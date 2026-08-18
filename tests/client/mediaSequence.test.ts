import { describe, expect, it } from 'vitest'
import { mediaItemsFromMessages, previewItemFromUrl } from '@/components/library/mediaSequence'
import type { UiMessage } from '@/components/messages/types'

describe('conversation media sequence', () => {
  it('keeps visible image and video order while deduplicating the same URL', () => {
    const messages: UiMessage[] = [
      { id: 'one', role: 'assistant', content: '![第一张](/media/first.png)' },
      { id: 'two', role: 'assistant', content: '[视频](/media/second.mp4)', attachments: [{ id: 'a', name: '第一张.png', kind: 'image', url: '/media/first.png' }] },
      { id: 'three', role: 'assistant', content: '普通文本', attachments: [{ id: 'b', name: '第三张.webp', kind: 'image', url: '/media/third.webp' }] },
    ]
    expect(mediaItemsFromMessages(messages).map(item => [item.name, item.kind, item.previewUrl])).toEqual([
      ['first.png', 'image', '/media/first.png'],
      ['second.mp4', 'video', '/media/second.mp4'],
      ['第三张.webp', 'image', '/media/third.webp'],
    ])
  })

  it('infers full-view media kind from a clicked conversation link', () => {
    expect(previewItemFromUrl('片段.webm', '/media/clip.webm')).toMatchObject({ kind: 'video', previewUrl: '/media/clip.webm' })
  })
})
