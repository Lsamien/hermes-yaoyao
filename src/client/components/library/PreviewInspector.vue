<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'
import type { UiLibraryItem } from './types'

const props = defineProps<{ item: UiLibraryItem }>()
const emit = defineEmits<{ close: []; addToComposer: [item: UiLibraryItem]; source: [item: UiLibraryItem] }>()

const canInline = computed(() => !!props.item.previewUrl)
const isTextual = computed(() => ['text', 'code'].includes(props.item.kind))
const sourceUrl = computed(() => props.item.previewUrl || props.item.downloadUrl || '')
const officeRoot = ref<HTMLElement | null>(null)
const pdfRoot = ref<HTMLElement | null>(null)
const spreadsheetRows = ref<unknown[][]>([])
const previewText = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const extension = computed(() => props.item.name.split('.').at(-1)?.toLocaleLowerCase() || '')
const isWord = computed(() => extension.value === 'docx' || /wordprocessingml/.test(props.item.mimeType || ''))
const isSpreadsheet = computed(() => ['xlsx', 'xls'].includes(extension.value) || /spreadsheetml|excel/.test(props.item.mimeType || ''))
const isPdf = computed(() => props.item.kind === 'pdf' || extension.value === 'pdf' || props.item.mimeType === 'application/pdf')
let previewGeneration = 0

const PDF_WORKER_URL = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

async function loadRichPreview() {
  const generation = ++previewGeneration
  spreadsheetRows.value = []
  previewText.value = props.item.textContent || ''
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
    } else if (isSpreadsheet.value) {
      const { default: readXlsxFile } = await import('read-excel-file/browser')
      spreadsheetRows.value = await readXlsxFile(blob) as unknown[][]
    } else if (isTextual.value && !previewText.value) {
      previewText.value = await blob.text()
    }
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : '无法生成预览'
  } finally {
    previewLoading.value = false
  }
}

watch(() => props.item.id, loadRichPreview, { immediate: true, flush: 'post' })

