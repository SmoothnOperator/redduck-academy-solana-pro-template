# Solution

## Why a total commutes and a step does not

- **In the given program (deltas + nonces):**
  Suppose the oracle signs two steps: $\Delta_1 = 100$ with nonce 1, and $\Delta_2 = 150$ with nonce 2.
  - **In order ($\Delta_1$ then $\Delta_2$):** $\Delta_1$ arrives, nonce moves from 0 to 1, and paid increases by $100$. $\Delta_2$ arrives, nonce moves from 1 to 2, and paid increases by $150$. Final paid = $250$.
  - **Out of order ($\Delta_2$ then $\Delta_1$):** $\Delta_2$ lands first. Because `device.nonce` is 0 and $\Delta_2$ carries nonce 2, the check `nonce == device.nonce + 1` fails (`BadNonce`). $\Delta_2$ is permanently rejected. When $\Delta_1$ lands, it succeeds. Final paid = $100$ (the 150 reward is permanently lost!).
  - **Duplicate message:** If $\Delta_1$ is replayed without a nonce check, the device is paid twice ($100 + 100 = 200$). With strict nonces, the replay is rejected, but any dropped message permanently halts all future rewards.

- **In our program (monotonic cumulative totals):**
  The oracle signs cumulative totals: $T_1 = 100$ and $T_2 = 250$. The state transition is idempotent:
  $$\text{paid}_{\text{new}} = \max(\text{paid}, T), \quad \text{payout} = \text{paid}_{\text{new}} - \text{paid}$$
  - **In order ($T_1=100$ then $T_2=250$):**
    1. $T_1=100$: device paid was 0. Payout is $100 - 0 = 100$. `device.paid` becomes $100$.
    2. $T_2=250$: device paid is 100. Payout is $250 - 100 = 150$. `device.paid` becomes $250$. Total paid = $250$.
  - **Out of order ($T_2=250$ then $T_1=100$):**
    1. $T_2=250$: device paid was 0. Payout is $250 - 0 = 250$. `device.paid` becomes $250$.
    2. $T_1=100$: device paid is 250. Since $100 \le 250$, payout is $0$ and state is unchanged. Total paid = $250$.
  - **Duplicate message ($T_2=250$ sent twice):**
    The first claim pays $250$ and sets `paid = 250`. The duplicate sees $250 \le 250$, pays $0$, and safely no-ops.
  - Because $\max(A, B) = \max(B, A)$ and $\max(A, A) = A$, cumulative totals commute and are strictly idempotent. Every execution sequence terminates at the exact same final state.

## What the program compares

- **What `claim` compares the message with:**
  `claim` compares the signed `total` strictly against the device's current on-chain state: `device.paid`. It also compares the signature with `config.oracle` and verifies `signed.message == claim_message(device.key(), total)`.
- **What it never compares it with:**
  It **never** compares the message with:
  - Any sequential counter or nonce (`nonce == device.nonce + 1`).
  - Any history, bitmap, hash set, or bloom filter of previously processed messages.
  - Any timestamps or sequence numbers relative to other messages.

## Why the nonce could go

- **What the nonce guaranteed:** It guaranteed only that deltas were applied in strict contiguous sequential order ($1, 2, 3 \dots$) and prevented identical message replays while the device was at that nonce.
- **What it did not guarantee:** It did not guarantee message arrival or out-of-order tolerance: a single dropped or delayed packet blocked all subsequent rewards forever.
- **What makes it unnecessary in your version:** The cumulative total $T$ is monotonic and idempotent. Replay protection and order tolerance are naturally enforced by $\max(\text{device.paid}, T)$. Stale or duplicate messages automatically produce zero payout ($\le \text{device.paid}$), while newer messages immediately credit whatever unpaid difference is owed, making nonces completely obsolete.

## The boundary of the oracle's consent

- **What the oracle signs:** The oracle explicitly certifies: *"Device $D$ has earned a cumulative lifetime total of $T$ base tokens."*
- **What a claim can never do beyond what was signed:** A claim can **never** extract more than the highest signed total $T$ for that device. Regardless of how many times transactions are submitted, replayed, reordered, or interleaved, total lifetime withdrawals for the device cannot exceed $\max(T_i)$ from valid oracle signatures. The oracle's consent sets an absolute upper bound on cumulative payouts, guaranteeing treasury solvency.
