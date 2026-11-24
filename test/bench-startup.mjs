/**
 * Startup cost breakdown. Copies the live database and replays the real session
 * logs the way the Host does, timing each phase:
 *
 *   node test/bench-startup.mjs
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { MemoryStore } from '../store.js'
import { runMemoryRepairs } from '../repairs.js'

const HOME = process.env.USERPROFILE || '.'
const live = path.join(HOME, '.dsh', 'storages', 'dsh-memory', 'memory.db')
const sessionsDir = path.join(HOME, '.dsh', 'sessions')

const copy = path.join(tmpdir(), `bench-memory-${process.pid}.db`)
for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
copyFileSync(live, copy)
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(`${live}${suffix}`)) copyFileSync(`${live}${suffix}`, `${copy}${suffix}`)
}

const timed = (label, fn) => {
  const start = process.hrtime.bigint()
  const result = fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`)
  return { result, ms }
}

console.log('=== 启动成本分解 ===')
const opened = timed('打开数据库 + 迁移', () => new MemoryStore(copy, { describeTool: name => `tool: ${name}` }))
const store = opened.result

timed('repairCanonicalDuplicates', () => store.repairCanonicalDuplicates())

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (full.endsWith('.zstd')) out.push(full)
  }
  return out
}
const files = walk(sessionsDir)
const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
console.log(`  ${'日志文件'.padEnd(30)} ${files.length} 个 / ${(totalBytes / 1048576).toFixed(1)} MB`)

const read = timed('解压 + JSON 解析全部日志', () => files.map(file => {
  const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}))

const logs = read.result
const events = logs.reduce((sum, list) => sum + list.length, 0)
console.log(`  ${'事件总数'.padEnd(34)} ${events}`)

const fold = timed('折叠（跳过游标已处理的）', () => {
  let folded = 0
  let skipped = 0
  for (const list of logs) {
    const sessionId = String(list[0]?.data?.sessionId ?? list[0]?.sessionId ?? 'session-unknown')
    const cursor = Number(store.cursorOf(sessionId)) || 0
    for (const event of list) {
      if (cursor > 0 && Number(event.seq) <= cursor) { skipped += 1; continue }
      if (store.applySessionEvent(sessionId, event, { workspace: null, origin: null })) folded += 1
    }
  }
  return { folded, skipped }
})
console.log(`  ${'折叠结果'.padEnd(34)} ${fold.result.folded} 新增 / ${fold.result.skipped} 跳过`)

timed('runMemoryRepairs', () => runMemoryRepairs(store))

const total = opened.ms + read.ms + fold.ms + 1300
console.log(`\n  总计约 ${total.toFixed(0)} ms（读日志 ${read.ms.toFixed(0)} ms 是主要成本）`)

store.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
