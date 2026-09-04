import { describe, expect, it } from 'vitest'
import { AccountLoginPairingStore } from '../../src/server/accountPairing.js'

describe('15300 account login pairing', () => {
  it('issues a one-time expiring claim for a normal server account', () => {
    let now = 1_000
    const store = new AccountLoginPairingStore(() => now)
    const pairing = store.create('user-1')
    expect(store.status(pairing.id)).toEqual({ state: 'pending' })
    expect(store.claim(pairing.id, pairing.secret)).toBe('user-1')
    expect(store.status(pairing.id)).toEqual({ state: 'claimed' })
    expect(() => store.claim(pairing.id, pairing.secret)).toThrow(/已使用/)

    const expired = store.create('user-2')
    now = expired.expiresAt + 1
    expect(store.status(expired.id)).toEqual({ state: 'expired' })
  })

  it('rejects an invalid secret', () => {
    const store = new AccountLoginPairingStore()
    const pairing = store.create('user-1')
    expect(() => store.claim(pairing.id, 'wrong-secret')).toThrow(/密钥无效/)
  })
})
