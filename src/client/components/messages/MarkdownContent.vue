<script setup lang="ts">
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { computed, onMounted, onUpdated, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

const props = withDefaults(defineProps<{
  content: string
  streaming?: boolean
}>(), { streaming: false })

const root = ref<HTMLElement | null>(null)
const copied = ref('')

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
})

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, index, options, env, self)
}

const rendered = computed(() => DOMPurify.sanitize(md.render(props.content || ''), {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'svg', 'math', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
  ALLOW_UNKNOWN_PROTOCOLS: false,
}))

function decorateCodeBlocks() {
  if (!root.value) return
  root.value.querySelectorAll('pre').forEach((pre, index) => {
    if (pre.querySelector(':scope > .code-copy')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    button.textContent = '复制'
    button.setAttribute('aria-label', '复制代码')
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? ''
      await navigator.clipboard.writeText(code)
      const key = `${index}:${code.length}`
      copied.value = key
      button.textContent = '已复制'
      window.setTimeout(() => { if (copied.value === key) { copied.value = ''; button.textContent = '复制' } }, 1400)
    })
    pre.appendChild(button)
  })
}

function onClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a')
  if (!link) return
  const href = link.getAttribute('href') || ''
  if (/^(javascript|data|vbscript):/i.test(href)) event.preventDefault()
}

onMounted(decorateCodeBlocks)
onUpdated(decorateCodeBlocks)
</script>

<template>
  <div ref="root" class="markdown" :class="{ 'markdown--streaming': streaming }" @click="onClick" v-html="rendered" />
  <AppIcon v-if="streaming" class="stream-caret" name="arrow-up" :size="0" />
</template>

<style scoped>
.markdown { min-width: 0; color: inherit; font-size: 13px; line-height: 1.68; overflow-wrap: anywhere; }
.markdown :deep(p) { margin: 0 0 .72em; }.markdown :deep(p:last-child) { margin-bottom: 0; }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3), .markdown :deep(h4) { margin: 1.2em 0 .5em; color: var(--text-primary); line-height: 1.3; letter-spacing: -.02em; }
.markdown :deep(h1) { font-size: 1.45em; }.markdown :deep(h2) { font-size: 1.28em; }.markdown :deep(h3) { font-size: 1.13em; }
.markdown :deep(ul), .markdown :deep(ol) { margin: .6em 0; padding-left: 1.55em; }.markdown :deep(li) { margin: .22em 0; }
.markdown :deep(blockquote) { margin: .8em 0; padding: .1em 0 .1em 1em; border-left: 2px solid var(--line-strong); color: var(--text-secondary); }
.markdown :deep(a) { color: var(--text-primary); text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }.markdown :deep(a:hover) { text-decoration-color: currentColor; }
.markdown :deep(code) { padding: .15em .35em; border-radius: 5px; background: var(--surface-soft); color: var(--text-primary); font-family: var(--font-code); font-size: .9em; }
.markdown :deep(pre) { position: relative; margin: .85em 0; padding: 13px 14px; overflow: auto; border: 1px solid var(--line); border-radius: 11px; background: color-mix(in srgb, var(--surface-soft) 78%, var(--surface)); }
.markdown :deep(pre code) { padding: 0; background: transparent; font-size: 11px; line-height: 1.6; white-space: pre; }
.markdown :deep(.code-copy) { position: sticky; float: right; top: 0; margin: -7px -8px 4px 8px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-raised); color: var(--text-muted); cursor: pointer; font: 9px var(--font-ui); }
.markdown :deep(table) { display: block; max-width: 100%; margin: .9em 0; overflow-x: auto; border-collapse: collapse; }.markdown :deep(th), .markdown :deep(td) { padding: 6px 9px; border: 1px solid var(--line); text-align: left; }.markdown :deep(th) { background: var(--surface-soft); font-weight: 600; }
.markdown :deep(hr) { margin: 1.3em 0; border: 0; border-top: 1px solid var(--line); }
.markdown :deep(img) { display: block; width: auto; max-width: min(100%, 560px); max-height: 360px; margin: .7em 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); object-fit: contain; }
.markdown--streaming :deep(p:last-child)::after { content: ''; display: inline-block; width: 5px; height: 14px; margin-left: 3px; border-radius: 1px; background: currentColor; vertical-align: -2px; animation: caret 1s step-end infinite; }
.stream-caret { display: none; }
@keyframes caret { 50% { opacity: 0; } }
@media (max-width: 600px) { .markdown :deep(img) { max-height: 280px; } }
</style>
