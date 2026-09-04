import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeServer, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { PushCoordinator } from '../../src/server/pushCoordinator.js'

import { createAuthenticatedApplication } from './authenticatedApplication.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dynamic push runtime', () => {
  it('starts and stops background observers when Web configuration changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-runtime-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const push = new PushCoordinator({
      home,
      autoFlush: false,
      providerFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }),
      fcmProviderFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }),
    })
    const runtime = createAuthenticatedApplication({ config, push })
    const chatStart = vi.spyOn(runtime.chatPushJobs, 'start').mockImplementation(() => undefined)
    const chatStop = vi.spyOn(runtime.chatPushJobs, 'stop').mockImplementation(() => undefined)
    expect(runtime).not.toHaveProperty('groupPushEvents')
    const node = createNodeServer(runtime)

    expect(chatStop).toHaveBeenCalledTimes(1)
    await push.configureAPNs({
      keyFile: '/private/unused.p8', keyId: 'KEY1234567', teamId: 'TEAM123456',
      topic: 'cn.samien.yaoyao.hermes', environments: ['development'],
    })
    expect(chatStart).toHaveBeenCalledTimes(1)
    await push.configureAPNs()
    expect(chatStop).toHaveBeenCalledTimes(2)

    await push.configureFCM({
      serviceAccountFile: '/private/unused.json',
      projectId: 'yaoyao-test-project',
      packageName: 'cn.samien.yaoyao.hermes',
    })
    expect(chatStart).toHaveBeenCalledTimes(2)
    await push.configureFCM()
    expect(chatStop).toHaveBeenCalledTimes(3)

    await node.close()
  })
})
