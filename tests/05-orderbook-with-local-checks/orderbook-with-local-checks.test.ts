import { assert } from "chai";
import { BN } from "@coral-xyz/anchor";

import { numToHex, oneToken, toBN, tokenBalance } from "../helpers";
import { BookFixture, findHint, listOrders, setupBook, NONE } from "./fixture";
import { cancelOrder, placeOrder } from "./actions";

/** Helper asserting a transaction reverts with either the Anchor error name or hex error code. */
const expectBookError = async (
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

describe("05-orderbook-with-local-checks", () => {
  let env: BookFixture;

  beforeEach(async () => {
    env = await setupBook();
  });

  it("keeps the orders sorted from the highest price to the lowest", async () => {
    const [alice, bob, carol] = env.traders;
    for (const [trader, price] of [
      [alice, 10],
      [bob, 30],
      [carol, 20],
    ] as const) {
      const hint = findHint(await env.readBook(), toBN(price));
      await placeOrder(env, trader, toBN(price), oneToken(), hint);
    }

    const book = await env.readBook();
    const prices = listOrders(book).map((cell) =>
      book.cells[cell].price.toNumber(),
    );
    assert.deepEqual(prices, [30, 20, 10]);
    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      oneToken().muln(3).toString(),
    );

    const bobsCell = listOrders(book)[0];
    await cancelOrder(env, bob, bobsCell);
    const after = await env.readBook();
    assert.deepEqual(
      listOrders(after).map((cell) => after.cells[cell].price.toNumber()),
      [20, 10],
    );
  });

  it("inserts orders at the head, in the middle, and at the tail with O(1) checks", async () => {
    const [alice, bob, carol] = env.traders;

    // 1. Initial order at price 50 (hint: null -> head of empty book)
    await placeOrder(env, alice, toBN(50), oneToken(), null);

    // 2. Insert at tail: price 20 (hint: cell of 50, next is NONE)
    let book = await env.readBook();
    const cell50 = book.head;
    await placeOrder(env, bob, toBN(20), oneToken(), cell50);

    // 3. Insert at head: price 80 (hint: null, head 50 is cheaper than 80)
    await placeOrder(env, carol, toBN(80), oneToken(), null);

    // 4. Insert in the middle: price 60 (hint: cell of 80, next is 50 -> 80 >= 60 > 50)
    book = await env.readBook();
    const cell80 = book.head;
    await placeOrder(env, alice, toBN(60), oneToken(), cell80);

    // 5. Insert at tail: price 10 (hint: cell of 20, next is NONE -> 20 >= 10)
    book = await env.readBook();
    const orders = listOrders(book);
    const cell20 = orders[orders.length - 1];
    await placeOrder(env, bob, toBN(10), oneToken(), cell20);

    // Verify complete descending order: [80, 60, 50, 20, 10]
    book = await env.readBook();
    const finalPrices = listOrders(book).map((c) =>
      book.cells[c].price.toNumber(),
    );
    assert.deepEqual(finalPrices, [80, 60, 50, 20, 10]);

    // Verify vault holds 5 tokens escrowed
    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      oneToken().muln(5).toString(),
    );
  });

  it("refuses wrong hints with BadHint", async () => {
    const [alice] = env.traders;

    // Place [80, 50, 20]
    await placeOrder(env, alice, toBN(50), oneToken(), null);
    let book = await env.readBook();
    const cell50 = book.head;
    await placeOrder(env, alice, toBN(20), oneToken(), cell50);
    await placeOrder(env, alice, toBN(80), oneToken(), null);

    book = await env.readBook();
    const [c80, c50, c20] = listOrders(book);

    // Case A: Hint is null, but head (80) is not cheaper than 40
    await expectBookError(
      placeOrder(env, alice, toBN(40), oneToken(), null),
      "BadHint",
      6005,
    );

    // Case B: Hint points to 20 for price 60 (hint price 20 < 60)
    await expectBookError(
      placeOrder(env, alice, toBN(60), oneToken(), c20),
      "BadHint",
      6005,
    );

    // Case C: Hint points to 80 for price 15, but next cell is 50 (50 >= 15)
    await expectBookError(
      placeOrder(env, alice, toBN(15), oneToken(), c80),
      "BadHint",
      6005,
    );

    // Case D: Hint points to an unallocated/dead cell index
    await expectBookError(
      placeOrder(env, alice, toBN(15), oneToken(), 50),
      "BadHint",
      6005,
    );

    // Case E: Hint points out of bounds (64)
    await expectBookError(
      placeOrder(env, alice, toBN(15), oneToken(), 64),
      "BadHint",
      6005,
    );
  });

  it("refuses a hint that went stale after another insertion", async () => {
    const [alice, bob] = env.traders;

    // Start with book having [50, 20]
    await placeOrder(env, alice, toBN(50), oneToken(), null);
    let book = await env.readBook();
    const cell50 = book.head;
    await placeOrder(env, alice, toBN(20), oneToken(), cell50);

    // Alice wants to place price 35. At this moment, hint is cell50 (next is 20).
    const staleHint = cell50;

    // Before Alice's order lands, Bob inserts price 40 after cell50
    await placeOrder(env, bob, toBN(40), oneToken(), cell50);

    // Now book is [50, 40, 20]. The order right after cell50 is now 40 (not 20).
    // Alice submits her order at price 35 with staleHint (cell50).
    // On-chain check: cell50.next is 40, and 40 >= 35, so next is NOT cheaper than 35.
    await expectBookError(
      placeOrder(env, alice, toBN(35), oneToken(), staleHint),
      "BadHint",
      6005,
    );
  });

  it("cancels an order in the middle, relinks correctly, and reuses the freed cell", async () => {
    const [alice, bob, carol] = env.traders;

    // Place [70, 50, 30]
    await placeOrder(env, alice, toBN(70), oneToken(), null);
    let book = await env.readBook();
    const cell70 = book.head;
    await placeOrder(env, bob, toBN(50), oneToken(), cell70);
    book = await env.readBook();
    const cell50 = book.cells[cell70].next;
    await placeOrder(env, carol, toBN(30), oneToken(), cell50);

    book = await env.readBook();
    const cell30 = book.cells[cell50].next;
    assert.deepEqual(listOrders(book), [cell70, cell50, cell30]);

    // Bob cancels order 50 in the middle
    const bobTokensBefore = await tokenBalance(env.context, bob.tokens);
    await cancelOrder(env, bob, cell50);
    const bobTokensAfter = await tokenBalance(env.context, bob.tokens);
    assert.equal(
      (bobTokensAfter - bobTokensBefore).toString(),
      oneToken().toString(),
      "Cancelling must refund locked tokens",
    );

    // Verify relinking: cell70 points to cell30, cell30 points back to cell70
    book = await env.readBook();
    assert.deepEqual(listOrders(book), [cell70, cell30]);
    assert.equal(book.cells[cell70].next, cell30);
    assert.equal(book.cells[cell30].prev, cell70);
    assert.equal(book.freeHead, cell50);

    // Place new order at price 40: must reuse cell50
    await placeOrder(env, alice, toBN(40), oneToken(), cell70);
    book = await env.readBook();
    assert.deepEqual(listOrders(book), [cell70, cell50, cell30]);
    assert.equal(book.cells[cell50].price.toNumber(), 40);
    assert.equal(book.cells[cell50].prev, cell70);
    assert.equal(book.cells[cell50].next, cell30);
  });

  it("refuses to place an order when the book is full", async () => {
    const [alice] = env.traders;

    // Fill all 64 cells of the book
    for (let i = 0; i < 64; i++) {
      const price = toBN(1000 + i);
      const book = await env.readBook();
      const hint = findHint(book, price);
      // Use small size of 1 base unit so token balance is negligible
      await placeOrder(env, alice, price, toBN(1), hint);
    }

    const fullBook = await env.readBook();
    assert.equal(fullBook.freeHead, NONE);
    assert.equal(listOrders(fullBook).length, 64);

    // 65th order must be refused with BookFull (6001)
    const price65 = toBN(2000);
    await expectBookError(
      placeOrder(env, alice, price65, toBN(1), null),
      "BookFull",
      6001,
    );
  });
});
