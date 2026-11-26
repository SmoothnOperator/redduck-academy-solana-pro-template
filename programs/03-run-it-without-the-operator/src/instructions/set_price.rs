use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::instruction::Instruction;

use crate::{Config, RewardsError};

/// What an Ed25519 instruction verified: the key that signed and the message.
pub struct Ed25519Signed {
    pub pubkey: Pubkey,
    pub message: Vec<u8>,
}

/// Parses a single-signature instruction built for the native Ed25519 program.
/// Verifies that the program ID is ed25519_program::ID and validates the 16-byte header
/// and data offsets.
pub fn parse_ed25519(ix: &Instruction) -> Result<Ed25519Signed> {
    require_keys_eq!(ix.program_id, ed25519_program::ID, RewardsError::NotEd25519);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, RewardsError::MalformedEd25519);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix) = (u16_at(4), u16_at(6), u16_at(8));
    let (msg_off, msg_size, msg_ix) = (u16_at(10), u16_at(12), u16_at(14));
    require!(
        sig_ix == 0xffff && pk_ix == 0xffff && msg_ix == 0xffff,
        RewardsError::MalformedEd25519
    );
    require!(
        d.len() >= pk_off + 32 && d.len() >= msg_off + msg_size,
        RewardsError::MalformedEd25519
    );
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&d[pk_off..pk_off + 32]);
    Ok(Ed25519Signed {
        pubkey: Pubkey::from(pubkey),
        message: d[msg_off..msg_off + msg_size].to_vec(),
    })
}

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

    require_keys_eq!(
        ed25519_ix.program_id,
        anchor_lang::solana_program::ed25519_program::ID,
        RewardsError::NotEd25519
    );

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
