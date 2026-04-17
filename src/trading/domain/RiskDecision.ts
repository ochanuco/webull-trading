import type { OrderIntent } from './OrderIntent'

export interface RiskDecision {
  allowed: boolean
  reasons: string[]
  normalizedIntent?: OrderIntent
}
