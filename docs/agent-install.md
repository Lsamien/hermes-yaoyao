# 夭夭 Agent 安装手册

适用于需要部署或升级夭夭 Web 与 Hermes Dashboard 插件的自动化 Agent。

## 发布版本

| 项目 | 版本 | 校验位置 |
| --- | --- | --- |
| Git 发布标签 | `v0.2.19` | `release.json` 的 `gitTag` 与 `git describe --tags --exact-match HEAD` |
| 夭夭 Web | `0.2.19` | `release.json` 与 `package.json` 的 `version` |
| Hermes Dashboard 插件 | `1.7.3` | `hermes-plugins/yaoyao/dashboard/manifest.json` 的 `version` |

以下步骤以仓库根目录为工作目录。不要使用浮动分支替代发布标签。

## 网络默认值与局域网策略

通过 `service install` 安装的受管服务默认监听可信局域网，两个端口一起开放：

| 端口 | 服务 | 默认监听地址 | 开启局域网的责任边界 |
| --- | --- | --- | --- |
| `9119` | Hermes Dashboard | `0.0.0.0` | 由 8800 服务持续监督；沿用或创建独立服务认证后启动 |
| `8800` | 夭夭 Web | `0.0.0.0` | LaunchAgent 显式写入可信局域网 HTTP 开关 |

受管服务不支持“仅开放 8800”：安装后会同时以局域网地址启动 8800 和 9119。该默认值只适用于受管 macOS LaunchAgent；手动 `npm start` 和 Docker 部署仍使用各自的绑定配置。

受管 `service install` 会覆盖遗留的 loopback 环境并保持局域网监听。若部署必须限制为仅本机访问，请使用手动 `npm start` 或 Docker 的回环绑定，不要使用受管 LaunchAgent。

默认局域网模式会显式设置 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1`，只适合受信网络。跨不受信网络部署时必须设置 `HERMES_YAOYAO_TLS_CERT` 和 `HERMES_YAOYAO_TLS_KEY`，并使用防火墙或反向代理限制访问；`hermes dashboard --insecure` 不会关闭认证，不能将它当成局域网开关。

## 受管 9119 的默认认证与持续监督

夭夭 Web LaunchAgent 默认启用 `HERMES_YAOYAO_SUPERVISE_DASHBOARD=1`。它每 5 秒检查本机 `9119`；端口未监听时会启动 Dashboard。首次发现 `dashboard.basic_auth` 未配置时，它会写入 8800 生成的服务账号并重启 Dashboard 载入配置：

| 项目 | 默认值 |
| --- | --- |
| 用户名 | `yaoyao-service` |
| 密码 | 8800 首次安装随机生成并加密保存 |
| 密码存储 | `password_hash` scrypt 哈希，不保存明文 |
| 会话签名密钥 | 首次配置时随机生成 |

8800 自己的默认管理员仍为 `admin/admin`，首次登录必须修改。它与上述 9119 服务
账号相互独立。监督器只会填补缺失的 9119 用户名、密码和会话签名密钥，绝不会
覆盖已有配置；已有或外部 9119 请在 8800“系统管理”中验证并保存服务凭据。

如需在首次登录后替换默认密码，可用下列命令以 scrypt 哈希方式写入配置。不要将新密码放入命令历史、Git 或日志。

```bash
HERMES_AGENT_HOME="${HERMES_AGENT_HOME:-$HOME/.hermes/hermes-agent}"
read -r -p 'Dashboard username: ' DASHBOARD_USERNAME
read -r -s -p 'Dashboard password: ' DASHBOARD_PASSWORD
printf '\n'

DASHBOARD_PASSWORD_HASH="$(
  DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" \
    "$HERMES_AGENT_HOME/venv/bin/python" -c \
    'import os; from plugins.dashboard_auth.basic import hash_password; print(hash_password(os.environ["DASHBOARD_PASSWORD"]))'
)"
DASHBOARD_SECRET="$("$HERMES_AGENT_HOME/venv/bin/python" -c 'import secrets; print(secrets.token_urlsafe(32))')"

