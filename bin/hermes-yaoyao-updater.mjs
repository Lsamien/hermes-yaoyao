#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const label = 'com.samien.hermes-yaoyao'
const uid = process.getuid?.() ?? 501
const domain = `gui/${uid}`

function fail(message) { throw new Error(message) }

function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')) }

function writeJSON(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function validateManifest(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) fail('release.json 格式无效')
  for (const key of ['releaseVersion', 'webVersion', 'pluginVersion']) {
    if (typeof value[key] !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value[key])) {
      fail(`release.json ${key} 无效`)
    }
  }
  if (value.releaseVersion !== value.webVersion || value.gitTag !== `v${value.releaseVersion}`) {
    fail('release.json 版本组合不一致')
  }
  return value
}

function updateJob(jobPath, patch) {
  const current = readJSON(jobPath)
  writeJSON(jobPath, { ...current, ...patch, updatedAt: new Date().toISOString() })
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1_024 * 1_024,
  })
}

function pathInside(path, parent) {
  const target = resolve(path)
  const root = resolve(parent)
  return target.startsWith(`${root}${sep}`)
}

function removeInside(path, parent) {
  if (!pathInside(path, parent)) fail(`拒绝清理非预期路径：${path}`)
  rmSync(path, { recursive: true, force: true })
}

function loaded() {
  try {
    run('launchctl', ['print', `${domain}/${label}`])
    return true
  } catch {
    return false
  }
}

function stopService() {
  if (loaded()) run('launchctl', ['bootout', `${domain}/${label}`])
}

function stopDashboard() {
  try { run('hermes', ['dashboard', '--stop'], { timeout: 30_000 }) } catch { /* already stopped */ }
}

function enabledPlugins() {
  const raw = run('hermes', ['config', 'get', 'plugins.enabled']).trim()
  if (!raw) return []
  const value = JSON.parse(raw)
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    fail('Hermes plugins.enabled 不是字符串数组')
  }
  return value
}

function setEnabledPlugins(value) {
  run('hermes', ['config', 'set', 'plugins.enabled', JSON.stringify(value)])
}

function ensureYaoyaoEnabled(previous) {
  if (!previous.includes('yaoyao')) setEnabledPlugins([...previous, 'yaoyao'])
}

function atomicDirectory(source, target, scratchRoot, token) {
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const incoming = join(parent, `.${token}-incoming`)
  const previous = join(parent, `.${token}-previous`)
  removeInside(incoming, scratchRoot)
  removeInside(previous, scratchRoot)
  cpSync(source, incoming, { recursive: true, preserveTimestamps: true })
  if (existsSync(target)) renameSync(target, previous)
  renameSync(incoming, target)
  return previous
}

function atomicFile(source, target, scratchRoot, token) {
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const incoming = join(parent, `.${token}-incoming.yaml`)
  const previous = join(parent, `.${token}-previous.yaml`)
  removeInside(incoming, scratchRoot)
  removeInside(previous, scratchRoot)
  copyFileSync(source, incoming)
  if (existsSync(target)) renameSync(target, previous)
  renameSync(incoming, target)
  return previous
}

export function currentTarget(releaseRoot) {
  const current = join(releaseRoot, 'current')
  try {
    const stat = lstatSync(current)
    if (!stat.isSymbolicLink()) fail('发布目录 current 必须是符号链接')
    return resolve(releaseRoot, readlinkSync(current))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export function switchCurrent(releaseRoot, target, token) {
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  const current = join(releaseRoot, 'current')
  const temporary = join(releaseRoot, `.current-${token}`)
  removeInside(temporary, releaseRoot)
  symlinkSync(relative(releaseRoot, target), temporary, 'dir')
  renameSync(temporary, current)
}

function removeCurrent(releaseRoot) {
  const current = join(releaseRoot, 'current')
  try {
    if (!lstatSync(current).isSymbolicLink()) fail('拒绝删除非符号链接 current')
    rmSync(current)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function serviceEnvironment(serviceRoot, plan) {
  return {
    ...process.env,
    HERMES_YAOYAO_SERVICE_ROOT: serviceRoot,
    HERMES_YAOYAO_RELEASE_ROOT: plan.releaseRoot,
    HERMES_YAOYAO_RELEASE_SOURCE: plan.source,
  }
}

function startService(serviceRoot, plan, stableRoot = true) {
  const cli = join(serviceRoot, 'bin', 'hermes-yaoyao.mjs')
  if (!existsSync(cli)) fail(`服务入口不存在：${cli}`)
  const env = serviceEnvironment(stableRoot ? join(plan.releaseRoot, 'current') : serviceRoot, plan)
  if (!stableRoot) delete env.HERMES_YAOYAO_SERVICE_ROOT
  run(process.execPath, [cli, 'service', 'install'], { env, timeout: 30_000 })
}

async function responseJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000), cache: 'no-store' })
  if (!response.ok) fail(`${url} 返回 HTTP ${response.status}`)
  return response.json()
}

