# 夭夭 Web

夭夭 Web 是一个独立的本地 Web 工作台，通过端口 `8800` 连接 Hermes Dashboard/Gateway `9119`，提供普通聊天、群聊、文件库和产物浏览。通过本项目安装的 LaunchAgent 会持续监督本机 `9119`：缺失时在 `127.0.0.1` 启动它，不自动写入账号密码，也不重启或重绑定已有服务。

## 8800 用户与 iOS

8800 拥有独立于 9119 的用户机制。首次安装会创建管理员 `admin/admin`，首次登录
必须修改凭据。管理员可在“系统管理”中创建、禁用、删除普通用户和重置临时密码。
所有 8800 用户共享本机 9119 的 Bots、历史、团队和文件；普通用户不能管理用户、
节点、插件或系统升级。

iOS/Web 连接 `http://主机:8800` 并使用 8800 用户登录，客户端实时接口仅支持 HTTP+SSE。
从 v0.2.27 起，旧客户端 WebSocket、票据和租约接口已移除；iOS 必须同步更新到 HTTP+SSE 版本。
9119 和 8800 都可管理由 8800 签发配对码的直接子节点，节点不会递归暴露孙节点。
已登录 Web 用户还可在“手机登录与节点”中生成两分钟有效的一次性登录二维码；iOS
登录页扫描后会把 8800 保存为普通服务器账号。`yaoyao://login` 登录码与
`yaoyao://pair` 子节点码相互独立，不会把手机误登记为子节点。

8800 直连 `127.0.0.1`（或 `::1`），且 9119 明确声明 `auth_required=false` 时，
使用 Hermes 签发的本机临时会话令牌，无需配置 9119 用户名密码。令牌仅保存在服务端内存，
不返回客户端；REST 和上游 WebSocket 均携带该凭据。远程或已开启账号鉴权的 9119
仍使用独立服务账号，可在“系统管理”中配置，或设置
`HERMES_YAOYAO_UPSTREAM_USERNAME` 和 `HERMES_YAOYAO_UPSTREAM_PASSWORD_FILE`。
`localhost`、Docker 宿主机别名和转发头不作为本机授权依据；详见 [本机授权边界](docs/loopback-authorization.md)。

### iOS 后台消息推送

iOS 在线时使用 8800 的 SSE 实时接收消息；App 被挂起或未运行时，8800
可作为 APNs Provider 发送系统通知。推送设备与当前 8800 用户绑定，普通聊天只提醒
该用户经 8800 发起的任务；团队在用户首次发言后自动订阅，也可在团队页关闭。

在 Apple Developer 中为 `cn.samien.yaoyao.hermes` 开启 Push Notifications 并创建
Token Key，把下载的 `.p8` 保存在仓库外、权限设为 `0600`，然后为 8800 配置：

```bash
export HERMES_YAOYAO_APNS_KEY_FILE=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
export HERMES_YAOYAO_APNS_KEY_ID=XXXXXXXXXX
export HERMES_YAOYAO_APNS_TEAM_ID=GMU6W5FKQ6
export HERMES_YAOYAO_APNS_TOPIC=cn.samien.yaoyao.hermes
```

前三项必须同时存在；缺失或无效时聊天服务仍会启动，iOS 自动保留原有本地通知降级。
管理员可在“系统管理 → iOS 消息推送”查看配置、注册设备和待发送数量，页面与日志均
不会显示 `.p8` 内容或 device token。Docker 部署需要把 `.p8` 只读挂载到容器，并让
`HERMES_YAOYAO_APNS_KEY_FILE` 指向容器内绝对路径。APNs 只要求 8800 能主动访问
Apple，不需要把 8800 暴露到公网；手机访问 8800 仍应优先使用 HTTPS 或 Tailscale。

未设置任何 `HERMES_YAOYAO_APNS_*` 环境变量时，管理员也可以在“系统管理 → iOS
消息推送”填写 **8800 所在机器上的 `.p8` 绝对路径**、Key ID、Team ID、Topic 及启用
环境，然后点击“验证并启用”。私钥内容不会经过浏览器；8800 会本地读取 P-256 密钥、
探测所选 APNs 环境，再把路径和元数据原子保存到
`$HERMES_YAOYAO_HOME/push/apns-config.json`（权限 `0600`）并立即热加载。密钥文件权限
宽于 `0600` 只显示安全建议，不会阻止启用。任一 APNs 环境变量存在时仍以环境变量为准，
Web 界面只读，避免两个配置源互相覆盖。

