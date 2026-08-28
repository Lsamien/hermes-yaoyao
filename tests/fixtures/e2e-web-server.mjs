import { rmSync } from 'node:fs'

const testHome = '/tmp/hermes-yaoyao-e2e-home'
rmSync(testHome, { recursive: true, force: true })

Object.assign(process.env, {
  NODE_ENV: 'production',
  HERMES_YAOYAO_HOME: testHome,
  HERMES_YAOYAO_HOST: '127.0.0.1',
  HERMES_YAOYAO_PORT: '18801',
  HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:19119',
  HERMES_YAOYAO_UPSTREAM_USERNAME: 'test',
  HERMES_YAOYAO_UPSTREAM_PASSWORD: 'test',
})

await import('../../dist-server/server/index.js')
