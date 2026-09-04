<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import QRCode from 'qrcode'
import AppIcon from '@/components/common/AppIcon.vue'
import { accountPairingStatus, createAccountPairing, type AccountPairingSession } from '@/api/accountPairing'
import {
  createPairing,
  pairChildNode,
  pairedDevices,
  pairingStatus,
  revokePairedDevice,
  type NodeScope,
  type PairedDevice,
  type PairingSession,
} from '@/api/pairing'

const props = withDefaults(defineProps<{
  active?: boolean
  mode: 'account' | 'nodes'
  insecureTransport?: boolean
  userName?: string
  isAdmin?: boolean
}>(), {
  active: true,
  insecureTransport: false,
  userName: '',
  isAdmin: false,
})
const emit = defineEmits<{ 'dirty-change': [dirty: boolean] }>()

const ALL_SCOPES: NodeScope[] = [
  'agents.read', 'history.read', 'sessions.execute', 'groups.read', 'groups.execute',
]
const pairing = ref<PairingSession>()
const accountPairing = ref<AccountPairingSession>()
const qrImage = ref('')
const accountQrImage = ref('')
const accountPairingComplete = ref(false)
const devices = ref<PairedDevice[]>([])
const nodeID = ref('')
const busy = ref(false)
const error = ref('')
const childCode = ref('')
const childName = ref('')
const scanVideo = ref<HTMLVideoElement>()
const scanning = ref(false)
const scanStarting = ref(false)
const now = ref(Date.now())
let timer: number | undefined
let accountTimer: number | undefined
let scanTimer: number | undefined
let scanStream: MediaStream | undefined
let lifecycleToken = 0
let scanToken = 0
let nodePolling = false
let accountPolling = false

type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>> }
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike

const secondsRemaining = computed(() => pairing.value
  ? Math.max(0, Math.ceil((pairing.value.expiresAt - now.value) / 1_000))
  : 0)
const accountSecondsRemaining = computed(() => accountPairing.value
  ? Math.max(0, Math.ceil((accountPairing.value.expiresAt - now.value) / 1_000))
  : 0)
const dirty = computed(() => props.mode === 'nodes' && Boolean(childName.value.trim() || childCode.value.trim()))
watch(dirty, value => emit('dirty-change', value), { immediate: true })

function stopPolling() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  nodePolling = false
}

function stopAccountPolling() {
  if (accountTimer !== undefined) window.clearInterval(accountTimer)
  accountTimer = undefined
  accountPolling = false
}

function stopScanning() {
  scanToken += 1
  scanStarting.value = false
  if (scanTimer !== undefined) window.clearInterval(scanTimer)
  scanTimer = undefined
  scanStream?.getTracks().forEach(track => track.stop())
  scanStream = undefined
  scanning.value = false
}

function resetTransientState() {
  lifecycleToken += 1
  stopPolling()
  stopAccountPolling()
  stopScanning()
  pairing.value = undefined
  accountPairing.value = undefined
  qrImage.value = ''
  accountQrImage.value = ''
  accountPairingComplete.value = false
  childCode.value = ''
  childName.value = ''
  error.value = ''
  busy.value = false
}

function isCurrent(token: number, mode: 'account' | 'nodes'): boolean {
  return token === lifecycleToken && props.active && props.mode === mode
}

function isCurrentScan(token: number, lifecycle: number): boolean {
  return token === scanToken && isCurrent(lifecycle, 'nodes')
}

async function pollAccountPairing(token = lifecycleToken) {
  if (accountPolling || !isCurrent(token, 'account')) return
  accountPolling = true
  now.value = Date.now()
  const current = accountPairing.value
  if (!current || accountSecondsRemaining.value <= 0) { stopAccountPolling(); return }
  try {
    const status = await accountPairingStatus(current.pairingId)
    if (!isCurrent(token, 'account') || accountPairing.value?.pairingId !== current.pairingId) return
    if (status.state === 'claimed') {
      accountPairingComplete.value = true
      stopAccountPolling()
    } else if (status.state === 'expired') stopAccountPolling()
  } catch { /* Keep a still-valid QR code during transient polling failures. */ }
  finally { accountPolling = false }
}

