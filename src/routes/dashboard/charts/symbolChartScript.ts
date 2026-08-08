/**
 * 銘柄チャートタブ (`renderSymbolTab`) の client 側初期化スクリプト実体。
 *
 * 元は `symbol.ts` の `renderSymbolTab` 内にインライン `<script>` として
 * 約1200行 (≈70KB) 埋め込まれていた。銘柄切替のたびに同一内容の巨大
 * インラインスクリプトを HTML に再送していたため、静的ファイル化して
 * `GET /dashboard/static/symbol-chart.js` として配信し、ブラウザキャッシュ
 * (`Cache-Control: public, max-age=86400` + ETag) を効かせる (#charts-symbol-redesign)。
 *
 * データは `#__chartData` (別 `<script type="application/json">` で per-request
 * に埋め込む JSON) からのみ読む — `JSON.parse(el.textContent)` で毎回 DOM から
 * 読み直す (`window.__chartData` 代入には依存しない)。クライアント側銘柄切替
 * (#charts-symbol-redesign Phase C、`#symbol-main` の innerHTML を partial
 * fetch で丸ごと差し替える) の後も同じ読み方で動くようにするため:
 * innerHTML 経由で挿入した通常の `<script>` は実行系であっても実行されない
 * ブラウザ仕様があるが、`type="application/json"` の inert script は元々
 * 実行されない前提なので innerHTML 差し替えでも挙動が変わらない。
 * このファイル自体に `${...}` テンプレート補間は無い (build 前に grep 済み)。
 * ビルドステップを増やさない POC 方針を維持するため、実体は TypeScript の
 * export された定数文字列のままにしている。内容を変更する場合は `symbol.ts`
 * 側の DOM 構造 (`#symbol-chart` / `#decision-trace-panel` / `.zoom-preset` /
 * `#symbol-main` / `.symbol-rail` / `.symbol-subnav` 等) との整合を確認すること。
 *
 * 銘柄切替 (#charts-symbol-redesign Phase C): チャート初期化本体を
 * `initSymbolChart()` として再実行可能にし、`.symbol-rail` / `.symbol-subnav`
 * のクリックを intercept して `?partial=1` で `#symbol-main` の innerHTML だけ
 * fetch → 差し替え → `initSymbolChart()` 再実行、という SPA 風遷移にする。
 * fetch 失敗 / non-200 / timeout は fail-open で通常のフルページ遷移に
 * フォールバックする。
 */
