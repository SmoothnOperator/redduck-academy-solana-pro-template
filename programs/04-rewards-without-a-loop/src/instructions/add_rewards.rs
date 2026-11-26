use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Pool, PoolError, REWARD_PRECISION};

/// A reward arrives and only advances the pool's global `reward_per_token` accumulator.
/// Does not loop over stakers; any remaining accounts passed by callers are ignored.
#[derive(Accounts)]
pub struct AddRewards<'info> {
    pub funder: Signer<'info>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = funder)]
    pub funder_tokens: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"vault"],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn add_rewards<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddRewards<'info>>,
    amount: u64,
) -> Result<()> {
    let total_staked = ctx.accounts.pool.total_staked;
    require!(total_staked > 0, PoolError::NothingStaked);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let delta = (amount as u128)
        .checked_mul(REWARD_PRECISION)
        .ok_or(PoolError::MathOverflow)?
        .checked_div(total_staked as u128)
        .ok_or(PoolError::MathOverflow)?;

    let pool = &mut ctx.accounts.pool;
    pool.reward_per_token = pool
        .reward_per_token
        .checked_add(delta)
        .ok_or(PoolError::MathOverflow)?;

    Ok(())
}
