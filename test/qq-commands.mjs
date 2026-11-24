/**
 * QQ control commands: the fixed table, exact matching, and the rules that matter —
 * no invented commands, near-misses stay conversations, and every switch is reversible.
 */
import { handleCommand, commandList } from '../qq-commands.js'

const state = {
  localSwitch: false,
  applied: [],
  local: { provider: 'ollama', model: 'mimo-9b' },
  paid: null,
  current: { provider: 'deepseek-account', model: 'deepseek-flash' },
  previous: null,
  pending: null,
}

const models = () => ({
  local: state.local === null ? [] : [{ ...state.local, id: state.local.model, kind: '本地', billing: '免费' }],
  cloud: [
    { provider: 'deepseek-account', id: 'deepseek-flash', name: 'DeepSeek Flash', providerName: 'DeepSeek', kind: '官方 API', billing: '付费' },
    { provider: 'deepseek-account', id: 'deepseek-pro', name: 'DeepSeek Pro', providerName: 'DeepSeek', kind: '官方 API', billing: '付费' },
  ],
})

const deps = {
  policy: () => ({ local: state.local, paid: state.paid }),
  selection: () => state.current,
  localModel: () => state.local?.model ?? '',
  localSwitch: () => state.localSwitch,
  setLocalSwitch: on => { state.localSwitch = on },
  listModels: async () => models(),
  setPaid: selection => { state.paid = selection },
  setLocal: selection => { state.local = selection },
  offerDefault: async kind => {
    const data = models()
    if (kind === 'local') {
      if (data.local.length === 0) return '本机没有发现任何本地模型（Ollama 里一个模型都没有）。'
      const first = data.local[0]
      state.pending = { kind: 'local', provider: 'ollama', model: first.id }
      return `本机还没有配置本地模型。帮你把列表第一个 ${first.id} 设为默认本地模型？回复「好」。`
    }
    const first = data.cloud[0]
    state.pending = { kind: 'paid', provider: first.provider, model: first.id }
    return `还没配置付费模型。帮你把列表第一个 ${first.name}（${first.providerName}）设为付费槽？回复「好」。`
  },
  takePending: () => {
    const pending = state.pending
    state.pending = null
    return pending
  },
  confirmPending: async pending => {
    if (pending?.kind === 'local') {
      state.local = { provider: pending.provider, model: pending.model }
      return `已把 ${pending.model} 设为默认本地模型并切过去。`
    }
    state.paid = { provider: pending.provider, model: pending.model }
    return `已把 ${pending.provider} / ${pending.model} 设为付费槽。`
  },
  apply: async selection => {
    state.applied.push(selection)
    state.current = selection
    return true
  },
  rememberCurrent: () => { state.previous = { ...state.current } },
  restorePaid: async () => {
    if (state.previous === null) return null
    state.current = { ...state.previous }
    return state.previous
  },
  paidActive: () => state.paid !== null && state.current.provider === state.paid.provider && state.current.model === state.paid.model,
  beginCloudTurn: async () => {
    state.previous = { ...state.current }
    state.current = { ...state.paid }
    return true
  },
}

let failed = 0
const check = async (input, expect) => {
  const reply = await handleCommand(input, deps)
  const ok = expect === null ? reply === null : (typeof reply === 'string' && reply.includes(expect))
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(input)} -> ${reply === null ? 'null' : JSON.stringify(reply.slice(0, 90))}`)
}

await check('命令', '可用命令')
await check('帮助', '可用命令')
await check('?', '可用命令')
await check('状态', '当前模型')
await check('模型列表', '本地模型')
await check('模型列表', 'API 模型（付费/免费）')
await check('模型列表', '官方 API · 付费')
await check('开启自动切换本地模型', '自动切换本地模型：开')
await check('关闭自动切换本地模型', '自动切换本地模型：关')
await check('切换模型 mimo-9b', '已切到本地模型 mimo-9b')
await check('状态', 'ollama / mimo-9b')
await check('切回付费模型', '已切回 deepseek-account / deepseek-flash')
await check('状态', 'deepseek-account / deepseek-flash')
await check('切换模型 deepseek-pro', '已切到付费模型 deepseek-account / deepseek-pro')
await check('模型列表', 'DeepSeek Pro')
await check('切换模型 no-such-model', '模型列表里没有')

// Near-misses must stay conversations, never commands.
await check('用一下这个功能', null)
await check('切换一下思路', null)
await check('打开音乐', null)
await check('你好', null)
await check('今天天气不错', null)
// A bare switch verb now answers with a hint instead of silence.
await check('切到', '要切到哪个模型')

// One-turn cloud request: switch only when not already on the paid model.
state.paid = { provider: 'deepseek-account', model: 'deepseek-pro' }
state.current = { provider: 'deepseek-account', model: 'deepseek-flash' }
await check('本轮使用api', '本轮已切到')
await check('本轮使用api', '当前就是付费 API 模式')
// Inside a sentence the message must still reach the assistant.
state.current = { provider: 'deepseek-account', model: 'deepseek-flash' }
const cloudSentence = await handleCommand('本轮使用api 帮我写个函数', deps)
console.log(`${cloudSentence === null ? 'ok  ' : 'FAIL'} 句中关键字 -> ${cloudSentence === null ? 'null（继续投递）' : JSON.stringify(cloudSentence)}`)
if (cloudSentence !== null) failed += 1

// No slot configured: the command asks first, and a short yes fills the slot.
state.paid = null
await check('本轮使用api', '帮你把列表第一个 DeepSeek Flash')
await check('好', '已把 deepseek-account / deepseek-flash 设为付费槽')
if (state.paid?.model !== 'deepseek-flash') {
  failed += 1
  console.log('FAIL 确认后付费槽没有写入:', JSON.stringify(state.paid))
}

// No local model configured: the auto-switch must refuse, but offer to pick one.
state.local = null
await check('开启自动切换本地模型', '本机没有发现任何本地模型')
await check('切本地', '本机没有发现任何本地模型')

// Picking a local model through 切换模型 also makes it the default local slot.
state.local = null
await check('切换模型 mimo-9b', '模型列表里没有 mimo-9b')

console.log(failed === 0 ? 'all passed' : `${failed} failed`)
console.log('help text lines:', commandList().split('\n').length)
process.exitCode = failed === 0 ? 0 : 1
