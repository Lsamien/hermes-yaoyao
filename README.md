# 夭夭 Web

夭夭 Web 是一个独立的本地 Web 工作台，通过端口 `8800` 连接 Hermes Dashboard/Gateway `9119`，提供普通聊天、群聊、文件库和产物浏览。通过本项目安装的 LaunchAgent 会持续监督 `9119`：缺失时自动配置 Dashboard 认证并启动它。

仓库同时归档了夭夭的 Hermes Dashboard 插件，位于
[`hermes-plugins/yaoyao/dashboard`](hermes-plugins/yaoyao/dashboard)。Web 工作台和该插件是两个独立部署单元：前者运行在 `8800`，后者由已运行的 Hermes Dashboard 在 `9119` 加载。

插件根目录同时提供 Hermes 标准 `plugin.yaml`，可通过 Dashboard 的 Git
插件安装接口安装。默认源为
`https://git.samien.cn/samien/hermes-yaoyao.git#hermes-plugins/yaoyao`。

当前发布版本：**Git `v0.2.7` / 夭夭 Web `0.2.7` / Hermes Dashboard 插件 `1.7.2`**。版本组合由仓库根目录的 `release.json` 唯一声明，并由 `npm run release:verify` 校验。

需要由自动化 Agent 部署或升级时，请直接使用 [Agent 安装手册](docs/agent-install.md)。其中包含固定版本校验、备份、同步、单一 Dashboard 重载与验证步骤。

## 安装 Hermes Dashboard 插件

前提是目标机器已安装并可运行 Hermes。插件目录会被 Hermes 以路径加载，因此请保留下面的目录层级，不要只复制其中的 Python 文件或 `dist/`。

```text
<Hermes 数据目录>/plugins/yaoyao/dashboard/
├── manifest.json
├── plugin_api.py
├── group_plugin_api.py
└── dist/
```

默认 Hermes 数据目录是 `~/.hermes`。从本仓库根目录执行下列命令即可安装或更新插件；首次覆盖已有版本时会先创建带时间戳的备份：

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN_DIR="$HERMES_HOME/plugins/yaoyao/dashboard"

if [ -d "$PLUGIN_DIR" ]; then
  cp -a "$PLUGIN_DIR" "${PLUGIN_DIR}.backup-$(date +%Y%m%d%H%M%S)"
fi

mkdir -p "$PLUGIN_DIR"
rsync -a --delete \
  --exclude '__pycache__/' \
  --exclude '*.py[cod]' \
  --exclude '.pytest_cache/' \
  hermes-plugins/yaoyao/dashboard/ "$PLUGIN_DIR/"
```

`rsync --delete` 只会删除目标 `dashboard/` 目录中仓库未提供的旧插件文件，不会触及其他 Hermes 插件或数据；如需保留本机额外文件，请先移出该目录或不要使用 `--delete`。

安装后需显式启用夭夭插件。Dashboard 对用户目录下的插件采用默认拒绝策略：文件已复制不代表前端资源或 API 已加载。

先查看当前启用列表：

```bash
hermes config get plugins.enabled
```

若输出为 `[]`，可直接启用夭夭：

```bash
hermes config set plugins.enabled '["yaoyao"]'
```

若已有其他条目，请在保留原有插件名的前提下，将 `yaoyao` 加入同一 JSON 列表后再写回。不要只依赖 `hermes plugins list` 判断夭夭是否加载：夭夭是 Dashboard 扩展，最终应以 Dashboard 的插件清单和启动日志为准。

然后停止 Dashboard，使运行中的 `9119` 进程重新加载插件。已安装的夭夭 Web LaunchAgent 会在下一轮检查中自动按其配置重启它：

```bash
hermes dashboard --stop
```

通过状态命令、插件清单和日志确认 Dashboard 已恢复且已加载夭夭：

```bash
hermes dashboard --status
curl --noproxy '*' --fail --silent http://127.0.0.1:9119/api/dashboard/plugins
tail -n 100 ~/.hermes/logs/gui.log
```

验收时，插件清单应包含 `"name":"yaoyao"`，日志应包含 `Mounted plugin API routes: /api/plugins/yaoyao/`。夭夭 API 需要 Dashboard 登录会话，匿名请求返回 `401`、插件静态资源跳转到登录页均属预期。

若 Hermes 由 LaunchAgent、服务管理器或其他外部监督器启动，请使用该监督器重启 Dashboard；不要在 `hermes dashboard --stop` 后同时手动执行 `hermes dashboard --no-open`，以免产生重复监听进程。

插件的归档数据与运行状态仍位于 Hermes 数据目录中，不在此仓库的 `hermes-plugins/` 中；升级插件前的备份也不应提交到 Git。

### 通过 8800 安全编排 9119 安装

登录夭夭 Web 后，可以调用受登录、Origin 和 CSRF 保护的接口：

```http
POST /api/app/plugins/yaoyao/install
Content-Type: application/json

