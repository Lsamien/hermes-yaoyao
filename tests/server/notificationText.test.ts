import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { notificationPlainText } from '../../src/server/notificationText.js'
import { PushCoordinator, type PushSender } from '../../src/server/pushCoordinator.js'
import type { APNsRequest, APNsSendResult } from '../../src/server/apns.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function text(value: string, maximum = 180): string {
  return notificationPlainText(value, { fallback: '新消息', maximum })
}

class RecordingSender implements PushSender {
  requests: APNsRequest[] = []
  async send(request: APNsRequest): Promise<APNsSendResult> {
    this.requests.push(request)
    return { disposition: 'success', status: 200 }
  }
}

describe('notification plain text', () => {
  it('keeps emoji and decorative bullets while removing Markdown syntax and link targets', () => {
    const result = text(`
## 部署完成 ✅

- 已发布 **v0.2.15**
- [查看报告](https://example.com/report?token=secret)
- ![运行截图](https://example.com/screenshot.png)
`)

    expect(result).toContain('部署完成 ✅')
    expect(result).toContain('• 已发布 v0.2.15')
    expect(result).toContain('查看报告')
    expect(result).toContain('🖼️ 运行截图')
    expect(result).not.toMatch(/[#*_`~]|https?:\/\//u)
  })

  it('summarizes code, paths, attachments, raw URLs, stacks, HTML, and unsafe controls', () => {
    const result = text(`
<b>构建失败 ⚠️</b>

\`inline --flag\`

\`\`\`bash
npm run build
\`\`\`

@file:/Users/samien/project/report.pdf
详情 https://example.com/private
Error: missing /Users/samien/project/config.json
    at run (/Users/samien/project/app.js:12:3)
\u001b[31m红色\u001b[0m\u202E
`)

    expect(result).toContain('构建失败 ⚠️')
    expect(result).toContain('inline --flag')
    expect(result).toContain('💻 代码片段')
    expect(result).toContain('📎 report.pdf')
    expect(result).toContain('📎 config.json')
    expect(result).toContain('🔗 链接')
    expect(result).toContain('红色')
    expect(result).not.toContain('/Users/')
    expect(result).not.toContain('at run')
    expect(result).not.toContain('\u001b')
    expect(result).not.toContain('\u202E')
  })

  it('is idempotent and truncates only at complete grapheme boundaries', () => {
    const source = '✅ 👨‍👩‍👧‍👦 完成 • 报告'
    const once = text(source, 8)
    const twice = text(once, 8)
    expect(twice).toBe(once)
    expect(once).not.toContain('�')
    expect([...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(once)].length).toBeLessThanOrEqual(8)
  })

  it('sanitizes notification text before persisting and delivering new outbox rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-notification-text-'))
    roots.push(home)
    const sender = new RecordingSender()
    const config = {
      keyFile: '/unused.p8', keyId: 'KEY1234567', teamId: 'TEAM123456',
      topic: 'cn.samien.yaoyao.hermes', environments: ['development' as const],
    }
    const coordinator = new PushCoordinator({ home, apns: config, provider: sender, autoFlush: false })
    coordinator.registerInstallation({
      userId: 'user-a', installationId: 'phone-a', clientAccountId: 'account-a',
      deviceToken: 'ab'.repeat(32), environment: 'development',
    })
    expect(coordinator.enqueue({
      eventId: 'event-a', userId: 'user-a', kind: 'chat.completed',
      title: '## 完成 ✅', body: '**报告** [下载](https://example.com/secret)',
    })).toBe(1)
    const statePath = join(home, 'push', 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { outbox: Array<{ title: string; body: string }> }
    expect(state.outbox[0]).toMatchObject({ title: '完成 ✅', body: '报告 下载' })

    await coordinator.flushDue()
    const alert = (sender.requests[0]!.payload.aps as { alert: { title: string; body: string } }).alert
    expect(alert).toEqual({ title: '完成 ✅', body: '报告 下载' })
    coordinator.close()
  })
})
