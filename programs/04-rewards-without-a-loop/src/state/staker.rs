use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Staker {
    pub owner: Pubkey,
    pub stake: u64,
    /// Rewards settled at the last stake/unstake and not yet claimed.
    pub pending: u64,
    /// Value of `pool.reward_per_token` at the staker's last settlement.
    pub reward_per_token_paid: u128,
    pub bump: u8,
}

impl Staker {
    /// Settles accrued rewards owed to `self` up to `reward_per_token` and advances `reward_per_token_paid`.
    pub fn settle(&mut self, reward_per_token: u128) -> Result<()> {
        let delta = reward_per_token
            .checked_sub(self.reward_per_token_paid)
            .ok_or(crate::PoolError::MathOverflow)?;
        if self.stake > 0 && delta > 0 {
            let earned = (self.stake as u128)
                .checked_mul(delta)
                .ok_or(crate::PoolError::MathOverflow)?
                .checked_div(crate::REWARD_PRECISION)
                .ok_or(crate::PoolError::MathOverflow)?;
            let earned_u64 = u64::try_from(earned).map_err(|_| crate::PoolError::MathOverflow)?;
            self.pending = self
                .pending
                .checked_add(earned_u64)
                .ok_or(crate::PoolError::MathOverflow)?;
        }
        self.reward_per_token_paid = reward_per_token;
        Ok(())
    }
}
