#!/usr/bin/env node
/**
 * Move selected Sessions out of DSH's local store.
 *
 * DSH has no session-delete seam, so this operates on files: each Session
 * directory is MOVED to `~/.dsh/session-trash/<timestamp>/` (never unlinked), its
 * projection cache is moved too, and the workspace registry is patched with a
 * backup taken first. Nothing is destroyed, so a mistake is recoverable.
 *
 *   node test/prune-sessions.mjs            # dry run
 *   node test/prune-sessions.mjs --apply    # do it
 *
 * Restart DSH afterwards so the workspace registry reloads from disk.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = path.join(HOME, '.dsh')
const SESSIONS = path.join(DSH, 'sessions')
const PROJCACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions')
const WORKSPACE_JSON = path.join(DSH, 'storages', 'workspace.json')
const MEMORY_DB = path.join(DSH, 'storages', 'dsh-memory', 'memory.db')

/** Sessions to remove, with why. Anything not listed here is untouched. */
const TARGETS = [
  ['session-4b914510-8550-4adb-a8fc-adb6018ebd49', 'AndroidStudioProject · 验证是否成功'],
  ['session-d1753260-5e31-40de-89dc-ce19cfdf5062', 'AndroidStudioProject · 验证是否成功'],
  ['session-03017202-cd81-42fd-b36f-ec73af0e6530', 'default-workspace · 安装显示每轮对话使用量的插件'],
  ['session-1e24ea04-3d63-4d31-b142-504a02e694ea', 'default-workspace · DSH余额显示与用量轨迹插件'],
  ['session-92592623-0510-4d78-8c82-5691f312cda9', 'default-workspace · 千问2.5本地模型'],
  ['session-55cc70bf-ef54-4a26-94f7-5cdfa29579b6', 'default-workspace · (无标题)'],
  ['77568bec-a2b9-4fd0-b0f2-5d6cde416fcb', 'default-workspace · 子代理 Injection probe'],
  ['e161c4fc-c797-4394-bb76-4f476629da3a', 'default-workspace · 子代理 Injection probe m4.1'],
  ['9c7bd49f-1d4f-4ba5-b584-9e9492b9554e', 'default-workspace · 子代理 Review plugin UX'],
  ['dc69ef5e-834f-4eb2-b69f-654c62250841', 'default-workspace · 子代理 记忆库验证'],
  ['89d493b5-b1c3-4d97-b9bd-d519ed7c0488', 'default-workspace · 子代理 复习强化验证'],
  ['94cf3562-a154-4ad4-b579-435521f3a2e4', 'default-workspace · 子代理 精简注入验证'],
  ['d41299f5-8aef-4468-922d-bfa1b4884dff', 'default-workspace · 子代理 m7.1 注入测试'],
]

const KEEP = [
  'session-ca6719fe-d3a4-483e-a525-f351007839f2  ← 当前对话，绝不可删',
  'session-d6e25354-6b7f-4361-b4f6-1096070258c3  ← DSH余额卡片插件开发',
  'session-439badb4-c617-464a-bddb-dfecfc707a73  ← 浏览Android Studio猫猫项目代码',
  '1646b261-f0f8-4ea8-99a9-a7660b728fde         ← 盯采集进度（真实子代理）',
]

const apply = process.argv.includes('--apply')
const cleanStale = process.argv.includes('--clean-stale')

/** Derived rows that only describe a live Session; memory itself is kept. */
function cleanDerived(ids, store) {
  const db = store.db
  let removed = 0
  for (const id of ids) {
    for (const table of ['handoffs', 'session_briefs', 'session_cursors', 'session_models', 'sessions']) {
      try {
        removed += Number(db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(id).changes)
      } catch {
        // A table that does not exist yet is nothing to clean.
      }
    }
  }
  return removed
}

/** Locate one Session directory under any workspace folder. */
function findSessionDir(id) {
  for (const workspaceDir of readdirSync(SESSIONS)) {
    const candidate = path.join(SESSIONS, workspaceDir, id)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return { workspaceDir, dir: candidate }
    }
  }
  return null
}

const dirSize = dir => readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
  const full = path.join(dir, entry.name)
  return total + (entry.isDirectory() ? dirSize(full) : statSync(full).size)
}, 0)

