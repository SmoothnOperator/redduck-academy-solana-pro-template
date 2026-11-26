use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("CdBnueUNxmd2eB2uTthggnoKXXnq71GzWBPU3TCjBADi");

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

#[program]
pub mod lazy_pool {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize(ctx)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::unstake(ctx, amount)
    }

    pub fn add_rewards<'info>(
        ctx: Context<'_, '_, 'info, 'info, AddRewards<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::add_rewards(ctx, amount)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim(ctx)
    }
}
