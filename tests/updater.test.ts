import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentTarget, formatCommandFailure, switchCurrent, validateManifest } from '../bin/hermes-yaoyao-updater.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('standalone updater primitives', () => {
  it('atomically switches the stable current symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-updater-'))
    roots.push(root)
    const first = join(root, 'releases', '0.2.0-a')
    const second = join(root, 'releases', '0.3.0-b')
    switchCurrent(root, first, 'first')
    expect(currentTarget(root)).toBe(first)
    switchCurrent(root, second, 'second')
    expect(currentTarget(root)).toBe(second)
    expect(lstatSync(join(root, 'current')).isSymbolicLink()).toBe(true)
  })

  it('rejects a mismatched release manifest before any service transition', () => {
    expect(() => validateManifest({
      schemaVersion: 1,
      releaseVersion: '0.3.0',
      webVersion: '0.3.1',
      pluginVersion: '1.8.0',
      gitTag: 'v0.3.0',
    })).toThrow('版本组合不一致')
  })

  it('keeps useful command output while redacting credentials', () => {
    const error = Object.assign(new Error('Command failed'), {
      status: 127,
      stdout: '\u001B[31m发布版本校验通过\u001B[0m',
      stderr: 'https://secret@example.test/release.git\nsh: vue-tsc: command not found',
    })

    const message = formatCommandFailure('npm', ['run', 'build'], error)
    expect(message).toContain('npm run build 失败，退出码 127')
    expect(message).toContain('发布版本校验通过')
    expect(message).toContain('https://***@example.test/release.git')
    expect(message).toContain('vue-tsc: command not found')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('\u001B')
  })

})
