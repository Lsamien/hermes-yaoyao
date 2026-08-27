import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMainModule, launchAgentPlist } from '../bin/hermes-yaoyao.mjs'

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
})
