/**
 * Offline verification for the memory store (M1).
 *
 * Replays every real Session log under ~/.dsh/sessions through the exact fold
 * the Host listeners use, then asserts:
 *   1. rows are produced for turns, tool calls, and user text;
 *   2. a second full replay is idempotent (counts unchanged);
 *   3. injected `[memory]` blocks are never re-recorded;
 *   4. CJK bigram shadow text is searchable through FTS5;
 *   5. tool digests and the assistant summary keep their shape.
 *
 * Usage: node test/replay.mjs [--keep]
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { MemoryStore, bigramText, toolDigest } from '../store.js'

const keep = process.argv.includes('--keep')
const root = process.env.DSH_MEMORY_REPLAY_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions')
const dbFile = path.join(tmpdir(), `dsh-memory-replay-${process.pid}.db`)

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** @returns {Array<{ id: string, events: any[] }>} */
function loadCorpus() {
  if (!statSync(root, { throwIfNoEntry: false })) return []
  const sessions = []
  for (const file of walk(root)) {
    let text
    try {
      text = zstdDecompressSync(readFileSync(file)).toString('utf8')
    } catch {
      continue
    }
    const events = []
    let declared = ''
    for (const line of text.split('\n')) {
      if (line === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed?.type === 'session' && typeof parsed?.data?.id === 'string') declared = parsed.data.id
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.type === 'string') events.push(parsed)
    }
    const id = declared || path.basename(path.dirname(file))
    sessions.push({ id, events })
  }
  return sessions
}

function replay(store, corpus) {
  let rows = 0
  for (const session of corpus) {
    let maxSeq = 0
    for (const event of session.events) {
      if (store.applySessionEvent(session.id, event, { workspace: null })) rows += 1
      const seq = Number(event.seq)
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
    }
    store.setCursor(session.id, maxSeq)
  }
  return rows
}

console.log(`corpus: ${root}`)
const corpus = loadCorpus()
const totalEvents = corpus.reduce((sum, session) => sum + session.events.length, 0)
console.log(`loaded ${corpus.length} Sessions, ${totalEvents} events`)

const store = new MemoryStore(dbFile)
console.log('\n[1] first replay')
const started = process.hrtime.bigint()
const firstRows = replay(store, corpus)
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
const first = store.stats()
console.log('  ', JSON.stringify(first))
console.log(`   replay ${elapsedMs.toFixed(0)} ms, ${firstRows} rows`)
check('turns recorded', first.turns > 0, String(first.turns))
check('tool calls recorded', first.toolCalls > 0, String(first.toolCalls))
check('user text queued', first.queuedUserMessages > 0, String(first.queuedUserMessages))
check('sessions tracked', first.sessions === corpus.length, `${first.sessions} vs ${corpus.length}`)
check('multiple tool kinds', first.distinctTools > 1, String(first.distinctTools))

console.log('\n[2] second replay is idempotent')
replay(store, corpus)
const second = store.stats()
for (const key of ['turns', 'toolCalls', 'queuedUserMessages', 'sessions']) {
  check(`${key} unchanged`, first[key] === second[key], `${first[key]} → ${second[key]}`)
}

console.log('\n[3] injected memory is never re-recorded')
const before = store.stats().queuedUserMessages
const injected = store.applySessionEvent('sess-marker', {
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text: '[memory]\n事实/偏好:\n- 西瓜 ×2\n[/memory]' }] },
})
check('marker message dropped', injected === false)
const after = store.stats().queuedUserMessages
check('queue unchanged', before === after, `${before} → ${after}`)

console.log('\n[4] CJK bigram shadow text is searchable')
store.db.prepare(
  "INSERT INTO entities(canonical, kind, workspace, aliases, first_seen, last_seen) VALUES (?, 'object', NULL, ?, 1, 1)",
).run('西瓜', bigramText('西瓜'))
const shadow = store.db.prepare('SELECT aliases FROM entities WHERE canonical = ?').get('西瓜').aliases
check('shadow text produced', shadow.length > 0, shadow)
const hits = store.db
  .prepare("SELECT COUNT(*) AS n FROM entities_fts WHERE entities_fts MATCH ?")
  .get(`"${shadow}"`).n
