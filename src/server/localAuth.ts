import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type Koa from 'koa'
import { parse, serialize } from 'cookie'
import { HttpError } from './errors.js'
import { appendSetCookies } from './security.js'
import { CookieJar, type UpstreamRequestOptions, type UpstreamResponse, UpstreamClient } from './upstream.js'

const SESSION_COOKIE = 'hermes_yaoyao_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const USERNAME_PATTERN = /^[^\u0000-\u001f\u007f\s/@\\]{1,100}$/u

export type LocalRole = 'admin' | 'user'

interface StoredUser {
  id: string
  username: string
  normalizedUsername: string
  role: LocalRole
  enabled: boolean
  mustChangePassword: boolean
  salt: string
  passwordHash: string
  authVersion: number
  createdAt: number
  updatedAt: number
}

interface StoredUsers { version: 1; users: StoredUser[] }

interface SessionRecord {
  userID: string
  authVersion: number
  expiresAt: number
}
interface StoredSessions { version: 1; sessions: Array<SessionRecord & { tokenHash: string }> }

export interface LocalUser {
  id: string
  username: string
  role: LocalRole
  enabled: boolean
  mustChangePassword: boolean
  createdAt: number
  updatedAt: number
}

export interface UpstreamCredentials { username: string; password: string }

function passwordDigest(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, {
    N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024,
  })
}

function canonicalUsername(value: string): string {
  const username = value.trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, '用户名必须为 1 到 100 个不含空格的字符', 'invalid_username')
  }
  return username
}

function validatePassword(value: string, allowDefault = false): string {
  if (value.length > 4_096 || (!allowDefault && value.length < 8) || (allowDefault && !value)) {
    throw new HttpError(400, '密码必须至少 8 个字符', 'invalid_password')
  }
  return value
}

