import type { SymbolUniverse } from '../../../infrastructure/db/symbolUniverse'
import type { EntryStatus } from '../../../trading/strategy/entryStatus'
import { renderOverviewTab } from './equity'
import { type SymbolChartData, type SymbolChartPoint } from './loaders'
import { renderQualityTab } from './quality'
import { type ChartsBodyArgs, type ChartsBodyGrid, ECHARTS_CDN, renderZoomPresetButtons } from './shared'
import { entryStatusBadgeHtml, renderAllocationLine, renderSymbolTab } from './symbol'
import { displaySymbol, esc, inactiveTooltip, isSymbolInactive, safeJsonScript } from '../shared'

export function chartsBody(args: ChartsBodyArgs): string {
  if (args.tab === 'overview') return renderOverviewTab(args)
  if (args.tab === 'quality') return renderQualityTab(args)
  if (args.tab === 'grid') return renderGridTab(args)
  return renderSymbolTab(args)
}

/**
 * Grid panel の表示優先度ソート (#452 PR 2)。
 * ENTRY > HALF > WATCH > NG > cash_parking > 判定不能 (データ無し) > inactive。
 * 同順位内は元の並び (pair 隣接など) を保つ stable sort。
 */
export function sortGridChartsByEntryPriority<T extends { symbol: string }>(
  charts: T[],
  entryStatuses: Record<string, EntryStatus>,
  universe: SymbolUniverse,
): T[] {
  const inactive = new Set(universe.inactiveSymbols)
  const priority = (symbol: string): number => {
    if (inactive.has(symbol)) return 6
    if (universe.symbolRole[symbol] === 'cash_parking') return 4
    const status = entryStatuses[symbol]
    if (status === 'ENTRY') return 0
    if (status === 'HALF') return 1
    if (status === 'WATCH') return 2
    if (status === 'NG') return 3
    return 5 // 判定不能 (chart/eval データ無し)
  }
  return charts
    .map((entry, idx) => ({ entry, idx }))
    .sort((a, b) => priority(a.entry.symbol) - priority(b.entry.symbol) || a.idx - b.idx)
    .map(({ entry }) => entry)
}

