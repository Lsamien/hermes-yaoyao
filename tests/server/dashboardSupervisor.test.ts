import { describe, expect, it } from 'vitest'
import { DashboardSupervisor } from '../../src/server/dashboardSupervisor.js'

function supervisor(initiallyRunning = false) {
  let running = initiallyRunning
  const calls: string[][] = [], launches: string[][] = [], probes: string[] = []
  const instance = new DashboardSupervisor({
    run(args) {
      calls.push([...args])
      if (args[0] === 'dashboard' && args[1] === '--stop') running = false
      return ''
    },
    launch(args) { launches.push([...args]); running = true },
    probe: async (host, port) => { probes.push(host + ':' + port); return running },
    log: () => undefined,
  })
  return { instance, calls, launches, probes }
}

describe('DashboardSupervisor', () => {
  it('starts a missing service on loopback without reading or writing authentication config', async () => {
    const f = supervisor()
    await f.instance.checkNow()
    expect(f.calls).toEqual([])
    expect(f.launches).toEqual([['dashboard', '--host', '127.0.0.1', '--no-open']])
    await f.instance.checkNow()
    expect(f.launches).toHaveLength(1)
  })
  it('leaves an existing service and its authentication/binding untouched', async () => {
    const f = supervisor(true)
    await f.instance.checkNow(); await f.instance.checkNow()
    expect(f.calls).toEqual([])
    expect(f.launches).toEqual([])
    expect(new Set(f.probes)).toEqual(new Set(['127.0.0.1:9119']))
  })
  it('only restarts on an explicit request, without configuring any credentials', async () => {
    const f = supervisor(true)
    await f.instance.restart()
    expect(f.calls).toEqual([['dashboard', '--stop']])
    expect(f.launches).toEqual([['dashboard', '--host', '127.0.0.1', '--no-open']])
  })
  it('coalesces concurrent checks', async () => {
    const f = supervisor()
    await Promise.all([f.instance.checkNow(), f.instance.checkNow()])
    expect(f.launches).toHaveLength(1)
  })
})