hermes config set dashboard.basic_auth.username "$DASHBOARD_USERNAME"
hermes config set dashboard.basic_auth.password_hash "$DASHBOARD_PASSWORD_HASH"
hermes config set dashboard.basic_auth.secret "$DASHBOARD_SECRET"

unset DASHBOARD_PASSWORD DASHBOARD_PASSWORD_HASH DASHBOARD_SECRET
```

`password_hash` 优先于明文 `password`。`secret` 使认证会话可跨 Dashboard 重启继续有效。若 Dashboard 由 LaunchAgent 或其他监督器运行，配置变更后必须通过**同一个监督器**重启它，确保新认证提供方被加载。

受管服务负责启动和重启 9119，不能再同时安装独立的 Dashboard LaunchAgent 或手动长期运行 `hermes dashboard`。认证加载可在本机无密码回显地检查：

```bash
hermes config get dashboard.basic_auth.username
curl --fail --silent --show-error http://127.0.0.1:9119/api/auth/providers
```

第二条命令应能返回包含用户名密码登录提供方的 JSON。不要在自动化日志、命令行、环境变量转储或 Git 配置中记录替换后的明文密码。

## 1. 获取并校验指定发布版本

```bash
RELEASE_VERSION=v0.2.19
git fetch --tags
git checkout "$RELEASE_VERSION"

test "$(git describe --tags --exact-match HEAD)" = "$RELEASE_VERSION"
test "$(node -p \"require('./package.json').version\")" = "0.2.19"
test "$(node -e \"console.log(require('./hermes-plugins/yaoyao/dashboard/manifest.json').version)\")" = "1.7.3"
npm run release:verify
```

这会进入 detached HEAD 状态，属于部署发布版本的预期行为。若 Agent 负责修改代码，应另行创建工作分支，不要在此发布检出上修改。

## 2. 安装或升级 Hermes Dashboard 插件

前提：目标机器已安装 Hermes，且 `hermes dashboard --status` 可执行。插件必须完整放在 `<Hermes 数据目录>/plugins/yaoyao/dashboard/`，不能只复制 Python 文件或前端 `dist/` 目录。

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN_DIR="$HERMES_HOME/plugins/yaoyao/dashboard"
BACKUP_DIR="${PLUGIN_DIR}.backup-$(date +%Y%m%d%H%M%S)"

if [ -d "$PLUGIN_DIR" ]; then
  cp -a "$PLUGIN_DIR" "$BACKUP_DIR"
fi

mkdir -p "$PLUGIN_DIR"
rsync -a --delete \
  --exclude '__pycache__/' \
  --exclude '*.py[cod]' \
  --exclude '.pytest_cache/' \
  hermes-plugins/yaoyao/dashboard/ "$PLUGIN_DIR/"

test -f "$PLUGIN_DIR/manifest.json"
test -f "$PLUGIN_DIR/plugin_api.py"
test -f "$PLUGIN_DIR/group_plugin_api.py"
test -f "$PLUGIN_DIR/dist/index.js"
test "$(node -e \"console.log(require(process.argv[1]).version)\" "$PLUGIN_DIR/manifest.json")" = "1.7.3"
```

`rsync --delete` 的范围严格限于 `$PLUGIN_DIR`，不会删除其他 Hermes 插件或用户数据。若目标目录已有额外的本机定制文件，应先将其移出目录或改用不带 `--delete` 的同步命令。

不要提交、复制或恢复 `data/`、`__pycache__/`、`.pytest_cache/` 等运行时内容。归档数据库和本机状态不属于插件发布物。

当前兼容版本首次启动时，会把每个 Profile 的旧目录
`<profile-home>/plugins/yaoyao/data` 原子迁移到
`<profile-home>/plugin-data/yaoyao`。后者独立于插件安装树，后续通过 Hermes
插件接口替换 `plugins/yaoyao` 时不会丢失运行数据。若两个目录同时包含数据，
插件不会自动合并，运行时仍只读取 `plugin-data/yaoyao`；应人工核对后移出旧目录，
最终只保留这一权威数据目录。

完成这次兼容版本启动后，后续可在已登录的 8800 会话中调用：

```http
POST /api/app/plugins/yaoyao/install
Content-Type: application/json

{"force":true}
```

