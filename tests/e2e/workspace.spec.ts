import { expect, test } from '@playwright/test'

const WIDE_DOCX_BASE64 = 'UEsDBAoAAAAIAKwmFF15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMECgAAAAAArCYUXQAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgArCYUXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBAoAAAAAAKwmFF0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgArCYUXalT+9hjAQAABwMAABEAAAB3b3JkL2RvY3VtZW50LnhtbKVSW0/CMBT+K03fpXMBJYRBFAaaYDSKwdeydluTrW3awsBfb7uVDYwmJr6cc75z+c6lHU8PZQH2VGkmeASvewEElCeCMJ5F8H29uBpCoA3mBBeC0wgeqYbTybgaEZHsSsoNsARcj6oI5sbIEUI6yWmJdU9Iym0sFarExkKVoUooIpVIqNaWvyxQGAQ3qMSMQ0e5FeTotHRCOWEmG0YomD/PPoBUdM9oNUbO7aSqZZ1stoVXL8obG1C5oa6DYWB3sq6jtOOTA4bIZ6zwUexMG0rZgRIXRJdES8WIMzOrZ6JoaAd9y4p+daOLStNQJY30xMnmrOT7fKhLPD/GKl6swfrufhWDeL6MfzgF6vr8u9vr4/Lhb+1QsyNqH0LTxHjC7O3Tv0QY9uveubUHw76/n8yesHITCRnB27DOUCzLTYu2whhRtrCgaRfLKSZURbAGqRCmBdnOeNBseBoJnf4Z6v7w5AtQSwECFAAKAAAACACsJhRdeW4z1+gAAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAAKwmFF0AAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAABkBAABfcmVscy9QSwECFAAKAAAACACsJhRdm/036q0AAAApAQAACwAAAAAAAAAAAAAAAAA9AQAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAACsJhRdAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAAATAgAAd29yZC9QSwECFAAKAAAACACsJhRdqVP72GMBAAAHAwAAEQAAAAAAAAAAAAAAAAA2AgAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAyAMAAAAA'

test.beforeEach(async ({ page }) => {
  await page.goto('/chat')
  if (await page.getByRole('heading', { name: '登录 Hermes' }).isVisible()) {
    await page.getByLabel('账号').fill('test')
    await page.getByLabel('密码').fill('test')
    await page.getByRole('button', { name: '登录' }).click()
  }
  await expect(page.getByRole('navigation')).toBeVisible()
})

