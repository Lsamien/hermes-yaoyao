<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import PreviewInspector from './PreviewInspector.vue'
import type { UiLibraryItem } from './types'

const props = withDefaults(defineProps<{ item: UiLibraryItem; items?: UiLibraryItem[]; canAddToComposer?: boolean }>(), { items: () => [], canAddToComposer: true })
const emit = defineEmits<{ close: []; addToComposer: [item: UiLibraryItem]; source: [item: UiLibraryItem] }>()

const mediaItems = computed(() => {
  const candidates = props.items.filter(item => item.kind === 'image' || item.kind === 'video')
  return candidates.some(item => item.id === props.item.id || item.previewUrl === props.item.previewUrl) ? candidates : [props.item]
})
const activeIndex = ref(0)
const activeItem = computed(() => mediaItems.value[activeIndex.value] ?? props.item)
const canPrevious = computed(() => activeIndex.value > 0)
const canNext = computed(() => activeIndex.value < mediaItems.value.length - 1)
let swipeStart: number | undefined

function resetActiveItem() {
  const index = mediaItems.value.findIndex(item => item.id === props.item.id || item.previewUrl === props.item.previewUrl)
  activeIndex.value = index >= 0 ? index : 0
}
function previous() { if (canPrevious.value) activeIndex.value -= 1 }
function next() { if (canNext.value) activeIndex.value += 1 }
function startSwipe(event: PointerEvent) {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  if ((event.target as HTMLElement).closest('button, a, audio')) return
  swipeStart = event.clientX
}
function finishSwipe(event: PointerEvent) {
  if (swipeStart === undefined) return
  const delta = event.clientX - swipeStart
  swipeStart = undefined
  if (Math.abs(delta) < 48) return
  if (delta < 0) next()
  else previous()
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    previous()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    next()
  }
}

watch([() => props.item.id, mediaItems], resetActiveItem, { immediate: true })
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="preview-modal">
      <div class="preview-modal-layer" @mousedown.self="emit('close')">
        <section class="preview-modal" role="dialog" aria-modal="true" :aria-label="`预览 ${activeItem.title || activeItem.name}`" @pointerdown="startSwipe" @pointerup="finishSwipe" @pointercancel="swipeStart = undefined">
          <PreviewInspector :item="activeItem" show-close :can-add-to-composer="canAddToComposer" @close="emit('close')" @add-to-composer="emit('addToComposer', $event)" @source="emit('source', $event)" />
          <button v-if="canPrevious" class="media-nav media-nav--previous" type="button" aria-label="上一张媒体" title="上一张媒体" @click="previous"><AppIcon name="chevron-left" :size="22" /></button>
          <button v-if="canNext" class="media-nav media-nav--next" type="button" aria-label="下一张媒体" title="下一张媒体" @click="next"><AppIcon class="media-nav__next-icon" name="chevron-left" :size="22" /></button>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.preview-modal-layer { position: fixed; z-index: 90; inset: 0; display: grid; place-items: center; padding: 28px; background: var(--scrim); backdrop-filter: blur(4px); }
.preview-modal { position: relative; display: flex; width: min(960px, calc(100vw - 56px)); height: min(820px, calc(100vh - 56px)); overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: 0 24px 70px rgba(0,0,0,.28); }
.preview-modal :deep(.preview-inspector) { width: 100%; }
.preview-modal :deep(.preview-stage) { min-height: min(58vh, 560px); }
.media-nav { position: absolute; z-index: 3; top: 50%; display: grid; width: 42px; height: 58px; place-items: center; padding: 0; border: 0; border-radius: 10px; background: rgba(20,20,20,.45); color: #fff; cursor: pointer; opacity: .72; transform: translateY(-50%); transition: opacity 120ms ease, background-color 120ms ease; }.media-nav:hover { background: rgba(20,20,20,.72); opacity: 1; }.media-nav--previous { left: 12px; }.media-nav--next { right: 12px; }.media-nav__next-icon { transform: rotate(180deg); }
.preview-modal-enter-active, .preview-modal-leave-active { transition: opacity 160ms ease; }
.preview-modal-enter-active .preview-modal, .preview-modal-leave-active .preview-modal { transition: transform 180ms var(--ease-out), opacity 150ms ease; }
.preview-modal-enter-from, .preview-modal-leave-to { opacity: 0; }
.preview-modal-enter-from .preview-modal, .preview-modal-leave-to .preview-modal { opacity: 0; transform: translateY(8px) scale(.985); }
@media (max-width: 600px) { .preview-modal-layer { padding: 0; }.preview-modal { width: 100vw; max-height: 100vh; min-height: 100vh; border: 0; border-radius: 0; }.preview-modal :deep(.preview-stage) { min-height: 46vh; }.media-nav { width: 38px; height: 52px; }.media-nav--previous { left: 8px; }.media-nav--next { right: 8px; } }
@media (prefers-reduced-motion: reduce) { .preview-modal-enter-active, .preview-modal-leave-active, .preview-modal-enter-active .preview-modal, .preview-modal-leave-active .preview-modal { transition: none; } }
</style>
