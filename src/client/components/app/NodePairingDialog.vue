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

const props = withDefaults(defineProps<{ open: boolean; insecureTransport?: boolean; userName?: string; isAdmin?: boolean }>(), {
  insecureTransport: false,
  userName: '',
  isAdmin: false,
})
const emit = defineEmits<{ close: [] }>()

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
const now = ref(Date.now())
let timer: number | undefined
let accountTimer: number | undefined
let scanTimer: number | undefined
let scanStream: MediaStream | undefined

type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>> }
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike

const secondsRemaining = computed(() => pairing.value
  ? Math.max(0, Math.ceil((pairing.value.expiresAt - now.value) / 1_000))
  : 0)
const accountSecondsRemaining = computed(() => accountPairing.value
  ? Math.max(0, Math.ceil((accountPairing.value.expiresAt - now.value) / 1_000))
  : 0)

function stopPolling() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
}

function stopAccountPolling() {
  if (accountTimer !== undefined) window.clearInterval(accountTimer)
  accountTimer = undefined
}

async function pollAccountPairing() {
  now.value = Date.now()
  const current = accountPairing.value
  if (!current || accountSecondsRemaining.value <= 0) { stopAccountPolling(); return }
  try {
    const status = await accountPairingStatus(current.pairingId)
    if (status.state === 'claimed') {
      accountPairingComplete.value = true
      stopAccountPolling()
    } else if (status.state === 'expired') stopAccountPolling()
  } catch { /* Keep a still-valid QR code during transient polling failures. */ }
}

async function beginAccountPairing() {
  busy.value = true; error.value = ''; accountPairingComplete.value = false; stopAccountPolling()
  try {
    const created = await createAccountPairing()
    accountPairing.value = created
    now.value = Date.now()
    accountQrImage.value = await QRCode.toDataURL(created.qrPayload, {
      width: 296, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#191918', light: '#ffffff' },
    })
    accountTimer = window.setInterval(() => { void pollAccountPairing() }, 1_000)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法创建手机登录二维码' }
  finally { busy.value = false }
}

function stopScanning() {
  if (scanTimer !== undefined) window.clearInterval(scanTimer)
  scanTimer = undefined
  scanStream?.getTracks().forEach(track => track.stop())
  scanStream = undefined
  scanning.value = false
}

async function startScanning() {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    error.value = '当前浏览器不支持直接扫码，请粘贴配对码。'
    return
  }
  stopScanning(); error.value = ''
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    scanning.value = true
    await new Promise(resolve => window.setTimeout(resolve, 0))
    if (scanVideo.value) { scanVideo.value.srcObject = scanStream; await scanVideo.value.play() }
    const detector = new Detector({ formats: ['qr_code'] })
    scanTimer = window.setInterval(() => {
      const video = scanVideo.value
      if (!video || video.readyState < 2) return
      void detector.detect(video).then(values => {
        const payload = values.find(value => value.rawValue?.startsWith('yaoyao://pair'))?.rawValue
        if (payload) { childCode.value = payload; stopScanning() }
      }).catch(() => undefined)
    }, 350)
  } catch { error.value = '无法使用摄像头，请检查权限或直接粘贴配对码。'; stopScanning() }
}

async function refreshDevices() {
  const response = await pairedDevices()
  devices.value = response.devices
  nodeID.value = response.nodeId
}

async function poll() {
  now.value = Date.now()
  const current = pairing.value
  if (!current || secondsRemaining.value <= 0) {
    stopPolling()
    return
  }
  try {
    const status = await pairingStatus(current.pairingId)
    if (status.state === 'claimed') {
      pairing.value = undefined
      qrImage.value = ''
      stopPolling()
      await refreshDevices()
    } else if (status.state === 'expired') {
      stopPolling()
    }
  } catch {
    // A transient poll failure must not discard a still-valid QR code.
  }
}

async function beginPairing() {
  busy.value = true
  error.value = ''
  stopPolling()
  stopAccountPolling()
  try {
    const created = await createPairing(ALL_SCOPES)
    pairing.value = created
    now.value = Date.now()
    qrImage.value = await QRCode.toDataURL(created.qrPayload, {
      width: 296,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#191918', light: '#ffffff' },
    })
    timer = window.setInterval(() => { void poll() }, 1_000)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法创建配对二维码'
  } finally {
    busy.value = false
  }
}

async function addChild() {
  busy.value = true
  error.value = ''
  try {
    await pairChildNode(childCode.value.trim(), childName.value.trim() || undefined)
    childCode.value = ''
    childName.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '添加子节点失败'
  } finally {
    busy.value = false
  }
}

