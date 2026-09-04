export type InterfaceMode = 'chat' | 'bots'
const KEY = 'hermes-yaoyao:interface-mode'

export function savedInterfacePath(): '/chat' | '/conversations' {
  try { return localStorage.getItem(KEY) === 'chat' ? '/chat' : '/conversations' }
  catch { return '/conversations' }
}

export function rememberInterfacePath(path: string): void {
  const mode: InterfaceMode | undefined = /^\/conversations(?:\/|$)/.test(path) ? 'bots'
    : /^\/chat(?:\/|$)/.test(path) ? 'chat' : undefined
  if (!mode) return
  try { localStorage.setItem(KEY, mode) } catch { /* storage may be unavailable */ }
}
