import { describe, expect, it } from 'vitest';
import { applySpread, bpsFee, convert, divRound, formatDecimal, formatFixed, parseDecimal, rescale, scheduleFee } from './fx-math';

describe('fx math (exact decimals)', () => {
  it('parses and formats decimals', () => {
    expect(parseDecimal('83.2500')).toEqual({ units: 832500n, scale: 4 });
    expect(formatDecimal({ units: 8295862500n, scale: 8 })).toBe('82.958625');
    expect(formatDecimal({ units: 72146600000n, scale: 9 })).toBe('72.1466');
    expect(formatDecimal({ units: 5n, scale: 0 })).toBe('5.0000');
    expect(() => parseDecimal('-1')).toThrow();
  });

  it('applies a 35 bps spread against the customer', () => {
    expect(formatDecimal(applySpread('83.2500', 35))).toBe('82.958625');
    expect(formatDecimal(applySpread('5.9100', 35))).toBe('5.889315');
    expect(formatDecimal(applySpread('72.4000', 35))).toBe('72.1466');
  });

  it('converts with floor rounding in minor units', () => {
    // 1,250.00 USD * 82.958625 = 103,698.28125 INR -> 10,369,828 paise
    expect(convert({ amountMinor: 125_000, currency: 'USD' }, applySpread('83.2500', 35), 'INR')).toEqual({ amountMinor: 10_369_828, currency: 'INR' });
    // 500.00 EUR * 5.889315 = 2,944.6575 BRL -> 294,465 centavos
    expect(convert({ amountMinor: 50_000, currency: 'EUR' }, applySpread('5.9100', 35), 'BRL')).toEqual({ amountMinor: 294_465, currency: 'BRL' });
    // 1,000.00 GBP * 72.1466 = 72,146.60 PHP
    expect(convert({ amountMinor: 100_000, currency: 'GBP' }, applySpread('72.4000', 35), 'PHP')).toEqual({ amountMinor: 7_214_660, currency: 'PHP' });
    // zero-decimal target currency
    expect(convert({ amountMinor: 100, currency: 'USD' }, parseDecimal('150.5'), 'JPY')).toEqual({ amountMinor: 150, currency: 'JPY' });
    // max amount stays exact
    expect(convert({ amountMinor: 100_000_000, currency: 'USD' }, applySpread('83.2500', 35), 'INR').amountMinor).toBe(8_295_862_500);
  });

  it('computes basis-point fees with a minimum', () => {
    expect(bpsFee({ amountMinor: 125_000, currency: 'USD' }, 15, 100)).toEqual({ amountMinor: 188, currency: 'USD' }); // 187.5 -> 188
    expect(bpsFee({ amountMinor: 50_000, currency: 'EUR' }, 15, 100)).toEqual({ amountMinor: 100, currency: 'EUR' }); // 75 -> min 100
  });

  it('rounds half-up when asked (FX engine)', () => {
    // 1,250.00 EUR * 5.886932 = 7,358.665 BRL -> floor 735,866 / half-up 735,867
    expect(convert({ amountMinor: 125_000, currency: 'EUR' }, parseDecimal('5.886932'), 'BRL')).toEqual({ amountMinor: 735_866, currency: 'BRL' });
    expect(convert({ amountMinor: 125_000, currency: 'EUR' }, parseDecimal('5.886932'), 'BRL', 'half-up')).toEqual({ amountMinor: 735_867, currency: 'BRL' });
    expect(convert({ amountMinor: 125_000, currency: 'EUR' }, parseDecimal('5.886931'), 'BRL', 'half-up')).toEqual({ amountMinor: 735_866, currency: 'BRL' }); // .38750 -> down
    expect(divRound(15n, 10n, 'half-up')).toBe(2n);
    expect(divRound(14n, 10n, 'half-up')).toBe(1n);
    expect(divRound(19n, 10n, 'floor')).toBe(1n);
  });

  it('rescales and formats with a fixed number of decimals', () => {
    expect(rescale(applySpread('83.639339', 37), 6)).toEqual({ units: 83_329_873n, scale: 6 }); // 83.32987345...
    expect(formatFixed(parseDecimal('83.25'), 6)).toBe('83.250000');
    expect(formatFixed({ units: 12_345_675n, scale: 7 }, 6)).toBe('1.234568');
    expect(formatFixed(parseDecimal('0.5'), 0)).toBe('1');
  });

  it('applies a provider fee schedule (fixed + bps, half-up)', () => {
    expect(scheduleFee({ amountMinor: 125_000, currency: 'USD' }, { fixedMinor: 150, bps: 20 })).toEqual({ amountMinor: 400, currency: 'USD' });
    expect(scheduleFee({ amountMinor: 5_000, currency: 'GBP' }, { fixedMinor: 80, bps: 10 })).toEqual({ amountMinor: 85, currency: 'GBP' });
    expect(scheduleFee({ amountMinor: 1_250, currency: 'USD' }, { fixedMinor: 90, bps: 12 })).toEqual({ amountMinor: 92, currency: 'USD' }); // 1.5 -> 2
  });
});
