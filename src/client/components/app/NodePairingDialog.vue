<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import QRCode from 'qrcode'
import AppIcon from '@/components/common/AppIcon.vue'
import {
  createPairing,
  pairedDevices,
  pairingStatus,
  revokePairedDevice,
  type NodeScope,
  type PairedDevice,
  type PairingSession,
} from '@/api/pairing'

const props = withDefaults(defineProps<{ open: boolean; insecureTransport?: boolean; userName?: string }>(), {
  insecureTransport: false,
  userName: '',
})
const emit = defineEmits<{ close: [] }>()

const ALL_SCOPES: NodeScope[] = [
  'agents.read', 'history.read', 'sessions.execute', 'groups.read', 'groups.execute',
]
const pairing = ref<PairingSession>()
const qrImage = ref('')
const devices = ref<PairedDevice[]>([])
const nodeID = ref('')
const busy = ref(false)
const error = ref('')
const username = ref('')
const password = ref('')
const now = ref(Date.now())
let timer: number | undefined

const secondsRemaining = computed(() => pairing.value
  ? Math.max(0, Math.ceil((pairing.value.expiresAt - now.value) / 1_000))
  : 0)

function stopPolling() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
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
  try {
    const created = await createPairing(
      ALL_SCOPES,
      username.value.trim(),
      password.value,
    )
    password.value = ''
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
  pairing.value = undefined
  qrImage.value = ''
  error.value = ''
  password.value = ''
  if (open) {
    username.value = props.userName
    busy.value = true
    void refreshDevices()
      .catch(cause => { error.value = cause instanceof Error ? cause.message : '读取配对设备失败' })
      .finally(() => { busy.value = false })
  }
})

onBeforeUnmount(stopPolling)
</script>

<template>
  <Teleport to="body">
    <Transition name="pairing-fade">
      <div v-if="open" class="pairing-layer" role="presentation" @mousedown.self="emit('close')">
        <section class="pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
          <header>
            <div><small>HERMES NODE</small><h2 id="pairing-title">手机与节点</h2></div>
            <button class="icon-button" type="button" aria-label="关闭手机与节点" @click="emit('close')"><AppIcon name="close" /></button>
          </header>

          <p class="pairing-intro">扫描一次即可在 iOS 中使用这台 Hermes 的 Bots、聊天历史和团队 Agent。</p>
          <p v-if="insecureTransport" class="pairing-warning"><AppIcon name="alert" :size="15" />当前是局域网 HTTP，二维码免密配对仅适用于可信网络。正式使用请配置 HTTPS/WSS 或 Tailscale。</p>
          <p v-if="error" class="pairing-error">{{ error }}</p>

          <div v-if="!pairing" class="pairing-credentials">
            <label><span>Hermes 用户名</span><input v-model="username" autocomplete="username" /></label>
            <label><span>密码</span><input v-model="password" type="password" autocomplete="current-password" @keydown.enter="beginPairing" /></label>
            <small>密码只用于向 Hermes 创建一份独立的设备会话，不写入二维码，也不会由夭夭 Web 保存。</small>
          </div>

          <section v-if="pairing" class="qr-card">
            <img v-if="qrImage" :src="qrImage" alt="添加此 Hermes 节点的二维码" />
            <strong>用夭夭 iOS 扫描</strong>
            <span v-if="secondsRemaining">二维码将在 {{ secondsRemaining }} 秒后失效</span>
            <span v-else>二维码已失效</span>
            <button v-if="!secondsRemaining" class="quiet-button" type="button" @click="beginPairing">重新生成</button>
          </section>
          <button v-else class="solid-button create-pairing" type="button" :disabled="busy || !username.trim() || !password" @click="beginPairing">
            <AppIcon name="users" :size="17" />{{ busy ? '正在准备…' : '生成手机配对二维码' }}
          </button>

          <section class="device-section">
            <div class="device-heading"><strong>已授权设备</strong><small v-if="nodeID">节点 {{ nodeID.slice(0, 8) }}</small></div>
            <p v-if="!busy && !devices.length" class="device-empty">还没有已授权设备。</p>
            <div v-for="device in devices" :key="device.id" class="device-row">
              <span><b>{{ device.name }}</b><small>{{ device.scopes.includes('history.read') ? 'Bots、历史与团队' : '受限访问' }}</small></span>
              <button type="button" :disabled="busy" @click="revoke(device)">撤销</button>
            </div>
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
.pairing-credentials { display: grid; gap: 10px; margin-bottom: 13px; }.pairing-credentials label { display: grid; gap: 5px; color: var(--text-secondary); font-size: 10px; }.pairing-credentials input { min-height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; outline: 0; background: var(--surface-soft); color: var(--text-primary); }.pairing-credentials input:focus { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--focus-ring); }.pairing-credentials small { color: var(--text-muted); font-size: 9px; line-height: 1.5; }
.qr-card { display: grid; justify-items: center; gap: 7px; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: #fff; color: #191918; }.qr-card img { width: min(296px, 100%); aspect-ratio: 1; }.qr-card strong { font-size: 12px; }.qr-card span { color: #686865; font-size: 10px; }.qr-card .quiet-button { color: #191918; }
.device-section { margin-top: 19px; padding-top: 15px; border-top: 1px solid var(--line); }.device-heading { display: flex; justify-content: space-between; margin-bottom: 8px; }.device-heading strong { font-size: 11px; }.device-heading small, .device-empty { color: var(--text-muted); font-size: 9px; }.device-empty { margin: 12px 1px; }
.device-row { display: flex; align-items: center; gap: 12px; min-height: 47px; padding: 6px 2px; border-bottom: 1px solid var(--line); }.device-row span { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.device-row b { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.device-row small { color: var(--text-muted); font-size: 9px; }.device-row button { border: 0; background: transparent; color: var(--danger); font-size: 10px; cursor: pointer; }
.pairing-fade-enter-active, .pairing-fade-leave-active { transition: opacity 140ms ease; }.pairing-fade-enter-active .pairing-dialog, .pairing-fade-leave-active .pairing-dialog { transition: transform 170ms var(--ease-out); }.pairing-fade-enter-from, .pairing-fade-leave-to { opacity: 0; }.pairing-fade-enter-from .pairing-dialog, .pairing-fade-leave-to .pairing-dialog { transform: translateY(8px) scale(.985); }
@media (max-width: 540px) { .pairing-layer { place-items: end center; padding: 0; }.pairing-dialog { width: 100%; max-height: calc(100vh - 12px); border-radius: 19px 19px 0 0; padding-bottom: max(18px, env(safe-area-inset-bottom)); } }
</style>