test('uses the yaoyao-webui grouped model picker without a mobile full-screen sheet', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await page.locator('.composer-tool--model').click()

  const dialog = page.getByRole('dialog', { name: '选择模型' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByPlaceholder('搜索模型名称或 ID')).toBeFocused()
  await expect(dialog.locator('.model-dialog__group-header')).toContainText('OpenAI')
  await expect(dialog.locator('.model-dialog__item--active')).toContainText('gpt-5.6')

  const desktopBox = await dialog.boundingBox()
  expect(desktopBox?.width).toBeGreaterThanOrEqual(450)
  expect(desktopBox?.width).toBeLessThanOrEqual(480)

  await dialog.getByPlaceholder('搜索模型名称或 ID').fill('gpt-5.5')
  await expect(dialog.locator('.model-dialog__item')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.composer-tool--model').click()
  const mobileBox = await dialog.boundingBox()
  expect(mobileBox?.x).toBeGreaterThanOrEqual(12)
  expect(mobileBox?.width).toBeLessThanOrEqual(366)
  expect(mobileBox?.height).toBeLessThan(820)
})

test('navigates every 9119 workspace without blank transitions', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await expect(page.getByRole('option').first()).toContainText('夭夭 Web 验收会话')
  await expect(page.getByRole('option').first()).toContainText('夭夭')
  await expect(page.locator('.desktop-sidebar').getByText('已置顶 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '群聊' }).click()
  await expect(page.getByRole('heading', { name: '设计与工程协作' })).toBeVisible()
  await expect(page.getByRole('button', { name: '对话', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '群聊', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '文件库', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新建群聊' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建群聊' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: '新建群聊' })).toHaveCSS('font-weight', '580')
  await expect(page.getByRole('button', { name: '管理群聊' })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()

  await page.goto('/files')
  await expect(page.getByRole('heading', { name: '文件库', exact: true }).last()).toBeVisible()
  const fileSidebar = page.locator('.desktop-sidebar')
  await expect(fileSidebar.getByRole('button', { name: '新建聊天' })).toBeVisible()
  const compactControlHeights = await fileSidebar.locator('.sidebar-search-trigger, .sidebar-primary-action button, .sidebar-feature-nav button').evaluateAll(elements => (
    elements.map(element => element.getBoundingClientRect().height)
  ))
  expect(compactControlHeights.length).toBeGreaterThanOrEqual(4)
  expect(Math.max(...compactControlHeights)).toBeLessThanOrEqual(36)
  await expect(page.getByText('demo-report.pdf')).toBeVisible()
  const firstFileCard = page.locator('.library-grid article').first()
  const cardGeometry = await firstFileCard.evaluate(element => {
    const card = element.getBoundingClientRect()
    const preview = element.querySelector('.library-thumb')?.getBoundingClientRect()
    return { width: card.width, previewHeight: preview?.height || 0 }
  })
  expect(cardGeometry.width).toBeGreaterThanOrEqual(220)
  expect(cardGeometry.previewHeight).toBe(154)
  await page.getByText('demo-report.pdf').click()
  await expect(page.getByRole('dialog', { name: /预览 demo-report.pdf/ })).toBeVisible()
  await expect(page.locator('.preview-meta')).toHaveCount(0)
  const previewDialog = page.getByRole('dialog', { name: /预览 demo-report.pdf/ })
  await expect(previewDialog.getByRole('link', { name: '下载' })).toBeVisible()
  await expect(previewDialog.getByRole('button', { name: '加入输入框' })).toBeVisible()
  await expect(previewDialog.locator('.preview-close')).toBeVisible()
  const modalHeight = await page.locator('.preview-modal').evaluate(element => element.getBoundingClientRect().height)
  expect(modalHeight).toBeGreaterThan(600)
  await previewDialog.locator('.preview-close').click()
  await fileSidebar.getByRole('button', { name: '新建聊天' }).click()
  await expect(page).toHaveURL(/\/chat\/draft-[^?]+\?profile=yaoyao/)

  await page.goto('/artifacts')
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveCount(0)
  expect(consoleErrors).toEqual([])
})

test('previews an octet-stream Markdown file from the file library', async ({ page }) => {
  await page.route('**/api/app/files**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/app/files') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profile: 'yaoyao',
          items: [{
            id: 'markdown-file',
            path: '/tmp/版本说明.md',
            name: '版本说明.md',
            extension: '.md',
            mimeType: 'application/octet-stream',
            size: 48,
            modifiedAt: Date.now() / 1000,
            exists: true,
            origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话' }],
          }, {
            id: 'empty-markdown-file',
            path: '/tmp/空白说明.md',
            name: '空白说明.md',
            extension: 'md',
            mimeType: 'application/octet-stream',
            size: 0,
            modifiedAt: Date.now() / 1000,
            exists: true,
            origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话' }],
          }],
          nextCursor: null,
          total: 2,
        }),
      })
      return
    }
    if (url.pathname === '/api/app/files/markdown-file/preview') {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: '# 版本说明\n\n- Markdown 预览已恢复',
      })
      return
    }
    if (url.pathname === '/api/app/files/empty-markdown-file/preview') {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '' })
      return
    }
    await route.continue()
  })

  await page.goto('/files')
  await page.getByText('版本说明.md', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览 版本说明.md' })
  await expect(dialog.locator('.preview-text h1')).toHaveText('版本说明')
  await expect(dialog.getByText('Markdown 预览已恢复', { exact: true })).toBeVisible()
  await dialog.locator('.preview-close').click()
  await page.getByText('空白说明.md', { exact: true }).click()
  const emptyDialog = page.getByRole('dialog', { name: '预览 空白说明.md' })
  await expect(emptyDialog.locator('.preview-text')).toBeVisible()
  await expect(emptyDialog.locator('.preview-unavailable')).toHaveCount(0)
})

