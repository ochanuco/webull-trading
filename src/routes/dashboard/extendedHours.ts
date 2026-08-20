import type { ExtendedHoursObservationRow } from '../../infrastructure/db/schema'
import { esc, fmtJst } from './shared'

/**
 * 時間外参考観測 (issue #709 Phase 1) の dashboard 表示。
 *
 * `extendedHoursScheduler` (producer) が書いた `extended_hours_observation` を
 * 読むだけの read-only view — 執行価格ではなく Yahoo 時間外値の参考表示であり、
 * 売買判断には接続していないことを画面上でも明示する (下部の注記)。
 */

const STATUS_LABELS: Record<string, { ja: string; cls: string }> = {
  NORMAL: { ja: 'NORMAL (正常)', cls: 'ok' },
  WARNING: { ja: 'WARNING (警戒)', cls: 'warn' },
  STOP_AT_OPEN_CANDIDATE: { ja: 'STOP_AT_OPEN_CANDIDATE (寄付損切り候補)', cls: 'err' },
  UNKNOWN: { ja: 'UNKNOWN (データ不明)', cls: 'neutral' },
}

function statusPill(status: string): string {
  const s = STATUS_LABELS[status] ?? { ja: status, cls: 'neutral' }
  return `<span class="pill ${s.cls}">${esc(s.ja)}</span>`
}

/** すでに % 値 (例: -3.5 → -3.5%) の number を符号付きで表示する。null は「—」。 */
function fmtPctValue(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '<span class="muted">—</span>'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function fmtPriceValue(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '<span class="muted">—</span>'
  return `$${v.toFixed(2)}`
}

function fmtFreshness(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '<span class="muted">—</span>'
  if (sec < 0) return '0秒'
  if (sec < 60) return `${sec}秒`
  return `${Math.floor(sec / 60)}分`
}

function symbolLink(symbol: string): string {
  return `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(symbol)}" style="text-decoration:none"><strong>${esc(symbol)}</strong></a>`
}

function renderRow(r: ExtendedHoursObservationRow, showCapturedAt: boolean): string {
  return `<tr>
    ${showCapturedAt ? `<td class="muted" style="white-space:nowrap">${esc(fmtJst(r.capturedAt))}</td>` : ''}
    <td>${symbolLink(r.symbol)}</td>
    <td>${statusPill(r.status)}</td>
    <td class="num">${fmtPriceValue(r.preMarketLast)}</td>
    <td class="num">${fmtPctValue(r.gapPct)}</td>
    <td class="num">${fmtPctValue(r.direction15mPct)}</td>
    <td class="num">${fmtPctValue(r.toStopPct)}</td>
    <td class="muted" style="white-space:nowrap">${r.lastBarAt ? esc(fmtJst(r.lastBarAt)) : '<span class="muted">—</span>'}</td>
    <td class="muted">${fmtFreshness(r.freshnessSec)}</td>
  </tr>`
}

export interface ExtendedHoursBodyArgs {
  sessionYmd: string
  latest: ExtendedHoursObservationRow[]
  recent: ExtendedHoursObservationRow[]
}

export function extendedHoursBody(args: ExtendedHoursBodyArgs): string {
  const { sessionYmd, latest, recent } = args
  const latestTable =
    latest.length === 0
      ? '<p class="muted">本日 (NY) のプレマーケット観測はまだありません。</p>'
      : `<div class="tablewrap"><table class="fit">
          <thead><tr>
            <th>銘柄</th><th>状態</th><th class="num">プレマ終値</th><th class="num">gap</th><th class="num">直近15分</th><th class="num">stopまで</th><th>最終bar (JST)</th><th>新しさ</th>
          </tr></thead>
          <tbody>${latest.map((r) => renderRow(r, false)).join('')}</tbody>
        </table></div>`
  const recentTable =
    recent.length === 0
      ? '<p class="muted">履歴はまだありません。</p>'
      : `<div class="tablewrap"><table class="fit">
          <thead><tr>
            <th>観測時刻 (JST)</th><th>銘柄</th><th>状態</th><th class="num">プレマ終値</th><th class="num">gap</th><th class="num">直近15分</th><th class="num">stopまで</th><th>最終bar (JST)</th><th>新しさ</th>
          </tr></thead>
          <tbody>${recent.map((r) => renderRow(r, true)).join('')}</tbody>
        </table></div>`
  return `
    <p class="muted" style="font-size:13px">対象日 (NY): ${esc(sessionYmd)}。Yahoo 時間外参考値であり執行価格ではありません。売買判断には未接続 (観測専用) です。</p>
    <div class="section-head">当日の銘柄別最新観測</div>
    ${latestTable}
    <div class="section-head" style="margin-top:20px">直近履歴 (最大50件)</div>
    ${recentTable}
  `
}
