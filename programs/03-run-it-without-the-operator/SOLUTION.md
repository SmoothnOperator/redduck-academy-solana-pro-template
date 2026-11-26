# Solution

## Why the caller does not matter

In the original protocol, `pay_reward` was an admin-only instruction: rewards were paid out exclusively while the admin's centralized server ran. In the redesigned `claim` instruction, the executor is completely untrusted. Anyone (a random wallet, a keeper bot, or the user themselves) can submit the transaction on behalf of any user.

The result of `claim` is deterministic and identical regardless of who sends the transaction because:
1. **The recipient is hardcoded to the user:** The destination token account (`user_tokens`) is constrained by Anchor to belong strictly to the user (`token::authority = user.owner`). The reward payout always lands in the user's token account.
2. **State is tied to the user's PDA:** The accrued reward is read directly from the user's canonical PDA (`seeds = [b"user", user.owner.as_ref()]`), and `user.pending` is reset to zero upon execution, preventing double claims.
3. **The caller has no control over payout amounts:** The caller cannot alter who receives the reward or how much is paid. They merely serve as a transaction relayer (an untrusted executor) triggering the state transition.

**What would go wrong if the reward went to the caller instead of the user:**
If the reward went to the caller, frontrunning bots would monitor the mempool or network for pending claims and steal users' rewards by submitting their own claim transaction with higher priority fees. By strictly routing the user's reward to `user.owner`'s token account, the reward remains completely theft-proof and invariant to the caller's identity.

## The caller's fee

Because submitting transactions on Solana incurs transaction fees (signature fees + compute budget priority fees), third-party bots require economic incentive to run as keeper services.

1. **How the fee was sized:**
   - The fee is structured as a small percentage of the claimed reward: **1% (100 basis points)** of `user.pending`.
   - When a user claims for themselves (`caller == user.owner`), the fee is 0%, allowing users to retain 100% of their rewards without penalty.
2. **What the fee covers:**
   - It covers the base network transaction fee, priority fees necessary for inclusion during congestion, and a modest profit margin so that running autonomous keeper bots is economically viable.
3. **How it is capped:**
   - The fee is hard-capped at a maximum threshold: `pub const MAX_CALLER_FEE: u64 = 1_000_000` (1 whole token at 6 decimals).
   - This prevents large whale reward claims from yielding disproportionate windfall fees to relayers while ensuring smaller claims still adequately reward keeper execution.

## The price

In the original program, the market relied on a centralized team bot calling `set_price` on a push schedule. If the bot stalled or ran out of SOL, the market froze.

1. **Who brings the price now:**
   - The protocol implements a **pull oracle pattern** (role inversion). The caller (e.g. the trader or anyone wishing to update the market) brings the signed price update directly in the same transaction as their trade.
2. **What the program checks about it:**
   - **Instruction Sysvar & Precompile Execution:** The program inspects the preceding instruction loaded from the Instructions Sysvar (`sysvar::instructions::ID`).
   - **Precompile Program ID & Layout:** It verifies via `parse_ed25519` that the preceding instruction was executed by the native Ed25519 precompile program (`ed25519_program::ID`) and parses the signed payload.
   - **Oracle Authority:** It validates that the public key that signed the message strictly matches the protocol's configured oracle key (`require_keys_eq!(signed.pubkey, config.oracle)`).
   - **Message Parsing:** It extracts the price (`u64`) and publish timestamp (`i64`) from the 16-byte signed message payload.
3. **What happens when the update is too old:**
   - The program compares the oracle's signed `publish_time` with the current on-chain timestamp (`Clock::get()?.unix_timestamp`).
   - If `now - publish_time > config.max_price_age`, the transaction immediately reverts with `RewardsError::StalePrice`. This ensures trades execute only against fresh, timely market prices.

## What stays with the admin

The only instructions that retain admin privileges are:
1. **`initialize`**: Setting up the protocol's initial configuration (token mint, oracle public key, and maximum price age parameters).
2. **`accrue`**: Crediting users with rewards.

**Why this is acceptable:**
- **Rewards are an off-chain/business logic decision:** Deciding *who* earned rewards and *how much* is an inherent protocol-level business function that originates with the protocol issuer (e.g. protocol incentives, liquidity rewards, or platform activity).
- **Execution is fully decentralized:** Once rewards are accrued, the admin has zero control over execution. The admin cannot block a user from receiving their funds, cannot redirect payouts, and does not need to run any server to pay rewards. Similarly, the market does not rely on any team bot to function.
- The protocol's day-to-day operation is completely autonomous and operator-free.