function publicUser(user: StoredUser): LocalUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export class LocalAuthStore {
  readonly #path: string
  readonly #credentialPath: string
  readonly #keyPath: string
  readonly #sessionsPath: string
  readonly #secureCookie: boolean
  readonly #sessions = new Map<string, SessionRecord>()
  #users: StoredUser[]

  constructor(home: string, secureCookie = false) {
    this.#path = join(home, 'users.json')
    this.#credentialPath = join(home, 'upstream-credentials.enc')
    this.#keyPath = join(home, 'local-auth.key')
    this.#sessionsPath = join(home, 'sessions.json')
    this.#secureCookie = secureCookie
    this.#users = this.#loadUsers()
    this.#loadSessions()
  }

  login(ctx: Koa.Context, usernameValue: string, password: string): LocalUser {
    const normalized = usernameValue.trim().toLocaleLowerCase('en-US')
    const user = this.#users.find(candidate => candidate.normalizedUsername === normalized)
    if (!user || !user.enabled || !this.#passwordMatches(user, password)) {
      throw new HttpError(401, '用户名或密码错误', 'login_failed')
    }
    return this.#issueSession(ctx, user)
  }

  issueSession(ctx: Koa.Context, userID: string): LocalUser {
    const user = this.#users.find(candidate => candidate.id === userID)
    if (!user || !user.enabled) {
      throw new HttpError(401, '用户已失效', 'account_pairing_user_unavailable')
    }
    return this.#issueSession(ctx, user)
  }

  #issueSession(ctx: Koa.Context, user: StoredUser): LocalUser {
    const token = randomBytes(32).toString('base64url')
    this.#sessions.set(this.#sessionKey(token), {
      userID: user.id,
      authVersion: user.authVersion,
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000,
    })
    this.#saveSessions()
    appendSetCookies(ctx, [serialize(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.#secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })])
    const published = publicUser(user)
    ctx.state.localUser = published
    return published
  }

  logout(ctx: Koa.Context): void {
    const token = this.#token(ctx)
    if (token) this.#sessions.delete(this.#sessionKey(token))
    this.#saveSessions()
    appendSetCookies(ctx, [serialize(SESSION_COOKIE, '', {
      httpOnly: true, secure: this.#secureCookie, sameSite: 'strict', path: '/', maxAge: 0,
    })])
  }

  current(ctx: Koa.Context): LocalUser | undefined {
    const injected = ctx.state.localUser as LocalUser | undefined
    if (injected) return injected
    return this.currentFromCookieHeader(ctx.get('cookie'))
  }

  /** Resolve the same authenticated user for non-Koa transports such as WS Upgrade. */
  currentFromCookieHeader(cookieHeader: string | undefined): LocalUser | undefined {
    const token = parse(cookieHeader ?? '')[SESSION_COOKIE]
    if (!token) return undefined
    const key = this.#sessionKey(token)
    const session = this.#sessions.get(key)
    if (!session || session.expiresAt <= Date.now()) {
      this.#sessions.delete(key)
      this.#saveSessions()
      return undefined
    }
    const user = this.#users.find(candidate => candidate.id === session.userID)
    if (!user || !user.enabled || user.authVersion !== session.authVersion) {
      this.#sessions.delete(key)
      this.#saveSessions()
      return undefined
    }
    return publicUser(user)
  }

  require(ctx: Koa.Context, allowPasswordChange = false): LocalUser {
    const user = this.current(ctx)
    if (!user) throw new HttpError(401, '请先登录夭夭', 'authentication_required')
    if (user.mustChangePassword && !allowPasswordChange) {
      throw new HttpError(428, '必须先修改初始密码', 'password_change_required')
    }
    return user
  }

  requireAdmin(ctx: Koa.Context): LocalUser {
    const user = this.require(ctx)
    if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    return user
  }

  isUserActive(userID: string): boolean {
    return this.#users.some(user => user.id === userID && user.enabled)
  }

  pushAuthorizationVersion(userID: string): number | undefined {
    const user = this.#users.find(candidate => candidate.id === userID && candidate.enabled)
    return user?.authVersion
  }

  list(admin: LocalUser): LocalUser[] {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    return this.#users.map(publicUser).sort((a, b) => a.createdAt - b.createdAt)
  }

  create(admin: LocalUser, usernameValue: string, passwordValue: string): LocalUser {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    const username = canonicalUsername(usernameValue)
    const normalizedUsername = username.toLocaleLowerCase('en-US')
    if (this.#users.some(user => user.normalizedUsername === normalizedUsername)) {
      throw new HttpError(409, '用户名已存在', 'username_exists')
    }
    const password = validatePassword(passwordValue)
    const now = Date.now()
    const user = this.#newUser(username, password, 'user', true, now)
    this.#users.push(user)
    this.#saveUsers()
    return publicUser(user)
  }

  updateUser(admin: LocalUser, userID: string, input: { enabled?: boolean; password?: string }): LocalUser {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    const user = this.#users.find(candidate => candidate.id === userID)
    if (!user) throw new HttpError(404, '用户不存在', 'user_not_found')
    if (user.role === 'admin') throw new HttpError(409, '管理员账号请在账号设置中修改', 'admin_account_protected')
    if (typeof input.enabled === 'boolean') user.enabled = input.enabled
    if (input.password !== undefined) {
      this.#setPassword(user, validatePassword(input.password), true)
    } else {
      user.authVersion += 1
    }
    user.updatedAt = Date.now()
    this.#saveUsers()
    return publicUser(user)
  }

  deleteUser(admin: LocalUser, userID: string): void {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    const user = this.#users.find(candidate => candidate.id === userID)
    if (!user) throw new HttpError(404, '用户不存在', 'user_not_found')
    if (user.role === 'admin') throw new HttpError(409, '不能删除管理员账号', 'admin_account_protected')
    this.#users = this.#users.filter(candidate => candidate.id !== userID)
    this.#saveUsers()
    this.#revokeUser(userID)
  }

  changeCredentials(
    ctx: Koa.Context,
    currentPassword: string,
    newPassword: string,
    newUsername?: string,
  ): LocalUser {
    const current = this.require(ctx, true)
    const user = this.#users.find(candidate => candidate.id === current.id)!
    if (!this.#passwordMatches(user, currentPassword)) {
      throw new HttpError(401, '当前密码错误', 'invalid_current_password')
    }
    const username = newUsername === undefined ? user.username : canonicalUsername(newUsername)
    const normalized = username.toLocaleLowerCase('en-US')
    if (this.#users.some(candidate => candidate.id !== user.id && candidate.normalizedUsername === normalized)) {
      throw new HttpError(409, '用户名已存在', 'username_exists')
    }
    user.username = username
    user.normalizedUsername = normalized
    this.#setPassword(user, validatePassword(newPassword), false)
    user.mustChangePassword = false
    user.updatedAt = Date.now()
    this.#saveUsers()
    this.#revokeUser(user.id)
    return this.login(ctx, username, newPassword)
  }

  upstreamCredentials(fallback?: UpstreamCredentials): UpstreamCredentials | undefined {
    try {
      const encoded = Buffer.from(readFileSync(this.#credentialPath, 'utf8').trim(), 'base64url')
      if (encoded.byteLength < 29) return fallback
      const key = this.#key()
      const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12))
      decipher.setAuthTag(encoded.subarray(12, 28))
      const raw = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8')
      const value = JSON.parse(raw) as UpstreamCredentials
      return value.username && value.password ? value : fallback
    } catch {
      return fallback
    }
  }

  setUpstreamCredentials(admin: LocalUser, credentials: UpstreamCredentials): void {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    this.#writeUpstreamCredentials(credentials)
  }

  ensureUpstreamCredentials(): UpstreamCredentials {
    const existing = this.upstreamCredentials()
    if (existing) return existing
    const credentials = {
      username: 'yaoyao-service',
      password: randomBytes(32).toString('base64url'),
    }
    this.#writeUpstreamCredentials(credentials)
    return credentials
  }

  #writeUpstreamCredentials(credentials: UpstreamCredentials): void {
    const username = canonicalUsername(credentials.username)
    const password = validatePassword(credentials.password, true)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key(), iv)
    const encrypted = Buffer.concat([
      iv,
      cipher.update(JSON.stringify({ username, password }), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    // Store as IV + auth tag + ciphertext for a stable, inspectable envelope.
    const normalized = Buffer.concat([encrypted.subarray(0, 12), encrypted.subarray(-16), encrypted.subarray(12, -16)])
    this.#atomicWrite(this.#credentialPath, `${normalized.toString('base64url')}\n`)
  }

  #token(ctx: Koa.Context): string | undefined {
    return parse(ctx.get('cookie') || '')[SESSION_COOKIE]
  }

  #revokeUser(userID: string): void {
    for (const [token, session] of this.#sessions) {
      if (session.userID === userID) this.#sessions.delete(token)
    }
    this.#saveSessions()
  }

  #passwordMatches(user: StoredUser, password: string): boolean {
    try {
      const expected = Buffer.from(user.passwordHash, 'base64')
      const actual = passwordDigest(password, Buffer.from(user.salt, 'base64'))
      return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }

  #setPassword(user: StoredUser, password: string, mustChange: boolean): void {
    const salt = randomBytes(16)
    user.salt = salt.toString('base64')
    user.passwordHash = passwordDigest(password, salt).toString('base64')
    user.mustChangePassword = mustChange
    user.authVersion += 1
  }

  #newUser(username: string, password: string, role: LocalRole, mustChange: boolean, now: number): StoredUser {
    const salt = randomBytes(16)
    return {
      id: randomUUID().toLowerCase(),
      username,
      normalizedUsername: username.toLocaleLowerCase('en-US'),
      role,
      enabled: true,
      mustChangePassword: mustChange,
      salt: salt.toString('base64'),
      passwordHash: passwordDigest(password, salt).toString('base64'),
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    }
  }

  #loadUsers(): StoredUser[] {
    try {
      const value = JSON.parse(readFileSync(this.#path, 'utf8')) as StoredUsers
      if (value.version !== 1 || !Array.isArray(value.users) || value.users.length === 0) throw new Error()
      return value.users
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('8800 用户库损坏，已停止启动以避免覆盖数据')
      }
      const now = Date.now()
      const users = [this.#newUser('admin', 'admin', 'admin', true, now)]
      this.#users = users
      this.#saveUsers()
      return users
    }
  }

  #saveUsers(): void {
    this.#atomicWrite(this.#path, `${JSON.stringify({ version: 1, users: this.#users }, null, 2)}\n`)
  }

  #sessionKey(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url')
  }

  #loadSessions(): void {
    try {
      const value = JSON.parse(readFileSync(this.#sessionsPath, 'utf8')) as StoredSessions
      if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error('invalid sessions')
      const now = Date.now()
      for (const session of value.sessions) {
        if (session.tokenHash && session.expiresAt > now) {
          this.#sessions.set(session.tokenHash, {
            userID: session.userID, authVersion: session.authVersion, expiresAt: session.expiresAt,
          })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt sessions are safely discarded; user credentials remain authoritative.
      }
    }
  }

  #saveSessions(): void {
    const sessions = [...this.#sessions.entries()].map(([tokenHash, value]) => ({ tokenHash, ...value }))
    this.#atomicWrite(this.#sessionsPath, `${JSON.stringify({ version: 1, sessions })}\n`)
  }

  #key(): Buffer {
    try {
      const key = readFileSync(this.#keyPath)
      if (key.byteLength !== 32) throw new Error('invalid key')
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const key = randomBytes(32)
      this.#atomicWrite(this.#keyPath, key)
      return key
    }
  }

  #atomicWrite(path: string, value: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, value, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  }
}

