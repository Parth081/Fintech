// Exact decimal money math. The implementation lives in @ct/market (browser-safe, shared with the
// FX engine and the UI); re-exported here so existing imports keep working. No floats touch amounts.
export {
  applySpread,
  bpsFee,
  convert,
  divRound,
  formatDecimal,
  formatFixed,
  parseDecimal,
  rescale,
  scheduleFee,
  type Decimal,
  type Rounding,
} from '@ct/market';
