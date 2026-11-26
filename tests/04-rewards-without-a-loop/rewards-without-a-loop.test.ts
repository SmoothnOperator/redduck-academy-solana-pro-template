import { assert } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  numToHex,
  oneToken,
  processTransaction,
  sendIxs,
  tokenBalance,
} from "../helpers";
import { PoolFixture, StakerAccount, setupPool } from "./fixture";
import { addRewards, claim, stake, unstake } from "./actions";

/** Helper asserting a transaction reverts with either the Anchor error name or hex error code. */
const expectPoolError = async (
  promise: Promise<unknown>,
  errorName: string,
  errorCode: number,
) => {
  try {
    await promise;
  } catch (err: any) {
    const msg = err.toString();
    const hex = numToHex(errorCode);
    if (msg.includes(errorName) || msg.includes(hex)) {
      return;
    }
    throw new Error(
      `Expected revert with ${errorName} (${hex}), got: ${msg}`,
    );
  }
  throw new Error(`Expected revert with ${errorName}, but succeeded`);
};

/** Sends `addRewards` with NO staker remaining accounts (proving O(1) execution). */
const addRewardsNoLoop = async (
  env: PoolFixture,
  amount: BN,
  extraAccounts: PublicKey[] = [],
) => {
  const ix = await env.program.methods
    .addRewards(amount)
    .accountsPartial({
      funder: env.payer.publicKey,
      mint: env.mint,
      funderTokens: env.payerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      extraAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: false,
      })),
    )
    .instruction();
  await sendIxs(env.context, [env.payer], ix);
};

