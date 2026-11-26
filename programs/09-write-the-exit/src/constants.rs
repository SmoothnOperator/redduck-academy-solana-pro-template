use anchor_lang::prelude::*;

pub const DEX_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Delay after round deadline before players can refund their stakes if unsettled (1 hour).
pub const REFUND_DELAY_SECONDS: i64 = 3600;

/// Delay before a proposed DEX change takes effect (24 hours).
pub const DEX_CHANGE_DELAY_SECONDS: i64 = 86400;
