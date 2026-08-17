# 夭夭 Web

夭夭 Web 是一个独立的本地 Web 工作台，通过端口 `8800` 连接现有 Hermes Dashboard/Gateway `9119`，提供普通聊天、群聊、文件库和产物浏览。它不会启动、停止或监督 Hermes。

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
