import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { domainToASCII } from 'node:url'
import { HttpError } from './errors.js'

export type AllowedHostsConfigurationSource = 'none' | 'file' | 'environment'

export interface AllowedHostsConfigurationSnapshot {
  source: AllowedHostsConfigurationSource
  hosts: string[]
  editableHosts: string[]
  environmentHosts: string[]
  configurationError?: string
}

interface StoredAllowedHostsConfiguration {
  schemaVersion: 1
  hosts: string[]
  updatedAt: string
}

const MAX_CONFIGURATION_FILE_BYTES = 64 * 1_024
const MAX_ALLOWED_HOSTS = 128

export function normalizeAllowedHost(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/\.$/, '')
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (!value || value.length > 253 || /[\u0000-\u0020\u007f/@\\?#]/.test(value)) {
    throw new HttpError(400, '允许的访问地址必须是域名或 IP，不能包含协议、端口或路径', 'invalid_allowed_host')
  }
  if (isIP(value)) return value
  if (value.includes(':')) {
    throw new HttpError(400, '地址格式无效；域名和 IP 均不能附加端口', 'invalid_allowed_host')
  }
  const ascii = domainToASCII(value).toLowerCase().replace(/\.$/, '')
  const labels = ascii.split('.')
  if (!ascii || ascii.length > 253 || labels.some(label => (
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    throw new HttpError(400, '允许的访问域名格式无效', 'invalid_allowed_host')
  }
  return ascii
}

export function canonicalAllowedHosts(values: readonly string[]): string[] {
  if (values.length > MAX_ALLOWED_HOSTS) {
    throw new HttpError(400, `允许的访问地址最多 ${MAX_ALLOWED_HOSTS} 个`, 'too_many_allowed_hosts')
  }
  return [...new Set(values.map(normalizeAllowedHost))].sort()
}

export function allowedHostsConfigurationPath(home: string): string {
  return join(home, 'network', 'allowed-hosts.json')
}

function readStoredHosts(path: string): string[] {
  const descriptor = openSync(path, 'r')
  try {
    const file = fstatSync(descriptor)
    if (!file.isFile() || file.size < 1 || file.size > MAX_CONFIGURATION_FILE_BYTES) {
      throw new Error('Allowed hosts configuration file has an invalid size')
    }
    const value = JSON.parse(readFileSync(descriptor).toString('utf8')) as Partial<StoredAllowedHostsConfiguration>
    if (value.schemaVersion !== 1 || !Array.isArray(value.hosts)
      || value.hosts.some(host => typeof host !== 'string')) {
      throw new Error('Unsupported allowed hosts configuration file')
    }
    return canonicalAllowedHosts(value.hosts as string[])
  } finally {
    closeSync(descriptor)
  }
}

export function loadAllowedHostsConfiguration(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): AllowedHostsConfigurationSnapshot {
  let environmentHosts: string[] = []
  try {
    environmentHosts = canonicalAllowedHosts(
      (env.HERMES_YAOYAO_ALLOWED_HOSTS ?? '').split(',').filter(value => value.trim()),
    )
  } catch (cause) {
    return {
      source: 'environment',
      hosts: [],
      editableHosts: [],
      environmentHosts: [],
      configurationError: cause instanceof Error ? cause.message : '允许的访问地址环境变量无效',
    }
  }
  const path = allowedHostsConfigurationPath(home)
  if (!existsSync(path)) {
    return {
      source: environmentHosts.length ? 'environment' : 'none',
      hosts: [...environmentHosts],
      editableHosts: [],
      environmentHosts,
    }
  }
  try {
    const editableHosts = readStoredHosts(path)
    chmodSync(path, 0o600)
    return {
      source: 'file',
      hosts: canonicalAllowedHosts([...environmentHosts, ...editableHosts]),
      editableHosts,
      environmentHosts,
    }
  } catch (cause) {
    return {
      source: 'file',
      hosts: [...environmentHosts],
      editableHosts: [],
      environmentHosts,
      configurationError: cause instanceof Error ? cause.message : '允许的访问地址配置文件无效',
    }
  }
}

function writeAtomic(path: string, value: string): void {
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

function cloneSnapshot(value: AllowedHostsConfigurationSnapshot): AllowedHostsConfigurationSnapshot {
  return {
    ...value,
    hosts: [...value.hosts],
    editableHosts: [...value.editableHosts],
    environmentHosts: [...value.environmentHosts],
  }
}

export class AllowedHostsConfigurationManager {
  readonly path: string
  readonly #runtimeHosts: Set<string>
  #snapshot: AllowedHostsConfigurationSnapshot

  constructor(home: string, initial: AllowedHostsConfigurationSnapshot, runtimeHosts: Set<string>) {
    this.path = allowedHostsConfigurationPath(home)
    this.#snapshot = cloneSnapshot(initial)
    this.#runtimeHosts = runtimeHosts
    this.#applyRuntimeHosts(initial.hosts)
  }

  snapshot(): AllowedHostsConfigurationSnapshot {
    return cloneSnapshot(this.#snapshot)
  }

  update(hosts: readonly string[]): AllowedHostsConfigurationSnapshot {
    const editableHosts = canonicalAllowedHosts(hosts)
    const effectiveHosts = canonicalAllowedHosts([
      ...this.#snapshot.environmentHosts,
      ...editableHosts,
    ])
    const stored: StoredAllowedHostsConfiguration = {
      schemaVersion: 1,
      hosts: editableHosts,
      updatedAt: new Date().toISOString(),
    }
    writeAtomic(this.path, `${JSON.stringify(stored, null, 2)}\n`)
    this.#snapshot = {
      source: 'file',
      hosts: effectiveHosts,
      editableHosts,
      environmentHosts: [...this.#snapshot.environmentHosts],
    }
    this.#applyRuntimeHosts(effectiveHosts)
    return this.snapshot()
  }

  #applyRuntimeHosts(hosts: readonly string[]): void {
    this.#runtimeHosts.clear()
    for (const host of hosts) this.#runtimeHosts.add(host)
  }
}
