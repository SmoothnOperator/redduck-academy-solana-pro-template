# Solution

## The chain as you found it

In the original program, the `withdraw` instruction performed four checks in sequence, but every single check depended on accounts provided and controlled entirely by the caller:

1. **Instruction Sysvar Indexing (`load_instruction_unchecked(0, &ctx.accounts.instructions)`):**
   - **Account it depends on:** `instructions: UncheckedAccount<'info>`.
   - **Could the caller create it?** **Yes.** The program defined `instructions` as an unconstrained `UncheckedAccount` with no address check. The caller could pass any arbitrary account with synthesized data.
2. **Ed25519 Precompile Format Parsing (`parse_ed25519(&signature_check)`):**
   - **Account it depends on:** `instructions` (indirectly via the deserialized instruction bytes).
   - **Could the caller create it?** **Yes.** Because the caller provided the underlying `instructions` account, they could populate it with arbitrary bytes matching the Ed25519 precompile instruction layout without running the real Ed25519 precompile program.
3. **Signer Allowlist Membership (`require!(ctx.accounts.allowlist.keys.contains(&signed.pubkey), VaultError::KeyNotAllowed)`):**
   - **Account it depends on:** `allowlist: Account<'info, Allowlist>`.
   - **Could the caller create it?** **Yes.** The program offered a permissionless `create_allowlist` instruction that anyone could call to create an `Allowlist` account owned by the program. The `withdraw` account struct did not enforce seeds, PDA constraints, or authority checks linking `allowlist` to `vault` or `config`. The caller could supply their own allowlist containing their own attacker key.
4. **Signed Message Verification (`require!(signed.message == expected, VaultError::MessageMismatch)`):**
   - **Account it depends on:** `vault`, `recipient_tokens`, and `amount`.
   - **Could the caller create it?** While `vault` is derived via seeds, `signed.message` was extracted directly from the caller-supplied fake `instructions` account. The caller simply pre-computed the expected message and embedded it in their fake account data.

## Where the chain ended

The entire chain of trust ended at two ungrounded accounts supplied by the caller:
1. **The unverified `instructions` account:** Because the program used `load_instruction_unchecked` without verifying that `instructions.key() == sysvar::instructions::ID`, the chain terminated at a fake account constructed by the caller. The exploit test faked this by allocating an account in Bankrun with the sysvar layout: a `u16` instruction count of 1, an offset pointing to instruction 0, 0 accounts, `Ed25519Program.programId`, and an instruction data buffer containing a forged Ed25519 payload for an attacker-generated keypair.
2. **The ungrounded `allowlist` account:** The chain terminated at an arbitrary `Allowlist` account. The exploit test faked it by synthesizing an allowlist account in Bankrun containing the attacker's own public key.

Together, these allowed an attacker to drain funds without an authorized oracle signature ever occurring.

## The root

The root of trust is now the **`config` PDA** (`seeds = [b"config"], bump = config.bump`):

- **Why the caller cannot create it:** The `config` account is a Program Derived Address deterministically derived from the program ID and the seed `b"config"`. It is initialized strictly once by the admin during `initialize`. Because it has no private key and lies off the Ed25519 curve, only this program can create or mutate it. Anchor's account constraint `#[account(seeds = [b"config"], bump = config.bump)]` enforces that any supplied account matches the canonical PDA.
- **How every other check in `withdraw` depends on it:**
  1. **Allowed oracle keys moved into the root:** The allowed oracle public keys are stored directly inside `config.keys: Vec<Pubkey>`. The external caller-supplied `Allowlist` account and the `create_allowlist` entry point have been eliminated entirely.
  2. **Sysvar address validation:** The `instructions` account is verified against the real sysvar address `anchor_lang::solana_program::sysvar::instructions::ID` both via `#[account(address = ...)]` and `require_keys_eq!` before any bytes are read.
  3. **Ed25519 program ID & parser validation:** The signature instruction loaded from the sysvar is explicitly verified to belong to the Solana Ed25519 program (`require_keys_eq!(signature_check.program_id, ed25519_program::ID)`), ensuring that the signature check was executed by the native precompile.
  4. **Ed25519 check against config:** The public key extracted from the genuine instructions sysvar is validated against `ctx.accounts.config.keys`.
  5. **Vault & Mint validation:** The token mint is verified against `config.mint`, and the vault PDA authority seeds for CPI transfer are derived from `config`.

## One root for every instruction

Every instruction in the program anchors into the identical `config` PDA:

- **`initialize`**: Derives and initializes the single `config` PDA (`seeds = [b"config"]`), recording the admin, the token mint, and the initial `keys`. Also initializes `vault` with `token::authority = config`.
- **`deposit`**: Enforces `#[account(seeds = [b"config"], bump = config.bump)]`, verifies that the deposit token mint matches `config.mint` (`#[account(address = config.mint)]`), validates `vault` authority as `config`, and transfers tokens into the vault PDA.
- **`withdraw`**: Enforces the same `#[account(seeds = [b"config"], bump = config.bump)]`, verifies `mint` against `config.mint`, validates `vault` authority as `config`, verifies the signer against `config.keys`, verifies `sysvar::instructions::ID`, verifies the Ed25519 instruction program ID, and signs the outgoing transfer using the `config` PDA bump seed.
- **`create_allowlist` eliminated**: The caller-created allowlist entry point has been removed from the public interface, ensuring that there are no orphan instructions outside the single root of trust.
