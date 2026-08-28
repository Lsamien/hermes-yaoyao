import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeServer, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { PushCoordinator } from '../../src/server/pushCoordinator.js'
import {
  GroupPushEventWatcher,
  type GroupEventConnection,
  type GroupEventSource,
  type PushEventCoordinator,
} from '../../src/server/pushEvents.js'
import { createAuthenticatedApplication } from './authenticatedApplication.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dynamic push runtime', () => {
  it('closes a group connection that finishes opening after the watcher was stopped', async () => {
    const epoch = '11111111-1111-4111-8111-111111111111'
    let resolveConnection!: (connection: GroupEventConnection) => void
    const connection = { close: vi.fn() }
    const source: GroupEventSource = {
      currentAnchor: async () => ({ epoch, cursor: 0 }),
      connect: () => new Promise(resolve => { resolveConnection = resolve }),
    }
    const coordinator: PushEventCoordinator = {
      saveChatJob: () => undefined,
      completeChatJob: () => undefined,
      pendingChatJobs: () => [],
      enqueueNotification: () => 'ignored',
      groupWatchAnchor: () => ({ epoch, cursor: 0 }),
      groupSubscribers: () => [],
      advanceGroupCursor: () => undefined,
      resetGroupCursor: reset => ({ epoch: reset.epoch, cursor: reset.cursor }),
    }
    const watcher = new GroupPushEventWatcher(source, coordinator)
    watcher.start()
    await vi.waitFor(() => expect(resolveConnection).toBeTypeOf('function'))
    watcher.stop()
    resolveConnection(connection)
    await vi.waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1))
  })

  it('starts and stops background observers when Web configuration changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-push-runtime-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 8800, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const push = new PushCoordinator({
      home,
      autoFlush: false,
      providerFactory: () => ({ send: async () => ({ disposition: 'success', status: 200 }) }),
    })
    const runtime = createAuthenticatedApplication({ config, push })
    const chatStart = vi.spyOn(runtime.chatPushJobs, 'start').mockImplementation(() => undefined)
    const chatStop = vi.spyOn(runtime.chatPushJobs, 'stop').mockImplementation(() => undefined)
    const groupStart = vi.spyOn(runtime.groupPushEvents, 'start').mockImplementation(() => undefined)
    const groupStop = vi.spyOn(runtime.groupPushEvents, 'stop').mockImplementation(() => undefined)
    const node = createNodeServer(runtime)

    expect(chatStop).toHaveBeenCalledTimes(1)
    expect(groupStop).toHaveBeenCalledTimes(1)
    await push.configureAPNs({
      keyFile: '/private/unused.p8', keyId: 'KEY1234567', teamId: 'TEAM123456',
      topic: 'cn.samien.yaoyao.hermes', environments: ['development'],
    })
    expect(chatStart).toHaveBeenCalledTimes(1)
    expect(groupStart).toHaveBeenCalledTimes(1)
    await push.configureAPNs()
    expect(chatStop).toHaveBeenCalledTimes(2)
    expect(groupStop).toHaveBeenCalledTimes(2)

    await node.close()
  })
})
