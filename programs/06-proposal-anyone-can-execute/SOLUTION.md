# Solution

## Why anyone may execute

- **Why it is safe:** The entire action is frozen as immutable data inside the `Proposal` PDA at creation time and authenticated through individual member signatures (`approve`). Because the decision and its exact parameters are already cryptographically committed on-chain, execution is merely a mechanical trigger.
- **What the executor can change:** The executor can only choose **when** to submit the transaction (after threshold is reached and before expiry) and **pays the transaction network fee**.
- **What the executor cannot change:** The executor cannot alter any part of the execution: they cannot change the target program, the account addresses, account writability, account signers, or the instruction payload bytes. The program enforces that the accounts passed by the executor match the stored `metas` one by one, that only the vault PDA is permitted as a signer, and that the target program matches `proposal.program_id`. Any deviation is rejected with `AccountMismatch`.

## What the PDA signs

- **What the vault PDA signs:** At execution, the vault PDA signs **only the single CPI instruction** defined by `proposal.program_id`, `proposal.metas`, and `proposal.data` via `invoke_signed`.
- **Why it cannot sign anything outside the proposal account:** The instruction passed to `invoke_signed` is strictly assembled from the stored `proposal` account fields (`program_id`, `metas`, `data`). The vault PDA seeds (`&[b"vault", &[vault_bump]]`) are provided exclusively to this one `invoke_signed` call. The program also validates that if any `meta.is_signer` is true, its address must equal the vault PDA address, and no other account in the transaction is granted PDA signer privileges. Since no other instruction or seeds are passed, the PDA cannot sign anything not explicitly stored in and approved through the proposal.

## What stays with the members

- **Creating proposals (`create_proposal`):** Requires a member's signature. This prevents griefing and spam attacks from arbitrary wallets cluttering the multisig with malicious or garbage proposals.
- **Approving proposals (`approve`):** Strictly requires individual member signatures until the threshold is reached. Multisig authority derives entirely from these authentic cryptographic approvals.
- **Early cancellation (`cancel`):** While a proposal is active and unexpired, only the proposer or an existing member can cancel it. Strangers cannot cancel or disrupt an in-flight proposal that members are currently deliberating on.
- **Why execution does not need them:** Execution is an operational consequence of an already-authorized decision. Once approvals reach the threshold, requiring another member signature would recreate the very bottleneck, liveness hazard, and single point of failure that the multisig is designed to avoid.

## The exits

- **Who pays for the proposal account:** The **proposer** pays the rent lamports upfront when calling `create_proposal` (`payer = proposer`).
- **How an unapproved proposal ends:**
  1. **Before expiry:** The proposer or any member can call `cancel` at any time on an unexecuted proposal, which immediately closes the proposal account and refunds 100% of the rent lamports back to the proposer.
  2. **After expiry (`Clock::unix_timestamp > expires_at`):** Anyone (including third-party relayers, keepers, or bots) can call `cancel`, closing the expired proposal and refunding the rent lamports to the proposer.
  3. **Executed proposals:** Once executed, the proposal is marked `executed = true`, preventing double execution and preventing cancellation.
