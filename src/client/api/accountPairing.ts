import { apiRequest } from './client'

export interface AccountPairingSession {
  protocolVersion: number
  serviceType: string
  pairingId: string
  expiresAt: number
  qrPayload: string
}

export async function createAccountPairing(): Promise<AccountPairingSession> {
  return apiRequest('/api/app/account-pairings', { method: 'POST', body: {} })
}

export async function accountPairingStatus(
  pairingId: string,
): Promise<{ state: 'pending' | 'claimed' | 'expired' }> {
  return apiRequest(`/api/app/account-pairings/${encodeURIComponent(pairingId)}`)
}
