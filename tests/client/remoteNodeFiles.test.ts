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
    expect(rewritten).toContain(`/api/plugins/yaoyao/v1/nodes/${node}/files?path=%2FUsers%2Fremote%2FAgents%2Fresult%20one.png`)
    expect(rewritten).toContain('path=%2FUsers%2Fremote%2FAgents%2Freport.pdf')
    expect(rewritten).toContain('path=%2FUsers%2Fremote%2FAgents%2Frun.log')
    expect(rewritten).not.toContain('](</Users/remote')
  })

  it('does not rewrite web URLs or local-agent content', () => {
    expect(rewriteRemoteNodeFiles('[官网](https://example.com/a.png)', 'local'))
      .toBe('[官网](https://example.com/a.png)')
  })
})
