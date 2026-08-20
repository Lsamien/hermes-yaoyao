# 夭夭 Web

夭夭 Web 是一个独立的本地 Web 工作台，通过端口 `8800` 连接现有 Hermes Dashboard/Gateway `9119`，提供普通聊天、群聊、文件库和产物浏览。它不会启动、停止或监督 Hermes。

仓库同时归档了夭夭的 Hermes Dashboard 插件，位于
[`hermes-plugins/yaoyao/dashboard`](hermes-plugins/yaoyao/dashboard)。Web 工作台和该插件是两个独立部署单元：前者运行在 `8800`，后者由已运行的 Hermes Dashboard 在 `9119` 加载。

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

安装后重启 Dashboard，使运行中的 `9119` 进程重新加载插件：

```bash
hermes dashboard --stop
hermes dashboard --no-open
```

通过状态命令确认 Dashboard 已恢复运行：

```bash
hermes dashboard --status
```

若 Hermes 由 LaunchAgent、服务管理器或其他外部监督器启动，请使用该监督器重启 Dashboard，而不是同时手动执行 `hermes dashboard --no-open`，以免产生重复监听进程。

插件的归档数据与运行状态仍位于 Hermes 数据目录中，不在此仓库的 `hermes-plugins/` 中；升级插件前的备份也不应提交到 Git。

## 开发

```bash
npm install
cp .env.example .env
npm run dev
```

默认上游是 `http://127.0.0.1:9119`，服务默认只监听本机。局域网 HTTP 只适用于可信网络，必须同时设置：

```bash
HERMES_YAOYAO_HOST=0.0.0.0
HERMES_YAOYAO_ALLOW_INSECURE_LAN=1
```

生产局域网使用建议同时配置 `HERMES_YAOYAO_TLS_CERT` 和 `HERMES_YAOYAO_TLS_KEY`。

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
