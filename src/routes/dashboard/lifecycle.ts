import type { ExitReasonCategory, SkipReasonCategory } from '../../trading/analysis/lifecycleMetrics'
import type { LifecycleReport } from '../../trading/analysis/lifecycleReport'
import { esc } from './shared'

/**
 * 売買ライフサイクル計測 (issue #709 Phase 2) の dashboard 表示。
 *
 * `loadLifecycleReport` (D1 + Yahoo daily bars) が組み立てた
 * `LifecycleReport` を読むだけの read-only view — 執行経路には一切接続して
 * いない。数値は全て過去の decision / fill から再現可能に集計したもの。
 */

const EXIT_REASON_LABELS: Record<ExitReasonCategory, string> = {
  TP: 'TP (利食い)',
  SL: 'SL (損切り)',
  TIME_STOP: 'TIME_STOP (時間切れ)',
  REGIME_FLIP: 'REGIME_FLIP (ペアレジーム反転)',
  INTRADAY_CLOSE: 'INTRADAY_CLOSE (日中強制クローズ)',
  REBALANCE: 'REBALANCE (現金配分調整)',
  OTHER: 'OTHER (その他)',
  UNKNOWN: 'UNKNOWN (reason 未特定)',
}

const SKIP_REASON_LABELS: Record<SkipReasonCategory, string> = {
  HALT: 'HALT (取引停止中)',
  SIZING: 'SIZING (サイジング不可)',
  RISK: 'RISK (リスクゲート)',
  OTHER: 'OTHER (その他)',
}

function categoryLabel(category: ExitReasonCategory | 'ALL'): string {
  if (category === 'ALL') return '全体'
  return EXIT_REASON_LABELS[category]
}