function formatSize(size?: number) {
  if (size === undefined) return '未知大小'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="preview-inspector">
    <header>
      <button class="icon-button preview-back" type="button" aria-label="关闭预览" @click="emit('close')"><AppIcon name="chevron-left" /></button>
      <div><small>预览</small><strong :title="item.name">{{ item.title || item.name }}</strong></div>
    </header>

    <div class="preview-stage" :class="`preview-stage--${item.kind}`">
      <img v-if="item.kind === 'image' && canInline" :src="item.previewUrl" :alt="item.name" />
      <video v-else-if="item.kind === 'video' && canInline" :src="item.previewUrl" controls playsinline />
      <audio v-else-if="item.kind === 'audio' && canInline" :src="item.previewUrl" controls />
      <div v-else-if="isPdf && canInline" ref="pdfRoot" class="preview-pdf" />
      <div v-else-if="isWord" ref="officeRoot" class="preview-office" />
      <div v-else-if="isSpreadsheet && spreadsheetRows.length" class="preview-sheet"><table><tbody><tr v-for="(row, rowIndex) in spreadsheetRows.slice(0, 200)" :key="rowIndex"><td v-for="(cell, cellIndex) in row.slice(0, 50)" :key="cellIndex">{{ cell }}</td></tr></tbody></table></div>
      <div v-else-if="isTextual && previewText" class="preview-text"><pre v-if="item.kind === 'code'">{{ previewText }}</pre><MarkdownContent v-else :content="previewText" /></div>
      <a v-else-if="item.kind === 'link' && (item.previewUrl || item.downloadUrl)" class="preview-link" :href="item.previewUrl || item.downloadUrl" target="_blank" rel="noopener noreferrer"><span><AppIcon name="link" :size="27" /></span><strong>{{ item.title || item.name }}</strong><small>在新窗口中打开</small></a>
      <div v-else class="preview-unavailable"><span><AppIcon :name="previewError ? 'alert' : 'file'" :size="28" /></span><strong>{{ previewLoading ? '正在生成预览…' : previewError || '此格式暂不支持内嵌预览' }}</strong><p>{{ previewError ? '仍可下载文件后使用系统应用查看。' : '可下载文件，使用系统应用查看。' }}</p></div>
    </div>

    <section class="preview-meta">
      <dl><div><dt>文件名</dt><dd>{{ item.name }}</dd></div><div><dt>类型</dt><dd>{{ item.mimeType || item.kind }}</dd></div><div><dt>大小</dt><dd>{{ formatSize(item.size) }}</dd></div><div v-if="item.sourceLabel"><dt>来源</dt><dd>{{ item.sourceLabel }}</dd></div></dl>
      <div class="preview-actions">
        <a v-if="item.downloadUrl || item.previewUrl" class="quiet-button" :href="item.downloadUrl || item.previewUrl" download><AppIcon name="download" :size="14" />下载</a>
        <button class="solid-button" type="button" @click="emit('addToComposer', item)"><AppIcon name="plus" :size="14" />加入输入框</button>
      </div>
      <button v-if="item.sourceSessionId" class="source-link" type="button" @click="emit('source', item)"><AppIcon name="external" :size="13" />跳转到来源消息</button>
    </section>
  </div>
</template>

<style scoped>
.preview-inspector { display: flex; height: 100%; flex-direction: column; overflow-y: auto; }
header { display: flex; min-height: 62px; align-items: center; gap: 7px; padding: 9px 42px 9px 11px; border-bottom: 1px solid var(--line); } header > div { display: flex; min-width: 0; flex: 1; flex-direction: column; }.preview-back { display: none; } header small { color: var(--text-muted); font-size: 9px; } header strong { margin-top: 2px; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.preview-stage { display: grid; min-height: 280px; flex: 1 0 auto; place-items: center; overflow: hidden; background: var(--surface-soft); }.preview-stage img, .preview-stage video { display: block; width: 100%; height: auto; max-height: 58vh; object-fit: contain; }.preview-stage audio { width: calc(100% - 34px); }.preview-stage object { width: 100%; height: min(62vh, 660px); border: 0; }.preview-text { width: 100%; height: min(62vh, 660px); padding: 16px; overflow: auto; background: var(--surface-raised); }.preview-text pre { margin: 0; color: var(--text-secondary); font: 10px/1.65 var(--font-code); white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-office { width: 100%; height: min(62vh, 660px); overflow: auto; background: #e6e6e4; color: #111; }.preview-office :deep(.docx-wrapper) { padding: 18px 0; background: #e6e6e4; }.preview-office :deep(.docx) { margin-bottom: 14px; box-shadow: 0 4px 18px rgba(0,0,0,.12); }
.preview-pdf { display: flex; width: 100%; height: min(62vh, 660px); align-items: center; flex-direction: column; gap: 12px; padding: 12px; overflow: auto; background: #dadad7; }.preview-pdf :deep(.pdf-page) { flex: 0 0 auto; overflow: hidden; background: #fff; box-shadow: 0 3px 14px rgba(0,0,0,.15); }.preview-pdf :deep(canvas) { display: block; }
.preview-sheet { width: 100%; height: min(62vh, 660px); overflow: auto; background: var(--surface-raised); }.preview-sheet table { min-width: 100%; border-collapse: collapse; font-size: 9px; }.preview-sheet td { min-width: 72px; max-width: 240px; padding: 6px 8px; overflow: hidden; border: 1px solid var(--line); color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }.preview-sheet tr:first-child td { position: sticky; top: 0; background: var(--surface-soft); color: var(--text-primary); font-weight: 600; }
.preview-link { display: flex; width: calc(100% - 34px); flex-direction: column; align-items: center; color: var(--text-secondary); text-decoration: none; text-align: center; }.preview-link > span, .preview-unavailable > span { display: grid; place-items: center; width: 52px; height: 52px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-raised); }.preview-link strong { max-width: 100%; overflow: hidden; color: var(--text-primary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.preview-link small { margin-top: 5px; color: var(--text-muted); font-size: 9px; }
.preview-unavailable { display: flex; padding: 30px; flex-direction: column; align-items: center; color: var(--text-secondary); text-align: center; }.preview-unavailable strong { font-size: 11px; }.preview-unavailable p { margin: 5px 0 0; color: var(--text-muted); font-size: 9px; }
.preview-meta { padding: 15px; border-top: 1px solid var(--line); } dl { display: flex; margin: 0; flex-direction: column; gap: 7px; } dl div { display: grid; grid-template-columns: 55px minmax(0, 1fr); gap: 8px; font-size: 9px; } dt { color: var(--text-muted); } dd { margin: 0; overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.preview-actions { display: flex; gap: 7px; margin-top: 15px; }.preview-actions > * { display: flex; flex: 1; gap: 6px; font-size: 10px; text-decoration: none; }.source-link { display: flex; align-items: center; gap: 5px; margin: 11px auto 0; padding: 4px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 9px; }.source-link:hover { color: var(--text-primary); }
@media (max-width: 900px) { .preview-back { display: grid; } header { padding-right: 12px; } }
</style>
