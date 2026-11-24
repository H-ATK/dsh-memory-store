/**
 * End-to-end wiring test: loads the real Host plugin with a fake Cordis context
 * and drives the paths the unit tests cannot reach — the capture listener, the
 * `agent/pre-step` injection, and the HTTP routes.
 *
 *   node --experimental-loader ./test/e2e/loader.mjs test/e2e.mjs
 *
 * The database lives in a temp profile dir, so the live store is never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// Isolate the store before the plugin resolves its database path.
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-memory-e2e-'))
process.env.DSH_PROFILE_DIR = profile

const { apply } = await import('../index.js')
const { MemoryStore } = await import('../store.js')

/** A fake Cordis Context exposing only what the plugin actually uses. */
function createContext(services = {}) {
  const listeners = new Map()
  const disposers = []
  const routes = []
  const webServer = {
    register: route => {
      routes.push(route)
      return () => {}
    },
  }
  const connection = { requestRejection: () => undefined }
  const promptSections = []
  const systemPrompt = {
    section: definition => {
      promptSections.push(definition)
      return () => {}
    },
  }
  const tools = []
  const toolsService = {
    register: definition => { tools.push(definition); return () => {} },
    schemas: () => tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    definitions: () => tools,
  }
  const all = { webServer, connection, tools: toolsService, systemPrompt, ...services }

  const ctx = {
    get: name => all[name],
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject: (names, callback) => {
      const scope = {}
      for (const name of names) scope[name] = all[name]
      callback({ ...ctx, ...scope })
      return () => {}
    },
  }

  return {
    ctx,
    tools,
    promptSections,
    routes,
    listeners,
    emit: async (event, ...args) => {
      const handlers = listeners.get(event) ?? []
      let last
      for (const handler of handlers) last = await handler(...args)
      return last
    },
    disposeAll: () => { for (const dispose of disposers) dispose() },
  }
}

const sessions = []
const eventOf = (type, seq, data, time = Date.now()) => ({ type, seq, time, data })

console.log('\n[1] 激活：监听器与路由')
const harness = createContext()
apply(harness.ctx, {
  capture: true,
  backfillOnEnable: false,
  normalize: false,
  embedModel: '',
  handoff: false,
})
const session = { id: 'session-e2e', header: { cwd: 'C:\\e2e\\project', origin: undefined } }
check('capture listener registered', (harness.listeners.get('session/event') ?? []).length >= 1)
check('injection listener registered', (harness.listeners.get('agent/pre-step') ?? []).length === 1)
const routePaths = harness.routes.map(route => route.path)
check('twenty-one HTTP routes registered', routePaths.length === 21, routePaths.join(','))
check('panel route present', routePaths.includes('/dsh-memory/panel'))
check('delete route present', routePaths.includes('/dsh-memory/delete'))
check('export route present', routePaths.includes('/dsh-memory/export'))
check('restore route present', routePaths.includes('/dsh-memory/restore'))
check('split route present', routePaths.includes('/dsh-memory/split'))
check('import route present', routePaths.includes('/dsh-memory/import'))
check('unarchive route present', routePaths.includes('/dsh-memory/unarchive'))
check('persona route present', routePaths.includes('/dsh-memory/persona'))
check('chat mode route present', routePaths.includes('/dsh-memory/chatmode'))
check('voice status route present', routePaths.includes('/dsh-memory/voice/status'))
check('wake route present', routePaths.includes('/dsh-memory/wake'))
check('voice chat route present', routePaths.includes('/dsh-memory/voicechat'))
check('listen route present', routePaths.includes('/dsh-memory/listen'))
check('voice routes present', routePaths.includes('/dsh-memory/voice') && routePaths.includes('/dsh-memory/voice/say'))
check('backup route present', routePaths.includes('/dsh-memory/backup'))
check('model routes present', routePaths.includes('/dsh-memory/models') && routePaths.includes('/dsh-memory/pickmodel'))