function skipCategoryLabel(category: SkipReasonCategory | 'ALL'): string {
  if (category === 'ALL') return '全体'
  return SKIP_REASON_LABELS[category]
}

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '<span class="muted">—</span>'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(2)}%`
}

function fmtUsd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '<span class="muted">—</span>'
  const sign = v >= 0 ? '+' : ''
  return `${sign}$${v.toFixed(2)}`
}

const signClass = (n: number) => (n > 0 ? 'ok' : n < 0 ? 'err' : 'muted')

function renderExitReasonStats(stats: LifecycleReport['exitReasonStats']): string {
  if (stats.length === 0) {
    return '<p class="muted">確定損益のある round trip がまだありません。</p>'
  }
  const rows = stats
    .map(
      (s) => `<tr>
        <td>${esc(categoryLabel(s.category))}</td>
        <td class="num">${s.count}</td>
        <td class="num">${(s.winRate * 100).toFixed(1)}%</td>
        <td class="num ok">${fmtUsd(s.avgWin)}</td>
        <td class="num err">${fmtUsd(s.avgLoss)}</td>
        <td class="num ${signClass(s.expectancy)}">${fmtUsd(s.expectancy)}</td>
      </tr>`,
    )
    .join('')
  return `<div class="tablewrap"><table class="fit">
    <thead><tr><th>exit reason</th><th class="num">件数</th><th class="num">勝率</th><th class="num">平均利益</th><th class="num">平均損失</th><th class="num">期待値</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function renderForwardReturns(rows: LifecycleReport['forwardReturns']): string {
  if (rows.length === 0) return '<p class="muted">round trip がまだありません。</p>'
  const body = rows
    .map(
      (r) => `<tr>
        <td>${esc(categoryLabel(r.category))}</td>
        <td class="num">${fmtPct(r.r1.avg)}<span class="muted"> (n=${r.r1.n})</span></td>
        <td class="num">${fmtPct(r.r3.avg)}<span class="muted"> (n=${r.r3.n})</span></td>
        <td class="num">${fmtPct(r.r5.avg)}<span class="muted"> (n=${r.r5.n})</span></td>
        <td class="num">${fmtPct(r.r10.avg)}<span class="muted"> (n=${r.r10.n})</span></td>
      </tr>`,
    )
    .join('')
  return `<div class="tablewrap"><table class="fit">
    <thead><tr><th>exit reason</th><th class="num">1営業日後</th><th class="num">3営業日後</th><th class="num">5営業日後</th><th class="num">10営業日後</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function renderMfeRunup(
  mfeRows: LifecycleReport['postExitMfe'],
  runupRows: LifecycleReport['preEntryRunup'],
): string {
  if (mfeRows.length === 0 && runupRows.length === 0) {
    return '<p class="muted">round trip がまだありません。</p>'
  }
  const mfeByCategory = new Map(mfeRows.map((r) => [r.category, r.mfe10]))
  const runupByCategory = new Map(runupRows.map((r) => [r.category, r.runup5]))
  const categories = [...new Set([...mfeByCategory.keys(), ...runupByCategory.keys()])]
  const body = categories
    .map((c) => {
      const mfe = mfeByCategory.get(c) ?? { n: 0, avg: null }
      const runup = runupByCategory.get(c) ?? { n: 0, avg: null }
      return `<tr>
        <td>${esc(categoryLabel(c))}</td>
        <td class="num">${fmtPct(mfe.avg)}<span class="muted"> (n=${mfe.n})</span></td>
        <td class="num">${fmtPct(runup.avg)}<span class="muted"> (n=${runup.n})</span></td>
      </tr>`
    })
    .join('')
  return `<div class="tablewrap"><table class="fit">
    <thead><tr><th>exit reason</th><th class="num">post-exit MFE (10営業日)</th><th class="num">entry前5営業日 上昇率</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function renderSkipOutcomes(rows: LifecycleReport['skipOutcomes']): string {
  if (rows.length === 0) return '<p class="muted">SKIP 判定がまだありません。</p>'
  const body = rows
    .map(
      (r) => `<tr>
        <td>${esc(skipCategoryLabel(r.category))}</td>
        <td class="num">${fmtPct(r.mfe10.avg)}<span class="muted"> (n=${r.mfe10.n})</span></td>
        <td class="num">${fmtPct(r.mae10.avg)}<span class="muted"> (n=${r.mae10.n})</span></td>
      </tr>`,
    )
    .join('')
  return `<div class="tablewrap"><table class="fit">
    <thead><tr><th>SKIP reason</th><th class="num">10営業日 MFE</th><th class="num">10営業日 MAE</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

const EXTENDED_HOURS_STATUS_LABELS: Record<string, string> = {
  NORMAL: 'NORMAL (正常)',
  WARNING: 'WARNING (警戒)',
  STOP_AT_OPEN_CANDIDATE: 'STOP_AT_OPEN_CANDIDATE (寄付損切り候補)',
  UNKNOWN: 'UNKNOWN (データ不明)',
  NO_OBSERVATION: '観測なし',
}

function renderExtendedHoursCrosstab(crosstab: Record<string, number>): string {
  const entries = Object.entries(crosstab)
  if (entries.length === 0) {
    return '<p class="muted">stop-loss exit がまだありません。</p>'
  }
  const total = entries.reduce((a, [, n]) => a + n, 0)
  const rows = entries
    .sort(([, a], [, b]) => b - a)
    .map(
      ([status, n]) => `<tr>
        <td>${esc(EXTENDED_HOURS_STATUS_LABELS[status] ?? status)}</td>
        <td class="num">${n}</td>
      </tr>`,
    )
    .join('')
  return `<div class="tablewrap"><table class="fit">
    <thead><tr><th>同日の時間外参考観測 status</th><th class="num">SL exit 件数</th></tr></thead>
    <tbody>${rows}</tbody>
  </table><p class="muted" style="font-size:11px;margin-top:4px">合計 ${total} 件 (stop-loss exit)</p></div>`
}

function renderCostDrawdownTurnover(report: LifecycleReport): string {
  const { cost, drawdown, turnover } = report
  const tile = (label: string, value: string) =>
    `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value" style="font-size:16px">${value}</div></div>`
  const tiles = [
    // cost / drawdown はどちらも正の magnitude (「いくら失ったか」)。符号付き
    // 表示 (fmtUsd) だと 0 円のとき "+$0.00" になり損失方向の意味と噛み合わない
    // ため、ここだけ符号なしの素の金額で表示する。
    tile('推定コスト合計', `$${cost.totalEstimatedCostUsd.toFixed(2)}`),
    tile('最大ドローダウン (USD)', `$${drawdown.maxDrawdownUsd.toFixed(2)}`),
    tile('turnover (BUY)', `$${turnover.buyNotionalUsd.toFixed(2)}`),
    tile('turnover (SELL)', `$${turnover.sellNotionalUsd.toFixed(2)}`),
    tile('turnover 合計', `$${turnover.totalNotionalUsd.toFixed(2)}`),
    tile(
      'turnover / 平均equity',
      turnover.turnoverRatio === null ? '<span class="muted">—</span>' : `${(turnover.turnoverRatio * 100).toFixed(1)}%`,
    ),
  ].join('')
  return `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:760px">${tiles}</div>`
}

export function lifecycleBody(report: LifecycleReport): string {
  const failedNote =
    report.meta.barFetchFailedSymbols.length > 0
      ? `<p class="warn" style="font-size:12px">日足取得に失敗した銘柄 (フォワード指標が null): ${esc(report.meta.barFetchFailedSymbols.join(', '))}</p>`
      : ''
  return `
    <p class="muted" style="font-size:13px">${esc(report.meta.note)}</p>
    <p class="muted" style="font-size:11px">round trip ${report.meta.roundTripCount} 件 / fill ${report.meta.fillCount} 件 / SKIP (dedup後) ${report.meta.skipSignalCount} 件 — as of ${esc(report.generatedAt)}</p>
    ${failedNote}

    <div class="section-head">(a) exit reason 別成績</div>
    ${renderExitReasonStats(report.exitReasonStats)}

    <div class="section-head" style="margin-top:20px">(b) exit 後リターン (1/3/5/10 営業日)</div>
    ${renderForwardReturns(report.forwardReturns)}

    <div class="section-head" style="margin-top:20px">(c) post-exit MFE / entry 前 runup</div>
    ${renderMfeRunup(report.postExitMfe, report.preEntryRunup)}

    <div class="section-head" style="margin-top:20px">(d) 見送り (SKIP) 後の 10 営業日 MFE/MAE</div>
    ${renderSkipOutcomes(report.skipOutcomes)}

    <div class="section-head" style="margin-top:20px">(e) 時間外警戒 × stop-loss exit (同日突き合わせ)</div>
    ${renderExtendedHoursCrosstab(report.extendedHoursSlCrosstab)}

    <div class="section-head" style="margin-top:20px">(f) コスト / 最大ドローダウン / turnover</div>
    ${renderCostDrawdownTurnover(report)}
  `
}
