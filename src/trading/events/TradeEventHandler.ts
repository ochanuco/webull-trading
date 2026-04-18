import type { TradeEvent } from '../domain/TradeEvent'
import type { PositionStore } from '../state/PositionStore'
import { logFill, logExit } from '../../infrastructure/logger/tradeJournal'

export interface TradeEventAuditRecord {
  source: 'trade-event'
  eventType: string
  orderId: string
  symbol: string
  status: string
  filledQty?: number
  receivedAt: string
}

export interface TradeEventHandlerOptions {
  positionStore?: PositionStore
  now?: () => Date
}

const MS_PER_DAY = 86_400_000

export class TradeEventHandler {
  private readonly positionStore?: PositionStore
  private readonly now: () => Date

  constructor(
    private readonly log: (message: string) => void = console.log,
    options: TradeEventHandlerOptions = {},
  ) {
    this.positionStore = options.positionStore
    this.now = options.now ?? (() => new Date())
  }

  async handle(event: TradeEvent): Promise<void> {
    const orderId = event.orderId.trim()
    const symbol = event.symbol.trim().toUpperCase()
    const status = event.status.trim()

    const record: TradeEventAuditRecord = {
      source: 'trade-event',
      eventType: event.eventType.trim(),
      orderId,
      symbol,
      status,
      receivedAt: event.receivedAt,
    }

    if (event.filledQty !== undefined) {
      record.filledQty = event.filledQty
    }

    this.log(JSON.stringify(record))

    const clientOrderId = readClientOrderId(event.rawPayload)
    const filledPrice = readFilledPrice(event.rawPayload)

    logFill({
      clientOrderId,
      orderId,
      symbol,
      filledQty: event.filledQty,
      filledPrice,
      status,
    })

    if (status === 'FILLED' && this.positionStore) {
      await this.applyFillToState({ symbol, event, orderId, clientOrderId, filledPrice })
    }
  }

  private async applyFillToState({
    symbol,
    event,
    orderId,
    clientOrderId,
    filledPrice,
  }: {
    symbol: string
    event: TradeEvent
    orderId: string
    clientOrderId?: string
    filledPrice?: number
  }): Promise<void> {
    if (!this.positionStore) return
    if (event.filledQty === undefined || filledPrice === undefined) {
      // Best-effort cleanup: only release pending lock if it belongs to this order
      const pre = await this.positionStore.getState(symbol)
      const lock = pre.pendingOrder
      if (lock) {
        const eventClientOrderId = clientOrderId ?? event.orderId
        if (lock.clientOrderId === eventClientOrderId) {
          await this.positionStore.clearPendingOrder(symbol).catch(() => undefined)
        }
      }
      return
    }

    const pre = await this.positionStore.getState(symbol)
    const lock = pre.pendingOrder
    if (!lock) return

    // Verify the pending lock belongs to this fill
    const eventClientOrderId = clientOrderId ?? event.orderId
    if (lock.clientOrderId !== eventClientOrderId) {
      // Stale or mismatched lock; ignore this fill
      this.log(
        JSON.stringify({
          warning: 'fill-lock-mismatch',
          symbol,
          orderId,
          eventClientOrderId,
          lockClientOrderId: lock.clientOrderId,
        }),
      )
      return
    }

    const next = await this.positionStore.recordFill(symbol, {
      side: lock.side,
      qty: event.filledQty,
      price: filledPrice,
    })

    if (lock.side === 'SELL' && pre.position !== null && next.position === null) {
      const realizedPnl = (filledPrice - pre.position.avgPrice) * event.filledQty
      const holdMs = this.now().getTime() - new Date(pre.position.openedAt).getTime()
      const holdDays = Math.max(0, Math.floor(holdMs / MS_PER_DAY))
      logExit({
        clientOrderId: clientOrderId ?? lock.clientOrderId,
        orderId,
        symbol,
        realizedPnl,
        holdDays,
        exitReason: 'OTHER',
      })
    }
  }
}

function readClientOrderId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload.client_order_id ?? payload.clientOrderId
  return typeof value === 'string' ? value : undefined
}

function readFilledPrice(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload.filled_price ?? payload.filledPrice ?? payload.price
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}