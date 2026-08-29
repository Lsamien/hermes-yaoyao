import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import NodePairingPanel from '@/components/app/NodePairingPanel.vue'
import { accountPairingStatus, createAccountPairing } from '@/api/accountPairing'
import {
  createPairing,
  pairChildNode,
  pairedDevices,
  pairingStatus,
  revokePairedDevice,
  type NodeScope,
} from '@/api/pairing'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,cXItY29kZQ=='),
  },
}))

vi.mock('@/api/accountPairing', () => ({
  accountPairingStatus: vi.fn(),
  createAccountPairing: vi.fn(),
}))

vi.mock('@/api/pairing', () => ({
  createPairing: vi.fn(),
  pairChildNode: vi.fn(),
  pairedDevices: vi.fn(),
  pairingStatus: vi.fn(),
  revokePairedDevice: vi.fn(),
}))

const allScopes: NodeScope[] = [
  'agents.read',
  'history.read',
  'sessions.execute',
  'groups.read',
  'groups.execute',
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-29T04:00:00.000Z'))
  vi.mocked(createAccountPairing).mockResolvedValue({
    protocolVersion: 1,
    serviceType: 'hermes-yaoyao',
    pairingId: 'account-pairing-1',
    expiresAt: Date.now() + 60_000,
    qrPayload: 'yaoyao://login?v=1&id=account-pairing-1',
  })
  vi.mocked(accountPairingStatus).mockResolvedValue({ state: 'pending' })
  vi.mocked(pairedDevices).mockResolvedValue({
    nodeId: 'node-12345678',
    fingerprint: 'fingerprint-1',
    devices: [],
  })
  vi.mocked(createPairing).mockResolvedValue({
    protocolVersion: 1,
    pairingId: 'node-pairing-1',
    nodeId: 'node-12345678',
    fingerprint: 'fingerprint-1',
    scopes: [...allScopes],
    expiresAt: Date.now() + 60_000,
    qrPayload: 'yaoyao://pair?v=1&id=node-pairing-1',
  })
  vi.mocked(pairingStatus).mockResolvedValue({ state: 'pending' })
  vi.mocked(pairChildNode).mockResolvedValue(undefined)
  vi.mocked(revokePairedDevice).mockResolvedValue(undefined)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
})

describe('NodePairingPanel', () => {
  it('account 模式只创建账号登录二维码，并在停用时清理轮询', async () => {
    const wrapper = mount(NodePairingPanel, {
      attachTo: document.body,
      props: { active: true, mode: 'account', isAdmin: true, userName: 'admin' },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()

    expect(createAccountPairing).toHaveBeenCalledOnce()
    expect(QRCode.toDataURL).toHaveBeenCalledWith(
      'yaoyao://login?v=1&id=account-pairing-1',
      expect.objectContaining({ width: 296, margin: 2, errorCorrectionLevel: 'M' }),
    )
    expect(pairedDevices).not.toHaveBeenCalled()
    expect(createPairing).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('在 iOS 登录页选择扫码')
    expect(vi.getTimerCount()).toBe(1)

    await wrapper.setProps({ active: false })
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)

    wrapper.unmount()
  })

  it('nodes 模式先只加载设备，生成二维码时传递完整授权范围，并在卸载时清理轮询', async () => {
    const wrapper = mount(NodePairingPanel, {
      attachTo: document.body,
      props: { active: true, mode: 'nodes', isAdmin: true },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()

    expect(pairedDevices).toHaveBeenCalledOnce()
    expect(createAccountPairing).not.toHaveBeenCalled()
    expect(createPairing).not.toHaveBeenCalled()
    expect(QRCode.toDataURL).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('还没有已授权设备')
    expect(vi.getTimerCount()).toBe(0)

    await wrapper.get('button.create-pairing').trigger('click')
    await flushPromises()

    expect(createPairing).toHaveBeenCalledWith(allScopes)
    expect(QRCode.toDataURL).toHaveBeenCalledWith(
      'yaoyao://pair?v=1&id=node-pairing-1',
      expect.objectContaining({ width: 296, margin: 2, errorCorrectionLevel: 'M' }),
    )
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops a camera stream whose startup becomes stale before video playback completes', async () => {
    let resolvePlay: (() => void) | undefined
    const play = new Promise<void>(resolve => { resolvePlay = resolve })
    const track = { stop: vi.fn() }
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    vi.stubGlobal('BarcodeDetector', class {
      detect = vi.fn(async () => [])
    })
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(play)
    const wrapper = mount(NodePairingPanel, {
      attachTo: document.body,
      props: { active: true, mode: 'nodes', isAdmin: true },
      global: { stubs: { AppIcon: true } },
    })
    await flushPromises()

    const scan = wrapper.findAll<HTMLButtonElement>('button').find(button => button.text().includes('使用摄像头扫码'))!
    await scan.trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(playSpy).toHaveBeenCalledOnce()

    const stop = wrapper.findAll<HTMLButtonElement>('button').find(button => button.text().includes('停止扫码'))!
    await stop.trigger('click')
    expect(track.stop).toHaveBeenCalledOnce()
    resolvePlay?.()
    await flushPromises()

    expect(vi.getTimerCount()).toBe(0)
    expect(wrapper.text()).not.toContain('停止扫码')
    wrapper.unmount()
  })
})
