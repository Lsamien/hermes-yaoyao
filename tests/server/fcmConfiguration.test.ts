import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FCMConfigurationManager,
  fcmConfigurationPath,
  loadFCMConfiguration,
  validateFCMConfiguration,
} from '../../src/server/fcmConfiguration.js'
import { HttpError } from '../../src/server/errors.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(mode = 0o600) {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-fcm-config-'))
  roots.push(home)
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const serviceAccountFile = join(home, 'service-account.json')
  writeFileSync(serviceAccountFile, JSON.stringify({
    type: 'service_account',
    project_id: 'yaoyao-test-project',
    client_email: 'push@yaoyao-test-project.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  }), { mode })
  chmodSync(serviceAccountFile, mode)
  return { home, serviceAccountFile }
}

describe('FCM configuration', () => {
  it('validates the project, RSA credentials, package, and file permissions without copying secrets', async () => {
    const { home, serviceAccountFile } = fixture(0o644)
    const input = {
      serviceAccountFile,
      projectId: 'yaoyao-test-project',
      packageName: 'cn.samien.yaoyao.hermes',
    }
    const validated = validateFCMConfiguration(input)
    expect(validated).toMatchObject({
      source: 'file',
      editable: true,
      warnings: [{ code: 'fcm_service_account_permissions', actualMode: '0644', recommendedMode: '0600' }],
    })
    const manager = new FCMConfigurationManager(
      home,
      { source: 'none', editable: true, warnings: [] },
      { probe: async () => undefined },
    )
    await expect(manager.update(input, () => undefined)).resolves.toMatchObject({ source: 'file' })
    const stored = readFileSync(fcmConfigurationPath(home), 'utf8')
    expect(stored).toContain(serviceAccountFile)
    expect(stored).toContain('yaoyao-test-project')
    expect(stored).not.toContain('private_key')
    expect(statSync(fcmConfigurationPath(home)).mode & 0o777).toBe(0o600)
  })

  it('keeps environment configuration read-only and reports partial configuration safely', async () => {
    const { home, serviceAccountFile } = fixture()
    const loaded = loadFCMConfiguration(home, {
      HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE: serviceAccountFile,
      HERMES_YAOYAO_FCM_PROJECT_ID: 'yaoyao-test-project',
    })
    expect(loaded).toMatchObject({ source: 'environment', editable: false, config: { projectId: 'yaoyao-test-project' } })
    const manager = new FCMConfigurationManager(home, loaded, { probe: async () => undefined })
    await expect(manager.update(loaded.input!, () => undefined)).rejects.toMatchObject({
      status: 409,
      code: 'fcm_environment_managed',
    })

    const partial = loadFCMConfiguration(home, { HERMES_YAOYAO_FCM_PROJECT_ID: 'yaoyao-test-project' })
    expect(partial).toMatchObject({ source: 'environment', editable: false })
    expect(partial.configurationError).toMatch(/absolute local path/)
  })

  it('preserves an unavailable-provider status instead of misreporting it as rejected credentials', async () => {
    const { home, serviceAccountFile } = fixture()
    const manager = new FCMConfigurationManager(
      home,
      { source: 'none', editable: true, warnings: [] },
      { probe: async () => { throw new HttpError(503, 'FCM unavailable', 'fcm_probe_unavailable') } },
    )

    await expect(manager.update({
      serviceAccountFile,
      projectId: 'yaoyao-test-project',
      packageName: 'cn.samien.yaoyao.hermes',
    }, () => undefined)).rejects.toMatchObject({ status: 503, code: 'fcm_probe_unavailable' })
  })
})
