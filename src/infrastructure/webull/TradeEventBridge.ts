import type { TradeEvent } from '../../trading/domain/TradeEvent'

export const TRADE_EVENT_INGEST_SECRET_HEADER = 'x-event-ingest-secret'

export interface TradeEventIngestRequest {
  event: TradeEvent
}
