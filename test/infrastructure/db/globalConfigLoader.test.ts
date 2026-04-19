import { describe, expect, it } from 'vitest'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'

describe('loadGlobalConfigFrom', () => {
  it('throws when env.DB binding is missing (D1 setup required)', async () => {
    await expect(loadGlobalConfigFrom({})).rejects.toThrow(/env\.DB is not bound/)
  })
})
