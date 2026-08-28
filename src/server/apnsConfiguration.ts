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
import { APNsProvider, type APNsEnvironment, type APNsSendResult } from './apns.js'
import type { APNsProviderConfig } from './config.js'
import { HttpError } from './errors.js'

export type APNsConfigurationSource = 'none' | 'file' | 'environment'
export const DEFAULT_APNS_TOPIC = 'cn.samien.yaoyao.hermes'

export interface APNsConfigurationInput {
  keyFile: string
  keyId: string
  teamId: string
  topic: string
  environments: APNsEnvironment[]
}

export interface APNsConfigurationWarning {
  code: 'apns_key_permissions'
  message: string
  actualMode: string
  recommendedMode: '0600'
}

export interface APNsConfigurationSnapshot {
  source: APNsConfigurationSource
  editable: boolean
  input?: APNsConfigurationInput
  config?: APNsProviderConfig
  warnings: APNsConfigurationWarning[]
  configurationError?: string
}

export interface APNsConfigurationManagerOptions {
  probe?: APNsConfigurationProbe
}

export type APNsConfigurationProbe = (
  config: APNsProviderConfig,
  environments: readonly APNsEnvironment[],
) => Promise<void>

interface StoredAPNsConfiguration extends APNsConfigurationInput {
  schemaVersion: 1
  enabled: true
  updatedAt: string
}

const MAX_KEY_FILE_BYTES = 64 * 1_024
const MAX_CONFIGURATION_FILE_BYTES = 64 * 1_024
const DEFAULT_ENVIRONMENTS: APNsEnvironment[] = ['development', 'production']
const ACCEPTED_PROBE_REASON = 'BadDeviceToken'

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function canonicalEnvironments(value: unknown): APNsEnvironment[] {
  const requested = Array.isArray(value) ? value : DEFAULT_ENVIRONMENTS
  const environments: APNsEnvironment[] = []
  for (const candidate of requested) {
    if (candidate !== 'development' && candidate !== 'production') {
      throw new HttpError(400, 'APNs environment must be development or production', 'invalid_apns_configuration')
    }
    if (!environments.includes(candidate)) environments.push(candidate)
  }
  if (environments.length === 0) {
    throw new HttpError(400, 'At least one APNs environment is required', 'invalid_apns_configuration')
  }
  return environments
}

function canonicalInput(value: Partial<APNsConfigurationInput>): APNsConfigurationInput {
  const keyFile = clean(value.keyFile)
  const keyId = clean(value.keyId)
  const teamId = clean(value.teamId)
  const topic = clean(value.topic)
  if (!keyFile || !isAbsolute(keyFile) || keyFile.length > 4_096 || /[\u0000-\u001f\u007f]/.test(keyFile)) {
    throw new HttpError(400, 'APNs key file must be an absolute local path', 'invalid_apns_key_file')
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(keyId)) {
    throw new HttpError(400, 'APNs Key ID is invalid', 'invalid_apns_key_id')
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(teamId)) {
    throw new HttpError(400, 'APNs Team ID is invalid', 'invalid_apns_team_id')
  }
  if (!topic || topic.length > 255 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(topic)) {
    throw new HttpError(400, 'APNs topic is invalid', 'invalid_apns_topic')
  }
  if (topic !== DEFAULT_APNS_TOPIC) {
    throw new HttpError(400, `APNs topic must be ${DEFAULT_APNS_TOPIC}`, 'invalid_apns_topic')
  }
  return {
    keyFile,
    keyId,
    teamId,
    topic,
    environments: canonicalEnvironments(value.environments),
  }
}

export function validateAPNsConfiguration(
  value: Partial<APNsConfigurationInput>,
): APNsConfigurationSnapshot {
  const requested = canonicalInput(value)
  let keyFile: string
  let encoded: Buffer
  let mode: number
  let descriptor: number | undefined
  try {
    keyFile = realpathSync(resolve(requested.keyFile))
    descriptor = openSync(keyFile, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const details = fstatSync(descriptor)
    if (!details.isFile() || details.size < 1 || details.size > MAX_KEY_FILE_BYTES) {
      throw new HttpError(400, 'APNs key path must reference a readable private key file', 'invalid_apns_key_file')
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
      '8800 cannot read the APNs key file; check the local path and service account permissions',
      'invalid_apns_key_file',
    )
  }
  let key
  try { key = createPrivateKey(encoded) } catch {
    throw new HttpError(400, 'APNs key file must contain an ES256 private key', 'invalid_apns_private_key')
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new HttpError(400, 'APNs key file must contain an ES256 private key', 'invalid_apns_private_key')
  }
  const actualMode = mode.toString(8).padStart(4, '0')
  const warnings: APNsConfigurationWarning[] = (mode & ~0o600) !== 0
    ? [{
        code: 'apns_key_permissions',
        message: `APNs 已启用，但密钥文件权限为 ${actualMode}，建议调整为 0600；此提示不会影响当前推送。`,
        actualMode,
        recommendedMode: '0600',
      }]
    : []
  const input = { ...requested, keyFile }
  return {
    source: 'file',
    editable: true,
    input,
    config: { ...input },
    warnings,
  }
}

function environmentInput(env: NodeJS.ProcessEnv): { present: boolean; input: APNsConfigurationInput } {
  const raw = {
    keyFile: clean(env.HERMES_YAOYAO_APNS_KEY_FILE),
    keyId: clean(env.HERMES_YAOYAO_APNS_KEY_ID),
    teamId: clean(env.HERMES_YAOYAO_APNS_TEAM_ID),
    topic: clean(env.HERMES_YAOYAO_APNS_TOPIC) || DEFAULT_APNS_TOPIC,
    environments: DEFAULT_ENVIRONMENTS,
  }
  return {
    present: Boolean(
      env.HERMES_YAOYAO_APNS_KEY_FILE?.trim()
      || env.HERMES_YAOYAO_APNS_KEY_ID?.trim()
      || env.HERMES_YAOYAO_APNS_TEAM_ID?.trim()
      || env.HERMES_YAOYAO_APNS_TOPIC?.trim(),
    ),
    input: raw,
  }
}

function storedInput(value: unknown): APNsConfigurationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('APNs configuration file must contain an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.enabled !== true) {
    throw new Error('Unsupported APNs configuration file')
  }
  return {
    keyFile: clean(record.keyFile),
    keyId: clean(record.keyId),
    teamId: clean(record.teamId),
    topic: clean(record.topic),
    environments: canonicalEnvironments(record.environments),
  }
}