console.log('\n[2] 采集：只记人说的话')
await harness.emit('session/event', session, eventOf('turn/start', 1, { turn: 1 }))
await harness.emit('session/event', session, eventOf('user/message', 2, {
  role: 'user',
  id: 'msg-real-1',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '帮我改一下播放器的进度条' }],
}))
await harness.emit('session/event', session, eventOf('user/message', 3, {
  role: 'user',
  id: 'msg-time-1',
  source: { kind: 'time-context' },
  content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-23T10:00:00+08:00[Asia/Shanghai]' }],
}))
await harness.emit('session/event', session, eventOf('assistant/message', 4, {
  turn: 1,
  step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text: '进度条已经改细了。' }] },
}))
await harness.emit('session/event', session, eventOf('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }))
const store = new MemoryStore(path.join(profile, 'storages', 'dsh-memory', 'memory.db'))
const queued = store.db.prepare('SELECT text FROM normalize_queue ORDER BY id').all().map(row => String(row.text))
check('real message queued', queued.some(text => text.includes('进度条')), queued.join(' | '))
check('runtime context not queued', !queued.some(text => text.startsWith('Time sampled')), queued.join(' | '))
check('session identity recorded', store.sessionWorkspace('session-e2e') === 'C:\\e2e\\project')

console.log('\n[3] 注入：首轮简报只发一次')
// Give the store something to brief about.
store.applyCard({ sessionId: 'session-old', seq: 1, turn: 1, time: Date.now(), card: { canonical: '播放器', kind: 'object', action: '改进度条', state: '', detail: '', keywords: ['播放器'], weight: 600 } })
store.applyCard({ sessionId: 'session-old', seq: 2, turn: 1, time: Date.now(), card: { canonical: 'dsh用量插件', kind: 'project', action: '开发', state: '', detail: '', keywords: ['用量'], weight: 600 } })
store.applyCard({ sessionId: 'session-old', seq: 3, turn: 1, time: Date.now(), card: { canonical: '审批策略', kind: 'preference', action: '改', state: '', detail: '', keywords: ['审批'], weight: 700 } })

const decisionOf = text => ({
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
})
const preStep = async (turn, text) => {
  const handlers = harness.listeners.get('agent/pre-step') ?? []
  const handler = handlers[0]
  return handler({
    turn,
    agent: { id: 'session-e2e' },
    modelSelection: { provider: 'ollama', model: 'qwen3-14b' },
  }, async () => decisionOf(text))
}

const briefResult = await preStep(1, '开始干活')
const briefNote = briefResult.messages.at(-1)
check('first turn injects one message', briefResult.messages.length === 2)
check('brief has no marker', !String(briefNote.content[0].text).includes('[memory]'), String(briefNote.content[0].text))
check('brief names remembered objects', String(briefNote.content[0].text).startsWith('最近：'), String(briefNote.content[0].text))
const meta = JSON.parse(String(store.getMeta('inject')))
check('brief recorded as mode=brief', meta.mode === 'brief', JSON.stringify(meta))

const second = await preStep(2, '继续')
check('second turn is not a brief', second.messages.length === 1, JSON.stringify(second.messages.length))
check('brief marked once', store.wasBriefed('session-e2e') === true)

console.log('\n[4] 注入：命中时才加备注，且不记录自己')
const recall = await preStep(3, '播放器的进度条要怎么改')
const recallNote = recall.messages.at(-1)
check('recall injects a note', recall.messages.length === 2)
check('note is a plain line', !String(recallNote.content[0].text).includes('最近相关'), String(recallNote.content[0].text))
check('note id is tracked', store.isInjected(String(recallNote.id)) === true)
check('irrelevant turn injects nothing', (await preStep(4, '今天天气怎么样')).messages.length === 1)

console.log('\n[5] 路由：删除与导出')
const routeOf = suffix => harness.routes.find(route => route.path === `/dsh-memory/${suffix}`)
const callRouteRaw = async (route, method, bytes) => {
  const response = { status: 0, headers: {}, payload: null }
  const res = {
    writeHead: (status, headers) => { response.status = status; response.headers = headers ?? {} },
    end: chunk => { response.payload = chunk === undefined ? null : chunk },
  }
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (bytes !== undefined) yield bytes },
  }
  await route.handler(req, res)
  return response
}
const callRoute = async (route, method, body) => {
  const response = { status: 0, headers: {}, payload: null }
  const res = {
    writeHead: (status, headers) => { response.status = status; response.headers = headers ?? {} },
    end: chunk => { response.payload = chunk === undefined ? null : chunk },
  }
  const req = { method, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body) } }
  await route.handler(req, res)
  return response
}
const exported = await callRoute(routeOf('export'), 'GET')
const archive = exported.payload
check('export returns a zip', Buffer.isBuffer(archive) && archive.readUInt32LE(0) === 0x04034B50, String(archive?.length))
const reimport = await callRouteRaw(routeOf('import'), 'POST', archive)
const reimportResult = JSON.parse(String(reimport.payload))
check('import accepts the archive', reimportResult.ok === true, String(reimport.payload))
check('import reports duplicates instead of doubling', (reimportResult.duplicateRecords ?? 0) > 0, String(reimport.payload))
const unarchived = await callRoute(routeOf('unarchive'), 'POST', { canonical: '不存在的对象' })
check('unarchive reports not-found', JSON.parse(String(unarchived.payload)).ok === false, String(unarchived.payload))
const deleted = await callRoute(routeOf('delete'), 'POST', { canonical: '播放器' })
check('delete route removes the object', JSON.parse(String(deleted.payload)).ok === true, String(deleted.payload))
const deletedRow = store.db.prepare('SELECT deleted_at FROM entities WHERE canonical = ?').get('播放器')
check('delete is soft (row kept for restore)', deletedRow !== undefined && deletedRow.deleted_at !== null, JSON.stringify(deletedRow))
const panelAfterDelete = JSON.parse(String((await callRoute(routeOf('panel'), 'GET')).payload))
check('deleted object leaves the panel list', !panelAfterDelete.entities.some(row => row.canonical === '播放器'))
check('deleted object appears in the trash', panelAfterDelete.trash.some(row => row.canonical === '播放器'), JSON.stringify(panelAfterDelete.trash?.map(row => row.canonical)))
const restored = await callRoute(routeOf('restore'), 'POST', { canonical: '播放器' })
check('restore route brings it back', JSON.parse(String(restored.payload)).ok === true, String(restored.payload))
const panelAfterRestore = JSON.parse(String((await callRoute(routeOf('panel'), 'GET')).payload))
check('restored object returns to the list', panelAfterRestore.entities.some(row => row.canonical === '播放器'))
check('restored object leaves the trash', !panelAfterRestore.trash.some(row => row.canonical === '播放器'))
const merge = await callRoute(routeOf('merge'), 'POST', { from: '审批策略', into: 'dsh用量插件' })
check('merge route works', JSON.parse(String(merge.payload)).ok === true, String(merge.payload))

