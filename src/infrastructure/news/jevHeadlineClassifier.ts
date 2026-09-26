/**
 * `typesafe/jev` headline classifier for the observe-only market-headline
 * collector. `env.AI.run` parses defensively rather than trusting the
 * response shape: an upstream schema change or partial answer set must
 * downgrade to a `jev_error` row, never throw into the cron.
 */
const MODEL_ID = 'typesafe/jev'

export const QUESTIONS = {
  shock: {
    type: 'noul',
    instructions:
      'Do these headlines, taken together, report a sudden negative shock that is moving broad US equity markets right now?',
    criteria: {
      true: 'Multiple headlines describe an ongoing or just-occurred broad US market selloff, crash, panic, or a policy/geopolitical event that is actively driving one.',
      false:
        'Headlines are routine commentary, forecasts, opinion, single-company news, non-US markets only, or old events being recapped.',
    },
  },
  direction: {
    type: 'choice',
    instructions: 'What is the dominant near-term direction implied for broad US equities?',
    criteria: {
      risk_off: 'Selling pressure, fear, falling indexes, flight to safety.',
      risk_on: 'Relief rally, easing of a threat, rising indexes.',
      mixed: 'Conflicting signals with no dominant direction.',
      not_market_relevant: 'Headlines are not about financial markets or market-moving policy.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'Rate the severity of the market stress described by the headlines.',
    criteria: [
      'No market stress',
      'Routine volatility or warnings about possible future declines',
      'Notable single-day selloff in major indexes',
      'Severe multi-day broad selloff',
      'Crisis or panic: circuit breakers, systemic failure, historic crash',
    ],
  },
  scope: {
    type: 'choice',
    instructions: 'What is the scope of the events described?',
    criteria: {
      broad_us_market: 'US indexes or the whole US market.',
      sector: 'One sector such as semiconductors, tech, or defense.',
      single_company: 'One or a few individual companies.',
      non_us: 'Markets outside the US only.',
      none: 'No market event.',
    },
  },
} as const

export interface JevAi {
  run(model: string, input: unknown): Promise<unknown>
}

export interface JevAnswers {
  shock: number | null
  direction: string | null
  directionConfidence: number | null
  severity: number | null
  severityConfidence: number | null
  scope: string | null
  scopeConfidence: number | null
}

export interface JevClassification {
  model: string | null
  answers: JevAnswers
  /** Raw `answers` object from the response, kept for the `answers_json` column. */
  rawAnswers: unknown
  inputTokens: number | null
  outputTokens: number | null
}

export type JevClassifyResult = { ok: true; data: JevClassification } | { ok: false; error: string }

export async function classifyHeadlines(ai: JevAi, titles: string[]): Promise<JevClassifyResult> {
  let raw: unknown
  try {
    raw = await ai.run(MODEL_ID, { state: titles, questions: QUESTIONS })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return parseJevResponse(raw)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberField(node: unknown, field: string): number | null {
  if (!isRecord(node)) return null
  const value = node[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(node: unknown, field: string): string | null {
  if (!isRecord(node)) return null
  const value = node[field]
  return typeof value === 'string' ? value : null
}

function snippet(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200)
  } catch {
    return String(value)
  }
}

export function parseJevResponse(raw: unknown): JevClassifyResult {
  if (!isRecord(raw)) {
    return { ok: false, error: `jev response is not an object: ${snippet(raw)}` }
  }
  if (raw.state !== 'Completed') {
    return { ok: false, error: `jev state !== 'Completed': ${snippet(raw)}` }
  }
  const result = raw.result
  const answersRaw = isRecord(result) ? result.answers : undefined
  if (!isRecord(answersRaw)) {
    return { ok: false, error: `jev response missing answers: ${snippet(raw)}` }
  }

  const answers: JevAnswers = {
    shock: numberField(answersRaw.shock, 'noul'),
    direction: stringField(answersRaw.direction, 'choice'),
    directionConfidence: numberField(answersRaw.direction, 'confidence'),
    severity: numberField(answersRaw.severity, 'score'),
    severityConfidence: numberField(answersRaw.severity, 'confidence'),
    scope: stringField(answersRaw.scope, 'choice'),
    scopeConfidence: numberField(answersRaw.scope, 'confidence'),
  }

  if (
    answers.shock === null &&
    answers.direction === null &&
    answers.severity === null &&
    answers.scope === null
  ) {
    return { ok: false, error: `jev answers unparseable: ${snippet(raw)}` }
  }

  const usage = isRecord(result) ? result.usage : undefined
  return {
    ok: true,
    data: {
      model: stringField(result, 'model'),
      answers,
      rawAnswers: answersRaw,
      inputTokens: numberField(usage, 'input_tokens'),
      outputTokens: numberField(usage, 'output_tokens'),
    },
  }
}
