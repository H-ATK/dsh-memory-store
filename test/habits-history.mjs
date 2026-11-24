/**
 * Fill conversation records, full turn text, and habit counters from the Session
 * logs that already exist, so the profile is useful immediately instead of after
 * twenty new messages.
 *
 *   node test/habits-history.mjs [--dry]
 *
 * Idempotent: records are content-addressed, so a second run adds no new rows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { MemoryStore } from '../store.js'

const HOME = process.env.USERPROFILE || userInfo().homedir
const live = process.env.DSH_MEMORY_DB || path.join(HOME, '.dsh', 'storages', 'dsh-memory', 'memory.db')
const sessionsDir = path.join(HOME, '.dsh', 'sessions')
const dry = process.argv.includes('--dry')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const blocksText = blocks => (Array.isArray(blocks) ? blocks : [])
  .filter(block => block && block.type === 'text')
  .map(block => block.text)
  .join('\n')
const oneLine = text => String(text).replace(/\s+/g, ' ').trim()

const RUNTIME_PREFIXES = ['Time sampled while preparing', 'Browser time zone for this request', 'Elapsed since the preceding', 'Current working directory:', '<system-reminder>']
const human = message => {
  const kind = String(message?.source?.kind ?? '')
  if (kind !== '' && kind !== 'user') return false
  const text = oneLine(blocksText(message?.content))
  return text !== '' && !RUNTIME_PREFIXES.some(prefix => text.startsWith(prefix))
}

if (!existsSync(live)) {
  console.error(`数据库不存在: ${live}`)
  process.exit(2)
}
const store = new MemoryStore(live, { describeTool: name => `tool: ${name}` })

let turns = 0
let users = 0
let assistants = 0
for (const file of walk(sessionsDir).filter(name => name.endsWith('.zstd'))) {
  const sessionId = path.basename(path.dirname(file))
  let events
  try {
    events = zstdDecompressSync(readFileSync(file)).toString('utf8')
      .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { continue }

  let turn = 0
  let user = []
  let assistant = ''
  let startTime = 0
  const flush = () => {
    if (turn <= 0 || user.length === 0) return
    const userText = user.join('\n').slice(0, 60_000)
    const assistantText = assistant === '' ? null : assistant
    turns += 1
    if (dry) return
    store.recordTurnText(sessionId, turn, { userText, assistantText, time: startTime || Date.now() })
    store.recordConversation({ userText, assistantText, time: startTime || Date.now(), source: `history:${sessionId}` })
  }

  for (const event of events) {
    if (event.type === 'turn/start') {
      flush()
      turn = Number(event.data?.turn) || turn + 1
      user = []
      assistant = ''
      startTime = Number(event.time) || Date.now()
      continue
    }
    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      if (!human(message)) continue
      user.push(oneLine(blocksText(message?.content)))
      users += 1
      continue
    }
    if (event.type === 'assistant/message') {
      const text = oneLine(blocksText(event.data?.message?.content))
      if (text === '') continue
      assistant = text.slice(0, 60_000)
      assistants += 1
      continue
    }
    if (event.type === 'turn/end') {
      flush()
      turn = 0
      user = []
      assistant = ''
    }
  }
  flush()
}

console.log(`扫描：${users} 条用户消息 / ${assistants} 条助手回复 → ${turns} 轮`)
if (dry) {
  console.log('（试运行，未写入）')
} else {
  const harvested = store.harvestHabits(2000)
  const profile = store.styleProfile()
  console.log(`写入并收集：${harvested} 条记录进入习惯统计`)
  console.log(profile.ready
    ? `风格：${profile.labels.join('、')}（${profile.messages} 条消息）`
    : `风格：还需要 ${20 - profile.messages} 条消息`)
}
store.close()
