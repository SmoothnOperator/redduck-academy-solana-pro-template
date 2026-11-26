use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Pool, PoolError, Staker, REWARD_PRECISION};

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"staker", owner.key().as_ref()], bump = staker.bump, has_one = owner)]
    pub staker: Account<'info, Staker>,
    #[account(address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
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

pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    require!(ctx.accounts.staker.stake >= amount, PoolError::InsufficientStake);

    // Settle rewards owed on the prior stake BEFORE decreasing `staker.stake`.
    let pool_reward_per_token = ctx.accounts.pool.reward_per_token;
    let staker = &mut ctx.accounts.staker;
    let delta = pool_reward_per_token
        .checked_sub(staker.reward_per_token_paid)
        .ok_or(PoolError::MathOverflow)?;
    if staker.stake > 0 && delta > 0 {
        let earned = (staker.stake as u128)
            .checked_mul(delta)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(REWARD_PRECISION)
            .ok_or(PoolError::MathOverflow)?;
        let earned_u64 = u64::try_from(earned).map_err(|_| PoolError::MathOverflow)?;
        staker.pending = staker
            .pending
            .checked_add(earned_u64)
            .ok_or(PoolError::MathOverflow)?;
    }
    staker.reward_per_token_paid = pool_reward_per_token;

    staker.stake = staker
        .stake
        .checked_sub(amount)
        .ok_or(PoolError::MathOverflow)?;

    let pool = &mut ctx.accounts.pool;
    pool.total_staked = pool
        .total_staked
        .checked_sub(amount)
        .ok_or(PoolError::MathOverflow)?;

    let seeds: &[&[u8]] = &[b"pool", &[pool.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_tokens.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}
