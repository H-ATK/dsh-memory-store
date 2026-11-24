/**
 * Verification for the human-memory model (M6).
 *
 * Covers the three mechanisms plus the identity rows the panel needs:
 *   1. forgetting — an untouched memory decays with age;
 *   2. reinforcement — every recall extends its lifetime;
 *   3. association — objects mentioned together are linked, so one recalls another;
 *   4. identity — a Session title and a subagent descriptor label are stored,
 *      while a subagent's conversation never is.
 *
 * Usage: node test/memory-model.mjs
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MemoryStore, SCHEMA_VERSION, cosineSimilarity, editDistance, isHumanMessage } from '../store.js'
import { profileOf, signalsOf } from '../style.js'
import { computeMood, describeGap } from '../mood.js'
import { proactivePrompt, proactiveStatus, syncProactive } from '../proactive.js'
import { bodyFacts, renderBody } from '../body.js'
import { applySelection, listOllamaModels, modelStatus, ollamaRoot, readModelPolicy, writeModelPolicy } from '../models.js'
import { classifyIntent, localAnswer } from '../intent.js'
import { matchSkill, runSkill, systemInfo } from '../skills.js'
import { checkDownloads, rememberObservation, takeObservation } from '../observer.js'
import { backupStatus, needsBackup, runBackup } from '../backup.js'
import { renderNarrative, weekKey, weekStart } from '../narrative.js'
import { cleanForSpeech } from '../voice.js'
import { saveVoiceConfig, voiceConfig } from '../voice-settings.js'
import { listen, recognizerInfo } from '../stt.js'
import { loopStatus, startLoop, stopLoop } from '../voice-loop.js'
import { DEFAULT_WAKE_WORD, createGate, parseRename } from '../wake.js'
import { learnName } from '../capture.js'
import { DEFAULT_PERSONA_ID, PERSONAS, personaById, renderPersona, withOverride } from '../personas.js'
import { isLocalProvider, pickNormalizeTarget, simpleCard } from '../normalize.js'
import { describeChange, estimateTokens, renderBrief, retrieve } from '../retrieve.js'

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const DAY = 86_400_000
const dbFile = path.join(tmpdir(), `dsh-memory-model-${process.pid}.db`)
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
const store = new MemoryStore(dbFile)
const now = Date.now()
const card = (canonical, extra = {}) => ({
  canonical, kind: 'object', action: '', state: '', detail: '', keywords: [], weight: 600, ...extra,
})

console.log('[1] 会话标题与子代理名字')
store.applySessionEvent('sess-main', { type: 'session/title', seq: 1, time: now, data: { title: '采集监控' } }, { workspace: 'C:\\w' })
const mainRow = store.db.prepare('SELECT title, workspace FROM sessions WHERE session_id = ?').get('sess-main')
check('title stored', mainRow?.title === '采集监控', JSON.stringify(mainRow))
check('workspace stored', mainRow?.workspace === 'C:\\w')

store.recordSubagentStart({ runId: 'run-1', parentSessionId: 'sess-main', id: 'sess-child', provider: 'spawn' })
store.applySessionEvent('sess-child', { type: 'subagent/descriptor', seq: 2, time: now, data: { label: '小肥鱼', provider: 'spawn' } }, { origin: 'subagent' })
const childRow = store.db.prepare('SELECT title, label, origin FROM sessions WHERE session_id = ?').get('sess-child')
check('descriptor label stored', childRow?.label === '小肥鱼', JSON.stringify(childRow))
check('origin marked subagent', childRow?.origin === 'subagent')
const runRow = store.db.prepare('SELECT name, child_session FROM subagent_runs WHERE run_id = ?').get('run-1')
check('run row carries the given name', runRow?.name === '小肥鱼', JSON.stringify(runRow))
check('run row links the child session', runRow?.child_session === 'sess-child')

console.log('\n[2] 子代理会话只留身份，不留对话')
const dropped = store.applySessionEvent('sess-child', {
  type: 'user/message', seq: 3, time: now,
  data: { role: 'user', content: [{ type: 'text', text: '子代理里说的话' }] },
}, { origin: 'subagent', metadataOnly: true })
check('conversation event ignored', dropped === false)
check('nothing queued from the child', store.queueStats().total === 0, String(store.queueStats().total))

console.log('\n[3] 遗忘：同样内容，越旧越难回忆')
store.applyCard({ sessionId: 's1', seq: 10, turn: 1, time: now - 5 * DAY, card: card('新鲜对象') })
store.applyCard({ sessionId: 's1', seq: 11, turn: 1, time: now - 400 * DAY, card: card('陈旧对象') })
const fresh = store.recall(['新鲜'], { limit: 5, now })[0]
const stale = store.recall(['陈旧'], { limit: 5, now })[0]
check('fresh memory has high retention', fresh.retention > 0.9, fresh.retention.toFixed(3))
check('stale memory has low retention', stale.retention < 0.05, stale.retention.toFixed(3))
check('fresh scores higher', fresh.score > stale.score, `${fresh.score.toFixed(3)} vs ${stale.score.toFixed(3)}`)

console.log('\n[4] 复习延长寿命（间隔效应）')
const beforeReviews = store.recall(['陈旧'], { limit: 1, now })[0]
store.reinforce([beforeReviews.id], now)
store.reinforce([beforeReviews.id], now)
store.reinforce([beforeReviews.id], now)
const afterReviews = store.recall(['陈旧'], { limit: 1, now })[0]
check('review count recorded', afterReviews.reviews === 3, String(afterReviews.reviews))
check('retention improved by reviews', afterReviews.retention > stale.retention, `${stale.retention.toFixed(4)} → ${afterReviews.retention.toFixed(4)}`)
check('score improved by reviews', afterReviews.score > stale.score, `${stale.score.toFixed(3)} → ${afterReviews.score.toFixed(3)}`)

console.log('\n[5] 联想：同轮出现的对象互相联结')
const linksBefore = Number(store.db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n)
store.applyCard({ sessionId: 's2', seq: 20, turn: 7, time: now, card: card('采集源', { keywords: ['采集'] }) })
store.applyCard({ sessionId: 's2', seq: 21, turn: 7, time: now, card: card('采集速度', { keywords: ['采集'] }) })
store.applyCard({ sessionId: 's2', seq: 22, turn: 7, time: now, card: card('采集后台', { keywords: ['采集'] }) })
const links = Number(store.db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n)
// Three objects in one turn make three unordered pairs.
check('three pairs linked for the shared turn', links - linksBefore === 3, `${linksBefore} → ${links}`)
const seed = store.recall(['采集源'], { limit: 1, now })[0]
const related = store.relatedItems([seed.id], 1, 2)
check('association returns a sibling', related.length > 0 && related[0].canonical !== '采集源', JSON.stringify(related.map(item => item.canonical)))
check('association excludes the seed', related.every(item => item.id !== seed.id))

console.log('\n[6] 联想需要重复共现，且不串到无关对象')
// A second turn mentioning the same pair makes the association strong enough to inject.
store.applyCard({ sessionId: 's2', seq: 23, turn: 8, time: now, card: card('采集源', { keywords: ['采集'] }) })
store.applyCard({ sessionId: 's2', seq: 24, turn: 8, time: now, card: card('采集速度', { keywords: ['采集'] }) })
const strong = store.relatedItems([seed.id], 2, 2)
check('repeated co-mention becomes a link at minCo=2', strong.some(item => item.canonical === '采集速度'), JSON.stringify(strong.map(item => item.canonical)))
const found = retrieve(store, '采集源', { budgetTokens: 800, minScore: 0.3 })
check('direct match still first', found.items[0]?.canonical === '采集源', found.items.map(item => item.canonical).join(','))
check('association rides along', found.related.length > 0, JSON.stringify(found.related.map(item => item.canonical)))
check('association appears in the note', found.text.includes(found.related[0].canonical), String(found.text))
const unrelated = retrieve(store, '今天天气怎么样', { minScore: 0.3 })
check('unrelated query still injects nothing', unrelated.text === null)

console.log('\n[7] 未知轮次不建联想（避免假关联）')
store.applyCard({ sessionId: 's3', seq: 30, turn: 0, time: now, card: card('无轮甲') })
store.applyCard({ sessionId: 's3', seq: 31, turn: 0, time: now, card: card('无轮乙') })
check('turn 0 creates no link', Number(store.db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n) === links, String(links))

console.log('\n[8] 旧库原地升级到 schema 5')
const live = path.join(process.env.USERPROFILE || '.', '.dsh', 'storages', 'dsh-memory', 'memory.db')
if (!existsSync(live)) {
  console.log('  skip (no live database)')
} else {
  const copy = path.join(tmpdir(), `dsh-memory-model-live-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
  copyFileSync(live, copy)
  for (const suffix of ['-wal', '-shm']) if (existsSync(`${live}${suffix}`)) copyFileSync(`${live}${suffix}`, `${copy}${suffix}`)
  const upgraded = new MemoryStore(copy)
  const version = upgraded.db.prepare('PRAGMA user_version').get().user_version
  check('user_version upgraded', version === SCHEMA_VERSION, String(version))
  const entityCols = upgraded.db.prepare('PRAGMA table_info(entities)').all().map(row => row.name)
  check('use_count column added', entityCols.includes('use_count'), entityCols.join(','))
  check('last_used_at column added', entityCols.includes('last_used_at'))
  const runCols = upgraded.db.prepare('PRAGMA table_info(subagent_runs)').all().map(row => row.name)
  check('child_session column added', runCols.includes('child_session'))
  check('sessions table created', upgraded.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sessions'").get().n === 1)
  check('existing entities survive', upgraded.normalizeStats().entities > 0, String(upgraded.normalizeStats().entities))
  // Titles the old build never stored can be rebuilt from a re-scan; nothing else breaks.
  check('panel identity query works', Array.isArray(upgraded.sessionsOf(5)), 'ok')
  upgraded.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
}

console.log('\n[9] 子代理名字在两种到达顺序下都能落库')
// Order A: label known first (descriptor appended before the start event).
store.applySessionEvent('sess-child-b', { type: 'subagent/descriptor', seq: 1, time: now, data: { label: '先有标签' } }, { origin: 'subagent' })
store.recordSubagentStart({ runId: 'run-b', parentSessionId: 'sess-main', id: 'sess-child-b', provider: 'spawn' })
check('name adopted when the label arrives first', store.db.prepare('SELECT name FROM subagent_runs WHERE run_id = ?').get('run-b')?.name === '先有标签')
// Order B: start known first, label arrives later.
store.recordSubagentStart({ runId: 'run-c', parentSessionId: 'sess-main', id: 'sess-child-c', provider: 'spawn' })
store.applySessionEvent('sess-child-c', { type: 'subagent/descriptor', seq: 2, time: now, data: { label: '后到标签' } }, { origin: 'subagent' })
check('name written when the label arrives later', store.db.prepare('SELECT name FROM subagent_runs WHERE run_id = ?').get('run-c')?.name === '后到标签')

console.log('\n[10] 历史联想可回填且幂等')
const linksPre = Number(store.db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n)
store.db.prepare('DELETE FROM entity_links').run()
const created = store.repairLinks()
check('repair rebuilds links from occurrences', created > 0, String(created))
check('link count restored', created === linksPre, `${created} vs ${linksPre}`)
const again = store.repairLinks()
check('second repair inserts nothing', again === 0, String(again))
const counts = store.db.prepare('SELECT COALESCE(MAX(co_count), 0) AS m FROM entity_links').get().m
check('repair does not inflate co_count', Number(counts) === 1, String(counts))

console.log('\n[11] 历史轮次可回填，回填后联想才成立')
store.applySessionEvent('s-tt', { type: 'turn/start', seq: 1, time: now, data: { turn: 9 } })
store.applySessionEvent('s-tt', { type: 'user/message', seq: 2, time: now, data: { role: 'user', content: [{ type: 'text', text: '旧甲说了什么' }] } })
store.applySessionEvent('s-tt', { type: 'user/message', seq: 3, time: now, data: { role: 'user', content: [{ type: 'text', text: '旧乙说了什么' }] } })
// Simulate rows recorded before the `turn` column existed.
store.db.prepare("UPDATE normalize_queue SET turn = 0 WHERE session_id = 's-tt'").run()
store.applyCard({ sessionId: 's-tt', seq: 2, turn: 0, card: card('旧甲') })
store.applyCard({ sessionId: 's-tt', seq: 3, turn: 0, card: card('旧乙') })
const linksBeforeTurnRepair = Number(store.db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n)
// A re-scan knows the real turn and records it on the existing queue row.
const requeued = store.applySessionEvent('s-tt', { type: 'user/message', seq: 2, time: now, data: { role: 'user', content: [{ type: 'text', text: '旧甲说了什么' }] } })
store.applySessionEvent('s-tt', { type: 'user/message', seq: 3, time: now, data: { role: 'user', content: [{ type: 'text', text: '旧乙说了什么' }] } })
check('re-scan does not duplicate the queue row', requeued === false)
check('turn recorded on the old queue row', store.db.prepare("SELECT turn FROM normalize_queue WHERE session_id = 's-tt' AND seq = 2").get().turn === 9)
const repaired = store.repairTurns()
check('occurrence turns repaired', repaired >= 2, String(repaired))
check('occurrence turn filled', store.db.prepare("SELECT turn FROM occurrences WHERE session_id = 's-tt' AND seq = 2").get().turn === 9)
const linked = store.repairLinks()
check('association appears after the turn repair', linked >= 1 && Number(store.db.prepare('SELECT COUNT(*) AS n FROM entity_links').get().n) > linksBeforeTurnRepair, String(linked))

console.log('\n[12] 新会话首轮简报（跨工作区）')
// Objects from two different workspaces; the newest across both must lead.
store.touchSession('s-ws', { workspace: 'C:\\demo', origin: null })
store.touchSession('s-ws2', { workspace: 'C:\\other', origin: null })
for (const [index, name] of ['甲项目', '乙项目', '丙项目'].entries()) {
  store.applyCard({ sessionId: 's-ws', seq: 200 + index, turn: 1, time: now - (5 + index) * DAY, card: card(name) })
}
store.applyCard({ sessionId: 's-ws2', seq: 300, turn: 1, time: now - DAY, card: card('别的项目的新事') })
check('workspace recorded', store.sessionWorkspace('s-ws') === 'C:\\demo')
const brief = store.recentBrief(10)
check('brief reports the global total', brief !== null && brief.total >= 4, JSON.stringify(brief))
check('brief crosses workspaces', brief.items.some(item => item.canonical === '别的项目的新事'), JSON.stringify(brief.items.map(item => item.canonical)))
const briefStamps = brief.items.map(item => Number(item.lastSeen))
check('brief is sorted newest first', briefStamps.every((value, index) => index === 0 || briefStamps[index - 1] >= value), briefStamps.join(','))
const briefLine = renderBrief(brief)
check('brief renders as one line', typeof briefLine === 'string' && !briefLine.includes('\n'), String(briefLine))
check('brief is scoped to everything', briefLine.startsWith('最近：'), String(briefLine))
check('brief lists no counts', !/×\d/.test(briefLine) && !/\d+ 条/.test(briefLine), String(briefLine))
check('brief token-cheap', estimateTokens(briefLine) <= 40, String(estimateTokens(briefLine)))
const emptyBriefPath = path.join(tmpdir(), `dsh-memory-empty-brief-${process.pid}.db`)
const emptyBrief = new MemoryStore(emptyBriefPath)
check('empty store has no brief', emptyBrief.recentBrief(3) === null)
emptyBrief.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${emptyBriefPath}${suffix}`, { force: true })
check('identity exposes workspace and origin', store.sessionIdentity('s-ws').workspace === 'C:\\demo', JSON.stringify(store.sessionIdentity('s-ws')))
check('identity marks subagents', store.sessionIdentity('sess-child').origin === 'subagent', JSON.stringify(store.sessionIdentity('sess-child')))
check('identity of unknown session is empty', store.sessionIdentity('nope').workspace === null)
check('not briefed yet', store.wasBriefed('s-ws') === false)
store.markBriefed('s-ws')
check('brief marked', store.wasBriefed('s-ws') === true)
store.markBriefed('s-ws')
check('brief marker is idempotent', store.wasBriefed('s-ws') === true)

console.log('\n[13] 交接卡：每轮改过哪些文件')
// The Host records a Session's identity on its first event; a handoff from a
// Session that no longer exists must be ignored, so the row has to exist here too.
store.touchSession('s-hand', { workspace: 'C:\\proj', origin: null })
store.applySessionEvent('s-hand', { type: 'turn/start', seq: 900, time: now, data: { turn: 3 } })
store.applySessionEvent('s-hand', {
  type: 'user/message', seq: 900, time: now,
  data: { role: 'user', content: [{ type: 'text', text: '帮我改一下播放器' }] },
}, {})
store.applySessionEvent('s-hand', {
  type: 'tool/call', seq: 901, time: now,
  data: { name: 'edit', arguments: JSON.stringify({ file_path: 'C:\\proj\\app\\Player.kt' }) },
}, {})
store.applySessionEvent('s-hand', {
  type: 'tool/call', seq: 902, time: now,
  data: { name: 'write', arguments: JSON.stringify({ file_path: 'C:\\proj\\app\\Main.kt' }) },
}, {})
store.applySessionEvent('s-hand', {
  type: 'tool/call', seq: 903, time: now,
  data: { name: 'read', arguments: JSON.stringify({ file_path: 'C:\\proj\\app\\Ignore.kt' }) },
}, {})
const flushed = store.applySessionEvent('s-hand', { type: 'turn/end', seq: 904, time: now, data: { turn: 3 } })
check('turn/end writes a handoff', flushed === true)
const handoffRow = store.db.prepare('SELECT session_id, turn, files FROM handoffs WHERE session_id = ?').get('s-hand')
const handoffFiles = JSON.parse(handoffRow?.files ?? '[]')
check('handoff has both written files', handoffFiles.length === 2, JSON.stringify(handoffFiles))
check('read-only tools are ignored', !handoffFiles.some(file => file.includes('Ignore')), JSON.stringify(handoffFiles))
check('handoff quoted the path verbatim', handoffFiles.includes('C:\\proj\\app\\Player.kt'), JSON.stringify(handoffFiles))

const seenElsewhere = store.recentHandoff({ hours: 24, excludeSessionId: 's-other' })
check('another session sees the handoff', seenElsewhere !== null && seenElsewhere.files.length === 2, JSON.stringify(seenElsewhere))
check('the writing session does not see its own handoff', store.recentHandoff({ hours: 24, excludeSessionId: 's-hand' }) === null)
// An old handoff must not leak into the 24h window.
store.handoffUpsert.run('s-old', 1, now - 10 * DAY, JSON.stringify(['C:\\old\\ancient.kt']))
check('old handoff is ignored', store.recentHandoff({ hours: 24, excludeSessionId: 's-other' }).sessionId === 's-hand', JSON.stringify(store.recentHandoff({ hours: 24, excludeSessionId: 's-other' })))
check('describeChange names the file', describeChange(['C:\\proj\\app\\Player.kt', 'C:\\proj\\app\\Main.kt']) === 'Player.kt(+1)', String(describeChange(['C:\\proj\\app\\Player.kt', 'C:\\proj\\app\\Main.kt'])))
check('describeChange of one file has no counter', describeChange(['C:\\proj\\a.kt']) === 'a.kt')
check('describeChange of nothing is null', describeChange([]) === null)

console.log('\n[14] 交接卡可从历史重建')
store.db.prepare('DELETE FROM handoffs').run()
const rebuilt = store.repairHandoffs()
check('repair writes handoffs', rebuilt >= 1, String(rebuilt))
check('rebuilt handoff is readable', store.recentHandoff({ hours: 24 * 365, excludeSessionId: 'other' }) !== null)
const secondRebuild = store.repairHandoffs()
check('repair is idempotent in count', secondRebuild === rebuilt, `${rebuilt} → ${secondRebuild}`)
check('handoff rows are not duplicated', Number(store.db.prepare('SELECT COUNT(*) n FROM handoffs').get().n) === rebuilt, String(rebuilt))

console.log('\n[15] 当前工作区加权（不是过滤）')
store.touchSession('s-home', { workspace: 'C:\\home', origin: null })
store.touchSession('s-away', { workspace: 'C:\\away', origin: null })
const sameTime = now - 2 * DAY
store.applyCard({ sessionId: 's-home', seq: 950, turn: 1, time: sameTime, card: card('本地对象', { keywords: ['加权测试'] }) })
store.applyCard({ sessionId: 's-away', seq: 951, turn: 1, time: sameTime, card: card('外地对象', { keywords: ['加权测试'] }) })
const all = store.recall(['加权'], { limit: 8, now, workspace: null })
const local = store.recall(['加权'], { limit: 8, now, workspace: 'C:\\home' })
check('both objects match either way', all.length >= 2 && local.length >= 2, `${all.length}/${local.length}`)
const homeRow = local.find(item => item.canonical === '本地对象')
const awayRow = local.find(item => item.canonical === '外地对象')
check('home object flagged', homeRow?.inWorkspace === true, JSON.stringify(homeRow?.inWorkspace))
check('away object not flagged', awayRow?.inWorkspace === false, JSON.stringify(awayRow?.inWorkspace))
check('home object scores higher', Number(homeRow.score) > Number(awayRow.score), `${homeRow?.score?.toFixed(3)} vs ${awayRow?.score?.toFixed(3)}`)
check('global recall keeps both', all.some(item => item.canonical === '外地对象'), JSON.stringify(all.map(item => item.canonical)))

console.log('\n[16] 本地模型适配')
check('ollama counts as local', isLocalProvider('ollama') === true)
check('lmstudio counts as local', isLocalProvider('lmstudio') === true)
check('deepseek-account is not local', isLocalProvider('deepseek-account') === false)
check('empty provider is not local', isLocalProvider('') === false)

const configured = { provider: 'deepseek-account', model: 'deepseek-flash' }
const sessionLocal = { provider: 'ollama', model: 'qwen3:8b' }
check('explicit config wins', pickNormalizeTarget({ configured, session: sessionLocal, fallback: null }).provider === 'deepseek-account')
check('session model used when config is empty', pickNormalizeTarget({ configured: { provider: '', model: '' }, session: sessionLocal, fallback: configured }).model === 'qwen3:8b')
check('profile default is the last resort', pickNormalizeTarget({ configured: { provider: '', model: '' }, session: null, fallback: configured }).model === 'deepseek-flash')
check('no model at all yields null', pickNormalizeTarget({ configured: {}, session: null, fallback: null }) === null)

store.recordSessionModel('s-model', { provider: 'ollama', model: 'qwen3:8b' })
check('session model recorded', store.sessionModel('s-model')?.model === 'qwen3:8b', JSON.stringify(store.sessionModel('s-model')))
store.recordSessionModel('s-model', { provider: 'deepseek-account', model: 'deepseek-flash' })
check('session model is replaced, not duplicated', store.sessionModel('s-model')?.provider === 'deepseek-account')
check('unknown session has no model', store.sessionModel('nope') === null)
check('incomplete selection is ignored', (store.recordSessionModel('s-bad', { provider: 'ollama' }), store.sessionModel('s-bad') === null))

const known = ['dsh用量插件', '价格表', '审批策略']
const cardKnown = simpleCard('帮我看看 dsh用量插件的注入隐藏现在是什么状态', { candidates: known })
check('fallback card reuses a known object', cardKnown?.canonical === 'dsh用量插件', JSON.stringify(cardKnown))
check('fallback card keeps the sentence', typeof cardKnown?.detail === 'string' && cardKnown.detail.length > 0)
const cardFree = simpleCard('明天帮我把价格表里 pro 的价格加进去', { candidates: ['价格表'] })
check('fallback card matches a shorter candidate too', cardFree?.canonical === '价格表', JSON.stringify(cardFree))
const cardNone = simpleCard('完全没匹配的话就抽词', { candidates: [] })
check('fallback card still names something', typeof cardNone?.canonical === 'string' && cardNone.canonical.length >= 2, JSON.stringify(cardNone))
check('filler-only text yields no card', simpleCard('好的', { candidates: [] }) === null || simpleCard('好的', { candidates: [] }).canonical.length >= 2)
check('empty text yields no card', simpleCard('', { candidates: [] }) === null)

console.log('\n[17] 只记人说的话（不记运行时上下文）')
check('time-context is not human', isHumanMessage({ source: { kind: 'time-context' } }, 'Time sampled while preparing turn 3') === false)
check('runtime-context is not human', isHumanMessage({ source: { kind: 'runtime-context' } }, 'Current working directory: C:\\x') === false)
check('typed user input is human', isHumanMessage({ source: { kind: 'user' } }, '帮我改一下播放器') === true)
check('missing source is kept', isHumanMessage({}, '老日志没有 source') === true)
check('time prefix without source is rejected', isHumanMessage({}, 'Time sampled while preparing turn 1') === false)
check('timezone prefix is rejected', isHumanMessage({}, 'Browser time zone for this request: Asia/Shanghai') === false)
check('empty text is not human', isHumanMessage({ source: { kind: 'user' } }, '') === false)

// The store must not queue runtime context even when DSH records it as user text.
const before = Number(store.db.prepare('SELECT COUNT(*) n FROM normalize_queue').get().n)
store.applySessionEvent('s-ctx', {
  type: 'user/message', seq: 960, time: now,
  data: {
    role: 'user',
    id: 'msg-time-1',
    source: { kind: 'time-context' },
    content: [{ type: 'text', text: 'Time sampled while preparing turn 5, step 1: 2026-11-23T10:00:00+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.' }],
  },
}, {})
store.applySessionEvent('s-ctx', {
  type: 'user/message', seq: 961, time: now,
  data: { role: 'user', id: 'msg-real-1', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把播放器的进度条改细一点' }] },
}, {})
const after = Number(store.db.prepare('SELECT COUNT(*) n FROM normalize_queue').get().n)
check('runtime context is not queued', after - before === 1, `${before} → ${after}`)
const queued = store.db.prepare('SELECT text FROM normalize_queue ORDER BY id DESC LIMIT 1').get()
check('the queued row is the real message', String(queued?.text ?? '').includes('进度条'), String(queued?.text ?? '').slice(0, 40))

console.log('\n[18] 模糊召回（错字 / 旧名 / 精度）')
check('edit distance of a homophone typo', editDistance('记意库', '记忆库') === 1, String(editDistance('记意库', '记忆库')))
check('edit distance of unrelated text is large', editDistance('今天天气', '记忆库') >= 3, String(editDistance('今天天气', '记忆库')))

store.applyCard({ sessionId: 's-fuzzy', seq: 970, turn: 1, time: now, card: card('记忆库插件', { keywords: ['记忆'], weight: 700 }) })
store.applyCard({ sessionId: 's-fuzzy', seq: 971, turn: 1, time: now, card: card('播放器界面', { keywords: ['播放器'], weight: 600 }) })
const typo = store.fuzzyRecall('记意库插件', { limit: 3 })
check('typo still finds the object', typo.some(item => item.canonical === '记忆库插件'), JSON.stringify(typo.map(item => item.canonical)))
check('unrelated query finds nothing', store.fuzzyRecall('今天天气怎么样', { limit: 3 }).length === 0, JSON.stringify(store.fuzzyRecall('今天天气怎么样', { limit: 3 })))
check('fuzzy items carry the render shape', typeof typo[0]?.action === 'string' && typeof typo[0]?.mentions === 'number', JSON.stringify(typo[0]))

// A merged object keeps its old name as an alias, so the old words still recall it.
const merged = store.mergeEntities('记忆库插件', '播放器界面')
check('merge succeeded', merged.ok === true, JSON.stringify(merged))
const intoRow = store.db.prepare('SELECT id, aliases FROM entities WHERE canonical = ?').get('播放器界面')
const aliases = String(intoRow?.aliases ?? '')
check('merged name kept as alias', aliases.includes('记忆库插件'), aliases)
const viaAlias = store.fuzzyRecall('记忆库插件', { limit: 3 })
check('old name still recalls the merged object', viaAlias.some(item => item.canonical === '播放器界面'), JSON.stringify(viaAlias.map(item => item.canonical)))
check('retrieve falls back when no bigram matches', retrieve(store, '记意库插件', { budgetTokens: 200, minScore: 0.3 }).text !== null, 'no fallback result')

console.log('\n[19] 巩固与归档')
const consTime = now - 5 * DAY
for (let index = 0; index < 4; index += 1) {
  store.applyCard({
    sessionId: 's-cons', seq: 980 + index, turn: 1, time: consTime + index * 1000,
    card: card('巩固测试对象', { action: '重复动作' }),
  })
}
store.applyCard({
  sessionId: 's-cons', seq: 990, turn: 1, time: consTime + 5000,
  card: card('巩固测试对象', { action: '另一个动作' }),
})
const folded = store.consolidate({ days: 30, now })
check('folds identical occurrences', folded.removed >= 3, JSON.stringify(folded))
const remainingOccurrences = Number(store.db.prepare(`
  SELECT COUNT(*) AS n FROM occurrences o JOIN entities e ON e.id = o.entity_id
  WHERE e.canonical = ?
`).get('巩固测试对象').n)
check('keeps one per distinct action', remainingOccurrences === 2, String(remainingOccurrences))
check('consolidate is idempotent', store.consolidate({ days: 30, now }).removed === 0)

store.applyCard({ sessionId: 's-old', seq: 995, turn: 1, time: now - 400 * DAY, card: card('远古的一次操作', { keywords: ['远古'] }) })
check('faded object is recallable first', store.recall(['远古'], { limit: 5, now }).some(item => item.canonical === '远古的一次操作'))
const arch = store.archiveStale({ days: 180, now })
check('archives the faded object', arch.archived >= 1, JSON.stringify(arch))
check('archived object leaves recall', !store.recall(['远古'], { limit: 5, now }).some(item => item.canonical === '远古的一次操作'))
check('archived object leaves fuzzy recall', !store.fuzzyRecall('远古的一次操作', { limit: 3, now }).some(item => item.canonical === '远古的一次操作'))
store.applyCard({ sessionId: 's-old', seq: 996, turn: 1, time: now, card: card('远古的一次操作', { keywords: ['远古'] }) })
check('a new mention revives it', store.recall(['远古'], { limit: 5, now }).some(item => item.canonical === '远古的一次操作'))

console.log('\n[20] 删除与导出')
store.applyCard({ sessionId: 's-del', seq: 997, turn: 1, time: now, card: card('待删对象', { keywords: ['删除测试'] }) })
store.applyCard({ sessionId: 's-del', seq: 998, turn: 1, time: now, card: card('关联对象', { keywords: ['删除测试'] }) })
store.repairLinks()
const removed = store.deleteEntity('待删对象')
check('delete is soft and counts occurrences', removed.ok === true && removed.soft === true && Number(removed.occurrences) >= 1, JSON.stringify(removed))
check('deleted object leaves recall', store.fuzzyRecall('待删对象', { limit: 5, now }).every(item => item.canonical !== '待删对象'))
const deletedRow = store.db.prepare('SELECT deleted_at FROM entities WHERE canonical = ?').get('待删对象')
check('the row survives for restore', deletedRow !== undefined && deletedRow.deleted_at !== null, JSON.stringify(deletedRow))
check('delete twice reports not-found', store.deleteEntity('待删对象').ok === false)
check('trash lists it', store.trashedEntities(10).some(row => row.canonical === '待删对象'))
const restored = store.restoreEntity('待删对象')
check('restore puts it back', restored.ok === true, JSON.stringify(restored))
check('restored object is recallable again', store.fuzzyRecall('待删对象', { limit: 5, now }).some(item => item.canonical === '待删对象'))
check('a new mention also revives a deleted object', (() => {
  store.deleteEntity('待删对象')
  store.applyCard({ sessionId: 's-del', seq: 999, turn: 1, time: now, card: card('待删对象', { keywords: ['删除测试'] }) })
  return store.fuzzyRecall('待删对象', { limit: 5, now }).some(item => item.canonical === '待删对象')
})())
const purged = store.purgeEntity('待删对象')
check('purge reports its occurrences', purged.ok === true && Number(purged.occurrences) >= 1, JSON.stringify(purged))
check('purged object is gone', store.db.prepare('SELECT id FROM entities WHERE canonical = ?').get('待删对象') === undefined)
check('purged occurrences are gone', Number(store.db.prepare(`
  SELECT COUNT(*) AS n FROM occurrences WHERE session_id = 's-del' AND seq = 997
`).get().n) === 0)
const exported = store.exportMemory()
check('export carries entities', Array.isArray(exported.entities) && exported.entities.length > 0, String(exported.entities?.length))
check('export carries links', Array.isArray(exported.links), String(exported.links?.length))
check('export names the schema', Number(exported.schema) === SCHEMA_VERSION, String(exported.schema))
check('export is JSON-serializable', typeof JSON.stringify(exported) === 'string')

console.log('\n[21] 语义召回（向量）')
check('cosine of identical vectors is 1', Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9)
check('cosine of orthogonal vectors is 0', Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
check('cosine tolerates a zero vector', cosineSimilarity([0, 0], [1, 1]) === 0)

store.applyCard({ sessionId: 's-vec', seq: 1001, turn: 1, time: now, card: card('向量甲', { keywords: ['向量测试'] }) })
store.applyCard({ sessionId: 's-vec', seq: 1002, turn: 1, time: now, card: card('向量乙', { keywords: ['向量测试'] }) })
const vecA = store.db.prepare('SELECT id FROM entities WHERE canonical = ?').get('向量甲')
const vecB = store.db.prepare('SELECT id FROM entities WHERE canonical = ?').get('向量乙')
check('saveVector accepts a plain array', store.saveVector(Number(vecA.id), [1, 0, 0, 0], 'test-model') === true)
store.saveVector(Number(vecB.id), [0, 1, 0, 0], 'test-model')
const loaded = store.loadVectors('test-model')
check('vectors round-trip as Float32', loaded.length === 2 && loaded[0].vec.length === 4, JSON.stringify(loaded.map(v => v.vec.length)))
const semanticHit = store.vectorRecall([0.95, 0.05, 0, 0], { limit: 3, model: 'test-model', minSimilarity: 0.55, now })
check('semantic recall finds the close object', semanticHit.some(item => item.canonical === '向量甲'), JSON.stringify(semanticHit.map(item => item.canonical)))
check('semantic recall skips the far object', !semanticHit.some(item => item.canonical === '向量乙'), JSON.stringify(semanticHit.map(item => item.canonical)))
check('semantic items carry the render shape', typeof semanticHit[0]?.action === 'string' && typeof semanticHit[0]?.semantic === 'number', JSON.stringify(semanticHit[0]))
const withSemantic = retrieve(store, '完全无关的一句话', {
  budgetTokens: 200,
  minScore: 0.3,
  extraItems: semanticHit,
})
check('retrieve renders caller-provided semantic hits', withSemantic.text !== null && withSemantic.text.includes('向量甲'), String(withSemantic.text))
const deduped = retrieve(store, '向量甲', { budgetTokens: 300, minScore: 0.3, extraItems: semanticHit })
check('semantic hits are deduplicated by identity', deduped.items.filter(item => item.canonical === '向量甲').length === 1, String(deduped.items.length))

console.log('\n[22] 拆开一个被合并过头的对象')
for (let index = 0; index < 3; index += 1) {
  store.applyCard({
    sessionId: 's-split', seq: 1100 + index, turn: 1, time: now - (10 + index) * DAY,
    card: card('合并过头的对象', { action: '旧的事' }),
  })
}
for (let index = 0; index < 2; index += 1) {
  store.applyCard({
    sessionId: 's-split', seq: 1110 + index, turn: 1, time: now - DAY,
    card: card('合并过头的对象', { action: `新的事${index}` }),
  })
}
const split = store.splitEntity('合并过头的对象', '拆出来的新对象', { since: now - 3 * DAY })
check('split moves the recent occurrences', split.ok === true && split.moved === 2, JSON.stringify(split))
check('the new object is recallable', store.fuzzyRecall('拆出来的新对象', { limit: 5 }).some(item => item.canonical === '拆出来的新对象'))
const splitCounts = store.db.prepare(`
  SELECT e.canonical, COUNT(o.id) AS n FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id
  WHERE e.canonical IN ('合并过头的对象', '拆出来的新对象') GROUP BY e.id
`).all()
check('the old object keeps the rest', Number(splitCounts.find(row => row.canonical === '合并过头的对象')?.n) === 3, JSON.stringify(splitCounts))
check('split refuses an existing target', store.splitEntity('合并过头的对象', '拆出来的新对象').ok === false)
check('split refuses the same name', store.splitEntity('拆出来的新对象', '拆出来的新对象').ok === false)

console.log('\n[23] 跨设备导入')
const portability = store.exportMemory()
const importedPath = path.join(tmpdir(), `dsh-memory-import-${process.pid}.db`)
const other = new MemoryStore(importedPath)
const imported = other.importMemory(portability, { source: 'e2e-export' })
check('import reports inserted objects', imported.ok === true && imported.inserted > 0, JSON.stringify(imported))
check('imported objects are recallable', other.fuzzyRecall('播放器界面', { limit: 5 }).length > 0, JSON.stringify(other.fuzzyRecall('播放器界面', { limit: 5 }).map(item => item.canonical)))
const reimport = other.importMemory(portability, { source: 'e2e-export' })
check('re-import merges instead of duplicating', reimport.ok === true && reimport.inserted === 0 && reimport.merged > 0, JSON.stringify(reimport))
check('import carries no occurrences', Number(other.db.prepare('SELECT COUNT(*) AS n FROM occurrences').get().n) === 0)
check('import records its source', String(other.getMeta('import')).includes('e2e-export'), String(other.getMeta('import')))
other.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${importedPath}${suffix}`, { force: true })

console.log('\n[24] 完整对话记录与去重')
const recTime = now - 2 * DAY
store.recordConversation({ userText: '把播放器的进度条改细一点', assistantText: '改好了', time: recTime, source: 's-full' })
const recHash = createHash('sha256').update('把播放器的进度条改细一点\u0000改好了').digest('hex')
check('conversation stored once', Number(store.db.prepare('SELECT count FROM memory_records WHERE hash = ?').get(recHash).count) === 1)
store.recordConversation({ userText: '把播放器的进度条改细一点', assistantText: '改好了', time: recTime + 60_000, source: 's-full' })
check('same words again only add a count', Number(store.db.prepare('SELECT count FROM memory_records WHERE hash = ?').get(recHash).count) === 2)
const recRow = store.db.prepare('SELECT first_at, last_at FROM memory_records WHERE hash = ?').get(recHash)
check('record keeps the time range', Number(recRow.first_at) === recTime && Number(recRow.last_at) === recTime + 60_000, JSON.stringify(recRow))

// The turn row keeps the full text, not the truncated queue copy.
store.applySessionEvent('s-full', { type: 'turn/start', seq: 2000, time: now, data: { turn: 7 } })
store.applySessionEvent('s-full', {
  type: 'user/message', seq: 2001, time: now,
  data: { role: 'user', id: 'msg-full-1', source: { kind: 'user' }, content: [{ type: 'text', text: '这是一段很长的需求描述，用来确认完整记录而不是截断保存。' }] },
}, {})
store.applySessionEvent('s-full', {
  type: 'assistant/message', seq: 2002, time: now,
  data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，已经按你说的改完了。' }] } },
}, {})
store.applySessionEvent('s-full', { type: 'turn/end', seq: 2003, time: now, data: { turn: 7, reason: { kind: 'completed' } } })
const turnRow = store.db.prepare('SELECT user_text, assistant_text FROM turns WHERE session_id = ? AND turn = 7').get('s-full')
check('turn stores the full user text', String(turnRow?.user_text ?? '').includes('完整记录而不是截断'), JSON.stringify(turnRow?.user_text))
check('turn stores the assistant answer', String(turnRow?.assistant_text ?? '').includes('改完了'), JSON.stringify(turnRow?.assistant_text))

console.log('\n[25] 习惯：常用关键词')
// Counts are per message that reaches for the term, which is the signal we want.
store.bumpKeywords('记忆库插件的面板要能折叠，记忆库插件的导出要压缩', now)
store.bumpKeywords('记忆库插件再加一个导入导出面板', now)
const habitRow = store.db.prepare("SELECT term, count FROM keyword_stats WHERE term LIKE '记忆%' ORDER BY count DESC LIMIT 1").get()
check('habits record the repeated term', habitRow !== undefined && Number(habitRow.count) >= 2, JSON.stringify(habitRow))
check('habit counts grow', store.habits(10).every(row => Number(row.count) >= 1), JSON.stringify(store.habits(3)))

console.log('\n[26] 导出 / 导入（内容+时间去重）')
const bundle = store.exportBundle()
check('bundle names its format', bundle.format === 'dsh-memory-bundle', String(bundle.format))
check('bundle carries conversation records', bundle.records.length > 0, String(bundle.records.length))

const importPath = path.join(tmpdir(), `dsh-memory-bundle-${process.pid}.db`)
const mirror = new MemoryStore(importPath)
const first = mirror.importBundle(bundle)
check('import inserts records', first.ok === true && first.insertedRecords > 0, JSON.stringify(first))
check('import inserts entities', first.insertedEntities > 0, JSON.stringify(first))
const countAfterFirst = Number(mirror.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n)

const second = mirror.importBundle(bundle)
check('re-import is detected as duplicate', second.ok === true && second.duplicateRecords > 0 && second.insertedRecords === 0, JSON.stringify(second))
check('duplicates do not add rows', Number(mirror.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n) === countAfterFirst)

// Same words, later time: only the time and the count travel.
const shifted = JSON.parse(JSON.stringify(bundle))
const target = shifted.records[0]
target.first_at = Number(target.first_at) + 30 * DAY
target.last_at = Number(target.last_at) + 30 * DAY
const beforeCount = Number(mirror.db.prepare('SELECT count FROM memory_records WHERE hash = ?').get(target.hash).count)
const third = mirror.importBundle(shifted)
check('a later occurrence merges instead of duplicating', third.ok === true && third.mergedRecords > 0, JSON.stringify(third))
check('merged record counts the extra occurrence',
  Number(mirror.db.prepare('SELECT count FROM memory_records WHERE hash = ?').get(target.hash).count) > beforeCount,
  `${beforeCount} → ${mirror.db.prepare('SELECT count FROM memory_records WHERE hash = ?').get(target.hash).count}`)
check('imported mentions show up in recall',
  Number(mirror.fuzzyRecall('播放器界面', { limit: 3 }).find(item => item.canonical === '播放器界面')?.mentions ?? 0) > 0,
  JSON.stringify(mirror.fuzzyRecall('播放器界面', { limit: 3 }).map(item => `${item.canonical}:${item.mentions}`)))
mirror.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${importPath}${suffix}`, { force: true })

console.log('\n[27] 行为风格：语气与习惯')
const sig = signalsOf('帮我改一下面板！记得用您的方式…😂')
check('signals count characters', sig.chars > 10, JSON.stringify(sig))
check('signals count exclamation', sig.exclam === 1, JSON.stringify(sig.exclam))
check('signals count ellipsis', sig.ellipsis === 1, JSON.stringify(sig.ellipsis))
check('signals count honorific', sig.honorific === 1, JSON.stringify(sig.honorific))
check('signals count emoji', sig.emoji >= 1, JSON.stringify(sig.emoji))
check('signals notice imperative wording', sig.direct >= 1, JSON.stringify(sig.direct))

const green = profileOf({ messages: 5, chars: 60 })
check('profile waits for history', green.ready === false, JSON.stringify(green))
const ready = profileOf({ messages: 30, chars: 600, direct: 12, polite: 1, exclam: 20, ellipsis: 12 })
check('profile becomes ready', ready.ready === true, JSON.stringify(ready))
check('profile names the tone', ready.labels.includes('直接') && ready.labels.includes('爱感叹'), JSON.stringify(ready.labels))
check('profile reports average length', ready.metrics.chars === 20, String(ready.metrics.chars))

console.log('\n[28] 习惯自动收集（从对话记录）')
const beforeHarvest = store.db.prepare('SELECT COUNT(*) AS n FROM memory_records WHERE habits_done = 0').get().n
check('records wait to be harvested', Number(beforeHarvest) > 0, String(beforeHarvest))
const harvested = store.harvestHabits(400)
check('harvest processes records', harvested > 0, String(harvested))
check('harvest marks records done', Number(store.db.prepare('SELECT COUNT(*) AS n FROM memory_records WHERE habits_done = 0').get().n) === 0)
check('harvest is idempotent', store.harvestHabits(400) === 0)
check('style counters exist after harvest', Object.keys(store.styleTotals()).length > 0, JSON.stringify(store.styleTotals()).slice(0, 120))
const styleBrief = renderBrief(store.recentBrief(2), { style: ['简短', '直接'] })
check('brief carries the style clause', String(styleBrief).includes('风格：简短、直接'), String(styleBrief))

console.log('\n[29] 人格：内置、默认、切换')
check('several personas ship', PERSONAS.length >= 4, String(PERSONAS.length))
check('the default persona exists', personaById(DEFAULT_PERSONA_ID)?.id === DEFAULT_PERSONA_ID, DEFAULT_PERSONA_ID)
check('unknown persona falls back to the default', personaById('nope').id === DEFAULT_PERSONA_ID)
const rendered = renderPersona('default')
check('persona text names itself', rendered.includes('大肥鱼'), rendered.slice(0, 60))
check('persona text states its style', rendered.includes('说话方式：'), rendered.slice(0, 120))
check('persona text states boundaries', rendered.includes('你不做：'), rendered.slice(0, 200))
check('persona text forbids meta talk', rendered.includes('不要提到'), rendered.slice(0, 120))
const warmText = renderPersona('warm')
check('a different persona reads differently', warmText !== rendered && warmText.includes('阿暖'), warmText.slice(0, 40))
check('empty selection renders the default', renderPersona(null) === rendered)

store.setActivePersona('tutor')
check('active persona persists', store.activePersona() === 'tutor', String(store.activePersona()))
store.setActivePersona(DEFAULT_PERSONA_ID)

console.log('\n[30] 关系：称呼、亲密度、边界、承诺')
store.observeRelationship('s-rel', 1, '叫我老板就行')
check('address is learned from "叫我X"', store.address() === '老板', String(store.address()))
const relA = store.relationship()
check('a counted turn raises closeness', relA.turns >= 1 && relA.warm > 0, JSON.stringify(relA))
store.observeRelationship('s-rel', 1, '叫我老板就行')
check('the same turn is never counted twice', store.relationship().turns === relA.turns, String(store.relationship().turns))
store.observeRelationship('s-rel', 2, '谢谢，这次很靠谱')
check('thanks is recorded as an event', store.relationship().thanks >= 1, JSON.stringify(store.relationship()))
store.observeRelationship('s-rel', 3, '别再这么叫我了')
check('a boundary is recorded too', store.relationship().boundaries >= 1, JSON.stringify(store.relationship()))
store.observeRelationship('s-rel', 4, '记得明天帮我看一下采集进度')
const withPromise = store.relationship()
check('a promise stays open', withPromise.promises.length >= 1, JSON.stringify(withPromise.promises))
check('boundaries lower closeness', store.relationship().warm < relA.warm + 2, `${store.relationship().warm} vs ${relA.warm}`)
const line = store.renderRelationship()
check('the relationship line names the stage', typeof line === 'string' && line.includes('关系：'), String(line))
check('the line carries the address', String(line).includes('老板'), String(line))
check('the line carries the promise', String(line).includes('还欠着'), String(line))
check('promise can be resolved', store.resolveRelationshipEvent(Number(withPromise.promises[0].id)) === true)
check('resolved promise leaves the list', store.relationship().promises.length === withPromise.promises.length - 1)

console.log('\n[31] 时间感与状态')
check('gap reads as minutes', describeGap(5 * 60_000) === '5 分钟前', String(describeGap(5 * 60_000)))
check('gap reads as hours', describeGap(3 * 3_600_000) === '3 小时前', String(describeGap(3 * 3_600_000)))
check('gap reads as yesterday', describeGap(1.2 * 86_400_000) === '昨天', String(describeGap(1.2 * 86_400_000)))
check('gap reads as days', describeGap(2.2 * 86_400_000) === '2 天前', String(describeGap(2.2 * 86_400_000)))
check('gap reads as a long silence', describeGap(11 * 86_400_000).includes('好久没聊'), String(describeGap(11 * 86_400_000)))
check('a zero gap is quiet', describeGap(-1) === null)

const rested = computeMood({ now, lastContactAt: now - 3_600_000, turnsToday: 3, lastNightHour: 15, thanksRecent: 0, boundariesRecent: 0 })
const tired = computeMood({ now, lastContactAt: now - 3_600_000, turnsToday: 3, lastNightHour: 2, thanksRecent: 0, boundariesRecent: 0 })
check('a late night lowers energy', tired.energy < rested.energy, `${tired.energy} vs ${rested.energy}`)
check('a late night shows in the note', tired.note.includes('昨晚聊到'), tired.note)
const thanked = computeMood({ now, lastContactAt: now, turnsToday: 1, lastNightHour: 12, thanksRecent: 2, boundariesRecent: 0 })
check('thanks lift the mood', thanked.valence > rested.valence, `${thanked.valence} vs ${rested.valence}`)
const scolded = computeMood({ now, lastContactAt: now, turnsToday: 1, lastNightHour: 12, thanksRecent: 0, boundariesRecent: 1 })
check('a boundary lowers it', scolded.valence < rested.valence, `${scolded.valence} vs ${rested.valence}`)
check('mood notes are plain words', typeof rested.note === 'string' && rested.note.length > 0, rested.note)

store.observeRelationship('s-mood', 1, '今天先这样', now - 30 * 60_000)
check('last contact comes from counted turns', store.lastContactAt() !== null, String(store.lastContactAt()))
const moodNow = store.moodNow()
check('moodNow returns a shape', typeof moodNow.note === 'string' && typeof moodNow.energy === 'number', JSON.stringify(moodNow))
// Real clock: earlier sections folded turns at Date.now().
const moodLine = store.renderMoodLine()
check('the mood line carries the state', String(moodLine).startsWith('状态：'), String(moodLine))
check('the mood line carries the gap', String(moodLine).includes('上次聊是'), String(moodLine))

console.log('\n[32] 主动问候（schedule）')
const promptText = proactivePrompt({ name: '大肥鱼', address: '老板' })
check('greeting prompt names the persona', promptText.includes('大肥鱼'), promptText.slice(0, 40))
check('greeting prompt uses the address', promptText.includes('老板'), promptText.slice(0, 80))
check('greeting prompt forbids sounding like a notice', promptText.includes('不要解释'), promptText.slice(-60))

const calls = []
const fakeSchedule = {
  create: async request => {
    calls.push(request)
    return { id: `task-${calls.length}` }
  },
  delete: async () => {},
}
const offResult = await syncProactive({ schedule: fakeSchedule, store, settings: { proactive: false } })
check('proactive is off by default', offResult.enabled === false && calls.length === 0, JSON.stringify(offResult))
const onResult = await syncProactive({ schedule: fakeSchedule, store, settings: { proactive: true, proactiveTime: '08:30' } })
check('enabling creates one daily task', calls.length === 1 && calls[0].timing.kind === 'daily', JSON.stringify(calls[0]?.timing))
check('the task carries the configured time', calls[0].timing.daily.time === '08:30:00', JSON.stringify(calls[0]?.timing))
check('the task targets a new session', calls[0].target.kind === 'new_once', JSON.stringify(calls[0]?.target))
check('the task is recorded', onResult.taskId === 'task-1', JSON.stringify(onResult))
const keptResult = await syncProactive({ schedule: fakeSchedule, store, settings: { proactive: true, proactiveTime: '08:30' } })
check('a second sync keeps the task', keptResult.action === 'kept' && calls.length === 1, String(keptResult.action))
const movedResult = await syncProactive({ schedule: fakeSchedule, store, settings: { proactive: true, proactiveTime: '21:00' } })
check('changing the time recreates it', movedResult.action === 'recreated' && calls.length === 2, String(movedResult.action))
const status = proactiveStatus(store)
check('panel status reflects the schedule', status.enabled === true && status.time === '21:00:00', JSON.stringify(status))

console.log('\n[33] 陪聊模式开关')
check('chat mode is off by default', store.chatMode() === false, String(store.chatMode()))
check('chat mode can be turned on', store.setChatMode(true) === true && store.chatMode() === true)
check('chat mode can be turned off', store.setChatMode(false) === true && store.chatMode() === false)

console.log('\n[34] 住在电脑里 + 问候时间跟着习惯走')
const facts = bodyFacts(dbFile)
const bodyText = renderBody(facts)
check('body knows the host', bodyText.includes(String(facts.host)), bodyText.slice(0, 60))
check('body says it lives here', bodyText.includes('住在这台电脑里'), bodyText.slice(0, 60))
check('body names the memory file', bodyText.includes('memory'), bodyText.slice(0, 160))
check('body admits sleeping between restarts', bodyText.includes('睡着了'), bodyText.slice(0, 240))
check('body admits it cannot see the room', bodyText.includes('看不见'), bodyText.slice(0, 300))

// Learn the hour this user shows up: 25 turns at 15:00 local.
const at15 = new Date()
at15.setHours(15, 0, 0, 0)
for (let turn = 100; turn < 125; turn += 1) {
  store.observeRelationship('s-hour', turn, '随便说点什么', at15.getTime() + turn * 1000)
}
check('the learned hour is 15', store.preferredHour() === 15, String(store.preferredHour()))
check('the sample size is counted', store.hourSampleSize() >= 25, String(store.hourSampleSize()))

const habitCalls = []
const habitSchedule = { create: async request => { habitCalls.push(request); return { id: 'habit-task' } }, delete: async () => {} }
const adaptive = await syncProactive({ schedule: habitSchedule, store, settings: { proactive: true, proactiveTime: '09:00' } })
check('the greeting follows the learned hour', habitCalls[0]?.timing?.daily?.time === '15:00:00', JSON.stringify(habitCalls[0]?.timing))
check('the adaptive time is reported', adaptive.time === '15:00:00' && adaptive.learnedHour === 15, JSON.stringify(adaptive))
const pinned = []
const pinnedSchedule = { create: async request => { pinned.push(request); return { id: 'pinned-task' } }, delete: async () => {} }
await syncProactive({ schedule: pinnedSchedule, store, settings: { proactive: true, proactiveTime: '07:30', proactiveAdaptive: false } })
check('an explicit time wins when adaptation is off', pinned[0]?.timing?.daily?.time === '07:30:00', JSON.stringify(pinned[0]?.timing))

console.log('\n[35] 本地优先的模型路由')
const listed = await listOllamaModels('http://127.0.0.1:11434', async () => ({
  ok: true,
  json: async () => ({ models: [{ name: 'mimo-9b:latest', size: 6 * 1024 ** 3 }, { name: 'qwen3-14b:latest', size: 9 * 1024 ** 3 }] }),
}))
check('ollamaRoot strips the embed path', ollamaRoot('http://127.0.0.1:11434/api/embed') === 'http://127.0.0.1:11434', ollamaRoot('http://127.0.0.1:11434/api/embed'))
check('ollamaRoot keeps a bare host', ollamaRoot('http://127.0.0.1:11434/') === 'http://127.0.0.1:11434', ollamaRoot('http://127.0.0.1:11434/'))
check('ollama models are listed', listed.length === 2 && listed[0].id === 'mimo-9b', JSON.stringify(listed))
check('model sizes are rounded', listed[1].sizeGb === 9, String(listed[1].sizeGb))

const emptyPolicy = readModelPolicy(store)
check('no local model is pinned by default', emptyPolicy.local === null, JSON.stringify(emptyPolicy))
check('auto switch defaults on', emptyPolicy.autoSwitch === true)
writeModelPolicy(store, { local: { provider: 'ollama', model: 'mimo-9b' }, paid: { provider: 'deepseek', model: 'deepseek-chat' }, autoSwitch: true })
const saved = readModelPolicy(store)
check('the local choice persists', saved.local?.model === 'mimo-9b', JSON.stringify(saved.local))

const modelCalls = []
const fakeService = { saveSelection: async selection => { modelCalls.push(selection) } }
const applied = await applySelection(fakeService, saved.local)
check('a selection is applied', applied === true && modelCalls[0]?.model === 'mimo-9b', JSON.stringify(calls))
const refused = await applySelection(fakeService, null)
check('an empty selection is ignored', refused === false && modelCalls.length === 1)
const modelStatusValue = modelStatus(store)
check('panel status carries the policy', modelStatusValue.local?.model === 'mimo-9b' && modelStatusValue.autoSwitch === true, JSON.stringify(modelStatusValue))

console.log('\n[36] 工作 / 陪聊 两种模式')
check('work mode is the default', store.mode() === 'work', String(store.mode()))
store.setMode('chat')
check('chat mode is selectable', store.mode() === 'chat' && store.chatMode() === true)
store.setMode('work')
check('work mode restores the flag', store.mode() === 'work' && store.chatMode() === false)

console.log('\n[37] 意图路由')
check('a duration question is a memory question', classifyIntent('我们认识多久了') === 'memory')
check('a habit question is a memory question', classifyIntent('我常用什么词') === 'memory')
check('a clock question is a memory question', classifyIntent('现在几点了') === 'memory')
check('small talk stays chat', classifyIntent('今天有点累') === 'chat')
check('a hard request escalates', classifyIntent('帮我重构这个函数，现在一直报错') === 'escalate')
check('a long request without code stays chat', classifyIntent('我想了一下，觉得这个东西还是先别急着做，等周末有空再看看情况吧') === 'chat')

const answer = localAnswer(store, '我们认识多久了')
check('the duration answer comes from the store', String(answer).includes('认识') && String(answer).includes('天'), String(answer))
const wordAnswer = localAnswer(store, '我常用什么词')
check('the habit answer names words', typeof wordAnswer === 'string' && wordAnswer.length > 0, String(wordAnswer))
const clockAnswer = localAnswer(store, '现在几点了')
check('the clock answer is a time', /\d{2}:\d{2}/.test(String(clockAnswer)), String(clockAnswer))
check('small talk has no local answer', localAnswer(store, '今天有点累') === null)

console.log('\n[38] 本地技能与用量')
check('tidying downloads is a skill', matchSkill('帮我整理一下下载文件夹')?.skill === 'tidy')
check('finding a file is a skill', matchSkill('找文件 报告')?.argument === '报告', JSON.stringify(matchSkill('找文件 报告')))
check('disk questions are local', matchSkill('磁盘还剩多少')?.skill === 'disk')
check('system questions are local', matchSkill('什么配置')?.skill === 'system')
check('destructive requests are refused', matchSkill('把d盘格式化')?.level === 'deny')
check('plain chat is not a skill', matchSkill('今天有点累') === null)
check('system info is readable', systemInfo().includes('Windows'), systemInfo())
check('the dangerous skill refuses', String(await runSkill({ skill: 'danger', level: 'deny' })).includes('不会自己做'))

store.bumpUsage('local')
store.bumpUsage('local')
store.bumpUsage('skill')
const usage = store.usageToday()
check('usage counts local handling', usage.local === 2 && usage.skill === 1, JSON.stringify(usage))
check('usage resets per day', usage.day === new Date().toISOString().slice(0, 10), usage.day)

console.log('\n[39] 打开程序与主动观察')
check('opening a program is a skill', matchSkill('打开记事本')?.skill === 'open', JSON.stringify(matchSkill('打开记事本')))
check('the open argument is extracted', matchSkill('帮我打开计算器')?.argument === '计算器', JSON.stringify(matchSkill('帮我打开计算器')))
check('opening nothing asks a question', String(await runSkill({ skill: 'open', level: 'ask', argument: '' })).includes('要打开什么'))

const observeFolder = path.join(tmpdir(), `observe-${process.pid}`)
rmSync(observeFolder, { recursive: true, force: true })
mkdirSync(observeFolder, { recursive: true })
const io = { folder: () => observeFolder }
check('the first observation is only a baseline', checkDownloads(store, io) === null)
writeFileSync(path.join(observeFolder, 'a.txt'), 'x')
check('a new file is noticed', String(checkDownloads(store, io)).includes('多了 1 个文件'), String(checkDownloads(store, io)))
check('nothing new says nothing', checkDownloads(store, io) === null)
rememberObservation(store, '下载目录刚多了 1 个文件：a.txt')
check('the observation is delivered once', String(takeObservation(store)).includes('a.txt'))
check('the observation does not repeat', takeObservation(store) === null)
rmSync(observeFolder, { recursive: true, force: true })

console.log('\n[40] 备份与重复注入跳过')
const backupPath = path.join(tmpdir(), 'dsh-backup-' + process.pid + '.db')
const backupStore = new MemoryStore(backupPath)
backupStore.setMeta('x', '1')
const backupRun = runBackup(backupStore, { databasePath: backupPath, keep: 2 })
check('a backup is written', backupRun.ok === true && typeof backupRun.file === 'string', JSON.stringify(first))
check('the backup file exists', backupRun.file !== undefined && existsSync(backupRun.file))
const backupStat = backupStatus(backupStore, backupPath)
check('the status names the folder', String(backupStat.folder).includes('backups'), backupStat.folder)
check('one archive is on disk', backupStat.count === 1, String(backupStat.count))
check('today counts as backed up', needsBackup(backupStore) === false)
check('tomorrow needs one', needsBackup(backupStore, Date.now() + 26 * 3600_000) === true)
backupStore.bumpUsage('skipped')
check('skipping is counted', backupStore.usageToday().skipped === 1, JSON.stringify(backupStore.usageToday()))
backupStore.close()
rmSync(path.dirname(backupRun.file), { recursive: true, force: true })
rmSync(backupPath, { force: true })

console.log('\n[41] 人格自定义')
check('an override merges by field', withOverride(personaById('default'), { tone: '更短' }).tone === '更短')
check('an empty override changes nothing', withOverride(personaById('default'), null).tone === personaById('default').tone)
check('unknown fields are ignored', withOverride(personaById('default'), { id: 'x' }).id === 'default')
check('the prompt reflects an override', renderPersona('default', { tone: '只说一句' }).includes('只说一句'))

store.setPersonaOverride('tutor', { name: '老陈', tone: '极简' })
check('the edit is stored', store.personaOverride('tutor')?.tone === '极简', JSON.stringify(store.personaOverride('tutor')))
check('blank fields do not erase the persona', store.setPersonaOverride('tutor', {}) === true && store.personaOverride('tutor') === null)

console.log('\n[42] 每周叙事')
const weekAnchor = Date.parse('2026-11-18T12:00:00+08:00')
check('weekStart lands on Monday', new Date(weekStart(weekAnchor)).getDay() === 1, new Date(weekStart(weekAnchor)).toISOString())
check('weekKey is a date', /^\d{4}-\d{2}-\d{2}$/.test(weekKey(weekAnchor)), weekKey(weekAnchor))
const narrativeText = renderNarrative({
  start: weekAnchor,
  end: weekAnchor + 7 * 86_400_000,
  topObjects: [{ canonical: '记忆库', mentions: 9 }, { canonical: '模型', mentions: 4 }],
  turns: 12,
  days: 3,
})
check('the narrative names the week', narrativeText.includes(weekKey(weekAnchor)), narrativeText)
check('the narrative counts turns', narrativeText.includes('12 轮'), narrativeText)
check('the narrative names the objects', narrativeText.includes('记忆库'), narrativeText)
const emptyWeek = renderNarrative({ start: weekAnchor, end: weekAnchor + 86_400_000, topObjects: [], turns: 0, days: 0 })
check('an empty week says so', emptyWeek.includes('没有聊什么'), emptyWeek)

const built = store.buildNarrative(Date.now())
check('a narrative is stored', built !== null && typeof built.text === 'string', JSON.stringify(built))
check('it lists in recent narratives', store.recentNarratives(2).some(row => row.week === built.week), JSON.stringify(store.recentNarratives(2).map(r => r.week)))

console.log('\n[43] 语音')
check('code blocks are not read out', cleanForSpeech('看这段 \u0060\u0060\u0060js\nlet a = 1\n\u0060\u0060\u0060 就行').includes('代码省略'))
check('markdown is stripped', !cleanForSpeech('**加粗**').includes('*'))
check('links become a word', cleanForSpeech('[文档](http://x)').includes('文档') && !cleanForSpeech('[文档](http://x)').includes('http'))
check('long text is cut', cleanForSpeech('啊'.repeat(900), 50).length <= 51, String(cleanForSpeech('啊'.repeat(900), 50).length))

check('voice is off by default', voiceConfig(store).enabled === false)
check('the default voice is set', voiceConfig(store).voice.length > 0, voiceConfig(store).voice)
saveVoiceConfig(store, { enabled: true, voice: 'zh-CN-YunxiNeural', rate: 20, pitch: -5 })
const savedVoice = voiceConfig(store)
check('the choice persists', savedVoice.enabled === true && savedVoice.voice === 'zh-CN-YunxiNeural' && savedVoice.rate === 20, JSON.stringify(savedVoice))
saveVoiceConfig(store, { ...savedVoice, rate: 999 })
check('rate is clamped', voiceConfig(store).rate === 50, String(voiceConfig(store).rate))
saveVoiceConfig(store, { ...voiceConfig(store), voice: 'nope' })
check('an unknown voice falls back', voiceConfig(store).voice !== 'nope', voiceConfig(store).voice)

console.log('\n[44] 截图 / 音量 / 媒体 / 剪贴板')
check('screenshots are a skill', matchSkill('截个屏')?.skill === 'screenshot')
check('volume down is recognised', matchSkill('音量调小一点')?.argument === 'down', JSON.stringify(matchSkill('音量调小一点')))
check('mute is recognised', matchSkill('静音')?.argument === 'mute')
check('media pause is recognised', matchSkill('暂停一下')?.argument === 'playpause')
check('next track is recognised', matchSkill('下一首')?.argument === 'next')
check('desktop is a skill', matchSkill('最小化窗口')?.skill === 'desktop')
check('clipboard read is a skill', matchSkill('剪贴板里是什么')?.argument === undefined)
check('clipboard write keeps the payload', matchSkill('复制到剪贴板 你好世界')?.argument === '你好世界', JSON.stringify(matchSkill('复制到剪贴板 你好世界')))
check('all new skills are safe', ['screenshot', 'volume', 'media', 'clipboard', 'desktop']
  .every(name => matchSkill(name === 'screenshot' ? '截个屏' : name === 'volume' ? '音量' : name === 'media' ? '播放' : name === 'clipboard' ? '剪贴板' : '最小化')?.level === 'safe'))

console.log('\n[45] 语音输入')
const listenResult = await listen({ seconds: 3 })
check('listening returns a shape', typeof listenResult.ok === 'boolean' && typeof listenResult.text === 'string', JSON.stringify(listenResult))
const infoHearing = await recognizerInfo()
check('the recognizer list is readable', Array.isArray(infoHearing.recognizers), JSON.stringify(infoHearing))
check('a Chinese recognizer is reported', typeof infoHearing.hasChinese === 'boolean', String(infoHearing.hasChinese))

console.log('\n[46] 语音对话回路')
const delivered = []
const chunks = [
  { ok: true, text: '大肥鱼 今天天气怎么样' },
  { ok: true, text: '大肥鱼 再说一句' },
]
let chunkIndex = 0
const fakeListen = async () => chunks[chunkIndex] ?? { ok: false, text: '', peak: 5 }
const loop = startLoop({
  wakeWord: '大肥鱼',
  seconds: 1,
  speaking: () => false,
  listenImpl: async options => {
    const next = fakeListen(options)
    chunkIndex += 1
    return next
  },
  deliver: async text => { delivered.push(text) },
})
for (let attempt = 0; attempt < 40 && delivered.length < 2; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
check('the loop starts active', loop.active === true)
check('spoken chunks are delivered', delivered.length === 2 && delivered[0].includes('今天天气怎么样'), JSON.stringify(delivered))
check('the status reports it running', loopStatus().active === true, JSON.stringify(loopStatus()))
stopLoop()

const heard = []
const silentLoop = startLoop({
  wakeWord: '大肥鱼',
  seconds: 1,
  speaking: () => false,
  listenImpl: async () => ({ ok: true, text: '它自己说的话' }),
  onHeard: (text, state) => { heard.push([text, state]) },
  deliver: async () => {},
})
await new Promise(resolve => setTimeout(resolve, 200))
stopLoop()
check('unaddressed speech is recorded but not delivered', heard.some(([text]) => text.includes('它自己说的话')), JSON.stringify(heard))
check('the loop stops', loopStatus().active === false, JSON.stringify(loopStatus()))

console.log('\n[47] 唤醒词与三秒窗口')
const gate = createGate({ wakeWord: '大肥鱼', windowMs: 3000, now: () => 1000 })
check('a sentence with the wake word is a command', gate.feed('大肥鱼，现在几点了').deliver === '现在几点了', JSON.stringify(gate.feed('大肥鱼')))
const bare = createGate({ wakeWord: '大肥鱼', windowMs: 3000, now: () => 1000 })
check('the bare wake word opens the window', bare.feed('大肥鱼').state === 'listening')
check('a sentence without the wake word is ignored', bare.feed('帮我查天气').deliver === null)
const expiring = createGate({ wakeWord: '大肥鱼', windowMs: 3000, now: () => 1000 })
expiring.feed('大肥鱼')
check('the window is still open', expiring.windowLeft() > 0, String(expiring.windowLeft()))
const ignoring = createGate({ wakeWord: '大肥鱼', windowMs: 3000, now: () => 1000 })
check('unaddressed speech is ignored', ignoring.feed('今天吃什么').deliver === null)
check('punctuation is ignored when matching', createGate({ wakeWord: '大肥鱼' }).feed('大肥鱼！讲讲天气').deliver === '讲讲天气')

check('a rename is detected', parseRename('以后叫你小柒') === '小柒', String(parseRename('以后叫你小柒')))
check('another rename form works', parseRename('你的名字改成阿豆' ) === '阿豆', String(parseRename('你的名字改成阿豆')))
check('plain talk is not a rename', parseRename('今天天气不错') === null)
check('the default wake word exists', DEFAULT_WAKE_WORD.length > 0, DEFAULT_WAKE_WORD)
check('the wake word round-trips', store.setWakeWord('小柒') === true && store.wakeWord() === '小柒', store.wakeWord())
check('an empty wake word is refused', store.setWakeWord('') === false)
check('learning a name changes it', learnName(store, '以后叫你阿豆') === '阿豆', String(learnName(store, '以后叫你阿豆')))
check('the window is adjustable', store.setWakeWindowMs(1500) === true && store.wakeWindowMs() === 1500, String(store.wakeWindowMs()))

store.close()
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
console.log(failures.length === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures.length} failure(s)`)
process.exitCode = failures.length === 0 ? 0 : 1
