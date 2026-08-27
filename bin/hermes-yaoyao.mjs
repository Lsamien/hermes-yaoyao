#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const label = 'com.samien.hermes-yaoyao'
const sourceProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serviceRoot = resolve(process.env.HERMES_YAOYAO_SERVICE_ROOT || sourceProjectRoot)
const uid = process.getuid?.() ?? 501
const domain = `gui/${uid}`
const launchAgents = join(homedir(), 'Library', 'LaunchAgents')
const plistPath = join(launchAgents, `${label}.plist`)
const dataHome = process.env.HERMES_YAOYAO_HOME || join(homedir(), '.hermes-yaoyao')
const logDir = join(homedir(), 'Library', 'Logs')
const serverEntry = join(serviceRoot, 'dist-server', 'server', 'index.js')

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe' })
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function environment() {
  const allowed = [
    'HERMES_YAOYAO_HOST',
    'HERMES_YAOYAO_PORT',
    'HERMES_YAOYAO_UPSTREAM',
    'HERMES_YAOYAO_ALLOWED_HOSTS',
    'HERMES_YAOYAO_HOME',
    'HERMES_YAOYAO_TLS_CERT',
    'HERMES_YAOYAO_TLS_KEY',
    'HERMES_YAOYAO_ALLOW_INSECURE_LAN',
    'HERMES_YAOYAO_SUPERVISE_DASHBOARD',
    'HERMES_YAOYAO_RELEASE_SOURCE',
    'HERMES_YAOYAO_RELEASE_ROOT',
    'HERMES_YAOYAO_ALLOW_REMOTE_UPDATE',
    'HERMES_YAOYAO_SERVICE_ROOT',
  ]
  return Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
}

export function launchAgentPlist(options = {}) {
  const plistServiceRoot = resolve(options.serviceRoot || serviceRoot)
  const plistServerEntry = join(plistServiceRoot, 'dist-server', 'server', 'index.js')
  const node = process.execPath
  const envEntries = {
    PATH: `${dirname(node)}:${join(homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_ENV: 'production',
    HERMES_YAOYAO_HOME: dataHome,
    HERMES_YAOYAO_HOST: '127.0.0.1',
    HERMES_YAOYAO_PORT: '8800',
    HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:9119',
    HERMES_YAOYAO_SUPERVISE_DASHBOARD: '1',
    ...environment(),
  }
  const envXml = Object.entries(envEntries).map(([key, value]) => (
    `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`
  )).join('\n')
  const logPath = join(logDir, 'hermes-yaoyao.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array><string>${escapeXml(node)}</string><string>${escapeXml(plistServerEntry)}</string></array>
    <key>WorkingDirectory</key><string>${escapeXml(plistServiceRoot)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ProcessType</key><string>Interactive</string>
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
  </dict>
</plist>
`
}

function loaded() {
  try {
    run('launchctl', ['print', `${domain}/${label}`])
    return true
  } catch {
    return false
  }
}

async function install() {
  if (!existsSync(serverEntry)) {
    throw new Error('未找到生产构建，请先运行 npm run build')
  }
  await mkdir(launchAgents, { recursive: true })
  await mkdir(dataHome, { recursive: true, mode: 0o700 })
  await mkdir(logDir, { recursive: true })
  if (loaded()) run('launchctl', ['bootout', `${domain}/${label}`])
  await writeFile(plistPath, launchAgentPlist(), { mode: 0o600 })
  await chmod(plistPath, 0o600)
  run('plutil', ['-lint', plistPath], { inherit: true })
  run('launchctl', ['bootstrap', domain, plistPath])
  process.stdout.write(`已安装并启动 ${label}\n`)
}

function start() {
  if (!existsSync(plistPath)) throw new Error('服务尚未安装')
  if (!loaded()) run('launchctl', ['bootstrap', domain, plistPath])
  else run('launchctl', ['kickstart', '-k', `${domain}/${label}`])
  process.stdout.write(`已启动 ${label}\n`)
}

function stop() {
  if (loaded()) run('launchctl', ['bootout', `${domain}/${label}`])
  process.stdout.write(`已停止 ${label}；Hermes 9119 未被操作\n`)
}

async function uninstall() {
  stop()
  if (existsSync(plistPath)) await unlink(plistPath)
  process.stdout.write(`已卸载 ${label}；运行数据保留在 ${dataHome}\n`)
}

function status() {
  if (!loaded()) {
    process.stdout.write(`${label}: stopped\n`)
    process.exitCode = 3
    return
  }
  process.stdout.write(run('launchctl', ['print', `${domain}/${label}`]))
}

async function pruneUploads(args) {
  const index = args.indexOf('--older-than')
  const days = index >= 0 ? Number(args[index + 1]) : 30
  if (!Number.isFinite(days) || days < 1) throw new Error('--older-than 必须是大于 0 的天数')
  if (!args.includes('--yes')) {
    throw new Error('这是显式清理操作，请增加 --yes')
  }
  const root = join(dataHome, 'uploads', 'pending')
  if (!existsSync(root)) return
  const cutoff = Date.now() - days * 86_400_000
  let removed = 0
  for (const entry of await readdir(root)) {
    const target = join(root, entry)
    const info = await stat(target)
    if (info.isFile() && info.mtimeMs < cutoff) {
      await unlink(target)
      removed += 1
    }
  }
  process.stdout.write(`已清理 ${removed} 个未提交上传文件\n`)
}

async function main() {
  const [, , group, command, ...args] = process.argv
  if (group === 'service') {
    if (command === 'install') return install()
    if (command === 'start') return start()
    if (command === 'stop') return stop()
    if (command === 'status') return status()
    if (command === 'uninstall') return uninstall()
  }
  if (group === 'uploads' && command === 'prune') return pruneUploads(args)
  process.stdout.write(`夭夭 Web\n\n用法：\n  hermes-yaoyao service install|start|stop|status|uninstall\n  hermes-yaoyao uploads prune --older-than 30 --yes\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
