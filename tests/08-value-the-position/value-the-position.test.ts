import { assert } from "chai";

import {
  getTime,
  numToHex,
  oneToken,
  timeTravel,
  tokenBalance,
} from "../helpers";
import { MarketFixture, MAX_PRICE_AGE, setupMarket } from "./fixture";
import { borrow, deposit, liquidate } from "./actions";

/** Helper asserting a transaction reverts with either the Anchor error name or hex error code. */
const expectMarketError = async (
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

describe("08-value-the-position", () => {
  let env: MarketFixture;

  beforeEach(async () => {
    env = await setupMarket();
  });

  it("borrows against deposited collateral", async () => {
    await env.setPrices([150, 1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));

    const before = await tokenBalance(env.context, env.payerDebt);
    await borrow(env, oneToken().muln(1_000));
    const after = await tokenBalance(env.context, env.payerDebt);

    assert.equal((after - before).toString(), oneToken().muln(1_000).toString());
    const position = await env.program.account.position.fetch(
      env.position(env.payer.publicKey),
    );
    assert.equal(position.collateral.toString(), oneToken().muln(10).toString());
    assert.equal(position.debt.toString(), oneToken().muln(1_000).toString());
  });

  it("refuses borrow or liquidation with a stale price", async () => {
    // 1. Set price older than MAX_PRICE_AGE (e.g. 65s > 60s)
    await env.setPrices([150, 1], [1, 0.001], MAX_PRICE_AGE + 5);
    await deposit(env, oneToken().muln(10));

    // Borrow must be refused due to stale price
    await expectMarketError(
      borrow(env, oneToken().muln(500)),
      "StalePrice",
      6002,
    );

    // 2. Set fresh price and borrow successfully
    await env.setPrices([150, 1], [1, 0.001], 0);
    await borrow(env, oneToken().muln(500));

    // 3. Stale price also prevents liquidation
    await env.setPrices([80, 1], [1, 0.001], MAX_PRICE_AGE + 10);
    await expectMarketError(
      liquidate(env, env.payer.publicKey),
      "StalePrice",
      6002,
    );
  });

  it("refuses borrow when confidence band is wide", async () => {
    // Normal confidence (price 150, conf 1):
    // low collateral price = 149.
    // 10 collateral tokens = $1,490 value.
    // At 75% LTV, max borrow is $1,117.5 (can borrow 1,000 debt tokens at $1.001 = $1,001).
    //
    // Wide confidence band (price 150, conf 50):
    // low collateral price = 100.
    // 10 collateral tokens = $1,000 value.
    // At 75% LTV, max borrow is $750.
    // Borrowing 1,000 debt tokens ($1,001 value) must exceed borrow limit!
    await env.setPrices([150, 50], [1, 0.001]);
    await deposit(env, oneToken().muln(10));

    await expectMarketError(
      borrow(env, oneToken().muln(1_000)),
      "BorrowLimitExceeded",
      6004,
    );
  });

  it("refuses borrow against a short price spike until it has lasted", async () => {
    // 1. Market initializes at steady price 100 (conf 1)
    await env.setPrices([100, 1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));

    // First borrow records collateral TWAP at 100
    await borrow(env, oneToken().muln(100));

    // 2. Collateral price spikes from 100 to 200 (conf 1)
    // At price 200, 10 collateral tokens would be worth 10 * 199 = $1,990.
    // 75% of $1,990 = $1,492.5.
    // User tries to borrow 1,100 more debt tokens (total 1,200 tokens = $1,201.2 debt value).
    // But TWAP over 300s window has not caught up (only 5 seconds elapsed).
    const now = await getTime(env.context);
    await timeTravel(env.context, now + 5n);
    await env.setPrices([200, 1], [1, 0.001]);

    await expectMarketError(
      borrow(env, oneToken().muln(1_100)),
      "BorrowLimitExceeded",
      6004,
    );

    // 3. Let the full 300s window elapse with the price remaining high
    const timeLater = await getTime(env.context);
    await timeTravel(env.context, timeLater + 301n);
    await env.setPrices([200, 1], [1, 0.001]);

    // Now that the spike has lasted for the entire window, TWAP catches up and borrow succeeds
    await borrow(env, oneToken().muln(1_100));

    const position = await env.program.account.position.fetch(
      env.position(env.payer.publicKey),
    );
    assert.equal(position.debt.toString(), oneToken().muln(1_200).toString());
  });

  it("handles position between the two lines: cannot borrow more, cannot be liquidated, then liquidates when line crossed", async () => {
    // 1. Collateral price: 100 (conf 1), Low = 99.
    // Debt price: 1 (conf 0.001), High = 1.001.
    // Deposit: 10 collateral tokens -> Collateral value = 10 * 99 = $990.
    // Borrow line (75%): 990 * 0.75 = $742.5.
    // Liquidation line (85%): 990 * 0.85 = $841.5.
    await env.setPrices([100, 1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));

    // Borrow 740 debt tokens (Debt value = 740 * 1.001 = $740.74 <= $742.5).
    await borrow(env, oneToken().muln(740));

    // A. Cannot borrow more: borrowing 10 more (total 750 tokens -> $750.75 > $742.5) fails
    await expectMarketError(
      borrow(env, oneToken().muln(10)),
      "BorrowLimitExceeded",
      6004,
    );

    // B. Cannot be liquidated: debt ($740.74) is below liquidation line ($841.5)
    await expectMarketError(
      liquidate(env, env.payer.publicKey),
      "PositionHealthy",
      6005,
    );

    // C. Collateral price drops to 86 (conf 1), Low = 85.
    // Collateral value = 10 * 85 = $850.
    // Liquidation line (85%): 850 * 0.85 = $722.5.
    // Debt value ($740.74) is now strictly greater than liquidation limit ($722.5)!
    await env.setPrices([86, 1], [1, 0.001]);

    const liquidatorCollateralBefore = await tokenBalance(
      env.context,
      env.liquidatorCollateral,
    );
    const liquidatorDebtBefore = await tokenBalance(
      env.context,
      env.liquidatorDebt,
    );

    await liquidate(env, env.payer.publicKey);

    const liquidatorCollateralAfter = await tokenBalance(
      env.context,
      env.liquidatorCollateral,
    );
    const liquidatorDebtAfter = await tokenBalance(
      env.context,
      env.liquidatorDebt,
    );

    // Liquidator paid full debt (740 tokens) and received all collateral (10 tokens)
    assert.equal(
      (liquidatorDebtBefore - liquidatorDebtAfter).toString(),
      oneToken().muln(740).toString(),
    );
    assert.equal(
      (liquidatorCollateralAfter - liquidatorCollateralBefore).toString(),
      oneToken().muln(10).toString(),
    );

    const position = await env.program.account.position.fetch(
      env.position(env.payer.publicKey),
    );
    assert.equal(position.debt.toString(), "0");
    assert.equal(position.collateral.toString(), "0");
  });
});
