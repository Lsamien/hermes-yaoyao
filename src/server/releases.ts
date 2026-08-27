import { readFileSync } from 'node:fs'

export interface ReleaseManifest {
  schemaVersion: 1
  releaseVersion: string
  webVersion: string
  pluginVersion: string
  gitTag: string
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function version(value: unknown, field: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`${field} 必须是有效的语义版本`)
  }
  return value
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release.json 必须是对象')
  }
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1) throw new Error('release.json schemaVersion 必须为 1')
  const releaseVersion = version(input.releaseVersion, 'releaseVersion')
  const webVersion = version(input.webVersion, 'webVersion')
  const pluginVersion = version(input.pluginVersion, 'pluginVersion')
  const gitTag = typeof input.gitTag === 'string' ? input.gitTag : ''
  if (releaseVersion !== webVersion) throw new Error('releaseVersion 与 webVersion 必须一致')
  if (gitTag !== `v${releaseVersion}`) throw new Error('gitTag 必须与 releaseVersion 一致')
  return { schemaVersion: 1, releaseVersion, webVersion, pluginVersion, gitTag }
}

export function readReleaseManifest(path: string): ReleaseManifest {
  return parseReleaseManifest(JSON.parse(readFileSync(path, 'utf8')))
}

function numericCore(value: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = value.split('-', 1)[0]!.split('.').map(Number)
  return [major, minor, patch]
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = numericCore(left)
  const b = numericCore(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  const leftSuffix = left.includes('-') ? left.slice(left.indexOf('-') + 1) : ''
  const rightSuffix = right.includes('-') ? right.slice(right.indexOf('-') + 1) : ''
  if (!leftSuffix && rightSuffix) return 1
  if (leftSuffix && !rightSuffix) return -1
  return leftSuffix.localeCompare(rightSuffix)
}