export const SYMBOL_CHART_CLIENT_SCRIPT = `
(function () {
  // ECharts インスタンスは module scope で共有する。銘柄切替のたびに
  // initSymbolChart() を再実行するので、window resize listener を都度
  // 追加すると disposed instance を握った古い closure が積み上がってしまう
  // (呼ぶたびに console error 兼無駄な処理が増える)。1 回だけ登録し、
  // この変数越しに常に「今の」インスタンスへ resize を届ける。
  var symChart = null;
  window.addEventListener('resize', function () { if (symChart) symChart.resize(); });

  function initSymbolChart() {
      if (typeof echarts === 'undefined') return;
      var chartEl = document.getElementById('symbol-chart');
      // 再実行時 (銘柄切替 swap 後) は前回のインスタンスを破棄してから作り直す。
      // getInstanceByDom も併用し、symChart 変数と DOM の紐付けがずれた場合
      // (例外で init 未完了のまま次の swap が来た等) でも dispose し損ねない
      // ようにする。
      if (chartEl) {
        var prevInstance = echarts.getInstanceByDom(chartEl);
        if (prevInstance) prevInstance.dispose();
      }
      symChart = null;
      var chartDataEl = document.getElementById('__chartData');
      var data = chartDataEl ? JSON.parse(chartDataEl.textContent || 'null') : null;
      var sc = data && data.symbolChart;
      if (!chartEl || !sc || sc.points.length === 0) return;

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
      // オープン中の保有は server が span に含めない (右端まで塗ると「そこで
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

      symChart = echarts.init(chartEl);
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

      // 判定点クリック → 脇パネルにその判定の判定トレース・ラダーを表示する
      // (文字ログ↔グラフ同期の肝)。ladderHtml は server 側で renderDecisionLadder
      // により事前レンダリング済み (全値 esc 済みの自前 markup) なので innerHTML
      // へ挿すだけ。JS 側にラダー描画ロジックを複製しない。
      // #charts-symbol-redesign: パネルは既定 display:none (プレースホルダで
      // 空間を取らない、fold 圧縮の一環)。クリックで内容を差し込むと同時に表示する。
      var tracePanel = document.getElementById('decision-trace-panel');
      function showDecisionTrace(d) {
        if (!tracePanel || !d) return;
        tracePanel.innerHTML = d.ladderHtml || '';
        tracePanel.style.display = 'block';
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
        tracePanel.style.display = 'block';
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
      // #charts-symbol-redesign: 初期表示では開かない (fold 内サマリカードの
      // 「直近判定」で同じ情報を既に見せている)。パネルは display:none のまま
      // 空間を取らず、判定点 / fill ピンをクリックしたときだけ開く。

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
  }

  document.addEventListener('DOMContentLoaded', initSymbolChart);

  // ---------------------------------------------------------------------
  // 銘柄切替 (client-side partial swap, #charts-symbol-redesign Phase C)
  // ---------------------------------------------------------------------
  // 対象は左レール (.symbol-rail) と symbol サブナビ (.symbol-subnav、
  // チャート/履歴・設定) のリンクのみ。同一 origin かつ ?tab=symbol の
  // リンクだけ intercept し、それ以外 (別ページへのリンク・modifier キー
  // 付きクリック・別 origin) は通常のブラウザ挙動に任せる。

  // 左レールの active 銘柄ハイライトを、swap 後の focus symbol に追従させる。
  // rail 自体は swap 対象 (#symbol-main) の外にあるため HTML は差し替わらず、
  // クラス付替えだけで見た目を同期する。
  function updateRailActiveSymbol(symbol) {
    var items = document.querySelectorAll('.symbol-rail .rail-item');
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var symEl = item.querySelector('.rail-sym');
      var isActive = !!symbol && !!symEl && symEl.textContent === symbol;
      if (isActive) item.classList.add('active'); else item.classList.remove('active');
    }
  }

  // #symbol-main の innerHTML を \`url\` (+ &partial=1) の fetch 結果で差し替え、
  // チャートを再初期化する。fetch 失敗 / non-200 / timeout は fail-open で
  // 通常のフルページ遷移 (window.location.href) にフォールバックする。
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
    // modifier キー付きクリック (新規タブ/ウィンドウで開く操作) は intercept しない。
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

  // 戻る/進む: このリスナーが生きている = 現在 symbol タブ表示中、なので
  // 遷移先 URL が tab=symbol でなければ (overview/quality タブへ戻る等)
  // SPA では対応せずフルリロードに任せる (location は既に新 URL に
  // 変わっているので reload で正しいページが取れる)。
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

/**
 * FNV-1a 32bit ハッシュ。改ざん耐性は不要 (静的アセットの ETag 用途のみ)。
 * `crypto.subtle.digest` は非同期なのでモジュール読み込み時に同期計算したく、
 * この軽量ハッシュで十分 (内容が変われば別 ETag になれば良い)。
 */
function computeFnv1aHex(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * `GET /dashboard/static/symbol-chart.js` の ETag。内容 (このファイル) が
 * 変わらない限り同じ値を返す静的ハッシュ + 文字数の組。ブラウザの
 * `If-None-Match` 突合と 304 応答に使う (#charts-symbol-redesign)。
 */
export const SYMBOL_CHART_CLIENT_SCRIPT_ETAG = `"${computeFnv1aHex(SYMBOL_CHART_CLIENT_SCRIPT)}-${SYMBOL_CHART_CLIENT_SCRIPT.length}"`