{"force":false}
```

全新安装使用 `force:false`；已安装版本升级必须明确使用 `force:true`。8800
只会把服务端配置的固定 Git 源交给 9119，不接受浏览器传入任意仓库地址。
可通过 `HERMES_YAOYAO_PLUGIN_SOURCE` 覆盖默认源，且配置中禁止嵌入用户名或
密码。

插件数据会从旧的 `<profile-home>/plugins/yaoyao/data` 一次性迁移到
`<profile-home>/plugin-data/yaoyao`。如果旧、新目录同时包含数据，安装接口会
返回 `409 yaoyao_storage_conflict`，不会覆盖任一目录；运行时仍以
`plugin-data/yaoyao` 为唯一权威目录，不会回退读取旧数据。旧版插件没有迁移检查
接口时，也会返回 `409 yaoyao_storage_migration_required`；此时先按上面的
`dashboard/` 局部同步方式安装一次当前兼容版本并重启，之后才能使用一键升级。

本机受管部署会在安装后由 8800 重启 9119；未启用 Dashboard 监督或使用远程
9119 时，响应中的 `restartRequired` 为 `true`，需要由目标环境的服务管理器
完成重启。

### Web 与插件配套升级

macOS 受管服务可在左下角 Agent 菜单中打开“系统更新”。它把一个 Git 发布标签
中的 Web 与 Dashboard 插件视为同一发布单元，版本关系来自 `release.json`。

升级接口固定读取 `HERMES_YAOYAO_RELEASE_SOURCE`，只接受发布源中最新的
`vX.Y.Z` 标签，并在下载后核对标签解析出的 Git 提交和发布清单。浏览器不能传入
仓库地址或任意提交。写接口仍受 Hermes 登录、Origin 和 CSRF 保护；默认还要求
请求来自本机，可通过 `HERMES_YAOYAO_ALLOW_REMOTE_UPDATE=1` 明确允许远程管理。

首次成功升级会把运行文件迁入：

```text
~/.local/share/hermes-yaoyao/
├── releases/<版本>-<提交>/
└── current -> releases/<版本>-<提交>
```

独立 updater 会先下载、构建和备份插件，再停止 8800 与 9119、原子切换插件和
`current`、重装 LaunchAgent，最后验证 `/healthz`、`/readyz` 和实际插件版本。
验证失败会自动恢复上一套 Web 与插件；用户数据始终留在
`~/.hermes-yaoyao` 和 `~/.hermes/plugin-data/yaoyao`，不进入版本目录。

相关接口：

```text
GET  /api/app/system/update/status
POST /api/app/system/update/check
POST /api/app/system/update/apply
GET  /api/app/system/update/jobs/:jobID
POST /api/app/system/update/rollback
```

容器和非 macOS 环境只显示版本状态，不执行服务内升级；应通过替换镜像更新。

## 开发

```bash
npm install
cp .env.example .env
npm run dev
```

## 手机扫码与跨节点 Agent

插件 `1.7.2` 与当前 Web 服务共同提供 Hermes 节点配对。每台参与设备都需要安装相同版本的夭夭插件并运行 Web 服务：

1. 在目标 Hermes 的夭夭 Web 左下角打开“手机与节点”。
2. 输入一次 Hermes 密码并生成两分钟有效、只能使用一次的二维码；密码只用于创建独立设备会话，不会保存。
3. 在夭夭 iOS 的“设置 → 服务器与账号”中选择“扫描 Hermes 节点”。
4. 扫描后，该节点的 Bots、普通聊天历史和 Agent Profile 会按节点身份加入手机；同名 Profile 使用 `nodeId + profile` 区分。

二维码不包含账号密码、长期 Token 或 Dashboard Cookie。Web 服务会签发可撤销的设备 Token，并把代理所需的 Dashboard Cookie 加密保存在 `HERMES_YAOYAO_HOME`。iOS Token 按服务器账号保存在系统 Keychain。忘记 iOS 中的节点或在 Web 中撤销设备都会终止后续访问。

当前免密扫码签发要求 Hermes 启用 `basic` 密码 provider，以便为每台手机建立彼此独立、可单独刷新的上游会话；不会复制浏览器正在轮换的 refresh Cookie。仅启用 OAuth/SSO 的安装仍可在 iOS 中使用手动“添加服务器账号”，等待 Hermes 提供适合移动回调的原生授权方式。

原生群聊由房主 Hermes 保存权威房间、话题和消息。扫码时，iOS 会把远端节点以加密凭据注册到房主插件；房主通过远端 `nodeWorker` 执行 Session，并转发流式事件、审批、澄清、中断和受限群聊附件。房主工作目录不会作为远端绝对路径使用，远端 Agent 默认采用自己的工作区。

免密配对和跨节点执行应使用 HTTPS/WSS 或 Tailscale。只有显式设置 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1` 时才应在可信局域网使用 HTTP；不要把二维码或配对凭据发送给不受信任的人。