async function revoke(device: PairedDevice) {
  if (!window.confirm(`撤销“${device.name}”的 Hermes 访问权限？`)) return
  busy.value = true
  error.value = ''
  try {
    await revokePairedDevice(device.id)
    await refreshDevices()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '撤销设备失败'
  } finally {
    busy.value = false
  }
}

watch(() => props.open, open => {
  stopPolling()
  stopScanning()
  pairing.value = undefined
  accountPairing.value = undefined
  qrImage.value = ''
  accountQrImage.value = ''
  accountPairingComplete.value = false
  error.value = ''
  if (open) {
    void beginAccountPairing()
    if (!props.isAdmin) return
    busy.value = true
    void refreshDevices()
      .catch(cause => { error.value = cause instanceof Error ? cause.message : '读取配对设备失败' })
      .finally(() => { busy.value = false })
  }
})

onBeforeUnmount(() => { stopPolling(); stopAccountPolling(); stopScanning() })
</script>

<template>
  <Teleport to="body">
    <Transition name="pairing-fade">
      <div v-if="open" class="pairing-layer" role="presentation" @mousedown.self="emit('close')">
        <section class="pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
          <header>
            <div><small>YAOYAO MOBILE</small><h2 id="pairing-title">手机登录与节点</h2></div>
            <button class="icon-button" type="button" aria-label="关闭手机与节点" @click="emit('close')"><AppIcon name="close" /></button>
          </header>

          <p class="pairing-intro">手机扫描登录二维码后，会把这台 15300 保存为普通服务器账号；不会添加成子节点。</p>
          <p v-if="insecureTransport" class="pairing-warning"><AppIcon name="alert" :size="15" />当前是局域网 HTTP，二维码免密配对仅适用于可信网络。正式使用请配置 HTTPS/WSS 或 Tailscale。</p>
          <p v-if="error" class="pairing-error">{{ error }}</p>

          <section class="account-login-section">
            <div class="device-heading"><strong>扫码登录并添加服务器</strong><small>{{ userName }}</small></div>
            <section v-if="accountPairing" class="qr-card">
              <img v-if="accountQrImage" :src="accountQrImage" alt="手机扫码登录并添加服务器" />
              <strong>{{ accountPairingComplete ? '手机已添加此服务器' : '在 iOS 登录页选择扫码' }}</strong>
              <span v-if="accountPairingComplete">该二维码已经失效</span>
              <span v-else-if="accountSecondsRemaining">二维码将在 {{ accountSecondsRemaining }} 秒后失效</span>
              <span v-else>二维码已失效</span>
              <button v-if="accountPairingComplete || !accountSecondsRemaining" class="quiet-button" type="button" @click="beginAccountPairing">重新生成</button>
            </section>
          </section>

          <section v-if="isAdmin" class="device-section">
            <div class="device-heading"><strong>授权为 15300 子节点</strong><small>管理员</small></div>
          <section v-if="pairing" class="qr-card">
            <img v-if="qrImage" :src="qrImage" alt="添加此 Hermes 节点的二维码" />
            <strong>仅用于子节点配对</strong>
            <span v-if="secondsRemaining">二维码将在 {{ secondsRemaining }} 秒后失效</span>
            <span v-else>二维码已失效</span>
            <button v-if="!secondsRemaining" class="quiet-button" type="button" @click="beginPairing">重新生成</button>
          </section>
          <button v-else class="solid-button create-pairing" type="button" :disabled="busy" @click="beginPairing">
            <AppIcon name="users" :size="17" />{{ busy ? '正在准备…' : '生成子节点配对二维码' }}
          </button>
          </section>

          <section v-if="isAdmin" class="device-section">
            <div class="device-heading"><strong>已授权设备</strong><small v-if="nodeID">节点 {{ nodeID.slice(0, 8) }}</small></div>
            <p v-if="!busy && !devices.length" class="device-empty">还没有已授权设备。</p>
            <div v-for="device in devices" :key="device.id" class="device-row">
              <span><b>{{ device.name }}</b><small>{{ device.scopes.includes('history.read') ? 'Bots、历史与团队' : '受限访问' }}</small></span>
              <button type="button" :disabled="busy" @click="revoke(device)">撤销</button>
            </div>
          </section>
          <section v-if="isAdmin" class="device-section child-section">
            <div class="device-heading"><strong>添加 15300 子节点</strong><small>只管理直接子节点</small></div>
            <label><span>节点名称（可选）</span><input v-model="childName" placeholder="例如：办公室 Mac" /></label>
            <label><span>子节点配对码</span><textarea v-model="childCode" rows="3" placeholder="粘贴子节点生成的 yaoyao://pair…" /></label>
            <video v-if="scanning" ref="scanVideo" class="scanner-video" muted playsinline />
            <button class="quiet-button" type="button" @click="scanning ? stopScanning() : startScanning()">{{ scanning ? '停止扫码' : '使用摄像头扫码' }}</button>
            <button class="solid-button create-pairing" type="button" :disabled="busy || !childCode.trim()" @click="addChild">验证并添加子节点</button>
          </section>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pairing-layer { position: fixed; z-index: 260; inset: 0; display: grid; place-items: center; padding: 18px; background: var(--scrim); backdrop-filter: blur(6px); }
