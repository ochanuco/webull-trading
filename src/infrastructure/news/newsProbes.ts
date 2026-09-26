// Kept as a code constant, not in `global_config`: `query` defines the
// baseline population that trailing-window comparisons are computed against.
// A DB-editable query would let past and new data silently become
// different populations under the same `probe_key`. Changing it goes
// through deploy instead, so the change is reviewed and shows in git history.
type NewsProbeMetric = 'volume' | 'tone'

export interface NewsProbe {
  /** D1 の `attention_observation.probe_key` と一致させる。 */
  readonly key: string
  /** GDELT DOC 2.0 API の `query` パラメタにそのまま渡す。 */
  readonly query: string
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
