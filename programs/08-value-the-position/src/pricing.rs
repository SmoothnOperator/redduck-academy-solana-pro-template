use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{Market, MarketError, AVERAGE_WINDOW_SECONDS, PRICE_DECIMALS};

pub struct Band {
    pub low: u64,
    pub mid: u64,
    pub high: u64,
}

pub fn read_band(
    update: &PriceUpdateV2,
    feed_id: &[u8; 32],
    max_age: u64,
    clock: &Clock,
) -> Result<Band> {
    let price = update
        .get_price_no_older_than(clock, max_age, feed_id)
        .map_err(|_| MarketError::StalePrice)?;
    require!(price.price > 0, MarketError::InvalidPrice);
    let price_u64 = u64::try_from(price.price).map_err(|_| MarketError::MathOverflow)?;
    let conf = price.conf;

    let low_raw = price_u64.saturating_sub(conf);
    let mid_raw = price_u64;
    let high_raw = price_u64.checked_add(conf).ok_or(MarketError::MathOverflow)?;

    let low = scale(low_raw, price.exponent)?;
    let mid = scale(mid_raw, price.exponent)?;
    let high = scale(high_raw, price.exponent)?;

    Ok(Band { low, mid, high })
}

/// Updates the market's internal time-weighted average of the collateral price.
pub fn update_market_twap(market: &mut Market, current_price: u64, now: i64) -> Result<()> {
    if market.last_update_time == 0 || market.collateral_twap == 0 {
        market.collateral_twap = current_price;
        market.last_update_time = now;
        return Ok(());
    }

    let dt = now.saturating_sub(market.last_update_time);
    if dt <= 0 {
        return Ok(());
    }

    let window = AVERAGE_WINDOW_SECONDS; // 300 seconds
    if dt >= window {
        market.collateral_twap = current_price;
    } else {
        let old_weight = (window - dt) as u128;
        let new_weight = dt as u128;
        let weighted = old_weight
            .checked_mul(market.collateral_twap as u128)
            .ok_or(MarketError::MathOverflow)?
            .checked_add(
                new_weight
                    .checked_mul(current_price as u128)
                    .ok_or(MarketError::MathOverflow)?,
            )
            .ok_or(MarketError::MathOverflow)?
            / (window as u128);
        market.collateral_twap = u64::try_from(weighted).map_err(|_| MarketError::MathOverflow)?;
    }
    market.last_update_time = now;
    Ok(())
}

pub fn value(amount: u64, price: u64, decimals: u8) -> Result<u128> {
    Ok((amount as u128)
        .checked_mul(price as u128)
        .ok_or(MarketError::MathOverflow)?
        / 10u128.pow(decimals as u32))
}

pub fn scale(value: u64, exponent: i32) -> Result<u64> {
    let target = -(PRICE_DECIMALS as i32);
    let value = value as u128;
    let scaled = if exponent < target {
        value / 10u128.pow((target - exponent) as u32)
    } else {
        value
            .checked_mul(10u128.pow((exponent - target) as u32))
            .ok_or(MarketError::MathOverflow)?
    };
    u64::try_from(scaled).map_err(|_| MarketError::MathOverflow.into())
}
