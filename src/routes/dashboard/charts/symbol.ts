import type { SymbolUniverse } from '../../../infrastructure/db/symbolUniverse'
import type { SymbolRole } from '../../../infrastructure/db/symbolConfigRepo'
import { SYMBOL_ROLES } from '../../../infrastructure/db/symbolConfigRepo'
import type { BuyabilityView, EntryGateStatus } from '../../../trading/strategy/entryDistance'
import type { EntryStatus, EntryStatusResult } from '../../../trading/strategy/entryStatus'
import { PAIR_REGIME_ZONE_LABELS, type PairRegimeDecision } from '../../../trading/strategy/pairRegime'
import type { SymbolAllocation } from '../../../trading/strategy/conditionalAllocation'
import { MAX_CHART_DECISIONS, type SymbolChartData, type SymbolChartPoint } from './loaders'
import { type ChartsBodyArgs, type ChartsBodySymbol, ECHARTS_CDN, type StrategyParamsSnapshot, type SymbolPolicySummary, renderZoomPresetButtons } from './shared'
import { renderOverviewTab } from './equity'
import { renderQualityTab } from './quality'
import { renderDecisionTable } from '../cron'
import { currencyOfSymbol, displaySymbol, esc, fmtPctSigned, fmtPriceCcy, inactiveTooltip, isSymbolInactive, safeJsonScript } from '../shared'
import { SYMBOL_ROLE_LABELS, SYMBOL_ROLE_LABELS_SHORT } from '../symbols'

/**
 * チャート銘柄タブ内の判定履歴 (#decisions-chart-unify)。戦略判定ページと同じ
 * renderer を共用し、チャート上の判定 pin と同じデータを表でも読めるようにする
 * (pin はクリックで 1 件ずつ、表はラダー・実 fill・AI コピーまで一覧)。
 */
export function renderSymbolDecisionHistory(args: ChartsBodySymbol): string {
  const rows = args.decisionRows ?? []
  if (rows.length === 0 || !args.focusSymbol) return ''
  const symbolCronHref = `/dashboard/cron?symbol=${encodeURIComponent(args.focusSymbol)}`
  return `<div style="margin-top:14px">
    <h2 class="section-head">判定履歴 <span class="muted" style="font-size:11px;font-weight:normal">直近 ${rows.length} 件 — チャートの判定 pin と同じデータ</span>
      <a href="${esc(symbolCronHref)}" style="font-size:11px">この銘柄の全件 →</a>
      <a href="/dashboard/trades?symbol=${encodeURIComponent(args.focusSymbol)}" style="font-size:11px">この銘柄の約定 →</a>
      <a href="/dashboard/cron" style="font-size:11px">全銘柄 →</a>
      <a href="/dashboard/charts/symbol/json?symbol=${encodeURIComponent(args.focusSymbol)}" target="_blank" rel="noreferrer" style="font-size:11px" title="チャート + 判定履歴の機械可読版 (#dashboard-json-api)">この銘柄の JSON →</a>
    </h2>
    ${renderDecisionTable(rows, args.universe, {
      copyVarName: '__decisionCopy',
      showSymbol: false,
      filterLabel: `symbol=${args.focusSymbol}, limit=30`,
    })}
  </div>`
}

/**
 * ペアレジーム行 (#472)。zone を日本語で表示し、score / proxy / 判定日を併記。
 * observe mode はその旨を明示 (gate していないことが分かるように)。
 */
export function renderPairRegimeLine(
  view: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null,
): string {
  if (!view) return ''
  const d = view.decision
  const color =
    d.zone === 'bull' ? '#057a55' : d.zone === 'bear' ? '#b25000' : d.zone === 'neutral' ? '#46608a' : '#c22'
  const sideJa = view.side === 'bull' ? 'ブル側' : 'ベア側'
  const allowed = (view.side === 'bull' && d.zone === 'bull') || (view.side === 'bear' && d.zone === 'bear')
  const verdict = allowed ? 'entry 可' : 'entry 不可'
  return `<div style="margin-top:8px;font-size:13px;color:#3a3a3c;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    ペアレジーム: <strong style="color:${color}">${esc(PAIR_REGIME_ZONE_LABELS[d.zone])}</strong>
    <span class="muted" style="font-size:12px">この銘柄は${sideJa} → ${verdict}${view.mode === 'observe' ? ' (observe: gate は未適用)' : ''}</span>
    <span class="muted" style="font-size:12px">${d.score !== null ? `score ${(d.score * 100).toFixed(2)}%` : ''} proxy ${esc(d.proxySymbol)}${d.asOfDate ? ` / ${esc(d.asOfDate)} 時点` : ''}</span>
    ${d.zone === 'unknown' ? `<span class="err" style="font-size:12px">${esc(d.reason)}</span>` : ''}
  </div>`
}

