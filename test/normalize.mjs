/**
 * Offline verification for the normalization stage (M3).
 *
 * No model call: cleaning, skip rules, prompt shape, JSON parsing, card folding,
 * queue bookkeeping, and the schema-1 → schema-2 migration are all deterministic.
 *
 * Usage: node test/normalize.mjs
 */
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryStore, SCHEMA_VERSION, bigramText } from '../store.js'
import { SYSTEM_PROMPT, bigramsOf, buildUserPrompt, cleanUserText, parseCard, worthNormalizing } from '../normalize.js'

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('[1] cleaning removes harness scaffolding')
const dirty = '<system-reminder> Current session: cwd C:\\x </system-reminder>用户说他劈了个西瓜，但是没吃。'
const cleaned = cleanUserText(dirty)
check('system-reminder stripped', !cleaned.includes('system-reminder'), cleaned)
check('content kept', cleaned.includes('西瓜'), cleaned)
check('code fence stripped', !cleanUserText('看这段 ```js\nconst a = 1\n``` 好吗').includes('const a'))
check('url stripped', !cleanUserText('参考 https://example.com/a?b=1 谢谢').includes('example.com'))
check('length capped', cleanUserText('字'.repeat(2000)).length <= 600)

console.log('\n[2] skip rules protect the budget')
const cases = [
  ['', 'empty'],
  ['好的', 'filler'],
  ['OK', 'filler'],
  ['嗯', 'too-short'],
  ['/recall 西瓜', 'command'],
  ['...', 'no-letters'],
  ['[memory] 事实: 西瓜 ×2', 'injected-content-kept-or-cut'],
]
for (const [text, label] of cases) {
  const verdict = worthNormalizing(text)
  if (label === 'injected-content-kept-or-cut') {
    check(`"${text.slice(0, 12)}…" rejected`, verdict.worth === false, verdict.reason)
  } else {
    check(`"${text || '(empty)'}" rejected (${label})`, verdict.worth === false, verdict.reason)
  }
}
check('real sentence accepted', worthNormalizing('用户说他劈了个西瓜，但是没吃。').worth === true)

console.log('\n[3] prompt shape is stable')
const prompt = buildUserPrompt('用户说他劈了个西瓜', ['西瓜', '工作区'])
check('candidates listed', prompt.includes('西瓜、工作区'))
check('payload appended', prompt.includes('待整理：用户说他劈了个西瓜'))
check('system prompt forbids prose', SYSTEM_PROMPT.includes('只输出一个 JSON 对象'))
check('system prompt has all fields', ['canonical', 'kind', 'action', 'state', 'detail', 'keywords', 'weight']
  .every(field => SYSTEM_PROMPT.includes(field)))

console.log('\n[4] parsing tolerates real model output')
const good = parseCard('{"canonical":"西瓜","kind":"object","action":"切","state":"未吃","detail":"劈了没吃","keywords":["西瓜","吃"],"weight":700}')
check('clean json parsed', good?.skip === false && good.card.canonical === '西瓜')
check('fields normalized', good.card.action === '切' && good.card.state === '未吃' && good.card.weight === 700)
const fenced = parseCard('```json\n{"canonical":"西瓜"}\n```')
check('fenced json parsed', fenced?.skip === false && fenced.card.canonical === '西瓜')
const prose = parseCard('好的，结果如下：{"canonical":"西瓜","kind":"object"} 希望有用')
check('prose-wrapped json parsed', prose?.skip === false && prose.card.canonical === '西瓜')
check('skip honoured', parseCard('{"skip":true}')?.skip === true)
check('garbage rejected', parseCard('我不知道') === null)
check('empty rejected', parseCard('') === null)
check('missing canonical rejected', parseCard('{"kind":"object"}') === null)
const clamped = parseCard('{"canonical":"西瓜","weight":99999,"kind":"nonsense"}')
check('weight clamped', clamped.card.weight === 1000, String(clamped.card.weight))
check('unknown kind floored to topic', clamped.card.kind === 'topic', clamped.card.kind)

console.log('\n[5] bigrams drive candidate lookup')
const grams = bigramsOf('用户说他劈了个西瓜 Excel')
check('cjk bigrams produced', grams.includes('西瓜'), grams.join(' '))
check('latin word kept', grams.includes('Excel'), grams.join(' '))
check('store shadow agrees', bigramText('西瓜').includes('西瓜'))

console.log('\n[6] card folding aggregates instead of duplicating')
const dbFile = path.join(tmpdir(), `dsh-memory-norm-${process.pid}.db`)
rmSync(dbFile, { force: true })
const store = new MemoryStore(dbFile)
const cut = store.applyCard({
  sessionId: 's1', seq: 10, turn: 1, time: 1_700_000_000_000,
  card: { canonical: '西瓜', kind: 'object', action: '切', state: '未吃', detail: '劈了没吃', keywords: ['西瓜'], weight: 700 },
})
check('entity created', cut.created === true)
const eat = store.applyCard({
  sessionId: 's2', seq: 20, turn: 5, time: 1_700_100_000_000,
  card: { canonical: '西瓜', kind: 'object', action: '吃', state: '已吃', detail: '', keywords: ['西瓜'], weight: 700 },
})
check('same object reuses one entity', eat.entityId === cut.entityId && eat.created === false)
check('two occurrences recorded', store.normalizeStats().occurrences === 2)
check('one entity only', store.normalizeStats().entities === 1)
const occ = store.db.prepare('SELECT action, state, detail FROM occurrences ORDER BY id').all()
check('exception detail preserved', occ[0].detail === '劈了没吃', String(occ[0].detail))
check('states kept apart', occ[0].state === '未吃' && occ[1].state === '已吃')
const replay = store.applyCard({
  sessionId: 's1', seq: 10, turn: 1, time: 1_700_000_000_000,
  card: { canonical: '西瓜', kind: 'object', action: '切', state: '未吃', detail: '劈了没吃', keywords: [], weight: 700 },
})
check('duplicate pointer is idempotent', store.normalizeStats().occurrences === 2, `entity ${replay.entityId}`)
const candidates = store.candidateCanonicals(['西瓜'])
check('candidate lookup finds the entity', candidates.includes('西瓜'), candidates.join(','))

