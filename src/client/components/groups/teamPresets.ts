export interface TeamPresetRole {
  name: string
  description: string
  host?: boolean
}

export interface TeamPreset {
  id: string
  name: string
  summary: string
  instructions: string
  roles: TeamPresetRole[]
}

export const TEAM_PRESETS: TeamPreset[] = [
  {
    id: 'information-research',
    name: '信息收集团队',
    summary: '检索、核验并整理可信资料',
    instructions: '围绕用户目标拆解调研问题，分别完成资料检索、交叉核验和结构化整理。引用关键来源，明确事实、推断与待确认项，最后由调研负责人汇总可直接使用的结论。',
    roles: [
      { name: '调研负责人', description: '拆解问题、分派任务并汇总最终结论', host: true },
      { name: '信息检索', description: '广泛查找资料、案例和一手来源' },
      { name: '事实核验', description: '交叉验证关键数据、时效与来源可信度' },
      { name: '资料整理', description: '归纳要点、证据和待确认事项' },
    ],
  },
  {
    id: 'product-design',
    name: '产品设计团队',
    summary: '从需求洞察推进到可评审方案',
    instructions: '先澄清目标用户、问题和成功指标，再分别完成用户洞察、交互方案、视觉表达与设计评审。所有决策说明依据、约束和取舍，由产品负责人整合为可执行方案。',
    roles: [
      { name: '产品负责人', description: '定义目标、优先级和验收标准', host: true },
      { name: '用户研究', description: '分析用户、场景、痛点和使用动机' },
      { name: '交互设计', description: '设计信息架构、流程和交互细节' },
      { name: '视觉设计', description: '负责界面层级、视觉规范和表现一致性' },
      { name: '设计评审', description: '检查可用性、无障碍、边界状态和实现风险' },
    ],
  },
  {
    id: 'software-development',
    name: '软件开发团队',
    summary: '覆盖设计、实现、测试与审查',
    instructions: '先确认需求、现有架构和验收方式，再按前端、后端、测试和审查分工推进。优先复用现有约定，保护无关行为；提交结论时列明改动、风险和真实验证证据。',
    roles: [
      { name: '技术负责人', description: '拆解方案、协调依赖并把控技术边界', host: true },
      { name: '前端开发', description: '负责界面、交互、状态和客户端测试' },
      { name: '后端开发', description: '负责接口、数据、服务逻辑和兼容性' },
      { name: '测试工程师', description: '设计并执行功能、回归和边界验证' },
      { name: '代码审查', description: '检查正确性、安全性、性能和可维护性' },
    ],
  },
  {
    id: 'copywriting',
    name: '文案书写团队',
    summary: '策划、撰写并校对完整内容',
    instructions: '先明确读者、目标、语气和发布渠道，再完成资料整理、内容结构、文案撰写与校对。保持术语统一和事实准确，由内容策划整合最终版本。',
    roles: [
      { name: '内容策划', description: '确定受众、目标、结构和表达策略', host: true },
      { name: '资料编辑', description: '整理素材、事实、术语和引用依据' },
      { name: '文案撰写', description: '完成正文、标题和不同渠道版本' },
      { name: '校对审核', description: '检查事实、逻辑、语气、语法和一致性' },
    ],
  },
  {
    id: 'project-management',
    name: '项目管理团队',
    summary: '协调需求、进度、依赖与风险',
    instructions: '围绕目标、范围、时间和责任人建立项目计划。持续同步需求变化、进度、依赖、风险与决策，所有行动项必须包含负责人和完成条件，由项目负责人维护统一结论。',
    roles: [
      { name: '项目负责人', description: '维护目标、范围、计划和最终决策', host: true },
      { name: '需求协调', description: '澄清需求、优先级和跨方依赖' },
      { name: '进度跟踪', description: '跟进里程碑、行动项和交付状态' },
      { name: '风险管理', description: '识别风险、阻塞并准备应对方案' },
    ],
  },
  {
    id: 'data-analysis',
    name: '数据分析团队',
    summary: '从数据处理到业务洞察汇报',
    instructions: '先定义问题、指标口径和数据边界，再完成数据处理、指标分析和洞察验证。明确数据质量、假设和不确定性，由分析负责人输出可复核的结论与建议。',
    roles: [
      { name: '分析负责人', description: '定义分析问题、口径并整合结论', host: true },
      { name: '数据处理', description: '负责数据获取、清洗和质量检查' },
      { name: '指标分析', description: '计算指标、识别趋势并验证假设' },
      { name: '洞察汇报', description: '将发现转化为图表、结论和行动建议' },
    ],
  },
  {
    id: 'meeting-collaboration',
    name: '会议协作团队',
    summary: '会前准备、会议记录与会后跟进',
    instructions: '会前整理议题、背景和待决策事项；会中记录关键观点、结论和分歧；会后输出带负责人和截止条件的行动项。由会议主持控制议程并确认最终记录。',
    roles: [
      { name: '会议主持', description: '组织议程、推动决策并控制讨论范围', host: true },
      { name: '议题研究', description: '准备背景资料、备选方案和关键问题' },
      { name: '会议记录', description: '记录观点、决策、分歧和上下文' },
      { name: '行动跟进', description: '整理责任人、完成条件并跟踪后续事项' },
    ],
  },
  {
    id: 'operations',
    name: '运维保障团队',
    summary: '发布、监控、排障与安全检查',
    instructions: '所有操作先确认环境、影响范围、回滚方式和验证标准。发布、监控排障与安全审查分别执行并互相复核，由运维负责人统一判断是否继续、回滚或升级处理。',
    roles: [
      { name: '运维负责人', description: '制定方案、控制风险并负责最终决策', host: true },
      { name: '发布执行', description: '负责变更步骤、配置检查和回滚准备' },
      { name: '监控排障', description: '观察指标日志、定位故障并验证恢复' },
      { name: '安全审查', description: '检查权限、数据、依赖和操作安全性' },
    ],
  },
]
