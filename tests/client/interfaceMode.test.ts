import { beforeEach, describe, expect, it } from 'vitest'
import { rememberInterfacePath, savedInterfacePath } from '@/utils/interfaceMode'

beforeEach(() => localStorage.clear())

describe('last interface mode', () => {
  it('opens application-owned chats by default and remembers an explicit history choice', () => {
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/conversations/existing-group')
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/files')
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/history/existing-session')
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/chat/existing-session')
    expect(savedInterfacePath()).toBe('/chat')
  })

  it('does not mistake unrelated paths or invalid storage for a mode', () => {
    localStorage.setItem('hermes-yaoyao:interface-mode', 'invalid')
    expect(savedInterfacePath()).toBe('/conversations')
    rememberInterfacePath('/conversations-other')
    expect(savedInterfacePath()).toBe('/conversations')
  })
})
