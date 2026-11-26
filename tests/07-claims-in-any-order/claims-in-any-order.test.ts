import { assert } from "chai";
import { Keypair } from "@solana/web3.js";

import { numToHex, oneToken, tokenBalance } from "../helpers";
import { ClaimsFixture, setupClaims } from "./fixture";
import { claim, claimMessage } from "./actions";

/** Helper asserting a transaction reverts with either the Anchor error name or hex error code. */
const expectClaimError = async (
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

describe("07-claims-in-any-order", () => {
  let env: ClaimsFixture;

  beforeEach(async () => {
    env = await setupClaims();
  });

  it("pays a reward the oracle signed", async () => {
    await claim(env, oneToken().muln(10));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(10).toString(),
    );
    const device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), oneToken().muln(10).toString());
  });

  it("sends two claims (older total then newer total) and ends in the correct total state", async () => {
    const total1 = oneToken().muln(100);
    const total2 = oneToken().muln(250);

    const balanceStart = await tokenBalance(env.context, env.ownerTokens);

    // 1. Send older claim (100 tokens)
    await claim(env, total1);
    const balanceAfter1 = await tokenBalance(env.context, env.ownerTokens);
    assert.equal(
      (balanceAfter1 - balanceStart).toString(),
      total1.toString(),
      "First claim must pay 100 tokens",
    );
    let device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), total1.toString());

    // 2. Send newer claim (250 tokens)
    await claim(env, total2);
    const balanceAfter2 = await tokenBalance(env.context, env.ownerTokens);
    assert.equal(
      (balanceAfter2 - balanceStart).toString(),
      total2.toString(),
      "Second claim must pay difference (150 tokens) reaching 250 tokens total",
    );
    device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), total2.toString());
  });

  it("sends two claims (newer total then older total) and ends in the exact same state", async () => {
    const total1 = oneToken().muln(100);
    const total2 = oneToken().muln(250);

    const balanceStart = await tokenBalance(env.context, env.ownerTokens);

    // 1. Send newer claim first (250 tokens)
    await claim(env, total2);
    const balanceAfter1 = await tokenBalance(env.context, env.ownerTokens);
    assert.equal(
      (balanceAfter1 - balanceStart).toString(),
      total2.toString(),
      "Newer claim arriving first pays full 250 tokens",
    );
    let device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), total2.toString());

    // 2. Send older claim second (100 tokens)
    await claim(env, total1);
    const balanceAfter2 = await tokenBalance(env.context, env.ownerTokens);
    assert.equal(
      (balanceAfter2 - balanceStart).toString(),
      total2.toString(),
      "Older claim arriving second must change nothing and transfer zero tokens",
    );
    device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), total2.toString(), "Paid amount remains 250 tokens");
  });

  it("sends the same claim twice (duplicate replay) and changes nothing on replay", async () => {
    const total = oneToken().muln(180);
    const balanceStart = await tokenBalance(env.context, env.ownerTokens);

    // 1. First execution
    await claim(env, total);
    const balanceAfter1 = await tokenBalance(env.context, env.ownerTokens);
    assert.equal(
      (balanceAfter1 - balanceStart).toString(),
      total.toString(),
      "First claim must pay 180 tokens",
    );

    // 2. Replay duplicate message
    await claim(env, total);
    const balanceAfter2 = await tokenBalance(env.context, env.ownerTokens);
    assert.equal(
      (balanceAfter2 - balanceStart).toString(),
      total.toString(),
      "Duplicate replay must change nothing and pay zero tokens",
    );
    const device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), total.toString());
  });

  it("refuses claim signed by an unauthorized oracle key", async () => {
    const unauthorizedOracle = Keypair.generate();
    assert.isFalse(unauthorizedOracle.publicKey.equals(env.oracle.publicKey));

    await expectClaimError(
      claim(env, oneToken().muln(50), env.payer, unauthorizedOracle),
      "WrongSigner",
      6004,
    );
  });

  it("refuses claim when message does not match requested total", async () => {
    const requestedTotal = oneToken().muln(50);
    const tamperedMessage = claimMessage(env.device, oneToken().muln(40));

    await expectClaimError(
      claim(env, requestedTotal, env.payer, env.oracle, tamperedMessage),
      "MessageMismatch",
      6005,
    );
  });
});
