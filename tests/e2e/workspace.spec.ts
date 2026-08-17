import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/chat')
  if (await page.getByRole('heading', { name: '登录 Hermes' }).isVisible()) {
    await page.getByLabel('账号').fill('test')
    await page.getByLabel('密码').fill('test')
    await page.getByRole('button', { name: '登录' }).click()
  }
  await expect(page.getByRole('navigation')).toBeVisible()
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
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新建群聊' })).toBeVisible()
  await expect(page.getByRole('button', { name: '管理群聊' })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()

  await page.getByRole('button', { name: '文件库' }).click()
  await expect(page.getByRole('heading', { name: '文件库', exact: true }).last()).toBeVisible()
  await expect(page.getByText('demo-report.pdf')).toBeVisible()
  await page.getByText('demo-report.pdf').click()
  await expect(page.getByRole('dialog', { name: /预览 demo-report.pdf/ })).toBeVisible()
  await page.getByRole('button', { name: '关闭预览' }).click()

  await page.goto('/artifacts')
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveCount(0)
  expect(consoleErrors).toEqual([])
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

test('restores a routed conversation even when unread-count refresh fails', async ({ page }) => {
  await page.route('**/api/app/sessions/unread*', async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unread unavailable' }) })
  })

  await page.goto('/chat/session-demo')
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
  await page.reload()
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
})

test('renders historical assistant MEDIA as Markdown in chat and group chat', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await expect(page.locator('.markdown img[alt="AppIcon-1024.png"]')).toBeVisible()

  await page.getByRole('button', { name: '群聊' }).click()
  await expect(page.locator('.markdown img[alt="AppIcon-1024.png"]')).toBeVisible()
})

test('folds tool result rows into their expandable tool call', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const tool = page.getByRole('button', { name: /file_search/ })
  await expect(tool).toBeVisible()
  await tool.click()
  await expect(page.locator('.tool-trace pre')).toContainText('/tmp/demo-report.pdf')
  await expect(page.locator('.message--tool')).toHaveCount(0)
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
  await expect(page.locator('.message--user .message__meta')).toHaveCSS('display', 'none')
  await expect(page.getByRole('button', { name: '会话操作' })).toBeVisible()
  await page.getByRole('button', { name: '会话操作' }).click()
  await expect(page.getByText('重命名', { exact: true })).toBeVisible()
  await expect(page.getByText('删除会话', { exact: true })).toBeVisible()
  await expect(page.getByText('置顶会话', { exact: true })).toHaveCount(0)
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
