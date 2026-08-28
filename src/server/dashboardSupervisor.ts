import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isPrivateHost } from './config.js'

export const DEFAULT_DASHBOARD_USERNAME = 'admin'
export const DEFAULT_DASHBOARD_PASSWORD = 'admin'
const DASHBOARD_PORT = 9119
const SUPERVISION_INTERVAL_MS = 5_000
const RESTART_READY_TIMEOUT_MS = 15_000

type Run = (args: readonly string[]) => string
type Launch = (args: readonly string[]) => void
type Probe = (host: string, port: number) => Promise<boolean>

export interface DashboardSupervisorOptions {
  allowLan: boolean
  command?: string
  intervalMs?: number
  run?: Run
  launch?: Launch
  probe?: Probe
  lanProbeHost?: string
  log?: (message: string) => void
  credentials?: { username: string; password: string }
}

function defaultRun(command: string): Run {
  return (args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' })
}

function defaultLaunch(command: string): Launch {
  return (args) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
    child.unref()
  }
}

function portIsListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (value: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function privateLanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isPrivateHost(address.address)) {
        return address.address
      }
    }
  }
  return undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function passwordHash(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`
}

/** Keeps the local Hermes Dashboard available for the managed 8800 service. */
export class DashboardSupervisor {
  private readonly command: string
  private readonly dashboardHost: string
  private readonly run: Run
  private readonly launch: Launch
  private readonly probe: Probe
  private readonly allowLan: boolean
  private readonly lanProbeHost: string | undefined
  private readonly log: (message: string) => void
  private readonly intervalMs: number
  private readonly credentials: { username: string; password: string }
  private timer: NodeJS.Timeout | undefined
  private checking = false

  constructor(options: DashboardSupervisorOptions) {
    this.command = options.command ?? 'hermes'
    this.allowLan = options.allowLan
    this.dashboardHost = options.allowLan ? '0.0.0.0' : '127.0.0.1'
    this.run = options.run ?? defaultRun(this.command)
    this.launch = options.launch ?? defaultLaunch(this.command)
    this.probe = options.probe ?? portIsListening
    this.lanProbeHost = options.lanProbeHost ?? privateLanAddress()
    this.log = options.log ?? console.info
    this.intervalMs = options.intervalMs ?? SUPERVISION_INTERVAL_MS
    this.credentials = options.credentials ?? {
      username: DEFAULT_DASHBOARD_USERNAME,
      password: DEFAULT_DASHBOARD_PASSWORD,
    }
  }

  start(): void {
    void this.checkNow()
    this.timer = setInterval(() => { void this.checkNow() }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async restart(): Promise<void> {
    while (this.checking) await delay(25)
    this.run(['dashboard', '--stop'])
    await this.checkNow()
    const deadline = Date.now() + RESTART_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.probe('127.0.0.1', DASHBOARD_PORT)) return
      await delay(100)
    }
    throw new Error('Hermes Dashboard did not return on 9119 after restart')
  }

  async checkNow(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const credentialsChanged = this.ensureBasicAuthentication()
      let running = await this.probe('127.0.0.1', DASHBOARD_PORT)
      const bindingChanged = running && !(await this.bindingMatches())
      if ((credentialsChanged || bindingChanged) && running) {
        const reason = credentialsChanged
          ? 'authentication was configured'
          : `listener must move to ${this.dashboardHost}`
        this.log(`Hermes Dashboard ${reason}; restarting 9119 to load it.`)
        this.run(['dashboard', '--stop'])
        running = await this.probe('127.0.0.1', DASHBOARD_PORT)
      }
      if (running) return
      this.log(`Hermes Dashboard is unavailable on 9119; starting it on ${this.dashboardHost}.`)
      this.launch(['dashboard', '--host', this.dashboardHost, '--no-open'])
    } catch (error) {
      this.log(`Hermes Dashboard supervision failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.checking = false
    }
  }

  private async bindingMatches(): Promise<boolean> {
    if (!this.lanProbeHost) return true
    const listeningOnLan = await this.probe(this.lanProbeHost, DASHBOARD_PORT)
    return this.allowLan ? listeningOnLan : !listeningOnLan
  }

  private value(key: string): string {
    try {
      return this.run(['config', 'get', key]).trim()
    } catch {
      return ''
    }
  }

  private set(key: string, value: string): void {
    this.run(['config', 'set', key, value])
  }

  private ensureBasicAuthentication(): boolean {
    const username = this.value('dashboard.basic_auth.username')
    const configuredPasswordHash = this.value('dashboard.basic_auth.password_hash')
    const password = this.value('dashboard.basic_auth.password')
    const secret = this.value('dashboard.basic_auth.secret')
    let changed = false

    if (!username) {
      this.set('dashboard.basic_auth.username', this.credentials.username)
      changed = true
    }
    if (!configuredPasswordHash && !password) {
      this.set('dashboard.basic_auth.password_hash', passwordHash(this.credentials.password))
      changed = true
    }
    if (!secret) {
      this.set('dashboard.basic_auth.secret', randomBytes(32).toString('base64url'))
      changed = true
    }
    return changed
  }
}
