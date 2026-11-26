import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { getTime, numToHex, oneToken, timeTravel, tokenBalance, sendIxs } from "../helpers";
import { Player, RoundFixture, setupRounds } from "./fixture";
import {
  applyDex,
  cancelDex,
  join,
  openRound,
  proposeDex,
  refund,
  settle,
} from "./actions";

/** Helper asserting a transaction reverts with either the Anchor error name or hex error code. */
const expectRoundError = async (
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

describe("09-write-the-exit", () => {
  let env: RoundFixture;

  beforeEach(async () => {
    env = await setupRounds();
  });

  it("pays the whole pot to the winner the executor names", async () => {
    const [alice, bob] = env.players;
    const deadline = (await getTime(env.context)) + 60n;
    await openRound(env, 1, deadline);
    await join(env, 1, alice, oneToken().muln(100));
    await join(env, 1, bob, oneToken().muln(50));

    await timeTravel(env.context, deadline);
    const before = await tokenBalance(env.context, bob.tokens);
    await settle(env, 1, bob);
    const after = await tokenBalance(env.context, bob.tokens);

    assert.equal((after - before).toString(), oneToken().muln(150).toString());
    const round = await env.program.account.round.fetch(env.round(1));
    assert.isTrue(round.settled);
  });

  it("allows players to refund their stakes when the rollup executor never settles", async () => {
    const [alice, bob] = env.players;
    const now = await getTime(env.context);
    const deadline = now + 60n;
    await openRound(env, 2, deadline);
    await join(env, 2, alice, oneToken().muln(100));
    await join(env, 2, bob, oneToken().muln(50));

    // 1. At deadline, refund is not ready yet because REFUND_DELAY_SECONDS (3600s) has not passed
    await timeTravel(env.context, deadline);
    await expectRoundError(
      refund(env, 2, alice),
      "RefundNotReady",
      6006,
    );

    // 2. Time travels past deadline + REFUND_DELAY_SECONDS (3600s)
    await timeTravel(env.context, deadline + 3601n);

    // 3. Alice refunds her stake (100 tokens)
    const aliceBefore = await tokenBalance(env.context, alice.tokens);
    await refund(env, 2, alice);
    const aliceAfter = await tokenBalance(env.context, alice.tokens);
    assert.equal(
      (aliceAfter - aliceBefore).toString(),
      oneToken().muln(100).toString(),
      "Alice must recover her exact stake of 100 tokens",
    );

    // Alice's entry account is now closed, so calling refund again fails
    const aliceEntry = await env.program.account.entry.fetchNullable(
      env.entry(env.round(2), alice.keypair.publicKey),
    );
    assert.isNull(aliceEntry, "Alice entry account must be closed after refund");

    // 4. Bob refunds his stake (50 tokens)
    const bobBefore = await tokenBalance(env.context, bob.tokens);
    await refund(env, 2, bob);
    const bobAfter = await tokenBalance(env.context, bob.tokens);
    assert.equal(
      (bobAfter - bobBefore).toString(),
      oneToken().muln(50).toString(),
      "Bob must recover his exact stake of 50 tokens",
    );

    // 5. Executor CANNOT settle after the refund delay has expired
    await expectRoundError(
      settle(env, 2, bob),
      "RoundExpired",
      6005,
    );
  });

  it("changes the DEX venue with a timelock delay and blocks instant changes", async () => {
    const newDex = Keypair.generate().publicKey;

    // 1. Verify initial DEX is the default DEX_PROGRAM_ID
    let config = await env.program.account.config.fetch(env.config);
    assert.isFalse(config.dexProgram.equals(newDex));

    // 2. Stranger cannot propose a DEX change
    const stranger = Keypair.generate();
    await expectRoundError(
      proposeDex(env, newDex, stranger),
      "ConstraintHasOne",
      2001,
    );

    // 3. Admin proposes the new DEX
    await proposeDex(env, newDex);
    config = await env.program.account.config.fetch(env.config);
    assert.isTrue(config.pendingDex.equals(newDex));

    // 4. Calling applyDex immediately fails because the 24-hour delay has not passed
    await expectRoundError(
      applyDex(env),
      "DexChangeDelayNotPassed",
      6009,
    );

    // 5. Time travel past DEX_CHANGE_DELAY_SECONDS (86400s)
    const now = await getTime(env.context);
    await timeTravel(env.context, now + 86401n);

    // 6. Anyone can call applyDex now
    await applyDex(env, stranger);

    // 7. Config now uses the new DEX venue and clears pending fields
    config = await env.program.account.config.fetch(env.config);
    assert.isTrue(config.dexProgram.equals(newDex));
    assert.isTrue(config.pendingDex.equals(PublicKey.default));
    assert.equal(config.dexEffectiveAt.toString(), "0");
  });

  it("allows admin to cancel a pending DEX change before activation", async () => {
    const rogueDex = Keypair.generate().publicKey;

    // 1. Propose rogue DEX
    await proposeDex(env, rogueDex);
    let config = await env.program.account.config.fetch(env.config);
    assert.isTrue(config.pendingDex.equals(rogueDex));

    // 2. Admin cancels the proposal before the timelock expires
    await cancelDex(env);
    config = await env.program.account.config.fetch(env.config);
    assert.equal(config.dexEffectiveAt.toString(), "0");

    // 3. Time travel past 24 hours and attempt to apply
    const now = await getTime(env.context);
    await timeTravel(env.context, now + 86401n);

    // Apply fails because there is no pending DEX
    await expectRoundError(
      applyDex(env),
      "NoPendingDex",
      6008,
    );
  });
});