async function beginAccountPairing() {
  if (busy.value || !props.active || props.mode !== 'account') return
  const token = lifecycleToken
  busy.value = true
  error.value = ''
  accountPairingComplete.value = false
  stopAccountPolling()
  try {
    const created = await createAccountPairing()
    if (!isCurrent(token, 'account')) return
    accountPairing.value = created
    now.value = Date.now()
    const image = await QRCode.toDataURL(created.qrPayload, {
      width: 296, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#191918', light: '#ffffff' },
    })
    if (!isCurrent(token, 'account')) return
    accountQrImage.value = image
    accountTimer = window.setInterval(() => { void pollAccountPairing(token) }, 1_000)
  } catch (cause) {
    if (isCurrent(token, 'account')) error.value = cause instanceof Error ? cause.message : '无法创建手机登录二维码'
  } finally {
    if (isCurrent(token, 'account')) busy.value = false
  }
}

async function startScanning() {
  if (scanStarting.value || scanning.value || !props.active || props.mode !== 'nodes') return
  const lifecycle = lifecycleToken
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    error.value = '当前浏览器不支持直接扫码，请粘贴配对码。'
    return
  }
  stopScanning()
  const token = scanToken
  scanStarting.value = true
  error.value = ''
  let ownedStream: MediaStream | undefined
  const releaseOwnedStream = () => {
    ownedStream?.getTracks().forEach(track => track.stop())
    if (scanStream === ownedStream) {
      scanStream = undefined
      scanning.value = false
    }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    ownedStream = stream
    if (!isCurrentScan(token, lifecycle)) {
      releaseOwnedStream()
      return
    }
    scanStream = stream
    scanStarting.value = false
    scanning.value = true
    await new Promise(resolve => window.setTimeout(resolve, 0))
    if (!isCurrentScan(token, lifecycle)) { releaseOwnedStream(); return }
    if (scanVideo.value) { scanVideo.value.srcObject = stream; await scanVideo.value.play() }
    if (!isCurrentScan(token, lifecycle)) { releaseOwnedStream(); return }
    const detector = new Detector({ formats: ['qr_code'] })
    scanTimer = window.setInterval(() => {
      if (!isCurrentScan(token, lifecycle)) { releaseOwnedStream(); return }
      const video = scanVideo.value
      if (!video || video.readyState < 2) return
      void detector.detect(video).then(values => {
        const payload = values.find(value => value.rawValue?.startsWith('yaoyao://pair'))?.rawValue
        if (payload && isCurrentScan(token, lifecycle)) { childCode.value = payload; stopScanning() }
      }).catch(() => undefined)
    }, 350)
  } catch {
    if (isCurrentScan(token, lifecycle)) {
      error.value = '无法使用摄像头，请检查权限或直接粘贴配对码。'
      stopScanning()
    } else {
      releaseOwnedStream()
    }
  } finally {
    if (isCurrentScan(token, lifecycle)) scanStarting.value = false
  }
}

async function refreshDevices(token = lifecycleToken) {
  const response = await pairedDevices()
  if (!isCurrent(token, 'nodes')) return
  devices.value = response.devices
  nodeID.value = response.nodeId
}

async function poll(token = lifecycleToken) {
  if (nodePolling || !isCurrent(token, 'nodes')) return
  nodePolling = true
  now.value = Date.now()
  const current = pairing.value
  if (!current || secondsRemaining.value <= 0) { stopPolling(); return }
  try {
    const status = await pairingStatus(current.pairingId)
    if (!isCurrent(token, 'nodes') || pairing.value?.pairingId !== current.pairingId) return
    if (status.state === 'claimed') {
      pairing.value = undefined
      qrImage.value = ''
      stopPolling()
      await refreshDevices(token)
    } else if (status.state === 'expired') stopPolling()
  } catch { /* A transient poll failure must not discard a still-valid QR code. */ }
  finally { nodePolling = false }
}

async function beginPairing() {
  if (!props.isAdmin || busy.value || !props.active || props.mode !== 'nodes') return
  const token = lifecycleToken
  busy.value = true
  error.value = ''
  stopPolling()
  try {
    const created = await createPairing(ALL_SCOPES)
    if (!isCurrent(token, 'nodes')) return
    pairing.value = created
    now.value = Date.now()
    const image = await QRCode.toDataURL(created.qrPayload, {
      width: 296, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#191918', light: '#ffffff' },
    })
    if (!isCurrent(token, 'nodes')) return
    qrImage.value = image
    timer = window.setInterval(() => { void poll(token) }, 1_000)
  } catch (cause) {
    if (isCurrent(token, 'nodes')) error.value = cause instanceof Error ? cause.message : '无法创建配对二维码'
  } finally {
    if (isCurrent(token, 'nodes')) busy.value = false
  }
}

