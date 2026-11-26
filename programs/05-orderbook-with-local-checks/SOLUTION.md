# Solution

## The two complexities

- **Off-chain complexity:** $O(n)$ for a linear scan through the book's linked list, or $O(\log n)$ if the client maintains a sorted index (such as a search tree or skiplist). The client reads the book state from RPC, finds the cell after which the new order belongs, and provides that index as the `hint`.
- **On-chain complexity:** Strictly $O(1)$ constant time and compute units ($CU$). The on-chain program never iterates through the book; it only inspects at most 2 cells (the `hint` cell and its `next` neighbor, or the `head` cell if `hint` is `None`).
- **Why on-chain cost does not grow with the book:**
  This design employs **complexity asymmetry**: finding the right position in a sorted sequence requires searching through the collection ($O(n)$), but verifying that a position is locally correct only requires comparing against its immediate neighbors ($O(1)$). Because the program delegates the search to the off-chain client and only verifies the local invariant ($P_{\text{hint}} \ge P_{\text{new}} > P_{\text{next}}$), the number of cell reads and comparisons on-chain is bounded and identical regardless of whether the book holds 1 order or 10,000 orders.

## The checks

`place_order` performs the following comparisons:

1. `book.free_head != NONE`:
   - Checks that an unused cell is available in the book.
   - Catches attempting to place an order when all capacity is exhausted (`BookError::BookFull`).

2. **When `hint` is `None` (claiming insertion at the head):**
   - `book.head == NONE || (head.alive == 1 && head.price < price)`:
   - Catches passing `None` when the book already has active orders and the current highest price is greater than or equal to the new order's price (`head.price >= price`). This prevents placing an order at the head when it belongs further down or behind an older order at the same price. Also catches dead or corrupted head pointers.

3. **When `hint` is `Some(hint_idx)` (claiming insertion after `hint_idx`):**
   - `hint_idx < CELLS`:
     - Catches out-of-bounds cell indices passed by buggy or malicious callers.
   - `hint_cell.alive == 1`:
     - Catches a hint pointing to an unallocated cell, a previously cancelled order, or a free-list cell (`BookError::BadHint`).
   - `hint_cell.price >= price`:
     - Catches a hint pointing to an order cheaper than the new order. The new order should have been placed ahead of `hint_cell` to preserve descending price order.
   - `hint_cell.next == NONE || (next_cell.alive == 1 && next_cell.price < price)`:
     - When `next != NONE`:
       - Catches an invalid link (`next_idx >= CELLS` or `next_cell.alive == 0`).
       - Catches `next_cell.price >= price`. This catches two scenarios:
         1. **Wrong hint:** The client skipped orders and tried to insert ahead of an existing order with a higher or equal price.
         2. **Stale hint:** Between the client's RPC query and transaction execution, a concurrent transaction inserted an order after `hint_cell` whose price is $\ge \text{price}$. The program catches that the neighbors have changed and refuses the stale hint.

## The fixed capacity

- **Why the number of cells is fixed:**
  Solana accounts require upfront rent allocation and fixed-size layout for zero-copy deserialization (`AccountLoader` with `repr(C)`). Dynamically resizing an account during execution adds transaction overhead, realloc costs, and memory fragmentation. A fixed buffer guarantees predictable memory usage, bounds worst-case serialization costs, and fits inside Solana's account size limits.
- **What an attacker could do if placement cost grew with book size:**
  If order placement were $O(n)$ with unbounded capacity, an attacker could flood the book with thousands of micro-orders. As the linked list grows, the compute units needed to traverse the list would eventually exceed the Solana transaction compute limit (1.4 million CU). At that point, any transaction attempting to insert an order would run out of compute units and revert, causing a permanent Denial of Service (DoS) that renders the orderbook unusable.
- **What stops an attacker from filling this fixed book for free:**
  **Capital lockup:** Every placed order requires an upfront CPI token transfer that escrows `size` tokens into the vault account. The only way to retrieve those tokens is by calling `cancel_order`. Filling all 64 cells requires the attacker to lock up real capital ($\sum \text{size}_i$), creating a substantial financial opportunity cost and preventing costless spam attacks.