## 网络暴露：9119 与 8800 分别控制

默认情况下，两个端口都**不开放局域网**：Hermes Dashboard `9119` 和夭夭 Web `8800` 都只监听 `127.0.0.1`。通过本项目安装的受管服务开启局域网时，两个端口会一起开放。

| 端口 | 服务 | 默认 | 单独开启局域网 |
| --- | --- | --- | --- |
| `9119` | Hermes Dashboard | `127.0.0.1` | 由夭夭 Web 受管服务监督；首次缺失配置时自动创建 `admin/admin` 登录并启动 |
| `8800` | 夭夭 Web | `127.0.0.1` | 显式设置 `HERMES_YAOYAO_HOST=0.0.0.0` 后与 9119 一起开放 |

夭夭 Web 默认上游仍是 `http://127.0.0.1:9119`。受管服务的局域网开关会同时让它监听局域网地址，并让其启动的 Dashboard `9119` 监听局域网地址。

仅在可信局域网中以 HTTP 开放受管服务时，必须同时设置：

```bash
HERMES_YAOYAO_HOST=0.0.0.0
HERMES_YAOYAO_ALLOW_INSECURE_LAN=1
```

生产局域网使用建议同时配置 `HERMES_YAOYAO_TLS_CERT` 和 `HERMES_YAOYAO_TLS_KEY`。

