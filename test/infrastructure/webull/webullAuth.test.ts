import { describe, expect, it } from 'vitest'
import {
  canonicalString,
  hmacSha1Base64,
  md5UpperHex,
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

  it('matches the HMAC-SHA1 worked example from Webull docs', async () => {
    const encodedSignString =
      '%2Ftrade%2Fplace_order%26a1%3Dwebull%26a2%3D123%26a3%3Dxxx%26host%3Dapi.webull.com%26q1%3Dyyy%26x-app-key%3D776da210ab4a452795d74e726ebd74b6%26x-signature-algorithm%3DHMAC-SHA1%26x-signature-nonce%3D48ef5afed43d4d91ae514aaeafbc29ba%26x-signature-version%3D1.0%26x-timestamp%3D2022-01-04T03%3A55%3A31Z%26E296C96787E1A309691CEF3692F5EEDD'

    await expect(hmacSha1Base64('0f50a2e853334a9aae1a783bee120c1f', encodedSignString)).resolves.toBe(
      'kvlS6opdZDhEBo5jq40nHYXaLvM=',
    )
  })
})