默认安装源是
`https://git.samien.cn/samien/hermes-yaoyao.git#hermes-plugins/yaoyao`，可由服务端
环境变量 `HERMES_YAOYAO_PLUGIN_SOURCE` 覆盖。接口不接受请求体覆盖仓库地址，
并会在调用 9119 的通用安装接口前检查持久数据迁移状态。

## 3. 由 8800 服务担任唯一 Dashboard 监督者

插件文件只有在 Dashboard 重载后才会生效。安装本项目的受管服务后，8800 服务是 Dashboard 的唯一持续监督者；不要保留其他 Dashboard LaunchAgent 或手动常驻进程。

| Dashboard 情况 | 正确做法 | 禁止做法 |
| --- | --- | --- |
| 需要让新插件生效 | 执行 `hermes dashboard --stop`，等待 8800 监督器在 5 秒内自动启动 | 另起常驻 `hermes dashboard` 进程 |
| 9119 未监听 | 等待 8800 监督器自动启动；检查其日志 | 手动重复启动多个 Dashboard |

## 4. 显式启用夭夭 Dashboard 插件

夭夭位于用户插件目录，Dashboard 会先发现其 `manifest.json`，但不会自动执行用户提供的 JavaScript 或 Python 代码。只有插件名同时满足 `plugins.enabled` 包含 `yaoyao` 且未出现在 `plugins.disabled` 中时，Dashboard 才会展示夭夭标签、提供静态资源并挂载 `/api/plugins/yaoyao/`。

先读取当前列表：

```bash
hermes config get plugins.enabled
```

当列表为空时，设置唯一的启用项：

```bash
hermes config set plugins.enabled '["yaoyao"]'
```

如果列表已有其他插件名，必须保留它们并在同一 JSON 列表中加入 `yaoyao`；不要以该示例覆盖已有启用项。随后执行：

```bash
hermes dashboard --stop
```

8800 监督器会在下一轮检查中自动重新启动 9119。不要补充 `hermes dashboard --no-open`，否则可能与监督器竞争端口。

验证时使用 Dashboard 专用清单，而不是通用 `hermes plugins list`：

```bash
curl --noproxy '*' --fail --silent http://127.0.0.1:9119/api/dashboard/plugins
tail -n 100 ~/.hermes/logs/gui.log
```

验收条件：清单包含 `"name":"yaoyao"`，日志包含 `Mounted plugin API routes: /api/plugins/yaoyao/`。匿名请求 `/api/plugins/yaoyao/...` 返回 `401` 是认证生效的信号，不表示插件加载失败。

## 5. 验证插件和 Dashboard

```bash
hermes dashboard --status
lsof -nP -iTCP:9119 -sTCP:LISTEN
```

验收条件：Dashboard 状态正常，且只有一个 `9119` TCP 监听器。插件路由位于 `/api/plugins/yaoyao/`，该 API 需要现有 Hermes 登录会话；不要为了探测路由而关闭认证。独立运行的 Dashboard 默认保持本机监听；通过夭夭受管服务安装时则跟随 8800 默认监听局域网。

## 6. 可选：部署夭夭 Web

夭夭 Web 默认使用端口 `8800` 并连接 Dashboard `9119`。通过 LaunchAgent 安装后，8800 与受监督的 9119 都默认监听 `0.0.0.0`；8800 停止或卸载时不会主动停止正在运行的 Dashboard。

```bash
npm ci
npm run build
node bin/hermes-yaoyao.mjs service install
node bin/hermes-yaoyao.mjs service status
```

若需要显式指定 Dashboard 上游，只在安装服务前设置 `HERMES_YAOYAO_UPSTREAM`。默认值为 `http://127.0.0.1:9119`，因为 8800 仍通过本机回环访问受监督的 9119。受管升级会迁移旧版 `127.0.0.1/0` 环境并继续使用局域网监听。

受管服务的配置被写入 `~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist`。任何监听、TLS、上游或监督配置变更后，都要再次执行 `service install`，随后确认状态、两个监听器和日志：

```bash
node bin/hermes-yaoyao.mjs service status
lsof -nP -iTCP:8800 -sTCP:LISTEN
lsof -nP -iTCP:9119 -sTCP:LISTEN
tail -n 100 ~/Library/Logs/hermes-yaoyao.log
```

