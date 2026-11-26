use anchor_lang::prelude::*;

use crate::{Config, MultisigError, Proposal};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"proposal", proposal.id.to_le_bytes().as_ref()],
        bump = proposal.bump,
        close = proposer,
    )]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: Proposer receives the returned rent lamports.
    #[account(mut, address = proposal.proposer)]
    pub proposer: SystemAccount<'info>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    require!(!proposal.executed, MultisigError::AlreadyExecuted);

    let caller = ctx.accounts.caller.key();
    let clock = Clock::get()?;
    let is_expired = clock.unix_timestamp > proposal.expires_at;
    let is_proposer = caller == proposal.proposer;
    let is_member = ctx.accounts.config.is_member(&caller);

    require!(
        is_proposer || is_member || is_expired,
        MultisigError::NotAMember
    );

    Ok(())
}
