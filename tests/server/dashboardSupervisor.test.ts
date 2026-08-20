import { describe, expect, it } from 'vitest'
import {
  DashboardSupervisor,
  DEFAULT_DASHBOARD_USERNAME,
} from '../../src/server/dashboardSupervisor.js'

function supervisor(overrides: {
  values?: Record<string, string>
  running?: boolean
  allowLan?: boolean
} = {}) {
  const values = { ...overrides.values }
  let running = overrides.running ?? false
  const calls: string[][] = []
  const launches: string[][] = []
  const instance = new DashboardSupervisor({
    allowLan: overrides.allowLan ?? false,
    run(args) {
      calls.push([...args])
      if (args[0] === 'config' && args[1] === 'get') return values[args[2]] ?? ''
      if (args[0] === 'config' && args[1] === 'set') {
        values[args[2]] = args[3]
        return ''
      }
      if (args[0] === 'dashboard' && args[1] === '--stop') {
        running = false
        return ''
      }
      return ''
    },
    launch(args) { launches.push([...args]) },
    probe: async () => running,
    log: () => undefined,
  })
  return { instance, calls, launches, values }
}

describe('DashboardSupervisor', () => {
  it('configures the requested default credentials and starts an unavailable dashboard', async () => {
    const value = supervisor()
    await value.instance.checkNow()

    expect(value.values['dashboard.basic_auth.username']).toBe(DEFAULT_DASHBOARD_USERNAME)
    expect(value.values['dashboard.basic_auth.password_hash']).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(value.values['dashboard.basic_auth.secret']).toMatch(/.{32,}/)
    expect(value.launches).toEqual([['dashboard', '--host', '127.0.0.1', '--no-open']])
  })

  it('does not overwrite configured dashboard credentials', async () => {
    const value = supervisor({
      running: true,
      values: {
        'dashboard.basic_auth.username': 'operator',
        'dashboard.basic_auth.password_hash': 'scrypt$existing',
        'dashboard.basic_auth.secret': 'configured-secret',
      },
    })
    await value.instance.checkNow()

    expect(value.calls.filter((args) => args[1] === 'set')).toEqual([])
    expect(value.launches).toEqual([])
  })

  it('restarts a running dashboard after filling missing authentication and uses LAN binding when enabled', async () => {
    const value = supervisor({ running: true, allowLan: true })
    await value.instance.checkNow()

    expect(value.calls).toContainEqual(['dashboard', '--stop'])
    expect(value.launches).toEqual([['dashboard', '--host', '0.0.0.0', '--no-open']])
  })
})
