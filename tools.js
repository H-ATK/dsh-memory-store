/**
 * Bundled short purposes for the tools shipped with DeepSeek Harness.
 *
 * The live tool registry is the authoritative source and overrides these
 * entries whenever it is readable. This map exists because the registry is
 * frequently still empty when a plugin activates (every tool was already
 * registered, so no `tools/change` follows), and a memory row needs a stable,
 * short purpose rather than a `tool: <name>` placeholder.
 *
 * Keep entries short: they are stored once per tool call, so a 40-character
 * purpose keeps a 5,000-call history under a few hundred kilobytes, while the
 * full registry description would be several megabytes.
 */
export const TOOL_PURPOSES = {
  ask_user_question: '向用户提问并等待选择',
  cordis_inspect_list: '列出可用的运行时探查提供方',
  cordis_inspect_query: '查询运行时服务与事件契约',
  create_goal: '创建可延续的目标',
  edit: '按字面替换编辑文本文件',
  exit_plan_mode: '提交计划并退出计划模式',
  get_goal: '读取当前目标',
  glob: '按通配符查找文件',
  grep: '用正则搜索文件内容',
  job_kill: '取消后台任务',
  job_list: '列出后台任务',
  job_output: '读取后台任务输出',
  list_agents: '列出子代理树',
  list_subagent_models: '查看可用的子代理模型',
  load_workspace_dependencies: '获取工作区依赖路径',
  plugin_manager: '管理插件与插件包',
  plugin_market: '浏览插件市场索引',
  present: '声明最终交付文件',
  pwsh: '执行 PowerShell 命令',
  read: '读取 UTF-8 文本文件',
  read_image: '读取图片文件',
  schedule_create: '创建定时任务',
  schedule_edit: '修改或删除定时任务',
  schedule_list: '列出定时任务',
  schedule_view: '查看单个定时任务',
  send_message: '给子代理发消息',
  skill: '加载技能说明',
  subagent: '派发独立子代理任务',
  subagent_fork: '派发继承上下文的子代理',
  team_task_create: '创建团队任务',
  team_task_get: '读取团队任务',
  team_task_list: '列出团队任务',
  team_task_update: '更新团队任务状态',
  todo_write: '记录任务清单',
  update_goal: '更新目标状态',
  wait_agent: '等待代理消息或完成',
  web_fetch: '抓取网页内容',
  web_search: '联网搜索',
  workflow: '用脚本编排多个子代理',
  working_directory: '读取或切换工作目录',
  write: '写入或覆盖文本文件',
}

/** Longest purpose stored for tools outside the bundled map. */
export const LIVE_PURPOSE_LIMIT = 160