async function addChild() {
  if (!props.isAdmin || busy.value || !props.active || props.mode !== 'nodes') return
  const token = lifecycleToken
  busy.value = true
  error.value = ''
  try {
    await pairChildNode(childCode.value.trim(), childName.value.trim() || undefined)
    if (!isCurrent(token, 'nodes')) return
    childCode.value = ''
    childName.value = ''
  } catch (cause) {
    if (isCurrent(token, 'nodes')) error.value = cause instanceof Error ? cause.message : '添加子节点失败'
  } finally {
    if (isCurrent(token, 'nodes')) busy.value = false
  }
}

async function revoke(device: PairedDevice) {
  if (!props.isAdmin || !window.confirm(`撤销“${device.name}”的 Hermes 访问权限？`)) return
  if (busy.value || !props.active || props.mode !== 'nodes') return
  const token = lifecycleToken
  busy.value = true
  error.value = ''
  try {
    await revokePairedDevice(device.id)
    if (!isCurrent(token, 'nodes')) return
    await refreshDevices(token)
  } catch (cause) {
    if (isCurrent(token, 'nodes')) error.value = cause instanceof Error ? cause.message : '撤销设备失败'
  } finally {
    if (isCurrent(token, 'nodes')) busy.value = false
  }
}

watch(() => [props.active, props.mode] as const, ([active, mode]) => {
  resetTransientState()
  if (!active) return
  if (mode === 'account') {
    void beginAccountPairing()
    return
  }
  if (!props.isAdmin) return
  const token = lifecycleToken
  busy.value = true
  void refreshDevices(token)
    .catch(cause => { if (isCurrent(token, 'nodes')) error.value = cause instanceof Error ? cause.message : '读取配对设备失败' })
    .finally(() => { if (isCurrent(token, 'nodes')) busy.value = false })
}, { immediate: true })

onBeforeUnmount(resetTransientState)
</script>

<template>
  <section class="pairing-panel" :aria-label="mode === 'account' ? '手机登录' : '节点与设备'">
    <p v-if="mode === 'account'" class="pairing-intro">手机扫描登录二维码后，会把这台 15300 保存为普通服务器账号；不会添加成子节点。</p>
    <p v-else class="pairing-intro">管理当前 15300 的直接子节点与已授权设备。账号登录设备不会在这里显示。</p>
    <p v-if="mode === 'account' && insecureTransport" class="pairing-warning"><AppIcon name="alert" :size="16" />当前是局域网 HTTP，二维码免密配对仅适用于可信网络。正式使用请配置 HTTPS/WSS 或 Tailscale。</p>
    <p v-if="error" class="pairing-error" role="alert">{{ error }}</p>

    <template v-if="mode === 'account'">
      <div class="device-heading"><strong>扫码登录并添加服务器</strong><small>{{ userName }}</small></div>
      <section v-if="accountPairing" class="qr-card">
        <img v-if="accountQrImage" :src="accountQrImage" alt="手机扫码登录并添加服务器" />
        <strong>{{ accountPairingComplete ? '手机已添加此服务器' : '在 iOS 登录页选择扫码' }}</strong>
        <span v-if="accountPairingComplete">该二维码已经失效</span>
        <span v-else-if="accountSecondsRemaining">二维码将在 {{ accountSecondsRemaining }} 秒后失效</span>
        <span v-else>二维码已失效</span>
        <button v-if="accountPairingComplete || !accountSecondsRemaining" class="quiet-button" type="button" @click="beginAccountPairing">重新生成</button>
      </section>
      <p v-else-if="busy" class="device-empty">正在生成登录二维码…</p>
    </template>

    <template v-else-if="isAdmin">
      <section class="device-section device-section--first">
        <div class="device-heading"><strong>授权为 15300 子节点</strong><small>管理员</small></div>
        <section v-if="pairing" class="qr-card">
          <img v-if="qrImage" :src="qrImage" alt="添加此 Hermes 节点的二维码" />
          <strong>仅用于子节点配对</strong>
          <span v-if="secondsRemaining">二维码将在 {{ secondsRemaining }} 秒后失效</span>
          <span v-else>二维码已失效</span>
          <button v-if="!secondsRemaining" class="quiet-button" type="button" @click="beginPairing">重新生成</button>
        </section>
        <button v-else class="solid-button create-pairing" type="button" :disabled="busy" @click="beginPairing"><AppIcon name="users" :size="17" />{{ busy ? '正在准备…' : '生成子节点配对二维码' }}</button>
      </section>

      <section class="device-section">
        <div class="device-heading"><strong>已授权设备</strong><small v-if="nodeID">节点 {{ nodeID.slice(0, 8) }}</small></div>
        <p v-if="!busy && !devices.length" class="device-empty">还没有已授权设备。</p>
        <div v-for="device in devices" :key="device.id" class="device-row">
          <span><b>{{ device.name }}</b><small>{{ device.scopes.includes('history.read') ? 'Bots、历史与团队' : '受限访问' }}</small></span>
          <button type="button" :disabled="busy" @click="revoke(device)">撤销</button>
        </div>
      </section>

      <section class="device-section child-section">
        <div class="device-heading"><strong>添加 15300 子节点</strong><small>只管理直接子节点</small></div>
        <label><span>节点名称（可选）</span><input v-model="childName" :disabled="busy" placeholder="例如：办公室 Mac" /></label>
        <label><span>子节点配对码</span><textarea v-model="childCode" rows="3" :disabled="busy" placeholder="粘贴子节点生成的 yaoyao://pair…" /></label>
        <video v-if="scanning" ref="scanVideo" class="scanner-video" muted playsinline />
        <div class="child-actions">
          <button class="quiet-button" type="button" :disabled="busy || scanStarting" @click="scanning ? stopScanning() : startScanning()">{{ scanStarting ? '正在打开摄像头…' : scanning ? '停止扫码' : '使用摄像头扫码' }}</button>
          <button class="solid-button" type="button" :disabled="busy || !childCode.trim()" @click="addChild">验证并添加子节点</button>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.pairing-panel { display: grid; gap: 18px; }