const mb = bytes => `${(Number(bytes) / 1048576).toFixed(2)} MB`

console.log(`${apply ? '执行' : '试运行（加 --apply 才真正移动）'}\n`)

// `--clean-stale`: sessions recorded in the memory database but gone from disk.
if (cleanStale) {
  const { MemoryStore } = await import('../store.js')
  const store = new MemoryStore(MEMORY_DB, { describeTool: name => `tool: ${name}` })
  const onDisk = new Set()
  for (const workspace of readdirSync(SESSIONS)) {
    const dir = path.join(SESSIONS, workspace)
    if (!statSync(dir).isDirectory()) continue
    for (const entry of readdirSync(dir)) onDisk.add(entry)
  }
  const recorded = store.db.prepare('SELECT session_id FROM sessions').all().map(row => String(row.session_id))
  const stale = recorded.filter(id => !onDisk.has(id))
  console.log(`记忆库里登记了 ${recorded.length} 个会话，磁盘上找不到的有 ${stale.length} 个`)
  for (const id of stale) console.log(`  ${id}`)
  if (apply && stale.length > 0) {
    const removed = cleanDerived(stale, store)
    console.log(`\n已清理 ${removed} 行派生数据（会话身份/交接卡/简报/游标）；记忆实体与出现记录保留`)
  } else if (!apply) {
    console.log('\n试运行结束，未改动任何文件。')
  }
  store.close()
  process.exit(0)
}
console.log('保留：')
for (const line of KEEP) console.log(`  ${line}`)
console.log(`\n删除 ${TARGETS.length} 个：`)

let totalBytes = 0
const planned = []
for (const [id, label] of TARGETS) {
  const found = findSessionDir(id)
  if (found === null) {
    console.log(`  ${id}\n    ⚠ 目录不存在，跳过`)
    continue
  }
  const size = dirSize(found.dir)
  totalBytes += size
  planned.push({ id, label, ...found, size })
  console.log(`  ${id}\n    ${label} · ${mb(size)} · ${found.workspaceDir}`)
}
console.log(`\n合计 ${planned.length} 个会话，${mb(totalBytes)}`)

if (!apply) {
  console.log('\n试运行结束，未改动任何文件。')
  process.exit(0)
}

// Everything below writes. Verify every path first.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const trash = path.join(DSH, 'session-trash', stamp)
mkdirSync(trash, { recursive: true })
console.log(`\n回收目录: ${trash}（需要恢复就把目录搬回去）`)

for (const item of planned) {
  const destination = path.join(trash, item.workspaceDir, item.id)
  mkdirSync(path.dirname(destination), { recursive: true })
  renameSync(item.dir, destination)
  console.log(`  移动 ${item.id}`)
}

// Projection cache entries follow their Session.
for (const item of planned) {
  const cache = path.join(PROJCACHE, `${item.id}.json`)
  if (!existsSync(cache)) continue
  const destination = path.join(trash, 'projcache', `${item.id}.json`)
  mkdirSync(path.dirname(destination), { recursive: true })
  renameSync(cache, destination)
}

// Patch the workspace registry so the sidebar forgets them immediately.
const backup = `${WORKSPACE_JSON}.bak-${stamp}`
cpSync(WORKSPACE_JSON, backup)
const registry = JSON.parse(readFileSync(WORKSPACE_JSON, 'utf8'))
const removed = new Set(planned.map(item => item.id))
const before = JSON.stringify(registry).length
for (const workspace of Object.values(registry.tables?.workspaces ?? {})) {
  if (Array.isArray(workspace.sessionIds)) {
    workspace.sessionIds = workspace.sessionIds.filter(id => !removed.has(id))
  }
}
for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
  if (Array.isArray(registry.global?.[key])) {
    registry.global[key] = registry.global[key].filter(id => !removed.has(id))
  }
}
writeFileSync(WORKSPACE_JSON, JSON.stringify(registry, null, 2), 'utf8')
console.log(`\nworkspace.json 已更新（备份: ${path.basename(backup)}）`)
console.log(`剩余登记：${Object.values(registry.tables.workspaces).map(w => `${path.basename(w.path)}=${w.sessionIds.length}`).join(' · ')}`)
console.log('\n请重启 DSH，让会话列表按磁盘重新加载。')