### Android 后台消息推送

Android 使用 FCM HTTP v1 的高优先级 data-only 消息；通知标题、摘要、去重 `eventId`
和更新用 `collapseId` 由 App 统一处理。FCM 与 APNs 是两个独立 provider：任一方配置或
发送失败都不会停用另一方，团队订阅、事件去重和后台任务恢复继续共用同一份持久状态。

在 Firebase 项目中注册包名 `cn.samien.yaoyao.hermes`，为专用服务账号授予发送 FCM
消息所需的最小权限。把服务账号 JSON 保存在仓库外、权限设为 `0600`，然后配置：

```bash
export HERMES_YAOYAO_FCM_SERVICE_ACCOUNT_FILE=/absolute/path/to/firebase-service-account.json
export HERMES_YAOYAO_FCM_PROJECT_ID=your-firebase-project-id
export HERMES_YAOYAO_FCM_PACKAGE_NAME=cn.samien.yaoyao.hermes
```

也可以在“系统管理 → Android 消息推送”填写 8800 所在机器上的 JSON 绝对路径、Project
ID 和包名。浏览器只提交路径和公开元数据；8800 本地校验 RSA 凭据，并通过
`validate_only` 发送探测确认该账号对目标项目具有消息权限，然后把路径和元数据原子保存到
`$HERMES_YAOYAO_HOME/push/fcm-config.json`。配置文件不会复制 JSON 私钥或设备 FID。
任一 `HERMES_YAOYAO_FCM_*` 环境变量存在时，Web 界面保持只读。Docker 部署时需把服务
账号文件只读挂载到容器，并允许 8800 主动访问 Google OAuth 与 FCM HTTP v1 端点。

仓库同时归档了夭夭的 Hermes Dashboard 插件，位于
[`hermes-plugins/yaoyao/dashboard`](hermes-plugins/yaoyao/dashboard)。Web 工作台和该插件是两个独立部署单元：前者运行在 `8800`，后者由已运行的 Hermes Dashboard 在 `9119` 加载。

插件根目录同时提供 Hermes 标准 `plugin.yaml`，可通过 Dashboard 的 Git
插件安装接口安装。默认源为
`https://git.samien.cn/samien/hermes-yaoyao.git#hermes-plugins/yaoyao`。

当前发布版本：**Git `v0.2.29` / 夭夭 Web `0.2.29` / Hermes Dashboard 插件 `1.7.3`**。版本组合由仓库根目录的 `release.json` 唯一声明，并由 `npm run release:verify` 校验。

本版让 8800 自动兼容 9119 的本机 Session Token、密码认证和旧版本机直连模式，并在设置中明确展示认证模式、连接地址、验证时间以及 8800/9119 各自的网络边界。9119 可保持仅本机监听，8800 继续面向局域网提供服务。

普通聊天和团队事件继续使用 [HTTP+SSE 接口](docs/http-sse-realtime.md)，不兼容旧客户端 WebSocket。8800 到 9119 的上游接口及 Python 插件保持不变。

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

安装、覆盖、启用和加载均由 9119 自身处理；8800 不重启 9119，也不读写 Hermes
插件目录。登录 Web 后还会比较发布清单与 9119 的实际插件版本，落后时自动通过
同一接口更新。

### Web 独立升级

macOS 受管服务可在左下角 Agent 菜单中打开“系统更新”。Git 发布标签负责 Web
版本，`release.json` 同时声明兼容的插件版本；插件本身始终通过 9119 独立同步。

升级接口固定读取 `HERMES_YAOYAO_RELEASE_SOURCE`，只接受发布源中最新的
`vX.Y.Z` 标签，并在下载后核对标签解析出的 Git 提交和发布清单。浏览器不能传入
仓库地址或任意提交。所有更新接口都要求 8800 本地管理员登录，写接口仍受 Origin 和 CSRF 保护；默认还要求
请求来自本机，可通过 `HERMES_YAOYAO_ALLOW_REMOTE_UPDATE=1` 明确允许远程管理。

