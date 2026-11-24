/**
 * QQ control commands: a fixed list, matched exactly.
 *
 * Nothing is inferred. An unrecognised sentence is a conversation message, not a
 * near-miss command — "用一下这个" must never switch models just because it starts
 * with 用.
 */

/** The one place the help text lives. One blank line between entries. */
export function commandList() {
  return [
    '可用命令',
    '',
    '状态 —— 当前模型、自动切换、付费槽',
    '',
    '模型列表 —— 全部本地模型和 API 模型',
    '',
    '切换模型 <名字> —— 切过去，并设为对应的默认槽',
    '',
    '开启自动切换本地模型 —— 每轮结束切回本地',
    '',
    '关闭自动切换本地模型',
    '',
    '切回付费模型 —— 回到上次使用的付费模型',
    '',
    '切回本地模型 —— 立刻切到本地模型',
    '',
    '重建QQ会话 —— 丢掉旧会话记录，下条消息重新建两个专用会话',
    '',
    '本轮使用api —— 这一轮用付费 API，回答完自动切回',
  ].join('\n')
}

// Both question marks: the Chinese IME produces the full-width one by default.
const HELP = new Set(['命令', '指令', '帮助', 'help', '?', '？'])
/** Short yes-answers to "shall I pick one for you?". */
const CONFIRM = /^(好|好的|行|可以|是|确认|嗯|ok|yes|要|帮我选)$/iu
const STATUS = new Set(['状态', '模式'])
const MODELS = new Set(['模型列表', '模型', '列出模型', '本地模型', '付费模型', '付费模式'])
// Auto-switch (a standing setting) and local switch (a one-off move) are different
// things, but their aliases must not overlap or the two read as the same command.
const AUTO_ON = new Set([
  '开启自动切换本地模型', '开启自动切换', '开本地',
  '打开本地模型', '开启本地模型',
])
const AUTO_OFF = new Set([
  '关闭自动切换本地模型', '关闭自动切换', '关本地',
  '关闭本地模型', '停用本地模型',
])
const LOCAL_SWITCH = new Set(['切本地', '切到本地', '用本地', '切回本地模型', '切回本地'])
const PAID_SWITCH = new Set(['切回付费模型', '切付费', '切到付费', '切云端', '用云端'])
/** One-turn paid run: anchored, so "帮我解释本轮使用api" stays a question. Case-insensitive. */
const CLOUD_TURN = /^本轮使用api(?:$|\s)/iu
/** Drop the recorded QQ Sessions so the next message builds fresh ones (lower-case keys). */
const RESET_SESSIONS = new Set(['重建qq会话', '重置qq会话', '重建会话', '重置会话'])

function label(model) {
  if (model?.kind === '本地' || model?.billing === '免费' && model?.provider === 'ollama') {
    return '本地 · 免费'
  }
  return `${model?.kind ?? 'API'} · ${model?.billing ?? '付费'}`
}

async function modelListReply(deps) {
  let data = { local: [], cloud: [] }
  try {
    data = await deps.listModels?.() ?? data
  } catch (error) {
    return `读取模型列表失败：${error?.message ?? error}`
  }
  const local = Array.isArray(data?.local) ? data.local : []
  const cloud = Array.isArray(data?.cloud) ? data.cloud : []
  const policy = deps.policy()
  const current = deps.selection()
  const lines = ['模型列表']

  lines.push('', '本地模型（免费）：')
  if (local.length === 0) {
    lines.push('- 没有发现本地模型')
  } else {
    for (const model of local) {
      const active = current?.provider === (model.provider ?? 'ollama') && current?.model === model.id
      lines.push(`- ${model.id} [本地 · 免费]${active ? ' ← 当前使用' : ''}`)
    }
  }

  lines.push('', 'API 模型（付费/免费）：')
  if (cloud.length === 0) {
    lines.push('- 没有发现可用的 API 模型')
  } else {
    for (const model of cloud) {
      const active = current?.provider === model.provider && current?.model === model.id
      const slot = policy?.paid?.provider === model.provider && policy?.paid?.model === model.id
      const flags = [
        label(model),
        slot ? '当前付费槽' : '',
        active ? '当前使用' : '',
      ].filter(Boolean).join(' · ')
      lines.push(`- ${model.name ?? model.id}（${model.providerName ?? model.provider}）[${flags}]`)
    }
  }

  lines.push(
    '',
    `当前使用：${current?.provider ?? '?'} / ${current?.model ?? '?'}`,
    '说明：“付费模型”只是一个默认云端槽，不是只能有一个 API 模型；发「切换模型 <名字>」选择。',
  )
  return lines.join('\n')
}

function statusReply(deps) {
  const selection = deps.selection()
  const model = deps.localModel()
  const policy = deps.policy()
  const paid = policy?.paid
  return [
    `当前模型：${selection?.provider ?? '?'} / ${selection?.model ?? '?'}`,
    `自动切换本地模型：${deps.localSwitch() ? '开' : '关'}${model ? `（${model}）` : ''}`,
    paid === null || paid === undefined
      ? '付费模型槽：未设置'
      : `付费模型槽：${paid.provider} / ${paid.model}`,
  ].join('\n')
}

