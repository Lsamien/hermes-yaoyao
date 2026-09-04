# 部署夭夭 Web

## 前提

- Node.js 24。
- 可访问的 Hermes Dashboard/Gateway（通常为 9119），支持会话创建、恢复、提示词提交、附件及审批 RPC。
- 不需要 Yaoyao 插件，不会修改外部 Hermes 的插件目录或重启外部 Hermes。

## 源码安装

在仓库执行 `npm ci`、`npm run build`，然后执行 `npm start`。Web 默认监听 `127.0.0.1:15300`。

上游地址由 `HERMES_YAOYAO_UPSTREAM` 配置。远端凭据在 Web 系统设置中保存。需要环境配置时使用 `HERMES_YAOYAO_UPSTREAM_USERNAME` 和 `HERMES_YAOYAO_UPSTREAM_PASSWORD`，不要把凭据嵌入 URL。

首次打开 Web 时创建管理员账号和至少 8 位的密码。服务不会生成固定的默认账号或密码；iOS 使用 Web 账号或手机登录二维码。

## 局域网与容器

局域网部署可设置 `HERMES_YAOYAO_HOST=0.0.0.0` 和 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1`，并在 `HERMES_YAOYAO_ALLOWED_HOSTS` 中列入访问地址。公网部署配置 TLS。

容器保持 `HERMES_YAOYAO_SUPERVISE_DASHBOARD=0`，使用外部 Hermes 上游。数据目录 `/var/lib/hermes-yaoyao` 必须持久化；无需挂载 Hermes 文件系统或 Docker socket。

## 验收

- `/healthz` 检查 Web 自身；`/readyz` 检查 Hermes 上游。
- 登录后 `/api/app/capabilities` 声明新聊天功能。
- 创建角色、发送消息、上传并下载附件、创建固定成员群聊。
- 用同一账号在 iOS 和 Web 查看相同历史；另一账号看不到这些聊天。
- 全过程不应访问 `/api/plugins/yaoyao/`、插件安装或插件升级接口。

## 数据和发布

备份整个 `HERMES_YAOYAO_HOME`，包含 SQLite、上传与归档文件、用户凭据和密钥。正常的数据库持久化不依赖旧插件存储维护工具。

本次升级不迁移旧数据。旧插件及数据文件保留在原处，不自动卸载或删除。首次切换整体部署新 Web 和 iOS；此后只升级 Web 自身版本。