const crossKind = store.applyCard({
  sessionId: 's4', seq: 30, turn: 9, time: 1_700_200_000_000,
  card: { canonical: '西瓜', kind: 'preference', action: '喜欢', state: '', detail: '', keywords: [], weight: 900 },
})
check('a different kind still merges into one entity', crossKind.created === false && crossKind.entityId === cut.entityId)
check('kind is updated in place', store.db.prepare('SELECT kind FROM entities WHERE id = ?').get(cut.entityId).kind === 'preference')
check('still one entity after cross-kind mention', store.normalizeStats().entities === 1)

console.log('\n[7] queue bookkeeping')
store.applySessionEvent('s3', { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } })
store.applySessionEvent('s3', {
  type: 'user/message', seq: 2, time: 2,
  data: { role: 'user', content: [{ type: 'text', text: '用户说他劈了个西瓜' }] },
})
const pending = store.queuePending(5)
check('pending row visible', pending.length === 1 && pending[0].turn === 7, JSON.stringify(pending[0] ?? {}))
store.markQueueSkipped(pending[0].id, 'filler')
check('skip removes it from pending', store.queuePending(5).length === 0)
const again = store.applySessionEvent('s3', {
  type: 'user/message', seq: 2, time: 2,
  data: { role: 'user', content: [{ type: 'text', text: '重复投递' }] },
})
check('same seq is not queued twice', again === false && store.queueStats().total === 1)
store.logNormalize({ queueId: 1, provider: 'p', model: 'm', inputTokens: 800, outputTokens: 120, ok: true })
check('usage logged', store.normalizeStats().inputTokens === 800 && store.normalizeStats().calls === 1)
store.close()

console.log('\n[8] schema-1 database upgrades in place')
const live = path.join(process.env.USERPROFILE || '.', '.dsh', 'storages', 'dsh-memory', 'memory.db')
if (!existsSync(live)) {
  console.log('  skip (no live database)')
} else {
  const copy = path.join(tmpdir(), `dsh-memory-migrate-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
  // WAL mode keeps recent commits in `-wal` until a checkpoint, so the rehearsal
  // copies all three files; copying memory.db alone silently loses new rows.
  copyFileSync(live, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${live}${suffix}`)) copyFileSync(`${live}${suffix}`, `${copy}${suffix}`)
  }
  const before = statSync(copy).size
  const upgraded = new MemoryStore(copy)
  const columns = upgraded.db.prepare('PRAGMA table_info(normalize_queue)').all().map(row => row.name)
  check('turn column added', columns.includes('turn'), columns.join(','))
  check('attempts column added', columns.includes('attempts'))
  check('skipped column added', columns.includes('skipped'))
  check('existing rows survive', upgraded.queueStats().total > 0, String(upgraded.queueStats().total))
  check('user_version bumped', upgraded.db.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION, String(SCHEMA_VERSION))
  check('entities keyed on canonical alone',
    upgraded.db.prepare('PRAGMA index_info(ux_entities)').all().map(row => row.name).join(',') === 'canonical')
  const dupeCanonicals = upgraded.db
    .prepare('SELECT COUNT(*) AS n FROM (SELECT canonical FROM entities GROUP BY canonical HAVING COUNT(*) > 1)')
    .get().n
  check('no duplicate canonicals remain', Number(dupeCanonicals) === 0, String(dupeCanonicals))
  check('occurrences survived the merge', upgraded.normalizeStats().occurrences > 0, String(upgraded.normalizeStats().occurrences))
  check('data readable after upgrade', upgraded.stats().toolCalls > 0, String(upgraded.stats().toolCalls))
  check('size grew only slightly', statSync(copy).size - before < 200_000, `${before} → ${statSync(copy).size}`)
  upgraded.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
}

console.log('\n[9] truncated model output is salvaged')
const cut1 = parseCard('{"canonical":"西瓜","kind":"object","action":"切","state":"未吃","detail":"')
check('unterminated string salvaged', cut1?.skip === false && cut1.card.canonical === '西瓜', JSON.stringify(cut1))
const cut2 = parseCard('{"canonical":"西瓜","kind":"object","action":"切","keywords":["西瓜",')
check('unterminated array salvaged', cut2?.skip === false && cut2.card.canonical === '西瓜', JSON.stringify(cut2))
const cut3 = parseCard('{"canonical":"西瓜","kind":"object","action":"切"')
check('missing brace salvaged', cut3?.skip === false && cut3.card.canonical === '西瓜')
check('pure garbage still rejected', parseCard('{"not":') === null, JSON.stringify(parseCard('{"not":')))

for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
console.log(failures.length === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures.length} failure(s)`)
process.exitCode = failures.length === 0 ? 0 : 1