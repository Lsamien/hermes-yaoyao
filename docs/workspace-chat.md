# Web 聊天契约

## 身份和数据

`WorkspaceAgent` 引用不可变的 `(nodeId, profile)`，保存名称、头像及角色规则。`WorkspaceConversation` 为 `direct` 或 `group`；每个角色只有一个 direct，group 支持增减成员，协议不包含 topicId。角色名在用户内唯一，以便精确 @。

创建群聊选择 2～8 位成员；编辑时可以只保留管理员，最多 8 位。当前管理员不能移除，须先更换管理员并保存后再移除原管理员。新增成员必须属于当前用户且未归档。移除成员保留聊天记录及原会话，更新头像组合和提及名单，同时清理自动回复名单；进行中的回复可完成，后续接力不再调度已移除成员。

新建群聊保留原有 8 套团队预设。模板将角色分配给已创建的 Agent，`memberRoles` 以成员 ID 保存群内角色名称与职责。分工仅在对应群聊执行时加入提示词，不修改 Agent 的身份与独立规则；移除成员会同步清理分工。模板所需成员不足时，先创建足够的 Agent 再使用模板。

应用数据保存在 Web 数据目录的 `workspace.sqlite3`。每一条实体、命令和事件包含服务端用户归属。隐藏上游会话只由 WorkspaceRuntime 驱动，原生历史及 RPC 不允许直接访问。基础 Hermes Profile 的记忆和工具权限没有被复制为新的隔离运行环境。

## API

- `GET /api/app/capabilities`：协议 1 和能力。
- `GET/POST /api/app/agents`、`PATCH /api/app/agents/:id`：角色；`GET /api/app/agents/sources`：基础来源。
- `GET/POST /api/app/conversations`、`GET/PATCH /api/app/conversations/:id`：混合列表和聊天详情。创建接口仅创建群聊；创建角色自动创建单聊。
- `GET/POST /api/app/conversations/:id/messages`：历史和发送。发送需 UUID `requestId`、`content`、`mentionIds`、`fileIds`。重复编号与内容返回同一运行，内容冲突返回 409。
- `PUT /api/app/conversations/:id/read`：单调递增的已读序号。
- `POST /api/app/runs/:id/stop`、`/reconcile`：停止和核对不确定状态。
- `POST /api/app/interactions/:id/respond`：审批或澄清。
- `GET /api/app/events?after=N`：按序号读取持久化事件，最多 250 条，重连从最后序号继续。
- `POST /api/app/uploads`：multipart 上传；`GET /api/app/files` 与文件下载、预览接口：Web 归档库。
- `/api/app/nodes`：用户自己的远端节点。密码加密保存，只返回公开字段。
- `/api/app/voice/*`、`/api/app/tts/settings/*`、`/api/app/stt/settings/*`：语音设置及运行配置。
- `/api/app/session-context/:id?profile=...`：原生会话上下文快照，按观测时间拒绝倒退。

网页与 iOS 均使用相同本地账号认证。应用写入接口校验 Origin 和 CSRF；客户端先从 bootstrap 获取令牌。

## 执行

用户消息先持久化，再创建运行。每聊天一次只能有一个运行；群内按已记录的队列逐个执行。每个群成员有独立上游会话，聊天之间不复用会话。

明确 @ 优先；否则管理员模式由管理员开始，自由模式按自动回复成员开始，无人启用则由管理员响应。管理员委派后由成员执行并返回管理员；自由模式按成员 @ 接力。默认最多 3 轮，范围 1～100，达到上限即结束自动接力。引用和代码中的 @ 不触发协作。

每次成员执行前读取最新角色及群规则，附加到本次输入，不修改基础 Profile。网页和手机只展示用户原始消息，不展示执行提示词。

断开客户端不取消运行。提交丢失确认、连接中断或服务重启时，不自动重发可能已执行的请求。核对上游会话及带运行标识的历史后继续；无法核对时显示不确定状态并要求显式停止或核对。

## 退出旧插件

旧 Yaoyao API 返回 410；没有安装、reconcile、版本要求或升级流程。新数据不导入旧插件目录。旧插件数据原地保留。原生对话和可选 Kanban 继续使用各自的独立接口。
