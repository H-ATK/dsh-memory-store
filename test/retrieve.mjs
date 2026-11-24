/**
 * Offline verification for retrieval and injection rendering (M4).
 *
 * Builds a database shaped like the live one (real entity/occurrence rows),
 * checks ranking, the token budget, byte-stability, and the injection guards.
 *
 * Usage: node test/retrieve.mjs
 */
import { existsSync } from 'node:fs'
import { copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../store.js'
import { bigramText } from '../store.js'
import { MEMORY_CLOSE, MEMORY_OPEN, estimateTokens, queryTextOf, renderBlock, retrieve } from '../retrieve.js'

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const dbFile = path.join(tmpdir(), `dsh-memory-retrieve-${process.pid}.db`)
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
const store = new MemoryStore(dbFile)
const now = Date.now()
const day = 86_400_000

// 一个偏好、一个高频项目、一个旧对象、一个无关对象
store.applyCard({ sessionId: 's1', seq: 1, turn: 1, time: now - 200 * day, card: { canonical: '审批策略', kind: 'preference', action: '修改', state: '从不询问', detail: '由询问用户改为从不询问', keywords: ['审批'], weight: 900 } })
for (let index = 0; index < 6; index += 1) {
  store.applyCard({ sessionId: 's2', seq: 10 + index, turn: index + 1, time: now - (10 + index) * day, card: { canonical: 'dsh用量插件', kind: 'project', action: '开发', state: '进行中', detail: `第${index + 1}次迭代`, keywords: ['用量', '插件'], weight: 720 } })
}
store.applyCard({ sessionId: 's3', seq: 30, turn: 1, time: now - 300 * day, card: { canonical: '播放器', kind: 'object', action: '对比选型', state: '进行中', detail: 'media3 与 GSY', keywords: ['播放器'], weight: 520 } })
store.applyCard({ sessionId: 's4', seq: 40, turn: 1, time: now - 2 * day, card: { canonical: '西瓜', kind: 'object', action: '切', state: '未吃', detail: '劈了没吃', keywords: ['西瓜'], weight: 600 } })

console.log('[1] query extraction')
const blocks = [
  { content: [{ type: 'text', text: '<system-reminder>cwd C:\\x</system-reminder>插件审批策略改一下' }] },
  { content: [{ type: 'text', text: '```js\nconst a=1\n```' }] },
]
const query = queryTextOf(blocks)
check('scaffolding removed', !query.includes('system-reminder'), query)
check('intent kept', query.includes('审批策略'), query)
check('empty message list yields empty query', queryTextOf([]) === '')
check('non-text blocks ignored', queryTextOf([{ content: [{ type: 'image' }] }]) === '')

console.log('\n[2] ranking prefers relevant + frequent + recent')
const byKeyword = store.recall(['审批', '策略'], { limit: 5, now })
check('keyword recall finds the preference', byKeyword.some(item => item.canonical === '审批策略'), byKeyword.map(i => i.canonical).join(','))
check('unrelated entity absent', !byKeyword.some(item => item.canonical === '西瓜'), byKeyword.map(i => i.canonical).join(','))
const frequent = store.recall(['插件'], { limit: 5, now })
const plugin = frequent.find(item => item.canonical === 'dsh用量插件')
check('mention count aggregated', plugin?.mentions === 6, String(plugin?.mentions))
check('one entity holds six mentions', store.normalizeStats().entities === 4, String(store.normalizeStats().entities))
check('occurrences match mentions', store.normalizeStats().occurrences === 9, String(store.normalizeStats().occurrences))
check('latest action surfaced', plugin?.action === '开发' && plugin?.state === '进行中', `${plugin?.action}/${plugin?.state}`)

console.log('\n[3] retrieve renders one compact note')
const found = retrieve(store, '我那个用量插件的审批策略怎么设的', { budgetTokens: 800, minScore: 0.3 })
check('block produced', typeof found.text === 'string' && found.text.trim() !== '', String(found.text).slice(0, 40))
check('no opening marker', !found.text.includes(MEMORY_OPEN), found.text)
check('no closing marker', !found.text.includes(MEMORY_CLOSE), found.text)
check('no section headings', !/(已知偏好|最近相关|联想):/.test(found.text), found.text)
check('no instruction text', !/调用|memory_search|需要细节/.test(found.text), found.text)
check('single line', !found.text.includes('\n'), found.text)
check('preference keeps its detail', found.text.includes('从不询问'), found.text)
check('count rendered as ×N when repeated', /×\d+/.test(found.text), found.text)
check('within budget', found.tokens <= 800, String(found.tokens))
check('compact by default', found.tokens <= 120, `${found.tokens} tokens`)
check('irrelevant query injects nothing', retrieve(store, '今天天气怎么样', { minScore: 0.5 }).text === null)
check('filler query injects nothing', retrieve(store, '好的', { minScore: 0.3 }).text === null)

console.log('\n[4] rendering is byte-stable')
const first = retrieve(store, '审批策略', { budgetTokens: 800, minScore: 0.3 }).text
const second = retrieve(store, '审批策略', { budgetTokens: 800, minScore: 0.3 }).text
check('identical for identical data', first === second)
check('no volatile fields', !/\d{2}:\d{2}:\d{2}/.test(first), first)

console.log('\n[4b] 注入按时间从新到旧')
// 同一主题，一旧一新：两条都通过相关性门槛，新的应排在前面。
store.applyCard({
  sessionId: 's-order', seq: 500, turn: 1, time: now - 120 * day,
  card: { canonical: '排序测试对象', kind: 'object', action: '旧记录', state: '', detail: '', keywords: ['排序测试'], weight: 500 },
})
store.applyCard({
  sessionId: 's-order', seq: 501, turn: 2, time: now - 1 * day,
  card: { canonical: '排序测试别名', kind: 'object', action: '新记录', state: '', detail: '', keywords: ['排序测试'], weight: 500 },
})
const ordered = retrieve(store, '排序测试', { budgetTokens: 800, minScore: 0.3, maxItems: 5 })
check('both matches retrieved', ordered.items.length >= 2, ordered.items.map(item => item.canonical).join(','))
check('newest first', ordered.items[0]?.canonical === '排序测试别名', ordered.items.map(item => `${item.canonical}@${item.lastSeen}`).join(' | '))
const stamps = ordered.items.map(item => Number(item.lastSeen))
check('descending by time', stamps.every((value, index) => index === 0 || stamps[index - 1] >= value), stamps.join(','))

console.log('\n[5] budget truncates whole items, never mid-fragment')
const tight = renderBlock(
  Array.from({ length: 40 }, (_, index) => ({
    id: index, canonical: `对象${index}`, kind: 'object', weight: 500, mentions: 1,
    lastSeen: now, action: '查看', state: '完成', detail: '细节'.repeat(6), score: 1,
  })),
  { budgetTokens: 200 },
)
check('tight budget still renders', tight.text !== null)
check('tight budget respected', tight.tokens <= 200, String(tight.tokens))
check('still one line', !tight.text.includes('\n'), tight.text)
check('fragments separated by the fixed separator', tight.text.split(' / ').length === tight.items.length, tight.text)
check('fewer items than offered', tight.items.length < 40, String(tight.items.length))
check('every fragment carries its name', tight.items.every(item => tight.text.includes(item.canonical)))

console.log('\n[6] empty store is quiet')
const emptyFile = path.join(tmpdir(), `dsh-memory-empty-${process.pid}.db`)
for (const suffix of ['', '-wal', '-shm']) rmSync(`${emptyFile}${suffix}`, { force: true })
const empty = new MemoryStore(emptyFile)
check('no entities, no block', retrieve(empty, '插件审批策略', { minScore: 0.3 }).text === null)
empty.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${emptyFile}${suffix}`, { force: true })

console.log('\n[7] live database recalls real memories')
const live = path.join(process.env.USERPROFILE || '.', '.dsh', 'storages', 'dsh-memory', 'memory.db')
if (!existsSync(live)) {
  console.log('  skip (no live database)')
} else {
  const copy = path.join(tmpdir(), `dsh-memory-live-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
  copyFileSync(live, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${live}${suffix}`)) copyFileSync(`${live}${suffix}`, `${copy}${suffix}`)
  }
  const liveStore = new MemoryStore(copy)
  // Probe with whatever this database actually remembers: the corpus is real and
  // changes as the user works, so a fixed probe would rot.
  const top = liveStore.db.prepare(`
    SELECT e.canonical AS canonical FROM entities e
    JOIN occurrences o ON o.entity_id = e.id
    GROUP BY e.id ORDER BY COUNT(o.id) DESC, e.last_seen DESC LIMIT 3
  `).all().map(row => String(row.canonical))
  const probes = top.length > 0 ? top : ['dsh']
  for (const probe of probes) {
    const hit = retrieve(liveStore, probe, { budgetTokens: 800, minScore: 0.3 })
    check(`recall "${probe}"`, hit.text !== null && hit.items.length > 0, hit.text === null ? 'no match' : hit.items.map(i => i.canonical).join(','))
    if (hit.text !== null) console.log(`       ${hit.text.replace(/\n/g, ' | ')}`)
  }
  check('irrelevant query on live data injects nothing', retrieve(liveStore, '今天天气怎么样', { minScore: 0.3 }).text === null)
  console.log('       估算注入 token:', estimateTokens(retrieve(liveStore, probes[0], { minScore: 0.3 }).text ?? ''))
  liveStore.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
}

store.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
console.log(failures.length === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures.length} failure(s)`)
process.exitCode = failures.length === 0 ? 0 : 1
