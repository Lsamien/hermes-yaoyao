<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'
import type { UiLibraryItem } from './types'

const props = withDefaults(defineProps<{
  item: UiLibraryItem
  showClose?: boolean
}>(), { showClose: false })
const emit = defineEmits<{ close: []; addToComposer: [item: UiLibraryItem]; source: [item: UiLibraryItem] }>()

const canInline = computed(() => !!props.item.previewUrl)
const isTextual = computed(() => ['text', 'code'].includes(props.item.kind))
const sourceUrl = computed(() => props.item.previewUrl || props.item.downloadUrl || '')
const officeRoot = ref<HTMLElement | null>(null)
const pdfRoot = ref<HTMLElement | null>(null)
const spreadsheetRows = ref<unknown[][]>([])
const previewText = ref('')
const previewTextLoaded = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const extension = computed(() => props.item.name.split('.').at(-1)?.toLocaleLowerCase() || '')
const isWord = computed(() => extension.value === 'docx' || /wordprocessingml/.test(props.item.mimeType || ''))
const isSpreadsheet = computed(() => ['xlsx', 'xls'].includes(extension.value) || /spreadsheetml|excel/.test(props.item.mimeType || ''))
const isPdf = computed(() => props.item.kind === 'pdf' || extension.value === 'pdf' || props.item.mimeType === 'application/pdf')
let previewGeneration = 0
let officeResizeObserver: ResizeObserver | undefined

const PDF_WORKER_URL = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

function fitOfficePreview() {
  const root = officeRoot.value
  if (!root) return
  root.style.setProperty('--docx-preview-scale', '1')
  const pages = [...root.querySelectorAll<HTMLElement>('section.docx')]
  const widestPage = Math.max(0, ...pages.map(page => page.getBoundingClientRect().width))
  if (!widestPage) return
  const availableWidth = Math.max(1, root.clientWidth)
  const scale = Math.min(1, Math.max(0.1, availableWidth / widestPage))
  root.style.setProperty('--docx-preview-scale', scale.toFixed(4))
}

function observeOfficePreview() {
  officeResizeObserver?.disconnect()
  if (!officeRoot.value || typeof ResizeObserver === 'undefined') return
  officeResizeObserver = new ResizeObserver(fitOfficePreview)
  officeResizeObserver.observe(officeRoot.value)
}