describe("04-rewards-without-a-loop", () => {
  let env: PoolFixture;

  beforeEach(async () => {
    env = await setupPool();
  });

  it("splits a reward between three stakers in proportion to their stake", async () => {
    const [a, b, c] = env.stakers;
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(300));
    await stake(env, c, oneToken().muln(600));
    const before = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );

    await addRewards(env, oneToken().muln(100));
    await claim(env, a);
    await claim(env, b);
    await claim(env, c);

    const after = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );
    assert.equal(
      (after[0] - before[0]).toString(),
      oneToken().muln(10).toString(),
    );
    assert.equal(
      (after[1] - before[1]).toString(),
      oneToken().muln(30).toString(),
    );
    assert.equal(
      (after[2] - before[2]).toString(),
      oneToken().muln(60).toString(),
    );
  });

  it("add_rewards uses no loop, needs zero remaining accounts, and ignores any passed", async () => {
    const [a, b] = env.stakers;
    await stake(env, a, oneToken().muln(200));
    await stake(env, b, oneToken().muln(800));

    // Call addRewards with empty remainingAccounts
    await addRewardsNoLoop(env, oneToken().muln(100));

    // Verify pool accumulator increased
    const pool = await env.program.account.pool.fetch(env.pool);
    assert.isTrue(pool.rewardPerToken.gt(new BN(0)));

    // Call addRewards with an unrelated non-staker remaining account; it must be ignored
    const garbageAccount = Keypair.generate().publicKey;
    await addRewardsNoLoop(env, oneToken().muln(100), [garbageAccount]);

    const aBefore = await tokenBalance(env.context, a.tokens);
    const bBefore = await tokenBalance(env.context, b.tokens);

    await claim(env, a);
    await claim(env, b);

    const aAfter = await tokenBalance(env.context, a.tokens);
    const bAfter = await tokenBalance(env.context, b.tokens);

    assert.equal((aAfter - aBefore).toString(), oneToken().muln(40).toString());
    assert.equal((bAfter - bBefore).toString(), oneToken().muln(160).toString());
  });

  it("pays three stakers exact rewards across interleaved actions regardless of claim order", async () => {
    const [a, b, c] = env.stakers;

    // 1. a stakes 100, b stakes 300 (total = 400)
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(300));

    // 2. Reward 1 = 400 tokens (+1.0 reward per token -> a: 100, b: 300)
    await addRewardsNoLoop(env, oneToken().muln(400));

    // 3. c joins with 600 (total = 1000). c must NOT share Reward 1.
    await stake(env, c, oneToken().muln(600));

    // 4. Reward 2 = 1000 tokens (+1.0 reward per token -> a: +100=200, b: +300=600, c: +600=600)
    await addRewardsNoLoop(env, oneToken().muln(1000));

    // 5. b unstakes 200 (settles 600 into b.pending; b.stake becomes 100; total = 800)
    await unstake(env, b, oneToken().muln(200));
    const bStateAfterUnstake = await env.program.account.staker.fetch(b.account);
    assert.equal(bStateAfterUnstake.stake.toString(), oneToken().muln(100).toString());
    assert.equal(bStateAfterUnstake.pending.toString(), oneToken().muln(600).toString());

    // 6. Reward 3 = 800 tokens (+1.0 reward per token -> a: +100=300, b: +100=700, c: +600=1200)
    await addRewardsNoLoop(env, oneToken().muln(800));

    // 7. Claim in reverse/out-of-order sequence: c first, then a, then b last
    const claimAndMeasure = async (staker: StakerAccount) => {
      const before = await tokenBalance(env.context, staker.tokens);
      await claim(env, staker);
      const after = await tokenBalance(env.context, staker.tokens);
      return after - before;
    };

    const cReward = await claimAndMeasure(c);
    const aReward = await claimAndMeasure(a);
    const bReward = await claimAndMeasure(b);

    assert.equal(cReward.toString(), oneToken().muln(1200).toString());
    assert.equal(aReward.toString(), oneToken().muln(300).toString());
    assert.equal(bReward.toString(), oneToken().muln(700).toString());

    // All markers match pool.rewardPerToken and pending is 0
    const pool = await env.program.account.pool.fetch(env.pool);
    for (const s of [a, b, c]) {
      const stakerState = await env.program.account.staker.fetch(s.account);
      assert.equal(stakerState.pending.toString(), "0");
      assert.equal(
        stakerState.rewardPerTokenPaid.toString(),
        pool.rewardPerToken.toString(),
      );
    }
  });

  it("deposit settles prior rewards first and does not change what was owed before it", async () => {
    const [a, b] = env.stakers;

    // 1. a stakes 100, b stakes 900 (total = 1000)
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(900));

    // 2. Reward 1 = 100 tokens -> a is owed 10, b is owed 90
    await addRewardsNoLoop(env, oneToken().muln(100));

    // 3. Before claiming, a deposits 900 more tokens (a.stake rises from 100 to 1000)
    await stake(env, a, oneToken().muln(900));

    // Verify a's pending settled to 10 tokens (did NOT become 100 or 52.6 from the new stake)
    const aAfterDeposit = await env.program.account.staker.fetch(a.account);
    assert.equal(aAfterDeposit.stake.toString(), oneToken().muln(1000).toString());
    assert.equal(aAfterDeposit.pending.toString(), oneToken().muln(10).toString());

    // 4. a claims immediately before any further rewards: must receive exactly 10 tokens
    const aBeforeClaim1 = await tokenBalance(env.context, a.tokens);
    await claim(env, a);
    const aAfterClaim1 = await tokenBalance(env.context, a.tokens);
    assert.equal(
      (aAfterClaim1 - aBeforeClaim1).toString(),
      oneToken().muln(10).toString(),
    );

    // 5. Reward 2 = 190 tokens (total = 1900): now a's 1000 stake earns 100, b's 900 earns 90
    await addRewardsNoLoop(env, oneToken().muln(190));

    const aBeforeClaim2 = await tokenBalance(env.context, a.tokens);
    const bBeforeClaim = await tokenBalance(env.context, b.tokens);
    await claim(env, a);
    await claim(env, b);
    const aAfterClaim2 = await tokenBalance(env.context, a.tokens);
    const bAfterClaim = await tokenBalance(env.context, b.tokens);

    assert.equal(
      (aAfterClaim2 - aBeforeClaim2).toString(),
      oneToken().muln(100).toString(),
    );
    assert.equal(
      (bAfterClaim - bBeforeClaim).toString(),
      oneToken().muln(180).toString(),
    );
  });

  it("an untouched staker who claims last after everyone else exits receives exact cumulative rewards", async () => {
    const [a, b, c] = env.stakers;

    // 1. Initial stakes: a=250, b=250, c=500 (total=1000)
    await stake(env, a, oneToken().muln(250));
    await stake(env, b, oneToken().muln(250));
    await stake(env, c, oneToken().muln(500));

    // 2. Reward 1 = 100 -> a: 25, b: 25, c: 50
    await addRewardsNoLoop(env, oneToken().muln(100));

    // 3. b claims (25) and unstakes all 250 (total=750)
    await claim(env, b);
    await unstake(env, b, oneToken().muln(250));

    // 4. a deposits 250 more (a.pending=25, a.stake=500, total=1000)
    await stake(env, a, oneToken().muln(250));

    // 5. Reward 2 = 200 -> a: +100, c: +100
    await addRewardsNoLoop(env, oneToken().muln(200));

    // 6. a claims (125) and unstakes all 500 (total=500, only c left)
    await claim(env, a);
    await unstake(env, a, oneToken().muln(500));

    // 7. Reward 3 = 300 -> c: +300
    await addRewardsNoLoop(env, oneToken().muln(300));

    // c was completely untouched through all rewards and exits
    const cStateBefore = await env.program.account.staker.fetch(c.account);
    assert.equal(cStateBefore.pending.toString(), "0");
    assert.equal(cStateBefore.rewardPerTokenPaid.toString(), "0");

    // 8. c claims last and receives 50 + 100 + 300 = 450 tokens
    const cBefore = await tokenBalance(env.context, c.tokens);
    await claim(env, c);
    const cAfter = await tokenBalance(env.context, c.tokens);
    assert.equal((cAfter - cBefore).toString(), oneToken().muln(450).toString());
  });

  it("keeps enough precision that small rewards on a big stake do not vanish", async () => {
    const [a, b] = env.stakers;

    // Transfer extra tokens so total stake reaches 500,000 tokens (5e11 base units)
    await processTransaction(
      env.context,
      new Transaction().add(
        createTransferInstruction(
          env.payerTokens,
          a.tokens,
          env.payer.publicKey,
          BigInt(oneToken().muln(400_000).toString()),
        ),
        createTransferInstruction(
          env.payerTokens,
          b.tokens,
          env.payer.publicKey,
          BigInt(oneToken().muln(100_000).toString()),
        ),
      ),
      [env.payer],
    );

    await stake(env, a, oneToken().muln(400_000)); // 80%
    await stake(env, b, oneToken().muln(100_000)); // 20%

    // Send a tiny reward of just 10 base units (0.00001 tokens) across 5e11 base units staked
    await addRewardsNoLoop(env, new BN(10));

    const aBefore = await tokenBalance(env.context, a.tokens);
    const bBefore = await tokenBalance(env.context, b.tokens);

    await claim(env, a);
    await claim(env, b);

    const aAfter = await tokenBalance(env.context, a.tokens);
    const bAfter = await tokenBalance(env.context, b.tokens);

    assert.equal((aAfter - aBefore).toString(), "8");
    assert.equal((bAfter - bBefore).toString(), "2");
  });

  it("settles rewards before full unstake and enforces error checks", async () => {
    const [a] = env.stakers;

    // Cannot add rewards when nothing is staked
    await expectPoolError(
      addRewardsNoLoop(env, oneToken().muln(10)),
      "NothingStaked",
      6002,
    );

    await stake(env, a, oneToken().muln(100));

    // Cannot unstake more than staked
    await expectPoolError(
      unstake(env, a, oneToken().muln(101)),
      "InsufficientStake",
      6001,
    );

    // Reward arrives, then staker completely unstakes, then claims settled pending reward
    await addRewardsNoLoop(env, oneToken().muln(50));
    await unstake(env, a, oneToken().muln(100));

    const aBeforeClaim = await tokenBalance(env.context, a.tokens);
    await claim(env, a);
    const aAfterClaim = await tokenBalance(env.context, a.tokens);
    assert.equal(
      (aAfterClaim - aBeforeClaim).toString(),
      oneToken().muln(50).toString(),
    );
  });
});
