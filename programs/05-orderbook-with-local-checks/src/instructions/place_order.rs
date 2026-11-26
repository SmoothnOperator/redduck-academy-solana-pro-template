use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Book, BookError, CELLS, NONE};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"book"], bump = book.load()?.bump)]
    pub book: AccountLoader<'info, Book>,
    #[account(address = book.load()?.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Places an order. `hint` is the cell the new order should go after, or `None` for the head.
/// Verifies the local ordering around `hint` in O(1) without looping over the book.
pub fn place_order(
    ctx: Context<PlaceOrder>,
    price: u64,
    size: u64,
    hint: Option<u16>,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        size,
        ctx.accounts.mint.decimals,
    )?;

    let mut book = ctx.accounts.book.load_mut()?;
    let cell = book.free_head;
    require!(cell != NONE, BookError::BookFull);

    // Validate the hint in O(1) with local neighbor checks:
    let after = match hint {
        None => {
            // New order goes at the head: the head must be empty (NONE) or strictly cheaper.
            if book.head != NONE {
                require!((book.head as usize) < CELLS, BookError::BadHint);
                let head = &book.cells[book.head as usize];
                require!(head.alive == 1 && head.price < price, BookError::BadHint);
            }
            NONE
        }
        Some(hint_idx) => {
            // New order goes after `hint_idx`:
            // 1. Hint cell must be within bounds and alive.
            require!((hint_idx as usize) < CELLS, BookError::BadHint);
            let hint_cell = &book.cells[hint_idx as usize];
            require!(hint_cell.alive == 1, BookError::BadHint);

            // 2. The order before (the hint) must not be cheaper than the new order.
            require!(hint_cell.price >= price, BookError::BadHint);

            // 3. The order after must be NONE (tail) or alive with a price strictly below the new price.
            let next_idx = hint_cell.next;
            if next_idx != NONE {
                require!((next_idx as usize) < CELLS, BookError::BadHint);
                let next_cell = &book.cells[next_idx as usize];
                require!(
                    next_cell.alive == 1 && next_cell.price < price,
                    BookError::BadHint
                );
            }
            hint_idx
        }
    };

    book.free_head = book.cells[cell as usize].next;

    link(
        &mut book,
        cell,
        after,
        ctx.accounts.owner.key(),
        price,
        size,
    );
    Ok(())
}

/// Links `cell` into the list right after `after` (or at the head when `after` is NONE).
pub fn link(book: &mut Book, cell: u16, after: u16, owner: Pubkey, price: u64, size: u64) {
    let next = if after == NONE {
        book.head
    } else {
        book.cells[after as usize].next
    };
    let c = &mut book.cells[cell as usize];
    c.owner = owner;
    c.price = price;
    c.size = size;
    c.prev = after;
    c.next = next;
    c.alive = 1;
    if after == NONE {
        book.head = cell;
    } else {
        book.cells[after as usize].next = cell;
    }
    if next != NONE {
        book.cells[next as usize].prev = cell;
    }
}
