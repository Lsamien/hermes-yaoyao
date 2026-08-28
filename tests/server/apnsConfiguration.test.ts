import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APNsConfigurationManager,
  apnsConfigurationPath,
  loadAPNsConfiguration,
  validateAPNsConfiguration,
} from '../../src/server/apnsConfiguration.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

function ecKey(path: string, mode = 0o600): void {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(path, privateKey, { mode })
  chmodSync(path, mode)
}

function input(keyFile: string) {
  return {
    keyFile,
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    topic: 'cn.samien.yaoyao.hermes',
    environments: ['development', 'production'] as const,
  }
}

describe('APNs Web-managed configuration', () => {
  it('persists a validated local path atomically and treats broad key permissions as a warning', async () => {
    const home = temporaryRoot('yaoyao-apns-config')
    const keyFile = join(home, 'AuthKey_TEST.p8')
    ecKey(keyFile, 0o644)
    const probe = vi.fn(async () => undefined)
    const manager = new APNsConfigurationManager(
      home,
      { source: 'none', editable: true, warnings: [] },
      { probe },
    )
    const apply = vi.fn()

    const result = await manager.update(input(keyFile), apply)
    const canonicalKeyFile = realpathSync(keyFile)

    expect(result).toMatchObject({
      source: 'file',
      editable: true,
      config: { keyFile: canonicalKeyFile, keyId: 'KEY1234567' },
      warnings: [{ code: 'apns_key_permissions', actualMode: '0644', recommendedMode: '0600' }],
    })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ keyFile: canonicalKeyFile }), ['development', 'production'])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(statSync(apnsConfigurationPath(home)).mode & 0o777).toBe(0o600)
    expect(loadAPNsConfiguration(home, {})).toMatchObject({ source: 'file', editable: true, config: { keyFile: canonicalKeyFile } })
  })

  it('accepts stricter 0400 permissions without warning and rejects invalid key material', () => {
    const home = temporaryRoot('yaoyao-apns-permissions')
    const keyFile = join(home, 'AuthKey_TEST.p8')
    ecKey(keyFile, 0o400)
    expect(validateAPNsConfiguration(input(keyFile)).warnings).toEqual([])
    expect(() => validateAPNsConfiguration({
      ...input(keyFile), topic: 'cn.samien.another-app',
    })).toThrow(/topic must be cn\.samien\.yaoyao\.hermes/)

    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const invalid = join(home, 'not-ec.p8')
    writeFileSync(invalid, privateKey, { mode: 0o600 })
    expect(() => validateAPNsConfiguration(input(invalid))).toThrow(/ES256/)
    expect(() => validateAPNsConfiguration(input(join(home, 'missing.p8')))).toThrow(/cannot read/)

    const fifo = join(home, 'named-pipe.p8')
    execFileSync('mkfifo', [fifo])
    expect(() => validateAPNsConfiguration(input(fifo))).toThrow(/private key file/)

    const configurationHome = temporaryRoot('yaoyao-apns-config-fifo')
    mkdirSync(join(configurationHome, 'push'), { recursive: true })
    execFileSync('mkfifo', [apnsConfigurationPath(configurationHome)])
    expect(loadAPNsConfiguration(configurationHome, {})).toMatchObject({
      source: 'file', editable: true, configurationError: 'APNs configuration path is not a regular file',
    })
  })

  it('gives any APNs environment variable priority over a valid Web file', async () => {
    const home = temporaryRoot('yaoyao-apns-env-priority')
    const keyFile = join(home, 'AuthKey_TEST.p8')
    ecKey(keyFile)
    const manager = new APNsConfigurationManager(home, { source: 'none', editable: true, warnings: [] }, {
      probe: async () => undefined,
    })
    await manager.update(input(keyFile), () => undefined)

    const loaded = loadAPNsConfiguration(home, { HERMES_YAOYAO_APNS_TOPIC: 'cn.samien.yaoyao.hermes' })
    expect(loaded).toMatchObject({ source: 'environment', editable: false })
    expect(loaded.config).toBeUndefined()
    expect(loaded.configurationError).toMatch(/absolute local path/)
  })

  it('keeps the previous file and runtime when a replacement probe fails', async () => {
    const home = temporaryRoot('yaoyao-apns-rollback')
    const keyFile = join(home, 'AuthKey_TEST.p8')
    ecKey(keyFile)
    let reject = false
    const manager = new APNsConfigurationManager(home, { source: 'none', editable: true, warnings: [] }, {
      probe: async () => {
        if (reject) throw new Error('probe rejected')
      },
    })
    const apply = vi.fn()
    await manager.update(input(keyFile), apply)
    const before = readFileSync(apnsConfigurationPath(home))
    reject = true

    await expect(manager.update({ ...input(keyFile), keyId: 'REPLACED01' }, apply)).rejects.toThrow('probe rejected')
    expect(readFileSync(apnsConfigurationPath(home))).toEqual(before)
    expect(manager.snapshot().input?.keyId).toBe('KEY1234567')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('refuses Web changes when environment variables own the configuration', async () => {
    const home = temporaryRoot('yaoyao-apns-managed')
    const keyFile = join(home, 'AuthKey_TEST.p8')
    ecKey(keyFile)
    const initial = loadAPNsConfiguration(home, {
      HERMES_YAOYAO_APNS_KEY_FILE: keyFile,
      HERMES_YAOYAO_APNS_KEY_ID: 'KEY1234567',
      HERMES_YAOYAO_APNS_TEAM_ID: 'TEAM123456',
      HERMES_YAOYAO_APNS_TOPIC: 'cn.samien.yaoyao.hermes',
    })
    const manager = new APNsConfigurationManager(home, initial, { probe: async () => undefined })

    await expect(manager.update(input(keyFile), () => undefined)).rejects.toMatchObject({
      status: 409,
      code: 'apns_environment_managed',
    })
  })
})
