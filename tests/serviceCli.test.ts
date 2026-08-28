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

  it('does not retry permanent launchctl bootstrap failures', async () => {
    const error = new Error('Bootstrap failed: 125: Domain does not support specified action')
    const run = vi.fn(() => { throw error })
    const wait = vi.fn(async () => {})

    await expect(bootstrapLaunchAgent(run, wait)).rejects.toThrow(error)
    expect(run).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
