/**
 * GDELT probe 定義 (PR 1 — news attention producer)。
 *
 * **`global_config` には置かない** (コード定数として持つ)。理由: probe の
 * `query` 文字列は trailing baseline (直近 N 日の分布に対する比率で閾値判定
 * する、将来の newsShockGate 前提) の母集団そのものを定義する。DB UPDATE で
 * 誰でも書き換えられる状態にすると、query を変えた瞬間に過去の蓄積データと
 * 新規データが別の母集団になり baseline 比較が無意味になる — しかもそれが
 * 静かに起きる (schema 上は同じ `probe_key` のまま値の意味だけ変わる)。
 * query 変更は必ず deploy (= コードレビュー + git 履歴に残る意図表明) を
 * 経由させるため、ここに定数として固定する。
 */
export type NewsProbeMetric = 'volume' | 'tone'

export interface NewsProbe {
  /** コード側定数キー。D1 の `attention_observation.probe_key` と一致させる。 */
  readonly key: string
  /** GDELT DOC 2.0 API の `query` パラメタにそのまま渡す。 */
  readonly query: string
  /** この probe が取得する metric 群。PR 1 は volume/tone の 2 本固定。 */
  readonly metrics: readonly NewsProbeMetric[]
}

export const NEWS_PROBES: readonly NewsProbe[] = [
  {
    key: 'trump_macro',
    query: 'trump tariffs sourcelang:english',
    metrics: ['volume', 'tone'],
  },
  {
    key: 'market_selloff',
    query: 'stock market selloff sourcelang:english',
    metrics: ['volume', 'tone'],
  },
]
