/**
 * SQLite memory store for the dsh-memory-store bundle.
 *
 * Deliberately free of any DeepSeek Harness import: `test/replay.mjs` replays
 * real session logs through this exact code path, so the schema and the event
 * handling are verified without booting the Host.
 *
 * Design notes (see dsh-memory-spec-2026-11-22.md):
 * - `occurrences` is populated later by the normalization stage; M1 only
 *   records turns, tool calls, subagent runs, and the user-text queue.
 * - Counts are always derived with COUNT(*); no counter columns.
 * - Every insert is idempotent so a repeated full scan cannot double count.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { computeMood, describeLastContact } from './mood.js'
/** Default name the user calls the assistant by. */
const DEFAULT_WAKE_WORD = '大肥鱼'

/** Default listening window after the name is said. */
const DEFAULT_WINDOW_MS = 3000
import { renderNarrative as renderWeekNarrative, weekKey as weekKeyOf, weekStart as weekStartOf } from './narrative.js'
import { profileOf, signalsOf } from './style.js'
import { createHash } from 'node:crypto'

/** Bumped whenever the schema or fold semantics change. */
export const SCHEMA_VERSION = 16

/** Tools whose digest names a file the turn actually wrote. */
const WRITE_TOOLS = new Set(['edit', 'write', 'apply_patch'])

/**
 * Synthetic user messages DSH records for its own bookkeeping. They carry no
 * memory: normalizing them turns "Asia/Shanghai" into a hundred-times-repeated
 * object that then crowds out real memories in every recall.
 */
export const RUNTIME_MESSAGE_PREFIXES = [
  'Time sampled while preparing',
  'Browser time zone for this request',
  'Elapsed since the preceding',
  'Current working directory:',
  '<system-reminder>',
]

/**
 * Synthetic user messages that still describe a real decision the human made
 * (changing approval policy, permissions, sandbox, preset). Those are memory.
 */
export const HUMAN_SOURCE_KINDS = new Set([
  'user',
  'user-approval',
  'user-permission',
  'user-sandbox',
  'user-preset',
])

/**
 * Whether one user-message payload is something worth remembering.
 * @param {{ source?: { kind?: string }, content?: unknown } | null | undefined} message
 * @param {string} text normalized text
 */
export function isHumanMessage(message, text) {
  if (text === '') return false
  if (RUNTIME_MESSAGE_PREFIXES.some(prefix => text.startsWith(prefix))) return false
  const kind = String(message?.source?.kind ?? '')
  // Older logs carry no source; those rows are kept.
  if (kind === '') return true
  return HUMAN_SOURCE_KINDS.has(kind)
}

/**
 * The file path a write-class tool digest starts with.
 * @param {unknown} digest
 * @returns {string}
 */
export function filePathOf(digest) {
  const text = typeof digest === 'string' ? digest : ''
  if (text === '') return ''
  const match = text.match(/[A-Za-z]:\\[^\s"']{2,}|(?:\.{0,2}[\\/])[^\s"']{2,}\.[A-Za-z0-9]{1,8}/)
  return match === null ? '' : match[0]
}

/** Forgetting: days for a memory to decay to 1/e at zero reviews. */
export const FORGET_TAU_DAYS = 90
/** Each review extends the memory's lifetime by this many days of tau. */
export const REVIEW_TAU_DAYS = 45

/**
 * Cosine similarity of two equal-length vectors.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function cosineSimilarity(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return 0
  const length = Math.min(a.length ?? 0, b.length ?? 0)
  if (length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    const left = Number(a[index]) || 0
    const right = Number(b[index]) || 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Levenshtein distance, used only on short object names (typo tolerance).
 * @param {string} left
 * @param {string} right
 */
export function editDistance(left, right) {
  const a = String(left)
  const b = String(right)
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 2) return 3
  const previous = new Array(b.length + 1)
  const current = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }
  return previous[b.length]
}

/** Event types kept from a subagent session; its conversation is never stored. */
const METADATA_ONLY_TYPES = new Set(['session/title', 'subagent/descriptor'])
/** Protects unrelated databases from being reused by mistake. */
export const APPLICATION_ID = 0x4453484d // 'DSHM'

/** Injected memory blocks carry this marker; they are never recorded again. */
export const MEMORY_MARKER = '[memory]'

const MAX_QUEUE_TEXT = 4000
/** Upper bound for one turn's stored conversation text. */
const MAX_TURN_TEXT = 60_000

/** Words that carry no habit signal on their own. */
const KEYWORD_STOP = new Set([
  '这个', '那个', '就是', '然后', '现在', '可以', '需要', '还是', '或者', '因为', '所以',
  '但是', '如果', '已经', '没有', '什么', '怎么', '一个', '一下', '不是', '我们', '你们',
  '它们', '为了', '这样', '那样', '时候', '问题', '东西', '地方', '方式', '情况', '进行',
  '开始', '帮我', '帮忙', '麻烦', '给我', '请你', '看看', '明天', '今天', '昨天', '先把',
  '之后', '之前', '而且', '不过', '其实', '应该', '可能', '一样', '一点', '这么', '那么',
  '就是', '还有', '就是有', '还有就是', '好了', '好吧', '行了', '那个', '这个', '一下',
  '要不', '不然', '同时', '另外', '此外', '然后呢', '怎么样', '可以不',
])

/** Connective patterns that must never surface as a "frequent keyword". */
const KEYWORD_JUNK = /^(就是|还有|然后|所以|但是|不过|而且|另外|同时|其实|这个|那个|这样|那样|好了|行了|一下|可以不)/

/**
 * Drop keyword rows that are discourse connectives rather than content.
 * @returns {number} rows removed
 */
function pruneKeywordRows(db) {
  try {
    const rows = db.prepare('SELECT term FROM keyword_stats').all()
    const remove = db.prepare('DELETE FROM keyword_stats WHERE term = ?')
    let removed = 0
    for (const row of rows) {
      const term = String(row.term)
      if (KEYWORD_STOP.has(term) || KEYWORD_JUNK.test(term)) {
        remove.run(term)
        removed += 1
      }
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * The content terms one message contributes to habit tracking. Longer runs score
 * higher, so a 4-character phrase outranks its own 2-character fragments.
 * @param {string} text
 * @returns {string[]}
 */
function keywordsOf(text) {
  const found = new Map()
  for (const run of String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    for (let size = 4; size >= 2; size -= 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        const term = run.slice(start, start + size)
        if (KEYWORD_STOP.has(term) || KEYWORD_JUNK.test(term)) continue
        found.set(term, (found.get(term) ?? 0) + size)
      }
    }
  }
  for (const word of String(text).match(/[A-Za-z][A-Za-z0-9_.#-]{2,}/g) ?? []) {
    found.set(word, (found.get(word) ?? 0) + 4)
  }
  return [...found.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([term]) => term)
}
const MAX_SUMMARY = 1200
const MAX_DIGEST = 64
const MAX_SUBAGENT_SUMMARY = 300

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY,
  canonical  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  workspace  TEXT,
  aliases    TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 500,
  use_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  archived   INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
) STRICT;
-- One row per object: the model may classify the same object under different
-- kinds on different turns, and a (kind, canonical) key would split it.
CREATE UNIQUE INDEX IF NOT EXISTS ux_entities ON entities(canonical);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  aliases, canonical, content='entities', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, aliases, canonical) VALUES (new.id, new.aliases, new.canonical);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, aliases, canonical)
  VALUES ('delete', old.id, old.aliases, old.canonical);
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, aliases, canonical)
  VALUES ('delete', old.id, old.aliases, old.canonical);
  INSERT INTO entities_fts(rowid, aliases, canonical) VALUES (new.id, new.aliases, new.canonical);
END;

CREATE TABLE IF NOT EXISTS occurrences (
  id         INTEGER PRIMARY KEY,
  entity_id  INTEGER NOT NULL REFERENCES entities(id),
  action     TEXT,
  state      TEXT,
  detail     TEXT,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  time       INTEGER NOT NULL,
  UNIQUE(session_id, seq)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_occ ON occurrences(entity_id, time DESC);

CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  workspace  TEXT,
  keywords   TEXT,
  summary    TEXT NOT NULL,
  summary_bi TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  time       INTEGER NOT NULL,
  user_text      TEXT,
  assistant_text TEXT,
  PRIMARY KEY(session_id, turn)
) STRICT;

CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  digest      TEXT,
  time        INTEGER NOT NULL,
  UNIQUE(session_id, seq)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_tool ON tool_calls(name, time DESC);

