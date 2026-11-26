use anchor_lang::prelude::*;

#[error_code]
pub enum RoundError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("The round is closed for new entries")]
    RoundClosed,
    #[msg("The round has not ended yet")]
    RoundNotEnded,
    #[msg("The round is already settled")]
    AlreadySettled,
    #[msg("The swap returned less than the minimum")]
    SlippageExceeded,
    #[msg("The round settlement window has expired")]
    RoundExpired,
    #[msg("The refund delay has not passed yet")]
    RefundNotReady,
    #[msg("This entry has no stake to refund")]
    NoStake,
    #[msg("No DEX change is pending")]
    NoPendingDex,
    #[msg("The DEX change delay has not elapsed")]
    DexChangeDelayNotPassed,
    #[msg("Invalid DEX program")]
    InvalidDex,
}