首次成功升级会把运行文件迁入：

```text
~/.local/share/hermes-yaoyao/
├── releases/<版本>-<提交>/
└── current -> releases/<版本>-<提交>
```

检查、执行、查询任务和回滚 Web 都不连接 9119，也不会先检测或更新插件。
9119 离线、响应超时、认证失败或插件版本落后均不阻止 Web 升级；Git 发布源仍需可访问。
登录初始化最多等待上游 3 秒，超时后仍可进入设置管理和更新 Web。
独立 updater 只下载、构建和切换 Web 的 `current`，不会停止 9119、调用 `hermes config` 或读写
`HERMES_HOME`。升级和回滚只用 `/healthz` 验证 Web 自身；`/readyz` 保留上游连通性诊断，
不参与升级成败判定。Web 验证失败时只回滚 Web；插件由 9119 恢复后独立同步。
用户数据始终留在 `~/.hermes-yaoyao` 和
`~/.hermes/plugin-data/yaoyao`，不进入版本目录。

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

插件 `1.7.3` 与当前 Web 服务共同提供 Hermes 节点配对。每台参与设备都需要安装相同版本的夭夭插件并运行 Web 服务：

1. 在目标 Hermes 的夭夭 Web 左下角打开“手机登录与节点”。
2. 生成两分钟有效、只能使用一次的“子节点配对二维码”。
3. 在夭夭 iOS 的“设置 → 远程节点”中扫描；节点的 Agent 名称、头像和文件访问权限会随配对一起注册到当前父服务器。
4. 扫描后，该节点的 Bots、普通聊天历史和 Agent Profile 会按节点身份加入手机；同名 Profile 使用 `nodeId + profile` 区分。

二维码不包含账号密码、长期 Token 或 Dashboard Cookie。Web 服务会签发可撤销的设备 Token，并把代理所需的 Dashboard Cookie 加密保存在 `HERMES_YAOYAO_HOME`。iOS Token 按服务器账号保存在系统 Keychain。忘记 iOS 中的节点或在 Web 中撤销设备都会终止后续访问。

当前免密扫码签发要求 Hermes 启用 `basic` 密码 provider，以便为每台手机建立彼此独立、可单独刷新的上游会话；不会复制浏览器正在轮换的 refresh Cookie。仅启用 OAuth/SSO 的安装仍可在 iOS 中使用手动“添加服务器账号”，等待 Hermes 提供适合移动回调的原生授权方式。

原生群聊由房主 Hermes 保存权威房间、话题和消息。扫码时，iOS 会把远端节点以加密凭据注册到房主插件；房主通过远端 `nodeWorker` 执行 Session，并转发流式事件、审批、澄清、中断和受限群聊附件。房主工作目录不会作为远端绝对路径使用，远端 Agent 默认采用自己的工作区。

免密配对和跨节点执行应使用 HTTPS 或 Tailscale。受管安装会显式设置 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1`，因此默认 HTTP 监听只适合可信局域网；不要把二维码或配对凭据发送给不受信任的人。

## 网络暴露：9119 与 8800 分别控制

通过 `service install` 安装的受管服务默认只开放夭夭 Web `8800` 到可信局域网；新启动的 Hermes Dashboard `9119` 仅监听回环。手动 `npm start` 与 Docker 部署仍保留各自的绑定默认值。

| 端口 | 服务 | 默认 | 单独开启局域网 |
| --- | --- | --- | --- |
| `9119` | Hermes Dashboard | `127.0.0.1` | 不自动开放；已有服务保持原配置，远程服务必须启用鉴权 |
| `8800` | 夭夭 Web | `0.0.0.0` | LaunchAgent 显式启用可信局域网 HTTP |

夭夭 Web 默认上游仍是 `http://127.0.0.1:9119`；客户端只连接 8800。监督器仅管理此本机 HTTP 端口，不替外部上游启动本机 Dashboard。

受管 `service install` 会覆盖 8800 遗留的 loopback 环境并保持 8800 局域网监听。若 8800 也必须仅本机访问，请使用手动 `npm start` 或 Docker 的回环绑定，不要使用受管 LaunchAgent。

