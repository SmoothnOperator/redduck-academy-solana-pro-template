use anchor_lang::prelude::*;

use crate::{Config, RoundError, DEX_CHANGE_DELAY_SECONDS};

#[derive(Accounts)]
pub struct ProposeDex<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct ApplyDex<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CancelDex<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn propose_dex(ctx: Context<ProposeDex>, new_dex: Pubkey) -> Result<()> {
    require!(new_dex != Pubkey::default(), RoundError::InvalidDex);
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    config.pending_dex = new_dex;
    config.dex_effective_at = now
        .checked_add(DEX_CHANGE_DELAY_SECONDS)
        .ok_or(RoundError::MathOverflow)?;
    Ok(())
}

pub fn apply_dex(ctx: Context<ApplyDex>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.pending_dex != Pubkey::default(),
        RoundError::NoPendingDex
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= config.dex_effective_at,
        RoundError::DexChangeDelayNotPassed
    );
    config.dex_program = config.pending_dex;
    config.pending_dex = Pubkey::default();
    config.dex_effective_at = 0;
    Ok(())
}

pub fn cancel_dex(ctx: Context<CancelDex>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.pending_dex != Pubkey::default(),
        RoundError::NoPendingDex
    );
    config.pending_dex = Pubkey::default();
    config.dex_effective_at = 0;
    Ok(())
}
