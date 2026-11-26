use anchor_lang::prelude::*;

use crate::{parse_ed25519, Config, RewardsError};

/// Anyone can pull a fresh oracle price into the protocol by submitting
/// a transaction containing an Ed25519 signature from config.oracle followed by set_price.
#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Instructions sysvar, verified against sysvar::instructions::ID
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn set_price(ctx: Context<SetPrice>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.instructions.key(),
        anchor_lang::solana_program::sysvar::instructions::ID,
        RewardsError::MalformedEd25519
    );

    let current_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(
        &ctx.accounts.instructions.to_account_info(),
    )?;
    require!(current_index > 0, RewardsError::NotEd25519);

    let ed25519_ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(
        (current_index - 1) as usize,
        &ctx.accounts.instructions.to_account_info(),
    )?;

    let signed = parse_ed25519(&ed25519_ix)?;
    require_keys_eq!(
        signed.pubkey,
        ctx.accounts.config.oracle,
        RewardsError::NotEd25519
    );

    require!(signed.message.len() >= 16, RewardsError::MalformedEd25519);
    let price = u64::from_le_bytes(signed.message[0..8].try_into().unwrap());
    let publish_time = i64::from_le_bytes(signed.message[8..16].try_into().unwrap());

    let now = Clock::get()?.unix_timestamp;
    require!(price > 0, RewardsError::StalePrice);
    require!(
        now >= publish_time && now - publish_time <= ctx.accounts.config.max_price_age,
        RewardsError::StalePrice
    );

    let config = &mut ctx.accounts.config;
    config.price = price;
    config.price_time = publish_time;

    Ok(())
}
