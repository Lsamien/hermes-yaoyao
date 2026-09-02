# 设置中心 Design QA

## Findings

- 当前没有可执行的 P0、P1 或 P2 差异。
- P3：补充稿的“模型与 Provider”页包含统一保存栏，而实际 Provider 的新增、编辑、测试、设为默认和删除均是独立即时操作。实现有意不显示一个无真实提交语义的全局“保存更改”，避免误导。
- P3：账号安全补充稿本身为 `1505 × 1045`，与主设计的桌面比例不一致。实现遵循主设计的固定壳体，并让账号内容仅在右侧区域滚动；固定保存栏始终可见。

## Source visual truth

- 主视觉：`/Users/samien/.codex/generated_images/01a04b82-a660-7c43-a4d1-5c0a84482b5c/exec-9f6f7523-6cfa-418f-9103-d748e5958d68.png`
- 模型目录：`/Users/samien/.codex/generated_images/01a04b82-a660-7c43-a4d1-5c0a84482b5c/exec-b44ab548-2154-4432-944f-70b012ca9567.png`
- 账号安全：`/Users/samien/.codex/generated_images/01a04b82-a660-7c43-a4d1-5c0a84482b5c/exec-73b26de9-b178-48dd-a616-3933f87990f3.png`
- 系统概览：`/Users/samien/.codex/generated_images/01a04b82-a660-7c43-a4d1-5c0a84482b5c/exec-d8382bf2-4998-4ff8-bfd3-35d297071297.png`

源图像素尺寸依次为 `1717 × 916`、`1683 × 934`、`1505 × 1045`、`1717 × 916`。主视觉、模型和系统概览按相同比例归一到 `1637 × 874`；账号安全只作为内容层级参考，未拉伸为桌面比例。

## Implementation evidence

- 身份与头像：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/08-identity-desktop-fixed-footer.png`
- 模型与 Provider：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/11-models-desktop-final.png`
- 登录与安全：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/09-security-desktop-fixed-footer.png`
- 系统概览：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/10-overview-desktop-final.png`
- 移动端分类：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/12-mobile-menu-final.png`
- 移动端账号页：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/07-mobile-security-fixed-footer.png`

桌面实现截图与 CSS 视口均为 `1637 × 874`，`devicePixelRatio = 1`。移动端实现截图与 CSS 视口均为 `390 × 844`，`devicePixelRatio = 1`。

## Comparison evidence

