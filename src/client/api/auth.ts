import type { BootstrapResponse, CurrentUser, JsonValue, Profile } from '@shared/types'
import { apiRequest, setApiCsrfToken, unwrapData } from './client'
import { bool, normalizeProfile, normalizeUser, record, string, values } from '@/utils/normalize'
import { getProfileAvatarDataURLs } from './profiles'

function normalizeBootstrap(payload: unknown): BootstrapResponse {
  const root = record(unwrapData(payload as never))
  const status = record(root.status)
  const authRequired = bool(root.authRequired ?? root.auth_required ?? status.authRequired ?? status.auth_required)
  const rawUser = root.user ?? root.identity
  const profiles = values(root.profiles).map(normalizeProfile)
  const csrfToken = string(root.csrfToken ?? root.csrf_token ?? root.csrf)
  const response: BootstrapResponse = {
    status: string(status.state ?? root.state) || undefined,
    authRequired,
    profiles,
    csrfToken,
    insecureLan: bool(root.insecureLan ?? root.insecure_lan),
    groupUploadsEnabled: bool(root.groupUploadsEnabled ?? root.group_uploads_enabled),
    upstreamReady: bool(root.upstreamReady ?? root.upstream_ready),
    upstreamError: string(root.upstreamError ?? root.upstream_error) || undefined,
    serverKind: string(root.serverKind ?? root.server_kind) || undefined,
  }
  if (rawUser) response.user = normalizeUser(rawUser)
  setApiCsrfToken(csrfToken)
  return response
}

export async function bootstrap(): Promise<BootstrapResponse> {
  return normalizeBootstrap(await apiRequest<unknown>('/api/app/bootstrap', { csrf: false }))
}

export interface LoginInput {
  username: string
  password: string
  provider?: string
}

export async function login(input: LoginInput): Promise<BootstrapResponse> {
  const payload = await apiRequest<unknown>('/api/app/login', {
    method: 'POST',
    body: { ...input, next: '/' } as JsonValue,
    notifyUnauthorized: false,
  })
  const response = normalizeBootstrap(payload)
  if (!response.user && response.authRequired) return bootstrap()
  return response
}

export async function logout(): Promise<void> {
  await apiRequest('/api/app/logout', { method: 'POST', body: {}, notifyUnauthorized: false })
  setApiCsrfToken('')
}

export async function fetchProfiles(): Promise<Profile[]> {
  const payload = record(unwrapData(await apiRequest<unknown>('/api/app/profiles')))
  return values(payload.profiles ?? payload.items ?? payload).map(normalizeProfile)
}

export async function fetchProfileAvatars(profiles: Profile[]): Promise<Record<string, string>> {
  return getProfileAvatarDataURLs(profiles)
}

export async function fetchCurrentUser(): Promise<CurrentUser | undefined> {
  const response = await bootstrap()
  return response.user
}

export async function changeCredentials(input: {
  currentPassword: string
  newPassword: string
  username?: string
}): Promise<CurrentUser> {
  const payload = record(unwrapData(await apiRequest<unknown>('/api/app/account/credentials', {
    method: 'PUT', body: input as unknown as JsonValue,
  })))
  return normalizeUser(payload.user ?? payload)
}