export function apnsConfigurationPath(home: string): string {
  return join(home, 'push', 'apns-config.json')
}

function readConfigurationFile(path: string): Buffer {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  try {
    const details = fstatSync(descriptor)
    if (!details.isFile() || details.size < 1 || details.size > MAX_CONFIGURATION_FILE_BYTES) {
      throw new Error('APNs configuration path is not a regular file')
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function loadAPNsConfiguration(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): APNsConfigurationSnapshot {
  const fromEnvironment = environmentInput(env)
  if (fromEnvironment.present) {
    try {
      const validated = validateAPNsConfiguration(fromEnvironment.input)
      return { ...validated, source: 'environment', editable: false }
    } catch (cause) {
      return {
        source: 'environment',
        editable: false,
        input: fromEnvironment.input,
        warnings: [],
        configurationError: cause instanceof Error ? cause.message : 'APNs environment configuration is invalid',
      }
    }
  }
  const path = apnsConfigurationPath(home)
  if (!existsSync(path)) return { source: 'none', editable: true, warnings: [] }
  try {
    const input = storedInput(JSON.parse(readConfigurationFile(path).toString('utf8')))
    const validated = validateAPNsConfiguration(input)
    chmodSync(path, 0o600)
    return { ...validated, source: 'file', editable: true }
  } catch (cause) {
    return {
      source: 'file',
      editable: true,
      warnings: [],
      configurationError: cause instanceof Error ? cause.message : 'APNs configuration file is invalid',
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

async function defaultProbe(
  config: APNsProviderConfig,
  environments: readonly APNsEnvironment[],
): Promise<void> {
  const provider = new APNsProvider(config)
  try {
    for (const environment of environments) {
      const result: APNsSendResult = await provider.send({
        deviceToken: '00'.repeat(32),
        environment,
        payload: { aps: { 'content-available': 1 } },
        priority: 5,
        pushType: 'background',
      })
      if (result.reason === ACCEPTED_PROBE_REASON) continue
      if (result.disposition === 'retry') {
        throw new HttpError(503, 'Unable to connect to APNs; check outbound network access and retry', 'apns_probe_unavailable')
      }
      throw new HttpError(422, 'APNs rejected the provider credentials', 'apns_credentials_rejected')
    }
  } finally {
    provider.close()
  }
}

function cloneSnapshot(value: APNsConfigurationSnapshot): APNsConfigurationSnapshot {
  return {
    ...value,
    ...(value.input ? { input: { ...value.input, environments: [...value.input.environments] } } : {}),
    ...(value.config ? { config: { ...value.config, environments: [...(value.config.environments ?? DEFAULT_ENVIRONMENTS)] } } : {}),
    warnings: value.warnings.map(warning => ({ ...warning })),
  }
}

export class APNsConfigurationManager {
  readonly path: string
  readonly #probe: APNsConfigurationProbe
  #snapshot: APNsConfigurationSnapshot
  #operation: Promise<void> = Promise.resolve()

  constructor(
    home: string,
    initial: APNsConfigurationSnapshot,
    options: APNsConfigurationManagerOptions = {},
  ) {
    this.path = apnsConfigurationPath(home)
    this.#snapshot = cloneSnapshot(initial)
    this.#probe = options.probe ?? defaultProbe
  }

  snapshot(): APNsConfigurationSnapshot {
    return cloneSnapshot(this.#snapshot)
  }

  update(
    input: Partial<APNsConfigurationInput>,
    apply: (config: APNsProviderConfig) => void | Promise<void>,
  ): Promise<APNsConfigurationSnapshot> {
    const operation = this.#operation.then(() => this.#update(input, apply))
    this.#operation = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #update(
    input: Partial<APNsConfigurationInput>,
    apply: (config: APNsProviderConfig) => void | Promise<void>,
  ): Promise<APNsConfigurationSnapshot> {
    if (this.#snapshot.source === 'environment') {
      throw new HttpError(409, 'APNs configuration is managed by service environment variables', 'apns_environment_managed')
    }
    const validated = validateAPNsConfiguration(input)
    const config = validated.config!
    await this.#probe(config, validated.input!.environments)
    const previous = existsSync(this.path) ? readConfigurationFile(this.path) : undefined
    const stored: StoredAPNsConfiguration = {
      schemaVersion: 1,
      enabled: true,
      ...validated.input!,
      updatedAt: new Date().toISOString(),
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
