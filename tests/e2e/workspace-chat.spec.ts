import { test, expect, type Page } from '@playwright/test'
async function login(page: Page) {
  await page.goto('/conversations')
  await page.getByRole('textbox', { name: '账号', exact: true }).fill('fixture')
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('fixture-pass')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '从一个角色开始' })).toBeVisible()
}
async function createAgent(page: Page, name: string) {
  await page.getByRole('button', { name: '＋ 创建 Agent', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name)
  await dialog
    .getByRole('textbox', { name: '角色提示词与规则', exact: true })
    .fill(`你是${name}，每次回复给出验收证据。`)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}
test('created roles and immutable teams share a durable chat list without plugin calls', async ({
  page,
  context,
}, testInfo) => {
  const pluginCalls: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/plugins/yaoyao')) pluginCalls.push(r.url())
  })
  await login(page)
  await createAgent(page, '产品经理')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('请说明角色职责')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.message.assistant')).toContainText('我是产品经理')
  await expect(page.locator('.message.assistant a').first()).toHaveAttribute(
    'href',
    /\/api\/app\/files\/.+\/download/,
  )
  const directURL = page.url()
  await createAgent(page, '开发工程师')
  await expect(page.locator('.message')).toHaveCount(0)
  await page.getByRole('button', { name: '＋ 创建群聊', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('产品开发团队')
  await dialog.getByRole('checkbox', { name: '产品经理', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '开发工程师', exact: true }).check()
  await dialog
    .getByRole('combobox', { name: '管理员', exact: true })
    .selectOption({ label: '产品经理' })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('heading', { name: '产品开发团队', exact: true })).toBeVisible()
  await expect(page.locator('.desktop-sidebar .conversation-row')).toHaveCount(3)
  await expect(page.locator('.desktop-sidebar')).not.toContainText('话题')
  await expect(page.locator('.desktop-sidebar .sidebar-account-switcher')).not.toContainText(
    '通用助手',
  )
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: '产品经理', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('checkbox', { name: '开发工程师', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('checkbox', { name: '@开发工程师', exact: true }).check()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('给出实现结果')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.message.assistant')).toHaveCount(2)
  await expect(page.locator('.run-status')).toHaveCount(0)
  const second = await context.newPage()
  await second.goto(page.url())
  await expect(second.locator('.message.assistant')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('mixed-chats.png'), fullPage: true })
  const groupURL=page.url()
  await page.getByRole('button',{name:'文件库',exact:true}).click()
  await page.getByRole('button',{name:'查看来源',exact:true}).first().click()
  await expect(page).toHaveURL(groupURL)
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.locator('.desktop-sidebar .conversation-row')).toHaveCount(2)
  await page.getByRole('checkbox', { name: '显示已归档', exact: true }).first().check()
  await expect(page.locator('.desktop-sidebar .conversation-row')).toHaveCount(1)
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await page.goto(directURL)
  await expect(page.locator('.message.assistant')).toHaveCount(1)
  await expect(page.locator('.message.assistant')).toContainText('我是产品经理')
  await page.getByRole('button', { name: '原生对话', exact: true }).click()
  await expect(page).toHaveURL(/\/chat/)
  expect(pluginCalls).toEqual([])
  await second.close()
})