async function verifyRuntime(pluginVersion, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const health = await responseJSON('http://127.0.0.1:8800/healthz')
      const ready = await responseJSON('http://127.0.0.1:8800/readyz')
      const plugins = await responseJSON('http://127.0.0.1:9119/api/dashboard/plugins')
      const plugin = Array.isArray(plugins) ? plugins.find(item => item?.name === 'yaoyao') : undefined
      const pluginMatches = pluginVersion ? plugin?.version === pluginVersion : plugin === undefined
      if (health.ok === true && ready.ok === true && pluginMatches) return
      lastError = pluginVersion
        ? `运行版本不匹配：期望插件 ${pluginVersion}`
        : '上一版本未安装夭夭插件，但回滚后仍检测到插件'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  fail(`升级后健康检查失败：${lastError}`)
}

export function backupPlugin(plan, jobID) {
  const pluginRoot = join(plan.hermesHome, 'plugins', 'yaoyao')
  const backupRoot = join(plan.dataHome, 'backups', 'system-update', jobID)
  const pluginPreviouslyInstalled = existsSync(join(pluginRoot, 'dashboard', 'manifest.json'))
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  if (existsSync(join(pluginRoot, 'dashboard'))) {
    cpSync(join(pluginRoot, 'dashboard'), join(backupRoot, 'dashboard'), { recursive: true, preserveTimestamps: true })
  }
  if (existsSync(join(pluginRoot, 'plugin.yaml'))) copyFileSync(join(pluginRoot, 'plugin.yaml'), join(backupRoot, 'plugin.yaml'))
  return { pluginRoot, backupRoot, pluginPreviouslyInstalled }
}

export function restorePlugin(pluginRoot, backupRoot, token, pluginPreviouslyInstalled = true) {
  const dashboardBackup = join(backupRoot, 'dashboard')
  const manifestBackup = join(backupRoot, 'plugin.yaml')
  if (!pluginPreviouslyInstalled) {
    removeInside(join(pluginRoot, 'dashboard'), pluginRoot)
    removeInside(join(pluginRoot, 'plugin.yaml'), pluginRoot)
    return
  }
  if (!existsSync(dashboardBackup) || !existsSync(manifestBackup)) fail('插件回滚备份不完整')
  const oldDashboard = atomicDirectory(dashboardBackup, join(pluginRoot, 'dashboard'), pluginRoot, `${token}-restore-dashboard`)
  const oldManifest = atomicFile(manifestBackup, join(pluginRoot, 'plugin.yaml'), pluginRoot, `${token}-restore-manifest`)
  removeInside(oldDashboard, pluginRoot)
  removeInside(oldManifest, pluginRoot)
}

function backupPluginVersion(backupRoot) {
  return String(readJSON(join(backupRoot, 'dashboard', 'manifest.json')).version ?? '')
}

function stageRelease(job, jobPath) {
  const { plan, target, id } = job
  if (!target) fail('升级任务缺少目标版本')
  const releasesRoot = join(plan.releaseRoot, 'releases')
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 })
  const staging = join(releasesRoot, `.staging-${id}`)
  removeInside(staging, releasesRoot)
  updateJob(jobPath, { state: 'downloading', message: `正在下载 ${target.gitTag}` })
  run('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', target.gitTag, plan.source, staging], { timeout: 180_000 })
  const manifest = validateManifest(readJSON(join(staging, 'release.json')))
  for (const field of ['schemaVersion', 'releaseVersion', 'webVersion', 'pluginVersion', 'gitTag']) {
    if (manifest[field] !== target[field]) fail('下载的发布清单与检查结果不一致')
  }
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: staging }).trim()
  if (!/^[0-9a-f]{40,64}$/.test(plan.targetCommit || '') || commit !== plan.targetCommit) {
    fail('下载提交与检查时锁定的发布提交不一致')
  }

  updateJob(jobPath, { state: 'building', message: `正在构建 Web ${target.webVersion}` })
  run('npm', ['ci'], { cwd: staging, inherit: true, timeout: 600_000 })
  run('npm', ['run', 'build'], { cwd: staging, inherit: true, timeout: 600_000 })
  const finalRoot = join(releasesRoot, `${target.releaseVersion}-${commit.slice(0, 12)}`)
  if (existsSync(finalRoot)) removeInside(staging, releasesRoot)
  else renameSync(staging, finalRoot)
  return { finalRoot, commit }
}

