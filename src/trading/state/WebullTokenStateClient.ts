import type { WebullTokenStatus } from '../../infrastructure/webull/WebullTokenClient'
import type { WebullTokenState, WebullTokenStateDO } from './WebullTokenStateDO'

const SINGLETON_NAME = 'default'

/**
 * Thin adapter that hides the {@link DurableObjectNamespace}/stub plumbing
 * from callers. Always addresses `idFromName('default')` because the token
 * is account-wide (#21 Phase B).
 */
export class WebullTokenStateClient {
  constructor(private readonly namespace: DurableObjectNamespace<WebullTokenStateDO>) {}

  private stub(): DurableObjectStub<WebullTokenStateDO> {
    return this.namespace.get(this.namespace.idFromName(SINGLETON_NAME))
  }

  getState(): Promise<WebullTokenState | null> {
    return this.stub().getState()
  }

  seedToken(input: {
    token: string
    expires: number
    status: WebullTokenStatus
    nowIso?: string
  }): Promise<WebullTokenState> {
    return this.stub().seedToken(input)
  }

  recordRefresh(
    result:
      | {
          success: true
          token: string
          expires: number
          status: WebullTokenStatus
          nowIso?: string
        }
      | { success: false; nowIso?: string },
  ): Promise<WebullTokenState | null> {
    return this.stub().recordRefresh(result)
  }
}
