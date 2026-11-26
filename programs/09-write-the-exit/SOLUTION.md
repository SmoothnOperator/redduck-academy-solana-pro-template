# Solution

## Dependency 1: the ephemeral rollup

**Would the product make sense without it?**
Yes. The core game is a round-based competitive betting game where players stake tokens and the winner takes the pot. While an ephemeral rollup allows players to execute high-frequency game moves off-chain without paying L1 transaction fees per move, the game mechanics (player deposits, round timer, outcome verification, and pot settlement) can also run natively on Solana L1 (e.g., using commit-reveal schemes, on-chain state machines, or verifiable random functions/VRF). If the rollup fails, stalls, or is removed, the protocol can either execute rounds natively on Solana L1 or allow players to safely exit with their stakes.

**Should the rounds run on the rollup at all?**
The justification for running rounds on an ephemeral rollup is the **Solana account write-lock contention limit and per-transaction compute/fee limits on micro-moves**:
1. **Account Write-Lock Contention:** On Solana, all transactions that declare the same account as writable cannot be executed in parallel; the runtime serializes them. In a real-time, round-based multiplayer game where many participants submit rapid, concurrent moves against the same active round state, all transactions contend for the single round account's write lock. This creates a hard throughput bottleneck per block, triggers priority fee bidding wars, causes transaction drops, and impairs gameplay responsiveness.
2. **Transaction Overhead for High-Frequency Micro-Actions:** If a game round consists of dozens or hundreds of sub-second state transitions (e.g. movement, card draws, action sequences), committing every micro-move as an independent Solana L1 transaction imposes substantial signature verification overhead, compute unit consumption, rent, and latency.
An ephemeral rollup is therefore justified to offload high-frequency transient state transitions off-chain, using Solana L1 strictly as the secure settlement and custody layer for stake deposits and final pot distribution.

**The exit:**
- **What triggers it:** The round deadline expiring and remaining unsettled past the settlement window (`round.deadline + REFUND_DELAY_SECONDS`, set to 3,600 seconds / 1 hour).
- **Who can trigger it:** Any participating player who entered the round can trigger `refund` for their own entry.
- **How long it takes:** 1 transaction on Solana L1 once the 1-hour delay has elapsed.
- **Where the players' funds are while it happens:** Safe on Solana L1 inside the program's `vault` PDA. The rollup only computes game logic; token custody never leaves the Solana blockchain.

---

## Dependency 2: the external DEX

**Would the product make sense without it?**
Yes. The game's native accounting and pot distribution are denominated exclusively in the game's mint (`config.mint`). The external DEX integration in `join_with_swap` is strictly an optional convenience feature enabling players holding other SPL tokens (like USDC or SOL) to swap and join in a single user transaction. Without it, users simply perform the swap through any DEX aggregator or AMM prior to joining, then call the native `join` instruction.

**The exit:**
- **What triggers it:** The protocol admin calls `propose_dex(new_dex)` to queue a replacement DEX program, followed by `apply_dex()` once the timelock elapses.
- **Who can trigger it:** The admin proposes the change; after the timelock elapses, anyone (or the admin) can call `apply_dex()` to activate it. The admin can also call `cancel_dex()` to abort a pending proposal.
- **How long it takes:** `DEX_CHANGE_DELAY_SECONDS` (86,400 seconds / 24 hours).

**If the key were stolen:**
- **What someone could do:** If an attacker steals the admin key, they could call `propose_dex` with a malicious contract designed to steal funds during swap execution.
- **What limits the damage:**
  1. The 24-hour timelock delay prevents instant activation. The pending change is fully visible on-chain (`pending_dex` and `dex_effective_at`), giving operators, monitoring bots, and players 24 hours to detect the attack and warn users.
  2. Direct deposits via `join` do not interact with the DEX and are completely immune.
  3. Existing round stakes and vault funds are untouched; `join_with_swap` only invokes the DEX on the user's input tokens and enforces slippage protection (`min_amount`) on output tokens received by the vault.
  4. The admin/multisig can invoke `cancel_dex()` before the 24 hours expire to neutralize the malicious proposal.

---

## Dependency 3: the upgrade authority

**Would the product make sense without it?**
Yes. An upgrade authority is not an inherent operational requirement of the game protocol. Once the game contracts are audited, tested, and battle-proven, the upgrade authority can be permanently revoked (setting the BPF upgrade authority to `None`), rendering the program fully immutable, trustless, and resilient against any key compromise or third-party failure.

**The exit:**
- **What triggers it:**
  The exit is triggered by the completion of protocol milestones, security audits, and formal verification of the smart contract logic, or alternatively, by an operational or security incident (such as a vulnerability or compromise detected in the third-party multisig service) requiring an emergency migration away from the external provider.
