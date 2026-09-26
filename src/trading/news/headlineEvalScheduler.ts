/**
 * Failed and empty slots are stored as rows, not just logged: the evaluation needs the
 * coverage gap rate, and logs are not retained long enough to measure it.
 *
 * Yahoo Finance RSS is the primary source; Google News is fetched only when
 * the Yahoo fetch itself fails (throw/non-2xx/non-RSS body) — production
 * cron egress IPs get a 503 bot-block page from Google intermittently,
 * while the same IPs already fetch Yahoo bars reliably in this cron. A
 * Yahoo fetch that succeeds with zero headlines is not a failure, so it
 * does not trigger the Google fallback.
 */
import type { Env } from '../../config/env'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../infrastructure/db/newsHeadlineEvalRepo'
import { GOOGLE_NEWS_QUERY, GoogleNewsRssClient } from '../../infrastructure/news/GoogleNewsRssClient'
import { YAHOO_FINANCE_SYMBOLS, YahooFinanceRssClient } from '../../infrastructure/news/YahooFinanceRssClient'
import type { RssHeadline } from '../../infrastructure/news/rssHeadlineParser'
import {
  classifyHeadlines,
  type JevClassification,
  type JevClassifyResult,
} from '../../infrastructure/news/jevHeadlineClassifier'

export const NEWS_HEADLINE_EVAL_SOURCE_YAHOO = 'yahoo_finance_rss'
export const NEWS_HEADLINE_EVAL_SOURCE_GOOGLE = 'google_news_rss'
const SLOT_MINUTES = 15
/** Total length cap when both sources fail and their messages are combined into one error column. */
const COMBINED_ERROR_MAX_CHARS = 500

export interface HeadlineEvalSummary {
  ran: boolean
  reason?: string
  status?: string
  source?: string
  headlineCount?: number
  inserted?: boolean
}

interface RunHeadlineEvalSchedulerOptions {
  env: Env
  requestId?: string
  now?: () => Date
  /** Test seam; defaults to a client hitting Yahoo Finance RSS. */
  yahooClient?: YahooFinanceRssClient
  /** Test seam; defaults to a client hitting Google News RSS (used only on a Yahoo fetch failure). */
  googleClient?: GoogleNewsRssClient
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    source: string,
    query: string,
    headlines: RssHeadline[],
    extra: { error?: string; classification?: JevClassification } = {},
  ): Promise<HeadlineEvalSummary> => {
    try {
      const repo = createNewsHeadlineEvalRepo(createNewsHeadlineEvalDb(db))
      const { inserted } = await repo.insertIgnore({
        evaluatedAt,
        source,
        query,
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
      return { ran: true, status, source, headlineCount: headlines.length, inserted }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'headline_eval_scheduler_insert_error',
          requestId,
          status,
          source,
          message: messageOf(error),
        }),
      )
      return { ran: false, reason: 'insert_error', status, source, headlineCount: headlines.length }
    }
  }

  try {
    let headlines: RssHeadline[] | undefined
    let yahooError: unknown
    try {
      const yahoo = options.yahooClient ?? new YahooFinanceRssClient()
      headlines = await yahoo.fetchHeadlines(YAHOO_FINANCE_SYMBOLS)
    } catch (error) {
      yahooError = error
    }

    let source = NEWS_HEADLINE_EVAL_SOURCE_YAHOO
    let query = YAHOO_FINANCE_SYMBOLS
    if (headlines === undefined) {
      try {
        const google = options.googleClient ?? new GoogleNewsRssClient()
        headlines = await google.fetchHeadlines(GOOGLE_NEWS_QUERY)
        source = NEWS_HEADLINE_EVAL_SOURCE_GOOGLE
        query = GOOGLE_NEWS_QUERY
      } catch (googleError) {
        const combined = `yahoo: ${messageOf(yahooError)}; google: ${messageOf(googleError)}`.slice(
          0,
          COMBINED_ERROR_MAX_CHARS,
        )
        return await persist('fetch_error', NEWS_HEADLINE_EVAL_SOURCE_YAHOO, YAHOO_FINANCE_SYMBOLS, [], {
          error: combined,
        })
      }
    }

    if (headlines.length === 0) {
      return await persist('no_headlines', source, query, [])
    }

    const classification: JevClassifyResult = await classifyHeadlines(
      ai,
      headlines.map((h) => h.title),
    )
    if (!classification.ok) {
      return await persist('jev_error', source, query, headlines, { error: classification.error })
    }

    return await persist('ok', source, query, headlines, { classification: classification.data })
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'headline_eval_scheduler_error',
        requestId,
        message: messageOf(error),
      }),
    )
    return empty('error')
  }
}
