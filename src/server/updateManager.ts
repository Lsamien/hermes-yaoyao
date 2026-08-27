import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { ServerConfig } from './config.js'
import { DEFAULT_YAOYAO_RELEASE_SOURCE } from './config.js'
import {
  compareReleaseVersions,
  readReleaseManifest,
  type ReleaseManifest,
} from './releases.js'

export type UpdateJobState =
  | 'queued'
  | 'downloading'
  | 'building'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface UpdateJob {
  id: string
  operation: 'update' | 'rollback'
  state: UpdateJobState
  message: string
  createdAt: string
  updatedAt: string
  target?: ReleaseManifest
  error?: string
}

interface UpdatePlan {
  source: string
  releaseRoot: string
  dataHome: string
  hermesHome: string
  previousServiceRoot: string
  target?: ReleaseManifest
  targetCommit?: string
}

interface StoredUpdateJob extends UpdateJob {
  plan: UpdatePlan
}

export interface SystemUpdateStatus {
  current: ReleaseManifest
  installedPluginVersion?: string
  versionsMatch: boolean
  installationMode: 'source' | 'release'
  latest?: ReleaseManifest
  updateAvailable: boolean
  supported: boolean
  unsupportedReason?: string
  canRollback: boolean
  job?: UpdateJob
}

export interface RemoteRelease {
  manifest: ReleaseManifest
  commit: string
}

type InspectRemote = (source: string, current: ReleaseManifest) => Promise<RemoteRelease | undefined>
type LaunchUpdater = (jobPath: string) => number | undefined | void

export interface SystemUpdateManagerOptions {
  projectRoot?: string
  manifestPath?: string
  updaterPath?: string
  inspectRemote?: InspectRemote
  launchUpdater?: LaunchUpdater
  platform?: NodeJS.Platform
}

function run(command: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1_024 * 1_024 }, (error, stdout) => {
      if (error) reject(error)
      else resolvePromise(stdout)
    })
  })
}

export async function inspectGitRemote(source: string, current: ReleaseManifest): Promise<RemoteRelease | undefined> {
  const output = await run('git', ['ls-remote', '--tags', source, 'refs/tags/v*'])
  const byVersion = new Map<string, { version: string; commit: string; peeled: boolean }>()
  for (const line of output.split('\n')) {
    const [commit = '', reference = ''] = line.trim().split(/\s+/, 2)
    const match = reference.match(/^refs\/tags\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\^\{\})?$/)
    if (!match || !/^[0-9a-f]{40,64}$/.test(commit)) continue
    const version = match[1]!
    const peeled = Boolean(match[2])
    const existing = byVersion.get(version)
    if (!existing || peeled) byVersion.set(version, { version, commit, peeled })
  }
  const releases = [...byVersion.values()]
    .sort((left, right) => compareReleaseVersions(left.version, right.version))
  const latest = releases.at(-1)
  if (!latest || compareReleaseVersions(latest.version, current.releaseVersion) <= 0) return undefined

  const temporary = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-update-check-'))
  try {
    await run('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', `v${latest.version}`, source, temporary], 60_000)
    const commit = (await run('git', ['-C', temporary, 'rev-parse', 'HEAD'])).trim()
    if (commit !== latest.commit) throw new Error('远端发布标签在检查期间发生变化')
    const manifest = readReleaseManifest(join(temporary, 'release.json'))
    if (manifest.releaseVersion !== latest.version) throw new Error('远端标签与 release.json 版本不一致')
    return { manifest, commit }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function publicJob(job: StoredUpdateJob | undefined): UpdateJob | undefined {
  if (!job) return undefined
  const { plan: _plan, ...value } = job
  return value
}

function terminal(state: UpdateJobState): boolean {
  return ['succeeded', 'failed', 'rolled_back'].includes(state)
}

export class SystemUpdateManager {
  private readonly projectRoot: string
  private readonly manifestPath: string
  private readonly updaterPath: string
  private readonly updateHome: string
  private readonly releaseRoot: string
  private readonly releaseSource: string
  private readonly inspectRemote: InspectRemote
  private readonly launchUpdater: LaunchUpdater
  private readonly platform: NodeJS.Platform

  constructor(private readonly config: ServerConfig, options: SystemUpdateManagerOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.manifestPath = resolve(options.manifestPath ?? join(this.projectRoot, 'release.json'))
    this.updaterPath = resolve(options.updaterPath ?? join(this.projectRoot, 'bin', 'hermes-yaoyao-updater.mjs'))
    this.updateHome = join(config.home, 'updates')
    this.releaseRoot = resolve(config.releaseRoot ?? join(homedir(), '.local', 'share', 'hermes-yaoyao'))
    this.releaseSource = config.releaseSource ?? DEFAULT_YAOYAO_RELEASE_SOURCE
    this.inspectRemote = options.inspectRemote ?? inspectGitRemote
    this.platform = options.platform ?? process.platform
    this.launchUpdater = options.launchUpdater ?? ((jobPath) => {
      const child = spawn(process.execPath, [this.updaterPath, 'run', '--job', jobPath], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      child.unref()
      return child.pid
    })
  }

  currentManifest(): ReleaseManifest {
    return readReleaseManifest(this.manifestPath)
  }

  private latestJobID(): string | undefined {
    try {
      const value = JSON.parse(readFileSync(join(this.updateHome, 'latest.json'), 'utf8')) as { id?: unknown }
      return typeof value.id === 'string' ? value.id : undefined
    } catch {
      return undefined
    }
  }

  private storedJob(id: string): StoredUpdateJob | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined
    try {
      return JSON.parse(readFileSync(join(this.updateHome, `${id}.json`), 'utf8')) as StoredUpdateJob
    } catch {
      return undefined
    }
  }

