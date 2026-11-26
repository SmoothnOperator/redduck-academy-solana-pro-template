use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::{Config, MultisigError, Proposal};

/// Runs the stored instruction with the vault PDA as the signer.
/// Anyone may send it once approvals reach the threshold.
#[derive(Accounts)]
pub struct Execute<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"proposal", proposal.id.to_le_bytes().as_ref()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: the treasury PDA that signs the stored instruction.
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
}

pub fn execute<'info>(ctx: Context<'_, '_, 'info, 'info, Execute<'info>>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;

    // 1. Proposal executes once and never again
    require!(!proposal.executed, MultisigError::AlreadyExecuted);

    // 2. Approvals must reach the threshold
    require!(
        proposal.approvals >= ctx.accounts.config.threshold,
        MultisigError::NotApproved
    );

    // 3. Proposal must not be expired
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= proposal.expires_at,
        MultisigError::Expired
    );

    // 4. Verify remaining accounts match stored metas one by one, plus the target program at the end
    require!(
        ctx.remaining_accounts.len() == proposal.metas.len() + 1,
        MultisigError::AccountMismatch
    );

    // The target program must match the stored one
    let target_program = &ctx.remaining_accounts[proposal.metas.len()];
    require_keys_eq!(
        target_program.key(),
        proposal.program_id,
        MultisigError::AccountMismatch
    );

    // The remaining accounts the executor passes must match the stored metas one by one:
    // same pubkey, same writability, and signer only for the vault PDA.
    for (i, meta) in proposal.metas.iter().enumerate() {
        let account = &ctx.remaining_accounts[i];
        require_keys_eq!(account.key(), meta.pubkey, MultisigError::AccountMismatch);
        require!(
            account.is_writable == meta.is_writable,
            MultisigError::AccountMismatch
        );
        if meta.is_signer {
            require_keys_eq!(
                meta.pubkey,
                ctx.accounts.vault.key(),
                MultisigError::AccountMismatch
            );
        }
        if account.is_signer {
            require_keys_eq!(
                account.key(),
                ctx.accounts.vault.key(),
                MultisigError::AccountMismatch
            );
        }
    }

    let metas = proposal
        .metas
        .iter()
        .map(|meta| AccountMeta {
            pubkey: meta.pubkey,
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect();
    let seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.config.vault_bump]];
    invoke_signed(
        &Instruction {
            program_id: proposal.program_id,
            accounts: metas,
            data: proposal.data.clone(),
        },
        ctx.remaining_accounts,
        &[seeds],
    )?;

    ctx.accounts.proposal.executed = true;
    Ok(())
}
