import type { JsonValue } from '@shared/types'
import { apiRequest } from './client'

export type NodeScope =
  | 'agents.read'
  | 'history.read'
  | 'sessions.execute'
  | 'groups.read'
  | 'groups.execute'

export interface PairingSession {
  protocolVersion: number
  pairingId: string
  nodeId: string
  fingerprint: string
  scopes: NodeScope[]
  expiresAt: number
  qrPayload: string
}

export interface PairedDevice {
  id: string
  name: string
  scopes: NodeScope[]
  createdAt: number
  lastUsedAt: number
}

export interface PairedDevicesResponse {
  nodeId: string
  fingerprint: string
  devices: PairedDevice[]
}

export async function createPairing(
  scopes: NodeScope[],
  username: string,
  password: string,
): Promise<PairingSession> {
  return apiRequest<PairingSession>('/api/app/pairings', {
    method: 'POST',
    body: { scopes, username, password } as unknown as JsonValue,
  })
}

export async function pairingStatus(
  pairingId: string,
): Promise<{ state: 'pending' | 'claimed' | 'expired'; deviceID?: string }> {
  return apiRequest(`/api/app/pairings/${encodeURIComponent(pairingId)}`)
}

export async function pairedDevices(): Promise<PairedDevicesResponse> {
  return apiRequest('/api/app/paired-devices')
}

export async function revokePairedDevice(deviceId: string): Promise<void> {
  await apiRequest(`/api/app/paired-devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE', body: {} as JsonValue,
  })
}
