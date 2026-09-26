/**
 * Failed and empty slots are stored as rows, not just logged: the evaluation needs the
 * coverage gap rate, and logs are not retained long enough to measure it.
 */
import type { Env } from '../../config/env'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../infrastructure/db/newsHeadlineEvalRepo'
import {
  GOOGLE_NEWS_QUERY,
  GoogleNewsRssClient,
  type GoogleNewsHeadline,
} from '../../infrastructure/news/GoogleNewsRssClient'
import {
  classifyHeadlines,
  type JevClassification,
  type JevClassifyResult,
} from '../../infrastructure/news/jevHeadlineClassifier'

const SOURCE = 'google_news_rss'
const SLOT_MINUTES = 15

export interface HeadlineEvalSummary {
  ran: boolean
  reason?: string
  status?: string
  headlineCount?: number
  inserted?: boolean
}

interface RunHeadlineEvalSchedulerOptions {
  env: Env
  requestId?: string
  now?: () => Date
  /** Test seam; defaults to a client built from the fixed Google News query. */
  client?: GoogleNewsRssClient
}

/** Unset or anything but `'true'` means disabled (opt-in, fail-closed default). */
function isOptInEnabled(flag: string | undefined): boolean {
  return (flag ?? '').trim().toLowerCase() === 'true'
}

/** Floors `date` to the most recent 15-minute UTC boundary — the slot key stored in `evaluated_at`. */
function slotIso(date: Date): string {
  const floored = new Date(date.getTime())
  floored.setUTCMinutes(Math.floor(floored.getUTCMinutes() / SLOT_MINUTES) * SLOT_MINUTES, 0, 0)
  return floored.toISOString()
}

export async function runHeadlineEvalScheduler(
  options: RunHeadlineEvalSchedulerOptions,
): Promise<HeadlineEvalSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const empty = (reason: string): HeadlineEvalSummary => ({ ran: false, reason })

  if (!isOptInEnabled(env.JEV_HEADLINE_EVAL_ENABLED)) {
    return empty('jev_headline_eval_disabled')
  }
  const db = env.DB
  if (!db) {
    return empty('db_unavailable')
  }
  const ai = env.AI
  if (!ai) {
    return empty('ai_unavailable')
  }

  const nowDate = now()
  if (nowDate.getUTCMinutes() % SLOT_MINUTES !== 0) {
    return empty('outside_slot')
  }

  const evaluatedAt = slotIso(nowDate)
  const startedAt = Date.now()
  const requestId = options.requestId

  const persist = async (
    status: string,
    headlines: GoogleNewsHeadline[],
    extra: { error?: string; classification?: JevClassification } = {},
  ): Promise<HeadlineEvalSummary> => {
    try {
      const repo = createNewsHeadlineEvalRepo(createNewsHeadlineEvalDb(db))
      const { inserted } = await repo.insertIgnore({
        evaluatedAt,
        source: SOURCE,
        query: GOOGLE_NEWS_QUERY,
        headlineCount: headlines.length,
        headlinesJson: JSON.stringify(headlines),
        status,
        error: extra.error ?? null,
        model: extra.classification?.model ?? null,
        shock: extra.classification?.answers.shock ?? null,
        direction: extra.classification?.answers.direction ?? null,
        directionConfidence: extra.classification?.answers.directionConfidence ?? null,
        severity: extra.classification?.answers.severity ?? null,
        severityConfidence: extra.classification?.answers.severityConfidence ?? null,
        scope: extra.classification?.answers.scope ?? null,
        scopeConfidence: extra.classification?.answers.scopeConfidence ?? null,
        answersJson: extra.classification ? JSON.stringify(extra.classification.rawAnswers) : null,
        inputTokens: extra.classification?.inputTokens ?? null,
        outputTokens: extra.classification?.outputTokens ?? null,
        latencyMs: Date.now() - startedAt,
        requestId: requestId ?? null,
      })
      return { ran: true, status, headlineCount: headlines.length, inserted }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'headline_eval_scheduler_insert_error',
          requestId,
          status,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      return { ran: false, reason: 'insert_error', status, headlineCount: headlines.length }
    }
  }

  try {
    let headlines: GoogleNewsHeadline[]
    try {
      const client = options.client ?? new GoogleNewsRssClient()
      headlines = await client.fetchHeadlines(GOOGLE_NEWS_QUERY)
    } catch (error) {
      return await persist('fetch_error', [], {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (headlines.length === 0) {
      return await persist('no_headlines', [])
    }

    const classification: JevClassifyResult = await classifyHeadlines(
      ai,
      headlines.map((h) => h.title),
    )
    if (!classification.ok) {
      return await persist('jev_error', headlines, { error: classification.error })
    }

    return await persist('ok', headlines, { classification: classification.data })
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'headline_eval_scheduler_error',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return empty('error')
  }
}
