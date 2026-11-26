import { assert } from "chai";
import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  expectReverted,
  oneToken,
  processTransaction,
  sendIxs,
  toBN,
  tokenBalance,
} from "../helpers";
import { MAX_PRICE_AGE, RewardsFixture, setupRewards } from "./fixture";

/**
 * Encodes the 16-byte message signed by config.oracle:
 * [price: u64 LE, publish_time: i64 LE]
 */
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

describe("03-run-it-without-the-operator", () => {
  let env: RewardsFixture;

  beforeEach(async () => {
    env = await setupRewards();
  });

  it("pays a reward and sells tokens while the admin and the bot are running", async () => {
    await accrue(env, env.user.publicKey, oneToken().muln(100));
    // User claims their reward directly (0 fee deducted when user claims for themselves)
    await claim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.user,
      env.userTokens,
    );
    assert.equal(
      (await tokenBalance(env.context, env.userTokens)).toString(),
      oneToken().muln(100).toString(),
    );

    // one whole token costs 0.01 SOL (signed by oracle off-chain, pulled on-chain)
    await setPrice(env, toBN(LAMPORTS_PER_SOL / 100));
    await buy(
      env,
      env.stranger,
      env.strangerTokens,
      toBN(LAMPORTS_PER_SOL / 10),
    );
    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(10).toString(),
    );
  });

  it("shows a freshly created alternate signer (neither admin nor bot) claiming for user and getting paid the fee", async () => {
    // 1. Freshly create an alternate signer (neither admin nor bot)
    const alternateSigner = Keypair.generate();
    assert.isFalse(alternateSigner.publicKey.equals(env.payer.publicKey));
    assert.isFalse(alternateSigner.publicKey.equals(env.bot.publicKey));

    const alternateTokens = getAssociatedTokenAddressSync(
      env.mint,
      alternateSigner.publicKey,
    );

    // Fund alternateSigner with SOL for tx fees and create ATA
    await processTransaction(
      env.context,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: env.payer.publicKey,
          toPubkey: alternateSigner.publicKey,
          lamports: 1_000_000_000,
        }),
        createAssociatedTokenAccountInstruction(
          env.payer.publicKey,
          alternateTokens,
          alternateSigner.publicKey,
          env.mint,
        ),
      ),
      [env.payer],
    );

    // 2. Admin accrues 100 tokens to user
    await accrue(env, env.user.publicKey, oneToken().muln(100));

    const userTokensBefore = await tokenBalance(env.context, env.userTokens);
    const alternateTokensBefore = await tokenBalance(env.context, alternateTokens);

    // 3. Alternate signer calls claim on behalf of user
    const claimIx = await env.program.methods
      .claim()
      .accountsPartial({
        caller: alternateSigner.publicKey,
        user: env.userAccount(env.user.publicKey),
        mint: env.mint,
        userTokens: env.userTokens,
        callerTokens: alternateTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    await sendIxs(env.context, [alternateSigner], claimIx);

    const userTokensAfter = await tokenBalance(env.context, env.userTokens);
    const alternateTokensAfter = await tokenBalance(env.context, alternateTokens);

    // 1% fee (capped at 1 token = 1_000_000 units with 6 decimals)
    // 100 tokens * 1% = 1 token to alternateSigner, 99 tokens to user
    assert.equal(
      (userTokensAfter - userTokensBefore).toString(),
      oneToken().muln(99).toString(),
    );
    assert.equal(
      (alternateTokensAfter - alternateTokensBefore).toString(),
      oneToken().muln(1).toString(),
    );

    // User account pending is reset to 0
    const userAccount = await env.program.account.user.fetch(
      env.userAccount(env.user.publicKey),
    );
    assert.equal(userAccount.pending.toString(), "0");
  });

  it("shows a trade that works with no bot running using a price update built from a signed instruction", async () => {
    // 1. Freshly create an independent buyer (not admin, not bot)
    const buyer = Keypair.generate();
    const buyerTokens = getAssociatedTokenAddressSync(env.mint, buyer.publicKey);

    await processTransaction(
      env.context,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: env.payer.publicKey,
          toPubkey: buyer.publicKey,
          lamports: 1_000_000_000,
        }),
        createAssociatedTokenAccountInstruction(
          env.payer.publicKey,
          buyerTokens,
          buyer.publicKey,
          env.mint,
        ),
      ),
      [env.payer],
    );

    // 2. Build the signed Ed25519 instruction directly in the test from config.oracle
    const clock = await env.context.banksClient.getClock();
    const now = new BN(clock.unixTimestamp.toString());
    const price = toBN(LAMPORTS_PER_SOL / 50); // 0.02 SOL per token
    const message = oraclePriceMessage(price, now);

    const signedPriceIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: env.oracle.secretKey,
      message,
    });

    // 3. Buyer submits setPrice with signed instruction and buys tokens in one atomic transaction
    const setPriceIx = await env.program.methods
      .setPrice()
      .accountsPartial({
        caller: buyer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const buyIx = await env.program.methods
      .buy(toBN(LAMPORTS_PER_SOL / 10)) // 0.1 SOL -> 5 tokens
      .accountsPartial({
        buyer: buyer.publicKey,
        mint: env.mint,
        buyerTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Entire trade executes with NO bot transaction and NO bot signer
    await sendIxs(env.context, [buyer], signedPriceIx, setPriceIx, buyIx);

    const balance = await tokenBalance(env.context, buyerTokens);
    assert.equal(balance.toString(), oneToken().muln(5).toString());
  });

  it("verifies that no operator path remains: old admin pay_reward is gone and bot set_price is refused", async () => {
    // 1. The old admin pay_reward instruction no longer exists on the program
    assert.isUndefined((env.program.methods as any).payReward);

    // 2. The old bot path (calling setPrice with bot signer and no Ed25519 instruction) is refused
    const botSetPriceIx = await env.program.methods
      .setPrice()
      .accountsPartial({
        caller: env.bot.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await expectReverted(
      { revertedWith: { message: "NotEd25519" } },
      sendIxs(env.context, [env.bot], botSetPriceIx),
    );
  });

  it("prevents double claiming: a claim must not pay twice", async () => {
    await accrue(env, env.user.publicKey, oneToken().muln(50));

    // First claim succeeds
    await claim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.stranger,
      env.strangerTokens,
    );

    // Second claim must fail because pending is 0
    await expectReverted(
      { revertedWith: { message: "NothingToPay" } },
      claim(
        env,
        env.user.publicKey,
        env.userTokens,
        env.stranger,
        env.strangerTokens,
      ),
    );
  });

  it("refuses an oracle price update that is too old (older than max_price_age)", async () => {
    const clock = await env.context.banksClient.getClock();
    const staleTime = new BN(clock.unixTimestamp.toString()).subn(MAX_PRICE_AGE + 10);
    const price = toBN(LAMPORTS_PER_SOL / 100);

    await expectReverted(
      { revertedWith: { message: "StalePrice" } },
      setPrice(env, price, staleTime, env.oracle, env.stranger),
    );
  });

  it("refuses a price update signed by an unauthorized key instead of config.oracle", async () => {
    const fakeOracle = Keypair.generate();
    const price = toBN(LAMPORTS_PER_SOL / 100);

    await expectReverted(
      { revertedWith: { message: "NotEd25519" } },
      setPrice(env, price, undefined, fakeOracle, env.stranger),
    );
  });
});
