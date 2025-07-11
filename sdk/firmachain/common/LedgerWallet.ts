import { TxBodyEncodeObject, encodePubkey } from "@cosmjs/proto-signing";
import { AuthInfo, SignerInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { EncodeObject, Registry } from "@cosmjs/proto-signing";
import { Int53 } from "@cosmjs/math";
import { fromBase64 } from "@cosmjs/encoding";

import { AminoMsg, serializeSignDoc } from "../amino/signdoc";

import { encodeSecp256k1Pubkey } from "../amino/encoding";
import { makeSignDoc as makeSignDocAmino } from "../amino/signdoc";

import { fromUtf8 } from "@cosmjs/encoding";
import { Any } from "../google/protobuf/any";

import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import { FirmaUtil } from "../../FirmaUtil";
import { SignAndBroadcastOptions } from "../common";
import { Coin } from "../amino/coins";
import { AminoTypes } from "@cosmjs/stargate";

export interface LedgerWalletInterface {
    getAddress(): Promise<string>;
    sign(message: string): Promise<Uint8Array>;
    getPublicKey(): Promise<Uint8Array>;
    getAddressAndPublicKey(): Promise<{ address: string, publicKey: Uint8Array }>;
    showAddressOnDevice(): Promise<void>;
}

function makeSignerInfos(
    signers: ReadonlyArray<{ readonly pubkey: Any; readonly sequence: number }>,
    signMode: SignMode,
): SignerInfo[] {
    return signers.map(
        ({ pubkey, sequence }): SignerInfo => ({
            publicKey: pubkey,
            modeInfo: {
                single: { mode: signMode },
            },
            sequence: BigInt(sequence),
        }),
    );
}

function makeAuthInfoBytes(
    signers: ReadonlyArray<{ pubkey: Any; sequence: number }>,
    feeAmount: readonly Coin[],
    gasLimit: number,
    granter: string,
    signMode = SignMode.SIGN_MODE_LEGACY_AMINO_JSON,
): Uint8Array {
    const authInfo = {
        signerInfos: makeSignerInfos(signers, signMode),
        fee: {
            amount: [...feeAmount],
            gasLimit: BigInt(gasLimit),
            granter: granter,
        },
    };
    return AuthInfo.encode(AuthInfo.fromPartial(authInfo)).finish();
}

export async function signFromLedger(ledger: LedgerWalletInterface, messages: EncodeObject[], option: SignAndBroadcastOptions, registry: Registry): Promise<TxRaw> {

    let { address, publicKey } = await ledger.getAddressAndPublicKey();

    let signerData = await FirmaUtil.getSignerDataForLedger(address);

    const pubkey = encodePubkey(encodeSecp256k1Pubkey(publicKey));

    let aminoTypes = new AminoTypes({});

    const msgs = messages.map((msg) => aminoTypes.toAmino(msg));
    const chainId = signerData.chain_id;
    const accountNumber = Number.parseInt(signerData.account_number);
    const sequence = Number.parseInt(signerData.sequence);
    const memo = option.memo;

    const fee = { amount: option.fee.amount, gas: option.fee.gas };

    const signDoc = makeSignDocAmino(msgs, fee, chainId, memo, accountNumber, sequence);
    const signMessage = serializeSignDoc(signDoc);

    const ledgerSignature = await ledger.sign(fromUtf8(signMessage));;

    const signedTxBody = {
        messages: signDoc.msgs.map((msg: AminoMsg) => aminoTypes.fromAmino(msg)),
        memo: memo,
    };

    const signedTxBodyEncodeObject: TxBodyEncodeObject = {
        typeUrl: "/cosmos.tx.v1beta1.TxBody",
        value: signedTxBody,
    };

    const signedTxBodyBytes = registry.encode(signedTxBodyEncodeObject);
    const signedGasLimit = Int53.fromString(option.fee.gas).toNumber();

    const signedAuthInfoBytes = makeAuthInfoBytes(
        [{ pubkey, sequence }],
        option.fee.amount,
        signedGasLimit,
        option.fee.granter,
        SignMode.SIGN_MODE_LEGACY_AMINO_JSON,
    );

    let txRaw = TxRaw.fromPartial({
        bodyBytes: signedTxBodyBytes,
        authInfoBytes: signedAuthInfoBytes,
        signatures: [fromBase64(Buffer.from(ledgerSignature).toString('base64'))],
    });

    return txRaw;
}