.pairing-intro { margin: 0; max-width: 650px; color: var(--text-secondary); font-size: 14px; line-height: 1.65; }
.pairing-warning,.pairing-error { margin: 0; padding: 12px 14px; border-radius: 10px; font-size: 13px; line-height: 1.55; }
.pairing-warning { display: flex; gap: 8px; background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary); }
.pairing-error { background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); }
.device-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.device-heading strong { font-size: 16px; }
.device-heading small,.device-empty { color: var(--text-muted); font-size: 13px; }
.device-empty { margin: 0; }
.qr-card { display: grid; width: min(360px, 100%); justify-self: center; justify-items: center; gap: 9px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: #fff; color: #191918; }
.qr-card img { width: min(260px, 100%); aspect-ratio: 1; }
.qr-card strong { font-size: 14px; }
.qr-card span { color: #686865; font-size: 12px; }
.device-section { display: grid; gap: 10px; padding-top: 20px; border-top: 1px solid var(--line); }
.device-section--first { padding-top: 0; border-top: 0; }
.device-row { display: flex; min-height: 54px; align-items: center; gap: 12px; padding: 8px 2px; border-bottom: 1px solid var(--line); }
.device-row span { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
.device-row b { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.device-row small { color: var(--text-muted); font-size: 12px; }
.device-row button { border: 0; background: transparent; color: var(--danger); font-size: 13px; cursor: pointer; }
.child-section label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 13px; font-weight: 600; }
.child-section input,.child-section textarea { padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--surface-soft); color: var(--text-primary); font: inherit; resize: vertical; }
.child-section input:focus,.child-section textarea:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }
.scanner-video { width: 100%; max-height: 260px; border-radius: 11px; background: #111; object-fit: cover; }
.child-actions { display: flex; justify-content: flex-end; gap: 10px; }
.quiet-button,.solid-button { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; gap: 7px; padding: 0 14px; border: 0; border-radius: 9px; cursor: pointer; font: 600 13px var(--font-ui); }
.quiet-button { border: 1px solid var(--line); background: var(--surface-raised); color: var(--text-secondary); }
.solid-button { background: var(--accent); color: var(--text-on-solid); }
.create-pairing { width: 100%; min-height: 44px; }
button:disabled { cursor: not-allowed; opacity: .5; }
@media (max-width: 700px) {
  .qr-card { width: 100%; box-sizing: border-box; }
  .child-actions { align-items: stretch; flex-direction: column; }
}
</style>
