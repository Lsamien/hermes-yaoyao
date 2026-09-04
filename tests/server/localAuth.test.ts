import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Koa from 'koa'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalAuthStore } from '../../src/server/localAuth.js'

const homes: string[] = []

function context(cookie = ''): Koa.Context {
  const headers: Record<string, string | string[]> = {}
  return {
    state: {},
    get: (name: string) => name.toLowerCase() === 'cookie' ? cookie : '',
    set: (name: string, value: string | string[]) => { headers[name.toLowerCase()] = value },
    response: { headers },
  } as unknown as Koa.Context
}

function issuedCookie(ctx: Koa.Context): string {
  const value = ctx.response.headers['set-cookie']
  const raw = Array.isArray(value) ? value.at(-1) : String(value)
  return raw.split(';', 1)[0]!
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('8800 local users', () => {
  it('creates admin/admin and forces a credential change', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-'))
    homes.push(home)
    const store = new LocalAuthStore(home)
    const login = context()
    const admin = store.login(login, 'admin', 'admin')
    expect(admin).toMatchObject({ role: 'admin', mustChangePassword: true })
    const authenticated = context(issuedCookie(login))
    expect(() => store.require(authenticated)).toThrow(/修改初始密码/)

    const changed = store.changeCredentials(authenticated, 'admin', 'new-password', 'owner')
    expect(changed).toMatchObject({ username: 'owner', mustChangePassword: false })
    expect(store.require(context(issuedCookie(authenticated))).username).toBe('owner')
    const restarted = new LocalAuthStore(home)
    expect(restarted.require(context(issuedCookie(authenticated))).username).toBe('owner')
  })

  it('lets the administrator create, reset, disable and delete ordinary users', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-'))
    homes.push(home)
    const store = new LocalAuthStore(home)
    const first = context()
    store.login(first, 'admin', 'admin')
    const changedContext = context(issuedCookie(first))
    store.changeCredentials(changedContext, 'admin', 'new-password', 'admin')
    const admin = store.require(context(issuedCookie(changedContext)))
    const user = store.create(admin, 'member', 'temporary-password')
    expect(user.mustChangePassword).toBe(true)
    expect(store.updateUser(admin, user.id, { enabled: false }).enabled).toBe(false)
    store.deleteUser(admin, user.id)
    expect(store.list(admin).map(item => item.username)).toEqual(['admin'])
  })

  it('persists an account image without invalidating the existing session', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-')); homes.push(home)
    const store = new LocalAuthStore(home), login = context()
    store.login(login, 'admin', 'admin')
    const authenticated = context(issuedCookie(login))
    store.changeCredentials(authenticated, 'admin', 'new-password', 'admin')
    const active = context(issuedCookie(authenticated))
    const avatar = 'data:image/png;base64,aGVsbG8='
    expect(store.setAvatar(active, avatar).avatar).toBe(avatar)
    expect(store.require(active).avatar).toBe(avatar)
    expect(new LocalAuthStore(home).require(context(issuedCookie(authenticated))).avatar).toBe(avatar)
    expect(() => store.setAvatar(active, 'https://example.test/avatar.png')).toThrow(/PNG、JPEG/)
    expect(store.setAvatar(active, null).avatar).toBeUndefined()
  })

  it('encrypts the 9119 service password at rest', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-'))
    homes.push(home)
    const store = new LocalAuthStore(home)
    const first = context()
    store.login(first, 'admin', 'admin')
    const changedContext = context(issuedCookie(first))
    store.changeCredentials(changedContext, 'admin', 'new-password', 'admin')
    const admin = store.require(context(issuedCookie(changedContext)))
    store.setUpstreamCredentials(admin, { username: 'service', password: 'very-secret' })
    expect(store.upstreamCredentials()).toEqual({ username: 'service', password: 'very-secret' })
    expect(readFileSync(join(home, 'upstream-credentials.enc'), 'utf8')).not.toContain('very-secret')
  })
})
