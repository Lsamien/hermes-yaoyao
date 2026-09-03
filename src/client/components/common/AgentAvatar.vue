<script setup lang="ts">
// Motion language adapted from OpenMausBot CursorAvatar (Apache-2.0).
// The circle, rounded square and compact triangle silhouettes are Yaoyao-owned.
import { computed, getCurrentInstance } from 'vue'
import {
  decodeAgentMascotAvatar,
  defaultAgentIdentity,
  encodeAgentAvatar,
  isAgentImageAvatar,
} from '@shared/agentIdentity'

type MascotState = 'idle' | 'working' | 'notifying' | 'waiting' | 'success' | 'failure'

const props = withDefaults(defineProps<{
  name: string
  avatar?: string
  size?: number
  state?: MascotState
}>(), { avatar: '', size: 32, state: 'idle' })

const resolvedAvatar = computed(() => props.avatar || encodeAgentAvatar(defaultAgentIdentity(props.name)))
const hasImage = computed(() => isAgentImageAvatar(resolvedAvatar.value))
const mascot = computed(() => decodeAgentMascotAvatar(resolvedAvatar.value)
  ?? defaultAgentIdentity(props.name))
const gradientId = `yaoyao-agent-${getCurrentInstance()?.uid ?? 0}`

function mix(hex: string, toward: string, amount: number): string {
  const source = Number.parseInt(hex.slice(1), 16)
  const target = Number.parseInt(toward.slice(1), 16)
  const channel = (shift: number) => Math.round(
    ((source >> shift) & 0xff) + (((target >> shift) & 0xff) - ((source >> shift) & 0xff)) * amount,
  )
  return `#${[channel(16), channel(8), channel(0)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

const highlight = computed(() => mix(mascot.value.color, '#ffffff', 0.54))
const shadow = computed(() => mix(mascot.value.color, '#000000', 0.4))
const faceTransform = computed(() => {
  const shape = mascot.value.shape
  if (shape === 'ellipse') return 'translate(0 10) translate(50 50) scale(1 .8) translate(-50 -50)'
  if (shape === 'capsule') return 'translate(0 6) translate(50 50) scale(1 .7) translate(-50 -50)'
  if (shape === 'triangle') return 'translate(0 9) translate(50 50) scale(.85 .85) translate(-50 -50)'
  if (shape === 'droplet') return 'translate(0 8)'
  return ''
})
const mouthPath = computed(() => {
  switch (mascot.value.expression) {
    case 'focused': return 'M42 61 Q50 58 58 61'
    case 'curious': return 'M46 61 Q50 64 54 61'
    case 'calm': return 'M43 60 Q50 61 57 60'
    default: return 'M41 59 Q50 68 59 59'
  }
})
</script>

<template>
  <span
    class="agent-avatar"
    :class="[`agent-avatar--${state}`, { 'agent-avatar--image': hasImage }]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="`${name} 的头像`"
  >
    <img v-if="hasImage" :src="resolvedAvatar" alt="" />
    <svg v-else viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient :id="gradientId" x1="18" y1="12" x2="82" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0" :stop-color="highlight" />
          <stop offset="0.5" :stop-color="mascot.color" />
          <stop offset="1" :stop-color="shadow" />
        </linearGradient>
      </defs>
      <g class="agent-avatar__body">
        <circle v-if="mascot.shape === 'circle'" cx="50" cy="50" r="44" :fill="`url(#${gradientId})`" />
        <rect v-else-if="mascot.shape === 'square'" x="9" y="9" width="82" height="82" rx="18" :fill="`url(#${gradientId})`" />
        <ellipse v-else-if="mascot.shape === 'ellipse'" cx="50" cy="50" rx="45" ry="33" :fill="`url(#${gradientId})`" />
        <rect v-else-if="mascot.shape === 'capsule'" x="4" y="24" width="92" height="52" rx="26" :fill="`url(#${gradientId})`" />
        <path v-else-if="mascot.shape === 'triangle'" d="M50 9 Q45 8 40 17 L10 76 Q4 88 19 88 L81 88 Q96 88 90 76 L60 17 Q55 8 50 9Z" :fill="`url(#${gradientId})`" />
        <path v-else-if="mascot.shape === 'hexagon'" d="M46 6 Q50 4 54 6 L88 25 Q92 27 92 32 L92 68 Q92 73 88 75 L54 94 Q50 96 46 94 L12 75 Q8 73 8 68 L8 32 Q8 27 12 25Z" :fill="`url(#${gradientId})`" />
        <path v-else-if="mascot.shape === 'cloud'" d="M25 22 C21 8 40 2 48 14 C56 1 78 9 76 23 C93 21 99 40 85 50 C101 65 89 85 73 80 C71 98 47 102 42 85 C27 99 9 84 16 69 C0 62 1 42 19 37 C13 31 16 24 25 22Z" :fill="`url(#${gradientId})`" />
        <path v-else d="M50 5 C42 17 12 39 12 59 C12 80 29 95 50 95 C71 95 88 80 88 59 C88 39 58 17 50 5Z" :fill="`url(#${gradientId})`" />
        <g class="agent-avatar__face" :transform="faceTransform">
          <ellipse class="agent-avatar__eye agent-avatar__eye--left" cx="39" cy="43" rx="5.3" ry="8.2" fill="white" />
          <ellipse class="agent-avatar__eye agent-avatar__eye--right" cx="61" cy="43" rx="5.3" ry="8.2" fill="white" />
          <path class="agent-avatar__mouth" :d="mouthPath" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" />
        </g>
      </g>
    </svg>
  </span>
</template>

<style scoped>
.agent-avatar{display:block;position:relative;flex:0 0 auto;overflow:visible;line-height:1;background:transparent}.agent-avatar img,.agent-avatar svg{display:block;width:100%;height:100%;object-fit:cover}.agent-avatar--image img{border-radius:22%}.agent-avatar__body{transform-box:fill-box;transform-origin:center}.agent-avatar__eye{transform-box:fill-box;transform-origin:center;animation:agent-avatar-blink 9s ease-in-out infinite}.agent-avatar__eye--right{animation-delay:32ms}.agent-avatar--working .agent-avatar__body,.agent-avatar--working img{animation:agent-avatar-working .9s ease-in-out infinite}.agent-avatar--working .agent-avatar__eye{animation-duration:4.1s}.agent-avatar--notifying .agent-avatar__body,.agent-avatar--notifying img{animation:agent-avatar-notifying .7s cubic-bezier(.2,.8,.2,1) 2}.agent-avatar--notifying::after{position:absolute;inset:-3px;border:2px solid v-bind('mascot.color');border-radius:50%;content:"";animation:agent-avatar-ring 1.2s ease-out 2;pointer-events:none}.agent-avatar--waiting .agent-avatar__body,.agent-avatar--waiting img{animation:agent-avatar-waiting 1.8s ease-in-out infinite}.agent-avatar--waiting .agent-avatar__eye{animation-duration:3.4s}.agent-avatar--success .agent-avatar__body,.agent-avatar--success img{animation:agent-avatar-success .9s cubic-bezier(.18,.8,.2,1) both}.agent-avatar--failure .agent-avatar__body,.agent-avatar--failure img{animation:agent-avatar-failure .7s ease-in-out both}
@keyframes agent-avatar-blink{0%,42%,47%,100%{transform:scaleY(1)}44.5%{transform:scaleY(.08)}}
@keyframes agent-avatar-working{0%,100%{transform:translateY(1px) rotate(-1deg) scale(.99)}50%{transform:translateY(-2px) rotate(1.5deg) scale(1.02)}}
@keyframes agent-avatar-notifying{0%,100%{transform:translateY(0) rotate(0) scale(1)}25%{transform:translateY(2px) rotate(-3deg) scale(1.08,.92)}55%{transform:translateY(-4px) rotate(3deg) scale(.95,1.08)}78%{transform:translateY(0) rotate(-1deg) scale(1.03,.98)}}
@keyframes agent-avatar-ring{0%{opacity:.7;transform:scale(.8)}100%{opacity:0;transform:scale(1.28)}}
@keyframes agent-avatar-waiting{0%,100%{transform:rotate(-2deg) scale(1)}50%{transform:rotate(2deg) scale(1.04)}}
@keyframes agent-avatar-success{0%,100%{transform:translateY(0) scale(1)}25%{transform:translateY(3px) scale(1.12,.86)}55%{transform:translateY(-6px) scale(.92,1.12)}80%{transform:translateY(0) scale(1.03,.98)}}
@keyframes agent-avatar-failure{0%,100%{transform:translateX(0) rotate(0)}25%{transform:translateX(-3px) rotate(-4deg)}50%{transform:translateX(3px) rotate(4deg)}75%{transform:translateX(-2px) rotate(-2deg)}}
@media(prefers-reduced-motion:reduce){.agent-avatar *,.agent-avatar::after{animation:none!important;transition:none!important}}
</style>
