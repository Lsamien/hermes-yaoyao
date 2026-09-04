import { expect, test, type APIRequestContext, type Locator } from '@playwright/test'

const mediaPaths = [
  '/Users/samien/.hermes/profiles/yaoer/cache/images/openai_codex_gpt-image-2-high_20260902_194820_1d225f08.png',
  '/Users/samien/.hermes/profiles/yaoer/cache/images/国漫三视图.png',
]
const mediaNames = mediaPaths.map(path => path.split('/').at(-1)!)

async function signIn(request: APIRequestContext, origin: string) {
  const bootstrap = await (await request.get('/api/app/bootstrap')).json()
  if (bootstrap.setupRequired) {
    const setup = await request.post('/api/app/setup', {
      headers: { Origin: origin, 'X-CSRF-Token': bootstrap.csrfToken },
      data: { username: 'admin', password: 'e2e-password' },
    })
    expect(setup.ok()).toBe(true)
    return
  }
  const login = await request.post('/api/app/login', {
    headers: { Origin: origin, 'X-CSRF-Token': bootstrap.csrfToken },
    data: { username: 'admin', password: 'e2e-password' },
  })
  expect(login.ok()).toBe(true)
}

async function expectDecodedImage(image: Locator) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

test('loads Hermes profile cache images through the Web server and switches their full-size previews', async ({ page, baseURL }, testInfo) => {
  await signIn(page.request, new URL(baseURL!).origin)
  // No image interception: this exercises the real Web route, upstream account
  // authentication, attachment-to-inline response handling, and browser decode.
  const responses = mediaPaths.map(path => page.waitForResponse(response => (
    decodeURIComponent(new URL(response.url()).pathname) === path
  )))
  await page.goto('/chat/session-media?profile=yaoer')
  await expect(page).toHaveTitle('瑶儿生成图片验收 · 夭夭')

  for (const [index, name] of mediaNames.entries()) {
    const image = page.getByRole('button', { name: `预览图片 ${name}`, exact: true })
    await image.scrollIntoViewIfNeeded()
    await expectDecodedImage(image)
    const response = await responses[index]!
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('image/png')
    expect(response.headers()['content-disposition'] ?? '').not.toMatch(/^attachment(?:;|$)/)
    expect(new URL(response.url()).origin).toBe(new URL(baseURL!).origin)
  }

  await page.getByRole('button', { name: `预览图片 ${mediaNames[0]}`, exact: true }).click()
  const preview = page.locator('.image-preview-overlay')
  await expect(preview).toHaveAccessibleName(`预览 ${mediaNames[0]}`)
  await expectDecodedImage(preview.getByRole('img', { name: mediaNames[0], exact: true }))
  await expect(preview.locator('.image-preview-counter')).toHaveText('1 / 2')

  await preview.getByRole('button', { name: '下一张媒体' }).click()
  await expect(preview).toHaveAccessibleName(`预览 ${mediaNames[1]}`)
  const secondPreview = preview.getByRole('img', { name: mediaNames[1], exact: true })
  await expectDecodedImage(secondPreview)
  expect(decodeURIComponent(new URL(await secondPreview.getAttribute('src') || '', baseURL).pathname)).toBe(mediaPaths[1])
  await expect(preview.locator('.image-preview-counter')).toHaveText('2 / 2')

  await page.keyboard.press('ArrowLeft')
  await expect(preview).toHaveAccessibleName(`预览 ${mediaNames[0]}`)
  await expectDecodedImage(preview.getByRole('img', { name: mediaNames[0], exact: true }))
  await expect(preview.locator('.image-preview-counter')).toHaveText('1 / 2')
  await page.screenshot({ path: testInfo.outputPath('hermes-profile-cache-preview.png') })
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
})

test('restores nine user Profile uploads as images and opens the whole batch in the preview', async ({ page, baseURL }, testInfo) => {
  await signIn(page.request, new URL(baseURL!).origin)
  await page.goto('/chat/session-user-media?profile=yaoer')
  const message = page.locator('.message--user')
  await expect(message).toContainText('读取图片中的提示词')
  await expect(message).not.toContainText('@image:')
  await expect(message).not.toContainText('[用户附加图片')
  await expect(message).not.toContainText('[screenshot]')
  const images = message.locator('img')
  await expect(images).toHaveCount(9)
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded()
    await expectDecodedImage(image)
    const url = new URL(await image.getAttribute('src') || '', baseURL)
    expect(url.origin).toBe(new URL(baseURL!).origin)
    expect(url.pathname).toContain('/.hermes/profiles/yaoer/images/')
  }
  await page.screenshot({ path: testInfo.outputPath('user-profile-images.png') })
  await images.first().click()
  const preview = page.locator('.image-preview-overlay')
  await expect(preview.locator('.image-preview-counter')).toHaveText('1 / 9')
  await expectDecodedImage(preview.getByRole('img', { name: '照片-1.png', exact: true }))
  await preview.getByRole('button', { name: '下一张媒体' }).click()
  await expect(preview.locator('.image-preview-counter')).toHaveText('2 / 9')
  await expectDecodedImage(preview.getByRole('img', { name: '照片-2.png', exact: true }))
  await page.screenshot({ path: testInfo.outputPath('user-profile-image-preview.png') })
})