  job(id: string): UpdateJob | undefined {
    return publicJob(this.storedJob(id))
  }

  private latestJob(): StoredUpdateJob | undefined {
    const id = this.latestJobID()
    return id ? this.storedJob(id) : undefined
  }

  status(installedPluginVersion?: string, latest?: ReleaseManifest): SystemUpdateStatus {
    const current = this.currentManifest()
    const job = this.latestJob()
    return {
      current,
      installedPluginVersion,
      versionsMatch: installedPluginVersion === current.pluginVersion,
      installationMode: this.projectRoot.startsWith(`${this.releaseRoot}/`) ? 'release' : 'source',
      latest,
      updateAvailable: Boolean(latest && compareReleaseVersions(latest.releaseVersion, current.releaseVersion) > 0),
      supported: this.platform === 'darwin',
      unsupportedReason: this.platform === 'darwin' ? undefined : '容器和非 macOS 环境请通过替换部署镜像升级',
      canRollback: existsSync(join(this.updateHome, 'last-success.json')),
      job: publicJob(job),
    }
  }

  async check(installedPluginVersion?: string): Promise<SystemUpdateStatus> {
    const current = this.currentManifest()
    const latest = await this.inspectRemote(this.releaseSource, current)
    return this.status(installedPluginVersion, latest?.manifest)
  }

  private acquire(jobID: string): void {
    mkdirSync(this.updateHome, { recursive: true, mode: 0o700 })
    const lockPath = join(this.updateHome, 'active.lock')
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify({ jobID })}\n`)
      closeSync(descriptor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let lock: { jobID?: unknown; pid?: unknown } = {}
      try { lock = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof lock } catch { /* legacy lock */ }
      if (typeof lock.pid === 'number') {
        try {
          process.kill(lock.pid, 0)
          throw new Error('已有系统更新正在执行')
        } catch (processError) {
          if ((processError as NodeJS.ErrnoException).code !== 'ESRCH') throw processError
        }
      } else if (Date.now() - statSync(lockPath).mtimeMs < 5 * 60_000) {
        throw new Error('已有系统更新正在执行')
      }
      const latest = this.latestJob()
      if (latest && !terminal(latest.state)) {
        const failed = {
          ...latest,
          state: 'failed' as const,
          message: '升级进程意外终止，可重新检查更新',
          error: '升级进程已不存在',
          updatedAt: new Date().toISOString(),
        }
        writeFileSync(join(this.updateHome, `${latest.id}.json`), `${JSON.stringify(failed, null, 2)}\n`, { mode: 0o600 })
      }
      rmSync(lockPath, { force: true })
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify({ jobID })}\n`)
      closeSync(descriptor)
    }
  }

  private createJob(operation: UpdateJob['operation'], target?: ReleaseManifest, targetCommit?: string): StoredUpdateJob {
    const id = randomUUID()
    this.acquire(id)
    const now = new Date().toISOString()
    const job: StoredUpdateJob = {
      id,
      operation,
      state: 'queued',
      message: operation === 'update' ? '升级任务已排队' : '回滚任务已排队',
      createdAt: now,
      updatedAt: now,
      target,
      plan: {
        source: this.releaseSource,
        releaseRoot: this.releaseRoot,
        dataHome: this.config.home,
        hermesHome: resolve(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')),
        previousServiceRoot: this.projectRoot,
        target,
        targetCommit,
      },
    }
    const jobPath = join(this.updateHome, `${id}.json`)
    writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(join(this.updateHome, 'latest.json'), `${JSON.stringify({ id })}\n`, { mode: 0o600 })
    try {
      const pid = this.launchUpdater(jobPath)
      if (typeof pid === 'number' && existsSync(join(this.updateHome, 'active.lock'))) {
        writeFileSync(join(this.updateHome, 'active.lock'), `${JSON.stringify({ jobID: id, pid })}\n`, { mode: 0o600 })
      }
    } catch (error) {
      rmSync(join(this.updateHome, 'active.lock'), { force: true })
      throw error
    }
    return job
  }

  async startUpdate(targetVersion: string, installedPluginVersion?: string): Promise<UpdateJob> {
    if (this.platform !== 'darwin') throw new Error('当前环境不支持服务内升级')
    const current = this.currentManifest()
    const latest = await this.inspectRemote(this.releaseSource, current)
    if (!latest || compareReleaseVersions(latest.manifest.releaseVersion, current.releaseVersion) <= 0) {
      throw new Error('当前已经是最新版本')
    }
    if (targetVersion !== latest.manifest.releaseVersion) throw new Error('目标版本不是当前发布源的最新版本')
    return publicJob(this.createJob('update', latest.manifest, latest.commit))!
  }

  startRollback(): UpdateJob {
    if (this.platform !== 'darwin') throw new Error('当前环境不支持服务内回滚')
    if (!existsSync(join(this.updateHome, 'last-success.json'))) throw new Error('没有可回滚的上一版本')
    return publicJob(this.createJob('rollback'))!
  }
}
