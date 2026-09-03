import { beforeEach, describe, expect, it } from 'vitest'
import { rememberInterfacePath, savedInterfacePath } from '@/utils/interfaceMode'

beforeEach(() => localStorage.clear())

describe('last interface mode', () => {
  it('restores Bot mode and chat mode after explicit navigation', () => {
    expect(savedInterfacePath()).toBe('/chat')
    rememberInterfacePath('/conversations/existing-group')
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/files')
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/chat/existing-session')
    expect(savedInterfacePath()).toBe('/chat')
  })

  it('does not mistake unrelated paths or invalid storage for a mode', () => {
    localStorage.setItem('hermes-yaoyao:interface-mode', 'invalid')
    expect(savedInterfacePath()).toBe('/chat')
    rememberInterfacePath('/conversations-other')
    expect(savedInterfacePath()).toBe('/chat')
  })
})