若 `launchctl bootstrap` 报 `Bootstrap failed: 5: Input/output error`，先验证 plist，再使用已验证的兼容回退加载同一份文件：

```bash
plutil -lint ~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist
launchctl load -w ~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist
```

### 推送状态 v2 与 Android FCM

Web `0.2.16` 及后续版本会在首次写入时把 `$HERMES_YAOYAO_HOME/push/state.json` 从 schema 1
迁移为 schema 2；已有 APNs 安装、待发送队列、团队订阅、事件去重、游标和聊天恢复
任务都会保留。旧版 Web 不能直接读取 schema 2，因此升级前必须备份整个 `push/`
目录；若回滚 Web，也要同步恢复这份升级前备份，不能只切换 `current` 符号链接。

Android FCM 的服务账号 JSON 必须位于发布目录和 Git 仓库之外，权限建议为 `0600`。
可在 8800“系统管理 → Android 消息推送”填写其绝对路径、Firebase Project ID 和
固定包名 `cn.samien.yaoyao.hermes`。使用环境变量管理时配置以下三项并重新执行
`service install`；任一项出现时三项都必须有效，Web 界面只读：

```bash
HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE=/absolute/path/to/firebase-service-account.json \
HERMES_YAOYAO_FCM_PROJECT_ID=your-firebase-project-id \
HERMES_YAOYAO_FCM_PACKAGE_NAME=cn.samien.yaoyao.hermes \
node bin/hermes-yaoyao.mjs service install
```

服务账号文件、OAuth Token、FID 和 Android 的 `google-services.json` 都不得进入
Git、发布目录、命令输出或日志。配置后检查系统管理中的 APNs/FCM 独立状态；一方
未配置或失败不能使另一方停止。

## 7. 通过受管服务进行配套升级

首次按第 6 步安装 Web `0.2.19` 后，可在左下角 Agent 菜单打开“系统更新”。
检查更新只读取固定的 `HERMES_YAOYAO_RELEASE_SOURCE`，并锁定最新 `vX.Y.Z`
标签解析到的 Git 提交；执行升级前仍会检查插件持久目录是否安全。

升级任务由 8800 外部的独立 updater 执行。运行文件会安装到
`~/.local/share/hermes-yaoyao/releases/`，LaunchAgent 改为指向稳定的
`current` 符号链接。切换期间 8800 和 9119 会短暂不可用，任务状态保存在
`~/.hermes-yaoyao/updates/`，新服务启动后可继续读取。

默认只能从目标 Mac 本机触发“升级”和“回滚”；仅当用户明确允许远程系统管理
时，才在重新安装 LaunchAgent 前设置 `HERMES_YAOYAO_ALLOW_REMOTE_UPDATE=1`。
Docker 和其他非 macOS 部署必须替换镜像，不能调用服务内升级接口。

升级成功后至少验证：

```bash
curl --noproxy '*' --fail --silent http://127.0.0.1:8800/healthz
curl --noproxy '*' --fail --silent http://127.0.0.1:8800/readyz
curl --noproxy '*' --fail --silent http://127.0.0.1:9119/api/dashboard/plugins
readlink ~/.local/share/hermes-yaoyao/current
```

## 8. 失败处理

1. 记录失败的命令、退出码、Dashboard 状态和 `9119` 监听信息。
2. 若插件重载失败，使用第 2 步生成的 `$BACKUP_DIR` 恢复到 `$PLUGIN_DIR`，执行 `hermes dashboard --stop`，再由 8800 监督器重启 Dashboard。
3. 若插件文件存在但未显示，先检查 `plugins.enabled` 是否包含 `yaoyao`，再检查 `/api/dashboard/plugins` 和 `gui.log`；不要通过重复复制目录或禁用认证来“尝试修复”。
4. 不要通过多次执行 `hermes dashboard --no-open`、重复安装 LaunchAgent 或停止无关 Gateway 来“尝试修复”。这些操作会掩盖真正错误，或产生重复监听进程。

版本不匹配、没有可用备份或无法确认 Dashboard 所有者时，停止自动化流程并报告，而不是猜测或覆盖现有安装。