默认局域网 HTTP 只适合可信网络。跨不受信网络使用时必须配置 `HERMES_YAOYAO_TLS_CERT` 和 `HERMES_YAOYAO_TLS_KEY`，并限制防火墙或反向代理访问范围。

受管服务不创建或修改 `dashboard.basic_auth`。已有密码配置不会被删除；若 9119
仍要求账号鉴权，需在 8800 配置服务账号，不会自动降级成免账号模式。
8800 本地管理员 `admin/admin` 首次登录强制修改。具体步骤见
[Agent 安装手册](docs/agent-install.md#受管-9119-的默认认证与持续监督)。
Dashboard 的 `--insecure` 参数不会关闭认证；不要并行安装其他 Dashboard 监督器。

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

Docker 镜像运行时只启动本项目的夭夭 Web，不监督或重启 Hermes Dashboard。
`9119` 必须已经由项目外部的 Hermes 实例提供；Compose 会强制关闭
`HERMES_YAOYAO_SUPERVISE_DASHBOARD`。用户登录 Web 后，8800 会通过 9119 的
插件安装接口自动补齐落后的夭夭插件，不会直接操作 Hermes 容器或数据卷。为支持
离线部署，镜像仍携带 `/opt/hermes-yaoyao-plugin/dashboard` 作为手动安装材料。

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

如需经可信局域网或反向代理访问，可将 `HERMES_YAOYAO_BIND_ADDRESS` 改为 `0.0.0.0`。首次使用外网域名或公网 IP 前，可先从 `localhost:8800` 进入“设置中心 → Hermes 连接 → 外网访问地址”添加；也可继续通过 `HERMES_YAOYAO_ALLOWED_HOSTS` 配置，环境变量地址会与 Web 设置合并。Compose 内部的 8800 使用 HTTP；对非可信网络发布时，应在容器前配置 HTTPS 反向代理，不要直接把 8800 暴露到公网。

停止或升级不会删除运行数据：

```bash
docker compose --env-file docker.env down
docker compose --env-file docker.env up -d --build
```

只有显式执行 `docker compose down --volumes` 才会删除夭夭 Web 的命名卷。在线
环境会在登录后通过 9119 自动更新插件；下方手动步骤仅用于离线安装或旧插件缺少
安全迁移接口的兼容处理。

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

`service install` 会写入并启动 `com.samien.hermes-yaoyao` LaunchAgent；8800 默认监听局域网，新启动的受监督 9119 仅监听回环。已安装服务的环境变量写入 plist，因此改变监听地址、TLS 或监督开关后需要再次执行 `service install`，仅执行 `service start` 不会刷新这些配置。

| 目标 | 命令 | 预期结果 |
| --- | --- | --- |
| 查看服务 | `node bin/hermes-yaoyao.mjs service status` | `com.samien.hermes-yaoyao` 为 running |
| 查看 Web | `curl --noproxy '*' --fail --silent http://127.0.0.1:8800/` | 返回夭夭 Web 页面 |
| 查看 Dashboard | `curl --noproxy '*' --fail --silent http://127.0.0.1:9119/api/status` | 查看 `auth_required`；`false` 表示本机令牌模式 |
| 查看监听器 | `lsof -nP -iTCP:8800 -sTCP:LISTEN` 与 `lsof -nP -iTCP:9119 -sTCP:LISTEN` | 每个端口恰好一个监听进程 |
| 查看受管日志 | `tail -f ~/Library/Logs/hermes-yaoyao.log` | 记录 Web 监听和 Dashboard 监督事件 |

在部分 macOS 环境中，`service install` 内部的 `launchctl bootstrap` 可能返回 `Bootstrap failed: 5: Input/output error`。先验证 plist 再使用等效兼容回退，不要重复创建服务：

```bash
plutil -lint ~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist
launchctl load -w ~/Library/LaunchAgents/com.samien.hermes-yaoyao.plist
node bin/hermes-yaoyao.mjs service status
```

手动以 `npm start` 运行时，`HERMES_YAOYAO_SUPERVISE_DASHBOARD` 默认关闭；如需让该进程监督 Dashboard，请显式设置为 `1`。生产环境优先使用上述 LaunchAgent，避免两个进程同时管理 `9119`。
