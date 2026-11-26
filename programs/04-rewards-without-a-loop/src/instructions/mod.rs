use anchor_lang::prelude::*;

use crate::{PoolError, Staker, REWARD_PRECISION};

pub mod add_rewards;
pub mod claim;
pub mod initialize;
pub mod stake;
pub mod unstake;

pub use add_rewards::*;
pub use claim::*;
pub use initialize::*;
pub use stake::*;
pub use unstake::*;

/// Settles accrued rewards owed to `staker` up to the current `reward_per_token`
/// before any change to `staker.stake` or during `claim`, and advances the marker.
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
