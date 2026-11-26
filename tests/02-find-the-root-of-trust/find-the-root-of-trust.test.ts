import { assert } from "chai";
import * as crypto from "crypto";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { expectReverted, oneToken, tokenBalance, sendIxs } from "../helpers";
import { VaultFixture, setupVault } from "./fixture";
import { withdraw, withdrawalMessage, deposit } from "./actions";

/**
 * Builds a byte buffer with the exact layout expected by `load_instruction_unchecked`:
 * - u16 count of instructions (1)
 * - u16 offset of instruction 0 (4)
 * - u16 accounts length (0)
 * - 32 bytes program id (Ed25519Program.programId)
 * - u16 data length
 * - raw instruction data
 */
export function buildFakeInstructionsSysvar(ed25519IxData: Buffer, programId: PublicKey = Ed25519Program.programId): Buffer {
  const countBuf = Buffer.alloc(2);
  countBuf.writeUInt16LE(1, 0);

  const offsetBuf = Buffer.alloc(2);
  offsetBuf.writeUInt16LE(4, 0);

  const numAccountsBuf = Buffer.alloc(2);
  numAccountsBuf.writeUInt16LE(0, 0);

  const programIdBuf = programId.toBuffer();

  const dataLenBuf = Buffer.alloc(2);
  dataLenBuf.writeUInt16LE(ed25519IxData.length, 0);

  return Buffer.concat([
    countBuf,
    offsetBuf,
    numAccountsBuf,
    programIdBuf,
    dataLenBuf,
    ed25519IxData,
  ]);
}

describe("02-find-the-root-of-trust", () => {
  let env: VaultFixture;

  beforeEach(async () => {
    env = await setupVault();
  });

  it("pays out a withdrawal the oracle signed", async () => {
    const before = await tokenBalance(env.context, env.payerTokens);
    await withdraw(env, oneToken().muln(100), env.payerTokens);
    const after = await tokenBalance(env.context, env.payerTokens);

    assert.equal((after - before).toString(), oneToken().muln(100).toString());
    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      oneToken().muln(900).toString(),
    );
  });

  it("shows the hole before the fix: withdrawal passes with a fake sysvar account and a fake allowlist", async () => {
    const fakeOracle = Keypair.generate();
    const amount = oneToken().muln(100);

    // 1. Synthesize an Ed25519 signature payload for fakeOracle
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: fakeOracle.secretKey,
      message: withdrawalMessage(env.vault, env.payerTokens, amount),
    });

    // 2. Synthesize a fake instructions sysvar account containing the forged Ed25519 payload
    const fakeSysvarData = buildFakeInstructionsSysvar(ed25519Ix.data);
    const fakeSysvar = Keypair.generate();
    env.context.setAccount(fakeSysvar.publicKey, {
      lamports: 1_000_000_000,
      data: fakeSysvarData,
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });

    // 3. Attacker injects a fake allowlist account in bankrun containing their fakeOracle key
    const fakeAllowlist = Keypair.generate();
    const disc = crypto.createHash("sha256").update("account:Allowlist").digest().subarray(0, 8);
    const vecLenBuf = Buffer.alloc(4);
    vecLenBuf.writeUInt32LE(1, 0);
    const allowlistData = Buffer.concat([
      disc,
      env.payer.publicKey.toBuffer(),
      vecLenBuf,
      fakeOracle.publicKey.toBuffer(),
    ]);
    env.context.setAccount(fakeAllowlist.publicKey, {
      lamports: 1_000_000_000,
      data: allowlistData,
      owner: env.program.programId,
      executable: false,
      rentEpoch: 0,
    });

    // 4. In the unfixed program, withdrawing with fakeSysvar and fakeAllowlist succeeds in draining the vault.
    // In the fixed program, instructions is validated against sysvar::instructions::ID and rejected.
    // We actually pass fakeAllowlist both in accountsPartial and in remainingAccounts.
    const ix = await env.program.methods
      .withdraw(amount)
      .accountsPartial({
        caller: env.payer.publicKey,
        allowlist: fakeAllowlist.publicKey,
        mint: env.mint,
        recipientTokens: env.payerTokens,
        instructions: fakeSysvar.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        {
          pubkey: fakeAllowlist.publicKey,
          isWritable: false,
          isSigner: false,
        },
      ])
      .instruction();

    await expectReverted(
      { revertedWith: { message: "ConstraintAddress" } },
      sendIxs(env.context, [env.payer], ix),
    );
  });

  it("rejects a withdrawal when the preceding instruction is not an Ed25519 program instruction", async () => {
    // Instruction with wrong program ID (SystemProgram instead of Ed25519Program)
    const fakeSigIx = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.alloc(32),
    });

    await expectReverted(
      { revertedWith: { message: "NotEd25519" } },
      withdraw(
        env,
        oneToken().muln(50),
        env.payerTokens,
        env.oracle,
        undefined,
        fakeSigIx,
      ),
    );
  });

  it("rejects a withdrawal with a wrong instructions account address", async () => {
    const randomAccount = Keypair.generate().publicKey;
    await expectReverted(
      { revertedWith: { message: "ConstraintAddress" } },
      withdraw(env, oneToken().muln(50), env.payerTokens, env.oracle, randomAccount),
    );
  });

  it("rejects an unauthorized signer not in config allowed_keys", async () => {
    const unauthorizedOracle = Keypair.generate();
    await expectReverted(
      { revertedWith: { message: "KeyNotAllowed" } },
      withdraw(env, oneToken().muln(50), env.payerTokens, unauthorizedOracle),
    );
  });

  it("rejects a withdrawal when the signed message does not match the withdrawal parameters", async () => {
    const amount = oneToken().muln(50);
    const differentAmount = oneToken().muln(100);

    // Oracle signs for differentAmount, but caller requests `amount`
    const mismatchedSigCheck = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: env.oracle.secretKey,
      message: withdrawalMessage(env.vault, env.payerTokens, differentAmount),
    });

    await expectReverted(
      { revertedWith: { message: "MessageMismatch" } },
      withdraw(
        env,
        amount,
        env.payerTokens,
        env.oracle,
        undefined,
        mismatchedSigCheck,
      ),
    );
  });

  it("verifies initialize sets up the config PDA with allowed keys and vault authority", async () => {
    const configData = await env.program.account.config.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("config")], env.program.programId)[0]
    );
    assert.isTrue(configData.admin.equals(env.payer.publicKey));
    assert.isTrue(configData.mint.equals(env.mint));
    const allowedKeys = (configData as any).allowedKeys ?? (configData as any).keys;
    assert.equal(allowedKeys.length, 1);
    assert.isTrue(allowedKeys[0].equals(env.oracle.publicKey));
  });

  it("verifies deposit adds funds to the vault PDA using the config mint", async () => {
    const vaultBefore = await tokenBalance(env.context, env.vault);
    await deposit(env, oneToken().muln(200));
    const vaultAfter = await tokenBalance(env.context, env.vault);
    assert.equal((vaultAfter - vaultBefore).toString(), oneToken().muln(200).toString());
  });
});
