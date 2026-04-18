import type { TradeEvent } from '../domain/TradeEvent'
import { TradeEventHandler, type TradeEventHandlerOptions } from '../events/TradeEventHandler'

export class TradeEventService {
  private readonly handler: TradeEventHandler

  constructor(handlerOrOptions: TradeEventHandler | TradeEventHandlerOptions = {}) {
    this.handler =
      handlerOrOptions instanceof TradeEventHandler
        ? handlerOrOptions
        : new TradeEventHandler(console.log, handlerOrOptions)
  }

  async handle(event: TradeEvent): Promise<void> {
    await this.handler.handle(event)
  }
}
