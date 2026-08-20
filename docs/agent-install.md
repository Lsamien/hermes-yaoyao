# 夭夭 Agent 安装手册

适用于需要部署或升级夭夭 Web 与 Hermes Dashboard 插件的自动化 Agent。

## 发布版本

| 项目 | 版本 | 校验位置 |
| --- | --- | --- |
| Git 发布标签 | `v0.1.0` | `git describe --tags --exact-match HEAD` |
| 夭夭 Web | `0.1.0` | `package.json` 的 `version` |
| Hermes Dashboard 插件 | `1.6.1` | `hermes-plugins/yaoyao/dashboard/manifest.json` 的 `version` |

以下步骤以仓库根目录为工作目录。不要使用浮动分支替代发布标签。

## 网络默认值与局域网策略

默认情况下，两个服务都**不开启局域网访问**。受管 8800 服务启用局域网时，会将两个端口一起开放：

| 端口 | 服务 | 默认监听地址 | 开启局域网的责任边界 |
| --- | --- | --- | --- |
| `9119` | Hermes Dashboard | `127.0.0.1` | 由 8800 服务持续监督；无配置时创建 `admin/admin` 认证并启动 |
| `8800` | 夭夭 Web | `127.0.0.1` | 显式设置 `HERMES_YAOYAO_HOST=0.0.0.0` 后与 9119 一起开放 |

最小暴露策略是保持两个端口仅本机监听。受管服务不支持“仅开放 8800”：用户明确允许局域网后，它会同时以局域网地址启动 8800 和 9119。

若用户明确要求开放可信局域网 HTTP，Agent 必须在安装或重启夭夭 Web 前设置：

```bash
export HERMES_YAOYAO_HOST=0.0.0.0
export HERMES_YAOYAO_ALLOW_INSECURE_LAN=1
```

生产环境优先设置 `HERMES_YAOYAO_TLS_CERT` 和 `HERMES_YAOYAO_TLS_KEY`。该开关会将受管 9119 一起绑定至 `0.0.0.0`；`hermes dashboard --insecure` 不会关闭认证，不能将它当成局域网开关。

## 受管 9119 的默认认证与持续监督

夭夭 Web LaunchAgent 默认启用 `HERMES_YAOYAO_SUPERVISE_DASHBOARD=1`。它每 5 秒检查本机 `9119`；端口未监听时会启动 Dashboard。首次发现 `dashboard.basic_auth` 未配置时，它会写入下列默认认证并重启 Dashboard 载入配置：

| 项目 | 默认值 |
| --- | --- |
| 用户名 | `admin` |
| 密码 | `admin` |
| 密码存储 | `password_hash` scrypt 哈希，不保存明文 |
| 会话签名密钥 | 首次配置时随机生成 |

`admin/admin` 是发布要求的已知默认凭据，不适合长期使用。首次登录后，管理员必须用 Hermes 配置替换该账号或密码，并重启 8800 服务，让监督器加载新的认证配置。监督器只会填补缺失的用户名、密码和会话签名密钥，绝不会覆盖已有的用户名、密码哈希、密码或密钥。

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
RELEASE_VERSION=v0.1.0
git fetch --tags
git checkout "$RELEASE_VERSION"

test "$(git describe --tags --exact-match HEAD)" = "$RELEASE_VERSION"
test "$(node -p \"require('./package.json').version\")" = "0.1.0"
test "$(node -e \"console.log(require('./hermes-plugins/yaoyao/dashboard/manifest.json').version)\")" = "1.6.1"
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
test "$(node -e \"console.log(require(process.argv[1]).version)\" "$PLUGIN_DIR/manifest.json")" = "1.6.1"
```

`rsync --delete` 的范围严格限于 `$PLUGIN_DIR`，不会删除其他 Hermes 插件或用户数据。若目标目录已有额外的本机定制文件，应先将其移出目录或改用不带 `--delete` 的同步命令。

不要提交、复制或恢复 `data/`、`__pycache__/`、`.pytest_cache/` 等运行时内容。归档数据库和本机状态不属于插件发布物。

## 3. 由 8800 服务担任唯一 Dashboard 监督者

插件文件只有在 Dashboard 重载后才会生效。安装本项目的受管服务后，8800 服务是 Dashboard 的唯一持续监督者；不要保留其他 Dashboard LaunchAgent 或手动常驻进程。

| Dashboard 情况 | 正确做法 | 禁止做法 |
| --- | --- | --- |
| 需要让新插件生效 | 执行 `hermes dashboard --stop`，等待 8800 监督器在 5 秒内自动启动 | 另起常驻 `hermes dashboard` 进程 |
| 9119 未监听 | 等待 8800 监督器自动启动；检查其日志 | 手动重复启动多个 Dashboard |

## 4. 验证插件和 Dashboard

```bash
hermes dashboard --status
lsof -nP -iTCP:9119 -sTCP:LISTEN
```

验收条件：Dashboard 状态正常，且只有一个 `9119` TCP 监听器。插件路由位于 `/api/plugins/yaoyao/`，该 API 需要现有 Hermes 登录会话；不要为了探测路由而关闭认证。除非用户明确授权且已配置对应生命周期所有者，否则保持 `9119` 仅本机监听。

## 5. 可选：部署夭夭 Web

夭夭 Web 默认监听 `8800` 并连接 Dashboard `9119`。通过 LaunchAgent 安装后，它持续监督 Dashboard `9119`，但在自身停止或卸载时不会主动停止正在运行的 Dashboard。

```bash
npm ci
npm run build
node bin/hermes-yaoyao.mjs service install
node bin/hermes-yaoyao.mjs service status
```

若需要显式指定 Dashboard 上游，只在安装服务前设置 `HERMES_YAOYAO_UPSTREAM`。默认值为 `http://127.0.0.1:9119`。只有用户明确要求时才允许局域网：设置 `HERMES_YAOYAO_HOST=0.0.0.0` 和 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1`；受管服务会同时将 9119 绑定至 `0.0.0.0`。

## 6. 失败处理

1. 记录失败的命令、退出码、Dashboard 状态和 `9119` 监听信息。
2. 若插件重载失败，使用第 2 步生成的 `$BACKUP_DIR` 恢复到 `$PLUGIN_DIR`，执行 `hermes dashboard --stop`，再由 8800 监督器重启 Dashboard。
3. 不要通过多次执行 `hermes dashboard --no-open`、重复安装 LaunchAgent 或停止无关 Gateway 来“尝试修复”。这些操作会掩盖真正错误，或产生重复监听进程。

版本不匹配、没有可用备份或无法确认 Dashboard 所有者时，停止自动化流程并报告，而不是猜测或覆盖现有安装。
