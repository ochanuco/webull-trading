import type { TradeEvent } from '../domain/TradeEvent'
import { TradeEventHandler } from '../events/TradeEventHandler'

export class TradeEventService {
  constructor(private readonly handler: TradeEventHandler = new TradeEventHandler()) {}

  async handle(event: TradeEvent): Promise<void> {
    await this.handler.handle(event)
  }
}
