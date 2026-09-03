// Prepare only the disposable workspace fixture for the iOS cross-client test.
// Start tests/fixtures/workspace-server.ts on 18804 / 19124 before running this.
import { readFileSync } from 'node:fs'
const base = 'http://127.0.0.1:18804'
let cookie = '', csrf = ''
async function request(path, body, method) {
  const response = await fetch(base + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ')
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`)
  return response.json()
}
csrf = (await request('/api/app/bootstrap')).csrfToken
await request('/api/app/login', { username: 'fixture', password: 'fixture-pass' })
csrf = (await request('/api/app/bootstrap')).csrfToken
const source = (await request('/api/app/agents/sources')).sources[0]
if (!source) throw new Error('No isolated fixture profile')
const agents = (await request('/api/app/agents')).agents
const photo = 'data:image/png;base64,' + readFileSync(new URL('../public/brand/AppIcon-1024.png', import.meta.url)).toString('base64')
for (const [name, image] of [['跨端造型', false], ['跨端照片', true]]) {
  const avatar = 'yaoyao-avatar:v2:' + JSON.stringify({
    version: 2, avatarMode: image ? 'image' : 'mascot', shape: 'circle', color: '#1488ff',
    expression: 'proud', bodyId: image ? null : 'star', imageCrop: 'circle',
    ...(image ? { imageDataURL: photo } : {}),
  })
  const existing = agents.find(agent => agent.name === name)
  if (existing) await request(`/api/app/agents/${existing.id}`, { avatar }, 'PATCH')
  else await request('/api/app/agents', { name, avatar, nodeId: source.nodeId, profile: source.profile })
}
console.log('Prepared two avatar fixtures on 127.0.0.1:18804')
