import { assert } from "chai";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import { expectReverted, oneToken, toBN, tokenBalance } from "../helpers";
import { MAX_PRICE_AGE, RewardsFixture, setupRewards } from "./fixture";
import { accrue, buy, claim, setPrice } from "./actions";

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

  it("allows a random wallet that is neither admin nor bot to claim for someone else and receive the fee", async () => {
    // 1. Admin accrues 100 tokens of rewards to user
    await accrue(env, env.user.publicKey, oneToken().muln(100));

    const userTokensBefore = await tokenBalance(env.context, env.userTokens);
    const strangerTokensBefore = await tokenBalance(env.context, env.strangerTokens);

    // 2. Stranger (untrusted executor, neither admin nor bot) triggers claim for user
    await claim(
      env,
      env.user.publicKey,
      env.userTokens,
      env.stranger,
      env.strangerTokens,
    );

    const userTokensAfter = await tokenBalance(env.context, env.userTokens);
    const strangerTokensAfter = await tokenBalance(env.context, env.strangerTokens);

    // Fee is 1% (capped at 1 token = 1_000_000 units with 6 decimals)
    // 100 tokens * 1% = 1 token fee to stranger, 99 tokens to user
    const userGain = userTokensAfter - userTokensBefore;
    const strangerGain = strangerTokensAfter - strangerTokensBefore;

    assert.equal(userGain.toString(), oneToken().muln(99).toString());
    assert.equal(strangerGain.toString(), oneToken().muln(1).toString());

    // 3. User account pending is reset to 0
    const userAccount = await env.program.account.user.fetch(
      env.userAccount(env.user.publicKey)
    );
    assert.equal(userAccount.pending.toString(), "0");
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

  it("executes a trade that works with no bot running via signed oracle pull price", async () => {
    // Neither the admin nor the bot signs any transaction here.
    // Buyer uses an Ed25519 price update signed off-chain by oracle.
    const price = toBN(LAMPORTS_PER_SOL / 50); // 0.02 SOL per token
    await setPrice(env, price, undefined, env.oracle, env.stranger);

    const strangerTokensBefore = await tokenBalance(env.context, env.strangerTokens);
    await buy(
      env,
      env.stranger,
      env.strangerTokens,
      toBN(LAMPORTS_PER_SOL / 10), // 0.1 SOL pays for 5 tokens
    );
    const strangerTokensAfter = await tokenBalance(env.context, env.strangerTokens);

    assert.equal(
      (strangerTokensAfter - strangerTokensBefore).toString(),
      oneToken().muln(5).toString(),
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