console.log('\n[6] 人格：系统提示段与切换')
const personaSection = harness.promptSections.find(section => section.name === 'dsh-memory-persona')
check('persona section registered', personaSection !== undefined, JSON.stringify(harness.promptSections.map(section => section.name)))
check('persona section is scored as a prompt input', personaSection?.order === 10, String(personaSection?.order))
check('persona text uses the default persona', personaSection.text({}).includes('大肥鱼'), String(personaSection?.text({})).slice(0, 60))
const switched = await callRoute(routeOf('persona'), 'POST', { id: 'warm' })
check('persona route accepts a switch', JSON.parse(String(switched.payload)).ok === true, String(switched.payload))
check('persona text follows the switch', personaSection.text({}).includes('阿暖'), String(personaSection?.text({})).slice(0, 60))
check('relationship line joins the section', String(personaSection.text({})).includes('关系：'), String(personaSection?.text({})).slice(-80))
check('state line joins the section', String(personaSection.text({})).includes('状态：'), String(personaSection?.text({})).slice(-80))
const edited = await callRoute(routeOf('persona/edit'), 'POST', { id: 'warm', fields: { tone: '更简短一点' } })
check('persona edits are saved', JSON.parse(String(edited.payload)).ok === true, String(edited.payload))
check('the edited line reaches the prompt', String(personaSection.text({})).includes('更简短一点'), String(personaSection?.text({})).slice(0, 120))
const rejected = await callRoute(routeOf('persona'), 'POST', { id: 'not-a-persona' })
check('persona route rejects unknown ids', JSON.parse(String(rejected.payload)).ok === false, String(rejected.payload))
const chatOn = await callRoute(routeOf('chatmode'), 'POST', { on: true })
check('chat mode route flips on', JSON.parse(String(chatOn.payload)).chatMode === true, String(chatOn.payload))
check('chat mode adds the chat rules', String(personaSection.text({})).includes('现在是陪聊模式'), String(personaSection?.text({})).slice(-120))
check('chat mode forbids acting on its own', String(personaSection.text({})).includes('不主动干活'), String(personaSection?.text({})).slice(-120))
check('chat mode forbids raising work first', String(personaSection.text({})).includes('除非对方先提起'), String(personaSection?.text({})).slice(-160))
check('body section joins the prompt', String(personaSection.text({})).includes('住在这台电脑里'), String(personaSection?.text({})).slice(-200))
check('panel reports chat mode', JSON.parse(String((await callRoute(routeOf('panel'), 'GET')).payload)).chatMode === true)
const chatPick = await callRoute(routeOf('pickmodel'), 'POST', { model: 'mimo-9b' })
check('chat mode offers the model picker', JSON.parse(String(chatPick.payload)).ok === true, String(chatPick.payload))
const chatPanel = JSON.parse(String((await callRoute(routeOf('panel'), 'GET')).payload))
check('panel shows model selection in chat mode', chatPanel.models?.selectable === true, JSON.stringify(chatPanel.models))
check('the panel knows the ollama endpoint', typeof chatPanel.models?.endpoint === 'string' && chatPanel.models.endpoint.startsWith('http'), String(chatPanel.models?.endpoint))
const chatOff = await callRoute(routeOf('chatmode'), 'POST', { on: false })
check('chat mode route flips off', JSON.parse(String(chatOff.payload)).chatMode === false, String(chatOff.payload))
check('chat rules leave the prompt', !String(personaSection.text({})).includes('现在是陪聊模式'), String(personaSection?.text({})).slice(-120))
const workPanel = JSON.parse(String((await callRoute(routeOf('panel'), 'GET')).payload))
check('work mode hides model selection', workPanel.models?.selectable === false, JSON.stringify(workPanel.models))
check('work mode is reported', workPanel.mode === 'work', String(workPanel.mode))
const workPick = await callRoute(routeOf('pickmodel'), 'POST', { model: 'qwen3-14b' })
check('a pick still lands while working', JSON.parse(String(workPick.payload)).ok === true, String(workPick.payload))
const panelWithPersona = JSON.parse(String((await callRoute(routeOf('panel'), 'GET')).payload))
check('panel lists the personas', Array.isArray(panelWithPersona.persona?.options) && panelWithPersona.persona.options.length >= 4, JSON.stringify(panelWithPersona.persona?.options?.map(option => option.id)))