async function loadRichPreview() {
  const generation = ++previewGeneration
  officeResizeObserver?.disconnect()
  officeResizeObserver = undefined
  officeRoot.value?.style.removeProperty('--docx-preview-scale')
  spreadsheetRows.value = []
  previewText.value = props.item.textContent || ''
  previewTextLoaded.value = props.item.textContent !== undefined
  previewError.value = ''
  if (!sourceUrl.value) return
  if (!isWord.value && !isSpreadsheet.value && !isTextual.value && !isPdf.value) return
  previewLoading.value = true
  try {
    const response = await fetch(sourceUrl.value, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`预览读取失败（${response.status}）`)
    const blob = await response.blob()
    if (generation !== previewGeneration) return
    if (isPdf.value) {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL
      await nextTick()
      if (!pdfRoot.value) return
      pdfRoot.value.replaceChildren()
      const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise
      for (let index = 1; index <= Math.min(pdf.numPages, 24); index += 1) {
        if (generation !== previewGeneration || !pdfRoot.value) return
        const page = await pdf.getPage(index)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(1.45, Math.max(.55, (pdfRoot.value.clientWidth - 24) / base.width))
        const viewport = page.getViewport({ scale })
        const pixelRatio = Math.min(2, window.devicePixelRatio || 1)
        const wrapper = document.createElement('div')
        wrapper.className = 'pdf-page'
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width * pixelRatio)
        canvas.height = Math.floor(viewport.height * pixelRatio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        wrapper.appendChild(canvas)
        pdfRoot.value.appendChild(wrapper)
        const context = canvas.getContext('2d')
        if (context) await page.render({ canvas, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise
      }
    } else if (isWord.value) {
      const { renderAsync } = await import('docx-preview')
      await nextTick()
      if (!officeRoot.value) return
      officeRoot.value.replaceChildren()
      await renderAsync(blob, officeRoot.value, undefined, { inWrapper: true, breakPages: true, ignoreWidth: false, ignoreHeight: false })
      fitOfficePreview()
      observeOfficePreview()
    } else if (isSpreadsheet.value) {
      const { default: readXlsxFile } = await import('read-excel-file/browser')
      spreadsheetRows.value = await readXlsxFile(blob) as unknown[][]
    } else if (isTextual.value) {
      if (!previewTextLoaded.value) previewText.value = await blob.text()
      previewTextLoaded.value = true
    }
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : '无法生成预览'
  } finally {
    previewLoading.value = false
  }
}

watch(() => props.item.id, loadRichPreview, { immediate: true, flush: 'post' })
onBeforeUnmount(() => officeResizeObserver?.disconnect())

</script>

<template>
  <div class="preview-inspector">
    <header>
      <strong :title="item.name">{{ item.title || item.name }}</strong>
      <div class="preview-header-actions">
        <button v-if="item.sourceSessionId" class="icon-button" type="button" aria-label="跳转到来源消息" title="跳转到来源消息" @click="emit('source', item)"><AppIcon name="external" :size="15" /></button>
        <a v-if="item.downloadUrl || item.previewUrl" class="icon-button" :href="item.downloadUrl || item.previewUrl" download aria-label="下载" title="下载"><AppIcon name="download" :size="16" /></a>
        <button class="icon-button" type="button" aria-label="加入输入框" title="加入输入框" @click="emit('addToComposer', item)"><AppIcon name="plus" :size="17" /></button>
        <button v-if="showClose" class="icon-button preview-close" type="button" aria-label="关闭预览" title="关闭预览" @click="emit('close')"><AppIcon name="close" :size="17" /></button>
      </div>
    </header>

    <div class="preview-stage" :class="`preview-stage--${item.kind}`">
      <img v-if="item.kind === 'image' && canInline" :src="item.previewUrl" :alt="item.name" />
      <video v-else-if="item.kind === 'video' && canInline" :src="item.previewUrl" controls playsinline />
      <audio v-else-if="item.kind === 'audio' && canInline" :src="item.previewUrl" controls />
      <div v-else-if="isPdf && canInline" ref="pdfRoot" class="preview-pdf" />
      <div v-else-if="isWord" ref="officeRoot" class="preview-office" />
      <div v-else-if="isSpreadsheet && spreadsheetRows.length" class="preview-sheet"><table><tbody><tr v-for="(row, rowIndex) in spreadsheetRows.slice(0, 200)" :key="rowIndex"><td v-for="(cell, cellIndex) in row.slice(0, 50)" :key="cellIndex">{{ cell }}</td></tr></tbody></table></div>
      <div v-else-if="isTextual && previewTextLoaded" class="preview-text"><pre v-if="item.kind === 'code'">{{ previewText }}</pre><MarkdownContent v-else :content="previewText" /></div>
      <a v-else-if="item.kind === 'link' && (item.previewUrl || item.downloadUrl)" class="preview-link" :href="item.previewUrl || item.downloadUrl" target="_blank" rel="noopener noreferrer"><span><AppIcon name="link" :size="27" /></span><strong>{{ item.title || item.name }}</strong><small>在新窗口中打开</small></a>
      <div v-else class="preview-unavailable"><span><AppIcon :name="previewError ? 'alert' : 'file'" :size="28" /></span><strong>{{ previewLoading ? '正在生成预览…' : previewError || '此格式暂不支持内嵌预览' }}</strong><p>{{ previewError ? '仍可下载文件后使用系统应用查看。' : '可下载文件，使用系统应用查看。' }}</p></div>
    </div>

  </div>
</template>

<style scoped>
.preview-inspector { display: flex; height: 100%; min-height: 0; flex-direction: column; overflow: hidden; }
header { display: flex; min-height: 56px; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); } header > strong { min-width: 0; flex: 1; overflow: hidden; font-size: 12px; font-weight: 630; text-overflow: ellipsis; white-space: nowrap; }.preview-header-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 3px; }.preview-header-actions .icon-button { display: grid; width: 32px; height: 32px; place-items: center; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; text-decoration: none; }.preview-header-actions .icon-button:hover { background: var(--surface-soft); color: var(--text-primary); }
.preview-stage { display: grid; min-height: 0; flex: 1 1 auto; place-items: center; overflow: hidden; background: var(--surface-soft); touch-action: pan-y; }.preview-stage img, .preview-stage video { display: block; width: auto; height: auto; max-width: 100%; max-height: 100%; object-fit: contain; }.preview-stage audio { width: calc(100% - 34px); }.preview-stage object { width: 100%; height: 100%; border: 0; }.preview-text { width: 100%; height: 100%; box-sizing: border-box; padding: 20px 28px 28px; overflow: auto; background: var(--surface-raised); }.preview-text pre { margin: 0; color: var(--text-secondary); font: 10px/1.65 var(--font-code); white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-office { width: 100%; height: 100%; overflow: auto; background: #fff; color: #111; }.preview-office :deep(.docx-wrapper) { width: 100%; min-width: 0; box-sizing: border-box; align-items: flex-start; padding: 0; background: #fff; }.preview-office :deep(.docx) { margin: 0 auto; zoom: var(--docx-preview-scale, 1); box-shadow: none; }.preview-office :deep(.docx > article) { box-sizing: border-box; padding: 36px; }
.preview-pdf { display: flex; width: 100%; height: 100%; box-sizing: border-box; align-items: center; flex-direction: column; gap: 12px; padding: 12px; overflow: auto; background: #dadad7; }.preview-pdf :deep(.pdf-page) { flex: 0 0 auto; overflow: hidden; background: #fff; box-shadow: 0 3px 14px rgba(0,0,0,.15); }.preview-pdf :deep(canvas) { display: block; }
.preview-sheet { width: 100%; height: 100%; overflow: auto; background: var(--surface-raised); }.preview-sheet table { min-width: 100%; border-collapse: collapse; font-size: 9px; }.preview-sheet td { min-width: 72px; max-width: 240px; padding: 6px 8px; overflow: hidden; border: 1px solid var(--line); color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }.preview-sheet tr:first-child td { position: sticky; top: 0; background: var(--surface-soft); color: var(--text-primary); font-weight: 600; }
.preview-link { display: flex; width: calc(100% - 34px); flex-direction: column; align-items: center; color: var(--text-secondary); text-decoration: none; text-align: center; }.preview-link > span, .preview-unavailable > span { display: grid; place-items: center; width: 52px; height: 52px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); }.preview-link strong { max-width: 100%; overflow: hidden; color: var(--text-primary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.preview-link small { margin-top: 5px; color: var(--text-muted); font-size: 9px; }
.preview-unavailable { display: flex; padding: 30px; flex-direction: column; align-items: center; color: var(--text-secondary); text-align: center; }.preview-unavailable strong { font-size: 11px; }.preview-unavailable p { margin: 5px 0 0; color: var(--text-muted); font-size: 9px; }
@media (max-width: 900px) { header { padding-right: 12px; } }
@media (max-width: 600px) { .preview-text { padding: 18px 20px 24px; } }
</style>
