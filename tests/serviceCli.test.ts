import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { bootstrapLaunchAgent, isMainModule, launchAgentPlist } from '../bin/hermes-yaoyao.mjs'

describe('hermes-yaoyao LaunchAgent plist', () => {
  it('includes the local Hermes CLI directory in PATH', () => {
    const plist = launchAgentPlist()

    expect(plist).toContain(`${join(homedir(), '.local', 'bin')}:`)
  })

  it('enables Dashboard supervision by default', () => {
    expect(launchAgentPlist()).toContain('<key>HERMES_YAOYAO_SUPERVISE_DASHBOARD</key>')
  })

  it('binds managed Web and Dashboard services to the trusted LAN by default', () => {
    const plist = launchAgentPlist({ environment: {} })

    expect(plist).toContain('<key>HERMES_YAOYAO_HOST</key>\n      <string>0.0.0.0</string>')
    expect(plist).toContain('<key>HERMES_YAOYAO_ALLOW_INSECURE_LAN</key>\n      <string>1</string>')
    expect(plist).toContain('<key>HERMES_YAOYAO_SUPERVISE_DASHBOARD</key>\n      <string>1</string>')
  })

  it('keeps the managed installation on LAN even with stale loopback environment', () => {
    const plist = launchAgentPlist({
      environment: {
        HERMES_YAOYAO_HOST: '127.0.0.1',
        HERMES_YAOYAO_ALLOW_INSECURE_LAN: '0',
      },
    })

    expect(plist).toContain('<key>HERMES_YAOYAO_HOST</key>\n      <string>0.0.0.0</string>')
    expect(plist).toContain('<key>HERMES_YAOYAO_ALLOW_INSECURE_LAN</key>\n      <string>1</string>')
  })

  it('preserves APNs provider settings in the LaunchAgent', () => {
    const plist = launchAgentPlist({
      environment: {
        HERMES_YAOYAO_APNS_KEY_FILE: '/Users/test/AuthKey_ABC123.p8',
        HERMES_YAOYAO_APNS_KEY_ID: 'ABC123',
        HERMES_YAOYAO_APNS_TEAM_ID: 'TEAM123',
        HERMES_YAOYAO_APNS_TOPIC: 'cn.samien.yaoyao.hermes',
      },
    })

    expect(plist).toContain('<key>HERMES_YAOYAO_APNS_KEY_FILE</key>')
    expect(plist).toContain('/Users/test/AuthKey_ABC123.p8')
    expect(plist).toContain('<key>HERMES_YAOYAO_APNS_KEY_ID</key>')
    expect(plist).toContain('<key>HERMES_YAOYAO_APNS_TEAM_ID</key>')
    expect(plist).toContain('<key>HERMES_YAOYAO_APNS_TOPIC</key>')
  })

  it('preserves FCM provider settings in the LaunchAgent', () => {
    const plist = launchAgentPlist({
      environment: {
        HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE: '/Users/test/firebase-service-account.json',
        HERMES_YAOYAO_FCM_PROJECT_ID: 'yaoyao-test-project',
        HERMES_YAOYAO_FCM_PACKAGE_NAME: 'cn.samien.yaoyao.hermes',
      },
    })

    expect(plist).toContain('<key>HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE</key>')
    expect(plist).toContain('/Users/test/firebase-service-account.json')
    expect(plist).toContain('<key>HERMES_YAOYAO_FCM_PROJECT_ID</key>')
    expect(plist).toContain('yaoyao-test-project')
    expect(plist).toContain('<key>HERMES_YAOYAO_FCM_PACKAGE_NAME</key>')
    expect(plist).toContain('cn.samien.yaoyao.hermes')
  })

  it('can point the managed service at the stable current release link', () => {
    const root = join(homedir(), '.local', 'share', 'hermes-yaoyao', 'current')
    const plist = launchAgentPlist({ serviceRoot: root })

    expect(plist).toContain(`<string>${join(root, 'dist-server', 'server', 'index.js')}</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${root}</string>`)
  })

  it('runs the CLI when its entry path uses the stable current symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-service-cli-'))
    const entry = join(root, 'hermes-yaoyao.mjs')
    symlinkSync(join(process.cwd(), 'bin', 'hermes-yaoyao.mjs'), entry)
    try {
      expect(isMainModule(entry)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retries the transient launchctl bootstrap race after bootout', async () => {
    const error = Object.assign(new Error('launchctl bootstrap failed'), {
      stderr: 'Bootstrap failed: 5: Input/output error',
    })
    const run = vi.fn()
      .mockImplementationOnce(() => { throw error })
      .mockReturnValue('')
    const wait = vi.fn(async () => {})

    await expect(bootstrapLaunchAgent(run, wait)).resolves.toBe('')
    expect(run).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(250)
  })

  it('keeps retrying until a slow launchd removal finishes', async () => {
    const error = Object.assign(new Error('launchctl bootstrap failed'), {
      stderr: 'Bootstrap failed: 5: Input/output error',
    })
    let elapsedMs = 0
    const run = vi.fn(() => {
      if (elapsedMs < 5_000) throw error
      return ''
    })
    const wait = vi.fn(async (waitMs: number) => { elapsedMs += waitMs })

    await expect(bootstrapLaunchAgent(run, wait, {
      timeoutMs: 20_000,
      now: () => elapsedMs,
    })).resolves.toBe('')
    expect(elapsedMs).toBeGreaterThanOrEqual(5_000)
    expect(run).toHaveBeenCalledTimes(6)
    expect(wait.mock.calls.map(([waitMs]) => waitMs)).toEqual([250, 500, 1_000, 2_000, 2_000])
  })

  it('stops retrying a transient launchctl error at the deadline', async () => {
    const error = Object.assign(new Error('launchctl bootstrap failed'), {
      stderr: 'Bootstrap failed: 5: Input/output error',
    })
    let elapsedMs = 0
    const run = vi.fn(() => { throw error })
    const wait = vi.fn(async (waitMs: number) => { elapsedMs += waitMs })

    await expect(bootstrapLaunchAgent(run, wait, {
      timeoutMs: 2_000,
      now: () => elapsedMs,
    })).rejects.toThrow(error)
    expect(elapsedMs).toBe(2_000)
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('does not retry permanent launchctl bootstrap failures', async () => {
    const error = new Error('Bootstrap failed: 125: Domain does not support specified action')
    const run = vi.fn(() => { throw error })
    const wait = vi.fn(async () => {})

    await expect(bootstrapLaunchAgent(run, wait)).rejects.toThrow(error)
    expect(run).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