test('keeps DOCX body at 36px inset with zero canvas margin', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 760 })
  await page.route('**/api/app/files**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/app/files') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profile: 'yaoyao',
          items: [{
            id: 'wide-docx-file',
            path: '/tmp/宽版文档.docx',
            name: '宽版文档.docx',
            extension: 'docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 1024,
            modifiedAt: Date.now() / 1000,
            exists: true,
            origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话' }],
          }],
          nextCursor: null,
          total: 1,
        }),
      })
      return
    }
    if (url.pathname === '/api/app/files/wide-docx-file/preview') {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: Buffer.from(WIDE_DOCX_BASE64, 'base64'),
      })
      return
    }
    await route.continue()
  })

  await page.goto('/files')
  await page.getByText('宽版文档.docx', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览 宽版文档.docx' })
  const office = dialog.locator('.preview-office')
  await expect(office.locator('section.docx')).toBeVisible()
  const geometry = await office.evaluate(element => {
    const wrapper = element.querySelector<HTMLElement>('.docx-wrapper')!
    const pageElement = element.querySelector<HTMLElement>('section.docx')!
    const article = pageElement.querySelector<HTMLElement>('article')!
    const table = article.querySelector<HTMLElement>('table')!
    const officeRect = element.getBoundingClientRect()
    const pageRect = pageElement.getBoundingClientRect()
    const officeStyle = getComputedStyle(element)
    const wrapperStyle = getComputedStyle(wrapper)
    const articleStyle = getComputedStyle(article)
    return {
      officeLeft: officeRect.left,
      pageLeft: pageRect.left,
      pageWidth: pageRect.width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      wrapperWidth: wrapper.getBoundingClientRect().width,
      articlePaddingTop: Number.parseFloat(articleStyle.paddingTop),
      articlePaddingLeft: Number.parseFloat(articleStyle.paddingLeft),
      articlePaddingRight: Number.parseFloat(articleStyle.paddingRight),
      tableLeft: table.getBoundingClientRect().left,
      tableRight: table.getBoundingClientRect().right,
      officeBackground: officeStyle.backgroundColor,
      wrapperBackground: wrapperStyle.backgroundColor,
      wrapperPaddingTop: Number.parseFloat(wrapperStyle.paddingTop),
      wrapperPaddingLeft: Number.parseFloat(wrapperStyle.paddingLeft),
      wrapperPaddingRight: Number.parseFloat(wrapperStyle.paddingRight),
    }
  })
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.pageLeft).toBeGreaterThanOrEqual(geometry.officeLeft)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  expect(Math.abs(geometry.wrapperWidth - geometry.clientWidth)).toBeLessThan(1)
  expect(geometry.articlePaddingTop).toBe(36)
  expect(geometry.articlePaddingLeft).toBe(36)
  expect(geometry.articlePaddingRight).toBe(36)
  expect(geometry.tableLeft).toBeGreaterThanOrEqual(geometry.pageLeft - 1)
  expect(geometry.tableRight).toBeLessThanOrEqual(geometry.pageLeft + geometry.pageWidth + 1)
  expect(geometry.officeBackground).toBe('rgb(255, 255, 255)')
  expect(geometry.wrapperBackground).toBe('rgb(255, 255, 255)')
  expect(geometry.wrapperPaddingTop).toBe(0)
  expect(geometry.wrapperPaddingLeft).toBe(0)
  expect(geometry.wrapperPaddingRight).toBe(0)

  await page.setViewportSize({ width: 930, height: 760 })
  const centered = await office.evaluate(element => {
    const pageElement = element.querySelector<HTMLElement>('section.docx')!
    const officeRect = element.getBoundingClientRect()
    const pageRect = pageElement.getBoundingClientRect()
    return {
      pageWidth: pageRect.width,
      clientWidth: element.clientWidth,
      leftGap: pageRect.left - officeRect.left,
      rightGap: officeRect.right - pageRect.right,
    }
  })
  expect(centered.pageWidth).toBeLessThan(centered.clientWidth)
  expect(centered.leftGap).toBeGreaterThanOrEqual(18)
  expect(centered.rightGap).toBeGreaterThanOrEqual(18)
  expect(Math.abs(centered.leftGap - centered.rightGap)).toBeLessThanOrEqual(12)
})

