import { createPrivateKey, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { FCMProviderConfig } from './config.js'
import { FCMProbeError, FCMProvider } from './fcm.js'
import { HttpError } from './errors.js'

export type FCMConfigurationSource = 'none' | 'file' | 'environment'
export const DEFAULT_FCM_PACKAGE_NAME = 'cn.samien.yaoyao.hermes'

export interface FCMConfigurationInput {
  serviceAccountFile: string
  projectId: string
  packageName: string
}

export interface FCMConfigurationWarning {
  code: 'fcm_service_account_permissions'
  message: string
  actualMode: string
  recommendedMode: '0600'
}

export interface FCMConfigurationSnapshot {
  source: FCMConfigurationSource
  editable: boolean
  input?: FCMConfigurationInput
  config?: FCMProviderConfig
  warnings: FCMConfigurationWarning[]
  configurationError?: string
}

export type FCMConfigurationProbe = (config: FCMProviderConfig) => Promise<void>

export interface FCMConfigurationManagerOptions {
  probe?: FCMConfigurationProbe
}

interface StoredFCMConfiguration extends FCMConfigurationInput {
  schemaVersion: 1
  enabled: true
  updatedAt: string
}

const MAX_SERVICE_ACCOUNT_BYTES = 128 * 1_024
const MAX_CONFIGURATION_FILE_BYTES = 64 * 1_024

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function canonicalInput(value: Partial<FCMConfigurationInput>): FCMConfigurationInput {
  const serviceAccountFile = clean(value.serviceAccountFile)
  const projectId = clean(value.projectId)
  const packageName = clean(value.packageName) || DEFAULT_FCM_PACKAGE_NAME
  if (!serviceAccountFile || !isAbsolute(serviceAccountFile) || serviceAccountFile.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(serviceAccountFile)) {
    throw new HttpError(400, 'FCM service account file must be an absolute local path', 'invalid_fcm_service_account_file')
  }
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new HttpError(400, 'FCM project ID is invalid', 'invalid_fcm_project_id')
  }
  if (packageName !== DEFAULT_FCM_PACKAGE_NAME) {
    throw new HttpError(400, `FCM package name must be ${DEFAULT_FCM_PACKAGE_NAME}`, 'invalid_fcm_package_name')
  }
  return { serviceAccountFile, projectId, packageName }
}

