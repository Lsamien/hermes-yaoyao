import { describe, expect, it } from 'vitest'
import { RealtimeLeaseStore } from '../../src/server/leases.js'

describe('RealtimeLeaseStore', () => {
  it('binds a lease to channel, origin, account and one use', () => {
    let now = 1_000
    const store = new RealtimeLeaseStore(20_000, () => now)
    const lease = store.issue({
      channel: 'chat',
      credential: { name: 'ticket', value: 'upstream-secret' },
      origin: 'http://127.0.0.1:8800',
      accountKeys: ['account-a'],
    })
    expect(() => store.consume(
      lease.id,
      'groups',
      'http://127.0.0.1:8800',
      'account-a',
    )).toThrow(/invalid or expired/)
    expect(store.consume(
      lease.id,
      'chat',
      'http://127.0.0.1:8800',
      'account-a',
    ).credential.value).toBe('upstream-secret')
    expect(() => store.consume(
      lease.id,
      'chat',
      'http://127.0.0.1:8800',
      'account-a',
    )).toThrow(/invalid or expired/)

    const expiring = store.issue({
      channel: 'chat',
      credential: { name: 'ticket', value: 'another-secret' },
      origin: 'http://127.0.0.1:8800',
      accountKeys: ['account-a'],
    })
    now += 20_001
    expect(() => store.consume(
      expiring.id,
      'chat',
      'http://127.0.0.1:8800',
      'account-a',
    )).toThrow(/invalid or expired/)
  })
})