受管服务会在 `dashboard.basic_auth` 未配置时创建用户名 `admin`、密码 `admin` 的 scrypt 哈希和随机会话签名 `secret`。这是已知默认凭据，首次登录后必须立即修改。具体步骤见 [Agent 安装手册](docs/agent-install.md#受管-9119-的默认认证与持续监督)。Dashboard 的 `--insecure` 参数不会关闭认证；不要并行安装其他 Dashboard 监督器。

## 构建与运行

```bash
npm run build
npm start
```

服务管理命令：

```bash
node bin/hermes-yaoyao.mjs service install
node bin/hermes-yaoyao.mjs service start
node bin/hermes-yaoyao.mjs service status
node bin/hermes-yaoyao.mjs service stop
node bin/hermes-yaoyao.mjs service uninstall
```

执行 `npm link` 后也可以直接使用 `hermes-yaoyao` 命令。

运行数据默认位于 `~/.hermes-yaoyao`。卸载 LaunchAgent 不会删除运行数据。

## Docker 部署（仅夭夭 Web 8800）

Docker 镜像运行时只启动本项目的夭夭 Web，不安装或监督 Hermes Dashboard。`9119` 必须已经由项目外部的 Hermes 实例提供；Compose 会强制关闭 `HERMES_YAOYAO_SUPERVISE_DASHBOARD`，因此启动、停止或重建 Web 容器都不会操作 9119。为支持离线部署，镜像额外携带插件安装材料，位于 `/opt/hermes-yaoyao-plugin/dashboard`；它不会自行写入另一个 Hermes 容器。

复制 Docker 环境示例并启动：

```bash
cp docker.env.example docker.env
docker compose --env-file docker.env up -d --build
```

默认行为：

- 只把容器的 `8800` 发布到宿主机 `127.0.0.1:8800`；
- 通过 `http://host.docker.internal:9119` 连接宿主机已有的 Dashboard；
- 将 CSRF 密钥、设备配对信息和上传索引保存在命名卷 `hermes-yaoyao_yaoyao-data`；
- 以非 root 用户和只读根文件系统运行容器。

若本机 `8800` 已被占用，只需在 `docker.env` 中将
`HERMES_YAOYAO_PUBLISHED_PORT` 改为未占用端口（例如 `8801`），再重新执行
`docker compose --env-file docker.env up -d`。容器内服务和默认发布端口仍为
`8800`，并且 Compose 已允许通过 `localhost` 和 `127.0.0.1` 使用这个替代端口。

查看状态与日志：

```bash
docker compose --env-file docker.env ps
docker compose --env-file docker.env logs -f web
curl --fail --silent http://127.0.0.1:8800/healthz
curl --fail --silent http://127.0.0.1:8800/readyz
```

`/healthz` 只检查 8800 自身，`/readyz` 还会检查配置的 9119 是否可达。若 Dashboard 在另一台机器或另一个容器中，请在 `docker.env` 中把 `HERMES_YAOYAO_UPSTREAM` 改为容器可访问的 `http://主机:9119`；不要把账号密码写进该 URL。

Docker Desktop 会把 `host.docker.internal` 转发到宿主机。Linux 上的 `host-gateway` 只负责解析宿主机地址：如果外部 9119 仍只监听宿主机 `127.0.0.1`，桥接网络中的容器无法连接它。此时应让现有 Dashboard 在有认证和防火墙保护的前提下监听容器可达的宿主机地址，或由部署方改用经过评估的 host 网络方案；Compose 本身不会更改 9119 的监听配置。

如需经可信局域网或反向代理访问，可将 `HERMES_YAOYAO_BIND_ADDRESS` 改为 `0.0.0.0`。使用域名时还需配置 `HERMES_YAOYAO_ALLOWED_HOSTS`。Compose 内部的 8800 使用 HTTP；对非可信网络发布时，应在容器前配置 HTTPS 反向代理，不要直接把 8800 暴露到公网。

停止或升级不会删除运行数据：

```bash
docker compose --env-file docker.env down
docker compose --env-file docker.env up -d --build
```

只有显式执行 `docker compose down --volumes` 才会删除夭夭 Web 的命名卷。Dashboard 插件仍需按前文或 [Agent 安装手册](docs/agent-install.md) 独立安装到外部 Hermes 数据目录。

### Docker Hermes 容器的插件安装

`Plugin 'yaoyao' is not installed or bundled.` 表示报错的 **Hermes 容器** 的持久化目录中没有插件；重启或重建夭夭 Web 容器不会修复它。先确认 Hermes 容器把数据目录持久化到 `/root/.hermes`（或该镜像实际使用的 Hermes 数据目录）。没有持久化挂载时，`docker cp` 的内容会在 Hermes 重建后丢失。

离线镜像已加载后，用它携带的插件材料复制到 Hermes 容器。将下面的 `hermes` 替换为实际 Hermes 容器名，并按实际数据目录替换 `/root/.hermes`：

```bash
WEB_IMAGE=hermes-yaoyao:local
HERMES_CONTAINER=hermes
HERMES_HOME=/root/.hermes
SOURCE_CONTAINER=$(docker create "$WEB_IMAGE")

docker exec "$HERMES_CONTAINER" mkdir -p "$HERMES_HOME/plugins/yaoyao/dashboard"
docker cp "$SOURCE_CONTAINER":/opt/hermes-yaoyao-plugin/dashboard/. \
  "$HERMES_CONTAINER":"$HERMES_HOME/plugins/yaoyao/dashboard/"
docker rm "$SOURCE_CONTAINER"
```

随后保留现有启用列表并加入 `yaoyao`，再重启 **Hermes 容器** 使其重新发现插件。若当前没有其他用户插件，命令为：

```bash
docker exec "$HERMES_CONTAINER" hermes config set plugins.enabled '["yaoyao"]'
docker restart "$HERMES_CONTAINER"
```

若 `hermes config get plugins.enabled` 已有其他插件名，请把 `yaoyao` 合并进同一个 JSON 列表后再设置，不能用上面的示例覆盖它们。最后从 Hermes 容器或能访问其 `9119` 的位置确认插件清单包含 `"name":"yaoyao"`：

```bash
docker exec "$HERMES_CONTAINER" hermes config get plugins.enabled
curl --fail --silent http://127.0.0.1:9119/api/dashboard/plugins
```

注意：当前安全边界要求群聊上传和宿主机绝对路径媒体只用于回环地址的 Hermes 上游。默认桥接网络中的 `host.docker.internal` 不属于容器回环地址，因此这两类本地文件功能会返回明确的不可用错误；普通聊天、群聊消息、文件库 API 和产物代理不受此限制。不要通过关闭该检查来让不同机器共享本地文件路径。

## 受管服务操作与验收

`service install` 会写入并启动 `com.samien.hermes-yaoyao` LaunchAgent；它默认监督本机 `9119`。已安装服务的环境变量写入 plist，因此改变监听地址、TLS 或监督开关后需要再次执行 `service install`，仅执行 `service start` 不会刷新这些配置。

| 目标 | 命令 | 预期结果 |
| --- | --- | --- |
| 查看服务 | `node bin/hermes-yaoyao.mjs service status` | `com.samien.hermes-yaoyao` 为 running |
| 查看 Web | `curl --noproxy '*' --fail --silent http://127.0.0.1:8800/` | 返回夭夭 Web 页面 |
| 查看 Dashboard | `curl --noproxy '*' --fail --silent http://127.0.0.1:9119/api/auth/providers` | 返回基础认证 provider |
| 查看监听器 | `lsof -nP -iTCP:8800 -sTCP:LISTEN` 与 `lsof -nP -iTCP:9119 -sTCP:LISTEN` | 每个端口恰好一个监听进程 |
| 查看受管日志 | `tail -f ~/Library/Logs/hermes-yaoyao.log` | 记录 Web 监听和 Dashboard 监督事件 |

在部分 macOS 环境中，`service install` 内部的 `launchctl bootstrap` 可能返回 `Bootstrap failed: 5: Input/output error`。先验证 plist 再使用等效兼容回退，不要重复创建服务：

```bash
plutil -lint ~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist
launchctl load -w ~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist
node bin/hermes-yaoyao.mjs service status
```

手动以 `npm start` 运行时，`HERMES_YAOYAO_SUPERVISE_DASHBOARD` 默认关闭；如需让该进程监督 Dashboard，请显式设置为 `1`。生产环境优先使用上述 LaunchAgent，避免两个进程同时管理 `9119`。