- **Who can trigger it:**
  The current 2-of-3 third-party multisig signers must initiate the transaction to transfer the upgrade authority. Specifically, they execute `bpf_loader_upgradeable::set_upgrade_authority` to hand over control to a protocol-owned governance timelock (or revoke it permanently to `None`). Under the new timelocked governance system, future upgrades are initiated by protocol governance signers submitting a proposal through the timelock program.
- **How long it takes:**
  - Revoking the key to `None` (immutability) takes exactly 1 transaction (immediate and permanent).
  - Migrating to a timelocked governance setup and any subsequent program upgrades take a mandatory on-chain delay of 72 hours (3 days). This timelock window ensures that every queued upgrade buffer is publicly inspectable and provides users with a 72-hour escape window to withdraw all stakes before new code can become active.
- **What you would change about who holds the key and how a change takes effect:**
  1. **Key Ownership:** Strip the third-party service of unilateral upgrade control. Transfer the upgrade authority to an internal protocol governance multisig with a broader threshold (e.g. 4-of-7 composed of core team developers, independent security auditors, and community delegates).
  2. **Mandatory Timelock Delay:** Place an on-chain timelock contract (such as a Squads v4 timelock buffer or dedicated governance escrow) between the multisig and the BPF loader. Any proposed program deployment must sit queued on-chain for at least 72 hours before it can be executed.
  3. **Veto / Cancellation Mechanism:** Empower a dedicated Security Council to unilaterally cancel or veto a queued upgrade during the 72-hour window if malicious byte modifications are discovered.
  4. **Path to Immutability:** Permanently set the upgrade authority to `None` once feature development has concluded.

**If the key were stolen:**
- **What someone could do with it today:**
  Because the current setup is a 2-of-3 third-party multisig with **no timelock**, an attacker who compromises 2 signers can execute an instant upgrade in a single block (`bpf_loader_upgradeable::upgrade`). The attacker could deploy an arbitrary program that immediately drains all funds from the `vault` PDA, steals active pots, bypasses entry records, or rugs all player balances with zero warning or recourse.
- **What limits the damage with the exit:**
  With the proposed exit architecture (72-hour timelock and Security Council veto):
  1. An attacker with compromised multisig keys can only queue an upgrade; they cannot execute it immediately.
  2. The queued upgrade is visible on-chain to community monitoring services and bots for 72 hours.
  3. The Security Council can cancel the malicious upgrade before activation.
  4. Even if cancellation fails, players have 72 hours to exit all rounds and withdraw their funds before the malicious code is applied.

---

## What you implemented

- **Instructions added:**
  1. `refund(ctx)` in `src/instructions/refund.rs`: allows players to reclaim their original stake directly from the `vault` PDA if the round remains unsettled after `round.deadline + REFUND_DELAY_SECONDS`. Also closes the player's `Entry` account, returning rent.
  2. `propose_dex(ctx, new_dex)` in `src/instructions/change_dex.rs`: allows admin to propose a new DEX program address, setting a 24-hour timelock.
  3. `apply_dex(ctx)` in `src/instructions/change_dex.rs`: applies the pending DEX program once the 24-hour delay has passed.
  4. `cancel_dex(ctx)` in `src/instructions/change_dex.rs`: allows admin to cancel any pending DEX proposal.
  5. `settle(ctx)` in `src/instructions/settle.rs`: updated to reject settlement if `now >= round.deadline + REFUND_DELAY_SECONDS`, ensuring the executor cannot settle after the refund window opens.
  6. `join_with_swap(ctx)` in `src/instructions/join_with_swap.rs`: updated to invoke `config.dex_program` instead of a hardcoded constant.
- **Fields added to `Config` (`src/state/config.rs`):**
  - `dex_program: Pubkey`: current active DEX program address (defaults to `DEX_PROGRAM_ID`).
  - `pending_dex: Pubkey`: proposed new DEX program address awaiting timelock expiration.
  - `dex_effective_at: i64`: timestamp when the proposed DEX can be applied.
- **Delays chosen:**
  - `REFUND_DELAY_SECONDS = 3600` (1 hour): Gives the ephemeral rollup executor sufficient time to finalize game rounds and settle on Solana even during network congestion, while ensuring players are never trapped indefinitely if the rollup goes down.
  - `DEX_CHANGE_DELAY_SECONDS = 86400` (24 hours): Provides a full 24-hour window for monitoring systems, the community, and the protocol team to detect and react to a compromised admin key before a rogue DEX can be activated.
