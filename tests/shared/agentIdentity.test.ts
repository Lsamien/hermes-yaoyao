import { describe, expect, it } from 'vitest'
import {
  YAOYAO_AGENT_IDENTITY_NAMESPACE,
  agentIdentityFromProfile,
  decodeAgentMascotAvatar,
  defaultAgentIdentity,
  encodeAgentAvatar,
} from '../../src/shared/agentIdentity'

describe('Yaoyao agent identity', () => {
  it('inherits the legacy Bots title once but never its avatar asset', () => {
    const identity = agentIdentityFromProfile({
      name: 'default',
      ui_meta: { 'hermes-bots': { title: '竹儿' } },
    })

    expect(identity.displayName).toBe('竹儿')
    expect(identity.avatarMode).toBe('mascot')
    expect(encodeAgentAvatar(identity)).toMatch(/^yaoyao-mascot:v1:/)
  })

  it('reads the independent Yaoyao namespace ahead of legacy data', () => {
    const identity = agentIdentityFromProfile({
      name: 'researcher',
      ui_meta: {
        'hermes-bots': { title: '旧名称' },
        [YAOYAO_AGENT_IDENTITY_NAMESPACE]: {
          version: 1,
          display_name: '新名称',
          avatar_mode: 'mascot',
          shape: 'triangle',
          color: '#0ea5c6',
          expression: 'curious',
        },
      },
    })

    expect(identity.displayName).toBe('新名称')
    expect(decodeAgentMascotAvatar(encodeAgentAvatar(identity))).toEqual({
      shape: 'triangle', color: '#0ea5c6', expression: 'curious',
    })
  })

  it('derives the same default shape and color for the same profile', () => {
    expect(defaultAgentIdentity('designer')).toEqual(defaultAgentIdentity('designer'))
    expect(defaultAgentIdentity('designer')).not.toEqual(defaultAgentIdentity('reviewer'))
  })
})
