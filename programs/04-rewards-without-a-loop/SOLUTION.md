# Solution

## The two numbers

- **What the pool stores (`Pool::reward_per_token: u128`):** The cumulative reward distributed per staked base token unit across the lifetime of the pool, scaled by `REWARD_PRECISION = 1_000_000_000_000_000_000` ($10^{18}$). When `add_rewards(amount)` runs, it executes in $O(1)$ without looping over or touching any staker accounts, simply incrementing:
  $$\text{reward\_per\_token} \mathrel{+}= \frac{\text{amount} \times 10^{18}}{\text{pool.total\_staked}}$$
  The $10^{18}$ fixed-point scaling guarantees that tiny rewards over large total stakes (e.g. a few base units across hundreds of thousands of staked tokens) do not truncate to zero while fitting safely inside `u128` without overflowing.
- **What each staker stores (`Staker::reward_per_token_paid: u128`, plus `stake: u64` and `pending: u64`):** `reward_per_token_paid` records the value of `pool.reward_per_token` at the staker's most recent settlement (`stake`, `unstake`, or `claim`).
- **Formula for the amount a staker is owed:**
  $$\text{owed} = \text{staker.pending} + \frac{\text{staker.stake} \times (\text{pool.reward\_per\_token} - \text{staker.reward\_per\_token\_paid})}{10^{18}}$$

## Settle first

Both `stake` and `unstake` must call `settle_staker` **before** updating `staker.stake`, because any rewards accrued over $(\text{pool.reward\_per\_token} - \text{staker.reward\_per\_token\_paid})$ belong strictly to the **previous** stake balance, not the new one. Advancing `reward_per_token_paid` to `pool.reward_per_token` ensures the new stake only earns from rewards added *after* the balance change.

**Numerical example of the wrong order:**
Suppose Bob has `900` tokens staked and Alice has `100` tokens staked (`total_staked = 1000`), both with `reward_per_token_paid = 0`. A reward of `100` arrives, raising `pool.reward_per_token` to $0.1 \times 10^{18}$. Alice is legitimately owed $100 \times 0.1 = 10$, and Bob is owed $900 \times 0.1 = 90$.

- **If `stake` changed Alice's stake before settling:** Suppose Alice deposits `900` more tokens (`staker.stake` becomes `1000`) and *then* settles using the new stake:
  $$\text{settled} = 1000 \times 0.1 = 100$$
  Alice would be credited `100` instead of `10`, stealing Bob's `90` reward and leaving the vault `90` tokens insolvent when Bob tries to claim! (Conversely, if it only overwrote `reward_per_token_paid` without settling first, Alice would lose her earned `10`.)
- **If `unstake` changed Alice's stake before settling:** Suppose Alice unstakes all `100` tokens (`staker.stake` becomes `0`) and *then* settles:
  $$\text{settled} = 0 \times 0.1 = 0$$
  Alice's earned reward of `10` would be wiped to zero and trapped in the vault forever.

Settling *before* mutating `staker.stake` avoids both bugs completely: on `stake(900)`, Alice settles $100 \times 0.1 = 10$ into `pending`, advances `reward_per_token_paid` to $0.1 \times 10^{18}$, and then increases `stake` to `1000`. On `unstake(100)`, Alice settles $10$ into `pending` before `stake` drops to `0`, preserving her `10` reward for whenever she calls `claim`.

## The staker nobody touches

If a staker stays completely inactive while any number of rewards arrive and other stakers deposit, withdraw, or claim:
- Their `Staker` PDA is **never modified** by `add_rewards` or by any other staker's actions; their `stake` remains unchanged and their `reward_per_token_paid` stays anchored at the value from their last interaction.
- Meanwhile, each reward $i$ raises `pool.reward_per_token` by $\Delta_i = \frac{\text{reward}_i \times 10^{18}}{\text{total\_staked}_i}$ weighted by the exact total stake present at that moment. Because `pool.reward_per_token` is a running cumulative sum, the difference $(\text{pool.reward\_per\_token} - \text{staker.reward\_per\_token\_paid})$ equals the exact telescoping sum $\sum_i \Delta_i$ over every reward interval the staker sat through.
- Whenever the untouched staker finally calls `claim` (even last after everyone else has exited), multiplying that single difference by their unchanged `staker.stake` pays their exact cumulative share across all reward distributions in $O(1)$.

## What lazy loading does not cover

Lazy evaluation only works when the beneficiary of the state update has an incentive to show up and submit a transaction (like claiming positive rewards or withdrawing their own stake).

An action in a staking/DeFi pool that **cannot** wait for the owner to show up is **forced liquidation, slashing for misbehavior, or expiring/evicting a stale position** (any state transition that penalizes the account owner or needs to run on a global schedule regardless of user participation). A user will never voluntarily submit a transaction to slash their own stake or liquidate their own undercollateralized debt.

For such actions, the design requires **role inversion / an untrusted executor**: allow any third-party keeper or liquidator to invoke the instruction on the owner's account, and compensate the keeper with a **bounded fee or liquidation bonus** taken from the position (or a dedicated reward reserve) so autonomous bots profitably execute it without relying on a centralized team operator.