test('keeps pins first and loads the next session page at the list bottom', async ({ page }) => {
  const sidebar = page.locator('.desktop-sidebar')
  const items = sidebar.locator('.sidebar-list [role="option"]')
  await expect(items).toHaveCount(100)
  await expect(items.first()).toContainText('夭夭 Web 验收会话')
  await expect(sidebar.getByRole('button', { name: '继续加载会话' })).toBeVisible()

  const list = sidebar.locator('.sidebar-list')
  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(items).toHaveCount(103)
  await expect(sidebar.getByRole('button', { name: '继续加载会话' })).toHaveCount(0)
})

test('switches the composer model to the selected historical session model', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  await expect(page.locator('.composer-tool--model')).toContainText('gpt-5.6')
  await page.getByRole('option', { name: /第二个会话/ }).click()
  await expect(page.locator('.composer-tool--model')).toContainText('gpt-5.5')
})

test('restores a routed conversation even when unread-count refresh fails', async ({ page }) => {
  await page.route('**/api/app/sessions/unread*', async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unread unavailable' }) })
  })

  await page.goto('/chat/session-demo')
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
  await page.reload()
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
})

test('opens a conversation even when marking it read is unsupported', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/app/sessions/unread/*', async route => {
    await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'Method Not Allowed' }) })
  })

  await page.getByRole('option').filter({ hasText: '第二个会话' }).click()
  await expect(page).toHaveURL(/\/chat\/session-second\?profile=yaoyao/)
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('syncs the blue fast-mode shortcut with the iOS-compatible session config', async ({ page }) => {
  await page.request.post('http://127.0.0.1:19119/__test/rpc-requests/reset')
  await page.goto('/chat/session-demo')
  const fast = page.getByRole('button', { name: '快速模式：已关闭' })
  await expect(fast).toHaveAttribute('aria-pressed', 'false')
  await fast.click()
  const enabled = page.getByRole('button', { name: '快速模式：已开启' })
  await expect(enabled).toHaveAttribute('aria-pressed', 'true')
  await expect(enabled).toHaveCSS('color', 'rgb(22, 119, 255)')

  await page.getByRole('textbox', { name: '输入消息，Enter 发送，Shift + Enter 换行' }).fill('使用快速模式')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByText('这是来自假 Gateway 的流式回复。', { exact: true })).toBeVisible()

  const payload = await (await page.request.get('http://127.0.0.1:19119/__test/rpc-requests')).json() as { requests: Array<{ method: string; params: Record<string, unknown> }> }
  const fastConfigIndex = payload.requests.findIndex(request => request.method === 'config.set' && request.params.key === 'fast')
  const promptIndex = payload.requests.findIndex(request => request.method === 'prompt.submit')
  expect(fastConfigIndex).toBeGreaterThanOrEqual(0)
  expect(promptIndex).toBeGreaterThan(fastConfigIndex)
  expect(payload.requests[fastConfigIndex]?.params).toMatchObject({ key: 'fast', value: 'fast', scope: 'session' })

  await enabled.click()
  await expect(page.getByRole('button', { name: '快速模式：已关闭' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => {
    const next = await (await page.request.get('http://127.0.0.1:19119/__test/rpc-requests')).json() as typeof payload
    return next.requests.filter(request => request.method === 'config.set' && request.params.key === 'fast').at(-1)?.params.value
  }).toBe('normal')
})

test('reconciles an iOS fast-mode selection from the resumed 9119 session', async ({ page }) => {
  await page.request.post('http://127.0.0.1:19119/__test/rpc-requests/reset')
  await page.goto('/chat/session-yaoer?profile=yaoer')
  await expect(page.getByRole('button', { name: '快速模式：已关闭' })).toBeVisible()
  await page.getByRole('textbox', { name: '输入消息，Enter 发送，Shift + Enter 换行' }).fill('读取 iOS 快速模式')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByRole('button', { name: '快速模式：已开启' })).toHaveCSS('color', 'rgb(22, 119, 255)')

  const payload = await (await page.request.get('http://127.0.0.1:19119/__test/rpc-requests')).json() as { requests: Array<{ method: string; params: Record<string, unknown> }> }
  expect(payload.requests.some(request => request.method === 'session.resume' && request.params.session_id === 'session-yaoer')).toBe(true)
  expect(payload.requests.some(request => request.method === 'config.set' && request.params.key === 'fast')).toBe(false)
})

test('keeps the show-thinking preference across sessions of the same Agent', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await expect(page.locator('.turn-trace')).toHaveCount(1)
  await page.locator('.composer-tool[aria-label="设置"]').click()
  const setting = page.getByRole('switch', { name: /显示思考/ })
  await expect(setting).toHaveAttribute('aria-checked', 'true')
  await setting.click()
  await expect(page.locator('.turn-trace')).toHaveCount(0)
  await page.getByRole('option').filter({ hasText: '第二个会话' }).click()
  await expect(page.locator('.turn-trace')).toHaveCount(0)
  await page.locator('.composer-tool[aria-label="设置"]').click()
  await page.getByRole('switch', { name: /显示思考/ }).click()
  await expect(page.locator('.turn-trace')).toHaveCount(1)
})

test('restores a legacy session link under its owning Agent profile', async ({ page }) => {
  await page.goto('/chat/session-yaoer')
  await expect(page.getByText('瑶儿历史消息', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/chat\/session-yaoer\?profile=yaoer/)
  await page.reload()
  await expect(page.getByText('瑶儿历史消息', { exact: true })).toBeVisible()
})

test('renders historical assistant MEDIA as Markdown in chat and group chat', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const image = page.locator('.markdown img[alt="夭夭 Logo"]')
  await expect(image).toBeVisible()
  await image.click()
  const mediaDialog = page.getByRole('dialog', { name: /预览 AppIcon-1024.png/ })
  await expect(mediaDialog).toBeVisible()
  await expect(mediaDialog.getByRole('button', { name: '下一张媒体' })).toBeVisible()
  await mediaDialog.getByRole('button', { name: '下一张媒体' }).click()
  await expect(mediaDialog.locator('img')).toHaveAttribute('src', /variant=2/)
  await page.keyboard.press('ArrowLeft')
  await expect(mediaDialog.locator('img')).not.toHaveAttribute('src', /variant=2/)
  await expect(mediaDialog.getByRole('link', { name: /下载 AppIcon-1024\.png/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /预览 AppIcon-1024.png/ })).toBeHidden()

  await image.click()
  const reopenedMediaDialog = page.getByRole('dialog', { name: /预览 AppIcon-1024.png/ })
  await reopenedMediaDialog.getByRole('button', { name: '添加到聊天' }).click()
  await expect(reopenedMediaDialog).toBeHidden()
  await expect(page.locator('.composer-attachments img[alt="AppIcon-1024.png"]')).toBeVisible()

  await page.getByRole('button', { name: '群聊' }).click()
  await expect(page.locator('.markdown img[alt="AppIcon-1024.png"]')).toBeVisible()
})

test('renders persisted user file markers as attachment cards', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  const userMessage = page.locator('[data-message-id="message-user-file"]')
  await expect(userMessage).toContainText('查看附件')
  await expect(userMessage.getByRole('button', { name: /测试报告\.docx/ })).toBeVisible()
  await expect(userMessage).not.toContainText('@file:')
  await expect(userMessage).not.toContainText('用户附加文件')
})

test('folds tool result rows into their expandable tool call', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const trace = page.locator('.turn-trace').first()
  await expect(trace).not.toHaveAttribute('open', '')
  await expect(trace.locator('summary')).toContainText('思考与工具')
  await expect(trace.locator('summary')).toContainText('2 段思考 · 2 个工具')
  await trace.locator('summary').click()
  await expect(trace.locator('.turn-trace__reasoning')).toHaveCount(2)
  await expect(trace.locator('.tool-trace')).toHaveCount(2)
  await expect(trace.locator('.tool-trace__details')).toHaveCount(2)
  await expect(trace.locator('.tool-trace__details').filter({ hasText: '/tmp/demo-report.pdf' })).toBeVisible()
  await expect(page.locator('[data-message-id="message-tool-call"]')).toHaveCount(0)
  await expect(page.locator('.message--tool')).toHaveCount(0)
})

test('renders subtask completion as a collapsed timeline event', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await expect(page.getByText('子任务已完成', { exact: true })).toBeVisible()
  const delegation = page.locator('.delegation-event').filter({ hasText: '子任务已完成' })
  await expect(delegation).toContainText('2 个子任务 · 2 已完成')
  await expect(delegation).not.toHaveAttribute('open', '')
})

test('renders context compaction as a collapsed timeline event', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const compaction = page.locator('[data-message-id="message-compaction"] .compaction-event')
  await expect(compaction).toContainText('上下文已压缩')
  await expect(compaction).toContainText('压缩摘要已归档 · 点击查看')
  await expect(compaction).not.toHaveAttribute('open', '')
  await expect(compaction.getByText('Historical Task Snapshot', { exact: true })).toBeHidden()
  await compaction.locator('summary').click()
  await expect(compaction.getByText('Historical Task Snapshot', { exact: true })).toBeVisible()
  await expect(page.locator('[data-message-id="message-compaction"]')).toHaveClass(/message--system/)
})

test('renders model changes as a collapsed system event', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await expect(page.getByText('模型已切换：gpt-5.6-terra', { exact: true })).toBeVisible()
  await expect(page.locator('.system-event')).not.toHaveAttribute('open', '')
})

test('opens a local message file link as a floating preview card', async ({ page }) => {
  await page.route('**/Users/samien/Agents/%E6%96%B9%E6%A1%88%E8%8D%89%E7%A8%BF.md', route => route.fulfill({
    status: 200,
    contentType: 'text/markdown',
    body: '# 会话文件\n\n这是会话中的文本文件。',
  }))
  await page.goto('/chat/session-demo')
  const card = page.getByRole('link', { name: '预览文件 方案草稿.md' })
  await expect(card).toHaveClass(/file-link-card/)
  await card.click()
  const dialog = page.getByRole('dialog', { name: '预览 方案草稿.md' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.preview-text')).toBeVisible()
  const textPadding = await dialog.locator('.preview-text').evaluate(element => {
    const style = getComputedStyle(element)
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) }
  })
  expect(textPadding.left).toBeGreaterThanOrEqual(24)
  expect(textPadding.right).toBeGreaterThanOrEqual(24)
  const stageHeight = await dialog.locator('.preview-stage').evaluate(stage => stage.getBoundingClientRect().height)
  expect(stageHeight).toBeGreaterThan(500)
})

