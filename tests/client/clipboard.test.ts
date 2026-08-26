import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from '@/utils/clipboard'

function secureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value })
}

function clipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
})

describe('copyTextToClipboard', () => {
  it('uses the asynchronous clipboard API in a secure context', async () => {
    secureContext(true)
    const writeText = vi.fn(async () => undefined)
    clipboard(writeText)

    await expect(copyTextToClipboard('安全复制')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('安全复制')
  })

  it('falls back when an embedded browser rejects clipboard permission', async () => {
    secureContext(true)
    clipboard(vi.fn(async () => { throw new Error('NotAllowedError') }))
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await expect(copyTextToClipboard('兼容复制')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports failure and cleans up when both clipboard paths are unavailable', async () => {
    secureContext(false)
    clipboard()
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => { throw new Error('copy denied') }),
    })

    await expect(copyTextToClipboard('无法复制')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