async function runUpdate(jobPath, job) {
  const { plan, target, id } = job
  if (!target) fail('升级任务缺少目标发布清单')
  const { finalRoot, commit } = stageRelease(job, jobPath)
  const pluginSource = join(finalRoot, 'hermes-plugins', 'yaoyao')
  const pluginManifest = readJSON(join(pluginSource, 'dashboard', 'manifest.json'))
  if (pluginManifest.version !== target.pluginVersion) fail('构建产物中的插件版本与发布清单不一致')

  const previousCurrentTarget = currentTarget(plan.releaseRoot)
  const { pluginRoot, backupRoot, pluginPreviouslyInstalled } = backupPlugin(plan, id)
  const previousPluginVersion = pluginPreviouslyInstalled ? backupPluginVersion(backupRoot) : ''
  const previousEnabledPlugins = enabledPlugins()
  let transitioned = false
  let previousDashboard = ''
  let previousPluginYaml = ''
  try {
    updateJob(jobPath, { state: 'installing', message: `正在安装插件 ${target.pluginVersion}` })
    stopService()
    stopDashboard()
    transitioned = true
    previousDashboard = atomicDirectory(
      join(pluginSource, 'dashboard'), join(pluginRoot, 'dashboard'), pluginRoot, `${id}-dashboard`,
    )
    previousPluginYaml = atomicFile(
      join(pluginSource, 'plugin.yaml'), join(pluginRoot, 'plugin.yaml'), pluginRoot, `${id}-manifest`,
    )
    ensureYaoyaoEnabled(previousEnabledPlugins)
    switchCurrent(plan.releaseRoot, finalRoot, id)

    updateJob(jobPath, { state: 'restarting', message: '正在启动新版本服务' })
    startService(join(plan.releaseRoot, 'current'), plan, true)
    updateJob(jobPath, { state: 'verifying', message: '正在验证 8800、9119 和插件版本' })
    await verifyRuntime(target.pluginVersion)
    removeInside(previousDashboard, pluginRoot)
    removeInside(previousPluginYaml, pluginRoot)
    writeJSON(join(dirname(jobPath), 'last-success.json'), {
      jobId: id,
      previousCurrentTarget,
      previousServiceRoot: plan.previousServiceRoot,
      previousPluginVersion,
      pluginPreviouslyInstalled,
      previousEnabledPlugins,
      backupRoot,
      target,
      finalRoot,
      commit,
    })
    updateJob(jobPath, { state: 'succeeded', message: `已升级到 Web ${target.webVersion} + 插件 ${target.pluginVersion}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (transitioned) {
      updateJob(jobPath, { state: 'rolling_back', message: '升级失败，正在自动恢复上一版本', error: message })
      try {
        stopService()
        stopDashboard()
        restorePlugin(pluginRoot, backupRoot, id, pluginPreviouslyInstalled)
        setEnabledPlugins(previousEnabledPlugins)
        if (previousCurrentTarget) {
          switchCurrent(plan.releaseRoot, previousCurrentTarget, `${id}-rollback`)
          startService(join(plan.releaseRoot, 'current'), plan, true)
        } else {
          removeCurrent(plan.releaseRoot)
          startService(plan.previousServiceRoot, plan, false)
        }
        await verifyRuntime(previousPluginVersion)
        updateJob(jobPath, { state: 'failed', message: '升级失败，已自动恢复上一版本', error: message })
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        updateJob(jobPath, { state: 'failed', message: '升级和自动回滚均失败，需要人工处理', error: `${message}; 回滚：${rollbackMessage}` })
      }
    } else {
      updateJob(jobPath, { state: 'failed', message: '升级准备失败，现有服务未被修改', error: message })
    }
  }
}

async function runRollback(jobPath, job) {
  const { plan, id } = job
  const recordPath = join(dirname(jobPath), 'last-success.json')
  if (!existsSync(recordPath)) fail('没有可回滚的上一版本')
  const record = readJSON(recordPath)
  updateJob(jobPath, { state: 'rolling_back', message: '正在恢复上一版本' })
  stopService()
  stopDashboard()
  restorePlugin(
    join(plan.hermesHome, 'plugins', 'yaoyao'),
    record.backupRoot,
    id,
    record.pluginPreviouslyInstalled !== false,
  )
  if (Array.isArray(record.previousEnabledPlugins)) setEnabledPlugins(record.previousEnabledPlugins)
  if (record.previousCurrentTarget) {
    switchCurrent(plan.releaseRoot, record.previousCurrentTarget, id)
    startService(join(plan.releaseRoot, 'current'), plan, true)
  } else {
    removeCurrent(plan.releaseRoot)
    startService(record.previousServiceRoot, plan, false)
  }
  await verifyRuntime(record.previousPluginVersion)
  rmSync(recordPath, { force: true })
  updateJob(jobPath, { state: 'rolled_back', message: `已回滚到插件 ${record.previousPluginVersion}` })
}

async function main() {
  const [, , command, flag, jobPathValue] = process.argv
  if (command !== 'run' || flag !== '--job' || !jobPathValue) fail('用法：hermes-yaoyao-updater run --job <path>')
  const jobPath = resolve(jobPathValue)
  const job = readJSON(jobPath)
  try {
    if (job.operation === 'update') await runUpdate(jobPath, job)
    else if (job.operation === 'rollback') await runRollback(jobPath, job)
    else fail('未知升级任务类型')
  } catch (error) {
    updateJob(jobPath, {
      state: 'failed',
      message: job.operation === 'rollback' ? '回滚失败，需要人工处理' : '升级失败',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    const lockPath = join(dirname(jobPath), 'active.lock')
    try {
      const raw = readFileSync(lockPath, 'utf8').trim()
      let lockJobID = raw
      try { lockJobID = JSON.parse(raw).jobID } catch { /* legacy lock */ }
      if (lockJobID === job.id) rmSync(lockPath)
    } catch { /* already released */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
