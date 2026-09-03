import { describe, expect, it } from 'vitest'
import { rewriteRemoteNodeFiles } from '@/components/workspace/viewModels'

describe('remote node file links', () => {
  it('routes remote images and files through the source node', () => {
    const node = '11111111-1111-4111-8111-111111111111'
    const content = [
      '![图](</Users/remote/Agents/result one.png>)',
      '[报告](/Users/remote/Agents/report.pdf)',
      '[日志](file:///Users/remote/Agents/run.log)',
    ].join('\n')
    const rewritten = rewriteRemoteNodeFiles(content, node)
    expect(rewritten).toContain(`/api/app/groups/nodes/${node}/files?path=%2FUsers%2Fremote%2FAgents%2Fresult%20one.png`)
    expect(rewritten).toContain('path=%2FUsers%2Fremote%2FAgents%2Freport.pdf')
    expect(rewritten).toContain('path=%2FUsers%2Fremote%2FAgents%2Frun.log')
    expect(rewritten).not.toContain('](</Users/remote')
  })

  it('normalizes real Hermes MEDIA directives before routing them', () => {
    const node = '11111111-1111-4111-8111-111111111111'
    const content = [
      'MEDIA:/Users/samien/Agents/smoke_zimage_turbo_00001_.png',
      'MEDIA:`/Users/samien/Agents/远程 报告.pdf`',
    ].join('\n')

    const rewritten = rewriteRemoteNodeFiles(content, node)

    expect(rewritten).toContain(`![smoke_zimage_turbo_00001_.png](/api/app/groups/nodes/${node}/files?path=%2FUsers%2Fsamien%2FAgents%2Fsmoke_zimage_turbo_00001_.png)`)
    expect(rewritten).toContain(`[远程 报告.pdf](/api/app/groups/nodes/${node}/files?path=%2FUsers%2Fsamien%2FAgents%2F%E8%BF%9C%E7%A8%8B%20%E6%8A%A5%E5%91%8A.pdf)`)
    expect(rewritten).not.toContain('MEDIA:')
  })

  it('keeps an incomplete streaming MEDIA directive untouched', () => {
    const node = '11111111-1111-4111-8111-111111111111'
    expect(rewriteRemoteNodeFiles('MEDIA:/Users/samien/Agents/partial.png', node, true))
      .toBe('MEDIA:/Users/samien/Agents/partial.png')
  })

  it('does not rewrite web URLs or local-agent content', () => {
    expect(rewriteRemoteNodeFiles('[官网](https://example.com/a.png)', 'local'))
      .toBe('[官网](https://example.com/a.png)')
  })
})
