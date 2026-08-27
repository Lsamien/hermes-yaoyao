import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupPlugin, currentTarget, enabledPlugins, formatCommandFailure, restorePlugin, switchCurrent, validateManifest } from '../bin/hermes-yaoyao-updater.mjs'

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

  it('requests Hermes plugin configuration as JSON', () => {
    const calls: Array<{ command: string, args: string[] }> = []
    const plugins = enabledPlugins((command: string, args: string[]) => {
      calls.push({ command, args })
      return '["yaoyao", "other"]\n'
    })

    expect(plugins).toEqual(['yaoyao', 'other'])
    expect(calls).toEqual([{
      command: 'hermes',
      args: ['config', 'get', '--json', 'plugins.enabled'],
    }])
    expect(() => enabledPlugins(() => '- yaoyao\n')).toThrow('未返回有效 JSON')
  })

  it('backs up and restores plugin code without touching durable plugin data', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-updater-plugin-'))
    roots.push(root)
    const hermesHome = join(root, 'hermes')
    const dataHome = join(root, 'web-data')
    const dashboard = join(hermesHome, 'plugins', 'yaoyao', 'dashboard')
    const durable = join(hermesHome, 'plugin-data', 'yaoyao')
    mkdirSync(dashboard, { recursive: true })
    mkdirSync(durable, { recursive: true })
    writeFileSync(join(dashboard, 'manifest.json'), JSON.stringify({ version: '1.7.1' }))
    writeFileSync(join(dashboard, 'plugin.py'), 'old plugin')
    writeFileSync(join(hermesHome, 'plugins', 'yaoyao', 'plugin.yaml'), 'version: "1.7.1"\n')
    writeFileSync(join(durable, 'archive.db'), 'durable data')

    const backup = backupPlugin({ hermesHome, dataHome }, '11111111-1111-4111-8111-111111111111')
    writeFileSync(join(dashboard, 'plugin.py'), 'new plugin')
    restorePlugin(backup.pluginRoot, backup.backupRoot, 'restore', true)

    expect(readFileSync(join(dashboard, 'plugin.py'), 'utf8')).toBe('old plugin')
    expect(readFileSync(join(durable, 'archive.db'), 'utf8')).toBe('durable data')
  })
})