CREATE TABLE IF NOT EXISTS subagent_runs (
  run_id         TEXT PRIMARY KEY,
  parent_session TEXT NOT NULL,
  child_session  TEXT,
  name           TEXT,
  provider       TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  summary        TEXT,
  started_at     INTEGER,
  ended_at       INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS normalize_queue (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  done_at    INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  skipped    TEXT,
  UNIQUE(session_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS normalize_log (
  id            INTEGER PRIMARY KEY,
  queue_id      INTEGER,
  at            INTEGER NOT NULL,
  provider      TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  ok            INTEGER NOT NULL,
  error         TEXT,
  raw           TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS ix_normlog ON normalize_log(at DESC);

CREATE TABLE IF NOT EXISTS session_cursors (
  session_id TEXT PRIMARY KEY,
  max_seq    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- One row per Session: its title, and for a subagent child its descriptor label.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title      TEXT,
  label      TEXT,
  workspace  TEXT,
  origin     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Association: two objects mentioned in the same turn are linked, so recalling
-- one can surface the other (spreading activation).
CREATE TABLE IF NOT EXISTS entity_links (
  a         INTEGER NOT NULL REFERENCES entities(id),
  b         INTEGER NOT NULL REFERENCES entities(id),
  co_count  INTEGER NOT NULL DEFAULT 1,
  last_at   INTEGER NOT NULL,
  PRIMARY KEY (a, b)
) STRICT;

-- Message ids this plugin injected. Tracking identity instead of a text marker
-- keeps the injected text free of any label, and still stops the store from
-- recording its own injections.
CREATE TABLE IF NOT EXISTS injected_messages (
  message_id TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
) STRICT;

-- Sessions that already received the one-time workspace brief.
CREATE TABLE IF NOT EXISTS session_briefs (
  session_id TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
) STRICT;

-- What one turn actually touched on disk: the material a next window needs to
-- pick the work up instead of asking where the code is.
CREATE TABLE IF NOT EXISTS handoffs (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  files      TEXT NOT NULL,
  UNIQUE(session_id, turn)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_handoff ON handoffs(at DESC);

-- The model each Session is running on, so normalization can stay local when the
-- conversation is local instead of reaching for the profile default.
CREATE TABLE IF NOT EXISTS session_models (
  session_id TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  at         INTEGER NOT NULL
) STRICT;

-- Conversation records keyed by content, not by Session: the portable unit that
-- export carries and import deduplicates. The same content on two devices is one
-- row whose time range and count grow.
CREATE TABLE IF NOT EXISTS memory_records (
  hash           TEXT PRIMARY KEY,
  user_text      TEXT NOT NULL,
  assistant_text TEXT,
  first_at       INTEGER NOT NULL,
  last_at        INTEGER NOT NULL,
  count          INTEGER NOT NULL DEFAULT 1,
  source         TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS ix_records_time ON memory_records(last_at DESC);

-- Relationship: how well this assistant knows the user, and what it owes them.
-- One row per folded turn keeps the intimacy count idempotent across replays.
CREATE TABLE IF NOT EXISTS relationship_turns (
  session_id TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn)
) STRICT;

CREATE TABLE IF NOT EXISTS relationship_events (
  id     INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  note   TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
) STRICT;
CREATE INDEX IF NOT EXISTS ix_relationship_events ON relationship_events(kind, status);

-- One paragraph per week: what this relationship was about, in plain words.
CREATE TABLE IF NOT EXISTS narratives (
  week  TEXT PRIMARY KEY,
  text  TEXT NOT NULL,
  at    INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Behaviour counters (tone, length, punctuation): the other half of habits.
CREATE TABLE IF NOT EXISTS style_stats (
  signal     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;

-- Habits: the terms the user reaches for most often.
CREATE TABLE IF NOT EXISTS keyword_stats (
  term     TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_keywords_count ON keyword_stats(count DESC);

-- Semantic vectors, one per object. Embeddings are optional: without a model the
-- table stays empty and recall is lexical only.
CREATE TABLE IF NOT EXISTS entity_vectors (
  entity_id  INTEGER PRIMARY KEY REFERENCES entities(id),
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`

/**
 * Bigram shadow text for CJK runs, plain text elsewhere.
 *
 * FTS5 `unicode61` treats a contiguous CJK run as ONE token, so raw Chinese is
 * unsearchable. Cutting every CJK run into overlapping 2-character grams makes
 * 2-character queries work; Latin runs are left alone so words stay words.
 * Queries must apply this same transform.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function bigramText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g, run => {
      if (run.length < 2) return ' '
      const grams = []
      for (let index = 0; index < run.length - 1; index += 1) grams.push(run.slice(index, index + 2))
      return ` ${grams.join(' ')} `
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Concatenate the text blocks of a message content array.
 * @param {unknown} blocks
 * @returns {string}
 */
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * A stored message event carries the message either at `data.message` (assistant)
 * or directly on `data` (user); accept both.
 * @param {any} data
 */
function messageOf(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.message !== null && typeof data.message === 'object') return data.message
  return data
}

/** @param {unknown} value */
function oneLine(value) {
  return (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim()
}

/** @param {unknown} value */
function emptyToNull(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? null : text
}

const DIGEST_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'description',
  'prompt',
  'queries',
  'line',
  'query',
  'url',
  'method',
  'provider',
  'name',
  'labels',
  'todos',
]

/** Wrapper keys whose object is inspected one level deeper. */
const DIGEST_WRAPPERS = ['input', 'args', 'arguments', 'request', 'params']

/**
 * A short, human-meaningful summary of what one tool call did.
 * @param {unknown} raw
 * @returns {string}
 */
export function toolDigest(raw) {
  let text = ''
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    try {
      const parsed = JSON.parse(trimmed)
      text = digestOfObject(parsed, 0) || oneLine(trimmed)
    } catch {
      text = oneLine(trimmed)
    }
  } else if (raw !== null && typeof raw === 'object') {
    text = digestOfObject(raw, 0) || oneLine(JSON.stringify(raw))
  }
  return text.length > MAX_DIGEST ? `${text.slice(0, MAX_DIGEST - 1)}…` : text
}

/**
 * @param {any} value
 * @param {number} depth
 * @returns {string}
 */
function digestOfObject(value, depth) {
  if (value === null || typeof value !== 'object') return ''
  for (const key of DIGEST_KEYS) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return oneLine(candidate)
    if (Array.isArray(candidate) && candidate.length > 0) {
      const strings = candidate.filter(item => typeof item === 'string')
      if (strings.length > 0) return oneLine(strings.join(' '))
      if (typeof candidate[0] === 'object' && candidate[0] !== null) {
        const nested = digestOfObject(candidate[0], depth + 1)
        if (nested !== '') return nested
      }
    }
  }
  if (depth === 0) {
    for (const key of DIGEST_WRAPPERS) {
      const nested = digestOfObject(value[key], depth + 1)
      if (nested !== '') return nested
    }
  }
  return ''
}

/**
 * Add one column to a table that predates it.
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string} column
 * @param {string} ddl
 */
function ensureColumn(db, table, column, ddl) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  } catch {
    // A read-only or partially created database keeps working without it.
  }
}

/**
 * Merge entities an earlier schema split by `(kind, canonical)`, then key the
 * table on the canonical name alone.
 *
 * The model may classify the same object as both `object` and `preference` on
 * different turns (observed live: 审批策略 under both kinds). With a kind-scoped
 * key that produces two entities, which defeats "same meaning only accumulates".
 *
 * @param {DatabaseSync} db
 */
function migrateToCanonicalUnique(db) {
  let columns = []
  try {
    columns = db.prepare('PRAGMA index_info(ux_entities)').all().map(row => String(row.name))
  } catch {
    return
  }
  if (!columns.includes('kind')) return // already canonical-only
  db.exec('DROP INDEX IF EXISTS ux_entities')
  const duplicates = db
    .prepare('SELECT canonical, MIN(id) AS keep FROM entities GROUP BY canonical HAVING COUNT(*) > 1')
    .all()
  for (const row of duplicates) {
    const canonical = String(row.canonical)
    const keep = Number(row.keep)
    db.prepare(`
      UPDATE entities SET
        first_seen = (SELECT MIN(first_seen) FROM entities WHERE canonical = ?),
        last_seen  = (SELECT MAX(last_seen)  FROM entities WHERE canonical = ?),
        weight     = (SELECT MAX(weight)     FROM entities WHERE canonical = ?)
      WHERE id = ?
    `).run(canonical, canonical, canonical, keep)
    db.prepare(`
      UPDATE occurrences SET entity_id = ?
      WHERE entity_id IN (SELECT id FROM entities WHERE canonical = ? AND id <> ?)
    `).run(keep, canonical, keep)
    db.prepare('DELETE FROM entities WHERE canonical = ? AND id <> ?').run(canonical, keep)
  }
  db.exec('CREATE UNIQUE INDEX ux_entities ON entities(canonical)')
}

export class MemoryStore {
  /**
   * @param {string} file absolute database path
   * @param {{ describeTool?: (name: string) => string }} [options]
   */
  constructor(file, options = {}) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.file = file
    this.describeTool = options.describeTool ?? (name => `tool: ${name}`)
    /** @type {Map<string, number>} */
    this.turnOf = new Map()
    /** @type {Map<string, Set<string>>} files touched by the current turn */
    this.pendingFiles = new Map()
    /** @type {Map<string, { user: string[], assistant: string }>} full text of the current turn */
    this.pendingTurnText = new Map()
    const db = new DatabaseSync(file)
    this.db = db
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get()
    const { user_version: version } = db.prepare('PRAGMA user_version').get()
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      db.close()
      throw new Error(`memory store at "${file}" belongs to another application`)
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(SCHEMA)
    // Tables created by an older version keep their columns: add the ones the
    // normalization stage needs without dropping any recorded history.
    ensureColumn(db, 'normalize_queue', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'normalize_queue', 'last_error', 'last_error TEXT')
    ensureColumn(db, 'normalize_queue', 'skipped', 'skipped TEXT')
    ensureColumn(db, 'normalize_queue', 'turn', 'turn INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'normalize_log', 'raw', 'raw TEXT')
    // Memory-model columns, added in place so recorded history survives.
    ensureColumn(db, 'entities', 'use_count', 'use_count INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'entities', 'last_used_at', 'last_used_at INTEGER')
    // Archived objects stay in the database (they are history) but leave recall.
    ensureColumn(db, 'entities', 'archived', 'archived INTEGER NOT NULL DEFAULT 0')
    // Soft delete: a user-removed object leaves recall but can be restored.
    ensureColumn(db, 'entities', 'deleted_at', 'deleted_at INTEGER')
    // Merges from another device add mentions this machine has no occurrence for.
    ensureColumn(db, 'entities', 'imported_mentions', 'imported_mentions INTEGER NOT NULL DEFAULT 0')
    // Full conversation text, recorded on the turn row itself.
    ensureColumn(db, 'turns', 'user_text', 'user_text TEXT')
    ensureColumn(db, 'turns', 'assistant_text', 'assistant_text TEXT')
    // Records feed habit tracking exactly once.
    ensureColumn(db, 'memory_records', 'habits_done', 'habits_done INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'subagent_runs', 'child_session', 'child_session TEXT')
    ensureColumn(db, 'subagent_runs', 'name', 'name TEXT')
    migrateToCanonicalUnique(db)
    if (version !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.prepare('INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema', String(SCHEMA_VERSION))

    this.queueInsert = db.prepare(
      'INSERT OR IGNORE INTO normalize_queue(session_id, seq, text, added_at, turn) VALUES (?, ?, ?, ?, ?)',
    )
    this.turnUpsert = db.prepare(`
      INSERT INTO turns(session_id, turn, workspace, keywords, summary, summary_bi, seq, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET
        workspace  = COALESCE(excluded.workspace, turns.workspace),
        keywords   = COALESCE(excluded.keywords, turns.keywords),
        summary    = excluded.summary,
        summary_bi = excluded.summary_bi,
        seq        = excluded.seq,
        time       = excluded.time
    `)
    this.toolInsert = db.prepare(`
      INSERT OR IGNORE INTO tool_calls(session_id, seq, name, description, digest, time)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.subagentInsert = db.prepare(`
      INSERT INTO subagent_runs(run_id, parent_session, child_session, provider, outcome, started_at)
      VALUES (?, ?, ?, ?, 'running', ?)
      ON CONFLICT(run_id) DO NOTHING
    `)
    this.subagentFinish = db.prepare(`
      UPDATE subagent_runs SET outcome = ?, summary = ?, ended_at = ? WHERE run_id = ?
    `)
    this.cursorUpsert = db.prepare(`
      INSERT INTO session_cursors(session_id, max_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        max_seq = MAX(session_cursors.max_seq, excluded.max_seq),
        updated_at = excluded.updated_at
    `)
    this.handoffUpsert = db.prepare(`
      INSERT INTO handoffs(session_id, turn, at, files) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET files = excluded.files, at = excluded.at
    `)
  }

  /**
   * Fold one durable session event into the store.
   * @param {string} sessionId
   * @param {any} event
   * @param {{ workspace?: string | null, origin?: string | null, metadataOnly?: boolean }} [options]
   * @returns {boolean} whether the event produced a row
   */
  applySessionEvent(sessionId, event, options = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (event === null || typeof event !== 'object') return false
    // A subagent session contributes only its metadata, never its conversation.
    if (options.metadataOnly === true && !METADATA_ONLY_TYPES.has(event.type)) return false
    const time = Number(event.time) || Date.now()
    const seq = Number(event.seq) || 0
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    switch (event.type) {
      case 'session/title': {
        const title = oneLine(data.title)
        if (title === '') return false
        this.touchSession(sessionId, {
          title: title.slice(0, 200),
          workspace: typeof options.workspace === 'string' ? options.workspace : null,
          origin: typeof options.origin === 'string' ? options.origin : null,
        })
        return true
      }
      case 'subagent/descriptor': {
        // The label is the name the parent gave this child.
        const label = oneLine(data.label)
        this.touchSession(sessionId, {
          label: label === '' ? null : label.slice(0, 120),
          workspace: typeof options.workspace === 'string' ? options.workspace : null,
          origin: 'subagent',
        })
        return label !== ''
      }
      case 'turn/start': {
        const turn = Number(data.turn)
        if (Number.isSafeInteger(turn) && turn >= 0) this.turnOf.set(sessionId, turn)
        return false
      }
      case 'user/message': {
        const message = messageOf(data)
        const text = oneLine(blocksText(message?.content))
        if (text.includes(MEMORY_MARKER)) return false
        // Only what the human typed is memory material: DSH records its own time
        // snapshots and reminders as user messages, and normalizing those would
        // manufacture a high-frequency object that drowns out everything else.
        if (!isHumanMessage(message, text)) return false
        // Identity guard: never re-record a message this plugin injected.
        const messageId = String(message?.id ?? '')
        if (messageId !== '' && this.isInjected(messageId)) return false
        // Full text for the durable turn record, plus the habit counters.
        try {
          this.observeRelationship(sessionId, this.turnOf.get(sessionId) ?? 0, text, time)
        } catch {
          // The relationship is a nicety; capture must not depend on it.
        }
        const buffer = this.pendingTurnText.get(sessionId) ?? { user: [], assistant: '' }
        buffer.user.push(text.slice(0, MAX_TURN_TEXT))
        this.pendingTurnText.set(sessionId, buffer)
        const turn = this.turnOf.get(sessionId) ?? 0
        const result = this.queueInsert.run(sessionId, seq, text.slice(0, MAX_QUEUE_TEXT), time, turn)
        if (Number(result.changes) > 0) return true
        // The row predates the `turn` column (recorded as 0); a re-scan knows the
        // real turn, so record it now. Association keys off this value.
        if (turn > 0) {
          this.db.prepare(
            'UPDATE normalize_queue SET turn = ? WHERE session_id = ? AND seq = ? AND turn = 0',
          ).run(turn, sessionId, seq)
        }
        return false
      }
      case 'assistant/message': {
        const text = oneLine(blocksText(messageOf(data)?.content))
        if (text === '') return false
        // The last non-empty assistant text of a turn is its answer.
        const textBuffer = this.pendingTurnText.get(sessionId) ?? { user: [], assistant: '' }
        textBuffer.assistant = text.slice(0, MAX_TURN_TEXT)
        this.pendingTurnText.set(sessionId, textBuffer)
        const declared = Number(data.turn)
        const turn = Number.isSafeInteger(declared) && declared >= 0
          ? declared
          : (this.turnOf.get(sessionId) ?? 0)
        const summary = text.slice(0, MAX_SUMMARY)
        const result = this.turnUpsert.run(
          sessionId,
          turn,
          typeof options.workspace === 'string' ? options.workspace : null,
          null,
          summary,
          bigramText(summary),
          seq,
          time,
        )
        return Number(result.changes) > 0
      }
      case 'tool/call': {
        const name = String(data.name ?? '')
        if (name === '') return false
        const digest = toolDigest(data.arguments)
        const result = this.toolInsert.run(sessionId, seq, name, this.describeTool(name), digest, time)
        // Remember what this turn is touching, so `turn/end` can write a handoff.
        if (WRITE_TOOLS.has(name)) {
          const file = filePathOf(digest)
          if (file !== '') {
            if (!this.pendingFiles.has(sessionId)) this.pendingFiles.set(sessionId, new Set())
            this.pendingFiles.get(sessionId).add(file)
          }
        }
        return Number(result.changes) > 0
      }
      case 'turn/end': {
        const declared = Number(data.turn)
        const turn = Number.isSafeInteger(declared) && declared > 0
          ? declared
          : (this.turnOf.get(sessionId) ?? 0)
        // Full conversation text, even when nothing was written to disk.
        const buffer = this.pendingTurnText.get(sessionId)
        this.pendingTurnText.delete(sessionId)
        let recorded = false
        if (buffer !== undefined && turn > 0) {
          const userText = buffer.user.join('\n').slice(0, MAX_TURN_TEXT)
          const assistantText = buffer.assistant === '' ? null : buffer.assistant
          if (userText !== '') {
            this.recordTurnText(sessionId, turn, { userText, assistantText, time })
            recorded = this.recordConversation({ userText, assistantText, time, source: sessionId }) || recorded
          }
        }
        const files = this.pendingFiles.get(sessionId)
        this.pendingFiles.delete(sessionId)
        if (files !== undefined && files.size > 0 && turn > 0) {
          this.handoffUpsert.run(sessionId, turn, time, JSON.stringify([...files].slice(0, 12)))
          recorded = true
        }
        return recorded
      }
      default:
        return false
    }
  }

  /**
   * Make every stored tool purpose match `describe(name)`.
   *
   * Handles three cases in one pass: the `tool: <name>` fallback from an early
   * activation, a verbose registry description captured before the bundled map
   * won, and duplicate rows written under different descriptions. A purpose the
   * caller cannot resolve never degrades an existing one.
   *
   * @param {(name: string) => string} describe
   * @returns {number} repaired rows
   */
  repairToolDescriptions(describe) {
    const pairs = this.db
      .prepare('SELECT name, description, COUNT(*) AS c FROM tool_calls GROUP BY name, description')
      .all()
    const update = this.db.prepare(
      'UPDATE tool_calls SET description = ? WHERE name = ? AND description = ?',
    )
    let repaired = 0
    for (const row of pairs) {
      const name = String(row.name)
      const current = String(row.description ?? '')
      const next = describe(name)
      if (typeof next !== 'string' || next === '' || next === current) continue
      if (next === `tool: ${name}` && current !== `tool: ${name}`) continue
      repaired += Number(update.run(next, name, current).changes)
    }
    return repaired
  }

  // ---- normalization stage -------------------------------------------------

  /**
   * User messages still awaiting a card, oldest first.
   * @param {number} limit
   */
  queuePending(limit = 10) {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit) || 10))
    return this.db.prepare(`
      SELECT id, session_id, seq, turn, text, added_at, attempts
      FROM normalize_queue
      WHERE done_at IS NULL AND skipped IS NULL AND attempts < 3
      ORDER BY added_at ASC
      LIMIT ?
    `).all(bounded)
  }

  /** @param {number} id */
  markQueueDone(id) {
    this.db.prepare(
      'UPDATE normalize_queue SET done_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?',
    ).run(Date.now(), id)
  }

  /**
   * @param {number} id
   * @param {string} reason
   */
  markQueueSkipped(id, reason) {
    this.db.prepare(
      'UPDATE normalize_queue SET done_at = ?, skipped = ? WHERE id = ?',
    ).run(Date.now(), String(reason).slice(0, 60), id)
  }

  /**
   * @param {number} id
   * @param {string} error
   */
  markQueueFailed(id, error) {
    this.db.prepare(
      'UPDATE normalize_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?',
    ).run(String(error ?? '').slice(0, 200), id)
  }

  queueStats() {
    const one = sql => Number(this.db.prepare(sql).get().n)
    return {
      total: one('SELECT COUNT(*) AS n FROM normalize_queue'),
      pending: one('SELECT COUNT(*) AS n FROM normalize_queue WHERE done_at IS NULL AND skipped IS NULL AND attempts < 3'),
      skipped: one('SELECT COUNT(*) AS n FROM normalize_queue WHERE skipped IS NOT NULL'),
      failed: one('SELECT COUNT(*) AS n FROM normalize_queue WHERE attempts >= 3 AND done_at IS NULL'),
      done: one('SELECT COUNT(*) AS n FROM normalize_queue WHERE done_at IS NOT NULL'),
    }
  }

  /**
   * Existing canonical names that share bigrams with the text.
   *
   * With no bigrams to match on this lists the most recent entities; with
   * bigrams it returns *only* genuine matches. Returning a recency list for an
   * unrelated query would let a high-weight memory be recalled by any text.
   *
   * @param {readonly string[]} grams
   * @param {number} limit
   */
  candidateCanonicals(grams, limit = 12) {
    const bounded = Math.max(1, Math.min(40, limit))
    // Keep every distinct gram, not a positional prefix: a long message puts its
    // real intent late ("…请只回复一行中文：dsh用量插件的审批策略…"), and slicing to
    // the first ten silently dropped the part that mattered. Measured cost of 126
    // grams is ~4 ms at p50, which is cheap next to losing recall.
    const unique = [...new Set((grams ?? []).filter(gram => typeof gram === 'string' && gram.length >= 2))].slice(0, 200)
    if (unique.length === 0) {
      return this.db
        .prepare('SELECT canonical FROM entities WHERE archived = 0 AND deleted_at IS NULL ORDER BY last_seen DESC LIMIT ?')
        .all(bounded)
        .map(row => String(row.canonical))
    }
    const phrase = unique.map(gram => `"${gram.replaceAll('"', '""')}"`).join(' OR ')
    try {
      return this.db.prepare(`
        SELECT c.canonical AS canonical
        FROM entities_fts f JOIN entities c ON c.id = f.rowid
        WHERE entities_fts MATCH ? AND c.archived = 0 AND c.deleted_at IS NULL
        ORDER BY bm25(entities_fts)
        LIMIT ?
      `).all(phrase, bounded).map(row => String(row.canonical))
    } catch {
      return []
    }
  }

  /**
   * Fold one normalized card into an entity plus its occurrence.
   * Identical meaning keeps one entity and increments the occurrence count; the
   * original sentence is never stored, only the `(session_id, seq)` pointer.
   *
   * @param {{ sessionId: string, seq: number, turn: number, time: number, card: any }} input
   * @returns {{ entityId: number, created: boolean }}
   */
  applyCard(input) {
    const card = input.card
    // Reuse an existing spelling when only case or spacing differs, so "DSH 插件"
    // and "dsh插件" cannot become two entities.
    const canonical = this.resolveCanonical(String(card.canonical))
    const kind = String(card.kind ?? 'topic')
    const aliases = bigramText(`${canonical} ${(card.keywords ?? []).join(' ')}`)
    const time = Number(input.time) || Date.now()
    const weight = Math.max(0, Math.min(1000, Math.trunc(Number(card.weight) || 500)))
    const existing = this.db
      .prepare('SELECT id FROM entities WHERE canonical = ?')
      .get(canonical)
    this.db.prepare(`
      INSERT INTO entities(canonical, kind, workspace, aliases, first_seen, last_seen, weight)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(canonical) DO UPDATE SET
        kind       = excluded.kind,
        first_seen = MIN(entities.first_seen, excluded.first_seen),
        last_seen  = MAX(entities.last_seen, excluded.last_seen),
        weight     = excluded.weight,
        archived   = 0,
        deleted_at = NULL,
        aliases    = CASE
                       WHEN instr(entities.aliases, excluded.aliases) > 0 THEN entities.aliases
                       WHEN length(entities.aliases) > 400 THEN entities.aliases
                       ELSE entities.aliases || ' ' || excluded.aliases
                     END
    `).run(canonical, kind, aliases, time, time, weight)
    const entityId = existing === undefined
      ? Number(this.db.prepare('SELECT id FROM entities WHERE canonical = ?').get(canonical).id)
      : Number(existing.id)
    this.db.prepare(`
      INSERT OR IGNORE INTO occurrences(entity_id, action, state, detail, session_id, seq, turn, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entityId,
      emptyToNull(card.action),
      emptyToNull(card.state),
      emptyToNull(card.detail),
      String(input.sessionId),
      Number(input.seq) || 0,
      Number(input.turn) || 0,
      time,
    )
    // Association: objects mentioned in the same turn become linked, so recalling
    // one can surface the other. Turn 0 means the turn is unknown (rows recorded
    // before the column existed); linking those would create false associations.
    const turn = Number(input.turn) || 0
    if (turn > 0) {
      const siblings = this.db.prepare(`
        SELECT DISTINCT entity_id FROM occurrences
        WHERE session_id = ? AND turn = ? AND entity_id <> ?
      `).all(String(input.sessionId), turn, entityId)
      if (siblings.length > 0) {
        const link = this.db.prepare(`
          INSERT INTO entity_links(a, b, co_count, last_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(a, b) DO UPDATE SET co_count = co_count + 1, last_at = excluded.last_at
        `)
        for (const sibling of siblings) {
          const otherId = Number(sibling.entity_id)
          if (!Number.isSafeInteger(otherId) || otherId === entityId) continue
          link.run(Math.min(entityId, otherId), Math.max(entityId, otherId), time)
        }
      }
    }
    return { entityId, created: existing === undefined }
  }

  /** @param {{ queueId?: number, provider?: string, model?: string, inputTokens?: number, outputTokens?: number, ok: boolean, error?: string, raw?: string }} entry */
  logNormalize(entry) {
    this.db.prepare(`
      INSERT INTO normalize_log(queue_id, at, provider, model, input_tokens, output_tokens, ok, error, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.queueId ?? null,
      Date.now(),
      entry.provider ?? null,
      entry.model ?? null,
      Number(entry.inputTokens) || 0,
      Number(entry.outputTokens) || 0,
      entry.ok ? 1 : 0,
      entry.error === undefined ? null : String(entry.error).slice(0, 200),
      entry.raw === undefined ? null : String(entry.raw).slice(0, 500),
    )
  }

  normalizeStats() {
    const one = sql => Number(this.db.prepare(sql).get().n)
    return {
      calls: one('SELECT COUNT(*) AS n FROM normalize_log'),
      failedCalls: one('SELECT COUNT(*) AS n FROM normalize_log WHERE ok = 0'),
      inputTokens: one('SELECT COALESCE(SUM(input_tokens), 0) AS n FROM normalize_log'),
      outputTokens: one('SELECT COALESCE(SUM(output_tokens), 0) AS n FROM normalize_log'),
      entities: one('SELECT COUNT(*) AS n FROM entities'),
      occurrences: one('SELECT COUNT(*) AS n FROM occurrences'),
    }
  }

  /**
   * Fuzzy fallback for when no bigram matched at all: a typo ("记意库"), a longer
   * phrasing that contains the name, or a name merged away earlier. Matching is a
   * linear scan over a few hundred names, cheaper than any index at this scale.
   *
   * @param {string} text cleaned query
   * @param {{ limit?: number, workspace?: string | null, now?: number }} [options]
   */
  fuzzyRecall(text, options = {}) {
    const query = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (query.length < 2) return []
    const limit = Math.max(1, Math.min(10, options.limit ?? 3))
    const now = Number(options.now) || Date.now()
    const workspace = typeof options.workspace === 'string' && options.workspace !== '' ? options.workspace : null
    const workspaceCheck = workspace === null ? null : this.db.prepare(`
      SELECT 1 AS hit FROM occurrences o
      JOIN sessions s ON s.session_id = o.session_id
      WHERE o.entity_id = ? AND s.workspace = ? LIMIT 1
    `)
    const rows = this.db.prepare(`
      SELECT e.id, e.canonical, e.kind, e.weight, e.use_count, e.first_seen, e.last_seen,
             COALESCE(e.aliases, '') AS aliases, COUNT(o.id) + COALESCE(e.imported_mentions, 0) AS mentions
      FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id
      WHERE e.archived = 0 AND e.deleted_at IS NULL
      GROUP BY e.id
    `).all()
    const detail = this.db.prepare(`
      SELECT action, state, detail, time FROM occurrences
      WHERE entity_id = ? ORDER BY time DESC LIMIT 1
    `)
    const hits = []
    for (const row of rows) {
      const names = [String(row.canonical), ...String(row.aliases).split(' ').filter(Boolean)]
      let similarity = 0
      for (const name of names) {
        if (name.length < 2) continue
        if (name === query) {
          similarity = Math.max(similarity, 1)
          continue
        }
        if (query.includes(name) || name.includes(query)) {
          similarity = Math.max(similarity, 0.8)
          continue
        }
        const allowed = name.length <= 5 ? 1 : 2
        const distance = editDistance(query, name)
        if (distance <= allowed) similarity = Math.max(similarity, distance === 1 ? 0.7 : 0.55)
      }
      if (similarity === 0) continue
      const reviews = Number(row.use_count) || 0
      const ageDays = Math.max(0, (now - Number(row.last_seen)) / 86_400_000)
      const tau = FORGET_TAU_DAYS + REVIEW_TAU_DAYS * Math.log1p(reviews)
      const latest = detail.get(row.id)
      hits.push({
        id: Number(row.id),
        canonical: String(row.canonical),
        kind: String(row.kind),
        weight: Number(row.weight),
        mentions: Number(row.mentions),
        lastSeen: Number(row.last_seen),
        firstSeen: Number(row.first_seen),
        shared: 2,
        reviews,
        retention: Math.exp(-ageDays / tau),
        inWorkspace: workspaceCheck === null ? false : workspaceCheck.get(row.id, workspace) !== undefined,
        fuzzy: true,
        action: latest?.action ?? '',
        state: latest?.state ?? '',
        detail: latest?.detail ?? '',
        score: 0.40 + 0.18 * similarity,
      })
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit)
  }

  /**
   * Recall entities for a query, newest and heaviest first.
   *
   * Ranking is local and cheap: no model call. Existing entities are found by
   * bigram candidates, then scored by mention count, weight, and recency.
   *
   * @param {readonly string[]} grams
   * @param {{ limit?: number, now?: number, workspace?: string | null }} [options]
   */
  recall(grams, options = {}) {
    const limit = Math.max(1, Math.min(50, options.limit ?? 8))
    const now = Number(options.now) || Date.now()
    const workspace = typeof options.workspace === 'string' && options.workspace !== '' ? options.workspace : null
    const candidates = this.candidateCanonicals(grams, Math.max(limit * 3, 12))
    if (candidates.length === 0) return []
    const placeholders = candidates.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT e.id, e.canonical, e.kind, e.weight, e.first_seen, e.last_seen, e.aliases,
             e.use_count, e.last_used_at, COUNT(o.id) + COALESCE(e.imported_mentions, 0) AS mentions
      FROM entities e
      LEFT JOIN occurrences o ON o.entity_id = e.id
      WHERE e.canonical IN (${placeholders}) AND e.archived = 0 AND e.deleted_at IS NULL
      GROUP BY e.id
    `).all(...candidates)
    const wanted = [...new Set((grams ?? []).filter(gram => typeof gram === 'string' && gram !== ''))]
    const detail = this.db.prepare(`
      SELECT action, state, detail, time FROM occurrences
      WHERE entity_id = ? ORDER BY time DESC LIMIT 1
    `)
    // Home-workspace membership is a *boost*, never a filter: memory stays global.
    const workspaceCheck = workspace === null ? null : this.db.prepare(`
      SELECT 1 AS hit FROM occurrences o
      JOIN sessions s ON s.session_id = o.session_id
      WHERE o.entity_id = ? AND s.workspace = ? LIMIT 1
    `)
    const scored = rows.filter(row => {
      // Guard against a loose candidate list: the entity must actually share a
      // bigram with the query, in its name or its keywords.
      const haystack = `${row.canonical} ${row.aliases ?? ''}`
      return wanted.some(gram => haystack.includes(gram))
    }).map(row => {
      const last = detail.get(row.id)
      // Human-memory model: a memory fades with time and is kept alive by recall.
      const touched = Math.max(Number(row.last_seen), Number(row.last_used_at ?? 0))
      const ageDays = Math.max(0, (now - touched) / 86_400_000)
      const reviews = Number(row.use_count ?? 0)
      const tau = FORGET_TAU_DAYS + REVIEW_TAU_DAYS * Math.log1p(reviews)
      const retention = Math.exp(-ageDays / tau)
      const importance = Number(row.weight) / 1000
      const frequency = Math.min(1, Math.log1p(Number(row.mentions)) / Math.log(11))
      const rehearsal = Math.min(1, Math.log1p(reviews) / Math.log(11))
      // Overlap strength dominates: sharing one incidental gram with a
      // high-weight entity must not outrank a precise three-gram match.
      const haystack = `${row.canonical} ${row.aliases ?? ''}`
      const shared = wanted.filter(gram => haystack.includes(gram)).length
      const relevance = Math.min(1, shared / 3)
      const inWorkspace = workspaceCheck === null ? false : workspaceCheck.get(row.id, workspace) !== undefined
      const score = 0.38 * relevance + 0.22 * retention + 0.18 * importance
        + 0.12 * frequency + 0.10 * rehearsal + (inWorkspace ? 0.10 : 0)
      return {
        id: Number(row.id),
        canonical: String(row.canonical),
        kind: String(row.kind),
        weight: Number(row.weight),
        mentions: Number(row.mentions),
        lastSeen: Number(row.last_seen),
        firstSeen: Number(row.first_seen),
        shared,
        reviews,
        retention,
        inWorkspace,
        action: last === undefined ? '' : String(last.action ?? ''),
        state: last === undefined ? '' : String(last.state ?? ''),
        detail: last === undefined ? '' : String(last.detail ?? ''),
        score,
      }
    })
    return scored.sort((left, right) => right.score - left.score).slice(0, limit)
  }

  /**
   * Existing spelling of an equivalent name, or the input when none exists.
   * @param {string} canonical
   */
  resolveCanonical(canonical) {
    const row = this.db.prepare(`
      SELECT canonical FROM entities
      WHERE lower(replace(canonical, ' ', '')) = lower(replace(?, ' ', ''))
      LIMIT 1
    `).get(canonical)
    return row === undefined ? canonical : String(row.canonical)
  }

  /**
   * Move every occurrence of one entity into another and drop the source.
   *
   * The pointer table keeps this reversible in principle: merged occurrences keep
   * their `(session_id, seq)`, so a future split can walk them back.
   *
   * @param {string} fromCanonical
   * @param {string} intoCanonical
   * @returns {{ ok: boolean, moved?: number, dropped?: number, relinked?: number, error?: string }}
   */
  mergeEntities(fromCanonical, intoCanonical) {
    const from = this.db.prepare('SELECT * FROM entities WHERE canonical = ?').get(fromCanonical)
    const into = this.db.prepare('SELECT * FROM entities WHERE canonical = ?').get(intoCanonical)
    if (from === undefined) return { ok: false, error: 'source-not-found' }
    if (into === undefined) return { ok: false, error: 'target-not-found' }
    if (Number(from.id) === Number(into.id)) return { ok: false, error: 'same-entity' }
    let moved = 0
    let dropped = 0
    let relinked = 0
    this.db.exec('BEGIN')
    try {
      moved = Number(this.db.prepare('UPDATE OR IGNORE occurrences SET entity_id = ? WHERE entity_id = ?')
        .run(into.id, from.id).changes)
      // Rows skipped because the target already records that exact pointer.
      dropped = Number(this.db.prepare('DELETE FROM occurrences WHERE entity_id = ?').run(from.id).changes)
      // Association edges reference entities, so they must move before the source
      // row can go: fold the source's edges into the target's.
      const edges = this.db.prepare(`
        SELECT CASE WHEN a = ? THEN b ELSE a END AS other, co_count, last_at
        FROM entity_links WHERE a = ? OR b = ?
      `).all(from.id, from.id, from.id)
      this.db.prepare('DELETE FROM entity_links WHERE a = ? OR b = ?').run(from.id, from.id)
      const upsertEdge = this.db.prepare(`
        INSERT INTO entity_links(a, b, co_count, last_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(a, b) DO UPDATE SET
          co_count = co_count + excluded.co_count,
          last_at  = MAX(entity_links.last_at, excluded.last_at)
      `)
      for (const edge of edges) {
        const other = Number(edge.other)
        if (!Number.isSafeInteger(other) || other === Number(from.id) || other === Number(into.id)) continue
        upsertEdge.run(
          Math.min(Number(into.id), other),
          Math.max(Number(into.id), other),
          Number(edge.co_count) || 1,
          Number(edge.last_at) || Date.now(),
        )
        relinked += 1
      }
      // Keep the merged name reachable: the old words are how the user remembers it.
      const inherited = `${String(from.aliases ?? '')} ${String(from.canonical ?? '')}`.trim()
      this.db.prepare(`
        UPDATE entities SET
          first_seen = MIN(first_seen, ?),
          last_seen  = MAX(last_seen, ?),
          weight     = MAX(weight, ?),
          use_count  = use_count + ?,
          aliases    = CASE
                         WHEN instr(aliases, ?) > 0 THEN aliases
                         WHEN length(aliases) > 400 THEN aliases
                         ELSE aliases || ' ' || ? END
        WHERE id = ?
      `).run(
        Number(from.first_seen), Number(from.last_seen), Number(from.weight),
        Number(from.use_count ?? 0), inherited, inherited, into.id,
      )
      // Vectors reference the entity too; the merged row can be re-embedded later.
      this.db.prepare('DELETE FROM entity_vectors WHERE entity_id = ?').run(from.id)
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(from.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: String(error?.message ?? error) }
    }
    return { ok: true, moved, dropped, relinked }
  }

  /**
   * Merge entities that differ only by case or spacing, keeping the heaviest
   * spelling. Records written before canonical normalization existed need this.
   * @returns {number} merged entity count
   */
  repairCanonicalDuplicates() {
    const groups = this.db.prepare(`
      SELECT lower(replace(canonical, ' ', '')) AS k
      FROM entities GROUP BY k HAVING COUNT(*) > 1
    `).all()
    let merged = 0
    for (const group of groups) {
      const rows = this.db.prepare(`
        SELECT canonical FROM entities
        WHERE lower(replace(canonical, ' ', '')) = ?
        ORDER BY weight DESC, last_seen DESC
      `).all(String(group.k))
      if (rows.length < 2) continue
      const keep = String(rows[0].canonical)
      for (const row of rows.slice(1)) {
        const result = this.mergeEntities(String(row.canonical), keep)
        if (result.ok) merged += 1
      }
    }
    return merged
  }

  /**
   * Record or update one Session's identity row.
   *
   * `title` is the user-facing Session title; `label` is the name a parent gave a
   * subagent child (from its `subagent/descriptor` event). A new label is also
   * written onto the matching run row, so the run list can show the given name.
   *
   * @param {string} sessionId
   * @param {{ title?: string | null, label?: string | null, workspace?: string | null, origin?: string | null, createdAt?: number }} [patch]
   */
  touchSession(sessionId, patch = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const now = Date.now()
    const createdAt = Number.isFinite(Number(patch.createdAt)) && Number(patch.createdAt) > 0
      ? Number(patch.createdAt)
      : now
    const existing = this.db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId)
    if (existing === undefined) {
      this.db.prepare(`
        INSERT INTO sessions(session_id, title, label, workspace, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        patch.title ?? null,
        patch.label ?? null,
        patch.workspace ?? null,
        patch.origin ?? null,
        createdAt,
        now,
      )
    } else {
      this.db.prepare(`
        UPDATE sessions SET
          title      = COALESCE(?, title),
          label      = COALESCE(?, label),
          workspace  = COALESCE(?, workspace),
          origin     = COALESCE(?, origin),
          created_at = MIN(created_at, ?),
          updated_at = ?
        WHERE session_id = ?
      `).run(
        patch.title ?? null,
        patch.label ?? null,
        patch.workspace ?? null,
        patch.origin ?? null,
        createdAt,
        now,
        sessionId,
      )
    }
    if (typeof patch.label === 'string' && patch.label !== '') {
      this.db.prepare('UPDATE subagent_runs SET name = ? WHERE child_session = ?').run(patch.label, sessionId)
    }
  }

  /**
   * Known Sessions, newest activity first, with a subagent run outcome when the
   * Session is a child.
   * @param {number} limit
   */
  sessionsOf(limit = 40) {
    return this.db.prepare(`
      SELECT s.session_id, s.title, s.label, s.origin, s.workspace, s.updated_at,
             (SELECT outcome FROM subagent_runs r WHERE r.child_session = s.session_id) AS outcome,
             (SELECT name    FROM subagent_runs r WHERE r.child_session = s.session_id) AS run_name
      FROM sessions s
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, limit)))
  }

  /**
   * Spaced-repetition reinforcement: one recall extends the memory's lifetime.
   * @param {readonly number[]} ids
   * @param {number} [now]
   * @returns {number} rows updated
   */
  reinforce(ids, now = Date.now()) {
    const unique = [...new Set((ids ?? []).map(Number).filter(Number.isSafeInteger))]
    if (unique.length === 0) return 0
    const statement = this.db.prepare('UPDATE entities SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    let updated = 0
    for (const id of unique) updated += Number(statement.run(now, id).changes)
    return updated
  }

  /**
   * Objects associated with the given ones by co-mention, most associated first.
   * These are the "one thing reminds me of another" candidates.
   * @param {readonly number[]} ids
   * @param {number} minCo minimum co-mentions
   * @param {number} limit
   */
  relatedItems(ids, minCo = 2, limit = 2) {
    const unique = [...new Set((ids ?? []).map(Number).filter(Number.isSafeInteger))]
    if (unique.length === 0) return []
    let rows = []
    try {
      rows = this.db.prepare(`
        WITH seed(id) AS (SELECT value FROM json_each(?))
        SELECT e.id, e.canonical, e.kind, e.weight, e.last_seen, SUM(l.co_count) AS co
        FROM entity_links l
        JOIN entities e ON e.id = CASE WHEN l.a IN (SELECT id FROM seed) THEN l.b ELSE l.a END
        WHERE (l.a IN (SELECT id FROM seed) OR l.b IN (SELECT id FROM seed))
          AND e.id NOT IN (SELECT id FROM seed)
          AND e.archived = 0 AND e.deleted_at IS NULL
        GROUP BY e.id
        HAVING SUM(l.co_count) >= ?
        ORDER BY co DESC, e.last_seen DESC
        LIMIT ?
      `).all(JSON.stringify(unique), minCo, Math.max(1, Math.min(10, limit)))
    } catch {
      return []
    }
    const detail = this.db.prepare(
      'SELECT action, state, detail FROM occurrences WHERE entity_id = ? ORDER BY time DESC LIMIT 1',
    )
    return rows.map(row => {
      const last = detail.get(row.id)
      return {
        id: Number(row.id),
        canonical: String(row.canonical),
        kind: String(row.kind),
        weight: Number(row.weight),
        mentions: Number(row.co),
        lastSeen: Number(row.last_seen),
        firstSeen: Number(row.last_seen),
        shared: Number(row.co),
        action: last === undefined ? '' : String(last.action ?? ''),
        state: last === undefined ? '' : String(last.state ?? ''),
        detail: last === undefined ? '' : String(last.detail ?? ''),
        score: 0,
      }
    })
  }

  /**
   * Fill in the turn of occurrences recorded before the turn was known.
   *
   * Occurrences carry the user-message pointer, so the queue row supplies the
   * turn. Without this, every historical row sits at turn 0 and association —
   * which groups by turn — finds nothing.
   *
   * @returns {number} rows updated
   */
  repairTurns() {
    let updated = 0
    try {
      updated = Number(this.db.prepare(`
        UPDATE occurrences SET turn = (
          SELECT q.turn FROM normalize_queue q
          WHERE q.session_id = occurrences.session_id AND q.seq = occurrences.seq
        )
        WHERE turn = 0
          AND EXISTS (
            SELECT 1 FROM normalize_queue q
            WHERE q.session_id = occurrences.session_id AND q.seq = occurrences.seq AND q.turn > 0
          )
      `).run().changes)
    } catch {
      return 0
    }
    return updated
  }

  /**
   * Rebuild association edges from recorded occurrences.
   *
   * Links are created when a card arrives, so history recorded before the
   * association table existed has none. This walks the existing occurrences once
   * and pairs every set of objects that share a known turn.
   *
   * @returns {number} links created or reinforced
   */
  repairLinks() {
    const rows = this.db.prepare(`
      SELECT session_id, turn, GROUP_CONCAT(DISTINCT entity_id) AS ids, MAX(time) AS last_at
      FROM occurrences
      WHERE turn > 0
      GROUP BY session_id, turn
      HAVING COUNT(DISTINCT entity_id) > 1
    `).all()
    if (rows.length === 0) return 0
    const link = this.db.prepare(`
      INSERT OR IGNORE INTO entity_links(a, b, co_count, last_at) VALUES (?, ?, 1, ?)
    `)
    let touched = 0
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        const ids = String(row.ids ?? '').split(',').map(Number).filter(Number.isSafeInteger)
        if (ids.length < 2) continue
        for (let i = 0; i < ids.length; i += 1) {
          for (let j = i + 1; j < ids.length; j += 1) {
            if (ids[i] === ids[j]) continue
            // Count real inserts only: `OR IGNORE` skips pairs already linked.
            touched += Number(link.run(
              Math.min(ids[i], ids[j]),
              Math.max(ids[i], ids[j]),
              Number(row.last_at) || Date.now(),
            ).changes)
          }
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return touched
  }

  /** @param {string} messageId @returns {boolean} */
  isInjected(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return false
    try {
      const row = this.db.prepare('SELECT 1 AS hit FROM injected_messages WHERE message_id = ?').get(messageId)
      return row !== undefined
    } catch {
      return false
    }
  }

  /** @param {string} messageId */
  recordInjected(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return
    try {
      this.db.prepare('INSERT OR IGNORE INTO injected_messages(message_id, at) VALUES (?, ?)')
        .run(messageId, Date.now())
    } catch {
      // A missed id only means the injected text may be recorded again later.
    }
  }

  /** @param {string} sessionId */
  sessionWorkspace(sessionId) {
    try {
      const row = this.db.prepare('SELECT workspace FROM sessions WHERE session_id = ?').get(sessionId)
      return row === undefined || row.workspace === null ? null : String(row.workspace)
    } catch {
      return null
    }
  }

  /**
   * Workspace and origin of one Session, as far as the store knows it.
   * @param {string} sessionId
   * @returns {{ workspace: string | null, origin: string | null }}
   */
  sessionIdentity(sessionId) {
    try {
      const row = this.db.prepare('SELECT workspace, origin FROM sessions WHERE session_id = ?').get(sessionId)
      if (row === undefined) return { workspace: null, origin: null }
      return {
        workspace: row.workspace === null ? null : String(row.workspace),
        origin: row.origin === null ? null : String(row.origin),
      }
    } catch {
      return { workspace: null, origin: null }
    }
  }

  /** @param {string} sessionId @returns {boolean} */
  wasBriefed(sessionId) {
    try {
      return this.db.prepare('SELECT 1 AS hit FROM session_briefs WHERE session_id = ?').get(sessionId) !== undefined
    } catch {
      return false
    }
  }

  /** @param {string} sessionId */
  markBriefed(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    try {
      this.db.prepare('INSERT OR IGNORE INTO session_briefs(session_id, at) VALUES (?, ?)').run(sessionId, Date.now())
    } catch {
      // A missed marker only means one extra brief later.
    }
  }

  /**
   * The newest objects across **every** workspace.
   *
   * Memory is shared across workspaces by design, so the orientation line must not
   * be scoped to one: a new window in any workspace should see what the whole
   * memory has been dealing with lately.
   *
   * @param {number} limit
   * @returns {{ total: number, items: Array<{ canonical: string, mentions: number, lastSeen: number }> } | null}
   */
  /**
   * Split one object in two: occurrences at or after `since` move to a new canonical
   * name. The reverse of a merge, for the case where the model folded two things
   * into one name.
   *
   * @param {string} canonical
   * @param {string} newName
   * @param {{ since?: number }} [options]
   */
  splitEntity(canonical, newName, options = {}) {
    const fromName = String(canonical ?? '')
    const toName = String(newName ?? '').trim()
    if (fromName === '' || toName === '') return { ok: false, error: 'invalid-names' }
    if (fromName === toName) return { ok: false, error: 'same-name' }
    const from = this.db.prepare('SELECT * FROM entities WHERE canonical = ?').get(fromName)
    if (from === undefined) return { ok: false, error: 'source-not-found' }
    if (this.db.prepare('SELECT id FROM entities WHERE canonical = ?').get(toName) !== undefined) {
      return { ok: false, error: 'target-exists' }
    }
    const since = Number(options.since) || 0
    this.db.exec('BEGIN')
    try {
      const inserted = this.db.prepare(`
        INSERT INTO entities(canonical, kind, workspace, aliases, first_seen, last_seen, weight)
        VALUES (?, ?, NULL, NULL, ?, ?, ?)
      `).run(toName, String(from.kind), since || Number(from.last_seen), Number(from.last_seen), Number(from.weight))
      const id = Number(inserted.lastInsertRowid)
      const moved = Number(this.db.prepare(
        'UPDATE OR IGNORE occurrences SET entity_id = ? WHERE entity_id = ? AND (? = 0 OR time >= ?)',
      ).run(id, Number(from.id), since, since).changes)
      if (moved === 0) {
        this.db.exec('ROLLBACK')
        return { ok: false, error: 'nothing-to-move' }
      }
      // The split-off side gets its own first/last seen from what it actually holds.
      this.db.prepare(`
        UPDATE entities SET
          first_seen = (SELECT MIN(time) FROM occurrences WHERE entity_id = ?),
          last_seen  = (SELECT MAX(time) FROM occurrences WHERE entity_id = ?)
        WHERE id = ?
      `).run(id, id, id)
      this.db.exec('COMMIT')
      return { ok: true, moved }
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Merge another device's exported memory into this one.
   *
   * Entities are matched by canonical name, so the same object on two machines
   * becomes one row with the wider time range and the higher weight. Links keep the
   * larger co-mention count. Occurrences are not imported: they carry provenance
   * (session/seq) this device does not own, so the *knowledge* travels, not the raw
   * history. Re-importing is idempotent.
   *
   * @param {{ entities?: readonly any[], links?: readonly any[] }} [document]
   * @param {{ source?: string }} [options]
   */
  importMemory(document, options = {}) {
    const entities = Array.isArray(document?.entities) ? document.entities : []
    const links = Array.isArray(document?.links) ? document.links : []
    let inserted = 0
    let merged = 0
    let linked = 0
    this.db.exec('BEGIN')
    try {
      for (const row of entities) {
        const canonical = String(row?.canonical ?? '').trim()
        if (canonical === '') continue
        const kind = String(row?.kind ?? 'topic')
        const weight = Math.max(0, Math.min(1000, Math.trunc(Number(row?.weight) || 500)))
        const firstSeen = Number(row?.first_seen) || Date.now()
        const lastSeen = Number(row?.last_seen) || Date.now()
        const aliases = String(row?.aliases ?? '')
        const existing = this.db.prepare('SELECT id FROM entities WHERE canonical = ?').get(canonical)
        if (existing === undefined) {
          this.db.prepare(`
            INSERT INTO entities(canonical, kind, workspace, aliases, first_seen, last_seen, weight)
            VALUES (?, ?, NULL, ?, ?, ?, ?)
          `).run(canonical, kind, aliases, firstSeen, lastSeen, weight)
          inserted += 1
        } else {
          this.db.prepare(`
            UPDATE entities SET
              weight     = MAX(weight, ?),
              first_seen = MIN(first_seen, ?),
              last_seen  = MAX(last_seen, ?),
              aliases    = CASE
                             WHEN ? = '' THEN aliases
                             WHEN length(aliases) > 400 THEN aliases
                             ELSE aliases || ' ' || ?
                           END
            WHERE id = ?
          `).run(weight, firstSeen, lastSeen, aliases, aliases, existing.id)
          merged += 1
        }
      }
      const findId = this.db.prepare('SELECT id FROM entities WHERE canonical = ?')
      for (const link of links) {
        const a = findId.get(String(link?.a ?? ''))
        const b = findId.get(String(link?.b ?? ''))
        if (a === undefined || b === undefined) continue
        const left = Math.min(Number(a.id), Number(b.id))
        const right = Math.max(Number(a.id), Number(b.id))
        if (left === right) continue
        this.db.prepare(`
          INSERT INTO entity_links(a, b, co_count, last_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(a, b) DO UPDATE SET
            co_count = MAX(entity_links.co_count, excluded.co_count),
            last_at  = MAX(entity_links.last_at, excluded.last_at)
        `).run(left, right, Math.max(1, Number(link?.co_count) || 1), Number(link?.last_at) || Date.now())
        linked += 1
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: String(error?.message ?? error) }
    }
    try {
      this.setMeta('import', JSON.stringify({
        at: Date.now(),
        source: String(options.source ?? ''),
        inserted,
        merged,
        linked,
      }))
    } catch {
      // Observability must never break an import.
    }
    return { ok: true, inserted, merged, linked }
  }

  /**
   * Remove one object from recall. Soft by default: the row, its occurrences and its
   * edges stay, so a mis-click is recoverable; `purgeEntity` removes them for good.
   * @param {string} canonical
   */
  deleteEntity(canonical) {
    const name = String(canonical ?? '')
    if (name === '') return { ok: false, error: 'canonical required' }
    const row = this.db.prepare('SELECT id FROM entities WHERE canonical = ? AND deleted_at IS NULL').get(name)
    if (row === undefined) return { ok: false, error: 'not-found' }
    const id = Number(row.id)
    try {
      this.db.prepare('UPDATE entities SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
      return { ok: true, soft: true, occurrences: Number(this.db.prepare(
        'SELECT COUNT(*) AS n FROM occurrences WHERE entity_id = ?',
      ).get(id).n) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** Bring a soft-deleted object back into recall. */
  restoreEntity(canonical) {
    const name = String(canonical ?? '')
    if (name === '') return { ok: false, error: 'canonical required' }
    try {
      const result = this.db.prepare('UPDATE entities SET deleted_at = NULL WHERE canonical = ? AND deleted_at IS NOT NULL').run(name)
      if (Number(result.changes) === 0) return { ok: false, error: 'not-found' }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Delete one object for good: its edges, vectors, occurrences and the row.
   * @param {string} canonical
   */
  purgeEntity(canonical) {
    const name = String(canonical ?? '')
    if (name === '') return { ok: false, error: 'canonical required' }
    const row = this.db.prepare('SELECT id FROM entities WHERE canonical = ?').get(name)
    if (row === undefined) return { ok: false, error: 'not-found' }
    const id = Number(row.id)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM entity_links WHERE a = ? OR b = ?').run(id, id)
      this.db.prepare('DELETE FROM entity_vectors WHERE entity_id = ?').run(id)
      const occurrences = Number(this.db.prepare('DELETE FROM occurrences WHERE entity_id = ?').run(id).changes)
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      return { ok: true, occurrences }
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** Objects a user removed, newest first. */
  trashedEntities(limit = 50) {
    try {
      return this.db.prepare(`
        SELECT e.canonical, e.kind, e.deleted_at,
               (SELECT COUNT(*) FROM occurrences WHERE entity_id = e.id) AS occurrences
        FROM entities e WHERE e.deleted_at IS NOT NULL
        ORDER BY e.deleted_at DESC LIMIT ?
      `).all(Math.max(1, Math.min(200, limit)))
    } catch {
      return []
    }
  }

  /** A plain JSON document of everything remembered, for backup or inspection. */
  exportMemory() {
    const entities = this.db.prepare(`
      SELECT e.canonical, e.kind, e.weight, e.use_count, e.first_seen, e.last_seen, e.archived,
             COALESCE(e.aliases, '') AS aliases, COUNT(o.id) + COALESCE(e.imported_mentions, 0) AS mentions,
             (SELECT action FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS action,
             (SELECT state  FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS state,
             (SELECT detail FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS detail
      FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id
      GROUP BY e.id ORDER BY mentions DESC, e.last_seen DESC
    `).all()
    const links = this.db.prepare(`
      SELECT ea.canonical AS a, eb.canonical AS b, l.co_count, l.last_at
      FROM entity_links l JOIN entities ea ON ea.id = l.a JOIN entities eb ON eb.id = l.b
      ORDER BY l.co_count DESC
    `).all()
    return {
      exportedAt: new Date().toISOString(),
      schema: SCHEMA_VERSION,
      entities,
      links,
    }
  }

  /**
   * Sleep-like consolidation: the same object/action/state/detail recorded several
   * times in a short window is one memory, not five. The newest occurrence is kept
   * so recency and the file handoff still point at the right place.
   *
   * @param {{ days?: number, now?: number }} [options]
   */
  consolidate(options = {}) {
    const days = Math.max(1, Number(options.days) || 30)
    const now = Number(options.now) || Date.now()
    const since = now - days * 86_400_000
    try {
      const scanned = Number(this.db.prepare('SELECT COUNT(*) AS n FROM occurrences WHERE time >= ?').get(since).n)
      const result = this.db.prepare(`
        DELETE FROM occurrences
        WHERE time >= ?
          AND id NOT IN (
            SELECT MAX(id) FROM occurrences WHERE time >= ?
            GROUP BY entity_id, COALESCE(action, ''), COALESCE(state, ''), COALESCE(detail, '')
          )
      `).run(since, since)
      return { scanned, removed: Number(result.changes) }
    } catch {
      return { scanned: 0, removed: 0 }
    }
  }

  /**
   * Forget what has already faded: an object nobody mentioned for months, never
   * reinforced, and below the retention floor leaves recall but stays in the
   * database — "can't recall it any more, but it happened".
   *
   * @param {{ days?: number, now?: number, retentionBelow?: number }} [options]
   */
  archiveStale(options = {}) {
    const days = Math.max(1, Number(options.days) || 180)
    const now = Number(options.now) || Date.now()
    const cutoff = now - days * 86_400_000
    const floor = Number(options.retentionBelow) || 0.05
    let archived = 0
    try {
      const rows = this.db.prepare(`
        SELECT id, last_seen FROM entities
        WHERE archived = 0 AND last_seen < ? AND use_count = 0
      `).all(cutoff)
      const mark = this.db.prepare('UPDATE entities SET archived = 1 WHERE id = ?')
      for (const row of rows) {
        const ageDays = Math.max(0, (now - Number(row.last_seen)) / 86_400_000)
        if (Math.exp(-ageDays / FORGET_TAU_DAYS) <= floor) {
          mark.run(row.id)
          archived += 1
        }
      }
      return { archived }
    } catch {
      return { archived: 0 }
    }
  }

  /**
   * Persist one object's semantic vector (Float32 storage keeps it compact).
   * @param {number} entityId
   * @param {ArrayLike<number>} vector
   * @param {string} model
   */
  saveVector(entityId, vector, model) {
    const values = Float32Array.from(vector ?? [])
    if (values.length === 0) return false
    try {
      this.db.prepare(`
        INSERT INTO entity_vectors(entity_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          model = excluded.model, dim = excluded.dim,
          vec = excluded.vec, updated_at = excluded.updated_at
      `).run(
        Number(entityId), String(model), values.length,
        Buffer.from(values.buffer, values.byteOffset, values.byteLength), Date.now(),
      )
      return true
    } catch {
      return false
    }
  }

  /** @param {string} model @returns {Array<{ id: number, vec: Float32Array }>} */
  loadVectors(model) {
    try {
      return this.db.prepare('SELECT entity_id, vec FROM entity_vectors WHERE model = ?').all(String(model))
        .map(row => ({
          id: Number(row.entity_id),
          vec: new Float32Array(row.vec.buffer, row.vec.byteOffset, Math.floor(row.vec.byteLength / 4)),
        }))
    } catch {
      return []
    }
  }

  /**
   * Semantic hits for one query vector: cosine against stored object vectors.
   * @param {ArrayLike<number>} vector
   * @param {{ limit?: number, minSimilarity?: number, model?: string, workspace?: string | null, now?: number }} [options]
   */
  vectorRecall(vector, options = {}) {
    if (vector === null || vector === undefined || (vector.length ?? 0) === 0) return []
    const model = String(options.model ?? '')
    const entries = this.loadVectors(model)
    if (entries.length === 0) return []
    const minSimilarity = Number(options.minSimilarity) || 0.55
    const limit = Math.max(1, Math.min(10, options.limit ?? 3))
    const now = Number(options.now) || Date.now()
    const workspace = typeof options.workspace === 'string' && options.workspace !== '' ? options.workspace : null
    const workspaceCheck = workspace === null ? null : this.db.prepare(`
      SELECT 1 AS hit FROM occurrences o
      JOIN sessions s ON s.session_id = o.session_id
      WHERE o.entity_id = ? AND s.workspace = ? LIMIT 1
    `)
    const entityOf = this.db.prepare(`
      SELECT e.id, e.canonical, e.kind, e.weight, e.use_count, e.first_seen, e.last_seen,
             COUNT(o.id) + COALESCE(e.imported_mentions, 0) AS mentions
      FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id
      WHERE e.id = ? AND e.archived = 0 AND e.deleted_at IS NULL
      GROUP BY e.id
    `)
    const detailOf = this.db.prepare(`
      SELECT action, state, detail FROM occurrences WHERE entity_id = ? ORDER BY time DESC LIMIT 1
    `)
    const hits = []
    for (const entry of entries) {
      const similarity = cosineSimilarity(vector, entry.vec)
      if (similarity < minSimilarity) continue
      const row = entityOf.get(entry.id)
      if (row === undefined) continue
      const reviews = Number(row.use_count) || 0
      const ageDays = Math.max(0, (now - Number(row.last_seen)) / 86_400_000)
      const tau = FORGET_TAU_DAYS + REVIEW_TAU_DAYS * Math.log1p(reviews)
      const latest = detailOf.get(entry.id)
      hits.push({
        id: Number(row.id),
        canonical: String(row.canonical),
        kind: String(row.kind),
        weight: Number(row.weight),
        mentions: Number(row.mentions),
        lastSeen: Number(row.last_seen),
        firstSeen: Number(row.first_seen),
        shared: 2,
        reviews,
        retention: Math.exp(-ageDays / tau),
        inWorkspace: workspaceCheck === null ? false : workspaceCheck.get(entry.id, workspace) !== undefined,
        semantic: similarity,
        action: latest?.action ?? '',
        state: latest?.state ?? '',
        detail: latest?.detail ?? '',
        score: 0.32 + 0.28 * similarity,
      })
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit)
  }

  /**
   * Objects that need a fresh vector for one embedding model.
   * @param {string} model
   * @param {number} [limit]
   */
  entitiesForEmbedding(model, limit = 500) {
    try {
      return this.db.prepare(`
        SELECT e.id, e.canonical,
               (SELECT action FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS action,
               (SELECT detail FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS detail
        FROM entities e
        LEFT JOIN entity_vectors v ON v.entity_id = e.id AND v.model = ?
        WHERE e.archived = 0 AND e.deleted_at IS NULL AND (v.entity_id IS NULL OR v.updated_at < ?)
        ORDER BY e.last_seen DESC
        LIMIT ?
      `).all(String(model), Date.now() - 7 * 86_400_000, Math.max(1, Math.min(2000, limit)))
    } catch {
      return []
    }
  }

  /**
   * Store the full text of one finished turn on its row.
   * @param {string} sessionId
   * @param {number} turn
   * @param {{ userText: string, assistantText?: string | null, time: number }} input
   */
  recordTurnText(sessionId, turn, input) {
    try {
      this.db.prepare(`
        INSERT INTO turns(session_id, turn, workspace, keywords, summary, summary_bi, seq, time, user_text, assistant_text)
        VALUES (?, ?, NULL, NULL, '', '', 0, ?, ?, ?)
        ON CONFLICT(session_id, turn) DO UPDATE SET
          user_text      = excluded.user_text,
          assistant_text = COALESCE(excluded.assistant_text, turns.assistant_text),
          time           = CASE WHEN turns.time = 0 THEN excluded.time ELSE MIN(turns.time, excluded.time) END
      `).run(sessionId, Number(turn), Number(input.time), String(input.userText),
        input.assistantText === null || input.assistantText === undefined ? null : String(input.assistantText))
      return true
    } catch {
      return false
    }
  }

  /**
   * Record one conversation by content. The same words again only add a time and a
   * count — that is the whole deduplication rule.
   *
   * @param {{ userText: string, assistantText?: string | null, time: number, source?: string | null }} input
   */
  recordConversation(input) {
    const userText = String(input?.userText ?? '')
    if (userText === '') return false
    const assistantText = input.assistantText === null || input.assistantText === undefined
      ? null
      : String(input.assistantText)
    const hash = createHash('sha256').update(`${userText}\u0000${assistantText ?? ''}`).digest('hex')
    const time = Number(input.time) || Date.now()
    const existing = this.db.prepare('SELECT hash FROM memory_records WHERE hash = ?').get(hash)
    if (existing === undefined) {
      this.db.prepare(`
        INSERT INTO memory_records(hash, user_text, assistant_text, first_at, last_at, count, source)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(hash, userText, assistantText, time, time, input.source === undefined ? null : String(input.source))
      return true
    }
    this.db.prepare(`
      UPDATE memory_records SET
        first_at = MIN(first_at, ?), last_at = MAX(last_at, ?), count = count + 1
      WHERE hash = ?
    `).run(time, time, hash)
    return false
  }

  /**
   * Count the terms one message uses, so the panel can show habits.
   * @param {string} text
   * @param {number} [time]
   */
  bumpKeywords(text, time = Date.now()) {
    const terms = keywordsOf(text)
    if (terms.length === 0) return 0
    const upsert = this.db.prepare(`
      INSERT INTO keyword_stats(term, count, first_at, last_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(term) DO UPDATE SET
        count = count + 1,
        first_at = MIN(first_at, excluded.first_at),
        last_at  = MAX(last_at, excluded.last_at)
    `)
    for (const term of terms) upsert.run(term, Number(time) || Date.now(), Number(time) || Date.now())
    return terms.length
  }

  /**
   * Fold unprocessed conversation records into habits: keywords and behaviour
   * counters. Each record is processed once, so a restart cannot double count, and
   * identical words counted as one record still contribute their `count`.
   *
   * @param {number} [limit]
   */
  harvestHabits(limit = 400) {
    let processed = 0
    try {
      const rows = this.db.prepare(
        'SELECT hash, user_text, first_at, count FROM memory_records WHERE habits_done = 0 ORDER BY first_at LIMIT ?',
      ).all(Math.max(1, Math.min(2000, limit)))
      if (rows.length === 0) return 0
      const markRecord = this.db.prepare('UPDATE memory_records SET habits_done = 1 WHERE hash = ?')
      const bumpSignal = this.db.prepare(`
        INSERT INTO style_stats(signal, count, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(signal) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at
      `)
      this.db.exec('BEGIN')
      try {
        for (const row of rows) {
          const weight = Math.max(1, Number(row.count) || 1)
          const text = String(row.user_text ?? '')
          const time = Number(row.first_at) || Date.now()
          for (let repeat = 0; repeat < weight; repeat += 1) {
            this.bumpKeywords(text, time)
          }
          const signals = signalsOf(text)
          for (const [signal, value] of Object.entries(signals)) {
            if (signal === 'messages') {
              bumpSignal.run('messages', weight, time)
              continue
            }
            if (Number(value) === 0) continue
            bumpSignal.run(signal, Number(value) * weight, time)
          }
          markRecord.run(row.hash)
          processed += 1
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      console.warn('[dsh-memory] habit harvest skipped:', error?.message ?? error)
      return 0
    }
    try {
      this.setMeta('habits', JSON.stringify({ at: Date.now(), processed }))
    } catch {
      // Observability must never break capture.
    }
    return processed
  }

  /**
   * Behaviour totals, for the panel and the first-turn brief.
   * @returns {Record<string, number>}
   */
  /** Stored edits for one persona, or null when it is still as shipped. */
  personaOverride(id) {
    try {
      const raw = this.getMeta('personas')
      if (typeof raw !== 'string' || raw === '') return null
      const all = JSON.parse(raw)
      const entry = all?.[String(id)]
      return entry === null || entry === undefined ? null : entry
    } catch {
      return null
    }
  }

  /** Replace the stored edits for one persona. */
  setPersonaOverride(id, fields) {
    try {
      const raw = this.getMeta('personas')
      const all = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : {}
      const clean = {}
      for (const field of ['name', 'tone', 'values', 'avoid', 'help']) {
        const value = fields?.[field]
        if (typeof value === 'string' && value.trim() !== '') clean[field] = value.trim().slice(0, 500)
      }
      if (Object.keys(clean).length === 0) delete all[String(id)]
      else all[String(id)] = clean
      this.setMeta('personas', JSON.stringify(all))
      return true
    } catch {
      return false
    }
  }

  /**
   * Rebuild the narrative for the week containing `time`, from the turns and the
   * objects touched in it. Deterministic: no model, no invented details.
   *
   * @param {number} time any instant in the week
   * @returns {{ week: string, text: string, turns: number } | null}
   */
  buildNarrative(time) {
    try {
      const start = weekStartOf(time)
      const end = start + 7 * 86_400_000
      const turns = Number(this.db.prepare(
        'SELECT COUNT(*) AS n FROM relationship_turns WHERE at >= ? AND at < ?',
      ).get(start, end).n)
      const days = Number(this.db.prepare(
        "SELECT COUNT(DISTINCT date(at / 1000, 'unixepoch', 'localtime')) AS n FROM relationship_turns WHERE at >= ? AND at < ?",
      ).get(start, end).n)
      const topObjects = this.db.prepare(`
        SELECT e.canonical AS canonical, COUNT(o.id) AS mentions
        FROM occurrences o JOIN entities e ON e.id = o.entity_id
        WHERE o.time >= ? AND o.time < ? AND e.deleted_at IS NULL
        GROUP BY e.id ORDER BY mentions DESC LIMIT 5
      `).all(start, end)
      const text = renderWeekNarrative({ start, end, topObjects, turns, days })
      const week = weekKeyOf(start)
      this.db.prepare(
        'INSERT INTO narratives(week, text, at, turns) VALUES (?, ?, ?, ?) ON CONFLICT(week) DO UPDATE SET text = excluded.text, at = excluded.at, turns = excluded.turns',
      ).run(week, text, Date.now(), turns)
      return { week, text, turns }
    } catch (error) {
      console.warn('[dsh-memory] narrative skipped:', error?.message ?? error)
      return null
    }
  }

  /** Build the previous week's narrative when the current one rolls over. */
  ensureNarrative() {
    try {
      const current = weekKeyOf(Date.now())
      const latest = this.db.prepare('SELECT week FROM narratives ORDER BY week DESC LIMIT 1').get()
      if (latest?.week === current) return null
      return this.buildNarrative(Date.now() - 7 * 86_400_000)
    } catch {
      return null
    }
  }

  /** The newest narratives, newest first. */
  recentNarratives(limit = 4) {
    try {
      return this.db.prepare('SELECT week, text, turns FROM narratives ORDER BY week DESC LIMIT ?').all(Math.max(1, Math.min(20, limit)))
    } catch {
      return []
    }
  }

  /** The persona this profile uses, with the default as the fallback. */
  activePersona() {
    try {
      return this.getMeta('persona') ?? null
    } catch {
      return null
    }
  }

  /**
   * Count one answered request by where it was handled, for the panel's usage line.
   * @param {'local'|'skill'|'cloud'|'recall'} kind
   */
  bumpUsage(kind) {
    try {
      const raw = this.getMeta('usage')
      const usage = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : {}
      const day = new Date().toISOString().slice(0, 10)
      if (usage.day !== day) {
        usage.day = day
        usage.local = 0
        usage.skill = 0
        usage.cloud = 0
        usage.recall = 0
        usage.skipped = 0
      }
      usage[kind] = (Number(usage[kind]) || 0) + 1
      this.setMeta('usage', JSON.stringify(usage))
      return true
    } catch {
      return false
    }
  }

  /** Today's counters. */
  usageToday() {
    try {
      const raw = this.getMeta('usage')
      const usage = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : {}
      const day = new Date().toISOString().slice(0, 10)
      if (usage.day !== day) return { day, local: 0, skill: 0, cloud: 0, recall: 0, skipped: 0 }
      return { local: Number(usage.local) || 0, skill: Number(usage.skill) || 0, cloud: Number(usage.cloud) || 0, recall: Number(usage.recall) || 0, skipped: Number(usage.skipped) || 0, day }
    } catch {
      return { day: new Date().toISOString().slice(0, 10), local: 0, skill: 0, cloud: 0, recall: 0, skipped: 0 }
    }
  }

  /** The word that wakes the assistant. */
  wakeWord() {
    try {
      const raw = this.getMeta('wake.word')
      return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_WAKE_WORD
    } catch {
      return DEFAULT_WAKE_WORD
    }
  }

  /** @param {string} word */
  setWakeWord(word) {
    const clean = String(word ?? '').trim().slice(0, 12)
    if (clean === '') return false
    try {
      this.setMeta('wake.word', clean)
      return true
    } catch {
      return false
    }
  }

  /** How long the assistant keeps listening after the wake word. */
  wakeWindowMs() {
    try {
      const value = Number(this.getMeta('wake.windowMs'))
      return Number.isFinite(value) && value >= 500 ? value : DEFAULT_WINDOW_MS
    } catch {
      return DEFAULT_WINDOW_MS
    }
  }

  /** @param {number} ms */
  setWakeWindowMs(ms) {
    try {
      this.setMeta('wake.windowMs', String(Math.max(500, Math.min(30_000, Number(ms) || DEFAULT_WINDOW_MS))))
      return true
    } catch {
      return false
    }
  }

  /** @param {string} id */
  setActivePersona(id) {
    try {
      this.setMeta('persona', String(id))
      return true
    } catch {
      return false
    }
  }

  /** @param {string} name */
  setAddress(name) {
    try {
      this.setMeta('address', String(name).slice(0, 24))
      return true
    } catch {
      return false
    }
  }

  /** The name the assistant uses for the user, if one was ever learned. */
  address() {
    try {
      return this.getMeta('address') ?? null
    } catch {
      return null
    }
  }

  /** @param {{ kind: string, note: string, at?: number }} event */
  addRelationshipEvent(event) {
    try {
      this.db.prepare(
        'INSERT INTO relationship_events(at, kind, note, status) VALUES (?, ?, ?, ?)',
      ).run(Number(event.at) || Date.now(), String(event.kind), String(event.note).slice(0, 200), 'open')
      return true
    } catch {
      return false
    }
  }

  /** @param {number} id */
  resolveRelationshipEvent(id) {
    try {
      const result = this.db.prepare("UPDATE relationship_events SET status = 'done' WHERE id = ?").run(Number(id))
      return Number(result.changes) > 0
    } catch {
      return false
    }
  }

  /**
   * Fold one turn into the relationship: count it once, then learn the 称呼 the user
   * asks for. Boundaries, thanks and promises become events so they stay explainable.
   *
   * @param {string} sessionId
   * @param {number} turn
   * @param {string} text
   * @param {number} [time]
   */
  observeRelationship(sessionId, turn, text, time = Date.now()) {
    const body = String(text ?? '')
    if (body === '') return false
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO relationship_turns(session_id, turn, at) VALUES (?, ?, ?)',
      ).run(String(sessionId), Number(turn), Number(time) || Date.now())
    } catch {
      return false
    }
    // "别再这么叫我了" must not be read as asking for a name.
    const positive = body.replace(/(?:别|不要|不用|别再)[^。！？\n]{0,8}?(?:叫|喊)我/g, '')
    const address = positive.match(/(?:叫我|喊我|称呼我(?:为|作)?)[\s:：]?([\u4e00-\u9fa5A-Za-z0-9_]{1,6})/)
    if (address !== null) {
      const name = address[1].replace(/(?:就行|好了|可以|吧|啊|呀|了|的|哈|嘛|呗|哦)$/u, '')
      if (name.length >= 1) this.setAddress(name)
    }
    if (/别(?:再)?(?:这么|这样|叫我|喊我|说了)|不用(?:叫|喊|说)/.test(body)) {
      this.addRelationshipEvent({ kind: 'boundary', note: body.slice(0, 80), at: time })
    }
    if (/谢谢|辛苦了|感谢|靠谱|不错|厉害/.test(body)) {
      this.addRelationshipEvent({ kind: 'thanks', note: body.slice(0, 80), at: time })
    }
    if (/记得|别忘了|待会|回头|明天|后天/.test(body)) {
      const sentence = String(body).split(/[。！？\n]/)[0].trim().slice(0, 30)
      if (sentence !== '') this.addRelationshipEvent({ kind: 'promise', note: sentence, at: time })
    }
    return true
  }

  /**
   * Current relationship. Intimacy is *derived* from counted turns and events, so
   * replaying history cannot inflate it.
   */
  relationship(now = Date.now()) {
    try {
      const turns = Number(this.db.prepare('SELECT COUNT(*) AS n FROM relationship_turns').get().n)
      const count = kind => Number(this.db.prepare(
        'SELECT COUNT(*) AS n FROM relationship_events WHERE kind = ?',
      ).get(kind).n)
      const thanks = count('thanks')
      const boundaries = count('boundary')
      const days = Number(this.db.prepare(
        "SELECT COUNT(DISTINCT date(at / 1000, 'unixepoch', 'localtime')) AS n FROM relationship_turns",
      ).get().n)
      const firstAt = Number(this.db.prepare('SELECT MIN(at) AS at FROM relationship_turns').get()?.at ?? 0)
      const knownDays = firstAt === 0 ? 0 : Math.max(1, Math.ceil((now - firstAt) / 86_400_000))
      // Time and density together: how long we have known each other, plus how
      // much we actually talk. A narrow band on purpose - the history matters, the
      // number does not.
      const density = knownDays <= 0 ? 0 : turns / knownDays
      const warm = Math.max(0, Math.min(100,
        Math.round(35 + Math.min(knownDays, 25) + Math.min(density, 6) * 1.5 + (thanks > 0 ? 1 : 0) - 5 * Math.min(boundaries, 3)),
      ))
      const stage = knownDays < 2 ? '初识' : knownDays < 8 ? '熟悉' : knownDays < 30 ? '亲近' : '老搭档'
      const promises = this.db.prepare(
        "SELECT id, note, at FROM relationship_events WHERE kind = 'promise' AND status = 'open' AND at > ? ORDER BY at DESC LIMIT 1",
      ).all(now - 7 * 86_400_000)
      return {
        warm,
        stage,
        address: this.address(),
        turns,
        days,
        knownDays,
        firstAt,
        thanks,
        boundaries,
        promises,
      }
    } catch {
      return { warm: 0, stage: '初识', address: null, turns: 0, days: 0, knownDays: 0, firstAt: 0, thanks: 0, boundaries: 0, promises: [] }
    }
  }

  /** When the last conversation happened, from the counted turns. */
  lastContactAt() {
    try {
      const row = this.db.prepare('SELECT MAX(at) AS at FROM relationship_turns').get()
      return row?.at === null || row?.at === undefined ? null : Number(row.at)
    } catch {
      return null
    }
  }

  /**
   * Today's baseline state, derived from the last few days of turns and events.
   * Nothing is stored, so it cannot go stale or drift on replay.
   */
  moodNow(now = Date.now()) {
    try {
      const startOfDay = new Date(Number(now) || Date.now())
      startOfDay.setHours(0, 0, 0, 0)
      const since = startOfDay.getTime()
      const turnsToday = Number(this.db.prepare(
        'SELECT COUNT(*) AS n FROM relationship_turns WHERE at >= ?',
      ).get(since).n)
      const lastContactAt = this.lastContactAt()
      const lastNightHour = lastContactAt === null ? null : new Date(lastContactAt).getHours()
      const recent = since - 3 * 86_400_000
      const countRecent = kind => Number(this.db.prepare(
        'SELECT COUNT(*) AS n FROM relationship_events WHERE kind = ? AND at >= ?',
      ).get(kind, recent).n)
      return computeMood({
        now,
        lastContactAt,
        turnsToday,
        lastNightHour,
        thanksRecent: countRecent('thanks'),
        boundariesRecent: countRecent('boundary'),
      })
    } catch {
      return computeMood({ now, lastContactAt: null, turnsToday: 0, lastNightHour: null, thanksRecent: 0, boundariesRecent: 0 })
    }
  }

  /**
   * The time-sense line: today's state plus how long it has been.
   * @returns {string | null}
   */
  renderMoodLine(now = Date.now()) {
    const mood = this.moodNow(now)
    const gap = describeLastContact(this.lastContactAt(), now)
    const parts = [`状态：${mood.note}`]
    if (gap !== null) parts.push(gap)
    return parts.join(' · ')
  }

  /**
   * Rebuild the relationship turn ledger from the turns already recorded. Idempotent:
   * the primary key makes a second run insert nothing.
   * @returns {number} rows added
   */
  backfillRelationshipTurns() {
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO relationship_turns(session_id, turn, at)
        SELECT session_id, turn, time FROM turns WHERE turn > 0 AND time > 0
      `).run()
      return Number(result.changes) || 0
    } catch {
      return 0
    }
  }

  /**
   * The hour of day this user tends to show up, learned from the recent turns.
   * The proactive greeting follows it instead of staying pinned to a fixed clock.
   * @returns {number} 0-23
   */
  preferredHour() {
    try {
      const row = this.db.prepare(
        "SELECT CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour, COUNT(*) AS n " +
        'FROM relationship_turns GROUP BY hour ORDER BY n DESC, hour ASC LIMIT 1',
      ).get()
      const hour = Number(row?.hour)
      return Number.isFinite(hour) ? hour : 9
    } catch {
      return 9
    }
  }

  /** How many turns the learned hour rests on. */
  hourSampleSize() {
    try {
      return Number(this.db.prepare('SELECT COUNT(*) AS n FROM relationship_turns').get().n)
    } catch {
      return 0
    }
  }

  /**
   * The relationship as one prompt line, or null when there is nothing to say yet.
   * @returns {string | null}
   */
  renderRelationship() {
    const rel = this.relationship()
    if (rel.turns < 1 && rel.address === null) return null
    const known = rel.knownDays <= 0 ? null : rel.knownDays === 1 ? '认识第一天' : `认识 ${rel.knownDays} 天`
    const parts = [`关系：${rel.stage}${known === null ? '' : ` · ${known}`}`]
    if (rel.address !== null) parts.push(`你叫对方「${rel.address}」`)
    if (rel.promises.length > 0) parts.push(`还欠着：${rel.promises[0].note.slice(0, 40)}`)
    return parts.join(' · ')
  }

  styleTotals() {
    try {
      const rows = this.db.prepare('SELECT signal, count FROM style_stats').all()
      /** @type {Record<string, number>} */
      const totals = {}
      for (const row of rows) totals[String(row.signal)] = Number(row.count)
      return totals
    } catch {
      return {}
    }
  }

  /** The short profile: ready only once there is enough history to mean anything. */
  styleProfile() {
    return profileOf(this.styleTotals())
  }

  /** The terms this user reaches for most, strongest evidence first. */
  habits(limit = 20, minCount = 2) {
    try {
      return this.db.prepare(`
        SELECT term, count, first_at, last_at FROM keyword_stats
        WHERE count >= ? AND length(term) BETWEEN 2 AND 3
        ORDER BY count DESC, last_at DESC LIMIT ?
      `).all(Math.max(1, Number(minCount) || 1), Math.max(1, Math.min(100, limit)))
    } catch {
      return []
    }
  }

  /** Remove connective rows recorded before the filter existed. */
  pruneKeywords() {
    return pruneKeywordRows(this.db)
  }

  /** Which hours of the day this user works, from the turn record. */
  activeHours() {
    try {
      return this.db.prepare(`
        SELECT CAST(strftime('%H', time / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
               COUNT(*) AS turns
        FROM turns WHERE time > 0 GROUP BY hour ORDER BY hour
      `).all()
    } catch {
      return []
    }
  }

  /** Turns with their full text, newest first, for the timeline view. */
  recentTurns(limit = 60) {
    try {
      return this.db.prepare(`
        SELECT t.time, t.turn, t.session_id, t.user_text, t.assistant_text,
               COALESCE(s.title, s.label) AS session
        FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE t.user_text IS NOT NULL AND t.user_text <> ''
        ORDER BY t.time DESC LIMIT ?
      `).all(Math.max(1, Math.min(500, limit)))
    } catch {
      return []
    }
  }

  /** Objects the forgetting pass moved out of recall. */
  archivedEntities(limit = 50) {
    try {
      return this.db.prepare(`
        SELECT canonical, kind, weight, last_seen FROM entities
        WHERE archived = 1 AND deleted_at IS NULL
        ORDER BY last_seen DESC LIMIT ?
      `).all(Math.max(1, Math.min(200, limit)))
    } catch {
      return []
    }
  }

  /** Bring a faded object back into recall. */
  unarchiveEntity(canonical) {
    try {
      const result = this.db.prepare('UPDATE entities SET archived = 0 WHERE canonical = ? AND archived = 1').run(String(canonical ?? ''))
      return Number(result.changes) > 0 ? { ok: true } : { ok: false, error: 'not-found' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** Everything worth carrying to another device. */
  exportBundle() {
    const entities = this.db.prepare(`
      SELECT canonical, kind, weight, aliases, first_seen, last_seen, use_count, imported_mentions
      FROM entities WHERE deleted_at IS NULL ORDER BY last_seen DESC
    `).all()
    const links = this.db.prepare(`
      SELECT ea.canonical AS a, eb.canonical AS b, l.co_count, l.last_at
      FROM entity_links l JOIN entities ea ON ea.id = l.a JOIN entities eb ON eb.id = l.b
      ORDER BY l.co_count DESC
    `).all()
    const records = this.db.prepare(`
      SELECT hash, user_text, assistant_text, first_at, last_at, count, source
      FROM memory_records ORDER BY last_at DESC
    `).all()
    const keywords = this.db.prepare('SELECT term, count, first_at, last_at FROM keyword_stats ORDER BY count DESC').all()
    return {
      format: 'dsh-memory-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      schema: SCHEMA_VERSION,
      entities,
      links,
      records,
      keywords,
    }
  }

  /**
   * Merge a bundle from another device.
   *
   * Rules, in the user's words: a record with identical content *and* an identical
   * time range is a duplicate and is skipped; the same content at a different time
   * only adds the time and a count. Entities merge by name, links keep the larger
   * co-mention count.
   *
   * @param {{ entities?: readonly any[], links?: readonly any[], records?: readonly any[], keywords?: readonly any[] }} [bundle]
   */
  importBundle(bundle) {
    const entities = Array.isArray(bundle?.entities) ? bundle.entities : []
    const links = Array.isArray(bundle?.links) ? bundle.links : []
    const records = Array.isArray(bundle?.records) ? bundle.records : []
    const keywords = Array.isArray(bundle?.keywords) ? bundle.keywords : []
    const stats = { insertedEntities: 0, mergedEntities: 0, insertedRecords: 0, mergedRecords: 0, duplicateRecords: 0, linked: 0, keywords: 0 }
    this.db.exec('BEGIN')
    try {
      const findEntity = this.db.prepare('SELECT id FROM entities WHERE canonical = ?')
      for (const row of entities) {
        const canonical = String(row?.canonical ?? '').trim()
        if (canonical === '') continue
        const weight = Math.max(0, Math.min(1000, Math.trunc(Number(row?.weight) || 500)))
        const firstSeen = Number(row?.first_seen) || Date.now()
        const lastSeen = Number(row?.last_seen) || Date.now()
        const mentions = Math.max(0, Math.trunc(Number(row?.imported_mentions ?? row?.mentions) || 0)) || 1
        const existing = findEntity.get(canonical)
        if (existing === undefined) {
          this.db.prepare(`
            INSERT INTO entities(canonical, kind, workspace, aliases, first_seen, last_seen, weight, imported_mentions)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
          `).run(canonical, String(row?.kind ?? 'topic'), String(row?.aliases ?? ''), firstSeen, lastSeen, weight, mentions)
          stats.insertedEntities += 1
        } else {
          this.db.prepare(`
            UPDATE entities SET
              weight = MAX(weight, ?), first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?),
              imported_mentions = imported_mentions + ?
            WHERE id = ?
          `).run(weight, firstSeen, lastSeen, mentions, existing.id)
          stats.mergedEntities += 1
        }
      }
      const upsertLink = this.db.prepare(`
        INSERT INTO entity_links(a, b, co_count, last_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(a, b) DO UPDATE SET
          co_count = MAX(entity_links.co_count, excluded.co_count),
          last_at  = MAX(entity_links.last_at, excluded.last_at)
      `)
      for (const link of links) {
        const a = findEntity.get(String(link?.a ?? ''))
        const b = findEntity.get(String(link?.b ?? ''))
        if (a === undefined || b === undefined) continue
        const left = Math.min(Number(a.id), Number(b.id))
        const right = Math.max(Number(a.id), Number(b.id))
        if (left === right) continue
        upsertLink.run(left, right, Math.max(1, Number(link?.co_count) || 1), Number(link?.last_at) || Date.now())
        stats.linked += 1
      }
      const findRecord = this.db.prepare('SELECT first_at, last_at, count FROM memory_records WHERE hash = ?')
      for (const record of records) {
        const userText = String(record?.user_text ?? '')
        if (userText === '') continue
        const assistantText = record?.assistant_text === null || record?.assistant_text === undefined
          ? null
          : String(record.assistant_text)
        const hash = createHash('sha256').update(`${userText}\u0000${assistantText ?? ''}`).digest('hex')
        const first = Number(record?.first_at) || Date.now()
        const last = Number(record?.last_at) || first
        const count = Math.max(1, Math.trunc(Number(record?.count) || 1))
        const existing = findRecord.get(hash)
        if (existing === undefined) {
          this.db.prepare(`
            INSERT INTO memory_records(hash, user_text, assistant_text, first_at, last_at, count, source)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(hash, userText, assistantText, first, last, count, String(record?.source ?? 'import'))
          stats.insertedRecords += 1
          continue
        }
        // Identical content inside the known time range is the duplicate the user
        // asked to skip; anything outside only contributes time and count.
        if (first >= Number(existing.first_at) && last <= Number(existing.last_at)) {
          stats.duplicateRecords += 1
          continue
        }
        this.db.prepare(`
          UPDATE memory_records SET
            first_at = MIN(first_at, ?), last_at = MAX(last_at, ?), count = count + ?
          WHERE hash = ?
        `).run(first, last, count, hash)
        stats.mergedRecords += 1
      }
      const bump = this.db.prepare(`
        INSERT INTO keyword_stats(term, count, first_at, last_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(term) DO UPDATE SET
          count = count + excluded.count,
          first_at = MIN(first_at, excluded.first_at),
          last_at  = MAX(last_at, excluded.last_at)
      `)
      for (const keyword of keywords) {
        const term = String(keyword?.term ?? '').trim()
        if (term === '') continue
        bump.run(term, Math.max(1, Number(keyword?.count) || 1),
          Number(keyword?.first_at) || Date.now(), Number(keyword?.last_at) || Date.now())
        stats.keywords += 1
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, error: String(error?.message ?? error) }
    }
    try {
      this.setMeta('importBundle', JSON.stringify({ at: Date.now(), ...stats }))
    } catch {
      // Observability must never break an import.
    }
    return { ok: true, ...stats }
  }

  recentBrief(limit = 3) {
    const bounded = Math.max(1, Math.min(10, limit))
    try {
      const items = this.db.prepare(`
        SELECT e.canonical AS canonical, COUNT(o.id) + COALESCE(e.imported_mentions, 0) AS mentions, MAX(o.time) AS last_at
        FROM occurrences o
        JOIN entities e ON e.id = o.entity_id
        WHERE e.archived = 0 AND e.deleted_at IS NULL
        GROUP BY e.id
        ORDER BY last_at DESC
        LIMIT ?
      `).all(bounded)
      const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM entities WHERE archived = 0').get().n)
      if (total < 3 || items.length === 0) return null
      return {
        total,
        items: items.map(row => ({
          canonical: String(row.canonical),
          mentions: Number(row.mentions),
          lastSeen: Number(row.last_at),
        })),
      }
    } catch {
      return null
    }
  }

  /**
   * The newest handoff written by a *different* Session: what another window just
   * changed on disk. This is what makes picking work up in another window feel
   * continuous instead of "where is that file".
   *
   * @param {{ hours?: number, excludeSessionId?: string }} [options]
   */
  recentHandoff(options = {}) {
    const hours = Number(options.hours) || 24
    const since = Date.now() - hours * 3_600_000
    const exclude = typeof options.excludeSessionId === 'string' ? options.excludeSessionId : ''
    try {
      // Only trust handoffs whose Session still exists: a deleted window's last
      // change is a dead end, not a place to pick work up from.
      const row = this.db.prepare(`
        SELECT h.session_id, h.turn, h.at, h.files
        FROM handoffs h JOIN sessions s ON s.session_id = h.session_id
        WHERE h.at >= ? AND h.session_id <> ?
        ORDER BY h.at DESC LIMIT 1
      `).get(since, exclude)
      if (row === undefined) return null
      const files = JSON.parse(String(row.files))
      if (!Array.isArray(files) || files.length === 0) return null
      return {
        sessionId: String(row.session_id),
        turn: Number(row.turn),
        at: Number(row.at),
        files: files.map(String),
      }
    } catch {
      return null
    }
  }

  /** Name of the workspace with the most recent Session activity. */
  recentProject() {
    try {
      const row = this.db.prepare(`
        SELECT workspace FROM sessions
        WHERE workspace IS NOT NULL AND workspace <> ''
        ORDER BY updated_at DESC LIMIT 1
      `).get()
      if (row === undefined) return null
      const workspace = String(row.workspace)
      return path.basename(workspace) || workspace
    } catch {
      return null
    }
  }

  /**
   * Rebuild handoffs from recorded tool calls.
   *
   * Each call's turn comes from the user message that opened it: the queue row
   * with the greatest seq not past the call. Existing rows are overwritten in
   * place, so this is safe to run at every startup.
   *
   * @returns {number} handoffs written
   */
  repairHandoffs() {
    let marks
    try {
      marks = this.db.prepare(
        'SELECT session_id, seq, turn FROM normalize_queue WHERE turn > 0 ORDER BY session_id, seq',
      ).all()
    } catch {
      return 0
    }
    if (marks.length === 0) return 0
    const bySession = new Map()
    for (const row of marks) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, [])
      bySession.get(row.session_id).push({ seq: Number(row.seq), turn: Number(row.turn) })
    }
    const calls = this.db.prepare(`
      SELECT session_id, seq, name, digest, time FROM tool_calls
      WHERE name IN ('edit','write','apply_patch') AND digest IS NOT NULL
      ORDER BY time
    `).all()
    const buckets = new Map()
    for (const call of calls) {
      const marksOfSession = bySession.get(call.session_id)
      if (marksOfSession === undefined) continue
      let turn = 0
      for (const mark of marksOfSession) {
        if (mark.seq <= Number(call.seq)) turn = mark.turn
        else break
      }
      if (turn <= 0) continue
      const file = filePathOf(call.digest)
      if (file === '') continue
      const key = `${call.session_id}#${turn}`
      if (!buckets.has(key)) {
        buckets.set(key, { session: call.session_id, turn, at: Number(call.time), files: new Set() })
      }
      const bucket = buckets.get(key)
      bucket.files.add(file)
      bucket.at = Math.max(bucket.at, Number(call.time))
    }
    let written = 0
    for (const bucket of buckets.values()) {
      this.handoffUpsert.run(
        bucket.session,
        bucket.turn,
        bucket.at,
        JSON.stringify([...bucket.files].slice(0, 12)),
      )
      written += 1
    }
    return written
  }

  /**
   * Remember which provider/model one Session is running on.
   * @param {string} sessionId
   * @param {{ provider?: string, model?: string } | null | undefined} selection
   */
  recordSessionModel(sessionId, selection) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (selection === null || typeof selection !== 'object') return
    const provider = String(selection.provider ?? '')
    const model = String(selection.model ?? '')
    if (provider === '' || model === '') return
    try {
      this.db.prepare(`
        INSERT INTO session_models(session_id, provider, model, at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          provider = excluded.provider, model = excluded.model, at = excluded.at
      `).run(sessionId, provider, model, Date.now())
    } catch {
      // A missed model only means normalization falls back to the default.
    }
  }

  /**
   * @param {string} sessionId
   * @returns {{ provider: string, model: string } | null}
   */
  sessionModel(sessionId) {
    try {
      const row = this.db.prepare('SELECT provider, model FROM session_models WHERE session_id = ?').get(sessionId)
      if (row === undefined) return null
      return { provider: String(row.provider), model: String(row.model) }
    } catch {
      return null
    }
  }

  /** @param {any} info */
  recordSubagentStart(info) {
    if (info === null || typeof info !== 'object') return false
    const runId = String(info.runId ?? '')
    if (runId === '') return false
    const childSession = String(info.id ?? '')
    this.subagentInsert.run(
      runId,
      String(info.parentSessionId ?? ''),
      childSession,
      String(info.provider ?? ''),
      Date.now(),
    )
    // The child's descriptor can be appended before this start event is emitted,
    // so the label may already be known — adopt it now instead of waiting for it.
    if (childSession !== '') {
      try {
        const session = this.db.prepare('SELECT label FROM sessions WHERE session_id = ?').get(childSession)
        const label = session?.label
        if (typeof label === 'string' && label !== '') {
          this.db.prepare('UPDATE subagent_runs SET name = ? WHERE run_id = ?').run(label, runId)
        }
      } catch {
        // A missing identity row only costs the display name.
      }
    }
    return true
  }

  /** @param {any} info */
  recordSubagentEnd(info) {
    if (info === null || typeof info !== 'object') return false
    const runId = String(info.runId ?? '')
    if (runId === '') return false
    const summary = oneLine(blocksText(info.lastAssistantMessage)).slice(0, MAX_SUBAGENT_SUMMARY)
    this.subagentFinish.run(String(info.stopReason ?? 'unknown'), summary, Date.now(), runId)
    return true
  }

  /**
   * @param {string} sessionId
   * @param {number} maxSeq
   */
  setCursor(sessionId, maxSeq) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.cursorUpsert.run(sessionId, Number(maxSeq) || 0, Date.now())
  }

  /** @param {string} sessionId */
  cursorOf(sessionId) {
    const row = this.db.prepare('SELECT max_seq FROM session_cursors WHERE session_id = ?').get(sessionId)
    return row === undefined ? 0 : Number(row.max_seq)
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  /** @param {string} key */
  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM store_meta WHERE key = ?').get(key)
    return row === undefined ? undefined : String(row.value)
  }

  stats() {
    const count = sql => Number(this.db.prepare(sql).get().n)
    return {
      file: this.file,
      schemaVersion: SCHEMA_VERSION,
      turns: count('SELECT COUNT(*) AS n FROM turns'),
      toolCalls: count('SELECT COUNT(*) AS n FROM tool_calls'),
      subagentRuns: count('SELECT COUNT(*) AS n FROM subagent_runs'),
      queuedUserMessages: count('SELECT COUNT(*) AS n FROM normalize_queue'),
      pendingUserMessages: count('SELECT COUNT(*) AS n FROM normalize_queue WHERE done_at IS NULL'),
      entities: count('SELECT COUNT(*) AS n FROM entities'),
      occurrences: count('SELECT COUNT(*) AS n FROM occurrences'),
      sessions: count('SELECT COUNT(*) AS n FROM session_cursors'),
      distinctTools: count('SELECT COUNT(DISTINCT name) AS n FROM tool_calls'),
    }
  }

  close() {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}
