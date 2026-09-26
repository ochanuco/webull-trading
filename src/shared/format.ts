export interface SymbolDisplayInput {
  symbol: string
  name?: string | null
}

/** Display text only — URL routing (`?symbol=7974`) always uses the bare symbol. */
export function formatSymbolDisplay(input: SymbolDisplayInput): string {
  if (input.name && input.name.trim().length > 0) {
    return `${input.symbol}-${input.name.trim()}`
  }
  return input.symbol
}

// Defends against XSS in DB-derived / user-controllable strings interpolated into
// server-rendered HTML, which could otherwise pivot into a kill-switch / seed-cash CSRF.
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