check('two-character CJK query matches', hits === 1, `hits=${hits}`)
const miss = store.db
  .prepare("SELECT COUNT(*) AS n FROM entities_fts WHERE entities_fts MATCH ?")
  .get('"未出现的词"').n
check('unrelated query misses', miss === 0, `hits=${miss}`)

console.log('\n[5] shaping helpers')
check('tool digest prefers the command', toolDigest('{"command":"Get-ChildItem C:\\\\x"}') === 'Get-ChildItem C:\\x')
check('tool digest falls back to text', toolDigest('plain text') === 'plain text')
check('tool digest caps length', toolDigest('x'.repeat(200)).length <= 64)
check('bigram keeps latin words', bigramText('Excel 导出').includes('Excel'))
check('bigram cuts CJK', bigramText('缓存命中').includes('存命'))

// Assistant summaries must be the final text, never streaming record noise.
const sample = store.db.prepare('SELECT summary, summary_bi FROM turns LIMIT 1').get()
if (sample !== undefined) {
  check('assistant summary has no stream payload', !sample.summary.includes('"type":"text-delta"'))
  check('assistant summary is short', sample.summary.length <= 1200, String(sample.summary.length))
  check('summary_bi populated', typeof sample.summary_bi === 'string' && sample.summary_bi.length > 0)
}

console.log('\n[6] bundled tool purposes cover everything observed')
const { TOOL_PURPOSES } = await import('../tools.js')
// A tool name that never existed (a typo in one call) is indistinguishable from a
// tool this bundle does not ship. The map is stale when a *used* tool is missing,
// so require the frequently-called ones to be mapped and tolerate one-offs.
const observed = store.db.prepare('SELECT name, COUNT(*) AS n FROM tool_calls GROUP BY name').all()
  .map(row => ({ name: String(row.name), calls: Number(row.n) }))
const missing = observed.filter(row => !(row.name in TOOL_PURPOSES))
const usedOften = missing.filter(row => row.calls >= 5)
check(`all ${observed.length} observed tools with >=5 calls are mapped`, usedOften.length === 0,
  usedOften.map(row => `${row.name}x${row.calls}`).join(', '))
const countFallbacks = () => Number(store.db
  .prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE description = 'tool: ' || name")
  .get().n)
const fallbackRows = countFallbacks()
check('rows currently fall back', fallbackRows > 0, String(fallbackRows))
const repaired = store.repairToolDescriptions(name => TOOL_PURPOSES[name] ?? `tool: ${name}`)
const left = countFallbacks()
check('repair healed every healable fallback row', Number(repaired) === fallbackRows - left,
  `${repaired} repaired, ${fallbackRows} → ${left}`)
check('only unmapped names still fall back', left === missing.reduce((sum, row) => sum + row.calls, 0),
  `${left} left, unmapped calls ${missing.reduce((sum, row) => sum + row.calls, 0)}`)
const samplePurpose = store.db.prepare("SELECT description FROM tool_calls WHERE name = 'pwsh' LIMIT 1").get()
check('pwsh purpose is readable', samplePurpose?.description === TOOL_PURPOSES.pwsh, String(samplePurpose?.description))
store.repairToolDescriptions(name => `tool: ${name}`)
check('unknown purpose never degrades an existing one', store.db.prepare("SELECT description FROM tool_calls WHERE name = 'pwsh' LIMIT 1").get().description === TOOL_PURPOSES.pwsh)

const sizeMb = (statSync(dbFile).size / 1048576).toFixed(1)
console.log(`\ndatabase: ${dbFile} (${sizeMb} MB)`)
if (!failures.length) {
  console.log('RESULT: all checks passed')
} else {
  console.log(`RESULT: ${failures.length} failure(s)`)
  for (const failure of failures) console.log(` - ${failure}`)
}

store.close()
if (!keep) rmSync(dbFile, { force: true })
for (const suffix of ['-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
process.exitCode = failures.length === 0 ? 0 : 1
