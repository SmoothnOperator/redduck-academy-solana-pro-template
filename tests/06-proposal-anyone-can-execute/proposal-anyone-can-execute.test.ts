import { assert } from "chai";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";

import {
  getTime,
  numToHex,
  oneToken,
  processTransaction,
  timeTravel,
  tokenBalance,
} from "../helpers";
import { MultisigFixture, setupMultisig } from "./fixture";
import { approve, cancel, createProposal, execute, treasuryTransfer } from "./actions";

/** Helper asserting a transaction reverts with either the Anchor error name or hex error code. */
const expectMultisigError = async (
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

/** Freshly generates a stranger keypair, verifies it is outside the multisig member set, and funds it with SOL. */
const createVerifiedStranger = async (env: MultisigFixture): Promise<Keypair> => {
  const stranger = Keypair.generate();

  // Prove stranger is not among the multisig members and not the admin
  const config = await env.program.account.config.fetch(env.config);
  const memberKeys = config.members.slice(0, config.memberCount);
  for (const member of memberKeys) {
    assert.isFalse(
      member.equals(stranger.publicKey),
      "Stranger must not match any multisig member",
    );
  }
  assert.isFalse(
    config.admin.equals(stranger.publicKey),
    "Stranger must not match multisig admin",
  );

  // Fund stranger with SOL for transaction execution fees
  await processTransaction(
    env.context,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: env.payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 1_000_000_000,
      }),
    ),
    [env.payer],
  );

  return stranger;
};