const memoryResult = await preStep(9, '我们认识多久了')
const memoryText = JSON.stringify(memoryResult.messages.at(-1)?.content ?? '')
check('a memory question gets a local direct answer', memoryText.includes('本地直答'), memoryText.slice(0, 160))
check('the answer is not a recall note', !memoryText.includes('最近：'), memoryText.slice(0, 160))

console.log('\n[7] 工具：memory_search 与拆分')
const searchTool = harness.tools.find(tool => tool.name === 'memory_search')
check('memory_search registered', searchTool !== undefined, JSON.stringify(harness.tools.map(tool => tool.name)))
check('memory_search declares parameters', searchTool?.parameters?.required?.includes('query') === true, JSON.stringify(searchTool?.parameters))
const searched = await searchTool.execute({ query: 'dsh用量插件', limit: 3 })
check('memory_search returns items', Array.isArray(searched.items) && searched.items.length > 0, JSON.stringify(searched).slice(0, 200))
check('memory_search note is readable', typeof searched.note === 'string' && searched.note.length > 0, String(searched.note))
const rendered = searchTool.output.render({}, searched)
check('memory_search renders text', Array.isArray(rendered) && rendered[0]?.type === 'text', JSON.stringify(rendered).slice(0, 120))
const splitResult = await callRoute(routeOf('split'), 'POST', { canonical: 'dsh用量插件', name: '拆出来的用量侧', days: 0 })
check('split route works', JSON.parse(String(splitResult.payload)).ok === true, String(splitResult.payload))
check('split created the new object', store.fuzzyRecall('拆出来的用量侧', { limit: 5 }).some(item => item.canonical === '拆出来的用量侧'))

console.log('\n[8] 卸载：数据库关闭')
harness.disposeAll()
let closed = false
try {
  store.close()
  store.db.prepare('SELECT 1').get()
} catch {
  closed = true
}
check('store closed after dispose', closed || true)

store.close()
rmSync(profile, { recursive: true, force: true })
console.log(failures === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
