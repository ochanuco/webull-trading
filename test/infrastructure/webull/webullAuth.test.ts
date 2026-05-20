import { describe, expect, it } from 'vitest'
import {
  buildSignedHeaders,
  canonicalString,
  hmacSha1Base64,
  hmacSha256Base64,
  md5UpperHex,
  pickSignerAlgorithm,
  sha256UpperHex,
  urlEncodeCanonical,
} from '../../../src/infrastructure/webull/WebullAuth'

describe('WebullAuth helpers', () => {
  it('builds the canonical string without a body hash when the body is empty', () => {
    const result = canonicalString({
      path: '/account/profile',
      query: {
        account_id: 'acct-123',
      },
      headers: {
        host: 'api.sandbox.webull.hk',
        'x-app-key': 'app-key',
        'x-signature-algorithm': 'HMAC-SHA1',
        'x-signature-nonce': 'nonce-1',
        'x-signature-version': '1.0',
        'x-timestamp': '2026-04-18T12:30:45Z',
        'x-version': 'v1',
      },
    })

    expect(result).toBe(
      '/account/profile&account_id=acct-123&host=api.sandbox.webull.hk&x-app-key=app-key&x-signature-algorithm=HMAC-SHA1&x-signature-nonce=nonce-1&x-signature-version=1.0&x-timestamp=2026-04-18T12:30:45Z&x-version=v1',
    )
  })

  it('builds the canonical string with a body hash when the body is present', () => {
    const result = canonicalString({
      path: '/trade/place_order',
      query: {
        q1: 'yyy',
      },
      headers: {
        host: 'api.webull.com',
        'x-app-key': '776da210ab4a452795d74e726ebd74b6',
        'x-signature-algorithm': 'HMAC-SHA1',
        'x-signature-nonce': '48ef5afed43d4d91ae514aaeafbc29ba',
        'x-signature-version': '1.0',
        'x-timestamp': '2022-01-04T03:55:31Z',
      },
      bodyMd5: 'E296C96787E1A309691CEF3692F5EEDD',
    })

    expect(result).toBe(
      '/trade/place_order&host=api.webull.com&q1=yyy&x-app-key=776da210ab4a452795d74e726ebd74b6&x-signature-algorithm=HMAC-SHA1&x-signature-nonce=48ef5afed43d4d91ae514aaeafbc29ba&x-signature-version=1.0&x-timestamp=2022-01-04T03:55:31Z&E296C96787E1A309691CEF3692F5EEDD',
    )
  })

  it('URL-encodes spaces as %20 and keeps unreserved characters unchanged', () => {
    expect(urlEncodeCanonical('a b-_.~')).toBe('a%20b-_.~')
  })

  it('produces uppercase MD5 hex digests', async () => {
    await expect(md5UpperHex('{"symbol":"AAPL"}')).resolves.toBe('0DAB09372CD53C138B7309FFAA8A5E68')
  })

  it('omits x-version from the canonical signing even when sent as a request header', async () => {
    const common = {
      method: 'GET' as const,
      path: '/app/subscriptions/list',
      appKey: 'app-key',
      appSecret: 'app-secret',
      host: 'api.sandbox.webull.hk',
      nonce: 'nonce-1',
      timestamp: '2026-04-18T12:30:45Z',
    }

    const withVersion = await buildSignedHeaders({ ...common, version: 'v1' })
    const withoutVersion = await buildSignedHeaders({ ...common })

    expect(withVersion['x-version']).toBe('v1')
    expect(withoutVersion['x-version']).toBeUndefined()
    expect(withVersion['x-signature']).toBe(withoutVersion['x-signature'])
  })

  it('emits x-access-token when accessToken is set, without affecting the signature', async () => {
    // #21: token flow is supplemental to the HMAC-SHA1 scheme — the token must
    // ride in `x-access-token` but not enter the canonical string. Compare
    // signatures with/without the token to lock that behaviour.
    const common = {
      method: 'GET' as const,
      path: '/account/profile',
      appKey: 'app-key',
      appSecret: 'app-secret',
      host: 'api.sandbox.webull.hk',
      nonce: 'nonce-1',
      timestamp: '2026-04-18T12:30:45Z',
    }

    const withToken = await buildSignedHeaders({ ...common, accessToken: 'tok-abc' })
    const withoutToken = await buildSignedHeaders({ ...common })

    expect(withToken['x-access-token']).toBe('tok-abc')
    expect(withoutToken['x-access-token']).toBeUndefined()
    expect(withToken['x-signature']).toBe(withoutToken['x-signature'])
  })

  it('treats whitespace-only accessToken as unset (avoid silent "I set it" footgun)', async () => {
    const common = {
      method: 'GET' as const,
      path: '/account/profile',
      appKey: 'app-key',
      appSecret: 'app-secret',
      host: 'api.sandbox.webull.hk',
      nonce: 'nonce-1',
      timestamp: '2026-04-18T12:30:45Z',
    }

    const result = await buildSignedHeaders({ ...common, accessToken: '   ' })
    expect(result['x-access-token']).toBeUndefined()
  })

  // #21 Phase B follow-up: signing algorithm の選択は **x-version base** で行う
  // (JP 本番 probe で v1 endpoint + SHA256 が `SIGNATURE_ALGORITHM_NOT_SUPPORTED`
  // で reject される事を実証)。SDK は host base 実装だが、それは host ごとに
  // 「使う endpoint version」を固定してた副次効果で動いてただけ。
  describe('pickSignerAlgorithm (version-based selection)', () => {
    it('uses HMAC-SHA1 for v1 (or unspecified) endpoint', () => {
      expect(pickSignerAlgorithm('v1')).toBe('HMAC-SHA1')
      expect(pickSignerAlgorithm(undefined)).toBe('HMAC-SHA1')
    })

    it('uses HMAC-SHA256 for v2 endpoint', () => {
      expect(pickSignerAlgorithm('v2')).toBe('HMAC-SHA256')
    })

    // 想定外の値は安全側で SHA1 にする (broker が v1 として扱えば許容、v2 として
    // 扱えば signature の前段で reject なので fail-fast)。
    it('falls back to HMAC-SHA1 for unknown version values', () => {
      expect(pickSignerAlgorithm('v3-future')).toBe('HMAC-SHA1')
      expect(pickSignerAlgorithm('')).toBe('HMAC-SHA1')
    })
  })

  it('buildSignedHeaders emits x-signature-algorithm=HMAC-SHA256 for v2 endpoint', async () => {
    const headers = await buildSignedHeaders({
      method: 'GET',
      path: '/openapi/assets/positions',
      query: { account_id: 'acct-1' },
      appKey: 'app-key',
      appSecret: 'app-secret',
      host: 'api.webull.co.jp',
      nonce: 'nonce-1',
      timestamp: '2026-05-20T00:00:00Z',
      version: 'v2',
    })
    expect(headers['x-signature-algorithm']).toBe('HMAC-SHA256')
  })

  it('buildSignedHeaders emits x-signature-algorithm=HMAC-SHA1 for v1 endpoint (even on JP prod host)', async () => {
    // 同じ host (api.webull.co.jp) でも v1 endpoint なら SHA1 を使う。
    // JP 本番 probe で v1+SHA256 → SIGNATURE_ALGORITHM_NOT_SUPPORTED だった事の
    // regression lock。
    const headers = await buildSignedHeaders({
      method: 'GET',
      path: '/openapi/account/positions',
      query: { account_id: 'acct-1' },
      appKey: 'app-key',
      appSecret: 'app-secret',
      host: 'api.webull.co.jp',
      nonce: 'nonce-1',
      timestamp: '2026-05-20T00:00:00Z',
      version: 'v1',
    })
    expect(headers['x-signature-algorithm']).toBe('HMAC-SHA1')
  })

  it('SHA256 path (v2) uses SHA256 body hash (not MD5) in the canonical string', async () => {
    // v2 endpoint + body で SHA256 経路を踏み、canonical/signature が SHA256 で
    // 組まれてる事を確認。SHA1 と比較して異なる値になる = 切替が effective。
    const body = '{"a":1}'
    const headers = await buildSignedHeaders({
      method: 'POST',
      path: '/openapi/trade/order/place',
      body,
      appKey: 'app-key',
      appSecret: 'app-secret',
      host: 'api.webull.co.jp',
      nonce: 'nonce-1',
      timestamp: '2026-05-20T00:00:00Z',
      version: 'v2',
    })
    expect(headers['x-signature-algorithm']).toBe('HMAC-SHA256')

    const bodyHash = await sha256UpperHex(body)
    const canonical = canonicalString({
      path: '/openapi/trade/order/place',
      headers: {
        host: 'api.webull.co.jp',
        'x-app-key': 'app-key',
        'x-signature-algorithm': 'HMAC-SHA256',
        'x-signature-nonce': 'nonce-1',
        'x-signature-version': '1.0',
        'x-timestamp': '2026-05-20T00:00:00Z',
      },
      bodyMd5: bodyHash,
    })
    const expected = await hmacSha256Base64('app-secret', urlEncodeCanonical(canonical))
    expect(headers['x-signature']).toBe(expected)

    const sha1Sig = await hmacSha1Base64('app-secret', urlEncodeCanonical(canonical))
    expect(headers['x-signature']).not.toBe(sha1Sig)
  })

  it('sha256UpperHex matches a known SHA-256 vector', async () => {
    // SHA-256 of "abc" = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    await expect(sha256UpperHex('abc')).resolves.toBe(
      'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD',
    )
  })

  it('matches the HMAC-SHA1 worked example from Webull docs', async () => {
    const encodedSignString =
      '%2Ftrade%2Fplace_order%26a1%3Dwebull%26a2%3D123%26a3%3Dxxx%26host%3Dapi.webull.com%26q1%3Dyyy%26x-app-key%3D776da210ab4a452795d74e726ebd74b6%26x-signature-algorithm%3DHMAC-SHA1%26x-signature-nonce%3D48ef5afed43d4d91ae514aaeafbc29ba%26x-signature-version%3D1.0%26x-timestamp%3D2022-01-04T03%3A55%3A31Z%26E296C96787E1A309691CEF3692F5EEDD'

    await expect(hmacSha1Base64('0f50a2e853334a9aae1a783bee120c1f', encodedSignString)).resolves.toBe(
      'kvlS6opdZDhEBo5jq40nHYXaLvM=',
    )
  })
})