.pairing-dialog { width: min(470px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow-y: auto; padding: 18px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface-raised); box-shadow: var(--shadow-float); }
header { display: flex; align-items: flex-start; justify-content: space-between; } header small { color: var(--text-muted); font-size: 9px; letter-spacing: .08em; } h2 { margin: 3px 0 0; font-size: 19px; letter-spacing: -.03em; }
.pairing-intro { margin: 17px 0 14px; color: var(--text-secondary); font-size: 11px; line-height: 1.65; }
.pairing-warning, .pairing-error { margin: 0 0 13px; padding: 10px; border-radius: 10px; font-size: 10px; line-height: 1.55; }.pairing-warning { display: flex; gap: 7px; background: color-mix(in srgb, var(--warning, #bd7611) 10%, transparent); color: var(--text-secondary); }.pairing-error { background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); }
.create-pairing { width: 100%; min-height: 43px; gap: 8px; }
.account-login-section { display: grid; gap: 8px; margin-top: 14px; }.account-login-section > .device-heading { margin-bottom: 0; }
.pairing-credentials { display: grid; gap: 10px; margin-bottom: 13px; }.pairing-credentials label { display: grid; gap: 5px; color: var(--text-secondary); font-size: 10px; }.pairing-credentials input { min-height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; outline: 0; background: var(--surface-soft); color: var(--text-primary); }.pairing-credentials input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.pairing-credentials small { color: var(--text-muted); font-size: 9px; line-height: 1.5; }
.qr-card { display: grid; justify-items: center; gap: 7px; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: #fff; color: #191918; }.qr-card img { width: min(296px, 100%); aspect-ratio: 1; }.qr-card strong { font-size: 12px; }.qr-card span { color: #686865; font-size: 10px; }.qr-card .quiet-button { color: #191918; }
.device-section { margin-top: 19px; padding-top: 15px; border-top: 1px solid var(--line); }.device-heading { display: flex; justify-content: space-between; margin-bottom: 8px; }.device-heading strong { font-size: 11px; }.device-heading small, .device-empty { color: var(--text-muted); font-size: 9px; }.device-empty { margin: 12px 1px; }
.device-row { display: flex; align-items: center; gap: 12px; min-height: 47px; padding: 6px 2px; border-bottom: 1px solid var(--line); }.device-row span { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.device-row b { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.device-row small { color: var(--text-muted); font-size: 9px; }.device-row button { border: 0; background: transparent; color: var(--danger); font-size: 10px; cursor: pointer; }
.child-section { display: grid; gap: 9px; }.child-section label { display: grid; gap: 5px; color: var(--text-secondary); font-size: 10px; }.child-section input,.child-section textarea { padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-soft); color: var(--text-primary); font: inherit; resize: vertical; }
.scanner-video { width: 100%; max-height: 260px; border-radius: 11px; background: #111; object-fit: cover; }
.pairing-fade-enter-active, .pairing-fade-leave-active { transition: opacity 140ms ease; }.pairing-fade-enter-active .pairing-dialog, .pairing-fade-leave-active .pairing-dialog { transition: transform 170ms var(--ease-out); }.pairing-fade-enter-from, .pairing-fade-leave-to { opacity: 0; }.pairing-fade-enter-from .pairing-dialog, .pairing-fade-leave-to .pairing-dialog { transform: translateY(8px) scale(.985); }
@media (max-width: 540px) { .pairing-layer { place-items: end center; padding: 0; }.pairing-dialog { width: 100%; max-height: calc(100vh - 12px); border-radius: 19px 19px 0 0; padding-bottom: max(18px, env(safe-area-inset-bottom)); } }
</style>
