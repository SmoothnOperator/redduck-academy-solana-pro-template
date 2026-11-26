import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { sendIxs } from "../helpers";
import { RewardsFixture } from "./fixture";

export const oraclePriceMessage = (price: BN, publishTime: BN): Buffer =>
  Buffer.concat([
    price.toArrayLike(Buffer, "le", 8),
    publishTime.toArrayLike(Buffer, "le", 8),
  ]);

export const accrue = async (
  env: RewardsFixture,
  owner: PublicKey,
  amount: BN,
) => {
  const ix = await env.program.methods
    .accrue(amount)
    .accountsPartial({ admin: env.payer.publicKey, owner })
    .instruction();
  await sendIxs(env.context, [env.payer], ix);
};

export const claim = async (
  env: RewardsFixture,
  owner: PublicKey,
  userTokens: PublicKey,
  caller: Keypair = env.payer,
  callerTokens: PublicKey = env.strangerTokens,
) => {
  const ix = await env.program.methods
    .claim()
    .accountsPartial({
      caller: caller.publicKey,
      user: env.userAccount(owner),
      mint: env.mint,
      userTokens,
      callerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [caller], ix);
};

export const setPrice = async (
  env: RewardsFixture,
  price: BN,
  publishTime?: BN,
  signer: Keypair = env.oracle,
  caller: Keypair = env.payer,
) => {
  const clock = await env.context.banksClient.getClock();
  const time = publishTime ?? new BN(clock.unixTimestamp.toString());
  const message = oraclePriceMessage(price, time);
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: signer.secretKey,
    message,
  });
  const ix = await env.program.methods
    .setPrice()
    .accountsPartial({
      caller: caller.publicKey,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  await sendIxs(env.context, [caller], ed25519Ix, ix);
};

export const buy = async (
  env: RewardsFixture,
  buyer: Keypair,
  buyerTokens: PublicKey,
  lamports: BN,
) => {
  const ix = await env.program.methods
    .buy(lamports)
    .accountsPartial({
      buyer: buyer.publicKey,
      mint: env.mint,
      buyerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [buyer], ix);
};