/**
 * Run one QQ control command.
 *
 * @param {string} text
 * @param {{
 *   policy: () => { local: { provider: string, model: string } | null, paid: { provider: string, model: string } | null },
 *   selection: () => { provider: string, model: string } | null,
 *   localModel: () => string,
 *   localSwitch: () => boolean,
 *   setLocalSwitch: (on: boolean) => void,
 *   listModels?: () => Promise<{ local: any[], cloud: any[] }>,
 *   setPaid?: (selection: { provider: string, model: string }) => void,
 *   apply: (selection: { provider: string, model: string }) => Promise<boolean>,
 *   rememberCurrent?: () => Promise<void> | void,
 *   restorePaid?: () => Promise<{ provider: string, model: string } | null>,
 * }} deps
 * @returns {Promise<string | null>} the reply, or null when this is not a command
 */
export async function handleCommand(text, deps) {
  const body = String(text ?? '').trim()
  if (body === '' || body.length > 40) return null
  // English parts of a command are typed both ways ("QQ" / "qq", "api" / "API").
  const key = body.toLowerCase()

  // A pending "pick one for you?" question is answered by a short yes.
  if (CONFIRM.test(body)) {
    const pending = await deps.takePending?.()
    if (pending !== null && pending !== undefined) {
      return await deps.confirmPending?.(pending) ?? null
    }
  }

  if (HELP.has(body)) return commandList()

  // "本轮使用api" opens a message: this turn runs on the paid model, then falls back.
  // A bare command answers here; with trailing text the message still goes through.
  if (CLOUD_TURN.test(body)) {
    const paid = deps.policy().paid
    if (paid === null || paid === undefined) {
      const offered = await deps.offerDefault?.('paid')
      return offered ?? '还没配置付费模型：模型卡片里先选一个云端模型。'
    }
    if (deps.paidActive?.() === true) return '当前就是付费 API 模式，不用切。'
    await deps.beginCloudTurn?.()
    if (body === '本轮使用api') return `本轮已切到 ${paid.provider} / ${paid.model}，回答完自动切回。`
    return null
  }
  if (STATUS.has(body)) return statusReply(deps)
  if (MODELS.has(body)) return modelListReply(deps)

  if (RESET_SESSIONS.has(key)) {
    await deps.resetSessions?.()
    return '已清掉两个专用会话的记录。下一条消息会重新创建；旧会话还留在侧边栏，可以手动删。'
  }

  if (AUTO_ON.has(body) || AUTO_OFF.has(body)) {
    const on = AUTO_ON.has(body)
    const model = deps.localModel()
    if (on && model === '') {
      const offered = await deps.offerDefault?.('local')
      return offered ?? '本机还没有配置本地模型，所以自动切换打不开。'
    }
    deps.setLocalSwitch(on)
    return on
      ? `自动切换本地模型：开（每轮结束切回 ${model}）`
      : '自动切换本地模型：关'
  }

  if (LOCAL_SWITCH.has(body)) {
    const local = deps.policy().local
    if (local === null || local === undefined) {
      const offered = await deps.offerDefault?.('local')
      return offered ?? '本机还没有配置本地模型。'
    }
    const model = deps.localModel() || local.model
    await deps.rememberCurrent?.()
    const ok = await deps.apply({ provider: local.provider, model })
    return ok ? `已切到本地模型 ${model}` : `切换到 ${model} 失败`
  }

  if (PAID_SWITCH.has(body)) {
    const previous = await deps.restorePaid?.()
    if (previous !== null && previous !== undefined) {
      return `已切回 ${previous.provider} / ${previous.model}`
    }
    const paid = deps.policy().paid
    if (paid !== null && paid !== undefined) {
      const ok = await deps.apply({ provider: paid.provider, model: paid.model })
      return ok ? `已切到付费模型 ${paid.provider} / ${paid.model}` : `切换到 ${paid.model} 失败`
    }
    return '还没有设置付费模型槽。发「模型列表」看可用 API 模型，再发「切换模型 <名字>」。'
  }

  // "切换模型" without a name used to fall through silently.
  if (/^(?:切换模型|切到|切换到)$/u.test(body)) {
    return '要切到哪个模型？发「模型列表」看全部，再发「切换模型 <名字>」。'
  }

  // Only the explicit switch form takes an argument; nothing else is parsed.
  const target = /^(?:切换模型|切到|切换到)\s*(\S{1,40})$/u.exec(body)
  if (target !== null) {
    const name = target[1]
    let data = { local: [], cloud: [] }
    try {
      data = await deps.listModels?.() ?? data
    } catch (error) {
      return `读取模型列表失败：${error?.message ?? error}`
    }
    const local = (data.local ?? []).find(model => model.id === name)
    const cloud = (data.cloud ?? []).find(model => model.id === name || model.name === name)
    if (local !== undefined) {
      await deps.rememberCurrent?.()
      // Switching to a local model also makes it the default local slot.
      deps.setLocal?.({ provider: local.provider ?? 'ollama', model: local.id })
      const ok = await deps.apply({ provider: local.provider ?? 'ollama', model: local.id })
      return ok ? `已切到本地模型 ${local.id}（并设为默认本地模型）` : `切换到 ${local.id} 失败`
    }
    if (cloud !== undefined) {
      deps.setPaid?.({ provider: cloud.provider, model: cloud.id })
      const ok = await deps.apply({ provider: cloud.provider, model: cloud.id })
      return ok ? `已切到付费模型 ${cloud.provider} / ${cloud.id}（并设为付费槽）` : `切换到 ${cloud.id} 失败`
    }
    return `模型列表里没有 ${name}。发「模型列表」看全部模型。`
  }

  return null
}