export function renderGridTab(args: ChartsBodyGrid): string {
  if (args.charts.length === 0) {
    return `<p class="muted">ALLOWED_SYMBOLS が空です。<code>symbol_config</code> に少なくとも 1 銘柄登録してください。</p>`
  }
  // grid 共通 toolbar の preset zoom buttons。reference chart (最初に load 成功)
  // の lastTimestamp を基準に from/to を計算。各 panel が個別に同 timestamp 軸
  // を持つため、共通の ms 範囲で全 chart を dispatchAction で同期する。
  const referenceChart = args.charts.find((c) => c.chart !== null)?.chart ?? null
  const presetButtonsHtml = renderZoomPresetButtons(referenceChart)

  // 各 panel: chart 本体は client side で echarts.init される。panel header に
  // symbol 名 (詳細タブへの link) と最新 indicators (price / SMA50) を出して
  // 「市場全体ビュー」で trader が銘柄を一目で識別できるようにする。
  // inactive 銘柄は data 取得は通常通り行うが、panel header に INACTIVE バッジと
  // grayed-out style (`symbol-inactive`) を付けて視覚識別する。
  // panel に data-has-position / data-inactive を付け、上部 toolbar の checkbox
  // で client-side filter (display:none) する。state は localStorage に保存
  // (`dashboard.gridFilter.v1`)。chart=null (取得失敗) の panel は position 不明
  // のため has-position=false 扱い (= 「未保有」フィルタに含める)。
  const panelsHtml = args.charts
    .map((entry, idx) => {
      const inactive = isSymbolInactive(entry.symbol, args.universe)
      const hasPosition = entry.chart?.position != null
      // inactive は background / text-decoration の inline 上書きを避け、
      // CSS class 側 (.grid-panel.symbol-inactive と .symbol-disabled) に任せる。
      // inline style は CSS class より優先されてしまうため (CodeRabbit #230)。
      const baseStyle = inactive
        ? 'border:1px solid #d0d0d5;border-radius:6px;padding:8px'
        : 'border:1px solid #d0d0d5;border-radius:6px;padding:8px;background:#fff'
      const panelClass = inactive ? 'grid-panel symbol-inactive' : 'grid-panel'
      const dataAttrs = ` data-has-position="${hasPosition ? '1' : '0'}" data-inactive="${inactive ? '1' : '0'}"`
      const symbolLink = `/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(entry.symbol)}`
      const headerText = displaySymbol(entry.symbol, args.universe)
      const tooltipText = inactiveTooltip(entry.symbol, args.universe)
      const linkClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(tooltipText)}"` : ''
      const linkStyle = inactive
        ? 'font-weight:600;font-size:14px;color:#06c'
        : 'font-weight:600;font-size:14px;color:#06c;text-decoration:none'
      const headerLink = `<a href="${symbolLink}"${linkClass}${titleAttr} style="${linkStyle}">${esc(headerText)}</a>`
      const inactiveBadge = inactive
        ? `<span class="muted" style="font-size:11px"${titleAttr}>INACTIVE</span>`
        : ''
      const positionBadge = hasPosition
        ? `<span style="font-size:11px;color:#0a8a0a;font-weight:600" title="現保有あり">●保有</span>`
        : ''
      if (entry.chart === null) {
        const errMsg = entry.error ?? 'チャートデータ取得失敗'
        const errBadge = `<span class="warn" style="font-size:11px">取得失敗</span>`
        const rightSide = (inactive ? inactiveBadge : '') + errBadge
        return `<div class="${panelClass}"${dataAttrs} style="${baseStyle}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px">
            ${headerLink}
            <div style="display:flex;gap:6px;align-items:center">${rightSide}</div>
          </div>
          <div class="muted" style="font-size:12px;padding:24px 8px;text-align:center">${esc(errMsg)}</div>
        </div>`
      }
      const badge = renderGridPanelBadge(entry.chart)
      // 段階判定 badge (#452 PR 2)。inactive 銘柄は cron 評価対象外なので出さない。
      const status = args.entryStatuses?.[entry.symbol]
      const statusBadge = status !== undefined && !inactive ? entryStatusBadgeHtml(status) : ''
      const allocationLine = inactive
        ? ''
        : renderAllocationLine(args.allocations?.[entry.symbol])
      const rightSide = (inactive ? inactiveBadge : '') + statusBadge + positionBadge + badge
      return `<div class="${panelClass}"${dataAttrs} style="${baseStyle}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px">
          ${headerLink}
          <div style="display:flex;gap:6px;align-items:center">${rightSide}</div>
        </div>
        ${allocationLine}
        <div id="grid-chart-${idx}" style="width:100%;height:280px"></div>
      </div>`
    })
    .join('')

  // client 側に渡す全銘柄分の chart payload。各 panel が個別 echarts.init で
  // 消費する。__chartData.charts は array of { symbol, chart, displayName }
  // (chart は load 失敗で null)。displayName は server 側で JP 銘柄なら
  // "番号-会社名" を入れている (US は symbol そのまま) — tooltip header
  // (`sc.displayName || sc.symbol`) で読まれる。
  const payload = {
    charts: args.charts.map((c) => {
      // grid の mini chart は判定点 / 入場距離を描かないので、ラダー HTML を持つ
      // decisions と evalIndicators は payload から落としてサイズを抑える
      // (どちらも個別銘柄タブ専用)。
      const lean = c.chart
        ? (({ decisions: _omitD, evalIndicators: _omitE, ...rest }) => rest)(c.chart)
        : null
      return {
        symbol: c.symbol,
        chart: lean ? { ...lean, displayName: displaySymbol(c.chart!.symbol, args.universe) } : null,
        error: c.error,
        displayName: displaySymbol(c.symbol, args.universe),
      }
    }),
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  }

  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      if (!data || !Array.isArray(data.charts)) return;

      // mini chart factory: 1 panel 分の echarts instance を build して返す。
      // 単一銘柄タブの主要要素 (candle / 価格トレンド / position lines /
      // session divider / BUY-SELL pin) を引き継ぎつつ、SMA50 / band /
      // legend / chart 内 title は panel size のため省略する。
      function buildPanel(elId, sc) {
        if (!sc || !Array.isArray(sc.points) || sc.points.length === 0) return null;
        var el = document.getElementById(elId);
        if (!el) return null;
        var ohlcBars = sc.intradayBars || [];
        var useCategoryAxis = ohlcBars.length > 0;
        var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
        var categories = ohlcBars.map(function (b) { return b.timestamp; });

        var sessionOpenIndices = [];
        if (useCategoryAxis) {
          var SESSION_GAP_MS = 90 * 60 * 1000;
          for (var si = 1; si < ohlcMs.length; si++) {
            if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
          }
        }

        function nearestIndex(ms) {
          if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
          var lo = 0, hi = ohlcMs.length - 1;
          if (ms <= ohlcMs[0]) return 0;
          if (ms >= ohlcMs[hi]) return hi;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
          }
          if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
          return lo;
        }
        function xForTimestamp(ts) {
          if (useCategoryAxis) return nearestIndex(new Date(ts).getTime());
          return ts;
        }

        var jstFmt = new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        function jstLabel(value) {
          return jstFmt.format(new Date(value)).replace(/\\//g, '/');
        }
        function jstLabelForX(value) {
          if (useCategoryAxis && typeof value === 'number') {
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }

        var ohlcXY = useCategoryAxis
          ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
          : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });

        // SMA50: 個別銘柄タブと同形 (sc.points 各点の sma50 値)。null は break 用に
        // そのまま入れる (connectNulls=true でも null は points 間を非描画にする)。
        var smasXY = sc.points.map(function (p) {
          if (p.sma50 == null) return [xForTimestamp(p.timestamp), null];
          return [xForTimestamp(p.timestamp), p.sma50];
        });

        // 押し目ゾーン (#238 個別銘柄タブと同実装)。markArea (latest high20d 基準
        // の flat 帯) + per-timestamp の上下端 sloped line で構成。保有時は非表示。
        var pullbackMaxMul = 1 + sc.rules.pullbackMax;
        var pullbackMinMul = 1 + sc.rules.pullbackMin;
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
          data: [[{ yAxis: bandBottomY }, { yAxis: bandTopY }]],
        } : null;
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
        var pullbackBandHasData =
          pullbackUpperXY.some(function (xy) { return xy[1] != null; }) &&
          pullbackLowerXY.some(function (xy) { return xy[1] != null; });

        // dense trend line (個別銘柄タブと同アルゴリズム)
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
          out.sort(function (a, b) { return a[0] - b[0]; });
          return out.length > 0 ? out : null;
        }
        var trendLineXY = toCategoryXY(densifyTrendLine(sc.trendLine, ohlcTimestamps));

        // BUY/SELL pin: 個別銘柄タブと同形 (label は最新の fill 1 件のみ表示)
        var buys = (sc.markers || []).filter(function (m) { return m.side === 'BUY'; });
        var sells = (sc.markers || []).filter(function (m) { return m.side === 'SELL'; });
        var latestFillTs = sc.markers && sc.markers.length > 0
          ? sc.markers[sc.markers.length - 1].timestamp
          : null;
        var entries = buys.map(function (m) {
          var showLabel = m.timestamp === latestFillTs;
          return {
            name: 'BUY', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
            label: { show: showLabel, formatter: m.price.toFixed(2), color: '#057a55', position: 'top', distance: 4, fontSize: 10 },
            itemStyle: { color: '#057a55' },
          };
        });
        var exits = sells.map(function (m) {
          var showLabel = m.timestamp === latestFillTs;
          var pnlLabel = m.realizedPnl == null ? '' : ' ' + (m.realizedPnl >= 0 ? '+' : '') + m.realizedPnl.toFixed(1);
          return {
            name: 'SELL', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
            label: { show: showLabel, formatter: m.price.toFixed(2) + pnlLabel, color: '#c22', position: 'bottom', distance: 4, fontSize: 10 },
            itemStyle: { color: '#c22' },
          };
        });

        // 保有時の avg / stop / TP 水平線 (個別銘柄タブと同 dense path 方式)
        function densifyHorizontalLine(yValue, fromTs, toTs, samples) {
          if (!Number.isFinite(yValue)) return null;
          var a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime();
          var b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime();
          if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
          if (a >= b) return [[a, yValue], [b, yValue]];
          var seen = Object.create(null);
          var arr = [];
          function push(t) { if (seen[t]) return; seen[t] = true; arr.push(t); }
          push(a); push(b);
          for (var i = 0; i < samples.length; i += 1) {
            var t = samples[i];
            if (!Number.isFinite(t)) continue;
            if (t < a || t > b) continue;
            push(t);
          }
          arr.sort(function (x, y) { return x - y; });
          var out = [];
          for (var j = 0; j < arr.length; j += 1) out.push([arr[j], yValue]);
          return out;
        }
        var avgLineXY = null, stopLineXY = null, tpLineXY = null;
        // 保有ナシ時の preview stop/TP (latestCronPrice ベースの仮置き)。
        // 個別銘柄タブと同方針 (詳細コメントは上方参照)。Yahoo filler を
        // 含めないために sc.latestCronPrice / sc.latestCronTimestamp を採用。
        var previewStopLineXY = null, previewTpLineXY = null;
        var extraYValues = [];
        if (sc.position) {
          var avg = sc.position.avgPrice;
          var stopPrice = avg * (1 + sc.rules.stopPct);
          var tpPrice = avg * (1 + sc.rules.takeProfitPct);
          extraYValues.push(avg, stopPrice, tpPrice);
          var openedAt = sc.position.openedAt;
          var latestTs = sc.points.length > 0 ? sc.points[sc.points.length - 1].timestamp : openedAt;
          var endTs = new Date(latestTs).getTime() >= new Date(openedAt).getTime() ? latestTs : openedAt;
          var fromMs = new Date(openedAt).getTime();
          var toMs = new Date(endTs).getTime();
          avgLineXY = toCategoryXY(densifyHorizontalLine(avg, fromMs, toMs, ohlcTimestamps));
          stopLineXY = toCategoryXY(densifyHorizontalLine(stopPrice, fromMs, toMs, ohlcTimestamps));
          tpLineXY = toCategoryXY(densifyHorizontalLine(tpPrice, fromMs, toMs, ohlcTimestamps));
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
          var pFromMs = new Date(sc.points[0].timestamp).getTime();
          var pToMs = new Date(sc.latestCronTimestamp).getTime();
          if (Number.isFinite(pFromMs) && Number.isFinite(pToMs)) {
            previewStopLineXY = toCategoryXY(densifyHorizontalLine(pStopPrice, pFromMs, pToMs, ohlcTimestamps));
            previewTpLineXY = toCategoryXY(densifyHorizontalLine(pTpPrice, pFromMs, pToMs, ohlcTimestamps));
          }
        }

        // y 軸 range (candle + markers + position lines のみ。SMA50/band は除外)
        var allY = [];
        function pushIfFinite(v) {
          if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
        }
        ohlcBars.forEach(function (b) { pushIfFinite(b.high); pushIfFinite(b.low); });
        (sc.markers || []).forEach(function (m) { pushIfFinite(m.price); });
        extraYValues.forEach(function (v) { pushIfFinite(v); });
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

        // dataZoom 初期範囲。panel 構築ループ末尾で echarts.connect により全
        // panel 同期される (PR #242、tooltip popup だけは formatter 側で
        // 抑制)。filterMode は trend / position line の dropping 防止目的で
        // 'weakFilter' (個別銘柄タブと同方針)。
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
        var dzCommon = {
          labelFormatter: function (value) { return jstLabelForX(value); },
          filterMode: 'weakFilter',
        };
        var dzInside = { filterMode: 'weakFilter' };
        var dataZoomCfg = [
          Object.assign({ type: 'inside', xAxisIndex: 0 }, dzInside, dzInitial),
          Object.assign({ type: 'slider', xAxisIndex: 0, height: 18, bottom: 4, showDetail: false }, dzCommon, dzInitial),
        ];

        var chart = echarts.init(el);
        chart.setOption({
          animation: false,
          tooltip: {
            trigger: 'axis',
            axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
            // 個別銘柄タブと同形式: candle は OHLC 4 値を 1 行、line は seriesName +
            // value を行ごとに表示。densified path で重複する seriesName+value 行は
            // dedup する (#231 と同方針)。
            //
            // axisPointer は echarts.connect 経由で全 panel 同期するが、tooltip
            // popup は **hover 中の panel だけ** に出したい (PR #241 報告: 16
            // panel 全 popup でダッシュボードが埋め尽くされる問題)。なので
            // hoveredPanelId と elId が一致しない panel は formatter で空文字を
            // 返して popup 描画をスキップする。axisPointer 縦線は formatter と
            // 独立に描画されるので、空文字でも縦線は全 panel に出る。
            formatter: function (params) {
              if (window.__gridHoveredPanelId && window.__gridHoveredPanelId !== elId) return '';
              if (!Array.isArray(params) || params.length === 0) return '';
              var ts = params[0].axisValue;
              var lines = ['<div style="font-weight:600;font-size:11px">' + (sc.displayName || sc.symbol) + ' ' + jstLabelForX(ts) + '</div>'];
              var seenLine = Object.create(null);
              for (var i = 0; i < params.length; i += 1) {
                var p = params[i];
                if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                  var off = p.value.length >= 5 ? 1 : 0;
                  lines.push('<div style="font-size:11px">' + p.marker + ' OHLC ' +
                    Number(p.value[off]).toFixed(2) + ' / ' +
                    Number(p.value[off + 3]).toFixed(2) + ' / ' +
                    Number(p.value[off + 2]).toFixed(2) + ' / ' +
                    Number(p.value[off + 1]).toFixed(2) + '</div>');
                } else {
                  var v = Array.isArray(p.value) ? p.value[1] : p.value;
                  if (v == null) continue;
                  var vText = Number(v).toFixed(2);
                  var key = String(p.seriesName) + '|' + vText;
                  if (seenLine[key]) continue;
                  seenLine[key] = true;
                  lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName + ': ' + vText + '</div>');
                }
              }
              return lines.join('');
            },
          },
          legend: { show: false },
          // right を 60 に拡大して avg/stop/TP の endLabel (右端 'avg X' 等) を
          // 描画範囲に収める。bottom は slider 18px + padding 10 = 28 のまま。
          grid: { left: 40, right: 60, top: 8, bottom: 28 },
          dataZoom: dataZoomCfg,
          xAxis: useCategoryAxis ? {
            type: 'category', data: categories,
            axisLabel: { formatter: function (value) { return jstLabel(value); }, hideOverlap: true, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: false },
          } : {
            type: 'time',
            axisLabel: { formatter: function (value) { return jstLabel(value); }, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value', min: yMin, max: yMax,
            axisLabel: { showMinLabel: false, showMaxLabel: false, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: true, lineStyle: { opacity: 0.1 } },
          },
          series: [
            // 押し目ゾーン markArea (host series)。保有時は非表示。個別銘柄タブと同実装。
            ...((sc.position || !pullbackBandMarkArea) ? [] : [{
              name: '押し目ゾーン',
              type: 'line', data: [], symbol: 'none', z: 1,
              markArea: pullbackBandMarkArea,
            }]),
            // 押し目 sloped 上下端 (#238)。markArea の上に重ねて傾きを可視化。
            ...((sc.position || !pullbackBandMarkArea || !pullbackBandHasData) ? [] : [
              {
                name: '押し目上端', type: 'line', data: pullbackUpperXY,
                connectNulls: false,
                lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
                itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
                symbol: 'none', z: 2,
              },
              {
                name: '押し目下端', type: 'line', data: pullbackLowerXY,
                connectNulls: false,
                lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
                itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
                symbol: 'none', z: 2,
              },
            ]),
            ...(trendLineXY ? [{
              name: 'trend', type: 'line', data: trendLineXY,
              lineStyle: { width: 1.2, color: '#9333ea' }, symbol: 'none',
              itemStyle: { color: '#9333ea' }, z: 7,
            }] : []),
            ...(ohlcXY.length > 0 ? [{
              name: 'price', type: 'candlestick', data: ohlcXY,
              // barWidth は auto (15m 化で本数 4 倍、固定 px だと mini panel で潰れる)
              // 日本式配色: 赤=陽線 / 緑=陰線 (個別銘柄タブと揃える)
              itemStyle: {
                color: '#d23f31', color0: '#1e8e3e',
                borderColor: '#d23f31', borderColor0: '#1e8e3e', borderWidth: 1,
              },
              z: 5,
              markLine: sessionOpenIndices.length > 0 ? {
                symbol: 'none', silent: true, label: { show: false },
                lineStyle: { color: '#bbb', width: 1, type: 'dashed' }, z: 1,
                data: sessionOpenIndices.map(function (idx) { return { xAxis: idx }; }),
              } : undefined,
              // BUY/SELL pin の hover tooltip (qty / realized PnL / fill 時刻)。
              // 個別銘柄タブと同形 (symbolSize は panel に合わせて 18 のまま)。
              markPoint: entries.length + exits.length > 0 ? {
                symbol: 'pin', symbolSize: 18, data: entries.concat(exits),
                tooltip: {
                  trigger: 'item',
                  formatter: function (p) {
                    var d = p.data;
                    var pnl = d.realizedPnl == null
                      ? ''
                      : '<br/>realized PnL: ' + (d.realizedPnl >= 0 ? '+' : '') + d.realizedPnl.toFixed(2);
                    var qty = d.qty == null ? '' : '<br/>qty: ' + d.qty;
                    var ts = d.fillTimestamp == null ? '' : '<br/>fill: ' + jstLabel(d.fillTimestamp);
                    return d.name + ' @ ' + d.value.toFixed(2) + pnl + qty + ts;
                  },
                },
              } : undefined,
            }] : []),
            // SMA50: candle (z:5) より上、trend (z:7) と同じ層に置く。連続値で
            // null は break (gap) させる。色は TradingView 系の orange (#f59e0b)。
            {
              name: 'SMA50', type: 'line', data: smasXY,
              lineStyle: { width: 1.2, color: '#f59e0b' },
              symbol: 'none', connectNulls: true, z: 6,
              itemStyle: { color: '#f59e0b' },
            },
            ...(avgLineXY ? [{
              name: 'avg', type: 'line', data: avgLineXY,
              lineStyle: { width: 1, color: '#444' }, symbol: 'none',
              itemStyle: { color: '#444' },
              endLabel: { show: true, formatter: 'avg', color: '#444', fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            ...(stopLineXY ? [{
              name: 'stop', type: 'line', data: stopLineXY,
              lineStyle: { width: 1, color: '#c22', type: 'dashed' }, symbol: 'none',
              itemStyle: { color: '#c22' },
              endLabel: { show: true, formatter: 'stop', color: '#c22', fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            ...(tpLineXY ? [{
              name: 'tp', type: 'line', data: tpLineXY,
              lineStyle: { width: 1, color: '#057a55', type: 'dashed' }, symbol: 'none',
              itemStyle: { color: '#057a55' },
              endLabel: { show: true, formatter: 'tp', color: '#057a55', fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            // preview stop / TP (保有ナシで current price ベースの仮置き)。
            // dotted + opacity 0.5 で actual position lines と区別。
            ...(previewStopLineXY ? [{
              name: 'preview stop', type: 'line', data: previewStopLineXY,
              lineStyle: { width: 1, color: '#c22', type: 'dotted', opacity: 0.5 }, symbol: 'none',
              itemStyle: { color: '#c22' },
              endLabel: { show: true, formatter: 'p.stop', color: '#c22', opacity: 0.7, fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 7,
            }] : []),
            ...(previewTpLineXY ? [{
              name: 'preview tp', type: 'line', data: previewTpLineXY,
              lineStyle: { width: 1, color: '#057a55', type: 'dotted', opacity: 0.5 }, symbol: 'none',
              itemStyle: { color: '#057a55' },
              endLabel: { show: true, formatter: 'p.tp', color: '#057a55', opacity: 0.7, fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 7,
            }] : []),
          ],
        });
        return { elId: elId, chart: chart, useCategoryAxis: useCategoryAxis, nearestIndex: nearestIndex, categories: categories, ohlcMs: ohlcMs };
      }

      // 各 panel を build。null (load 失敗) は skip。
      var panels = [];
      for (var i = 0; i < data.charts.length; i += 1) {
        var entry = data.charts[i];
        var built = buildPanel('grid-chart-' + i, entry.chart);
        if (built) panels.push(built);
      }
      // echarts.connect で dataZoom + axisPointer (縦線) + legend を全 panel
      // 同期する (PR #237/#241 の経緯参照):
      //   - PR #237 で connect 採用 → tooltip popup まで全 panel 同期されてしまい、
      //     16 panel hover で popup の山に (ユーザ #43 報告)。
      //   - PR #241 で connect 撤去、dataZoom のみ手動 broadcast に変更。だが
      //     「縦線 (axisPointer) の同期は欲しかった」というフィードバックを受け、
      //     本 PR (#242) で connect を復活。
      //   - tooltip popup だけ panel ローカルにするため、tooltip.formatter 側で
      //     window.__gridHoveredPanelId !== elId なら空文字を返して描画スキップ
      //     (formatter 内のコメント参照)。axisPointer 縦線は formatter 結果と
      //     独立に描画されるので、空文字でも縦線は出る。
      //
      // panel DOM の mouseenter/leave で window.__gridHoveredPanelId を更新する
      // (DOMContentLoaded 開始時に null で初期化)。
      var instances = panels.map(function (p) { return p.chart; });
      if (instances.length > 0) echarts.connect(instances);

      window.__gridHoveredPanelId = null;
      panels.forEach(function (panel) {
        var dom = panel.chart.getDom();
        if (!dom) return;
        // mouseenter は子要素遷移で再発火しないので panel 単位の追跡に最適。
        dom.addEventListener('mouseenter', function () {
          window.__gridHoveredPanelId = panel.elId;
        });
        dom.addEventListener('mouseleave', function () {
          if (window.__gridHoveredPanelId === panel.elId) {
            window.__gridHoveredPanelId = null;
          }
        });
      });

      // resize 時は全 panel を resize (responsive)
      window.addEventListener('resize', function () {
        for (var i = 0; i < instances.length; i += 1) instances[i].resize();
      });

      // dataZoom event 1 つを listen して URL ?from / ?to を更新。connect 経由
      // で全 panel が同期発火するので panel[0] からだけ読み出せば十分 (debounce
      // 200ms で zoom drag 中の連続発火をまとめる)。
      function panelDataZoomToMs(panel) {
        var opt = panel.chart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return null;
        var sv = dz.startValue, ev = dz.endValue;
        if (sv == null || ev == null) return null;
        if (panel.useCategoryAxis) {
          var sIdx = Math.max(0, Math.min(panel.categories.length - 1, Math.round(sv)));
          var eIdx = Math.max(0, Math.min(panel.categories.length - 1, Math.round(ev)));
          var fromMs = new Date(panel.categories[sIdx]).getTime();
          var toMs = new Date(panel.categories[eIdx]).getTime();
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
          return { fromMs: fromMs, toMs: toMs };
        }
        return { fromMs: sv, toMs: ev };
      }
      var dzTimer = null;
      function onDz() {
        if (dzTimer) clearTimeout(dzTimer);
        dzTimer = setTimeout(function () {
          if (panels.length === 0) return;
          var range = panelDataZoomToMs(panels[0]);
          if (!range) return;
          try {
            var fromIso = new Date(range.fromMs).toISOString();
            var toIso = new Date(range.toMs).toISOString();
            var url = new URL(window.location.href);
            url.searchParams.set('from', fromIso);
            url.searchParams.set('to', toIso);
            window.history.replaceState({}, '', url.toString());
          } catch (e) { /* noop */ }
        }, 200);
      }
      for (var pi2 = 0; pi2 < panels.length; pi2 += 1) {
        panels[pi2].chart.on('dataZoom', onDz);
      }

      // preset zoom buttons (1D/5D/1M/All): 全 panel に dispatchAction で
      // 共通 ms 範囲を broadcast。category mode panel では nearestIndex で
      // index に snap してから dispatch (panel 個別)。connect でも同期するが、
      // panel 毎に category 軸の index が異なるので明示 dispatch が確実。
      var presetButtons = document.querySelectorAll('.zoom-preset');
      for (var pj = 0; pj < presetButtons.length; pj += 1) {
        presetButtons[pj].addEventListener('click', function (ev) {
          var fromMs = Number(ev.currentTarget.getAttribute('data-from-ms'));
          var toMs = Number(ev.currentTarget.getAttribute('data-to-ms'));
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
          for (var pk = 0; pk < panels.length; pk += 1) {
            var p = panels[pk];
            var sv, eV;
            if (p.useCategoryAxis) {
              sv = p.nearestIndex(fromMs);
              eV = p.nearestIndex(toMs);
              if (sv < 0 || eV < 0) continue;
              if (sv > eV) { var tmp = sv; sv = eV; eV = tmp; }
            } else {
              sv = fromMs; eV = toMs;
            }
            p.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
            p.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: sv, endValue: eV });
          }
        });
      }
    });
  `

  return `<p class="muted" style="font-size:12px">
    ALLOWED_SYMBOLS の全銘柄を 4 列 grid で並列表示 (Datadog dashboard 風)。
    ズーム / パン (slider drag, wheel) と axisPointer 縦線は全 panel 間で同期、
    tooltip popup は hover した panel ローカル。panel 左上の銘柄名をクリックする
    と個別銘柄タブの詳細表示に遷移。
  </p>
  ${presetButtonsHtml}
  <div class="grid-filter-bar" style="display:flex;gap:14px;align-items:center;margin-top:8px;font-size:12px;flex-wrap:wrap">
    <span class="muted">表示:</span>
    <label style="cursor:pointer"><input type="checkbox" id="grid-filter-position" checked> 保有あり</label>
    <label style="cursor:pointer"><input type="checkbox" id="grid-filter-flat" checked> 未保有</label>
    <label style="cursor:pointer"><input type="checkbox" id="grid-filter-inactive"> INACTIVE</label>
    <span class="muted" id="grid-filter-count" style="margin-left:auto"></span>
  </div>
  <div class="symbols-grid" style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px;margin-top:12px">
    ${panelsHtml}
  </div>
  <style>
    @media (max-width: 1280px) {
      .symbols-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    }
    @media (max-width: 768px) {
      .symbols-grid { grid-template-columns: 1fr !important; }
    }
  </style>
  ${safeJsonScript('__chartData', payload)}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>
  <script>${filterScript}</script>`
}

/**
 * grid panel filter (保有あり / 未保有 / INACTIVE)。echarts init 後に
 * DOMContentLoaded で発火するよう <script> を initScript より後ろに置く。
 * state は localStorage の `dashboard.gridFilter.v1` に保存。
 *
 * panel の表示/非表示は display:none の toggle のみ。echarts instance は
 * init 済 (= サイズ確定済) なので再表示時に resize 不要。
 */
export const filterScript = `
  document.addEventListener('DOMContentLoaded', function () {
    var KEY = 'dashboard.gridFilter.v1';
    var DEFAULT = { position: true, flat: true, inactive: false };
    var state = DEFAULT;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          state = {
            position: parsed.position !== false,
            flat: parsed.flat !== false,
            inactive: parsed.inactive === true,
          };
        }
      }
    } catch (_e) {}

    var cbPosition = document.getElementById('grid-filter-position');
    var cbFlat = document.getElementById('grid-filter-flat');
    var cbInactive = document.getElementById('grid-filter-inactive');
    var counter = document.getElementById('grid-filter-count');
    if (!cbPosition || !cbFlat || !cbInactive) return;
    cbPosition.checked = state.position;
    cbFlat.checked = state.flat;
    cbInactive.checked = state.inactive;

    function apply() {
      var panels = document.querySelectorAll('.symbols-grid .grid-panel');
      var shown = 0;
      // 「今回 visible に切り替わった panel」を resize 対象として記録。echarts は
      // display:none の DOM に init すると 0×0 で残り、後から display:'' にしても
      // 自動 resize しないため、手動で resize() を叩く必要がある (CodeRabbit #237)。
      // 対象を「visible に *なった* panel」だけに絞ってウィンドウ resize 全件再
      // レイアウトのコストを避ける。
      var newlyShown = [];
      for (var i = 0; i < panels.length; i++) {
        var p = panels[i];
        var hasPos = p.getAttribute('data-has-position') === '1';
        var inact = p.getAttribute('data-inactive') === '1';
        // INACTIVE は最優先 (inactive チェックが OFF なら問答無用で隠す)
        var visible;
        if (inact) {
          visible = state.inactive;
        } else if (hasPos) {
          visible = state.position;
        } else {
          visible = state.flat;
        }
        var wasHidden = p.style.display === 'none';
        p.style.display = visible ? '' : 'none';
        if (visible) {
          shown++;
          if (wasHidden) newlyShown.push(p);
        }
      }
      if (counter) counter.textContent = shown + ' / ' + panels.length + ' 銘柄表示';
      // panel が再表示されたら、内部の echarts instance を resize して
      // 0×0 サイズや stale viewport size のままにならないようにする。
      // window resize されてた間に hidden だった panel も含めて safe。
      if (newlyShown.length > 0 && typeof echarts !== 'undefined') {
        for (var j = 0; j < newlyShown.length; j++) {
          var chartDiv = newlyShown[j].querySelector('[id^="grid-chart-"]');
          if (!chartDiv) continue;
          var inst = echarts.getInstanceByDom(chartDiv);
          if (inst) inst.resize();
        }
      }
    }

    function onChange() {
      state = { position: cbPosition.checked, flat: cbFlat.checked, inactive: cbInactive.checked };
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_e) {}
      apply();
    }
    cbPosition.addEventListener('change', onChange);
    cbFlat.addEventListener('change', onChange);
    cbInactive.addEventListener('change', onChange);
    apply();
  });
`

/**
 * grid panel header の右肩に出す軽量 indicators badge (price / SMA50)。
 * 個別銘柄タブの `renderCurrentIndicatorsBadge` の縮小版。
 * 「市場全体ビュー」で trader が「現在価格と SMA50 の位置関係」を一目で
 * 判断するための最小限情報。high20d / low20d / atr は省略 (panel 幅優先)。
 */
export function renderGridPanelBadge(chart: SymbolChartData): string {
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  if (!latest) return ''
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  return `<span style="font-size:11px;white-space:nowrap">
    <span class="muted">px:</span> <strong>${esc(fmt(latest.price))}</strong>
    <span class="muted" style="margin-left:6px">SMA50:</span> ${esc(fmt(latest.sma50))}
  </span>`
}
