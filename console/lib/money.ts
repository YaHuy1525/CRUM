// Prices arrive as integer minor units plus an ISO currency code, and "minor"
// is not always hundredths: VND has no subunit, so dividing 2,900,000 by 100
// showed it as 29000.00. The exponent belongs to the currency, not to the call
// site, and the code is always shown so the number cannot be misread.
const CURRENCY_EXPONENT: Record<string, number> = {
  VND: 0,
  AUD: 2,
}

const DEFAULT_EXPONENT = 2

export function currencyExponent(currency: string | null): number {
  if (!currency) return DEFAULT_EXPONENT
  return CURRENCY_EXPONENT[currency.toUpperCase()] ?? DEFAULT_EXPONENT
}

export function formatMinor(value: number | null, currency: string | null): string | null {
  if (value === null) return null
  const exponent = currencyExponent(currency)
  const amount = (value / 10 ** exponent).toFixed(exponent)
  return currency ? `${amount} ${currency}` : amount
}
