# Solution

## Which end of the band each value uses

For both collateral and debt, the program values the position defensively at its worst-case scenario using the Pyth price confidence band (`price ± conf`):
- **Collateral** uses the **low end** of the band (`low = price - conf`). In `borrow`, it is further bounded by the market's internal time-weighted average price: `min(collateral_band.low, market.collateral_twap)`. In `liquidate`, it uses `collateral_band.low` directly.
- **Debt** uses the **high end** of the band (`high = price + conf`) in both `borrow` and `liquidate`.

**Why that end:**
Pyth reports a price estimate alongside a confidence interval `conf` representing uncertainty. The actual market price can lie anywhere in `[price - conf, price + conf]`.
1. **Collateral** is the asset backing the loan. Overvaluing collateral allows borrowers to take out more debt than the collateral can cover. Valuing collateral at the low end assumes the collateral is worth the least possible amount within the confidence band, ensuring every loan is adequately backed even in adverse pricing conditions.
2. **Debt** is the liability owed to the pool. Undervaluing debt understates borrower liability. Valuing debt at the high end assumes the owed token is worth the most possible amount within the confidence band, ensuring the protocol accounts for the maximum liability.

By pairing collateral at the low end with debt at the high end, the protocol evaluates borrow capacity and position health under maximal adversarial pressure.

---

## The two lines

**Why the borrow line is stricter than the liquidation line:**
The borrow line (`borrow_ltv_bps = 7,500`, or 75%) is strictly lower than the liquidation line (`liquidation_ltv_bps = 8,500`, or 85%). This creates a crucial 10% **safety buffer** between the maximum leverage a user can initiate and the threshold at which they face liquidation.

Without this buffer, a borrower at maximum LTV would be immediately liquidated by routine price noise, bid-ask spread variations, or minor oracle confidence shifts. The gap ensures borrowers have room to manage their positions (by adding collateral or paying down debt) while giving liquidators sufficient margin to close underwater positions before the protocol suffers bad debt (when debt exceeds 100% of collateral value).

**Checks `borrow` makes that `liquidate` does not:**
1. **TWAP Spike Damping:** `borrow` constrains collateral valuation by the market's internal moving average: `min(collateral_band.low, market.collateral_twap)`. `liquidate` does not use the TWAP; it checks spot `collateral_band.low` directly.
2. **Stricter LTV Threshold:** `borrow` limits total debt to `collateral_val * borrow_ltv_bps / 10,000`, whereas `liquidate` requires `debt_val * 10,000 > collateral_val * liquidation_ltv_bps`.

**Why liquidation must not inherit them:**
Liquidation is an emergency solvency defense mechanism. If `liquidate` inherited the TWAP check, a sudden real market collapse would lower the spot price while the TWAP would lag behind over the 300-second window. The position would appear falsely healthy under the smoothed average, preventing liquidators from stepping in until the protocol became hopelessly insolvent. Similarly, if `liquidate` inherited the stricter 75% threshold, every loan opened near max capacity would be instantly liquidatable. Liquidation rules must remain unblocked, responsive, and spot-based.

---

## The value from the market's own state

**What the market keeps and how it is updated:**
The `Market` state account maintains:
1. `collateral_twap: u64`: the internal time-weighted average price of the collateral asset (scaled to 6 decimals).
2. `last_update_time: i64`: the Unix timestamp of the most recent price update.

Both instructions that read the price (`borrow` and `liquidate`) update this state. When a price is read, the market computes the elapsed time $\Delta t = \text{now} - \text{last\_update\_time}$ over a continuous window of `AVERAGE_WINDOW_SECONDS = 300`:
- If $\Delta t \ge 300$, the previous price has completely aged out, and `collateral_twap = current_price`.
- If $0 < \Delta t < 300$, the average updates as a time-weighted blend:
  $$\text{new\_twap} = \frac{(300 - \Delta t) \cdot \text{collateral\_twap} + \Delta t \cdot \text{current\_price}}{300}$$
- `last_update_time` is updated to `now`.

**Which instruction uses it, and why not the others:**
- Only `borrow` uses the average, computing `effective_collateral_price = min(collateral_band.low, market.collateral_twap)`.
- `liquidate` does not use it because liquidation must react immediately to true market crashes without waiting 300 seconds for the average to decay.
- `deposit` and `initialize` do not read oracle prices (deposit only transfers collateral tokens), so they neither use nor modify the price average.

**What happens during a short price spike:**
If an attacker or oracle glitch spikes the collateral price (e.g. from $100 to $200 for a few seconds), `collateral_band.low` jumps up to ~$199, but `market.collateral_twap` barely moves from $100 because $\Delta t$ is small. Since `borrow` takes `min(collateral_band.low, market.collateral_twap)`, the collateral remains valued at ~$100. Any attempt to borrow against the spiked valuation is refused with `BorrowLimitExceeded`. Only after the price has sustained for the full 300-second window does the TWAP reflect the new higher level.

**What happens when the price really falls:**
If the collateral price drops (e.g. from $100 to $50):
- In `borrow`, `collateral_band.low` drops to $49 while TWAP is still ~$100. Because `borrow` takes `min(49, 100) = 49`, it immediately respects the lower spot price and prevents new borrowing against stale high values (failing fast).
- In `liquidate`, liquidation evaluates collateral at spot `collateral_band.low` ($49) without TWAP delay. The position is recognized as crossing `liquidation_ltv_bps` and is liquidated immediately.

---

## A price that is too old

**What the program does:**
The program passes `market.max_price_age` to `update.get_price_no_older_than(clock, max_age, feed_id)`. If the Pyth price update timestamp is older than `max_price_age` (e.g. 60 seconds), `read_band` rejects the transaction with `MarketError::StalePrice`. The transaction fails fast before any state changes or token transfers take place.

**Who can fix it:**
Anyone can fix it. Because Pyth Network on Solana operates as a pull oracle via `pyth-solana-receiver-sdk`, fresh price updates signed by Pyth Wormhole price feeds can be posted permissionlessly by any user, keeper, liquidator, or relayer. A caller simply prepends the Pyth price update instruction to their transaction or submits a price update right before calling `borrow` or `liquidate`. No team key, admin privilege, or specialized bot is required to refresh the oracle.
