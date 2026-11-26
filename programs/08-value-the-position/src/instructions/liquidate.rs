use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    pricing::{read_band, update_market_twap, value},
    Market, MarketError, Position, BPS,
};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    #[account(address = market.debt_mint)]
    pub debt_mint: Account<'info, Mint>,
    #[account(mut, token::mint = debt_mint, token::authority = liquidator)]
    pub liquidator_debt: Account<'info, TokenAccount>,
    #[account(mut, token::mint = collateral_mint)]
    pub liquidator_collateral: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"debt_vault"], bump)]
    pub debt_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"collateral_vault"], bump)]
    pub collateral_vault: Account<'info, TokenAccount>,
    pub collateral_price: Account<'info, PriceUpdateV2>,
    pub debt_price: Account<'info, PriceUpdateV2>,
    pub token_program: Program<'info, Token>,
}

pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
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

    // 2. Update the market's TWAP (liquidate reads price, so it updates the internal average)
    update_market_twap(market, collateral_band.mid, clock.unix_timestamp)?;

    let position = &mut ctx.accounts.position;
    require!(position.debt > 0, MarketError::NoDebt);

    // 3. Valued at its worst: collateral at low end, debt at high end.
    // Notice: liquidation does NOT use TWAP, because if the spot price really fell,
    // liquidation must start immediately to protect solvency.
    let collateral_val = value(
        position.collateral,
        collateral_band.low,
        ctx.accounts.collateral_mint.decimals,
    )?;
    let debt_val = value(
        position.debt,
        debt_band.high,
        ctx.accounts.debt_mint.decimals,
    )?;

    // Liquidation allowed ONLY above liquidation_ltv_bps:
    // debt_val * BPS > collateral_val * liquidation_ltv_bps
    let debt_scaled = debt_val
        .checked_mul(BPS as u128)
        .ok_or(MarketError::MathOverflow)?;
    let liquidation_limit = collateral_val
        .checked_mul(market.liquidation_ltv_bps as u128)
        .ok_or(MarketError::MathOverflow)?;

    require!(
        debt_scaled > liquidation_limit,
        MarketError::PositionHealthy
    );

    let repay_debt = position.debt;
    let payout_collateral = position.collateral;

    position.debt = 0;
    position.collateral = 0;

    // 4. Repay the whole debt from liquidator to debt_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.liquidator_debt.to_account_info(),
                mint: ctx.accounts.debt_mint.to_account_info(),
                to: ctx.accounts.debt_vault.to_account_info(),
                authority: ctx.accounts.liquidator.to_account_info(),
            },
        ),
        repay_debt,
        ctx.accounts.debt_mint.decimals,
    )?;

    // 5. Pay out the collateral from collateral_vault to liquidator_collateral
    if payout_collateral > 0 {
        let seeds: &[&[u8]] = &[b"market", &[market.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.liquidator_collateral.to_account_info(),
                    authority: market.to_account_info(),
                },
                &[seeds],
            ),
            payout_collateral,
            ctx.accounts.collateral_mint.decimals,
        )?;
    }

    Ok(())
}
