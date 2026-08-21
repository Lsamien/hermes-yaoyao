# 夭夭 Web

夭夭 Web 是一个独立的本地 Web 工作台，通过端口 `8800` 连接 Hermes Dashboard/Gateway `9119`，提供普通聊天、群聊、文件库和产物浏览。通过本项目安装的 LaunchAgent 会持续监督 `9119`：缺失时自动配置 Dashboard 认证并启动它。

仓库同时归档了夭夭的 Hermes Dashboard 插件，位于
[`hermes-plugins/yaoyao/dashboard`](hermes-plugins/yaoyao/dashboard)。Web 工作台和该插件是两个独立部署单元：前者运行在 `8800`，后者由已运行的 Hermes Dashboard 在 `9119` 加载。

当前发布版本：**Git `v0.1.0` / 夭夭 Web `0.1.0` / Hermes Dashboard 插件 `1.6.1`**。

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

## 开发

```bash
npm install
cp .env.example .env
npm run dev
```

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