export function validateFCMConfiguration(
  value: Partial<FCMConfigurationInput>,
): FCMConfigurationSnapshot {
  const requested = canonicalInput(value)
  let serviceAccountFile: string
  let encoded: Buffer
  let mode: number
  let descriptor: number | undefined
  try {
    serviceAccountFile = realpathSync(resolve(requested.serviceAccountFile))
    descriptor = openSync(serviceAccountFile, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const details = fstatSync(descriptor)
    if (!details.isFile() || details.size < 1 || details.size > MAX_SERVICE_ACCOUNT_BYTES) {
      throw new HttpError(400, 'FCM service account path must reference a readable JSON file', 'invalid_fcm_service_account_file')
    }
    encoded = readFileSync(descriptor)
    mode = details.mode & 0o777
    closeSync(descriptor)
    descriptor = undefined
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (cause instanceof HttpError) throw cause
    throw new HttpError(
      400,
      '8800 cannot read the FCM service account file; check the local path and service account permissions',
      'invalid_fcm_service_account_file',
    )
  }
  let credentials: Record<string, unknown>
  try {
    const value = JSON.parse(encoded.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    credentials = value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'FCM service account file must contain valid JSON', 'invalid_fcm_service_account_json')
  }
  if (clean(credentials.type) !== 'service_account'
    || !clean(credentials.client_email)
    || !clean(credentials.private_key)
    || !clean(credentials.token_uri)) {
    throw new HttpError(400, 'FCM service account credentials are incomplete', 'invalid_fcm_service_account')
  }
  if (clean(credentials.token_uri) !== 'https://oauth2.googleapis.com/token') {
    throw new HttpError(400, 'FCM OAuth token URI is invalid', 'invalid_fcm_token_uri')
  }
  if (clean(credentials.project_id) !== requested.projectId) {
    throw new HttpError(400, 'FCM project ID does not match the service account', 'fcm_project_id_mismatch')
  }
  let key
  try { key = createPrivateKey(clean(credentials.private_key)) } catch {
    throw new HttpError(400, 'FCM service account must contain an RSA private key', 'invalid_fcm_private_key')
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new HttpError(400, 'FCM service account must contain an RSA private key', 'invalid_fcm_private_key')
  }
  const actualMode = mode.toString(8).padStart(4, '0')
  const warnings: FCMConfigurationWarning[] = (mode & ~0o600) !== 0
    ? [{
        code: 'fcm_service_account_permissions',
        message: `FCM 已启用，但服务账号文件权限为 ${actualMode}，建议调整为 0600；此提示不会影响当前推送。`,
        actualMode,
        recommendedMode: '0600',
      }]
    : []
  const input = { ...requested, serviceAccountFile }
  return { source: 'file', editable: true, input, config: { ...input }, warnings }
}

function environmentInput(env: NodeJS.ProcessEnv): { present: boolean; input: FCMConfigurationInput } {
  const input = {
    serviceAccountFile: clean(env.HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE),
    projectId: clean(env.HERMES_YAOYAO_FCM_PROJECT_ID),
    packageName: clean(env.HERMES_YAOYAO_FCM_PACKAGE_NAME) || DEFAULT_FCM_PACKAGE_NAME,
  }
  return {
    present: Boolean(
      env.HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE?.trim()
      || env.HERMES_YAOYAO_FCM_PROJECT_ID?.trim()
      || env.HERMES_YAOYAO_FCM_PACKAGE_NAME?.trim(),
    ),
    input,
  }
}

function storedInput(value: unknown): FCMConfigurationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('FCM configuration file must contain an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.enabled !== true) throw new Error('Unsupported FCM configuration file')
  return {
    serviceAccountFile: clean(record.serviceAccountFile),
    projectId: clean(record.projectId),
    packageName: clean(record.packageName),
  }
}

export function fcmConfigurationPath(home: string): string {
  return join(home, 'push', 'fcm-config.json')
}

function readConfigurationFile(path: string): Buffer {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  try {
    const details = fstatSync(descriptor)
    if (!details.isFile() || details.size < 1 || details.size > MAX_CONFIGURATION_FILE_BYTES) {
      throw new Error('FCM configuration path is not a regular file')
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function loadFCMConfiguration(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): FCMConfigurationSnapshot {
  const fromEnvironment = environmentInput(env)
  if (fromEnvironment.present) {
    try {
      const validated = validateFCMConfiguration(fromEnvironment.input)
      return { ...validated, source: 'environment', editable: false }
    } catch (cause) {
      return {
        source: 'environment', editable: false, input: fromEnvironment.input, warnings: [],
        configurationError: cause instanceof Error ? cause.message : 'FCM environment configuration is invalid',
      }
    }
  }
  const path = fcmConfigurationPath(home)
  if (!existsSync(path)) return { source: 'none', editable: true, warnings: [] }
  try {
    const input = storedInput(JSON.parse(readConfigurationFile(path).toString('utf8')))
    const validated = validateFCMConfiguration(input)
    chmodSync(path, 0o600)
    return { ...validated, source: 'file', editable: true }
  } catch (cause) {
    return {
      source: 'file', editable: true, warnings: [],
      configurationError: cause instanceof Error ? cause.message : 'FCM configuration file is invalid',
    }
  }
}

function writeAtomic(path: string, value: Buffer | string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, value)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* already absent */ }
    throw cause
  }
}

async function defaultProbe(config: FCMProviderConfig): Promise<void> {
  const provider = new FCMProvider(config)
  try {
    await provider.probe()
  } catch (cause) {
    if (cause instanceof FCMProbeError && cause.result.disposition === 'retry') {
      throw new HttpError(
        503,
        'Unable to connect to FCM; check outbound network access and retry',
        'fcm_probe_unavailable',
      )
    }
    throw cause
  } finally {
    provider.close()
  }
}

function cloneSnapshot(value: FCMConfigurationSnapshot): FCMConfigurationSnapshot {
  return {
    ...value,
    ...(value.input ? { input: { ...value.input } } : {}),
    ...(value.config ? { config: { ...value.config } } : {}),
    warnings: value.warnings.map(warning => ({ ...warning })),
  }
}

export class FCMConfigurationManager {
  readonly path: string
  readonly #probe: FCMConfigurationProbe
  #snapshot: FCMConfigurationSnapshot
  #operation: Promise<void> = Promise.resolve()

  constructor(home: string, initial: FCMConfigurationSnapshot, options: FCMConfigurationManagerOptions = {}) {
    this.path = fcmConfigurationPath(home)
    this.#snapshot = cloneSnapshot(initial)
    this.#probe = options.probe ?? defaultProbe
  }

  snapshot(): FCMConfigurationSnapshot {
    return cloneSnapshot(this.#snapshot)
  }

  update(
    input: Partial<FCMConfigurationInput>,
    apply: (config: FCMProviderConfig) => void | Promise<void>,
  ): Promise<FCMConfigurationSnapshot> {
    const operation = this.#operation.then(() => this.#update(input, apply))
    this.#operation = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #update(
    input: Partial<FCMConfigurationInput>,
    apply: (config: FCMProviderConfig) => void | Promise<void>,
  ): Promise<FCMConfigurationSnapshot> {
    if (this.#snapshot.source === 'environment') {
      throw new HttpError(409, 'FCM configuration is managed by service environment variables', 'fcm_environment_managed')
    }
    const validated = validateFCMConfiguration(input)
    const config = validated.config!
    try {
      await this.#probe(config)
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError(
        422,
        `FCM credentials could not be verified: ${cause instanceof Error ? cause.message : 'unknown error'}`,
        'fcm_credentials_rejected',
      )
    }
    const previous = existsSync(this.path) ? readConfigurationFile(this.path) : undefined
    const stored: StoredFCMConfiguration = {
      schemaVersion: 1, enabled: true, ...validated.input!, updatedAt: new Date().toISOString(),
    }
    try {
      writeAtomic(this.path, `${JSON.stringify(stored, null, 2)}\n`)
      await apply(config)
    } catch (cause) {
      try {
        if (previous) writeAtomic(this.path, previous)
        else if (existsSync(this.path)) unlinkSync(this.path)
      } catch { /* preserve the primary configuration error */ }
      throw cause
    }
    this.#snapshot = { ...validated, source: 'file', editable: true }
    return this.snapshot()
  }
}
