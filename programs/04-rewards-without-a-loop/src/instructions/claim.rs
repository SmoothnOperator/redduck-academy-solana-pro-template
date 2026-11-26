use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Pool, PoolError, Staker, REWARD_PRECISION};

#[derive(Accounts)]
pub struct Claim<'info> {
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

/// Settles accrued rewards owed to `staker` up to `reward_per_token` and advances the marker.
pub fn settle_staker(staker: &mut Staker, reward_per_token: u128) -> Result<()> {
    let delta = reward_per_token
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
    staker.reward_per_token_paid = reward_per_token;
    Ok(())
}

pub fn claim(ctx: Context<Claim>) -> Result<()> {
    let pool_reward_per_token = ctx.accounts.pool.reward_per_token;
    let staker = &mut ctx.accounts.staker;

    // Settle what is owed: difference between pool's reward_per_token and staker's marker times stake
    let delta = pool_reward_per_token
        .checked_sub(staker.reward_per_token_paid)
        .ok_or(PoolError::MathOverflow)?;
    let earned = if staker.stake > 0 && delta > 0 {
        let earned_u128 = (staker.stake as u128)
            .checked_mul(delta)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(REWARD_PRECISION)
            .ok_or(PoolError::MathOverflow)?;
        u64::try_from(earned_u128).map_err(|_| PoolError::MathOverflow)?
    } else {
        0
    };

    // Move the marker to the pool's current reward_per_token
    staker.reward_per_token_paid = pool_reward_per_token;

    // Total claimable payout = previously settled pending rewards + newly earned difference
    let amount = staker
        .pending
        .checked_add(earned)
        .ok_or(PoolError::MathOverflow)?;
    staker.pending = 0;

    // If nothing is owed, exit cleanly without transferring tokens
    if amount == 0 {
        return Ok(());
    }

    let seeds: &[&[u8]] = &[b"pool", &[ctx.accounts.pool.bump]];
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
