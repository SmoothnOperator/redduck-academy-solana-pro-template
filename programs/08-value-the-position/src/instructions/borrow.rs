use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    pricing::{read_band, update_market_twap, value},
    Market, MarketError, Position, BPS,
};

#[derive(Accounts)]
pub struct Borrow<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
    )]
    pub position: Account<'info, Position>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    #[account(address = market.debt_mint)]
    pub debt_mint: Account<'info, Mint>,
    #[account(mut, token::mint = debt_mint)]
    pub owner_debt: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"debt_vault"], bump)]
    pub debt_vault: Account<'info, TokenAccount>,
    pub collateral_price: Account<'info, PriceUpdateV2>,
    pub debt_price: Account<'info, PriceUpdateV2>,
    pub token_program: Program<'info, Token>,
}

pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;

    // 1. Read bands for collateral and debt with freshness check
    let collateral_band = read_band(
        &ctx.accounts.collateral_price,
        &market.collateral_feed,
        market.max_price_age,
        &clock,
    )?;
    let debt_band = read_band(
        &ctx.accounts.debt_price,
        &market.debt_feed,
        market.max_price_age,
        &clock,
    )?;

    // 2. Update the market's own time-weighted average of the collateral price
    update_market_twap(market, collateral_band.mid, clock.unix_timestamp)?;

    // 3. Value position at its worst:
    // Collateral at the low end of its band, and bounded by the market's TWAP
    // so a short price spike cannot be borrowed against.
    let effective_collateral_price = std::cmp::min(collateral_band.low, market.collateral_twap);
    // Debt at the high end of its band.
    let effective_debt_price = debt_band.high;

    let position = &mut ctx.accounts.position;
    let new_debt = position
        .debt
        .checked_add(amount)
        .ok_or(MarketError::MathOverflow)?;

    let collateral_val = value(
        position.collateral,
        effective_collateral_price,
        ctx.accounts.collateral_mint.decimals,
    )?;
    let debt_val = value(
        new_debt,
        effective_debt_price,
        ctx.accounts.debt_mint.decimals,
    )?;

    // Refuse borrow above borrow_ltv_bps:
    // debt_val * BPS <= collateral_val * borrow_ltv_bps
    let debt_scaled = debt_val
        .checked_mul(BPS as u128)
        .ok_or(MarketError::MathOverflow)?;
    let borrow_limit = collateral_val
        .checked_mul(market.borrow_ltv_bps as u128)
        .ok_or(MarketError::MathOverflow)?;

    require!(
        debt_scaled <= borrow_limit,
        MarketError::BorrowLimitExceeded
    );

    position.debt = new_debt;

    // Transfer borrowed debt tokens from debt_vault to owner_debt
    let seeds: &[&[u8]] = &[b"market", &[market.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.debt_vault.to_account_info(),
                mint: ctx.accounts.debt_mint.to_account_info(),
                to: ctx.accounts.owner_debt.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.debt_mint.decimals,
    )
}