describe("06-proposal-anyone-can-execute", () => {
  let env: MultisigFixture;

  beforeEach(async () => {
    env = await setupMultisig();
  });

  it("executes an approved transfer from the treasury with the vault PDA signing", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(50));

    await createProposal(env, 1, bob, transfer);
    await approve(env, 1, admin);
    await approve(env, 1, bob);

    const before = await tokenBalance(env.context, bobTokens);
    await execute(env, 1, admin, transfer);
    const after = await tokenBalance(env.context, bobTokens);

    assert.equal((after - before).toString(), oneToken().muln(50).toString());
    const proposal = await env.program.account.proposal.fetch(env.proposal(1));
    assert.isTrue(proposal.executed);
  });

  it("shows a freshly created stranger (definitely not a member) executing an approved proposal", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(30));

    await createProposal(env, 2, bob, transfer);
    await approve(env, 2, admin);
    await approve(env, 2, bob);

    // 1. Freshly create a stranger keypair right inside the test
    const stranger = Keypair.generate();

    // 2. Explicitly demonstrate that the stranger is not a member and not the admin
    const config = await env.program.account.config.fetch(env.config);
    const memberKeys = config.members.slice(0, config.memberCount);
    for (const member of memberKeys) {
      assert.isFalse(
        member.equals(stranger.publicKey),
        "Stranger must definitely not be a member of the multisig",
      );
    }
    assert.isFalse(
      config.admin.equals(stranger.publicKey),
      "Stranger must definitely not be the multisig admin",
    );

    // 3. Fund stranger with SOL for transaction fees
    await processTransaction(
      env.context,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: env.payer.publicKey,
          toPubkey: stranger.publicKey,
          lamports: 1_000_000_000,
        }),
      ),
      [env.payer],
    );

    // 4. Stranger executes the approved proposal
    const before = await tokenBalance(env.context, bobTokens);
    await execute(env, 2, stranger, transfer);
    const after = await tokenBalance(env.context, bobTokens);

    assert.equal((after - before).toString(), oneToken().muln(30).toString());
    const proposal = await env.program.account.proposal.fetch(env.proposal(2));
    assert.isTrue(proposal.executed);
  });

  it("refuses execute below the approval threshold", async () => {
    const [, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(20));

    // Threshold is 2, but only 1 approval
    await createProposal(env, 3, bob, transfer);
    await approve(env, 3, bob);

    const stranger = await createVerifiedStranger(env);

    await expectMultisigError(
      execute(env, 3, stranger, transfer),
      "NotApproved",
      6004,
    );
  });

  it("refuses a second execute of the same proposal", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(10));

    await createProposal(env, 4, bob, transfer);
    await approve(env, 4, admin);
    await approve(env, 4, bob);

    const stranger = await createVerifiedStranger(env);

    // First execution succeeds
    await execute(env, 4, stranger, transfer);

    // Second execution must be refused
    await expectMultisigError(
      execute(env, 4, stranger, transfer),
      "AlreadyExecuted",
      6005,
    );
  });

  it("refuses execute with a changed account list or program", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(15));

    await createProposal(env, 5, bob, transfer);
    await approve(env, 5, admin);
    await approve(env, 5, bob);

    const stranger = await createVerifiedStranger(env);

    // Case A: Divert tokens by swapping destination with stranger's public key
    const fakeTransfer = treasuryTransfer(env, stranger.publicKey, oneToken().muln(15));
    await expectMultisigError(
      execute(env, 5, stranger, fakeTransfer),
      "AccountMismatch",
      6006,
    );

    // Case B: Tamper with writability flags
    const tamperedWritability = [
      ...transfer.keys.map((k, idx) => ({
        pubkey: k.pubkey,
        isSigner: false,
        isWritable: idx === 0 ? !k.isWritable : k.isWritable,
      })),
      { pubkey: transfer.programId, isSigner: false, isWritable: false },
    ];
    await expectMultisigError(
      execute(env, 5, stranger, transfer, tamperedWritability),
      "AccountMismatch",
      6006,
    );

    // Case C: Tamper with target program (e.g. SystemProgram instead of TokenProgram)
    const tamperedProgram = [
      ...transfer.keys.map((k) => ({
        pubkey: k.pubkey,
        isSigner: false,
        isWritable: k.isWritable,
      })),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await expectMultisigError(
      execute(env, 5, stranger, transfer, tamperedProgram),
      "AccountMismatch",
      6006,
    );

    // Case D: Wrong account count (missing program account)
    const missingProgram = transfer.keys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: false,
      isWritable: k.isWritable,
    }));
    await expectMultisigError(
      execute(env, 5, stranger, transfer, missingProgram),
      "AccountMismatch",
      6006,
    );
  });

  it("allows proposer or member to cancel, and anyone to close after expiry", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(5));

    // 1. Proposer cancels an unexecuted proposal
    await createProposal(env, 6, bob, transfer);
    await cancel(env, 6, bob);
    assert.isNull(
      await env.program.account.proposal.fetchNullable(env.proposal(6)),
      "Proposal account must be closed after cancel",
    );

    // 2. Another member cancels an unexecuted proposal
    await createProposal(env, 7, bob, transfer);
    await cancel(env, 7, admin);
    assert.isNull(
      await env.program.account.proposal.fetchNullable(env.proposal(7)),
      "Proposal account must be closed after member cancel",
    );

    // 3. Stranger CANNOT cancel an active proposal before expiry
    const stranger = await createVerifiedStranger(env);
    await createProposal(env, 8, bob, transfer, 3600);
    await expectMultisigError(
      cancel(env, 8, stranger),
      "NotAMember",
      6001,
    );

    // 4. Stranger CAN close an expired proposal after expires_at
    const now = await getTime(env.context);
    await timeTravel(env.context, now + BigInt(7200));

    await cancel(env, 8, stranger);
    assert.isNull(
      await env.program.account.proposal.fetchNullable(env.proposal(8)),
      "Expired proposal account must be closed by stranger",
    );

    // 5. Cannot cancel an already executed proposal
    await createProposal(env, 9, bob, transfer, 3600);
    await approve(env, 9, admin);
    await approve(env, 9, bob);
    await execute(env, 9, stranger, transfer);

    await expectMultisigError(
      cancel(env, 9, bob),
      "AlreadyExecuted",
      6005,
    );
  });
});
