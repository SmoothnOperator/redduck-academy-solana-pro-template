use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{parse_ed25519, ClaimError, Config, Device};

/// Pays rewards based on cumulative total earned signed by the oracle.
/// The device stores how much was already paid; a claim pays the difference
/// and advances the paid amount to the signed total. If total <= paid, changes nothing.
#[derive(Accounts)]
pub struct Claim<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"device", device.owner.as_ref()], bump = device.bump)]
    pub device: Account<'info, Device>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = device.owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the instructions sysvar; its address is verified before reading from it.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// The message the oracle signs for a claim: device pubkey and cumulative total earned.
pub fn claim_message(device: &Pubkey, total: u64) -> Vec<u8> {
    let mut message = Vec::with_capacity(40);
    message.extend_from_slice(device.as_ref());
    message.extend_from_slice(&total.to_le_bytes());
    message
}

pub fn claim(ctx: Context<Claim>, total: u64) -> Result<()> {
    let signature_check = load_instruction_at_checked(0, &ctx.accounts.instructions)?;
    let signed = parse_ed25519(&signature_check)?;
    require_keys_eq!(
        signed.pubkey,
        ctx.accounts.config.oracle,
        ClaimError::WrongSigner
    );
    let expected = claim_message(&ctx.accounts.device.key(), total);
    require!(signed.message == expected, ClaimError::MessageMismatch);

    let device = &mut ctx.accounts.device;
    if total <= device.paid {
        // A message with a total at or below the paid amount changes nothing.
        return Ok(());
    }

    let amount = total
        .checked_sub(device.paid)
        .ok_or(ClaimError::MathOverflow)?;
    device.paid = total;

    let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_tokens.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}
