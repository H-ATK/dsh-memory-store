#!/usr/bin/env node
/**
 * Memory store inspector — one entry point for the diagnostics that used to be a
 * pile of one-off scripts.
 *
 * Read commands copy the database to a temp file first, so they never touch the
 * live file and never fight the Host for a write lock. `repair` is the only
 * command that writes, and it says so.
 *
 *   node test/inspect.mjs status
 *   node test/inspect.mjs entities [--limit 40] [--filter 文本]
 *   node test/inspect.mjs sessions [--limit 20]
 *   node test/inspect.mjs injected [--limit 5]
 *   node test/inspect.mjs links [--limit 10]
 *   node test/inspect.mjs recall "查询" [--items 5] [--min 0.5]
 *   node test/inspect.mjs brief [--items 3]
 *   node test/inspect.mjs calls [--limit 30]
 *   node test/inspect.mjs queue
 *   node test/inspect.mjs corpus
 *   node test/inspect.mjs logs [--limit 2]
 *   node test/inspect.mjs repair
 *
 * See docs/TROUBLESHOOTING.zh.md for the symptom → command table.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { MemoryStore, RUNTIME_MESSAGE_PREFIXES, isHumanMessage } from '../store.js'
import { describeChange, renderBrief, retrieve } from '../retrieve.js'

const LIVE = process.env.DSH_MEMORY_DB
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'storages', 'dsh-memory', 'memory.db')
const SESSIONS = process.env.DSH_MEMORY_SESSIONS
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions')

const argv = process.argv.slice(2)
const command = argv[0] ?? 'status'
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const positional = argv.slice(1).filter(arg => !arg.startsWith('--'))
const positionalValue = () => {
  const index = argv.indexOf('--items')
  const beforeFlag = argv.slice(1).findIndex(arg => arg.startsWith('--'))
  const words = beforeFlag === -1 ? positional : positional.slice(0, beforeFlag)
  return words.join(' ').trim()
}

const num = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const when = time => new Date(Number(time) || 0).toLocaleString('zh-CN', { hour12: false })
const mb = bytes => `${(Number(bytes) / 1048576).toFixed(2)} MB`
const kb = bytes => `${(Number(bytes) / 1024).toFixed(0)} KB`
const pad = (value, width) => String(value).padEnd(width)

/** Open a throwaway copy so read commands cannot disturb the live database. */
function openCopy() {
  if (!existsSync(LIVE)) {
    console.error(`数据库不存在: ${LIVE}\n先让 DSH 运行一次插件。`)
    process.exit(2)
  }
  const copy = path.join(tmpdir(), `dsh-memory-inspect-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
  copyFileSync(LIVE, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${LIVE}${suffix}`)) copyFileSync(`${LIVE}${suffix}`, `${copy}${suffix}`)
  }
  const store = new MemoryStore(copy, { describeTool: name => `tool: ${name}` })
  const close = () => {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
  }
  return { store, close }
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

