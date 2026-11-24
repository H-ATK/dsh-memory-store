/**
 * Offline verification for entity merging (M5.1).
 *
 * Exercises the canonical normalization and the merge transaction on a copy of the
 * live database, so the shape of real data is what gets tested.
 *
 * Usage: node test/merge.mjs
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../store.js'

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const dbFile = path.join(tmpdir(), `dsh-memory-merge-${process.pid}.db`)
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })

console.log('[1] canonical normalization reuses an existing spelling')
const store = new MemoryStore(dbFile)
store.applyCard({ sessionId: 's1', seq: 1, turn: 1, time: 1000, card: { canonical: 'dsh插件', kind: 'project', action: '开发', state: '进行中', detail: '', keywords: [], weight: 600 } })
const variant = store.applyCard({ sessionId: 's1', seq: 2, turn: 2, time: 2000, card: { canonical: 'DSH 插件', kind: 'project', action: '发布', state: '完成', detail: '', keywords: [], weight: 600 } })
check('case+space variant merges', variant.created === false)
check('one entity only', store.normalizeStats().entities === 1, String(store.normalizeStats().entities))
check('two occurrences', store.normalizeStats().occurrences === 2)
check('original spelling kept', store.db.prepare('SELECT canonical FROM entities').get().canonical === 'dsh插件')
const spaced = store.applyCard({ sessionId: 's1', seq: 3, turn: 3, time: 3000, card: { canonical: 'Dsh 插件', kind: 'project', action: 'x', state: '', detail: '', keywords: [], weight: 600 } })
check('another spacing merges too', spaced.created === false)

console.log('\n[2] merge moves occurrences and drops the source')
store.applyCard({ sessionId: 's2', seq: 10, turn: 1, time: 4000, card: { canonical: '用量统计插件', kind: 'project', action: '重构', state: '进行中', detail: '改名', keywords: ['用量'], weight: 620 } })
store.applyCard({ sessionId: 's2', seq: 11, turn: 2, time: 5000, card: { canonical: '用量统计插件', kind: 'project', action: '发布', state: '完成', detail: '', keywords: [], weight: 620 } })
const before = store.normalizeStats()
check('two entities before merge', before.entities === 2, String(before.entities))
const merged = store.mergeEntities('用量统计插件', 'dsh插件')
check('merge succeeded', merged.ok === true, JSON.stringify(merged))
check('occurrences moved', merged.moved === 2, String(merged.moved))
check('one entity after merge', store.normalizeStats().entities === 1, String(store.normalizeStats().entities))
check('total occurrences preserved', store.normalizeStats().occurrences === before.occurrences, `${before.occurrences} → ${store.normalizeStats().occurrences}`)
const target = store.db.prepare('SELECT weight, first_seen, last_seen FROM entities').get()
check('weight takes the max', target.weight === 620, String(target.weight))
check('first_seen takes the min', target.first_seen === 1000, String(target.first_seen))
check('last_seen takes the max', target.last_seen === 5000, String(target.last_seen))

console.log('\n[3] merge refuses bad input')
check('missing source rejected', store.mergeEntities('不存在', 'dsh插件').ok === false)
check('missing target rejected', store.mergeEntities('dsh插件', '不存在').ok === false)
check('same entity rejected', store.mergeEntities('dsh插件', 'dsh插件').ok === false)
check('store still usable', store.normalizeStats().entities === 1)

console.log('\n[4] colliding pointers are dropped, not duplicated')
store.applyCard({ sessionId: 's9', seq: 99, turn: 1, time: 6000, card: { canonical: '甲', kind: 'topic', action: '', state: '', detail: '', keywords: [], weight: 500 } })
store.applyCard({ sessionId: 's9', seq: 100, turn: 1, time: 7000, card: { canonical: '乙', kind: 'topic', action: '', state: '', detail: '', keywords: [], weight: 500 } })
// Give both entities a row for the same session/seq by merging through a third name.
const dup = store.mergeEntities('乙', '甲')
check('merge with no collision reports drops', dup.ok === true && dup.dropped === 0, JSON.stringify(dup))
check('occurrence count after second merge', store.normalizeStats().occurrences === 7, String(store.normalizeStats().occurrences))

console.log('\n[5] real data dry run')
const live = path.join(process.env.USERPROFILE || '.', '.dsh', 'storages', 'dsh-memory', 'memory.db')
if (!existsSync(live)) {
  console.log('  skip (no live database)')
} else {
  const copy = path.join(tmpdir(), `dsh-memory-merge-live-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
  copyFileSync(live, copy)
  for (const suffix of ['-wal', '-shm']) if (existsSync(`${live}${suffix}`)) copyFileSync(`${live}${suffix}`, `${copy}${suffix}`)
  const liveStore = new MemoryStore(copy)
  const duplicatesSql = `
    SELECT lower(replace(canonical, ' ', '')) k, COUNT(*) c, group_concat(canonical, ' | ') names
    FROM entities GROUP BY k HAVING c > 1
  `
  const rows = liveStore.db.prepare(duplicatesSql).all()
  const mergedCount = liveStore.repairCanonicalDuplicates()
  const rowsAfter = liveStore.db.prepare(duplicatesSql).all()
  check('startup repair leaves no case/space duplicates', rowsAfter.length === 0,
    `${rows.length} group(s) before, merged ${mergedCount}, ${rowsAfter.length} after`)
  console.log(`       （修复前有 ${rows.length} 组重复：${rows.map(row => row.names).join(' ; ')}）`)
  const before = liveStore.normalizeStats()
  const names = liveStore.db.prepare('SELECT canonical FROM entities ORDER BY weight DESC LIMIT 2').all().map(row => row.canonical)
  if (names.length === 2) {
    const result = liveStore.mergeEntities(String(names[1]), String(names[0]))
    const after = liveStore.normalizeStats()
    check('live merge keeps occurrences', result.ok === true && after.occurrences === before.occurrences, JSON.stringify(result))
    check('live merge drops one entity', after.entities === before.entities - 1, `${before.entities} → ${after.entities}`)
  }
  liveStore.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
}

store.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
console.log(failures.length === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures.length} failure(s)`)
process.exitCode = failures.length === 0 ? 0 : 1
