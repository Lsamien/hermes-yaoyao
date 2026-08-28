import type Koa from 'koa'
import {
  createApplication,
  type ApplicationOptions,
  type ApplicationRuntime,
} from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { LocalAuthStore, type LocalUser } from '../../src/server/localAuth.js'

const TEST_ADMIN: LocalUser = {
  id: 'test-admin',
  username: 'test-admin',
  role: 'admin',
  enabled: true,
  mustChangePassword: false,
  createdAt: 1,
  updatedAt: 1,
}

class AuthenticatedTestStore extends LocalAuthStore {
  override current(_ctx: Koa.Context): LocalUser { return TEST_ADMIN }
  override require(_ctx: Koa.Context, _allowPasswordChange = false): LocalUser { return TEST_ADMIN }
  override requireAdmin(_ctx: Koa.Context): LocalUser { return TEST_ADMIN }
}

export function createAuthenticatedApplication(
  options: ApplicationOptions & { config: ServerConfig },
): ApplicationRuntime {
  return createApplication({
    ...options,
    auth: new AuthenticatedTestStore(options.config.home, Boolean(options.config.tlsCert)),
  })
}