export class UpstreamServiceSession {
  readonly #jar = new CookieJar('')
  #loginTask: Promise<void> | undefined

  constructor(
    readonly client: UpstreamClient,
    readonly credentials: () => UpstreamCredentials | undefined,
  ) {}

  get jar(): CookieJar { return this.#jar }

  async ensure(): Promise<void> {
    const status = await this.client.request('/api/status', this.#jar)
    if (status.status < 200 || status.status >= 300) throw new HttpError(502, '9119 状态不可用', 'upstream_unavailable')
    const parsed = JSON.parse(status.body.toString('utf8')) as Record<string, unknown>
    if (parsed.auth_required !== true && parsed.authRequired !== true) return
    const me = await this.client.request('/api/auth/me', this.#jar)
    if (me.status >= 200 && me.status < 300) return
    if (!this.#loginTask) this.#loginTask = this.#login().finally(() => { this.#loginTask = undefined })
    await this.#loginTask
  }

  async request(path: string, options: UpstreamRequestOptions = {}): Promise<UpstreamResponse> {
    await this.ensure()
    let response = await this.client.request(path, this.#jar, options)
    if (response.status === 401) {
      await this.#login()
      response = await this.client.request(path, this.#jar, options)
    }
    return response
  }

  async verify(credentials: UpstreamCredentials): Promise<void> {
    await this.#authenticate(credentials, new CookieJar(''))
  }

  async #login(): Promise<void> {
    const credentials = this.credentials()
    if (!credentials) throw new HttpError(503, '尚未配置 9119 服务账号', 'upstream_credentials_required')
    await this.#authenticate(credentials, this.#jar)
  }

  async #authenticate(credentials: UpstreamCredentials, jar: CookieJar): Promise<void> {
    const providers = await this.client.request('/api/auth/providers', jar)
    if (providers.status < 200 || providers.status >= 300) throw new HttpError(502, '无法读取 9119 登录方式', 'upstream_auth_unavailable')
    const response = await this.client.request('/auth/password-login', jar, {
      method: 'POST',
      body: { provider: 'basic', username: credentials.username, password: credentials.password, next: '' },
    })
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(503, '9119 服务账号验证失败', 'upstream_credentials_invalid')
    }
  }
}
