/**
 * Display formatting helpers shared across routes.
 *
 * 銘柄コードだけだと operator が dashboard 上で銘柄を識別しづらいので、
 * `symbol_config.name` がある場合は併記する。market は問わない:
 * JP (`7974` → `7974-任天堂`) も US (`AAPL` → `AAPL-Apple Inc.`) も同じ
 * フォーマット。
 */

export interface SymbolDisplayInput {
  symbol: string
  name?: string | null
}

/**
 * Format a symbol for human display.
 *
 * - name 有り → `${symbol}-${name}` (例: `7974-任天堂`, `AAPL-Apple Inc.`)
 * - name 空 / null / 空白のみ → `${symbol}` のみ (defensive fallback)
 *
 * URL routing (`?symbol=7974`) は変更しない。dashboard の表示テキストだけが
 * 番号-会社名 形式になる。
 */
export function formatSymbolDisplay(input: SymbolDisplayInput): string {
  if (input.name && input.name.trim().length > 0) {
    return `${input.symbol}-${input.name.trim()}`
  }
  return input.symbol
}
