<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AddOutline, ChevronBackOutline, ChevronForwardOutline, CloseOutline, DownloadOutline } from '@vicons/ionicons5'

export type PreviewMedia = { url: string; name: string; type?: 'image' | 'video' }

const props = withDefaults(defineProps<{
  images: PreviewMedia[]
  modelValue: number | null
  closeLabel?: string
  addLabel?: string
  canAdd?: boolean
  previousLabel?: string
  nextLabel?: string
}>(), { canAdd: true })
const emit = defineEmits<{ 'update:modelValue': [value: number | null]; close: []; add: [media: PreviewMedia] }>()

const dragStart = ref<{ pointerId: number; x: number } | null>(null)
const previewMedia = computed(() => props.modelValue === null ? null : props.images[props.modelValue] || null)
const canPrevious = computed(() => (props.modelValue ?? 0) > 0)
const canNext = computed(() => props.modelValue !== null && props.modelValue < props.images.length - 1)

function close() { dragStart.value = null; emit('update:modelValue', null); emit('close') }
function move(direction: -1 | 1) {
  if (props.modelValue === null) return
  const next = props.modelValue + direction
  if (next >= 0 && next < props.images.length) emit('update:modelValue', next)
}
function onKeydown(event: KeyboardEvent) {
  if (props.modelValue === null) return
  if (event.key === 'Escape') { event.preventDefault(); close() }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
  else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
}
function onPointerDown(event: PointerEvent) {
  if (!event.isPrimary) return
  dragStart.value = { pointerId: event.pointerId, x: event.clientX }
}
function onPointerUp(event: PointerEvent) {
  const start = dragStart.value
  dragStart.value = null
  if (!start || start.pointerId !== event.pointerId || Math.abs(event.clientX - start.x) < 48) return
  move(event.clientX < start.x ? 1 : -1)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="previewMedia"
      class="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="`预览 ${previewMedia.name}`"
      @click.self="close"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="dragStart = null"
    >
      <div class="image-preview-actions">
        <a :href="previewMedia.url" download :aria-label="`下载 ${previewMedia.name}`" :title="`下载 ${previewMedia.name}`"><DownloadOutline aria-hidden="true" /></a>
        <button v-if="canAdd" type="button" :aria-label="addLabel || '添加到聊天'" :title="addLabel || '添加到聊天'" @click.stop="emit('add', previewMedia)"><AddOutline aria-hidden="true" /></button>
        <button type="button" :aria-label="closeLabel || '关闭预览'" :title="closeLabel || '关闭预览'" @click="close"><CloseOutline aria-hidden="true" /></button>
      </div>
      <button v-if="canPrevious" class="image-preview-nav image-preview-nav--previous" type="button" :aria-label="previousLabel || '上一张媒体'" @click.stop="move(-1)"><ChevronBackOutline aria-hidden="true" /></button>
      <Transition name="image-preview-change" mode="out-in">
        <video v-if="previewMedia.type === 'video'" :key="previewMedia.url" :src="previewMedia.url" :aria-label="previewMedia.name" class="image-preview-video" controls playsinline preload="metadata" @click.stop @pointerdown.stop @pointerup.stop />
        <img v-else :key="previewMedia.url" :src="previewMedia.url" :alt="previewMedia.name" class="image-preview-img" draggable="false" @click.stop />
      </Transition>
      <button v-if="canNext" class="image-preview-nav image-preview-nav--next" type="button" :aria-label="nextLabel || '下一张媒体'" @click.stop="move(1)"><ChevronForwardOutline aria-hidden="true" /></button>
      <span v-if="images.length > 1" class="image-preview-counter">{{ (modelValue || 0) + 1 }} / {{ images.length }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.image-preview-overlay { position: fixed; z-index: 9999; inset: 0; display: flex; align-items: center; justify-content: center; isolation: isolate; background: rgba(0,0,0,.85); touch-action: none; user-select: none; }
.image-preview-img, .image-preview-video { position: relative; z-index: 1; max-width: 90vw; max-height: 84vh; border-radius: 8px; object-fit: contain; box-shadow: 0 22px 64px rgba(0,0,0,.42); }
.image-preview-video { width: min(90vw, 1200px); background: #000; }
.image-preview-actions { position: absolute; z-index: 3; top: 20px; right: 20px; display: flex; align-items: center; gap: 8px; }
.image-preview-actions > a, .image-preview-actions > button, .image-preview-nav { display: inline-flex; align-items: center; justify-content: center; border: 0; background: rgba(255,255,255,.12); color: #fff; cursor: pointer; backdrop-filter: blur(12px); transition: background .15s ease, transform .15s ease, opacity .15s ease; }
.image-preview-actions > a, .image-preview-actions > button { width: 40px; height: 40px; padding: 0; border-radius: 50%; text-decoration: none; }
.image-preview-actions svg { width: 20px; height: 20px; }
.image-preview-actions > a:hover, .image-preview-actions > a:focus-visible, .image-preview-actions > button:hover, .image-preview-actions > button:focus-visible, .image-preview-nav:hover, .image-preview-nav:focus-visible { outline: none; background: rgba(255,255,255,.22); }
.image-preview-actions > button:disabled { cursor: not-allowed; opacity: .38; }
.image-preview-nav { top: 50%; width: 46px; height: 58px; border-radius: 14px; transform: translateY(-50%); }.image-preview-nav svg { width: 24px; height: 24px; }.image-preview-nav:hover, .image-preview-nav:focus-visible { transform: translateY(-50%) scale(1.04); }.image-preview-nav--previous { left: 24px; }.image-preview-nav--next { right: 24px; }
.image-preview-counter { position: absolute; z-index: 2; bottom: 22px; left: 50%; padding: 6px 10px; border-radius: 999px; background: rgba(0,0,0,.46); color: rgba(255,255,255,.9); font-size: 12px; font-variant-numeric: tabular-nums; transform: translateX(-50%); }
.image-preview-change-enter-active, .image-preview-change-leave-active { transition: opacity .16s ease, transform .16s ease; }.image-preview-change-enter-from { opacity: 0; transform: translateX(14px); }.image-preview-change-leave-to { opacity: 0; transform: translateX(-14px); }
@media (max-width: 600px) { .image-preview-img, .image-preview-video { max-width: calc(100vw - 32px); max-height: 78vh; }.image-preview-video { width: calc(100vw - 32px); }.image-preview-actions { top: max(14px, env(safe-area-inset-top)); right: 14px; gap: 6px; }.image-preview-actions > a, .image-preview-actions > button { width: 40px; height: 40px; }.image-preview-nav { width: 38px; height: 50px; border-radius: 12px; }.image-preview-nav--previous { left: 10px; }.image-preview-nav--next { right: 10px; } }
</style>
