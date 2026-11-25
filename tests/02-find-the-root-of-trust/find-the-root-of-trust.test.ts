import { assert } from "chai";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { expectReverted, oneToken, tokenBalance, sendIxs } from "../helpers";
import { VaultFixture, setupVault } from "./fixture";
import { withdraw, withdrawalMessage } from "./actions";

/**
 * Builds a byte buffer with the exact layout expected by `load_instruction_unchecked`:
 * - u16 count of instructions (1)
 * - u16 offset of instruction 0 (4)
 * - u16 accounts length (0)
 * - 32 bytes program id (Ed25519Program.programId)
 * - u16 data length
 * - raw instruction data
 */
export function buildFakeInstructionsSysvar(ed25519IxData: Buffer): Buffer {
  const countBuf = Buffer.alloc(2);
  countBuf.writeUInt16LE(1, 0);

  const offsetBuf = Buffer.alloc(2);
  offsetBuf.writeUInt16LE(4, 0);

  const numAccountsBuf = Buffer.alloc(2);
  numAccountsBuf.writeUInt16LE(0, 0);

  const programIdBuf = Ed25519Program.programId.toBuffer();

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

    // 1. Create a fake allowlist with the attacker's fake oracle key
    const fakeAllowlist = Keypair.generate();
    const allowlistIx = await env.program.methods
      .createAllowlist([fakeOracle.publicKey])
      .accountsPartial({
        authority: env.payer.publicKey,
        allowlist: fakeAllowlist.publicKey,
      })
      .instruction();
    await sendIxs(env.context, [env.payer, fakeAllowlist], allowlistIx);

    // 2. Synthesize an Ed25519 signature from the fake oracle
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: fakeOracle.secretKey,
      message: withdrawalMessage(env.vault, env.payerTokens, amount),
    });

    // 3. Synthesize a fake instructions sysvar account containing the forged Ed25519 payload
    const fakeSysvarData = buildFakeInstructionsSysvar(ed25519Ix.data);
    const fakeSysvar = Keypair.generate();
    env.context.setAccount(fakeSysvar.publicKey, {
      lamports: 1_000_000_000,
      data: fakeSysvarData,
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });

    // 4. In the unfixed program, passing fakeSysvar and fakeAllowlist drains the vault.
    // In the fixed program, this fails because:
    // - instructions account address is validated to equal sysvar::instructions::ID
    // - the allowed keys are read from the config PDA, not caller's allowlist
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
      .instruction();

    await expectReverted(
      { revertedWith: { message: "ConstraintAddress" } },
      sendIxs(env.context, [env.payer], ix),
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
});
