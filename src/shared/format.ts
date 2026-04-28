/**
 * Display formatting helpers shared across routes.
 *
 * 4 桁の数字コードだけだと operator が dashboard 上で日本株を識別しづらい
 * ので、`market === 'JP'` のときに `symbol_config.name` を併記する。US 銘柄
 * (AAPL, SOXL 等) は ticker 自体が一意で識別性が高いので変更しない。
 */

export interface SymbolDisplayInput {
  symbol: string
  name?: string | null
  market?: string | null
}

/**
 * Format a symbol for human display.
 *
 * - JP + name 有り → `${symbol}-${name}` (例: `7974-任天堂`)
 * - JP + name 空 / null → `${symbol}` のみ (defensive fallback)
 * - US / その他 / market 不明 → `${symbol}` のみ (既存挙動を維持)
 *
 * URL routing (`?symbol=7974`) は変更しない。dashboard の表示テキストだけが
 * 番号-会社名 形式に変わる。
 */
export function formatSymbolDisplay(input: SymbolDisplayInput): string {
  if (input.market === 'JP' && input.name && input.name.trim().length > 0) {
    return `${input.symbol}-${input.name.trim()}`
  }
  return input.symbol
}
