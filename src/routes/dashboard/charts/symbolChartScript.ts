/**
 * Client-side init script for the symbol chart tab (`renderSymbolTab`),
 * served statically at `GET /dashboard/static/symbol-chart.js` (cacheable,
 * unlike an inline `<script>` re-sent on every symbol switch).
 *
 * Reads chart data only from `#__chartData`'s `textContent` (never
 * `window.__chartData`), because after a client-side symbol switch replaces
 * `#symbol-main`'s innerHTML, a `<script>` inserted that way would not
 * execute — reading the inert JSON script via DOM keeps both the initial
 * page load and a post-swap re-init working the same way.
 *
 * Kept as a plain exported string (no separate build step) to match the POC
 * policy of not adding a bundler. This file has no `${...}` interpolation.
 * Changing the DOM ids/classes it queries (`#symbol-chart`,
 * `#decision-trace-panel`, `.zoom-preset`, `#symbol-main`, `.symbol-rail`,
 * `.symbol-subnav`) requires updating `symbol.ts` in lockstep.
 */
export const SYMBOL_CHART_CLIENT_SCRIPT = `
(function () {
  // Shared across initSymbolChart() re-runs (symbol switch) rather than
  // adding a resize listener per call, which would pile up closures over
  // disposed chart instances.
  var symChart = null;
  window.addEventListener('resize', function () { if (symChart) symChart.resize(); });

  function initSymbolChart() {
      if (typeof echarts === 'undefined') return;
      var chartEl = document.getElementById('symbol-chart');
      // getInstanceByDom (not just the symChart variable) so a stale
      // instance is still disposed if a prior init threw before symChart
      // was assigned.
      if (chartEl) {
        var prevInstance = echarts.getInstanceByDom(chartEl);
        if (prevInstance) prevInstance.dispose();
      }
      symChart = null;
      var chartDataEl = document.getElementById('__chartData');
      var data = chartDataEl ? JSON.parse(chartDataEl.textContent || 'null') : null;
      var sc = data && data.symbolChart;
      if (!chartEl || !sc || sc.points.length === 0) return;

      // Category axis (index-based x, categories = each bar's ISO timestamp)
      // when intradayBars exist: ECharts' time axis has no native way to
      // skip non-trading hours, so category axis is used to collapse
      // overnight/weekend/holiday gaps (TradingView-style). Falls back to a
      // time axis when intradayBars is empty (Yahoo intraday fetch failed).
      var ohlcBars = sc.intradayBars || [];
      var useCategoryAxis = ohlcBars.length > 0;
      var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
      var categories = ohlcBars.map(function (b) { return b.timestamp; });

      // Session-open detection: collapsing gaps onto a category axis makes
      // session boundaries visually ambiguous, so a >=90min jump between
      // adjacent 15m bars (normally ~15min apart) is flagged as a new
      // session open and drawn as a markLine. Skipped in time-axis fallback.
      var sessionOpenIndices = [];
      if (useCategoryAxis) {
        var SESSION_GAP_MS = 90 * 60 * 1000;
        for (var si = 1; si < ohlcMs.length; si++) {
          if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
        }
      }

      // Binary search over ohlcMs (assumed ascending, Yahoo's native order)
      // for the nearest category index; -1 when ohlcMs is empty (time-axis fallback).
      function nearestIndex(ms) {
        if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
        var lo = 0, hi = ohlcMs.length - 1;
        if (ms <= ohlcMs[0]) return 0;
        if (ms >= ohlcMs[hi]) return hi;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
        }
        // lo is the first index >= ms; pick whichever neighbor is closer.
        if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
        return lo;
      }

      // Abstracts the two axis modes to the same (x, y) shape: category
      // index in category mode, ISO timestamp (the category value itself) in time mode.
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
      // Second precision reserved for fill timestamps (distinguishing
      // same-minute fills); axisLabel stays minute precision to avoid crowding.
      var jstFmtSec = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      function jstLabelSec(value) {
        return jstFmtSec.format(new Date(value)).replace(/\\//g, '/');
      }
      function jstLabelForX(value) {
        if (useCategoryAxis) {
          // ECharts callers pass either an index (number) or the category's
          // ISO string, depending on call site.
          if (typeof value === 'number') {
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }
        return jstLabel(value);
      }

      // Category mode: candle data is index-based, [open, close, low, high]
      // (ECharts pairs it with the categories array). Time mode adds the
      // timestamp: [timestamp, open, close, low, high].
      var ohlcXY = useCategoryAxis
        ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
        : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });
      var smasXY = sc.points.map(function (p) {
        if (p.sma50 == null) return [xForTimestamp(p.timestamp), null];
        return [xForTimestamp(p.timestamp), p.sma50];
      });

      // Pullback zone: upper = high20d * (1 + pullbackMax) (resistance-ish),
      // lower = high20d * (1 + pullbackMin) (too-deep cutoff).
      var pullbackMaxMul = 1 + sc.rules.pullbackMax;
      var pullbackMinMul = 1 + sc.rules.pullbackMin;
      // Drawn as both a flat markArea fill (latest high20d) and two sloped
      // per-timestamp dashed lines: a flat band alone reads wrong for
      // symbols where high20d trends strongly (e.g. SOXL), since the band's
      // actual daily movement diverges from the flat fill.
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

      // null (not omitted) for a missing high20d, so echarts breaks the
      // segment there (paired with connectNulls: false below).
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

      function bandEdgeLabel(name, edgeY) {
        if (!Number.isFinite(edgeY) || sc.latestCronPrice == null || !(sc.latestCronPrice > 0)) return name;
        var mv = (edgeY - sc.latestCronPrice) / sc.latestCronPrice;
        return name + ' あと ' + (mv >= 0 ? '+' : '') + (mv * 100).toFixed(1) + '% ($' + edgeY.toFixed(2) + ')';
      }
      var pullbackUpperLabel = bandEdgeLabel('押し目上端', bandUpperY);
      var pullbackLowerLabel = bandEdgeLabel('押し目下端', bandLowerY);

      // densifyTrendLine expands the trend line's 2 endpoints into a dense
      // path (one point per intradayBars timestamp, linearly interpolated,
      // extrapolated past both endpoints) instead of passing a 2-point line
      // series. ECharts drops a 2-point line entirely once either endpoint
      // scrolls outside the dataZoom range (a known upstream issue); a dense
      // path keeps multiple points visible at any zoom level regardless of
      // filterMode. Falls back to the raw 2-point line when intradayBars is
      // empty (Yahoo fetch failed).
      // Mirrors the server-side densifyTrendLine export algorithm exactly
      // — that copy is what's unit-tested; this one only exists inline
      // because it consumes sc.* already embedded in the page.
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

      var buys = sc.markers.filter(function (m) { return m.side === 'BUY'; });
      var sells = sc.markers.filter(function (m) { return m.side === 'SELL'; });
      var latestFillTs = sc.markers.length > 0
        ? sc.markers[sc.markers.length - 1].timestamp
        : null;
      // Only the single most recent fill's pin gets a visible price label;
      // older fills render marker-only. Labeling BUY and SELL independently
      // (each showing their own latest) made an adjacent BUY/SELL pair
      // overlap, so only the overall-latest "last action" is labeled — full
      // detail for older fills is still available via hover tooltip.
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

      // Colors mirror the trade-quality tab's DECISION_COLORS.
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

      // An open (not yet closed) position is never included in
      // holdingSpans by the server — shading it through to the right edge
      // would misread as "closed here", so avg/stop/TP lines cover that case instead.
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

      // Same dense-path workaround as densifyTrendLine, applied to a
      // horizontal avg/stop/TP line drawn only from openedAt to the latest
      // point (not the full chart width, which would misread as "avg since
      // forever"). Mirrors the server-side densifyHorizontalLine export,
      // which is what's unit-tested.
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
      // Preview stop/TP (no position held) use latestCronPrice, not the last
      // chart point — the last point can be a Yahoo daily filler (cron
      // paused / stale symbol), which would show a stale close as if it
      // were the current strategy-evaluated price.
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
        // Clamped to openedAt (not left to go negative): a fresh position
        // opened after the latest recorded point would otherwise draw the
        // line backwards.
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
        // Ends at latestCronTimestamp, not the chart's last point: extending
        // into the Yahoo-filler tail past the last cron eval would draw a
        // line inconsistent with virtualAvg.
        var pFromMs = new Date(sc.points[0].timestamp).getTime();
        var pToMs = new Date(sc.latestCronTimestamp).getTime();
        if (Number.isFinite(pFromMs) && Number.isFinite(pToMs)) {
          previewStopLineXY = toCategoryXY(densifyHorizontalLine(pStopPrice, pFromMs, pToMs, ohlcTimestamps));
          previewTpLineXY = toCategoryXY(densifyHorizontalLine(pTpPrice, pFromMs, pToMs, ohlcTimestamps));
          previewStopLabel = 'stop ' + pStopPrice.toFixed(2) + ' (preview)';
          previewTpLabel = 'TP ' + pTpPrice.toFixed(2) + ' (preview)';
        }
      }

      // Extrapolation of recent pace into future category slots — not a
      // prediction, hence dotted + labeled "参考" (reference only). Only
      // drawn in category-axis mode; server sends projection=null when
      // entryPrice can't be determined (price-independent gate blocking).
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
        var span = barsPerDay > 1 ? (lastBarMs - ohlcMs[ohlcMs.length - barsPerDay]) / (barsPerDay - 1) : 3600000;
        if (!Number.isFinite(span) || span <= 0) span = 3600000;
        // Future bars kept minimal (crossing: clamped to 1-5 business days;
        // no crossing: just enough to read the slope) — each future slot
        // occupies axis space and compresses the historical candles.
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
        // Crossing-point pin only within the drawn range.
        if (proj.crossingSteps != null && proj.entryPrice != null) {
          var crossBars = Math.round(proj.crossingSteps * barsPerDay);
          if (crossBars >= 0 && crossBars <= drawBars) {
            projCrossPoint = { coord: [startIdx + crossBars, proj.entryPrice], value: proj.entryPrice };
          }
        }
        projZoomEndIndex = endIdx;
      })();

      // Explicit yAxis min/max: ECharts' scale:true excludes markLine from
      // the axis range, so a TP/stop outside the data range would render
      // off-canvas otherwise. pushIfFinite guards against NaN/Infinity
      // reaching Math.min/max, which breaks the whole axis.
      var allY = [];
      function pushIfFinite(v) {
        if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
      }
      // Range decided from candle high/low + markers + position lines only.
      // SMA50 / band / low20d / trend line are still drawn (and auto-clipped
      // at the axis edge) but excluded here — including them stretches the
      // range and compresses the candles.
      (sc.intradayBars || []).forEach(function (b) {
        pushIfFinite(b.high);
        pushIfFinite(b.low);
      });
      sc.markers.forEach(function (m) { pushIfFinite(m.price); });
      extraYValues.forEach(function (v) { pushIfFinite(v); });
      pushIfFinite(data.prevClose);
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

      // Initial zoom range from ?from/?to (data.zoomFromMs/zoomToMs), snapped
      // to the nearest category index in category mode. dataZoom listener
      // below writes it back to the URL via replaceState, so it survives a symbol switch.
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
      // Widens the initial right edge to include the projection's future
      // slots (history + extrapolation both visible without an extra zoom-out).
      if (projZoomEndIndex != null && useCategoryAxis && dzInitial.endValue != null) {
        dzInitial.endValue = Math.min(projZoomEndIndex, categories.length - 1);
      }
      // filterMode: 'weakFilter' (not the default 'filter') only drops a
      // multi-point series (line/markLine) when every point in it falls
      // outside the zoom range — 'filter' drops per-point, which breaks a
      // 2-endpoint line the moment either endpoint scrolls off-range.
      // Slider and wheel/pinch zoom are disabled: range control is the 1D/5D/1M/All
      // preset pills only. The inside dataZoom stays as the pills' dispatch target.
      var dataZoomCfg = [
        Object.assign({
          type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter',
          zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false,
          zoomLock: false,
        }, dzInitial),
      ];

      symChart = echarts.init(chartEl);
      symChart.setOption({
        tooltip: {
          trigger: 'axis',
          axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
          // Overrides the default UTC axis-value header with a JST formatter.
          formatter: function (params) {
            if (!Array.isArray(params) || params.length === 0) return '';
            var ts = params[0].axisValue;
            var lines = ['<div style="font-weight:600;font-size:11px">' + jstLabelForX(ts) + '</div>'];
            // The densified line series (one point per intradayBars
            // timestamp) puts many same-seriesName-same-value points near
            // one axis index, which trigger:'axis' would otherwise repeat
            // as duplicate tooltip rows — dedup by seriesName + formatted value.
            var seenLine = Object.create(null);
            for (var i = 0; i < params.length; i += 1) {
              var p = params[i];
              if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                // p.value is [O, C, L, H] at length 4, or [x, O, C, L, H] at length >= 5.
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
        grid: { left: 50, right: 20, top: 56, bottom: 28, containLabel: true },
        dataZoom: dataZoomCfg,
        // Category axis (equal spacing per bar) collapses non-trading gaps
        // so e.g. Friday close sits adjacent to Monday open — reads as an
        // even step, trading that off against the alternative of a
        // time-proportional axis with large dead gaps.
        xAxis: useCategoryAxis ? {
          type: 'category',
          data: categories,
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
          // Empty-data line series exists only as a named host for the
          // markArea (ECharts markArea has no series type of its own).
          ...(holdingAreaData.length > 0 ? [{
            name: '保有区間 (確定)', type: 'line', data: [],
            symbol: 'none', silent: true, z: 0,
            itemStyle: { color: 'rgba(120, 120, 128, 0.4)' },
            markArea: { silent: true, data: holdingAreaData },
          }] : []),
          // Hidden while holding a position (avg/stop/TP take visual priority instead).
          ...((sc.position || !pullbackBandMarkArea) ? [] : [
            {
              name: '押し目ゾーン',
              type: 'line', data: [],
              symbol: 'none', z: 1,
              markArea: pullbackBandMarkArea,
            },
          ]),
          ...((sc.position || !pullbackBandMarkArea || !pullbackBandHasData) ? [] : [
            {
              name: '押し目上端',
              type: 'line', data: pullbackUpperXY,
              connectNulls: false,
              lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
              itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
              symbol: 'none', z: 2,
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
          ...(trendLineXY ? [{
            name: '価格トレンド (linear regression, 30日)', type: 'line', data: trendLineXY,
            lineStyle: { width: 1.8, color: '#9333ea', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#9333ea' }, z: 7,
          }] : []),
          // Japan-style coloring: red = up (close >= open), green = down —
          // opposite of the US convention.
          ...(ohlcXY.length > 0 ? [{
            name: 'price (15m OHLC)', type: 'candlestick', data: ohlcXY,
            itemStyle: {
              color: '#d23f31',
              color0: '#1e8e3e',
              borderColor: '#d23f31',
              borderColor0: '#1e8e3e',
              borderWidth: 1.5,
            },
            z: 5,
            // Session-open boundaries use markLine (not the densified line
            // series avg/stop/TP use below) because a vertical markLine
            // spans the full y-range natively and stays visible outside the
            // zoom range, unlike a 2-point sloped markLine.
            markLine: (function () {
              var mlData = sessionOpenIndices.map(function (idx) {
                return { xAxis: idx };
              });
              // Attached to the candle series' markLine rather than its own
              // series, to avoid adding a legend entry.
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
          {
            name: 'SMA50', type: 'line', data: smasXY,
            lineStyle: { width: 1.4, color: '#f59e0b', type: 'solid' },
            symbol: 'none', connectNulls: true, z: 6,
          },
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
          // dotted + opacity 0.5 distinguishes these from an actual position's lines.
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
          // Larger symbol for REJECT/ERROR (broker rejection / failure) to make them stand out.
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

      // ladderHtml is pre-rendered, pre-escaped markup from the server
      // (renderDecisionLadder) — inserted directly, not re-rendered here.
      var tracePanel = document.getElementById('decision-trace-panel');
      function showDecisionTrace(d) {
        if (!tracePanel || !d) return;
        tracePanel.innerHTML = d.ladderHtml || '';
        tracePanel.style.display = 'block';
      }
      // Values are DB-sourced, so escHtml everywhere; clientOrderId also
      // goes through encodeURIComponent (which escapes quotes too, so it's
      // safe in an href attribute).
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
        tracePanel.style.display = 'block';
      }
      symChart.on('click', function (p) {
        if (p && p.seriesName === '判定' && p.data && p.data.ladderHtml != null) {
          showDecisionTrace(p.data);
          if (tracePanel) tracePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else if (p && p.componentType === 'markPoint' && p.data && p.data.fillTimestamp != null) {
          // fillTimestamp distinguishes a fill pin from the projection's
          // "reference reached" pin, which has no fillTimestamp.
          showFillDetail(p.data);
          if (tracePanel) tracePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });

      // Recomputes the y-axis to fit only what's visible after a zoom
      // change, instead of the full data range — otherwise zooming in
      // leaves large empty vertical margins.
      function recomputeYAxis() {
        var opt = symChart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return;
        var startVal = dz.startValue;
        var endVal = dz.endValue;
        if (startVal == null || endVal == null) return;
        function inRangeMs(ms) {
          if (!Number.isFinite(ms)) return false;
          if (useCategoryAxis) {
            var idx = nearestIndex(ms);
            return idx >= startVal && idx <= endVal;
          }
          return ms >= startVal && ms <= endVal;
        }
        function inRangeIdx(idx) {
          if (useCategoryAxis) return idx >= startVal && idx <= endVal;
          return true; // unused in time mode — the intradayBars loop below uses inRangeMs instead
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
        // SMA50 is included in the y-range only when it's near the visible
        // candle range (within 25%) — a symbol with a wide SMA50/price
        // divergence (e.g. a 3x ETF mid-rally) would otherwise stretch the
        // axis and compress the candles unreadably. Out-of-band SMA50 still
        // draws (clipped), and its value is always visible in the price header.
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
        // Samples the trend line's y at the visible range's clipped
        // endpoints (interpolating from its two pivots), so the line stays
        // in the y-range even when both its own endpoints are off-screen.
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
          // Not included when latestCronPrice is null: the preview lines
          // themselves aren't drawn in that case, so including them here
          // would stretch the axis for nothing.
          var pVirtualAvg = sc.latestCronPrice;
          pushIfFinite(pVirtualAvg * (1 + sc.rules.stopPct));
          pushIfFinite(pVirtualAvg * (1 + sc.rules.takeProfitPct));
        }
        // Only the upper band edge (carries the distance-to-entry label) is
        // included — the lower edge is left out to avoid over-widening the axis.
        if (Number.isFinite(bandUpperY)) pushIfFinite(bandUpperY);
        if (projEndPrice != null) pushIfFinite(projEndPrice);
        if (visibleY.length === 0) return;
        var rawMin = Math.min.apply(null, visibleY);
        var rawMax = Math.max.apply(null, visibleY);
        if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return;
        var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
        symChart.setOption({ yAxis: { min: rawMin - pad, max: rawMax + pad } });
      }
      recomputeYAxis();

      // Debounced 200ms to avoid URL churn while dragging/zooming continuously.
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
            // Server-rendered rail/subnav links still carry the stale
            // from/to they were rendered with — rewrite them so a symbol
            // switch doesn't reset the zoom.
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

      // dispatchAction below re-triggers the dataZoom listener above, which
      // also updates the URL — no separate URL-sync call needed here.
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
          for (var pj = 0; pj < presetButtons.length; pj += 1) presetButtons[pj].classList.remove('active');
          ev.currentTarget.classList.add('active');
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
        });
      }
  }

  document.addEventListener('DOMContentLoaded', initSymbolChart);

  // Client-side partial swap for symbol switching: intercepts same-origin
  // ?tab=symbol clicks on .symbol-rail / .symbol-subnav only, leaving
  // everything else (other pages, modifier-key clicks, other origins) to
  // normal browser navigation.

  // The rail itself lives outside #symbol-main (the swap target), so its
  // HTML never gets replaced — only the active class is toggled to follow
  // the swapped-in symbol.
  function updateRailActiveSymbol(symbol) {
    var items = document.querySelectorAll('.symbol-rail .rail-item');
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var symEl = item.querySelector('.rail-sym');
      var isActive = !!symbol && !!symEl && symEl.textContent === symbol;
      if (isActive) item.classList.add('active'); else item.classList.remove('active');
    }
  }

  // Fetch failure, non-200, or timeout falls back to a normal full-page
  // navigation rather than leaving the page half-swapped.
  function navigateSymbolPartial(url, pushHistory) {
    var main = document.getElementById('symbol-main');
    if (!main) { window.location.href = url.toString(); return; }
    var fetchUrl = new URL(url.toString());
    fetchUrl.searchParams.set('partial', '1');
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 8000);
    main.classList.add('symbol-main-loading');
    fetch(fetchUrl.toString(), {
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('partial fetch failed: ' + res.status);
      return res.text();
    }).then(function (html) {
      main.innerHTML = html;
      main.classList.remove('symbol-main-loading');
      if (pushHistory) window.history.pushState({}, '', url.toString());
      updateRailActiveSymbol(url.searchParams.get('symbol'));
      initSymbolChart();
    }).catch(function () {
      clearTimeout(timer);
      window.location.href = url.toString();
    });
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    // Leaves modifier-key clicks (open in new tab/window) to the browser.
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var target = ev.target;
    var a = target && target.closest ? target.closest('a') : null;
    if (!a) return;
    if (!(a.closest('.symbol-rail') || a.closest('.symbol-subnav'))) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;
    var href = a.getAttribute('href');
    if (!href) return;
    var url;
    try { url = new URL(href, window.location.href); } catch (e) { return; }
    if (url.origin !== window.location.origin) return;
    if (url.searchParams.get('tab') !== 'symbol') return;
    ev.preventDefault();
    navigateSymbolPartial(url, true);
  });

  // This listener only runs while the symbol tab is active, so a back/forward
  // navigation to a non-symbol tab (window.location is already the new URL)
  // is handled by a full reload rather than the SPA swap.
  window.addEventListener('popstate', function () {
    var url = new URL(window.location.href);
    if (url.searchParams.get('tab') !== 'symbol') {
      window.location.reload();
      return;
    }
    navigateSymbolPartial(url, false);
  });
})();
`

/** Not tamper-resistant, only used as an ETag — chosen over `crypto.subtle.digest` because it can run synchronously at module load. */
function computeFnv1aHex(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** ETag for `GET /dashboard/static/symbol-chart.js`, used for `If-None-Match` / 304. */
export const SYMBOL_CHART_CLIENT_SCRIPT_ETAG = `"${computeFnv1aHex(SYMBOL_CHART_CLIENT_SCRIPT)}-${SYMBOL_CHART_CLIENT_SCRIPT.length}"`
