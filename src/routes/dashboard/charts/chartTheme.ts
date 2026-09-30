/**
 * Shared ECharts theme + init helper, served statically at
 * `GET /dashboard/static/chart-theme.js` and loaded from every dashboard
 * page (`layout.ts`), unlike `symbol-chart.js` which only the symbol tab
 * loads. Kept as a plain exported string (no build step) for the same
 * reason as `symbolChartScript.ts` — POC policy against adding a bundler.
 *
 * Registration is lazy (on the first `wtChart()` call, not at script load)
 * because this script is loaded before each page's own `ECHARTS_CDN`
 * `<script>` tag executes (layout's `<head>` renders before the page body),
 * so `echarts` is not yet defined when this file's top-level code runs.
 */
export const CHART_THEME_CLIENT_SCRIPT = `
(function () {
  var themeRegistered = false;
  var instances = []; // { el, option, chart, ro }

  function readTokens() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fallback) {
      var val = cs.getPropertyValue(name);
      return val ? val.trim() : fallback;
    }
    return {
      bg: v('--bg', '#f5f6f8'),
      surface: v('--surface', '#ffffff'),
      surface2: v('--surface-2', '#f0f2f5'),
      surface3: v('--surface-3', '#e7eaef'),
      border: v('--border', '#e2e5ea'),
      borderStrong: v('--border-strong', '#cdd2da'),
      text: v('--text', '#111827'),
      text2: v('--text-2', '#4b5563'),
      text3: v('--text-3', '#8b93a1'),
      accent: v('--accent', '#2f6fed'),
      accentSoft: v('--accent-soft', '#e7eefe'),
      accentText: v('--accent-text', '#1d4fd7'),
      up: v('--up', '#0e8a5f'),
      upSoft: v('--up-soft', '#e3f5ec'),
      down: v('--down', '#d4453b'),
      downSoft: v('--down-soft', '#fdeaea'),
      warn: v('--warn', '#b45309'),
      warnSoft: v('--warn-soft', '#fdf1e2'),
      info: v('--info', '#4b6a9b'),
      infoSoft: v('--info-soft', '#eaf0f8'),
    };
  }
  window.wtTokens = readTokens;

  function registerTheme() {
    if (typeof echarts === 'undefined') return false;
    var t = readTokens();
    // Series palette order (accent, then teal/amber/violet/rose/slate) is
    // fixed by the spec so charts across pages read consistently; only the
    // accent slot is dark-aware via the token, the rest are static hues
    // chosen for contrast against both --bg values.
    var palette = [t.accent, '#14b8a6', '#f59e0b', '#8b5cf6', '#f43f5e', t.text3];
    echarts.registerTheme('wt', {
      color: palette,
      backgroundColor: 'transparent',
      textStyle: { color: t.text },
      title: { textStyle: { color: t.text }, subtextStyle: { color: t.text2 } },
      legend: { textStyle: { color: t.text2 } },
      tooltip: {
        backgroundColor: t.surface,
        borderColor: t.border,
        textStyle: { color: t.text },
      },
      categoryAxis: {
        axisLine: { lineStyle: { color: t.border } },
        axisLabel: { color: t.text3 },
        splitLine: { lineStyle: { color: t.border } },
      },
      valueAxis: {
        axisLine: { lineStyle: { color: t.border } },
        axisLabel: { color: t.text3 },
        splitLine: { lineStyle: { color: t.border } },
      },
      timeAxis: {
        axisLine: { lineStyle: { color: t.border } },
        axisLabel: { color: t.text3 },
        splitLine: { lineStyle: { color: t.border } },
      },
    });
    themeRegistered = true;
    return true;
  }

  function findEntry(el) {
    for (var i = 0; i < instances.length; i += 1) {
      if (instances[i].el === el) return instances[i];
    }
    return null;
  }

  function createInstance(entry, option) {
    var chart = echarts.init(entry.el, 'wt', { renderer: 'canvas' });
    chart.setOption(option);
    entry.chart = chart;
    entry.option = option;
    return chart;
  }

  // Exposed so a caller that disposes its own instance (e.g. the symbol
  // chart's switch-symbol flow, which needs to dispose before this file's
  // init sees the DOM node again) doesn't leave a stale ResizeObserver
  // callback pointing at a disposed chart.
  window.wtChart = function (el, option) {
    if (!el || typeof echarts === 'undefined') return null;
    if (!themeRegistered) registerTheme();
    var entry = findEntry(el);
    if (!entry) {
      entry = { el: el, option: option, chart: null, ro: null };
      instances.push(entry);
    } else if (entry.ro) {
      entry.ro.disconnect();
      entry.ro = null;
    }
    var chart = createInstance(entry, option);
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        try { chart.resize(); } catch (e) { /* disposed between observation tick and callback */ }
      });
      ro.observe(el);
      entry.ro = ro;
    } else {
      window.addEventListener('resize', function () {
        try { chart.resize(); } catch (e) { /* disposed */ }
      });
    }
    return chart;
  };

  function retheme() {
    themeRegistered = false;
    if (!registerTheme()) return;
    for (var i = 0; i < instances.length; i += 1) {
      var entry = instances[i];
      try { entry.chart.dispose(); } catch (e) { /* already disposed */ }
      createInstance(entry, entry.option);
    }
  }

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', retheme);
    else if (mq.addListener) mq.addListener(retheme); // Safari < 14
  }
  // The theme-toggle button (layout.ts) sets data-theme on <html>, which
  // prefers-color-scheme alone won't notify listeners about.
  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i += 1) {
        if (muts[i].attributeName === 'data-theme') { retheme(); break; }
      }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) { /* MutationObserver unavailable — theme click still applies CSS, just skips live re-theme */ }
})();
`

/** Not tamper-resistant, only used as an ETag — mirrors symbolChartScript.ts's own copy (kept independent so the two static assets version separately). */
function computeFnv1aHex(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** ETag for `GET /dashboard/static/chart-theme.js`, used for `If-None-Match` / 304. */
export const CHART_THEME_CLIENT_SCRIPT_ETAG = `"${computeFnv1aHex(CHART_THEME_CLIENT_SCRIPT)}-${CHART_THEME_CLIENT_SCRIPT.length}"`