export function renderSymbolTab(args: ChartsBodySymbol): string {
  const noData =
    args.symbolChart === null ||
    args.symbolChart.points.length === 0
  if (noData) {
    return wrapWithSymbolRail(
      args,
      renderFocusSymbolHeader(args) +
        `<p class="muted">この銘柄にはまだ判定ログ / fill がありません。</p>` +
        renderStrategyParamsPanel(args.strategyParams, args.strategyParamsGlobal),
    )
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var sc = data.symbolChart;
      if (!sc || sc.points.length === 0) return;

      // xAxis 戦略:
      //   intradayBars が揃っているとき → category axis (categories = 各 bar の
      //     ISO timestamp)。overnight / 週末 / 米国祝日の空白を「詰めて」表示する
      //     (TradingView 等と同様の挙動)。ECharts の time axis では非取引時間を
      //     skip する native 機能が無いため、category 化が standard 解。
      //   intradayBars が空 (Yahoo intraday fetch 失敗) → time axis fallback。
      //     candle が無いので gap も発生せず、line / markPoint だけ実時刻で描画。
      // category mode では「category index」を全 series の x として揃える。
      // markPoint も coord に [categoryIndex, price] を渡す。
      var ohlcBars = sc.intradayBars || [];
      var useCategoryAxis = ohlcBars.length > 0;
      var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
      var categories = ohlcBars.map(function (b) { return b.timestamp; });

      // セッション境界 (休場 → 開場) 検出:
      // category axis 化で休場 gap が詰まった結果 (#193)、視覚的に
      // 「どこから新セッションか」が分かりにくくなった。15m interval なので
      // 隣接 bar は通常 15 分差。週末 / 夜間 closed 後の最初の bar は数時間〜
      // 数十時間ぶんの差が空く。閾値 90 分で safe に検出し、後ろ側
      // category index を「新セッションの開場点」として markLine 描画する。
      // useCategoryAxis === false (intradayBars 空) の場合は描画 skip。
      var sessionOpenIndices = [];
      if (useCategoryAxis) {
        var SESSION_GAP_MS = 90 * 60 * 1000;
        for (var si = 1; si < ohlcMs.length; si++) {
          if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
        }
      }

      // Map a millisecond timestamp to the nearest category index.
      // ohlcMs は intradayBars の順序 (= Yahoo の昇順) を保つ前提。binary search
      // で近接 index を返す。ohlcMs 空 (= time axis fallback) なら -1。
      function nearestIndex(ms) {
        if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
        var lo = 0, hi = ohlcMs.length - 1;
        if (ms <= ohlcMs[0]) return 0;
        if (ms >= ohlcMs[hi]) return hi;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
        }
        // lo は ms 以上の最初の index。一つ前と比べて近い方を採用。
        if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
        return lo;
      }

      // category mode では x = category index、time mode では x = ISO timestamp
      // (= category 値そのもの)。両 mode を同じ shape (x, y) で扱えるよう抽象化。
      function xForTimestamp(ts) {
        if (useCategoryAxis) {
          var idx = nearestIndex(new Date(ts).getTime());
          return idx;
        }
        return ts;
      }
      function xForMs(ms) {
        if (useCategoryAxis) return nearestIndex(ms);
        return ms;
      }

      var jstFmt = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      function jstLabel(value) {
        return jstFmt.format(new Date(value)).replace(/\\//g, '/');
      }
      // fill 時刻は秒精度で表示 (同分内 fills を区別するため)。axisLabel は
      // 分単位で密度を保つ (秒まで出すと x 軸ラベルが詰まる)。
      var jstFmtSec = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      function jstLabelSec(value) {
        return jstFmtSec.format(new Date(value)).replace(/\\//g, '/');
      }
      // category index → 表示 label。category 値は ISO timestamp なのでそのまま JST 化。
      function jstLabelForX(value) {
        if (useCategoryAxis) {
          // value は category 値 (ISO string) または index。axisLabel formatter に
          // 来るのは index/value (params.value=ISO)、dataZoom labelFormatter は
          // value=ISO string が来る (slider 端点の category 値)。
          if (typeof value === 'number') {
            // index として渡される場合 (recomputeYAxis 由来等)
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }
        return jstLabel(value);
      }

      // candlestick の data shape: [open, close, low, high]。category mode では
      // index ベースなので 4 値だけ並べれば ECharts が categories 配列と対応付ける。
      // time mode では [timestamp, open, close, low, high] の 5 値タプル。
      var ohlcXY = useCategoryAxis
        ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
        : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });
      // SMA50 line: cron-eval points から取得 (daily で計算された値の推移)。
      // category mode では point の timestamp を最近接 ohlc index に snap して
      // [index, value] で渡す。時間軸の連続性は category 上で保たれる。
      var smasXY = sc.points.map(function (p) {
        if (p.sma50 == null) return [xForTimestamp(p.timestamp), null];
        return [xForTimestamp(p.timestamp), p.sma50];
      });
      // (close line は削除: candle が close を含むので冗長、overnight gap で
      //  斜めに横断する視覚ノイズが発生していたため #176 → #177 で除去)

      // 押し目買いゾーン:
      // - 上端 = high20d × (1 + pullbackMax)  ≒ 教科書の「上値抵抗線 (resistance)」
      // - 下端 = high20d × (1 + pullbackMin)  = 押し目買いの下限 (-15% 以下は深すぎ)
      var pullbackMaxMul = 1 + sc.rules.pullbackMax;
      var pullbackMinMul = 1 + sc.rules.pullbackMin;
      // 帯の描画は 3 層で構成 (#237 follow-up):
      //   1. markArea fill (薄オレンジ): 「現在の押し目ゾーン (latest high20d 基準)」
      //      を flat に塗って即座にレンジを把握させる。
      //   2. per-timestamp dashed line × 2 (上端 / 下端): 各日の high20d × mul を
      //      たどる斜めライン。SOXL のように high20d が右肩上がりで動く銘柄では
      //      flat な markArea とのズレが大きく、傾きで「押し目ゾーンが日々どう動
      //      いてるか」を可視化する。
      // 元々 (#232 follow-up) は 1 だけにしていたが、価格 momentum が大きい銘柄で
      // 「平行な帯が実態とズレて見える」issue → 1+2 のハイブリッドに戻す。
      // markArea の opacity は重ね描きで濃くなりすぎないよう 0.12 → 0.08 に下げる。
      var latestHigh20d = null;
      for (var lhi = sc.points.length - 1; lhi >= 0; lhi -= 1) {
        var lhp = sc.points[lhi];
        if (lhp && typeof lhp.high20d === 'number' && isFinite(lhp.high20d)) {
          latestHigh20d = lhp.high20d;
          break;
        }
      }
      var bandUpperY = latestHigh20d == null ? null : latestHigh20d * pullbackMaxMul;
      var bandLowerY = latestHigh20d == null ? null : latestHigh20d * pullbackMinMul;
      var bandTopY = null;
      var bandBottomY = null;
      if (Number.isFinite(bandUpperY) && Number.isFinite(bandLowerY)) {
        bandTopY = Math.max(bandUpperY, bandLowerY);
        bandBottomY = Math.min(bandUpperY, bandLowerY);
      }
      var pullbackBandMarkArea = (bandTopY != null && bandBottomY != null) ? {
        silent: true,
        itemStyle: {
          color: 'rgba(255, 180, 50, 0.08)',
          borderColor: 'rgba(255, 140, 0, 0.35)',
          borderWidth: 1,
          borderType: 'dashed',
        },
        data: [[
          { yAxis: bandBottomY },
          { yAxis: bandTopY },
        ]],
      } : null;

      // per-timestamp の押し目ゾーン上下端 (sloped 2 lines)。各 point.high20d ×
      // pullbackMaxMul / pullbackMinMul を辿る。high20d が null の point は
      // null を入れて echarts に segment break させる (connectNulls=false)。
      var pullbackUpperXY = sc.points.map(function (p) {
        var x = xForTimestamp(p.timestamp);
        if (typeof p.high20d !== 'number' || !isFinite(p.high20d)) return [x, null];
        return [x, p.high20d * pullbackMaxMul];
      });
      var pullbackLowerXY = sc.points.map(function (p) {
        var x = xForTimestamp(p.timestamp);
        if (typeof p.high20d !== 'number' || !isFinite(p.high20d)) return [x, null];
        return [x, p.high20d * pullbackMinMul];
      });
      // 全点 null の場合は line series を出さない (legend を汚さない)。
      var pullbackBandHasData =
        pullbackUpperXY.some(function (xy) { return xy[1] != null; }) &&
        pullbackLowerXY.some(function (xy) { return xy[1] != null; });

      // 押し目ゾーン端までの距離ラベル (#entry-distance): 「入場ライン」独立線は
      // 廃止し、既存の上端/下端点線に「あと −X.X% ($Y)」を付与する。現価格は
      // latestCronPrice (直近 strategy 評価値) 基準。過熱/トレンド等で実際に入場
      // できない件は下の「入場まで」パネルが説明する (ここは純粋な価格距離)。
      function bandEdgeLabel(name, edgeY) {
        if (!Number.isFinite(edgeY) || sc.latestCronPrice == null || !(sc.latestCronPrice > 0)) return name;
        var mv = (edgeY - sc.latestCronPrice) / sc.latestCronPrice;
        return name + ' あと ' + (mv >= 0 ? '+' : '') + (mv * 100).toFixed(1) + '% ($' + edgeY.toFixed(2) + ')';
      }
      var pullbackUpperLabel = bandEdgeLabel('押し目上端', bandUpperY);
      var pullbackLowerLabel = bandEdgeLabel('押し目下端', bandLowerY);

      // 価格トレンド線 (server-side で daily close の linear regression fit)。
      // 旧仕様の「上値抵抗線 / 下値支持線」上下 2 本は、ローソク足の上下を
      // flat に走り「価格の中心を辿る trend」という user 期待と乖離していた
      // ため、close の重心を通る best-fit 1 本に統一した。
      //
      // 検出失敗 (sample < 2 / 同時刻のみ) なら null → 描画スキップ。
      //
      // 過去 #185 / #187 / #188 / #189 で「描画されない」回帰があったが、
      // 根因は ECharts の dataZoom + 2 点 line series が「片方の点が zoom
      // 範囲外になると線が引かれない」既知挙動 (issue #3637 系)。#189 で
      // dataZoom の filterMode を 'weakFilter' に変えて改善したが、それでも
      // ユーザ環境で残ケースがあった。本質的に robust にするため、line の
      // data 自体を「常に zoom 範囲内に複数点が入る粒度」に展開する。
      //
      // 具体的には intradayBars (15m candle、60 日で ~1500 点) の各 timestamp
      // で trend line の y 値を線形補間し、[[t, y], ...] の dense path にす
      // る。これで 5D (~120 点) や 1D zoom でも複数点が必ず visible になり
      // filterMode 不問で線分が描画される。intradayBars が空 (Yahoo fetch
      // 失敗) のときは 2 点 endpoint fallback (旧挙動)。
      //
      // 線形外挿: trend line は概念上両側に伸びる線なので、p1 より過去側 /
      // end より未来側の sample も同じ slope で外挿する。
      //
      // ※ Server-side densifyTrendLine (export) と同じアルゴリズム。
      //    unit test はそちらで担保する。client 側に inline するのは sc.*
      //    オブジェクトを HTML script に埋めて echarts.init で消費するため。
      // category mode では sample を「各 ohlc bar の ms」として展開した後、
      // 結果の [t, y] 配列を index ベース [i, y] に変換する (ohlcMs[i] === t を
      // 満たすので 1:1 対応)。time mode では従来通り [t, y] のまま渡す。
      var ohlcTimestamps = ohlcMs.slice();
      function densifyTrendLine(line, sampleTimestamps) {
        if (!line) return null;
        var t1 = new Date(line.pivots[0].timestamp).getTime();
        var t2 = new Date(line.end.timestamp).getTime();
        var y1 = line.pivots[0].price;
        var y2 = line.end.price;
        if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
        if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
        if (t1 === t2) return [[t1, y1], [t2, y2]];
        var slope = (y2 - y1) / (t2 - t1);
        var seen = Object.create(null);
        var arr = [];
        for (var i = 0; i < sampleTimestamps.length; i += 1) {
          var t = sampleTimestamps[i];
          if (!Number.isFinite(t)) continue;
          if (seen[t]) continue;
          seen[t] = true;
          arr.push(t);
        }
        if (!seen[t1]) { seen[t1] = true; arr.push(t1); }
        if (!seen[t2]) { seen[t2] = true; arr.push(t2); }
        arr.sort(function (a, b) { return a - b; });
        if (arr.length < 2) return [[t1, y1], [t2, y2]];
        var out = [];
        for (var j = 0; j < arr.length; j += 1) {
          var tj = arr[j];
          var yj = y1 + slope * (tj - t1);
          if (Number.isFinite(yj)) out.push([tj, yj]);
        }
        if (out.length < 2) return [[t1, y1], [t2, y2]];
        return out;
      }
      // category mode 用: [t, y] 配列を [index, y] に変換。t が ohlcMs に
      // 一致しない (= line endpoint が intradayBars の外) なら最近接 index に
      // snap される。line の中で同じ index に複数 y が落ちる場合は最初の y
      // のみ採用 (理論上 slope=0 の degenerate / endpoint クランプ時のみ発生)。
      function toCategoryXY(tyArr) {
        if (!tyArr) return null;
        if (!useCategoryAxis) return tyArr;
        var seenIdx = Object.create(null);
        var out = [];
        for (var i = 0; i < tyArr.length; i += 1) {
          var t = tyArr[i][0];
          var y = tyArr[i][1];
          var idx = nearestIndex(t);
          if (idx < 0) continue;
          if (seenIdx[idx]) continue;
          seenIdx[idx] = true;
          out.push([idx, y]);
        }
        // sort by index (nearest snap might reorder when endpoints clamp to same idx)
        out.sort(function (a, b) { return a[0] - b[0]; });
        return out.length > 0 ? out : null;
      }
      var trendLineXY = toCategoryXY(densifyTrendLine(sc.trendLine, ohlcTimestamps));

      // markPoint は xAxis: ISO timestamp (time axis 上の実時刻位置)。category 不一致問題なし。
      // pin label を短縮: BUY/SELL は色 (緑/赤) で識別、price だけ表示。
      // close-time fill (15 分以内) で label 重なりが起きにくい。pnl は SELL のみ
      // 末尾に小数 1 桁で付与 (例: "120.19 +0.4")。詳細 (full-precision PnL /
      // qty / timestamp) は markPoint hover tooltip で表示。
      // realizedPnl と filledQty を data に保持し tooltip.formatter から
      // full-precision で読む (label の toFixed(1) で丸めた値とは独立)。
      // pin label は「全 fill 中で最新」の 1 個だけ表示。それより古いのは
      // 全部 marker のみで label.show: false。BUY と SELL を別々に最新採用
      // していた旧仕様だと近接する BUY→SELL pair で label が重なる回帰が
      // あったため、現保有 status を表す「最後のアクション」だけ強調。
      // 過去の fill 詳細は hover tooltip (full-precision PnL / qty / 時刻) で。
      var buys = sc.markers.filter(function (m) { return m.side === 'BUY'; });
      var sells = sc.markers.filter(function (m) { return m.side === 'SELL'; });
      var latestFillTs = sc.markers.length > 0
        ? sc.markers[sc.markers.length - 1].timestamp
        : null;
      // category mode では markPoint coord に [categoryIndex, price] を渡す。
      // fill 時刻を最近接 ohlc bar (= 15m 粒度) の index に snap するため、同 bar
      // 内の複数 fill は同じ index に重なる。pin label は側 (top/bottom) と色で
      // 区別するため重なっても 1 件は読める。fillTimestamp は秒精度を保持して
      // hover tooltip で full-precision 時刻として表示される (情報損失なし)。
      // clientOrderId を data に保持し、pin クリックで side パネルに fill 詳細 +
      // 取引ジャーナル (/dashboard/trades?clientOrderId=...) への逆リンクを出す。
      var entries = buys.map(function (m) {
        var showLabel = m.timestamp === latestFillTs;
        return {
          name: 'BUY', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
          realizedPnl: null, qty: m.qty, fillTimestamp: m.timestamp,
          clientOrderId: m.clientOrderId == null ? null : m.clientOrderId,
          label: { show: showLabel, formatter: m.price.toFixed(2), color: '#057a55', position: 'top', distance: 6, fontSize: 11 },
          itemStyle: { color: '#057a55' },
        };
      });
      var exits = sells.map(function (m) {
        var showLabel = m.timestamp === latestFillTs;
        var pnlLabel = m.realizedPnl == null ? '' : ' ' + (m.realizedPnl >= 0 ? '+' : '') + m.realizedPnl.toFixed(1);
        return {
          name: 'SELL', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
          realizedPnl: m.realizedPnl, qty: m.qty, fillTimestamp: m.timestamp,
          clientOrderId: m.clientOrderId == null ? null : m.clientOrderId,
          label: { show: showLabel, formatter: m.price.toFixed(2) + pnlLabel, color: '#c22', position: 'bottom', distance: 6, fontSize: 11 },
          itemStyle: { color: '#c22' },
        };
      });

      // 判定点 (#decision-trace のグラフ同期): cron の判定イベント (HOLD を除く
      // BUY/SELL/SKIP/REJECT/ERROR) を eval 時刻 × eval 価格に色分けでプロットする。
      // 点クリックで脇パネルに判定トレース・ラダー (server 事前レンダリング HTML)
      // を出し、文字ログとグラフを 1 画面で同期させる。category mode では eval
      // 時刻を最近接 ohlc index に snap (markPoint と同じ手法、xForTimestamp 流用)。
      // 色は取引品質タブの DECISION_COLORS と揃える。
      var DECISION_COLORS = { BUY: '#057a55', SELL: '#1471a8', SKIP: '#b25000', REJECT: '#7c3aed', ERROR: '#c22' };
      var DECISION_LABEL_JA = { BUY: '買い', SELL: '売り', SKIP: '見送り (bot判定)', REJECT: '拒否 (証券会社)', ERROR: 'エラー (原因不明・一時的)' };
      function escHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      var decisionList = sc.decisions || [];
      var decisionPoints = decisionList.map(function (d) {
        var color = DECISION_COLORS[d.decision] || '#888';
        return {
          value: [xForTimestamp(d.timestamp), d.price],
          decision: d.decision, reason: d.reason, evalTs: d.timestamp, ladderHtml: d.ladderHtml,
          itemStyle: { color: color, borderColor: '#fff', borderWidth: 1 },
        };
      });

      // 保有区間 markArea (#chart-markers): BUY→SELL の closed pair を薄背景で
      // 塗る (server 側 pairClosedTrades の結果 = sc.holdingSpans)。SELL の
      // realizedPnl の符号で緑 (勝ち) / 赤 (負け) 系、欠損 (null) は中立グレー。
      // オープン中の建玉は server が span に含めない (右端まで塗ると「そこで
      // 決済した」と誤読される) — 現保有は avg/stop/TP 線が担う。
      // category mode では xAxis に最近接 ohlc index、time mode では ISO を渡す
      // (markPoint coord と同じ xForTimestamp 流用)。
      var holdingSpans = sc.holdingSpans || [];
      var holdingAreaData = holdingSpans.map(function (s) {
        var color = s.realizedPnl == null
          ? 'rgba(120, 120, 128, 0.08)'
          : (s.realizedPnl >= 0 ? 'rgba(5, 122, 85, 0.10)' : 'rgba(204, 34, 34, 0.10)');
        return [
          { xAxis: xForTimestamp(s.openTimestamp), itemStyle: { color: color } },
          { xAxis: xForTimestamp(s.closeTimestamp) },
        ];
      });

      // 保有中なら avg / stop / take-profit を「dense path の独立 line series」
      // として描画。openedAt から最新までのみ描画 (chart 全幅に伸ばすと
      // 「ずっと前から avg だった」と誤読される) のは旧仕様 (markLine 方式) と
      // 同じだが、ECharts dataZoom + 2 点 markLine は trend line と同様
      // 「片端が zoom 範囲外になると線が消える」回帰があるため (#190 / #191
      // と同根、issue #3637 系)、densifyHorizontalLine で intradayBars
      // 各 timestamp に y を割り当てた dense path に展開する。これで 1D zoom
      // でも複数点が必ず visible になり filterMode 不問で線が描画される。
      // ※ Server-side densifyHorizontalLine (export) と同じアルゴリズム。
      //    unit test はそちらで担保する。
      function densifyHorizontalLine(yValue, fromTs, toTs, samples) {
        if (!Number.isFinite(yValue)) return null;
        var a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime();
        var b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime();
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        if (a >= b) return [[a, yValue], [b, yValue]];
        var seen = Object.create(null);
        var arr = [];
        function push(t) {
          if (seen[t]) return;
          seen[t] = true;
          arr.push(t);
        }
        push(a);
        push(b);
        for (var i = 0; i < samples.length; i += 1) {
          var t = samples[i];
          if (!Number.isFinite(t)) continue;
          if (t < a || t > b) continue;
          push(t);
        }
        arr.sort(function (x, y) { return x - y; });
        var out = [];
        for (var j = 0; j < arr.length; j += 1) {
          out.push([arr[j], yValue]);
        }
        return out;
      }
      var avgLineXY = null;
      var stopLineXY = null;
      var tpLineXY = null;
      var avgLabel = '';
      var stopLabel = '';
      var tpLabel = '';
      // 保有ナシ時に「もし今 BUY したら」の損切り / 利食い水準を仮置きで描く
      // preview lines。virtualAvg = sc.latestCronPrice (= 直近 cron eval で
      // strategy 評価に使った価格) を仮の avg と見立てる。
      // sc.points[末尾] を使うと Yahoo daily filler が末尾に来ているケース
      // (cron 停止中 / 銘柄古い) で「過去 Yahoo close」を avg にしてしまい、
      // user に「最新評価値」と誤解させる。latestCronPrice が null = 評価履歴
      // 自体が無い → preview line そのものを描画スキップする。
      // dotted + opacity 0.5 で「actual position ではない」と区別する。
      var previewStopLineXY = null;
      var previewTpLineXY = null;
      var previewStopLabel = '';
      var previewTpLabel = '';
      var extraYValues = [];
      if (sc.position) {
        var avg = sc.position.avgPrice;
        var stopPrice = avg * (1 + sc.rules.stopPct);
        var tpPrice = avg * (1 + sc.rules.takeProfitPct);
        extraYValues.push(avg, stopPrice, tpPrice);
        var openedAt = sc.position.openedAt;
        // openedAt > 最新 point (chart データが古い / position 直後でまだ
        // strategy_decision_log に記録されていない) のとき、endTs が openedAt
        // より過去に出ると線が逆向き (左側) に伸びる。max で clamp。
        var latestTs = sc.points.length > 0 ? sc.points[sc.points.length - 1].timestamp : openedAt;
        var endTs = new Date(latestTs).getTime() >= new Date(openedAt).getTime()
          ? latestTs
          : openedAt;
        var fromMs = new Date(openedAt).getTime();
        var toMs = new Date(endTs).getTime();
        avgLineXY = toCategoryXY(densifyHorizontalLine(avg, fromMs, toMs, ohlcTimestamps));
        stopLineXY = toCategoryXY(densifyHorizontalLine(stopPrice, fromMs, toMs, ohlcTimestamps));
        tpLineXY = toCategoryXY(densifyHorizontalLine(tpPrice, fromMs, toMs, ohlcTimestamps));
        avgLabel = 'avg ' + avg.toFixed(2);
        stopLabel = 'stop ' + stopPrice.toFixed(2) + ' (' + (sc.rules.stopPct * 100).toFixed(0) + '%)';
        tpLabel = 'TP ' + tpPrice.toFixed(2) + ' (+' + (sc.rules.takeProfitPct * 100).toFixed(0) + '%)';
      } else if (
        sc.points.length > 0 &&
        sc.latestCronPrice != null &&
        sc.latestCronPrice > 0 &&
        sc.latestCronTimestamp != null
      ) {
        var virtualAvg = sc.latestCronPrice;
        var pStopPrice = virtualAvg * (1 + sc.rules.stopPct);
        var pTpPrice = virtualAvg * (1 + sc.rules.takeProfitPct);
        extraYValues.push(pStopPrice, pTpPrice);
        // preview line の x 範囲: chart 開始 → 最新 cron eval timestamp。
        // 末尾を Yahoo filler 末尾まで伸ばすと「最新 cron 以降の Yahoo 区間」
        // にも線が出てしまい virtualAvg と整合しないので latestCron まで。
        var pFromMs = new Date(sc.points[0].timestamp).getTime();
        var pToMs = new Date(sc.latestCronTimestamp).getTime();
        if (Number.isFinite(pFromMs) && Number.isFinite(pToMs)) {
          previewStopLineXY = toCategoryXY(densifyHorizontalLine(pStopPrice, pFromMs, pToMs, ohlcTimestamps));
          previewTpLineXY = toCategoryXY(densifyHorizontalLine(pTpPrice, pFromMs, pToMs, ohlcTimestamps));
          // label は actual stop/TP と長さを揃える (右端で見切れないよう
          // "preview" prefix ではなく "(preview)" suffix にして、actual の
          // "stop X (-Y%)" と同等の幅に収める)。
          previewStopLabel = 'stop ' + pStopPrice.toFixed(2) + ' (preview)';
          previewTpLabel = 'TP ' + pTpPrice.toFixed(2) + ' (preview)';
        }
      }

      // 参考 価格外挿線 (#entry-distance のグラフ表現): 直近ペースを未来へ延ばした
      // 点線。category 軸に未来スロットを足して描く。**予測ではなく外挿** なので
      // 点線 + "参考" 明記。entryPrice が無い (価格非依存ブロック) 局面は server 側で
      // projection=null になり描かれない。time 軸 fallback は POC では描画しない。
      var projLineXY = null;
      var projCrossPoint = null;
      var projZoomEndIndex = null;
      var projEndPrice = null;
      (function () {
        var proj = data.projection;
        if (!proj || !Number.isFinite(proj.lastPrice) || !Number.isFinite(proj.slopePerStep)) return;
        if (!useCategoryAxis || ohlcMs.length < 2) return;
        var dayMs = 24 * 3600 * 1000;
        var lastBarMs = ohlcMs[ohlcMs.length - 1];
        // 1 営業日あたりの bar 本数を直近 1 日のスロット数で近似。
        var barsPerDay = 0;
        for (var bi = ohlcMs.length - 1; bi >= 0; bi -= 1) {
          if (lastBarMs - ohlcMs[bi] <= dayMs) barsPerDay += 1; else break;
        }
        barsPerDay = Math.max(1, barsPerDay);
        // 未来スロットの timestamp 間隔 (直近 bar の平均間隔)。
        var span = barsPerDay > 1 ? (lastBarMs - ohlcMs[ohlcMs.length - barsPerDay]) / (barsPerDay - 1) : 3600000;
        if (!Number.isFinite(span) || span <= 0) span = 3600000;
        // 描く未来 bar 数: 交差あり (= 入場時期の目安が見える) はその近辺まで
        // 1〜5 営業日に clamp。交差なしは向き (傾き) が読めれば十分なので
        // 半営業日分の bar だけ — 未来スロットは axis を占有して履歴側の candle
        // を左に圧縮するため、最小限に保つ (operator 指摘 ×2)。
        var drawBars;
        if (proj.crossingSteps != null) {
          var drawDays = Math.min(Math.max(Math.ceil(proj.crossingSteps), 1), 5);
          drawBars = Math.max(barsPerDay, Math.round(drawDays * barsPerDay));
        } else {
          drawBars = Math.max(2, Math.ceil(barsPerDay / 2));
        }
        var startIdx = categories.length - 1;
        for (var k = 1; k <= drawBars; k += 1) {
          categories.push(new Date(lastBarMs + k * span).toISOString());
        }
        var endIdx = startIdx + drawBars;
        projEndPrice = proj.lastPrice + proj.slopePerStep * (drawBars / barsPerDay);
        projLineXY = [[startIdx, proj.lastPrice], [endIdx, projEndPrice]];
        extraYValues.push(proj.lastPrice, projEndPrice);
        if (proj.entryPrice != null) extraYValues.push(proj.entryPrice);
        // 交差点 marker (描画範囲内のときだけ pin を出す)。
        if (proj.crossingSteps != null && proj.entryPrice != null) {
          var crossBars = Math.round(proj.crossingSteps * barsPerDay);
          if (crossBars >= 0 && crossBars <= drawBars) {
            projCrossPoint = { coord: [startIdx + crossBars, proj.entryPrice], value: proj.entryPrice };
          }
        }
        projZoomEndIndex = endIdx;
      })();

      // ECharts の scale:true は markLine を yAxis range に含めないため、
      // TP / stop が data 範囲外だと枠の外で見えなくなる。data 全体 +
      // position lines + markers を考慮した explicit min/max + padding。
      // NaN / Infinity が混入すると Math.min/max が NaN を返し、
      // 結果 yAxis が壊れる (axis label に巨大数が出る回帰例あり) ので
      // pushIfFinite で防御。
      var allY = [];
      function pushIfFinite(v) {
        if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
      }
      // y軸は candle の高低 + markers + position 線だけで decide。
      // SMA50 (long-term、現在価格と乖離大) / band / low20d / trend line を
      // 入れると軸 range が必要以上に広がり candle が縦圧縮される
      // (trader-strategist 助言)。これらは line として描画はする
      // (auto-clip で軸外は切れる) が、軸 range には影響させない。
      (sc.intradayBars || []).forEach(function (b) {
        pushIfFinite(b.high);
        pushIfFinite(b.low);
      });
      sc.markers.forEach(function (m) { pushIfFinite(m.price); });
      extraYValues.forEach(function (v) { pushIfFinite(v); });
      pushIfFinite(data.prevClose); // 前日終値 markLine が枠外に出ないように
      var yMin, yMax;
      if (allY.length > 0) {
        var rawMin = Math.min.apply(null, allY);
        var rawMax = Math.max.apply(null, allY);
        if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
          var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
          yMin = rawMin - pad;
          yMax = rawMax + pad;
        }
      }

      // dataZoom: 下部 slider + inside (wheel/pinch zoom)。初期 zoom 範囲は
      // ?from / ?to URL params (data.zoomFromMs / zoomToMs)。zoom 操作時に
      // history.replaceState で URL を更新 → 銘柄切替を跨いでも range を維持。
      // category mode では startValue/endValue が「category index」を指す。
      // URL 由来の ms 範囲は最近接 index に snap して dataZoom に渡す。
      // time mode (intradayBars 空) では従来通り ms をそのまま startValue に。
      var dzInitial = (function () {
        if (data.zoomFromMs == null || data.zoomToMs == null) return {};
        if (useCategoryAxis) {
          var fromIdx = nearestIndex(data.zoomFromMs);
          var toIdx = nearestIndex(data.zoomToMs);
          if (fromIdx < 0 || toIdx < 0) return {};
          if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
          return { startValue: fromIdx, endValue: toIdx };
        }
        return { startValue: data.zoomFromMs, endValue: data.zoomToMs };
      })();
      // 外挿線を初期表示に収める: category mode で右端 (endValue) を外挿末尾まで
      // 広げる (未来スロットを足したぶん)。startValue は据え置きなので履歴 + 外挿が
      // 同時に見える。
      if (projZoomEndIndex != null && useCategoryAxis && dzInitial.endValue != null) {
        dzInitial.endValue = Math.min(projZoomEndIndex, categories.length - 1);
      }
      // dataZoom slider 両端ラベルも JST で表示 (default だと UTC date string)。
      // category mode では labelFormatter に category 値 (= ISO timestamp 文字列)
      // が渡されるので jstLabel に直接通せばよい (内部で Date(value) parse)。
      // filterMode: 'weakFilter' は line / markLine など複数点で 1 figure を
      // 構成する series 用。default の 'filter' は data item 単位で評価し、
      // 1 dimension でも zoom 外なら点ごと除外する → 直近 2 pivot を chart 末
      // まで延長する trend line ([oldPivot(~30d 前), chartEnd] の 2 点) は 5D
      // zoom で oldPivot が範囲外 → 1 点だけ残り「線が引けない」回帰になる。
      // 'weakFilter' は同 group 内の全点が同じ側に外れた時のみ filter する
      // ため、片端が範囲内なら線分は描画される (公式 issue #3637 / official
      // PR で line chart が zoom 中に消える問題の対策として実装された挙動)。
      // candle / line / scatter / markLine / markPoint / markArea すべてで
      // 「1 点が範囲外でも視覚的に切れて表示される」のが期待動作なので
      // wide chart (1 銘柄 / 数千点) でも問題ない。
      // 下部 slider と wheel/pinch zoom は廃止 (Google Finance 風 — range 操作は
      // 1日/5日/1か月/最大 のピルのみ。operator 要望)。inside dataZoom は
      // ピルの dispatchAction / URL 同期の受け皿として残すが、マウス・タッチ
      // 操作は全て無効化する (sticky チャート上で page scroll を奪わない効果も)。
      var dataZoomCfg = [
        Object.assign({
          type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter',
          zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false,
          zoomLock: false,
        }, dzInitial),
      ];

      var symChart = echarts.init(document.getElementById('symbol-chart'));
      // chart title は出さない: 銘柄は左レールの強調で、表示要素は凡例で分かる。
      symChart.setOption({
        tooltip: {
          trigger: 'axis',
          axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
          // 既定の trigger:'axis' tooltip は header に axis value (時刻) を
          // UTC 文字列で出すため、JST formatter を当てた custom formatter で上書き。
          // candlestick 値は [open, close, low, high]、line は scalar として処理。
          // category mode では axisValue は category 値 (= ISO timestamp string)。
          formatter: function (params) {
            if (!Array.isArray(params) || params.length === 0) return '';
            var ts = params[0].axisValue;
            var lines = ['<div style="font-weight:600;font-size:11px">' + jstLabelForX(ts) + '</div>'];
            // densified path (intradayBars timestamp ごとに line series を埋める
            // PR #190 / #192) により、同じ seriesName + 同じ y 値の data point が
            // 同一 axis index 周辺に多数並ぶ。ECharts の trigger axis は該当
            // params を全件渡してくるため、tooltip 上で SMA50 65.82 が 16 行
            // 続くような重複表示が発生する。seriesName + 整形後 value を key に
            // した Set で連続行を 1 行に dedup する (系列ごと 1 行)。candle は
            // OHLC 4 値の array なので special-case のまま既存挙動を維持。
            var seenLine = Object.create(null);
            for (var i = 0; i < params.length; i += 1) {
              var p = params[i];
              if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                // ECharts は candlestick の p.value 先頭に系列の x (timestamp/index)
                // を入れて返すことがあるため、長さで分岐。length===4 の場合は
                // [O, C, L, H]、5 以上は [x, O, C, L, H]。
                var off = p.value.length >= 5 ? 1 : 0;
                lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName +
                  '  O ' + Number(p.value[off]).toFixed(2) +
                  '  H ' + Number(p.value[off + 3]).toFixed(2) +
                  '  L ' + Number(p.value[off + 2]).toFixed(2) +
                  '  C ' + Number(p.value[off + 1]).toFixed(2) + '</div>');
              } else {
                var v = Array.isArray(p.value) ? p.value[1] : p.value;
                if (v == null) continue;
                var vText = Number(v).toFixed(2);
                var key = String(p.seriesName) + '|' + vText;
                if (seenLine[key]) continue;
                seenLine[key] = true;
                lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName +
                  ': ' + vText + '</div>');
              }
            }
            return lines.join('');
          },
        },
        legend: { top: 22, type: 'scroll' },
        // plot 面積最大化: grid 余白を絞り、splitLine 淡く、axisLine 非表示で
        // candle が映える背景に (trader-strategist 助言)。下部 slider 廃止に伴い
        // bottom は x軸ラベル分 (28px) のみ。
        // right は stop/TP の endLabel ("stop X (preview)" 等) が見切れないよう
        // 80px 確保 (短い "stop X (-Y%)" でも余白として違和感ない範囲)。
        grid: { left: 50, right: 20, top: 56, bottom: 28, containLabel: true },
        dataZoom: dataZoomCfg,
        // category mode: categories = intradayBars 各 bar の ISO timestamp。
        // overnight / 週末 / 米国祝日の空白を「詰めて」表示するため (TradingView
        // 同等)、time axis ではなく category axis を採用。category 間隔は等間隔
        // なので「金曜 16:00 ET 引け」と「月曜 09:30 ET 寄り」が隣接する。これは
        // 「同じ 1 hour 進んだように見える」が、休場で値が動いていない gap を
        // 詰める方が視認性で勝る (user 要望)。
        // time mode (intradayBars 空) では従来の time axis にフォールバック。
        xAxis: useCategoryAxis ? {
          type: 'category',
          data: categories,
          // 連続する category を密に並べた候補の中から ECharts が省略間引きする
          // ので、明示的な intervals 不要。formatter で個々の category 値 (ISO
          // timestamp) を JST に整形。
          axisLabel: { formatter: function (value) { return jstLabel(value); }, hideOverlap: true },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        } : {
          type: 'time',
          axisLabel: { formatter: function (value) { return jstLabel(value); } },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        },
        yAxis: {
          type: 'value', min: yMin, max: yMax,
          axisLabel: { showMinLabel: false, showMaxLabel: false },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        },
        series: [
          // 保有区間の薄背景 (markArea、#chart-markers)。host series 自体は
          // 空 data の line (markArea を legend 名付きでぶら下げるための器)。
          // z:0 で candle / 線群のさらに背面に置く。色は span ごとに
          // holdingAreaData 側の itemStyle で指定済み (勝ち緑 / 負け赤)。
          ...(holdingAreaData.length > 0 ? [{
            name: '保有区間 (確定)', type: 'line', data: [],
            symbol: 'none', silent: true, z: 0,
            itemStyle: { color: 'rgba(120, 120, 128, 0.4)' },
            markArea: { silent: true, data: holdingAreaData },
          }] : []),
          // 保有時は押し目バンド非表示 (avg/stop/TP に集中)、非保有時は表示。
          //
          // 帯は markArea fill のみで表現 (#232 follow-up): 以前は per-timestamp
          // の dashed line 2 本も併用していたが、20 日 high はあまり動かず
          // markArea の上下境界とほぼ重なって冗長だった。markArea のみに統一して
          // 凡例もコンパクトにし、chart の視認性を上げる。
          ...((sc.position || !pullbackBandMarkArea) ? [] : [
            {
              name: '押し目ゾーン',
              type: 'line', data: [],
              symbol: 'none', z: 1,
              markArea: pullbackBandMarkArea,
            },
          ]),
          // per-timestamp 上下端 (sloped lines)。markArea の上に重ねて、
          // high20d が動く銘柄での「帯の傾き」を可視化する。保有時 + 押し目
          // markArea 描画なしのケースは line も出さない (chart 過密回避)。
          // 凡例は markArea host series '押し目ゾーン' に集約させたいので、
          // この 2 本は legendHoverLink で同期する独立 series (name のみ別)。
          ...((sc.position || !pullbackBandMarkArea || !pullbackBandHasData) ? [] : [
            {
              name: '押し目上端',
              type: 'line', data: pullbackUpperXY,
              connectNulls: false,
              lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
              itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
              symbol: 'none', z: 2,
              // 入場まで距離を右端ラベルに (旧「入場ライン」線の代替)。
              endLabel: { show: true, formatter: pullbackUpperLabel, color: '#b25000', fontSize: 10 },
            },
            {
              name: '押し目下端',
              type: 'line', data: pullbackLowerXY,
              connectNulls: false,
              lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
              itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
              symbol: 'none', z: 2,
              endLabel: { show: true, formatter: pullbackLowerLabel, color: '#b25000', fontSize: 10 },
            },
          ]),
          // 価格トレンド (linear regression, 直近 30 日 daily close fit)。
          // 1 本だけ。中間色 (紫 #9333ea) で「上値 / 下値どちらでもない、価格
          // の重心」を表す。dense path (intradayBars 各 timestamp で y 補間)
          // で zoom にかかわらず確実に描画される (2 点 line series で zoom
          // 縮めると seg-droppable な ECharts 既知挙動 #3637 系への根本対処)。
          // z:7 で candle (z:5) / SMA50 (z:6) より上に置き、線本体を最前面に。
          // symbol:'none' で点 marker は出さない。itemStyle.color は legend
          // dot 色を lineStyle.color と揃えるため明示。
          ...(trendLineXY ? [{
            name: '価格トレンド (linear regression, 30日)', type: 'line', data: trendLineXY,
            lineStyle: { width: 1.8, color: '#9333ea', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#9333ea' }, z: 7,
          }] : []),
          // candle: 主役。日本式配色 (Google Finance JA と同じ):
          // 赤 = 陽線 (close >= open) / 緑 = 陰線 (close < open)。
          // markPoint / markLine もここに anchor。barWidth 明示で overnight
          // gap 後の細い candle を視認可能に。borderWidth 強めて
          // body と wick の対比を確保。
          ...(ohlcXY.length > 0 ? [{
            name: 'price (15m OHLC)', type: 'candlestick', data: ohlcXY,
            // barWidth は auto (slot 幅比例)。15m 化で本数が 4 倍になったため、
            // 固定 px だと zoom out 時に candle が重なる。
            itemStyle: {
              color: '#d23f31',     // 陽線 (close >= open) — 日本式は赤
              color0: '#1e8e3e',    // 陰線 (close < open) — 日本式は緑
              borderColor: '#d23f31',
              borderColor0: '#1e8e3e',
              borderWidth: 1.5,
            },
            z: 5,
            // position lines (avg/stop/TP) は dense path の独立 line series
            // として描画する (下方参照、densifyHorizontalLine 適用)。
            // candlestick の markLine は trend line / position line いずれも
            // dataZoom + 2 点だと「片端外で線が消える」回帰があるため使わない。
            //
            // ただしセッション境界の縦点線は xAxis: <category index> 指定で
            // y 軸全幅にまたがる「真の vertical markLine」となり、ECharts の
            // 描画 path が trend line (slanted 2-point markLine) とは別系統。
            // 縦線方向は zoom 範囲外でも描画ロバスト (#193 follow-up)。
            // category 軸モード時のみ data を積む (time axis fallback では空)。
            markLine: (function () {
              var mlData = sessionOpenIndices.map(function (idx) {
                return { xAxis: idx };
              });
              // 前日終値の水平点線 + 右端ラベル (Google Finance 風)。candle series
              // の markLine に同居させる (独立 series にすると legend を汚すため)。
              if (data.prevClose != null && Number.isFinite(data.prevClose)) {
                mlData.push({
                  yAxis: data.prevClose,
                  lineStyle: { color: '#9aa0a6', width: 1, type: 'dotted' },
                  label: {
                    show: true,
                    position: 'insideEndTop',
                    formatter: data.prevCloseLabel || '前日終値',
                    color: '#5f6368',
                    fontSize: 10,
                  },
                });
              }
              if (mlData.length === 0) return undefined;
              return {
                symbol: 'none',
                silent: true,
                label: { show: false },
                lineStyle: { color: '#bbb', width: 1, type: 'dashed' },
                z: 1,
                data: mlData,
              };
            })(),
            markPoint: entries.length + exits.length > 0 ? {
              symbol: 'pin', symbolSize: 24, data: entries.concat(exits),
              tooltip: {
                trigger: 'item',
                formatter: function (p) {
                  var d = p.data;
                  var pnl = d.realizedPnl == null
                    ? ''
                    : '<br/>realized PnL: ' + (d.realizedPnl >= 0 ? '+' : '') + d.realizedPnl.toFixed(2);
                  var qty = d.qty == null ? '' : '<br/>qty: ' + d.qty;
                  var ts = d.fillTimestamp == null ? '' : '<br/>fill: ' + jstLabelSec(d.fillTimestamp);
                  return d.name + ' @ ' + d.value.toFixed(2) + pnl + qty + ts
                    + '<br/><span style="font-size:10px;color:#888">クリックで注文詳細</span>';
                },
              },
            } : undefined,
          }] : []),
          // SMA50 line: Yahoo daily bars から server-side で連続計算 (cron eval
          // 行間も Yahoo 日次で線が繋がる)。candle (z:5) より上に置いて細い
          // candle 帯に重なっても見えるようにする。色は TradingView 系で
          // SMA に多用される orange (#f59e0b)、solid 1.4px。
          // trend line は独立 series で描画する (上方参照)。markLine 方式は
          // legend に出ないため legend と series の対応が崩れる。
          {
            name: 'SMA50', type: 'line', data: smasXY,
            lineStyle: { width: 1.4, color: '#f59e0b', type: 'solid' },
            symbol: 'none', connectNulls: true, z: 6,
          },
          // 保有時の avg / stop / TP 水平線。densifyHorizontalLine で
          // openedAt〜最新の dense path に展開済み (上方参照)。endLabel で
          // 右端に「avg 124.95」等のラベルを出す (zoom in しても右端は常に
          // 描画範囲内なので consistently 見える)。z:8 で candle / SMA50 /
          // trend line のすべてより上に置き、保有 status を最優先で可視化。
          // tooltip / hover には介入させたくないので silent + emphasis disabled。
          ...(avgLineXY ? [{
            name: avgLabel, type: 'line', data: avgLineXY,
            lineStyle: { width: 1, color: '#444', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#444' },
            endLabel: { show: true, formatter: avgLabel, color: '#444', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          ...(stopLineXY ? [{
            name: stopLabel, type: 'line', data: stopLineXY,
            lineStyle: { width: 1, color: '#c22', type: 'dashed' }, symbol: 'none',
            itemStyle: { color: '#c22' },
            endLabel: { show: true, formatter: stopLabel, color: '#c22', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          ...(tpLineXY ? [{
            name: tpLabel, type: 'line', data: tpLineXY,
            lineStyle: { width: 1, color: '#057a55', type: 'dashed' }, symbol: 'none',
            itemStyle: { color: '#057a55' },
            endLabel: { show: true, formatter: tpLabel, color: '#057a55', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          // 保有ナシ時の preview stop / TP (current price ベース)。dotted +
          // opacity 0.5 で「actual position の線ではない、仮置き」と視覚区別。
          // z:7 にして actual の z:8 より下に置く (混在することは無いが、
          // 凡例での視覚上の優先度として明示)。
          ...(previewStopLineXY ? [{
            name: previewStopLabel, type: 'line', data: previewStopLineXY,
            lineStyle: { width: 1, color: '#c22', type: 'dotted', opacity: 0.5 }, symbol: 'none',
            itemStyle: { color: '#c22', opacity: 0.5 },
            endLabel: {
              show: true, formatter: previewStopLabel, color: '#c22', fontSize: 10, opacity: 0.7,
            },
            silent: true, emphasis: { disabled: true }, z: 7,
          }] : []),
          ...(previewTpLineXY ? [{
            name: previewTpLabel, type: 'line', data: previewTpLineXY,
            lineStyle: { width: 1, color: '#057a55', type: 'dotted', opacity: 0.5 }, symbol: 'none',
            itemStyle: { color: '#057a55', opacity: 0.5 },
            endLabel: {
              show: true, formatter: previewTpLabel, color: '#057a55', fontSize: 10, opacity: 0.7,
            },
            silent: true, emphasis: { disabled: true }, z: 7,
          }] : []),
          // 入場ライン (#entry-distance): 今 BUY が成立する最寄り価格。cyan 実線 +
          // endLabel で「入場ライン $Y (−X.X%)」。現価格との差がチャート上の縦の
          // 隙間として直感的に読める。z:9 で価格線群より前面、判定点 (z:11) より背面。
          // 参考 価格外挿線: 直近ペースの未来延長 (点線)。予測ではない (legend / 注記)。
          // 交差点 (= 入場ライン到達) には pin を立てる。
          ...(projLineXY ? [{
            name: '参考 価格外挿 (予測ではない)', type: 'line', data: projLineXY,
            lineStyle: { width: 1.4, color: '#0891b2', type: 'dotted', opacity: 0.85 }, symbol: 'none',
            itemStyle: { color: '#0891b2' },
            silent: true, emphasis: { disabled: true }, z: 8,
            markPoint: projCrossPoint ? {
              symbol: 'pin', symbolSize: 30,
              data: [{
                coord: projCrossPoint.coord, value: projCrossPoint.value,
                itemStyle: { color: '#0891b2' },
                label: { show: true, formatter: '参考\\n到達', color: '#fff', fontSize: 9, lineHeight: 11 },
              }],
            } : undefined,
          }] : []),
          // 判定点 scatter: cron 判定イベントを価格チャートに重ねる。z を最前面に
          // 寄せて (candle z:5 / 線 z:6-8 より上) クリック可能にする。REJECT/ERROR
          // (= broker 拒否 / 失敗) は少し大きくして目立たせる。SKIP (bot 内部
          // ゲート見送り) は定常運転に近いので通常サイズ。
          // tooltip は item trigger で decision + reason 要約 (詳細は click→ラダー)。
          ...(decisionPoints.length > 0 ? [{
            name: '判定', type: 'scatter', data: decisionPoints,
            symbol: 'circle',
            symbolSize: function (val, p) {
              var dec = p && p.data ? p.data.decision : '';
              return (dec === 'REJECT' || dec === 'ERROR') ? 13 : 9;
            },
            z: 11, emphasis: { scale: 1.6 }, cursor: 'pointer',
            tooltip: {
              trigger: 'item',
              formatter: function (p) {
                var d = p.data;
                var ja = DECISION_LABEL_JA[d.decision] || d.decision;
                var price = Array.isArray(d.value) ? Number(d.value[1]).toFixed(2) : '';
                var rsn = d.reason ? '<div style="font-size:11px;max-width:280px;white-space:normal">' + escHtml(d.reason) + '</div>' : '';
                return '<div style="font-weight:600">' + escHtml(ja) + ' (' + escHtml(d.decision) + ') @ ' + price + '</div>'
                  + '<div style="font-size:11px">' + jstLabelSec(d.evalTs) + '</div>'
                  + rsn
                  + '<div style="font-size:10px;color:#888;margin-top:2px">クリックで判定トレース表示</div>';
              },
            },
          }] : []),
        ],
      });
      window.addEventListener('resize', function () { symChart.resize(); });

      // 判定点クリック → 脇パネルにその判定の判定トレース・ラダーを表示する
      // (文字ログ↔グラフ同期の肝)。ladderHtml は server 側で renderDecisionLadder
      // により事前レンダリング済み (全値 esc 済みの自前 markup) なので innerHTML
      // へ挿すだけ。JS 側にラダー描画ロジックを複製しない。
      var tracePanel = document.getElementById('decision-trace-panel');
      function showDecisionTrace(d) {
        if (!tracePanel || !d) return;
        tracePanel.innerHTML = d.ladderHtml || '';
      }
      // fill ピンクリック → 同じ脇パネルに fill 詳細 + 取引ジャーナルへの
      // 逆リンクを表示する (#chart-markers)。判定 pin (showDecisionTrace) と
      // 同じ流儀で innerHTML 差し替えのみ。値は DB 由来なので escHtml を通し、
      // clientOrderId は URL 側 encodeURIComponent (quote も % escape される
      // ため href 属性への注入も安全)。
      function showFillDetail(d) {
        if (!tracePanel || !d) return;
        var side = d.name === 'SELL' ? '売り (SELL)' : '買い (BUY)';
        var sideColor = d.name === 'SELL' ? '#c22' : '#057a55';
        var price = Number(d.value).toFixed(2);
        var qty = d.qty == null ? '—' : String(d.qty);
        var pnl = d.realizedPnl == null
          ? '—'
          : (d.realizedPnl >= 0 ? '+' : '') + d.realizedPnl.toFixed(2);
        var pnlColor = d.realizedPnl == null ? '#555' : (d.realizedPnl >= 0 ? '#057a55' : '#c22');
        var link = d.clientOrderId
          ? '<a href="/dashboard/trades?clientOrderId=' + encodeURIComponent(d.clientOrderId) + '" style="font-size:12px">この注文の履歴 →</a>'
          : '<span class="muted" style="font-size:11px">注文 ID 未記録 (旧 fill)</span>';
        tracePanel.innerHTML =
          '<div style="font-size:13px;font-weight:600;margin-bottom:4px;color:' + sideColor + '">約定 ' + escHtml(side) + ' @ ' + price + '</div>'
          + '<div style="font-size:12px">日時: ' + escHtml(d.fillTimestamp == null ? '—' : jstLabelSec(d.fillTimestamp)) + '</div>'
          + '<div style="font-size:12px">価格 × 数量: ' + price + ' × ' + escHtml(qty) + '</div>'
          + '<div style="font-size:12px">実現損益: <span style="color:' + pnlColor + '">' + escHtml(pnl) + '</span></div>'
          + '<div style="margin-top:4px">' + link + '</div>';
      }
      symChart.on('click', function (p) {
        if (p && p.seriesName === '判定' && p.data && p.data.ladderHtml != null) {
          showDecisionTrace(p.data);
          if (tracePanel) tracePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else if (p && p.componentType === 'markPoint' && p.data && p.data.fillTimestamp != null) {
          // fill ピンは candle series の markPoint (componentType で識別)。
          // 外挿線の「参考 到達」pin は fillTimestamp を持たないので反応しない。
          showFillDetail(p.data);
          if (tracePanel) tracePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      // 初期表示: 最新の判定点のトレースを開いておく。操作前から log↔graph が
      // 結びついた状態 (= 直近に何が起きたか) を一目で見せる。
      if (decisionPoints.length > 0) showDecisionTrace(decisionPoints[decisionPoints.length - 1]);

      // visible 範囲 (zoom 後の x 軸) 内の candle high/low / markers / position
      // 線を集めて y 軸 range を再計算。zoom out / preset 切替で「縦に空白が
      // 広がる」現象を防ぎプロ chart 風のタイト fit に。
      // category mode では dataZoom.startValue/endValue は category index、
      // time mode では ms。各 bar / marker / point について
      // 「visible 範囲内か」を判定する関数を mode で切り替える。
      function recomputeYAxis() {
        var opt = symChart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return;
        var startVal = dz.startValue;
        var endVal = dz.endValue;
        if (startVal == null || endVal == null) return;
        // mode 共通: 「ts (ISO string) または ms が visible か」を返す。
        // category mode では nearestIndex で snap した index を range と比較。
        // time mode では ms を range と比較。
        function inRangeMs(ms) {
          if (!Number.isFinite(ms)) return false;
          if (useCategoryAxis) {
            var idx = nearestIndex(ms);
            return idx >= startVal && idx <= endVal;
          }
          return ms >= startVal && ms <= endVal;
        }
        // category index ベースの直接判定 (intradayBars iterate 用)
        function inRangeIdx(idx) {
          if (useCategoryAxis) return idx >= startVal && idx <= endVal;
          return true; // time mode では使わない (intradayBars iterate 側で ms 判定)
        }
        var visibleY = [];
        function pushIfFinite(v) {
          if (v != null && typeof v === 'number' && Number.isFinite(v)) visibleY.push(v);
        }
        (sc.intradayBars || []).forEach(function (b, i) {
          if (useCategoryAxis ? inRangeIdx(i) : inRangeMs(new Date(b.timestamp).getTime())) {
            pushIfFinite(b.high);
            pushIfFinite(b.low);
          }
        });
        sc.markers.forEach(function (m) {
          if (inRangeMs(new Date(m.timestamp).getTime())) pushIfFinite(m.price);
        });
        // visible 範囲内の SMA50 は「candle range の近傍にある時だけ」含める。
        // #181 では SMA50 常時可視を優先したが、乖離が大きい銘柄 (3x ETF rally
        // 等: SMA50=125 / 価格=260) では軸が倍近く引き伸ばされ、candle の
        // 高値-安値が読めなくなる (operator 指摘で方針転換)。近傍 = candle
        // range を上下 25% 拡張した帯。帯の外の SMA50 線は clip されるが、値は
        // 価格ヘッダーのサブ行 (SMA50: X) で常に確認できる。
        var candleMin = visibleY.length ? Math.min.apply(null, visibleY) : null;
        var candleMax = visibleY.length ? Math.max.apply(null, visibleY) : null;
        sc.points.forEach(function (p) {
          if (!inRangeMs(new Date(p.timestamp).getTime())) return;
          var v = p.sma50;
          if (v == null || !Number.isFinite(v)) return;
          if (candleMin == null) { visibleY.push(v); return; }
          var nearBand = Math.max((candleMax - candleMin) * 0.25, 0.5);
          if (v >= candleMin - nearBand && v <= candleMax + nearBand) visibleY.push(v);
        });
        // trend line: regression で fit した 1 本。pivots[0]→end の 2 点で
        // 直線が定義される。visible 範囲内に endpoint または時間軸の交点が
        // 乗るときに y 値を取り込んで axis 外にはみ出さないようにする。両
        // endpoint が範囲外でも線分が visible 帯を横断するなら sample して
        // その y を採用 (= 単純な 2 点線形補間)。
        // category mode では index 基準の visible range を ms に変換して
        // 既存の ms 補間ロジックをそのまま再利用する。
        function sampleTrendY(line) {
          if (!line) return;
          var p1 = line.pivots[0];
          var p2 = line.end;
          var t1 = new Date(p1.timestamp).getTime();
          var t2 = new Date(p2.timestamp).getTime();
          if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 === t2) return;
          var slope = (p2.price - p1.price) / (t2 - t1);
          var startMs, endMs;
          if (useCategoryAxis) {
            var sIdx = Math.max(0, Math.min(categories.length - 1, Math.round(startVal)));
            var eIdx = Math.max(0, Math.min(categories.length - 1, Math.round(endVal)));
            startMs = ohlcMs[sIdx];
            endMs = ohlcMs[eIdx];
          } else {
            startMs = startVal;
            endMs = endVal;
          }
          // visible 範囲と線分の交差区間を [a, b] にクリップして両端を採用
          var a = Math.max(startMs, Math.min(t1, t2));
          var b = Math.min(endMs, Math.max(t1, t2));
          if (a > b) return; // 重なりなし
          pushIfFinite(p1.price + slope * (a - t1));
          pushIfFinite(p1.price + slope * (b - t1));
        }
        sampleTrendY(sc.trendLine);
        // 保有期間が visible 範囲と重なっていれば position 線を含める。
        // category mode では openedAt の最近接 index と endVal を比較。
        if (sc.position) {
          var openedAtMs = new Date(sc.position.openedAt).getTime();
          var openedVisible = false;
          if (Number.isFinite(openedAtMs)) {
            if (useCategoryAxis) {
              var oIdx = nearestIndex(openedAtMs);
              openedVisible = oIdx <= endVal;
            } else {
              openedVisible = openedAtMs <= endVal;
            }
          }
          if (openedVisible) {
            var avg = sc.position.avgPrice;
            pushIfFinite(avg);
            pushIfFinite(avg * (1 + sc.rules.stopPct));
            pushIfFinite(avg * (1 + sc.rules.takeProfitPct));
          }
        } else if (sc.latestCronPrice != null && sc.latestCronPrice > 0) {
          // preview lines は描画範囲が chart 開始 → 最新 cron eval まで。
          // visible 範囲とは常に交差する想定。virtualAvg = latestCronPrice
          // (Yahoo filler ではなく実 strategy 評価値) から stop/TP を算出。
          // latestCronPrice == null のときは preview 線そのものを描いていない
          // ので y range にも含めない (= 軸が無駄に広がるのを防ぐ)。
          var pVirtualAvg = sc.latestCronPrice;
          pushIfFinite(pVirtualAvg * (1 + sc.rules.stopPct));
          pushIfFinite(pVirtualAvg * (1 + sc.rules.takeProfitPct));
        }
        // 押し目ゾーン上端 (= 入場まで距離ラベルを載せた線) を y 範囲に含めて
        // ラベルが枠外に切れないようにする。下端は広がりすぎ防止のため含めない。
        if (Number.isFinite(bandUpperY)) pushIfFinite(bandUpperY);
        // 参考 価格外挿線の末尾価格も含める (未来スロットに描くので zoom 右端で visible)。
        if (projEndPrice != null) pushIfFinite(projEndPrice);
        if (visibleY.length === 0) return;
        var rawMin = Math.min.apply(null, visibleY);
        var rawMax = Math.max.apply(null, visibleY);
        if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return;
        var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
        symChart.setOption({ yAxis: { min: rawMin - pad, max: rawMax + pad } });
      }
      // 初回 render 後に一度実行 (default zoom 範囲に y を tight fit)
      recomputeYAxis();

      // dataZoom 変更で URL の ?from / ?to を更新 (replaceState なので history
      // 汚染なし)。debounce 200ms で連続操作中の URL flicker を抑制。
      // 同時に symbol picker / tab strip の '?tab=symbol' リンクの href も
      // 上書き → 銘柄切替で zoom が古い range に reset されない。
      // y 軸も visible 範囲に再 fit (recomputeYAxis、debounce 内で)。
      var dzTimer = null;
      symChart.on('dataZoom', function () {
        if (dzTimer) clearTimeout(dzTimer);
        dzTimer = setTimeout(function () {
          recomputeYAxis();
          var opt = symChart.getOption();
          var dz = opt.dataZoom && opt.dataZoom[0];
          if (!dz) return;
          var sv = dz.startValue;
          var ev = dz.endValue;
          if (sv == null || ev == null) return;
          try {
            // category mode: sv/ev は category index → categories[i] (ISO string)
            // を取り出して ms に変換。time mode: sv/ev は ms (number)。
            var fromMsLocal, toMsLocal;
            if (useCategoryAxis) {
              var sIdx = Math.max(0, Math.min(categories.length - 1, Math.round(sv)));
              var eIdx = Math.max(0, Math.min(categories.length - 1, Math.round(ev)));
              fromMsLocal = new Date(categories[sIdx]).getTime();
              toMsLocal = new Date(categories[eIdx]).getTime();
            } else {
              fromMsLocal = sv;
              toMsLocal = ev;
            }
            var fromIso = new Date(fromMsLocal).toISOString();
            var toIso = new Date(toMsLocal).toISOString();
            var url = new URL(window.location.href);
            url.searchParams.set('from', fromIso);
            url.searchParams.set('to', toIso);
            window.history.replaceState({}, '', url.toString());
            // server-render 時の picker / tab strip リンクは古い from/to を
            // 持っているので、ここで href を新値に書き換える。
            var symbolLinks = document.querySelectorAll('a[href*="tab=symbol"]');
            for (var i = 0; i < symbolLinks.length; i += 1) {
              try {
                var linkUrl = new URL(symbolLinks[i].href);
                linkUrl.searchParams.set('from', fromIso);
                linkUrl.searchParams.set('to', toIso);
                symbolLinks[i].href = linkUrl.toString();
              } catch (e) { /* noop per-link */ }
            }
          } catch (e) { /* noop */ }
        }, 200);
      });

      // preset zoom buttons (1D / 5D / 1M / All) の click handler。
      // dispatchAction で dataZoom を更新 → 既存の dataZoom listener が
      // URL ?from / ?to も連動更新する。
      // category mode では ms 範囲を最近接 index に snap してから dispatch。
      var presetButtons = document.querySelectorAll('.zoom-preset');
      for (var pi = 0; pi < presetButtons.length; pi += 1) {
        presetButtons[pi].addEventListener('click', function (ev) {
          var fromMs = Number(ev.currentTarget.getAttribute('data-from-ms'));
          var toMs = Number(ev.currentTarget.getAttribute('data-to-ms'));
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
          var sv, eV;
          if (useCategoryAxis) {
            sv = nearestIndex(fromMs);
            eV = nearestIndex(toMs);
            if (sv < 0 || eV < 0) return;
            if (sv > eV) { var tmp = sv; sv = eV; eV = tmp; }
          } else {
            sv = fromMs;
            eV = toMs;
          }
          // Google 風ピルの active 付替 (押した range を強調)
          for (var pj = 0; pj < presetButtons.length; pj += 1) presetButtons[pj].classList.remove('active');
          ev.currentTarget.classList.add('active');
          // dataZoom は inside 1 つだけ (slider 廃止)
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
        });
      }
    });
  `
  // chart payload に displayName を注入。client 側の chart title / tooltip header
  // は `sc.displayName || sc.symbol` で読む (US 銘柄は displayName === symbol)。
  // evalIndicators は buyability を server で算出済みなので client へは送らない
  // (入場までの距離は押し目ゾーン端ラベル / 外挿線で表現)。
  const symbolChartPayload = args.symbolChart
    ? (({ evalIndicators: _omit, ...rest }) => ({
        ...rest,
        displayName: displaySymbol(args.symbolChart!.symbol, args.universe),
      }))(args.symbolChart)
    : null
  // 参考 価格外挿線 (#entry-distance のグラフ表現)。直近ペースを未来へ延ばした
  // 「予測ではない外挿」。client は category 軸に未来スロットを足して描く。
  const projection = args.buyability?.projection ?? null
  // 前日終値 (header の前日比とチャート点線の共通基準)。
  const prevClose = prevDailyClose(args.symbolChart)
  const prevCloseLabel =
    prevClose !== null
      ? `前日終値 ${fmtPriceCcy(prevClose, args.universe?.symbolCurrency[args.symbolChart!.symbol.toUpperCase()] ?? null)}`
      : null
  const content = `<div class="symbol-chart-pin">
  ${renderFocusSymbolHeader(args)}
  ${renderPriceHeader(args.symbolChart, args.universe)}
  <div id="symbol-chart" style="width:100%;height:380px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:8px"></div>
  ${renderZoomPresetButtons(args.symbolChart)}
  </div>
  ${renderSymbolPolicyLine(args.focusSymbol, args.symbolPolicy ?? null)}
  ${renderPairRegimeLine(args.pairRegime ?? null)}
  ${renderBuyabilityPanel(args.buyability ?? null, {
    entryStatus: args.entryStatus ?? null,
    currency: args.focusSymbol ? currencyOfSymbol(args.focusSymbol) : null,
  })}
  ${renderDecisionPlotCaption(args.symbolChart)}
  <div id="decision-trace-panel" class="reason-panel" style="margin-top:10px">
    <p class="muted" style="font-size:12px;margin:0">判定点 (●) をクリックすると採用ロジックのトレース、fill ピン (BUY/SELL) をクリックすると約定詳細と注文履歴へのリンクがここに表示されます。</p>
  </div>
  ${renderSymbolDecisionHistory(args)}
  ${renderStrategyParamsPanel(args.strategyParams, args.strategyParamsGlobal)}`
  return `${wrapWithSymbolRail(args, content)}
  ${safeJsonScript('__chartData', {
    symbolChart: symbolChartPayload,
    projection,
    prevClose,
    prevCloseLabel,
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

/** 段階判定 badge の配色 (#452 PR 2)。 */
export const ENTRY_STATUS_BADGE: Record<EntryStatus, { label: string; bg: string; fg: string }> = {
  ENTRY: { label: 'ENTRY', bg: '#e6f6ec', fg: '#057a55' },
  HALF: { label: 'HALF 0.5x', bg: '#fff4e6', fg: '#b25000' },
  WATCH: { label: 'WATCH', bg: '#eef2f8', fg: '#46608a' },
  NG: { label: 'NG', bg: '#fdecec', fg: '#c22' },
}

export function entryStatusBadgeHtml(status: EntryStatus): string {
  const b = ENTRY_STATUS_BADGE[status]
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:${b.bg};color:${b.fg};font-weight:700;font-size:11px" title="段階判定 (#452): 発注対象は ENTRY / HALF のみ">${b.label}</span>`
}

/**
 * target / active weight の並記 (#452 Layer 3)。target を持つ (or 退避を受けた)
 * 銘柄のみ 1 行出す。「設定上 5% だが現在は SGOV に退避中」を panel 上で見せる。
 */
export function renderAllocationLine(alloc: SymbolAllocation | undefined): string {
  if (!alloc) return ''
  const pct = (w: number) => `${Math.round(w * 1000) / 10}%`
  const changed = Math.abs(alloc.activeWeight - alloc.targetWeight) > 1e-9
  const color = alloc.activeWeight === 0 ? '#b25000' : changed ? '#057a55' : '#86868b'
  const arrow = changed ? ` → <strong>${pct(alloc.activeWeight)}</strong>` : ''
  const reroute = alloc.rerouteTo ? `（${esc(alloc.rerouteTo)} へ退避中）` : ''
  const rerouted = alloc.reroutedInWeight > 0 ? `（+${pct(alloc.reroutedInWeight)} 退避受入）` : ''
  return `<div style="font-size:11px;color:${color};margin-bottom:4px" title="${esc(alloc.reason)}">配分 target ${pct(alloc.targetWeight)}${arrow}${reroute}${rerouted}</div>`
}

/**
 * 個別銘柄タブのロール / 配分ポリシー行 (#452)。role も配分も未設定なら出さない
 * (従来挙動の銘柄でノイズにしない)。設定変更は編集フォームへのリンクで誘導。
 */
export function renderSymbolPolicyLine(
  symbol: string | null,
  policy: SymbolPolicySummary | null,
): string {
  if (!symbol || !policy) return ''
  const hasAny =
    policy.role !== null ||
    policy.targetWeight !== null ||
    policy.entryRequired ||
    policy.alwaysActive ||
    policy.cashFallbackSymbols !== null
  if (!hasAny) return ''
  const parts: string[] = []
  if (policy.role !== null) {
    const known = (SYMBOL_ROLES as readonly string[]).includes(policy.role)
    parts.push(
      known
        ? `ロール: <code style="font-size:12px" title="${esc(SYMBOL_ROLE_LABELS[policy.role as SymbolRole])}">${esc(policy.role)}</code>: <strong>${esc(SYMBOL_ROLE_LABELS_SHORT[policy.role as SymbolRole])}</strong>`
        : `ロール: <span class="err" title="不正な role 値 — entry は抑止されます (fail-closed)">⚠ ${esc(policy.role)}</span>`,
    )
  }
  if (policy.targetWeight !== null) {
    parts.push(`配分 target ${Math.round(policy.targetWeight * 1000) / 10}%`)
  }
  if (policy.alwaysActive) parts.push('<span title="判定に関わらず常時 target = active">常時配分</span>')
  if (policy.entryRequired) parts.push('<span title="entry 判定 (ENTRY/HALF) 通過時のみ実配分有効">条件連動</span>')
  if (policy.cashFallbackSymbols !== null) {
    parts.push(
      `退避先 ${policy.cashFallbackSymbols.map((fb) => `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(fb)}">${esc(fb)}</a>`).join(' / ')}`,
    )
  }
  return `<div style="margin-top:8px;font-size:13px;color:#3a3a3c;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    ${parts.join('<span style="color:#d0d0d5">｜</span>')}
    <a href="/dashboard/symbols/${encodeURIComponent(symbol)}/edit" style="font-size:12px">設定変更</a>
  </div>`
}

/**
 * PullbackUptrendStrategy の TEST_DEFAULT_RULE と一致 (=コード上の default)。
 * チャートパネルで「default 値から変更されている項目」を ⚠ で flag するための
 * 比較対象。schema 側の default も同値 (pullback_default_*)。
 */
export const STRATEGY_DEFAULTS: StrategyParamsSnapshot = {
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.0,
  maxSma50DeviationPct: 0.6,
  maxAtrRatio: 1.5,
  reentryMinAtrBelowLastExit: 1.0,
  reentryGuardBusinessDays: 3,
}

/**
 * チャート併置の戦略パラメータパネル (#168)。チャート上のラベル
 * (押し目 ×N、stop -4% 等) はオーバーレイ 4 本制限のため限定的なので、
 * 補助情報として全パラメータを一覧表示。default からの変更を ⚠ で強調し
 * 「設定の意図しない残存」(例: pullback_max=0 のデバッグ残骸) に運用者が
 * 気づきやすくする。
 */
export function renderStrategyParamsPanel(
  p: StrategyParamsSnapshot,
  globalParams?: StrategyParamsSnapshot,
): string {
  const flag = (current: number | boolean, def: number | boolean): string =>
    current === def ? '' : ' <span class="warn" title="default 値から変更">⚠</span>'
  // effective 値が global と異なる = role preset / 銘柄管理の override 由来。
  // 「銘柄管理で設定した値ではなく global が出ている」と誤読されないよう、
  // 出どころを行内で明示する (operator 指摘)。
  const symbolTag = (key: keyof StrategyParamsSnapshot): string =>
    globalParams !== undefined && p[key] !== globalParams[key]
      ? ' <span style="font-size:10px;padding:1px 5px;border-radius:8px;background:#e8f0fe;color:#1a56db" title="role preset / 銘柄別 override 由来 (global と異なる)">銘柄別</span>'
      : ''
  const pct = (n: number): string =>
    (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
  const rows: Array<{ label: string; key: keyof StrategyParamsSnapshot; current: string; def: string; flag: string }> = [
    {
      label: '損切ライン (stopPct)',
      key: 'stopPct',
      current: pct(p.stopPct),
      def: pct(STRATEGY_DEFAULTS.stopPct),
      flag: flag(p.stopPct, STRATEGY_DEFAULTS.stopPct),
    },
    {
      label: '利食ライン (takeProfitPct)',
      key: 'takeProfitPct',
      current: pct(p.takeProfitPct),
      def: pct(STRATEGY_DEFAULTS.takeProfitPct),
      flag: flag(p.takeProfitPct, STRATEGY_DEFAULTS.takeProfitPct),
    },
    {
      label: '時間切れ (timeStopDays)',
      key: 'timeStopDays',
      current: `${p.timeStopDays} 営業日`,
      def: `${STRATEGY_DEFAULTS.timeStopDays} 営業日`,
      flag: flag(p.timeStopDays, STRATEGY_DEFAULTS.timeStopDays),
    },
    {
      label: '押し目 上限 (pullbackMax)',
      key: 'pullbackMax',
      current: pct(p.pullbackMax),
      def: pct(STRATEGY_DEFAULTS.pullbackMax),
      flag: flag(p.pullbackMax, STRATEGY_DEFAULTS.pullbackMax),
    },
    {
      label: '押し目 下限 (pullbackMin)',
      key: 'pullbackMin',
      current: pct(p.pullbackMin),
      def: pct(STRATEGY_DEFAULTS.pullbackMin),
      flag: flag(p.pullbackMin, STRATEGY_DEFAULTS.pullbackMin),
    },
    {
      // lookback の実体は 20 営業日 (#318)。field 名は global_config 列との互換で
      // minReturn50d のまま、人間向け文言だけ 20 日に揃える。
      label: '20日騰落率 閾値 (minReturn50d)',
      key: 'minReturn50d',
      current: pct(p.minReturn50d),
      def: pct(STRATEGY_DEFAULTS.minReturn50d),
      flag: flag(p.minReturn50d, STRATEGY_DEFAULTS.minReturn50d),
    },
    {
      label: 'SMA50 上 必須 (requireAboveSma50)',
      key: 'requireAboveSma50',
      current: p.requireAboveSma50 ? 'true' : 'false',
      def: STRATEGY_DEFAULTS.requireAboveSma50 ? 'true' : 'false',
      flag: flag(p.requireAboveSma50, STRATEGY_DEFAULTS.requireAboveSma50),
    },
    {
      label: 'ATR 倍率 (kAtr、サイジング用)',
      key: 'kAtr',
      current: p.kAtr.toFixed(2),
      def: STRATEGY_DEFAULTS.kAtr.toFixed(2),
      flag: flag(p.kAtr, STRATEGY_DEFAULTS.kAtr),
    },
  ]
  const tbody = rows
    .map(
      (r) =>
        `<tr><th>${esc(r.label)}</th><td>${esc(r.current)}${r.flag}${symbolTag(r.key)}</td><td class="muted">${esc(r.def)}</td></tr>`,
    )
    .join('')
  return `<details open style="margin-top:12px">
    <summary style="cursor:pointer;font-size:13px">戦略パラメータ (PullbackUptrendStrategy${globalParams !== undefined ? ' — この銘柄に適用される値' : ''}) — <span class="muted">⚠ は default から変更されている項目</span></summary>
    <table style="margin-top:8px">
      <thead><tr><th>項目</th><th>現在値</th><th>default</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">
      「銘柄別」タグは role preset / 銘柄管理の override 由来 (設定は 銘柄管理 → 編集)。
      global の変更は 設定ページ (pullback_default_*)。
    </p>
  </details>`
}

/**
 * チャート上に「現在の主要 indicator (price / SMA50 / high20d / low20d / atr20)」
 * を inline badge で表示。trader-strategist 助言で SMA50 を chart line から
 * 撤去 (15m chart の y軸を引き伸ばさないため) した代替表示。最新の cron-eval
 * point から取得し、null は em-dash (—) で fallback。
 */
export const JST_MD_FMT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
})

/**
 * 入場ゲートを「<左辺名> <実測> <記号> [<閾値名>] <閾値>」で整形 (#entry-distance /
 * #trace-readability)。左の値が何の数字かを名前で明示する。価格系は通貨記号 ($/¥)
 * 付き (currency 未指定なら $)。
 */
export function fmtGateValue(g: EntryGateStatus, currency: string | null = null): string {
  const sym = ({ '>': '>', '>=': '≥', '<': '<', '<=': '≤' } as Record<string, string>)[g.operator] ?? g.operator
  const price = (v: number): string => fmtPriceCcy(v, currency)
  switch (g.key) {
    case 'trend':
      return `20日騰落率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'overextension':
      return `移動平均乖離率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'pullback_shallow':
    case 'pullback_deep':
      return `押し目率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'above_sma50':
      return `株価 ${price(g.actual)} ${sym} SMA50 ${price(g.threshold)}`
    case 'volatility':
      return `ATR倍率 ${g.actual.toFixed(2)}× ${sym} ${g.threshold.toFixed(2)}×`
    case 'high20d_valid':
      return `直近高値 ${price(g.actual)} ${sym} ${price(g.threshold)}`
  }
}

/**
 * 「入場まで あとどれくらい / いつ頃」パネル (#entry-distance)。
 * - 結論 (buyable / 価格であと X% / 価格では不可+ボトルネック)
 * - 距離の推移 (mini bar、縮小/拡大トレンド)
 * - 参考 ETA (外挿・非予測の注記つき)
 * - 全ゲートの現在値 vs 閾値チェックリスト
 * buyability / current が無ければ空文字。
 */
export interface BuyabilityPanelContext {
  /** 段階判定 (#452 PR 2)。null = 出さない。 */
  entryStatus?: EntryStatusResult | null
  /** 価格表示の通貨 ($/¥)。未指定なら $。 */
  currency?: string | null
}

export function renderBuyabilityPanel(
  buyability: BuyabilityView | null,
  ctx: BuyabilityPanelContext = {},
): string {
  if (!buyability || !buyability.current) return ''
  const cur = buyability.current
  const status = ctx.entryStatus ?? null
  const ccy = ctx.currency ?? null

  // --- 結論 ---
  let headline: string
  let headColor: string
  if (cur.buyable) {
    headline =
      '現在 入場条件を充足（cron 評価では BUY 候補。実発注は資金 / 単元など発注側ゲート次第）'
    headColor = '#057a55'
  } else if (cur.entryPrice !== null && cur.priceMove !== null) {
    const dir = cur.priceMove < 0 ? '下落' : '上昇'
    const binding = cur.bindingGate ? ` ／ ボトルネック: ${esc(cur.bindingGate.labelJa)}` : ''
    headline = `入場まで: あと 価格 <strong>${fmtPctSigned(cur.priceMove)}</strong>（${fmtPriceCcy(cur.entryPrice, ccy)} 到達 = ${dir}）${binding}`
    headColor = '#b25000'
  } else {
    const g = cur.bindingGate
    const why = g
      ? g.priceDependent
        ? '押し目ゾーンと過熱上限が同時に成立しない局面です。'
        : 'この指標が条件を満たすまでは、価格がどこでも入場しません。'
      : ''
    headline = g
      ? `価格を動かすだけでは入場不可 — ボトルネック: <strong>${esc(g.labelJa)}</strong>（${esc(fmtGateValue(g, ccy))} 不成立）。${why}`
      : '入場条件 評価不可'
    headColor = '#c22'
  }

  // --- 距離の推移 (mini bars) ---
  const movePts = buyability.series.filter(
    (p): p is typeof p & { priceMove: number } => p.priceMove !== null,
  )
  const recent = movePts.slice(-8)
  let trendBlock = ''
  if (recent.length > 0) {
    const maxGap = Math.max(...recent.map((p) => Math.abs(p.priceMove)), 1e-9)
    const bars = recent
      .map((p, i) => {
        const gap = Math.abs(p.priceMove)
        const w = Math.max(2, Math.round((gap / maxGap) * 90))
        const last = i === recent.length - 1
        const color = last ? headColor : '#c9c9cf'
        const md = JST_MD_FMT.format(new Date(p.timestamp))
        return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.5">
          <span style="width:34px;color:#86868b;text-align:right">${esc(md)}</span>
          <span style="display:inline-block;height:8px;width:${w}px;background:${color};border-radius:2px"></span>
          <span style="font-variant-numeric:tabular-nums">${fmtPctSigned(p.priceMove)}</span>
        </div>`
      })
      .join('')
    const trendLabel =
      buyability.trend === 'closing'
        ? '<span style="color:#057a55">縮小中（入場に近づいている）</span>'
        : buyability.trend === 'widening'
          ? '<span style="color:#b25000">拡大中（入場から遠ざかっている）</span>'
          : buyability.trend === 'flat'
            ? '<span class="muted">横ばい</span>'
            : '<span class="muted">判定不能</span>'
    trendBlock = `<div style="margin-top:8px"><strong>距離の推移</strong>(入場までの価格距離)：${trendLabel}
      <div style="margin-top:4px">${bars}</div></div>`
  } else {
    trendBlock = `<div style="margin-top:8px" class="muted">距離の推移: 価格距離が算出できる評価日がありません（価格非依存ゲートが要因）。</div>`
  }

  // --- 参考 ETA ---
  let etaBlock = ''
  if (buyability.etaTradingDays !== null && buyability.trend === 'closing') {
    const days = Math.max(1, Math.ceil(buyability.etaTradingDays))
    etaBlock = `<div style="margin-top:8px"><strong>参考 ETA</strong>: このペースが続けば 約 ${days} 営業日
      <div class="muted" style="font-size:11px">⚠ 外挿の参考値・予測ではない（相場が逆行すれば遠のく / 押し目バンドも日々動く）</div></div>`
  }

  // --- ゲートチェックリスト ---
  const gateRows = cur.gates
    .map((g) => {
      const ok = g.passed
      const binding = cur.bindingGate?.key === g.key
      const mark = ok ? '✅' : '❌'
      const bg = ok ? '#f1f8f4' : '#fdf0f0'
      const border = binding ? 'border-left:3px solid #c22;' : 'border-left:3px solid transparent;'
      const tag = binding ? ' <span style="color:#c22;font-weight:600">◀ ボトルネック</span>' : ''
      return `<div style="display:flex;align-items:baseline;gap:8px;padding:3px 8px;background:${bg};${border}border-radius:4px;font-size:12px;flex-wrap:wrap">
        <span>${mark}</span><span>${esc(g.labelJa)}</span>
        <span style="color:#555;font-variant-numeric:tabular-nums">${esc(fmtGateValue(g, ccy))}</span>${tag}
      </div>`
    })
    .join('')

  // --- 段階判定 badge + HALF 説明 (#452 PR 2) ---
  const statusBadge = status ? entryStatusBadgeHtml(status.status) : ''
  let halfNote = ''
  if (status?.status === 'HALF' && status.halfGate) {
    halfNote = `<div style="margin-top:6px;font-size:12px;color:#b25000">HALF: 未通過は「${esc(status.halfGate.labelJa)}」のみで閾値の許容バンド内 → 0.5x サイジングで entry 候補 (role が entry 有効な銘柄のみ発注対象)。</div>`
  }

  // 距離の推移 (+ETA) と 入場ゲート は 2 列 (narrow 画面は .panel-row の
  // media query で 1 列に落ちる)。
  return `<div class="reason-panel" style="margin-top:10px;max-width:1000px">
    <div style="font-size:13px;color:${headColor};margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${statusBadge}<span>${headline}</span></div>
    ${halfNote}
    <div class="panel-row" style="gap:8px 20px">
      <div>${trendBlock}${etaBlock}</div>
      <div style="margin-top:8px"><strong>入場ゲート</strong>(全条件。閾値は global 既定 + role preset + 銘柄 override、#452)
        <div style="margin-top:4px;display:flex;flex-direction:column;gap:3px">${gateRows}</div>
      </div>
    </div>
  </div>`
}

/**
 * 判定点プロットの凡例 + 件数キャプション (#decision-trace のグラフ同期)。
 * decisions が空なら空文字。最新 `MAX_CHART_DECISIONS` 件に達していれば
 * truncation を明示する (silent cap を避ける)。色は chart 側 DECISION_COLORS
 * および取引品質タブと揃える。
 */
export function renderDecisionPlotCaption(chart: SymbolChartData | null): string {
  const decisions = chart?.decisions ?? []
  if (decisions.length === 0) return ''
  const dot = (color: string, label: string): string =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span style="width:9px;height:9px;border-radius:50%;background:${color};box-shadow:0 0 0 1px #fff,0 0 0 2px ${color}"></span>${esc(label)}</span>`
  const capped =
    decisions.length >= MAX_CHART_DECISIONS
      ? ` <span class="muted">(直近 ${MAX_CHART_DECISIONS} 件まで表示)</span>`
      : ''
  return `<p class="muted" style="font-size:12px;margin:6px 0 2px">
    ● は cron の判定イベント。点をクリックすると下に判定トレースが出ます (文字ログとグラフを同期)。HOLD (保有継続 / 様子見) は省略。${capped}
  </p>
  <div style="font-size:12px;margin:0 0 4px">
    ${dot('#057a55', '買い (BUY)')}${dot('#1471a8', '売り (SELL)')}${dot('#b25000', '見送り・bot判定 (SKIP)')}${dot('#7c3aed', '拒否・証券会社 (REJECT)')}${dot('#c22', 'エラー (ERROR)')}
  </div>`
}

/**
 * 前日終値 (= 最終 daily point の 1 つ前の price)。比較・markLine 共用。
 * points が 2 点未満 / 非有限なら null。
 */
export function prevDailyClose(chart: SymbolChartData | null): number | null {
  const pts = chart?.points ?? []
  if (pts.length < 2) return null
  const v = pts[pts.length - 2]!.price
  return Number.isFinite(v) ? v : null
}

/**
 * Google Finance 風の価格ヘッダー: 大きい現在値 + 前日比 (%/絶対値)。
 * 日本式配色 (上昇=赤 / 下落=緑)。下段に SMA50 / high20d / low20d の小バッジ。
 * 現在値は latestCronPrice (直近 strategy 評価値)、無ければ最終 point の price。
 */
export function renderPriceHeader(
  chart: SymbolChartData | null,
  universe?: SymbolUniverse | null,
): string {
  if (!chart || chart.points.length === 0) return ''
  const last = chart.points[chart.points.length - 1]!
  const cur = chart.latestCronPrice ?? last.price
  if (!Number.isFinite(cur)) return ''
  const ccy = universe?.symbolCurrency[chart.symbol.toUpperCase()] ?? null
  const prev = prevDailyClose(chart)
  let changeHtml = ''
  if (prev !== null && prev > 0) {
    const diff = cur - prev
    const pct = (diff / prev) * 100
    const up = diff >= 0
    // 日本式: 上昇=赤 / 下落=緑 (Google Finance JA と同じ)
    const color = up ? '#d23f31' : '#188038'
    const arrow = up ? '▲' : '▼'
    const sign = up ? '+' : ''
    changeHtml = ` <span style="font-size:14px;font-weight:600;color:${color};margin-left:6px">${arrow} ${sign}${pct.toFixed(2)}% (${sign}${diff.toFixed(2)}) 前日比</span>`
  }
  // 最新の indicator 付き point (Yahoo filler は indicators null)
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  const subItems: Array<[string, string]> = latest
    ? [
        ['SMA50', fmt(latest.sma50)],
        ['high20d', fmt(latest.high20d)],
        ['low20d', fmt(latest.low20d)],
      ]
    : []
  const sub = subItems
    .map(
      ([k, v]) =>
        `<span style="display:inline-block;margin-right:10px;font-size:12px"><span class="muted">${esc(k)}:</span> <strong>${esc(v)}</strong></span>`,
    )
    .join('')
  return `<div style="margin:2px 0 0">
    <span style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${esc(fmtPriceCcy(cur, ccy))}</span>${changeHtml}
  </div>
  ${sub ? `<p style="margin:2px 0 0">${sub}</p>` : ''}`
}

/**
 * 個別銘柄タブの銘柄レール (左固定)。旧 inline picker (「切替: <長い名前の列挙>」)
 * は full name の link が折り返して読みづらかったため、ticker + 小さい銘柄名の
 * 縦リストに変更。zoom 範囲は従来通り URL で伝搬する。
 */
export function renderSymbolRail(args: ChartsBodySymbol): string {
  if (args.availableSymbols.length === 0) return ''
  // 銘柄切替時にズーム範囲を維持するため、現在の from/to をレール URL に伝搬
  const zoomQs = args.zoom
    ? `&from=${encodeURIComponent(args.zoom.from.toISOString())}&to=${encodeURIComponent(args.zoom.to.toISOString())}`
    : ''
  const items = args.availableSymbols
    .map((s) => {
      const inactive = isSymbolInactive(s, args.universe)
      const isFocus = s === args.focusSymbol
      const name = args.universe?.symbolName[s.toUpperCase()] ?? ''
      const cls = ['rail-item', isFocus ? 'active' : '', inactive ? 'inactive' : '']
        .filter(Boolean)
        .join(' ')
      const titleAttr = inactive
        ? ` title="${esc(inactiveTooltip(s, args.universe))}"`
        : name
          ? ` title="${esc(name)}"`
          : ''
      return `<a class="${cls}" href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(s)}${zoomQs}"${titleAttr}>
        <span class="rail-sym">${esc(s)}</span>${name ? `<span class="rail-name">${esc(name)}</span>` : ''}
      </a>`
    })
    .join('')
  return `<aside class="symbol-rail"><div class="rail-head">銘柄</div>${items}</aside>`
}

/** レール + 本文の 2 カラム。レールが空 (銘柄ゼロ) なら本文のみ。 */
export function wrapWithSymbolRail(args: ChartsBodySymbol, content: string): string {
  const rail = renderSymbolRail(args)
  if (!rail) return content
  return `<div class="symbol-layout">${rail}<div class="symbol-main">${content}</div></div>`
}

/**
 * 表示中銘柄の見出し行。active 銘柄では出さない (左レールの強調表示で自明)。
 * inactive 銘柄の時だけ、注記 (cron 評価対象外) 付きで出す。
 */
export function renderFocusSymbolHeader(args: ChartsBodySymbol): string {
  const focusInactive = args.focusSymbol
    ? isSymbolInactive(args.focusSymbol, args.universe)
    : false
  if (!args.focusSymbol || !focusInactive) return ''
  const focusLabel = displaySymbol(args.focusSymbol, args.universe)
  const note = args.universe?.symbolNotes[args.focusSymbol.toUpperCase()] ?? 'cron 評価対象外'
  return `<p class="muted" style="font-size:12px;margin:0 0 4px">銘柄: <strong>${esc(focusLabel)}</strong> <span class="muted" style="font-size:11px">(inactive — ${esc(note)})</span></p>`
}

/**
 * チャートページのタブ dispatcher (#remove-grid で grid.ts から移設)。
 * 全タブ renderer に依存するため、最後発の symbol モジュールに置く。
 */
export function chartsBody(args: ChartsBodyArgs): string {
  if (args.tab === 'overview') return renderOverviewTab(args)
  if (args.tab === 'quality') return renderQualityTab(args)
  return renderSymbolTab(args)
}