test('shows a thinking animation after submit until output starts', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  await page.locator('.composer-textarea').fill('请开始思考')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.locator('.thinking-indicator')).toBeVisible()
  await expect(page.getByText('这是来自假 Gateway 的流式回复。', { exact: true })).toBeVisible()
  await expect(page.locator('.thinking-indicator')).toHaveCount(0)
})

test('keeps the canonical logo and yaoyao-webui composer geometry', async ({ page }) => {
  const logo = page.locator('.rail__brand img')
  await expect(logo).toHaveAttribute('src', '/brand/AppIcon-1024.png')
  const emptyLogo = page.locator('.new-chat-empty__logo')
  await expect(emptyLogo).toHaveAttribute('src', '/brand/AppIcon-1024.png')
  await expect(page.getByText('聊点什么', { exact: true })).toBeVisible()
  await expect(page.locator('.timeline-header')).toHaveClass(/timeline-header--transparent/)
  await expect(page.locator('.composer-context')).toContainText('剩余 256.0k')
  await page.getByRole('button', { name: '推理强度：默认' }).click()
  await expect(page.locator('.composer-popover--reasoning')).toBeVisible()
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.composer-popover--settings')).toBeVisible()
  await expect(page.getByText('语音输入设置', { exact: true })).toBeVisible()
  await page.locator('.composer-shell').click()
  await page.getByRole('option').first().click()
  await expect(page.locator('.timeline')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.message--assistant .message__avatar')).toHaveCount(0)
  await expect(page.locator('.message--assistant .message__meta')).toHaveCount(0)
  const assistantMessage = page.locator('.message--assistant-anonymous:not(.message--tool-only)').first()
  await page.mouse.move(1200, 20)
  await expect(assistantMessage.locator('.message__actions')).toHaveCSS('opacity', '0')
  await assistantMessage.hover()
  await expect(assistantMessage.locator('.message__actions')).toHaveCSS('opacity', '1')
  await expect(page.locator('.message--tool-only .message__actions')).toHaveCount(0)
  await expect(page.locator('[data-message-id="message-thinking-tool"]')).toHaveCount(0)
  await expect(page.locator('.turn-trace')).toHaveCount(1)
  const userMessageMeta = page.locator('.message--user .message__meta')
  await expect(userMessageMeta).not.toHaveCount(0)
  expect(await userMessageMeta.evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none'))).toBe(true)
  await expect(page.getByRole('button', { name: '会话操作' })).toBeVisible()
  await page.getByRole('button', { name: '会话操作' }).click()
  const sessionMenu = page.getByRole('menu', { name: '会话操作' })
  await expect(sessionMenu.getByText('会话大纲', { exact: true })).toBeVisible()
  await sessionMenu.getByText('会话大纲', { exact: true }).click()
  const outline = page.getByRole('navigation', { name: '会话大纲' })
  await expect(outline).toBeVisible()
  await expect(outline.getByText('请检查今天生成的产物。MEDIA:/brand/AppIcon-1024.png', { exact: true })).toBeVisible()
  await expect(outline.getByText('验收摘要', { exact: true })).toBeVisible()
  await outline.getByRole('button', { name: '跳转到 验收摘要' }).click()
  await expect(page.locator('[data-message-id="message-assistant"]')).toHaveClass(/message--revealed/)
  await page.getByRole('button', { name: '关闭会话大纲' }).click()
  await expect(outline).toBeHidden()
  await page.getByRole('button', { name: '会话操作' }).click()
  await expect(sessionMenu.getByText('取消置顶', { exact: true })).toBeVisible()
  const unpinIcon = sessionMenu.getByRole('menuitem', { name: '取消置顶' }).locator('.app-icon')
  await expect(unpinIcon.locator('path')).toHaveCount(2)
  await expect(unpinIcon.locator('path').last()).toHaveAttribute('d', 'M4 4l16 16')
  await expect(page.locator('.desktop-sidebar .sidebar-item--single-line').first().locator('.app-icon path')).toHaveAttribute('fill', 'currentColor')
  await expect(sessionMenu.getByText('重命名', { exact: true })).toBeVisible()
  await expect(sessionMenu.getByText('删除会话', { exact: true })).toBeVisible()
  await expect(page.getByText('置顶会话', { exact: true })).toHaveCount(0)
  const menuBox = await sessionMenu.evaluate(element => element.getBoundingClientRect().toJSON())
  expect(menuBox.width).toBeLessThanOrEqual(220)
  expect(menuBox.height).toBeLessThan(165)
  await expect(page.locator('.session-action-layer')).toHaveCount(0)
  await sessionMenu.getByText('取消置顶', { exact: true }).click()
  await expect(page.locator('.desktop-sidebar').getByText('已置顶 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '会话操作' }).click()
  await sessionMenu.getByText('置顶会话', { exact: true }).click()
  await expect(page.locator('.desktop-sidebar').getByText('已置顶 1', { exact: true })).toBeVisible()

  const compactSession = page.locator('.desktop-sidebar .sidebar-item--single-line').first()
  const compactMetrics = await compactSession.evaluate(element => {
    const title = element.querySelector('strong')
    return {
      height: element.getBoundingClientRect().height,
      weight: title ? Number(getComputedStyle(title).fontWeight) : 0,
    }
  })
  expect(compactMetrics.height).toBeLessThanOrEqual(31)
  expect(compactMetrics.weight).toBeLessThan(500)
  await compactSession.click({ button: 'right' })
  await expect(sessionMenu).toBeVisible()
  await page.keyboard.press('Escape')
  const composer = page.locator('.composer-shell')
  await expect(composer).toBeVisible()
  const geometry = await composer.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { width: rect.width, minHeight: style.minHeight, radius: style.borderRadius }
  })
  expect(geometry.width).toBeLessThanOrEqual(760)
  expect(geometry.minHeight).toBe('72px')
  expect(geometry.radius).toBe('18px')
  const send = page.getByRole('button', { name: '发送消息' })
  await expect(send).toHaveCSS('width', '34px')
  await expect(send).toHaveCSS('height', '34px')
})

test('uses the unified Grok-style sidebar, search trigger, and persistent collapse', async ({ page }) => {
  const sidebar = page.locator('.desktop-sidebar')
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toHaveCSS('width', '264px')
  await expect(sidebar.locator('.brand-mark__name')).toHaveCount(0)
  await expect(sidebar.locator('.profile-switcher')).toHaveCount(0)
  await expect(sidebar.locator('.sidebar-account-switcher')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toHaveCSS('font-weight', '580')
  await expect(sidebar.getByText('历史记录', { exact: true })).toBeVisible()

  const searchTrigger = page.getByRole('button', { name: '搜索', exact: true })
  const triggerBox = await searchTrigger.boundingBox()
  await searchTrigger.click()
  const search = page.getByPlaceholder('搜索会话').filter({ visible: true })
  await expect(search).toBeVisible()
  await page.waitForTimeout(150)
  const inputBox = await search.evaluate(element => {
    const rect = element.closest('label')?.getBoundingClientRect()
    return rect ? { y: rect.y, height: rect.height } : null
  })
  expect(inputBox?.y).toBe(triggerBox?.y)
  expect(inputBox?.height).toBe(triggerBox?.height)
  await search.fill('验收')
  await expect(page.getByRole('option', { name: /夭夭 Web 验收会话/ })).toBeVisible()
  await search.press('Escape')
  await expect(search).toBeHidden()
  await expect(searchTrigger).toBeVisible()
  await expect(searchTrigger).toHaveAttribute('aria-expanded', 'false')

  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await expect(sidebar).toHaveCSS('width', '68px')
  const collapseBox = await page.getByRole('button', { name: '展开侧边栏' }).boundingBox()
  const accountBox = await sidebar.locator('.sidebar-account-switcher__main').boundingBox()
  expect(collapseBox?.y).toBeLessThan(accountBox?.y ?? 0)
  await expect(sidebar.getByText('历史记录', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible()
  await page.reload()
  await expect(sidebar).toHaveCSS('width', '68px')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(sidebar).toHaveCSS('width', '264px')
  await expect(page.getByPlaceholder('搜索会话').filter({ visible: true })).toBeVisible()
})

test('uses the mobile composer and keeps the closed drawer inert', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole('navigation')).not.toBeVisible()
  const drawer = page.locator('.mobile-drawer')
  await expect(drawer).toHaveAttribute('aria-hidden', 'true')
  await expect(drawer).toHaveAttribute('inert', '')
  await expect(page.locator('.composer-shell')).toHaveCSS('min-height', '118px')
  await expect(page.locator('.composer-textarea')).toHaveCSS('font-size', '16px')
})