function sessionFiles() {
  if (!existsSync(SESSIONS)) return []
  return walkFiles(SESSIONS)
    .map(file => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
}

function readEvents(file) {
  try {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
    return text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

const bodyOf = blocks => (Array.isArray(blocks) ? blocks : [])
  .filter(block => block && block.type === 'text')
  .map(block => block.text)
  .join('\n')

/** The Session the preview pretends to be: the most recently active one. */
function selfSessionId(store) {
  if (argv.includes('--include-self')) return ''
  try {
    const row = store.db.prepare('SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT 1').get()
    return row === undefined ? '' : String(row.session_id)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
const commands = {
  /** Everything about the current state, in one screen. */
  status() {
    const { store, close } = openCopy()
    const db = store.db
    const one = sql => Number(db.prepare(sql).get().n)
    const meta = key => store.getMeta(key)

    console.log(`database   ${LIVE}`)
    for (const name of readdirSync(path.dirname(LIVE))) {
      console.log(`  ${pad(name, 16)} ${mb(statSync(path.join(path.dirname(LIVE), name)).size)}`)
    }
    console.log(`build      ${meta('build') ?? '(无)'}`)
    console.log(`schema     ${db.prepare('PRAGMA user_version').get().user_version}`)
    console.log(`activated  ${when(Date.parse(meta('activatedAt') ?? ''))}`)
    console.log(`target     ${meta('normalizeTarget') ?? '(无)'}`)

    console.log('\n内容')
    console.log(`  实体 ${one('SELECT COUNT(*) n FROM entities')} · 出现 ${one('SELECT COUNT(*) n FROM occurrences')} · 会话 ${one('SELECT COUNT(*) n FROM sessions')} · 联想 ${one('SELECT COUNT(*) n FROM entity_links')}`)
    console.log(`  轮次 ${one('SELECT COUNT(*) n FROM turns')} · 工具 ${one('SELECT COUNT(*) n FROM tool_calls')} · 子代理 ${one('SELECT COUNT(*) n FROM subagent_runs')} · 已注入 ${one('SELECT COUNT(*) n FROM injected_messages')}`)
    const queue = db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN done_at IS NULL AND skipped IS NULL AND attempts < 3 THEN 1 ELSE 0 END) pending,
             SUM(CASE WHEN skipped IS NOT NULL THEN 1 ELSE 0 END) skipped,
             SUM(CASE WHEN attempts >= 3 AND done_at IS NULL THEN 1 ELSE 0 END) dead
      FROM normalize_queue
    `).get()
    console.log(`  队列 总 ${queue.total} · 待处理 ${queue.pending ?? 0} · 跳过 ${queue.skipped ?? 0} · 放弃 ${queue.dead ?? 0}`)
    const calls = db.prepare(`
      SELECT COUNT(*) calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) fails,
             SUM(input_tokens) tin, SUM(output_tokens) tout FROM normalize_log
    `).get()
    console.log(`  归一化 ${calls.calls} 次（失败 ${calls.fails ?? 0}）· 输入 ${calls.tin ?? 0} / 输出 ${calls.tout ?? 0} token`)
    console.log(`  复习 ${one('SELECT COUNT(*) n FROM entities WHERE use_count > 0')} 个对象 · 简报 ${one('SELECT COUNT(*) n FROM session_briefs')} 个会话`)

    const inject = meta('inject')
    console.log('\n最近一次注入')
    if (inject === undefined) console.log('  (无)')
    else {
      const parsed = JSON.parse(inject)
      console.log(`  ${when(parsed.at)} · ${parsed.mode ?? 'recall'} · ${parsed.items} 条 · ${parsed.tokens} token`)
      console.log(`  ${(parsed.names ?? []).join(' / ')}`)
    }

    const repairs = ['canonicalRepair', 'turnRepair', 'linkRepair', 'toolRepair']
      .filter(key => meta(key) !== undefined)
    if (repairs.length > 0) {
      console.log('\n自愈记录')
      for (const key of repairs) console.log(`  ${pad(key, 16)} ${meta(key)}`)
    }
    close()
  },

  /** Objects with mentions, weight, reviews and the last action. */
  entities() {
    const limit = num(flag('limit', 40), 40)
    const filter = flag('filter', '')
    const { store, close } = openCopy()
    const rows = store.db.prepare(`
      SELECT e.canonical, e.kind, e.weight, e.use_count, e.last_seen,
             COUNT(o.id) AS mentions,
             (SELECT action FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS action,
             (SELECT state  FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS state,
             (SELECT detail FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS detail
      FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id
      GROUP BY e.id
      ORDER BY mentions DESC, e.last_seen DESC
      LIMIT ?
    `).all(limit)
    console.log(`${pad('对象', 20)} ${pad('类型', 10)} ${pad('次数', 5)} ${pad('复习', 5)} ${pad('权重', 5)} 最近`)
    for (const row of rows) {
      const line = [row.action, row.state, row.detail].filter(Boolean).join(' / ')
      if (filter !== '' && !String(row.canonical).includes(filter) && !line.includes(filter)) continue
      console.log(`${pad(row.canonical, 20)} ${pad(row.kind, 10)} ${pad(row.mentions, 5)} ${pad(row.use_count, 5)} ${pad(row.weight, 5)} ${when(row.last_seen)}`)
      if (line !== '') console.log(`${' '.repeat(22)}└ ${line.slice(0, 90)}`)
    }
    close()
  },

  /** Sessions, their titles/labels, and which workspace they belong to. */
  sessions() {
    const limit = num(flag('limit', 20), 20)
    const { store, close } = openCopy()
    console.log(`${pad('时间', 20)} ${pad('来源', 9)} ${pad('名字', 26)} 工作区`)
    for (const row of store.sessionsOf(limit)) {
      const name = String(row.origin) === 'subagent'
        ? (row.label || row.run_name || row.title || '(无名)')
        : (row.title || '(无标题)')
      console.log(`${pad(when(row.updated_at), 20)} ${pad(row.origin ?? 'main', 9)} ${pad(String(name).slice(0, 26), 26)} ${String(row.workspace ?? '-')}`)
    }
    const stats = store.db.prepare(`
      SELECT COALESCE(workspace, '(无)') w, COUNT(*) n FROM sessions GROUP BY w ORDER BY n DESC
    `).all()
    console.log('\n工作区分布')
    for (const row of stats) console.log(`  ${pad(row.w, 58)} ${row.n} 个会话`)
    try {
      const models = store.db.prepare('SELECT session_id, provider, model, at FROM session_models ORDER BY at DESC LIMIT 8').all()
      if (models.length > 0) {
        console.log('\n记录的会话模型（整理时跟随）')
        for (const row of models) {
          console.log(`  ${pad(String(row.session_id).slice(0, 22), 24)} ${pad(`${row.provider}/${row.model}`.slice(0, 48), 48)} ${when(row.at)}`)
        }
      }
    } catch {
      // Older databases have no session_models table until the next activation.
    }
    close()
  },

  /** Injected notes, with the exact text recovered from the session log. */
  injected() {
    const limit = num(flag('limit', 5), 5)
    const { store, close } = openCopy()
    const rows = store.db.prepare('SELECT message_id, at FROM injected_messages ORDER BY at DESC LIMIT ?').all(limit)
    close()
    if (rows.length === 0) {
      console.log('还没有注入记录')
      return
    }
    const wanted = new Map(rows.map(row => [String(row.message_id), Number(row.at)]))
    let found = 0
    for (const { file } of sessionFiles().slice(0, 12)) {
      for (const event of readEvents(file)) {
        if (event.type !== 'user/message') continue
        const data = event.data ?? {}
        const message = data.message ?? data
        const id = String(message?.id ?? '')
        if (!wanted.has(id)) continue
        found += 1
        const body = bodyOf(message?.content)
        console.log(`\n[${when(wanted.get(id))}] ${path.basename(path.dirname(file)).slice(0, 20)} seq ${event.seq}`)
        console.log(`  ${body}`)
        console.log(`  ${body.length} 字符 · 约 ${Math.ceil(body.length / 1.6)} token · 含标记 ${body.includes('[memory]')}`)
      }
    }
    console.log(`\n在会话日志里找到 ${found} / ${rows.length} 条`)
  },

  /** Association edges, and what a recall would pull in from a seed. */
  links() {
    const limit = num(flag('limit', 10), 10)
    const { store, close } = openCopy()
    const total = Number(store.db.prepare('SELECT COUNT(*) n FROM entity_links').get().n)
    console.log(`联想边 ${total} 条`)
    for (const row of store.db.prepare(`
      SELECT ea.canonical a, eb.canonical b, l.co_count, l.last_at
      FROM entity_links l JOIN entities ea ON ea.id = l.a JOIN entities eb ON eb.id = l.b
      ORDER BY l.co_count DESC, l.last_at DESC LIMIT ?
    `).all(limit)) {
      console.log(`  ${pad(row.a, 18)} ↔ ${pad(row.b, 18)} 共现 ${row.co_count} 次 · ${when(row.last_at)}`)
    }
    console.log('\n从高权重对象出发的联想')
    for (const seed of store.db.prepare('SELECT id, canonical FROM entities ORDER BY weight DESC LIMIT 3').all()) {
      const related = store.relatedItems([Number(seed.id)], 1, 2)
      console.log(`  ${pad(seed.canonical, 18)} → ${related.map(item => item.canonical).join('、') || '(无)'}`)
    }
    close()
  },

  /** Preview exactly what a recall would inject for one query. */
  async recall() {
    const query = positionalValue()
    if (query === '') {
      console.error('用法: node test/inspect.mjs recall "查询文本"')
      process.exit(2)
    }
    const items = num(flag('items', 5), 5)
    const minScore = num(flag('min', 0.5), 0.5)
    const { store, close } = openCopy()
    const workspace = store.db.prepare(`
      SELECT workspace FROM sessions WHERE workspace IS NOT NULL ORDER BY updated_at DESC LIMIT 1
    `).get()?.workspace ?? null
    const handoff = store.recentHandoff({ hours: 12, excludeSessionId: selfSessionId(store) })
    // `--semantic <model>` embeds the query with the given model and merges the
    // vector hits, exactly like the Host does when embedModel is configured.
    const semanticModel = flag('semantic', '')
    let extraItems = []
    if (semanticModel !== '') {
      try {
        const response = await fetch('http://127.0.0.1:11434/api/embed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: semanticModel, input: [query] }),
          signal: AbortSignal.timeout(60_000),
        })
        const payload = await response.json()
        const vector = payload?.embeddings?.[0]
        if (Array.isArray(vector)) {
          extraItems = store.vectorRecall(vector, {
            limit: 3,
            minSimilarity: num(flag('min-sim', 0.55), 0.55),
            model: semanticModel,
            workspace,
          })
        }
      } catch (error) {
        console.log(`  语义检索失败: ${error?.message ?? error}`)
      }
    }
    const found = retrieve(store, query, {
      budgetTokens: 160,
      minScore,
      maxItems: items,
      workspace,
      extraItems,
      change: handoff === null ? null : describeChange(handoff.files),
    })
    console.log(`查询: ${query}${workspace === null ? '' : `（当前工作区 ${path.basename(workspace)}）`}${semanticModel === '' ? '' : `（+语义 ${semanticModel}）`}`)
    if (found.text === null) {
      console.log('  结果: 无命中（不会注入）')
    } else {
      console.log(`  注入文本: ${found.text}`)
      console.log(`  ${found.items.length} 条直接命中 + ${found.related.length} 条联想 · 约 ${found.tokens} token`)
      console.log('\n  明细')
      for (const item of found.items) {
        console.log(`    ${pad(item.canonical, 18)} ${pad(item.kind, 10)} 分 ${Number(item.score).toFixed(3)} · 共享 ${item.shared} · 复习 ${item.reviews} · 本工作区 ${item.inWorkspace ? '是' : '否'} · ${when(item.lastSeen)}`)
      }
      if (found.related.length > 0) {
        console.log(`\n  联想: ${found.related.map(item => item.canonical).join('、')}`)
      }
      if (handoff !== null) {
        console.log(`\n  交接卡: ${handoff.files.length} 个文件 · ${when(handoff.at)} · 来自会话 ${handoff.sessionId.slice(0, 14)}`)
        for (const file of handoff.files.slice(0, 3)) console.log(`    ${file}`)
      }
    }
    close()
  },

  /** Preview the one-time brief a brand-new session would receive. */
  brief() {
    const items = num(flag('items', 3), 3)
    const { store, close } = openCopy()
    const brief = store.recentBrief(items)
    const handoff = store.recentHandoff({ hours: 24, excludeSessionId: selfSessionId(store) })
    const style = store.styleProfile()
    const line = renderBrief(brief, {
      project: store.recentProject(),
      change: handoff === null ? null : describeChange(handoff.files),
      style: style.ready ? style.labels : null,
    })
    if (line === null) console.log('(不会发送：实体不足 3 个)')
    else {
      console.log(`简报: ${line}`)
      console.log(`约 ${Math.ceil(line.length / 1.6)} token · 覆盖 ${brief.total} 个对象`)
    }
    console.log('\n最近活跃的对象（跨工作区）')
    for (const row of store.db.prepare(`
      SELECT e.canonical, e.kind, MAX(o.time) last_at, COUNT(DISTINCT s.workspace) workspaces
      FROM occurrences o JOIN entities e ON e.id = o.entity_id
      LEFT JOIN sessions s ON s.session_id = o.session_id
      GROUP BY e.id ORDER BY last_at DESC LIMIT 5
    `).all()) {
      console.log(`  ${pad(row.canonical, 18)} ${pad(row.kind, 10)} 涉及 ${row.workspaces} 个工作区 · ${when(row.last_at)}`)
    }
    if (handoff !== null) {
      console.log('\n交接卡（另一个窗口最近的改动）')
      console.log(`  ${when(handoff.at)} · ${handoff.files.length} 个文件`)
      for (const file of handoff.files.slice(0, 4)) console.log(`    ${file}`)
    }
    close()
  },

  /** Tool calls, grouped, with the latest digests. */
  calls() {
    const limit = num(flag('limit', 30), 30)
    const { store, close } = openCopy()
    console.log('按工具汇总')
    for (const row of store.db.prepare(`
      SELECT name, description, COUNT(*) n FROM tool_calls GROUP BY name ORDER BY n DESC LIMIT ?
    `).all(limit)) {
      console.log(`  ${pad(row.name, 22)} ${pad(row.n, 6)} ${row.description}`)
    }
    console.log('\n最近 5 次')
    for (const row of store.db.prepare('SELECT name, digest, time FROM tool_calls ORDER BY time DESC LIMIT 5').all()) {
      console.log(`  ${when(row.time)} ${pad(row.name, 20)} ${String(row.digest ?? '').slice(0, 60)}`)
    }
    const fallback = Number(store.db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE description = 'tool: ' || name").get().n)
    console.log(`\n退回占位描述的行: ${fallback}`)
    close()
  },

  /** Normalization queue and failed calls, including the raw model reply. */
  queue() {
    const limit = num(flag('limit', 8), 8)
    const { store, close } = openCopy()
    const db = store.db
    const stats = db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN done_at IS NULL AND skipped IS NULL AND attempts < 3 THEN 1 ELSE 0 END) pending,
             SUM(CASE WHEN skipped IS NOT NULL THEN 1 ELSE 0 END) skipped,
             SUM(CASE WHEN attempts >= 3 AND done_at IS NULL THEN 1 ELSE 0 END) dead
      FROM normalize_queue
    `).get()
    console.log(`队列 总 ${stats.total} · 待处理 ${stats.pending ?? 0} · 跳过 ${stats.skipped ?? 0} · 放弃 ${stats.dead ?? 0}`)
    console.log('\n跳过原因')
    for (const row of db.prepare('SELECT skipped, COUNT(*) n FROM normalize_queue WHERE skipped IS NOT NULL GROUP BY skipped ORDER BY n DESC').all()) {
      console.log(`  ${pad(row.skipped, 16)} ${row.n}`)
    }
    console.log('\n失败原因')
    for (const row of db.prepare('SELECT error, COUNT(*) n FROM normalize_log WHERE ok = 0 GROUP BY error ORDER BY n DESC').all()) {
      console.log(`  ${pad(String(row.error).slice(0, 50), 50)} ${row.n}`)
    }
    console.log(`\n最近 ${limit} 次失败（含模型原文）`)
    for (const row of db.prepare(`
      SELECT n.id, n.error, n.input_tokens, n.output_tokens, n.raw, q.text
      FROM normalize_log n LEFT JOIN normalize_queue q ON q.id = n.queue_id
      WHERE n.ok = 0 ORDER BY n.id DESC LIMIT ?
    `).all(limit)) {
      console.log(`  #${row.id} ${row.error} in=${row.input_tokens} out=${row.output_tokens}`)
      console.log(`    输入: ${String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`)
      console.log(`    输出: ${row.raw === null ? '(未记录)' : String(row.raw).slice(0, 200)}`)
    }
    close()
  },

  /** Corpus size versus what the store keeps — the "store full text?" answer. */
  corpus() {
    let userText = 0
    let assistantText = 0
    let toolText = 0
    let turns = 0
    for (const { file } of sessionFiles()) {
      for (const event of readEvents(file)) {
        if (event.type === 'turn/start') turns += 1
        else if (event.type === 'user/message') userText += Buffer.byteLength(bodyOf((event.data?.message ?? event.data)?.content), 'utf8')
        else if (event.type === 'assistant/message') assistantText += Buffer.byteLength(bodyOf(event.data?.message?.content), 'utf8')
        else if (event.type === 'tool/result') toolText += Buffer.byteLength(bodyOf(event.data?.message?.content), 'utf8')
      }
    }
    const { store, close } = openCopy()
    const dbSize = statSync(LIVE).size
    const storedTurns = Number(store.db.prepare('SELECT COALESCE(SUM(length(summary)), 0) n FROM turns').get().n)
    close()
    console.log(`语料 ${turns} 轮`)
    console.log(`  用户原文      ${mb(userText)}`)
    console.log(`  助手最终正文   ${mb(assistantText)}`)
    console.log(`  工具结果正文   ${mb(toolText)}`)
    console.log(`\n记忆库 ${mb(dbSize)}（其中轮次摘要 ${kb(storedTurns)}）`)
    console.log(`  若全存对话正文：${mb(dbSize - storedTurns + userText + assistantText)}（+${mb(userText + assistantText)}）`)
    console.log(`  连工具结果一起：${mb(dbSize - storedTurns + userText + assistantText + toolText)}（+${mb(userText + assistantText + toolText)}）`)
  },

  /** Newest session logs, with any error/stop reason and the last events. */
  logs() {
    const limit = num(flag('limit', 2), 2)
    const files = sessionFiles().slice(0, limit)
    if (files.length === 0) {
      console.log('没有找到会话日志')
      return
    }
    for (const { file, mtime } of files) {
      const events = readEvents(file)
      console.log(`\n=== ${path.basename(path.dirname(file)).slice(0, 40)} (${when(mtime)}) — ${events.length} 事件 ===`)
      for (const event of events) {
        const type = String(event.type ?? '')
        if (/error|fail|abort|retry/i.test(type)) {
          console.log(`  [${type}] seq ${event.seq}: ${JSON.stringify(event.data ?? {}).slice(0, 300)}`)
        }
      }
      const end = [...events].reverse().find(event => event.type === 'turn/end')
      if (end !== undefined) console.log(`  最后 turn/end: ${JSON.stringify(end.data?.reason)}`)
      console.log('  最后 4 条事件:')
      for (const event of events.slice(-4)) {
        console.log(`    ${when(event.time)} ${event.type}: ${JSON.stringify(event.data ?? {}).slice(0, 140)}`)
      }
    }
  },

  /** Normalization calls grouped by provider/model, with success rate. */
  models() {
    const { store, close } = openCopy()
    console.log(`${pad('provider', 18)} ${pad('model', 42)} ${pad('调用', 6)} ${pad('失败', 6)} ${pad('成功率', 8)} 输出均值`)
    for (const row of store.db.prepare(`
      SELECT provider, model, COUNT(*) calls,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) fails,
             AVG(output_tokens) avgOut,
             MAX(at) lastAt
      FROM normalize_log GROUP BY provider, model ORDER BY calls DESC
    `).all()) {
      const calls = Number(row.calls)
      const fails = Number(row.fails ?? 0)
      const rate = calls === 0 ? 0 : ((calls - fails) / calls) * 100
      console.log(`${pad(String(row.provider ?? '-').slice(0, 18), 18)} ${pad(String(row.model ?? '-').slice(0, 42), 42)} ${pad(calls, 6)} ${pad(fails, 6)} ${pad(`${rate.toFixed(1)}%`, 8)} ${Number(row.avgOut ?? 0).toFixed(0)}`)
    }
    console.log('\n最近 5 次调用')
    for (const row of store.db.prepare(`
      SELECT at, provider, model, ok, input_tokens, output_tokens, error
      FROM normalize_log ORDER BY id DESC LIMIT 5
    `).all()) {
      console.log(`  ${when(row.at)} ${pad(`${row.provider}/${row.model}`.slice(0, 46), 46)} ok=${row.ok} in=${row.input_tokens} out=${row.output_tokens} ${row.error ?? ''}`)
    }
    close()
  },

  /** Files touched by write-class tools, grouped by time — the handoff material. */
  changes() {
    const limit = num(flag('limit', 10), 10)
    const { store, close } = openCopy()
    const rows = store.db.prepare(`
      SELECT session_id, name, digest, time FROM tool_calls
      WHERE name IN ('edit','write','apply_patch') AND digest IS NOT NULL
      ORDER BY time DESC LIMIT 300
    `).all()
    console.log('写入类工具调用（原始记录）')
    for (const row of rows.slice(0, limit)) {
      console.log(`  ${when(row.time)} ${pad(row.name, 6)} ${String(row.session_id).slice(0, 12)} ${String(row.digest).slice(0, 70)}`)
    }
    const buckets = new Map()
    for (const row of rows) {
      const key = `${String(row.session_id).slice(0, 12)} · ${when(row.time).slice(0, 16)}`
      if (!buckets.has(key)) buckets.set(key, new Set())
      const file = String(row.digest).split(' ')[0]
      if (file.includes('\\') || file.includes('/')) buckets.get(key).add(file)
    }
    console.log('\n按时间聚合（可做成交接卡）')
    let shown = 0
    for (const [key, files] of buckets) {
      if (files.size === 0) continue
      console.log(`  ${pad(key, 30)} → ${[...files].map(file => file.slice(-40)).join(' , ')}`)
      if (++shown >= limit) break
    }
    console.log(`\n共 ${buckets.size} 个时间段有文件改动`)
    close()
  },

  /**
   * Write command: drop memories that came from DSH's synthetic runtime context
   * (time snapshots, reminders). Those messages were normalized before the capture
   * filter existed and produced a high-frequency object like "时区偏好×102".
   */
  purgeContext() {
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const rows = store.db.prepare('SELECT id, session_id, seq, text FROM normalize_queue').all()
    const doomed = rows.filter(row => RUNTIME_MESSAGE_PREFIXES.some(prefix => String(row.text ?? '').startsWith(prefix)))
    console.log(`队列里命中运行时上下文的行: ${doomed.length} / ${rows.length}`)
    let occurrences = 0
    const removeQueue = store.db.prepare('DELETE FROM normalize_queue WHERE id = ?')
    const removeOccurrence = store.db.prepare('DELETE FROM occurrences WHERE session_id = ? AND seq = ?')
    store.db.exec('BEGIN')
    try {
      for (const row of doomed) {
        occurrences += Number(removeOccurrence.run(row.session_id, row.seq).changes)
        removeQueue.run(row.id)
      }
      store.db.exec('COMMIT')
    } catch (error) {
      store.db.exec('ROLLBACK')
      console.error('回滚:', error.message)
      store.close()
      return
    }
    // Edges reference entities, so drop the edges that touch an orphan first.
    store.db.exec(`
      DELETE FROM entity_links
      WHERE a IN (SELECT id FROM entities WHERE id NOT IN (SELECT entity_id FROM occurrences))
         OR b IN (SELECT id FROM entities WHERE id NOT IN (SELECT entity_id FROM occurrences))
    `)
    const orphans = Number(store.db.prepare(`
      DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM occurrences)
    `).run().changes)
    console.log(`删除出现记录 ${occurrences} 条 · 队列行 ${doomed.length} · 空实体 ${orphans} 个`)
    for (const row of store.db.prepare('SELECT canonical, COUNT(o.id) n FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id GROUP BY e.id ORDER BY n DESC LIMIT 5').all()) {
      console.log(`  现在最多: ${row.canonical} ×${row.n}`)
    }
    store.close()
  },

  /**
   * Write command: re-queue human messages that the capture missed (for example
   * rows dropped by an earlier filter bug). Idempotent: rows already queued or
   * already turned into an occurrence are skipped.
   */
  requeue() {
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const injected = new Set(store.db.prepare('SELECT message_id FROM injected_messages').all().map(row => String(row.message_id)))
    const known = new Set([
      ...store.db.prepare('SELECT session_id, seq FROM normalize_queue').all().map(row => `${row.session_id}#${row.seq}`),
      ...store.db.prepare('SELECT session_id, seq FROM occurrences').all().map(row => `${row.session_id}#${row.seq}`),
    ])
    const insert = store.db.prepare(
      'INSERT OR IGNORE INTO normalize_queue(session_id, seq, text, added_at, turn) VALUES (?, ?, ?, ?, ?)',
    )
    const textOf = blocks => bodyOf(blocks).replace(/\s+/g, ' ').trim()
    let added = 0
    for (const { file } of sessionFiles()) {
      const sessionId = path.basename(path.dirname(file))
      let turn = 0
      for (const event of readEvents(file)) {
        if (event.type === 'turn/start') {
          turn = Number(event.data?.turn) || turn
          continue
        }
        if (event.type !== 'user/message') continue
        const data = event.data ?? {}
        const message = data.message ?? data
        const id = String(message?.id ?? '')
        if (id !== '' && injected.has(id)) continue
        const text = textOf(message?.content)
        if (!isHumanMessage(message, text)) continue
        const key = `${sessionId}#${event.seq}`
        if (known.has(key)) continue
        const result = insert.run(sessionId, Number(event.seq), text.slice(0, 1200), Number(event.time) || Date.now(), turn)
        if (Number(result.changes) > 0) {
          added += 1
          known.add(key)
        }
      }
    }
    const pending = Number(store.db.prepare(
      'SELECT COUNT(*) n FROM normalize_queue WHERE done_at IS NULL AND skipped IS NULL AND attempts < 3',
    ).get().n)
    console.log(`补回 ${added} 条用户消息 · 队列待处理 ${pending}`)
    store.close()
  },

  /** Write command: fold repeated occurrences and archive long-faded objects. */
  consolidate() {
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const folded = store.consolidate({ days: num(flag('days', 30), 30) })
    const archived = store.archiveStale({ days: num(flag('archive-days', 180), 180) })
    console.log(`巩固：扫描 ${folded.scanned} 条出现，折叠重复 ${folded.removed} 条`)
    console.log(`归档：${archived.archived} 个长期未用对象移出召回（仍在库中）`)
    store.close()
  },

  /** Write command: compute and store semantic vectors for pending objects. */
  async embed() {
    const model = String(flag('model', 'bge-m3'))
    const url = String(flag('url', 'http://127.0.0.1:11434/api/embed'))
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const rows = store.entitiesForEmbedding(model, 500)
    console.log(`需要向量: ${rows.length} 个（模型 ${model}）`)
    let stored = 0
    for (let index = 0; index < rows.length; index += 8) {
      const chunk = rows.slice(index, index + 8)
      const texts = chunk.map(row => `${row.canonical} ${row.action ?? ''} ${row.detail ?? ''}`.trim())
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        console.log(`  第 ${index + 1} 批失败: HTTP ${response.status}`)
        break
      }
      const payload = await response.json()
      const vectors = Array.isArray(payload?.embeddings) ? payload.embeddings : []
      for (let offset = 0; offset < chunk.length; offset += 1) {
        if (Array.isArray(vectors[offset]) && store.saveVector(chunk[offset].id, vectors[offset], model)) stored += 1
      }
      process.stdout.write(`\r  已写入 ${stored}`)
    }
    console.log(`\n完成：${stored} 个向量`)
    store.close()
  },

  /** Write command: split recent occurrences of one object into a new name. */
  split() {
    const words = argv.slice(1).filter(argument => !argument.startsWith('--'))
    const from = String(words[0] ?? '')
    const to = String(words[1] ?? '')
    if (from === '' || to === '') {
      console.error('用法: node test/inspect.mjs split "旧对象名" "新对象名" [--days 7]')
      process.exit(2)
    }
    const days = num(flag('days', 0), 0)
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const result = store.splitEntity(from, to, { since: days > 0 ? Date.now() - days * 86_400_000 : 0 })
    console.log(result.ok
      ? `已把「${from}」的 ${result.moved} 条出现拆到「${to}」`
      : `拆分失败: ${result.error}`)
    store.close()
  },

  /** Write command: merge another device's exported memory into this store. */
  importMemory() {
    const file = positionalValue()
    if (file === '') {
      console.error('用法: node test/inspect.mjs importMemory "导出的 dsh-memory.json"')
      process.exit(2)
    }
    if (!existsSync(file)) {
      console.error(`文件不存在: ${file}`)
      process.exit(2)
    }
    const document = JSON.parse(readFileSync(file, 'utf8'))
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const result = store.importMemory(document, { source: file })
    console.log(result.ok
      ? `导入完成：新增 ${result.inserted} 个对象，合并 ${result.merged} 个，联想边 ${result.linked} 条`
      : `导入失败: ${result.error}`)
    store.close()
  },

  /** Objects a user deleted (soft), newest first. */
  trash() {
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const rows = store.trashedEntities(num(flag('limit', 20), 20))
    if (rows.length === 0) console.log('回收站是空的')
    for (const row of rows) {
      console.log(`  ${when(row.deleted_at)} ${pad(row.canonical, 20)} ${pad(row.kind, 10)} ${row.occurrences} 条出现`)
    }
    store.close()
  },

  /** Write command: bring a soft-deleted object back into recall. */
  restore() {
    const canonical = positionalValue()
    if (canonical === '') {
      console.error('用法: node test/inspect.mjs restore "对象名"')
      process.exit(2)
    }
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const result = store.restoreEntity(canonical)
    console.log(result.ok ? `已恢复「${canonical}」` : `恢复失败: ${result.error}`)
    store.close()
  },

  /** Write command: delete an object for good. */
  purge() {
    const canonical = positionalValue()
    if (canonical === '') {
      console.error('用法: node test/inspect.mjs purge "对象名"')
      process.exit(2)
    }
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const result = store.purgeEntity(canonical)
    console.log(result.ok ? `已彻底删除「${canonical}」（${result.occurrences} 条出现）` : `删除失败: ${result.error}`)
    store.close()
  },

  /** Read: behaviour profile derived from the habit counters. */
  style() {
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const profile = store.styleProfile()
    if (!profile.ready) {
      console.log(`还不够：${profile.messages}/20 条消息`)
    } else {
      console.log(`风格：${profile.labels.join('、')}（${profile.messages} 条消息）`)
      for (const [key, value] of Object.entries(profile.metrics)) {
        console.log(`  ${key.padEnd(11)} ${Number(value).toFixed(3)}`)
      }
    }
    for (const row of store.habits(10)) console.log(`  # ${row.term} ×${row.count}`)
    store.close()
  },

  /** Write command: fold conversation records into habits now. */
  harvest() {
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const processed = store.harvestHabits(num(flag('limit', 400), 400))
    console.log(`已处理 ${processed} 条对话记录`)
    const profile = store.styleProfile()
    console.log(profile.ready ? `风格：${profile.labels.join('、')}` : `风格：还需 ${20 - profile.messages} 条`)
    store.close()
  },

  /** Write command: rebuild derived data on the live database. */
  repair() {
    console.log(`写入目标: ${LIVE}`)
    const store = new MemoryStore(LIVE, { describeTool: name => `tool: ${name}` })
    const duplicates = store.repairCanonicalDuplicates()
    const turns = store.repairTurns()
    const handoffs = store.repairHandoffs()
    const links = store.repairLinks()
    const tools = store.repairToolDescriptions(name => `tool: ${name}`)
    store.setMeta('canonicalRepair', JSON.stringify({ at: Date.now(), merged: duplicates }))
    store.setMeta('turnRepair', JSON.stringify({ at: Date.now(), rows: turns }))
    store.setMeta('handoffRepair', JSON.stringify({ at: Date.now(), handoffs }))
    store.setMeta('linkRepair', JSON.stringify({ at: Date.now(), links }))
    console.log(`大小写重复合并 ${duplicates} · 轮次回填 ${turns} 行 · 交接卡 ${handoffs} 条 · 联想重建 ${links} 条 · 工具描述 ${tools} 行`)
    store.close()
  },
}

const run = commands[command]
if (run === undefined) {
  console.error(`未知命令: ${command}`)
  console.error(`可用: ${Object.keys(commands).join(' / ')}`)
  process.exit(2)
}
mkdirSync(path.dirname(LIVE), { recursive: true })
await run()
run()
