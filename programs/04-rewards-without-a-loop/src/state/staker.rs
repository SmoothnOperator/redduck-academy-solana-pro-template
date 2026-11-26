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