- 身份全景并排：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/compare-identity.png`
- 模型密集内容并排：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/compare-models.png`
- 账号表单并排：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/compare-security.png`
- 系统概览并排：`/Users/samien/.codex/visualizations/2026/08/29/01a04b82-a660-7c43-a4d1-5c0a84482b5c/settings-center-implementation/compare-overview.png`

全景比较用于壳体、分栏、层级和整体密度；模型目录与账号表单比较作为聚焦区域，用于检查 ID、标签、字段、按钮、滚动和固定操作栏。

## Required fidelity surfaces

- 字体与排版：沿用现有 `--font-ui` 系统字体；页面标题 `23px`，导航 `14px`，正文与表单主要为 `13–16px`。标题、分组、标签和帮助文本层级与设计一致，没有截断关键 Provider ID。
- 间距与布局：桌面壳体实测 `1080 × 780`，标题栏 `64px`、左栏 `292px`、编辑页底栏 `76px`。系统概览右侧 `clientHeight = scrollHeight = 604px`；设置左栏 `clientHeight = scrollHeight = 714px`，全部导航在首屏完整可见。长表单仅滚动右内容区。
- 颜色与视觉 token：复用现有白色/暖灰表面、`--line`、`--surface-soft`、`--accent`、`--success` 和 `--danger`。选中态用浅灰，键盘焦点用紫色描边；成功与危险状态同时有文字，不只依赖颜色。
- 图像与资产：继续使用真实 `AgentAvatar` 数据和现有品牌/`AppIcon` 体系；设计没有要求新增位图资产，未使用占位图、CSS 绘图或临时 SVG 替代。
- 文案与内容：保留完整 Provider/model 目录与完整 `custom:tingly` ID；双流语音明确标记“全局”；账号、Agent 和系统作用域均在页面标题下持续显示。
- 响应式与可访问性：`390 × 844` 下设置中心为全屏导航栈，页面无横向溢出（`scrollWidth = innerWidth = 390`），分类页 `clientHeight = scrollHeight = 788px`，固定底栏为 `390 × 68`。当前分类使用 `aria-current="page"`；控制行、返回/关闭和底栏按钮命中区域达到约 `40–44px`，表单使用永久标签并保留明显焦点态。关闭后焦点实测返回 `aria-label="打开设置中心"` 的原按钮。

## Primary interactions tested

- Agent 切换弹层只显示 Agent 列表，独立设置按钮打开统一中心。
- 桌面设置导航可进入身份、模型、账号安全、系统概览、用户、Hermes 连接、双流语音和更新页面。
- 管理员系统组与非管理员隐藏逻辑由组件测试覆盖。
- 未保存内容切页确认、系统升级锁定切页/关闭由组件测试覆盖。
- 账号登录与节点配对按作用域拆分，定时器与扫码资源清理由组件测试覆盖。
- 移动抽屉打开后背景 header/main 均不可聚焦，焦点进入“关闭导航”；进入设置详情后焦点移到页面标题，返回后移到当前分类，关闭中心后回到“打开导航”。
- 两处 Agent 选择器均使用 `listbox / option` 状态，并支持方向键、Home、End 与 Escape；用户行操作的 accessible name 包含目标用户名。
- 9119 用户名、密码及双流语音 API Key 在浏览器中保持空白；Provider 完整目录与只读/可编辑状态来自真实本地服务。
- 浏览器控制台最终无 warning/error。

## Comparison history

1. 初次比较发现 P2：身份和账号安全的保存操作位于滚动内容中，未匹配固定底栏。
2. 修复：为两页增加外部表单 ID 和统一固定 `取消 / 保存更改` 底栏；桌面底栏实测 `786 × 76`，移动端底栏实测 `390 × 68`。
3. 复核：`08-identity-desktop-fixed-footer.png`、`09-security-desktop-fixed-footer.png` 与 `07-mobile-security-fixed-footer.png` 证明操作栏固定，右内容区仍可独立滚动，无横向溢出。
4. 独立代码审查发现更新任务恢复/启动锁、Agent 草稿刷新、扫码资源竞态、APNs/FCM 草稿互相覆盖等 P1/P2 风险；实现加入生命周期 token、真实 dirty baseline、分离配置快照、并发锁与业务 401 隔离。
5. 第二次复核确认 Agent 弹层仅剩 Agent 列表，桌面与移动设置导航首屏完整可见，关闭焦点正确恢复；新增组件测试覆盖 Provider/语音丢稿、更新恢复、摄像头停止、账号 401 和推送并发草稿。
6. 无障碍浏览器复核补齐移动详情/返回焦点、抽屉背景隔离、Agent 复合控件键盘操作及用户行按钮上下文；`390 × 844` 与 `1637 × 874` 实测焦点位置正确，控制台仍无 warning/error。

## Verification

- `npm run typecheck`：通过。
- `npm test`：61 个测试文件、317 项测试全部通过。
- `npm run build`：品牌校验、发布版本校验、客户端与服务端生产构建全部通过。
- `git diff --check`：通过。
- 两轮独立最终审查：无剩余 P0、P1 或 P2。

## Final result

final result: passed

---

# 自有动态 Agent 角色 Design QA（2026-09-02）

## Evidence

- Source visual language: `/Users/samien/git/OpenMausBot/docs/screenshots/agent-profile-desktop.png`.
- Implementation screenshot: `/Users/samien/.codex/visualizations/2026/09/02/01a05f7c-9ccc-76f2-99f3-116cd8ca64cb/agent-identity/web-desktop.jpg`.
- Browser viewport: `1440 × 1024`; fixture: `/?fixture=agent-identity`.

## Review

- OpenMausBot 的渐变、白色眼睛、极简嘴型与状态动效语言得到保留；原细长指针轮廓未复制。
- 圆形、圆角方形和短三角使用统一视觉面积；短三角接近 1:1 包围盒，尖端未超出同组卡片的光学边界。
- `working` 的实时 transform 在采样间变化；`notifying` 首屏截图可见提醒光环；页面控制台无 warning/error。
- 角色名称、三种形状、工作、新消息和等待操作均有可访问名称；减少动态效果由 CSS media query 覆盖。
- 无剩余 P0、P1 或 P2 视觉问题。

final result: passed

## 群聊组合头像补充验收

- 浏览器证据：`/Users/samien/.codex/visualizations/2026/09/02/01a05f7c-9ccc-76f2-99f3-116cd8ca64cb/group-mascot/web.jpg`。
- 群聊默认头像由前三位成员角色组成；不足三位时使用圆、方、短三角补足，旧动物值按新组合头像显示。
- 上传图片仍优先；创建与管理界面改为“成员组合 / 上传图片”，不再出现动物选择器。
- `1440 × 1024` 浏览器检查确认三个成员均可辨识，短三角未被完全遮挡，控制台无 warning/error。

final result: passed
