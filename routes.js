/**
 * HTTP surface of the memory store: the read-only panel payload, manual merge,
 * delete, and export.
 *
 * Registration must wait for `webServer`: at activation the service is usually not
 * published yet (a plain `ctx.get('webServer')` returns undefined and the route
 * silently never exists — observed as 404). Declaring it as a hard `inject` would
 * also gate capture on a web profile, so routes mount from a scoped context.
 */

import { DEFAULT_PERSONA_ID, PERSONAS } from './personas.js'
import { proactiveStatus } from './proactive.js'
import { backupStatus, runBackup } from './backup.js'
import { BUILD } from './runtime.js'
import { qqStatus } from './qq-bridge.js'
import { learnName } from './capture.js'
import { databaseFile } from './runtime.js'
import { statSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { applySelection, listOllamaModels, modelStatus, ollamaRoot, readModelPolicy, writeModelPolicy } from './models.js'
import { readZip, writeZip } from './zip.js'

const PANEL_LIMIT = 200
const RECENT_LIMIT = 60

/**
 * @param {any} owner a context that has `webServer` (and an effect scheduler)
 * @param {import('./store.js').MemoryStore} store
 */
export function mountRoutes(owner, store, settings = {}) {
  const webServer = owner.get?.('webServer') ?? owner.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return

  /** Shared admission: authenticated peer first, then loopback. */
  const admit = (req, reply) => {
    const connection = owner.get?.('connection')
    const rejection = connection === undefined ? 503 : connection.requestRejection(req)
    if (rejection !== undefined) {
      reply(rejection, { ok: false, error: 'unauthorized' })
      return false
    }
    const address = String(req.socket.remoteAddress || '')
    const loopback = address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
    if (!loopback) {
      reply(403, { ok: false, error: 'loopback only' })
      return false
    }
    return true
  }

  const json = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  const readBody = async req => {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 8192) throw new Error('body too large')
    }
    return JSON.parse(raw)
  }

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/panel',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        reply(405, { ok: false, error: 'GET required' })
        return
      }
      try {
        reply(200, { ok: true, ...panelData(store, settings) })
      } catch (error) {
        reply(500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: panel route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/merge',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const from = String(body?.from ?? '')
        const into = String(body?.into ?? '')
        if (from === '' || into === '') {
          reply(400, { ok: false, error: 'from and into are required' })
          return
        }
        const result = store.mergeEntities(from, into)
        reply(result.ok ? 200 : 400, result)
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: merge route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/delete',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const canonical = String(body?.canonical ?? '')
        if (canonical === '') {
          reply(400, { ok: false, error: 'canonical is required' })
          return
        }
        const result = store.deleteEntity(canonical)
        reply(result.ok ? 200 : 400, result)
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: delete route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/split',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const canonical = String(body?.canonical ?? '')
        const name = String(body?.name ?? '')
        const days = Number(body?.days) || 0
        if (canonical === '' || name === '') {
          reply(400, { ok: false, error: 'canonical and name are required' })
          return
        }
        const since = days > 0 ? Date.now() - days * 86_400_000 : 0
        const result = store.splitEntity(canonical, name, { since })
        reply(result.ok ? 200 : 400, result)
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: split route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/restore',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const canonical = String(body?.canonical ?? '')
        if (canonical === '') {
          reply(400, { ok: false, error: 'canonical is required' })
          return
        }
        const result = store.restoreEntity(canonical)
        reply(result.ok ? 200 : 400, result)
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: restore route')








  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/backup',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const result = runBackup(store, { databasePath: databaseFile(), keep: Math.max(1, Number(settings?.backupKeep) || 7) })
        reply(result.ok ? 200 : 500, result)
      } catch (error) {
        reply(500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: backup route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/models',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      try {
        const url = settings?.embedUrl ?? 'http://127.0.0.1:11434'
        const models = await listOllamaModels(url)
        reply(200, { ok: true, models, policy: modelStatus(store) })
      } catch (error) {
        reply(200, { ok: false, models: [], policy: modelStatus(store), error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: model list route')

  // Cloud (paid) models come live from the llm service, so the list follows whatever
  // routes are actually mounted — no hard-coded catalogue to rot.
  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/cloudmodels',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      try {
        const llm = owner.get?.('llm') ?? owner.llm
        if (llm === undefined || typeof llm.listProviders !== 'function') {
          reply(200, { ok: true, models: [], policy: modelStatus(store) })
          return
        }
        const providers = llm.listProviders()
        const models = []
        for (const provider of providers) {
          if (provider?.id === 'ollama') continue // local, listed elsewhere
          try {
            const list = await llm.listModels(provider.id)
            for (const model of list ?? []) {
              const id = String(model.id)
              const name = String(model.name ?? model.id)
              const haystack = `${id} ${name}`
              // 只做保守推断：明确标记 free 的才算免费，其余按量计费。
              const free = model?.free === true || model?.isFree === true ||
                model?.pricing?.free === true || /(?:^|[-_:])free$|\(free\)/i.test(haystack)
              const official = String(provider.id).startsWith('deepseek')
              models.push({
                provider: provider.id,
                providerName: String(provider.name ?? provider.id),
                id,
                name,
                kind: official ? '官方 API' : '第三方 API',
                billing: free ? '免费' : '付费',
              })
            }
          } catch {
            // A provider that refuses listing must not hide the others.
          }
        }
        reply(200, { ok: true, models, policy: modelStatus(store) })
      } catch (error) {
        reply(200, { ok: false, models: [], policy: modelStatus(store), error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: cloud model list route')

  // Remember the paid model, and switch to it on demand.
  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/paidmodel',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const provider = String(body?.provider ?? '').trim()
        const model = String(body?.model ?? '').trim()
        if (provider === '' || model === '') {
          reply(400, { ok: false, error: 'provider and model are required' })
          return
        }
        const policy = readModelPolicy(store)
        policy.paid = { provider, model }
        writeModelPolicy(store, policy)
        let switched = false
        if (body?.activate === true) {
          switched = await applySelection(owner.get?.('agentDefaultModel') ?? owner.agentDefaultModel, { provider, model })
        }
        reply(200, { ok: true, paid: policy.paid, switched })
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: paid model route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/pickmodel',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const model = String(body?.model ?? '')
        if (model === '') {
          reply(400, { ok: false, error: 'model is required' })
          return
        }
        const policy = readModelPolicy(store)
        policy.local = { provider: String(body?.provider ?? 'ollama'), model }
        policy.autoSwitch = body?.autoSwitch !== false
        writeModelPolicy(store, policy)
        const switched = await applySelection(owner.get?.('agentDefaultModel') ?? owner.agentDefaultModel, policy.local)
        reply(200, { ok: true, local: policy.local, switched })
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: pick model route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/cloudonce',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const policy = readModelPolicy(store)
        const paid = body?.provider !== undefined
          ? { provider: String(body.provider), model: String(body.model ?? '') }
          : policy.paid
        if (paid === null || paid.model === '') {
          reply(400, { ok: false, error: 'no cloud model configured' })
          return
        }
        policy.paid = paid
        writeModelPolicy(store, policy)
        store.setMeta('cloudOnce', 'on')
        const switched = await applySelection(owner.get?.('agentDefaultModel') ?? owner.agentDefaultModel, paid)
        reply(200, { ok: true, paid, switched })
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: cloud once route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/persona/edit',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const id = String(body?.id ?? '')
        if (!PERSONAS.some(persona => persona.id === id)) {
          reply(400, { ok: false, error: 'unknown persona' })
          return
        }
        const saved = store.setPersonaOverride(id, body?.fields ?? {})
        reply(saved ? 200 : 400, { ok: saved, id })
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: persona edit route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/persona',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const id = String(body?.id ?? '')
        if (!PERSONAS.some(persona => persona.id === id)) {
          reply(400, { ok: false, error: 'unknown persona' })
          return
        }
        store.setActivePersona(id)
        reply(200, { ok: true, active: id })
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: persona route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/import',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 256 * 1024 * 1024) throw new Error('archive too large')
          chunks.push(chunk)
        }
        const archive = Buffer.concat(chunks)
        const files = readZip(archive)

        // v2: a snapshot of the whole database. Merge every table, keeping rows that
        // already exist so a restore never overwrites live configuration.
        const database = files.get('memory.db')
        if (database !== undefined) {
          const temp = join(tmpdir(), `dsh-memory-import-${randomUUID()}.db`)
          writeFileSync(temp, database)
          try {
            const db = new DatabaseSync(store.file)
            try {
              db.exec(`ATTACH '${temp.replace(/'/g, "''")}' AS incoming`)
              const tables = db.prepare(`
                select name from incoming.sqlite_master
                where type = 'table'
                  and name not like '%_fts%'
                  and name not like 'sqlite_%'
              `).all()
              const mergedByTable = {}
              let merged = 0
              for (const row of tables) {
                const name = String(row.name)
                try {
                  const info = db.prepare(`INSERT OR IGNORE INTO main."${name}" SELECT * FROM incoming."${name}"`).run()
                  if (info.changes > 0) {
                    mergedByTable[name] = info.changes
                    merged += info.changes
                  }
                } catch (error) {
                  mergedByTable[name] = `skipped: ${error.message}`
                }
              }
              db.exec('DETACH incoming')
              reply(200, { ok: true, format: 'database', merged, tables: mergedByTable })
            } finally {
              db.close()
            }
          } finally {
            try {
              rmSync(temp, { force: true })
            } catch {
              // Temp file cleanup is best effort.
            }
          }
          return
        }

        // v1: the old memory-card bundle still imports, for archives made earlier.
        const payload = files.get('memory.json')
        if (payload === undefined) {
          reply(400, { ok: false, error: 'archive has neither memory.db nor memory.json' })
          return
        }
        const bundle = JSON.parse(payload.toString('utf8'))
        const result = store.importBundle(bundle)
        reply(result.ok ? 200 : 400, result)
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: import route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/unarchive',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req)
        const canonical = String(body?.canonical ?? '')
        if (canonical === '') {
          reply(400, { ok: false, error: 'canonical is required' })
          return
        }
        const result = store.unarchiveEntity(canonical)
        reply(result.ok ? 200 : 400, result)
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: unarchive route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/export',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method !== 'GET') {
        reply(405, { ok: false, error: 'GET required' })
        return
      }
      try {
        // Full backup: a consistent snapshot of the whole database plus a manifest.
        // The old JSON bundle only carried memory cards, so turns, relationship state
        // and session summaries were lost on restore.
        const snapshot = join(tmpdir(), `dsh-memory-export-${randomUUID()}.db`)
        try {
          const source = new DatabaseSync(store.file, { readOnly: true })
          try {
            source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
          } finally {
            source.close()
          }
          const bytes = readFileSync(snapshot)
          const manifest = {
            format: 'dsh-memory-database',
            version: 2,
            exportedAt: new Date().toISOString(),
            bytes: bytes.length,
          }
          const archive = writeZip([
            { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
            { name: 'memory.db', data: bytes },
          ])
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="dsh-memory.zip"',
            'cache-control': 'no-store',
          })
          res.end(archive)
        } finally {
          try {
            rmSync(snapshot, { force: true })
          } catch {
            // Temp file cleanup is best effort.
          }
        }
      } catch (error) {
        reply(500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: export route')

  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/qq',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (typeof body?.userUin === 'string') store.setMeta('qq.userUin', body.userUin.trim())
          if (typeof body?.botUin === 'string') store.setMeta('qq.botUin', body.botUin.trim())
          if (typeof body?.enabled === 'boolean') store.setMeta('qq.enabled', body.enabled ? '1' : '0')
          if (typeof body?.localModel === 'string') store.setMeta('qq.localModel', body.localModel.trim())
          if (typeof body?.localSwitch === 'boolean') store.setMeta('qq.localSwitch', body.localSwitch ? '1' : '0')
          if (typeof body?.workspace === 'string') store.setMeta('qq.workspace', body.workspace.trim())
        } catch (error) {
          reply(500, { ok: false, error: String(error?.message ?? error) })
          return
        }
      }
      reply(200, { ok: true, config: qqConfigOf(store), status: qqStatus() })
    },
  }), 'dsh-memory: qq config route')

  // Which model turns queued conversation into memory cards. Local is the default
  // recommendation because normalization runs on every turn and a cloud model would
  // spend money in the background without the operator noticing.
  owner.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-memory/normalizer',
    handler: async (req, res) => {
      const reply = (status, payload) => json(res, status, payload)
      if (!admit(req, reply)) return
      if (req.method === 'GET') {
        reply(200, { ok: true, config: normalizerConfigOf(store, settings) })
        return
      }
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'GET or POST required' })
        return
      }
      try {
        const body = await readBody(req)
        if (body?.mode !== undefined) {
          const mode = String(body.mode)
          if (!['local', 'cloud', 'off', ''].includes(mode)) throw new Error('mode must be local, cloud or off')
          store.setMeta('normalize.mode', mode)
        }
        if (typeof body?.model === 'string') store.setMeta('normalize.model', body.model.trim())
        if (typeof body?.provider === 'string') store.setMeta('normalize.provider', body.provider.trim())
      } catch (error) {
        reply(400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      reply(200, { ok: true, config: normalizerConfigOf(store, settings) })
    },
  }), 'dsh-memory: normalizer route')
}

/** Normalization model configuration, with the profile values as defaults. */
export function normalizerConfigOf(store, settings = {}) {
  const mode = String(store.getMeta('normalize.mode') ?? '').trim()
  const storedModel = String(store.getMeta('normalize.model') ?? '').trim()
  const storedProvider = String(store.getMeta('normalize.provider') ?? '').trim()
  return {
    /** local | cloud | off, empty string means "whatever the profile says" */
    mode: mode === '' ? 'local' : mode,
    model: storedModel !== '' ? storedModel : String(settings.normalizeModel ?? '').trim(),
    provider: storedProvider !== '' ? storedProvider : String(settings.normalizeProvider ?? '').trim(),
    /** What the profile would use when nothing is chosen in the panel. */
    profileModel: String(settings.normalizeModel ?? '').trim(),
    followSession: settings.normalizeFollowSession !== false,
  }
}

/** The QQ channel configuration as stored in the memory database. */
export function qqConfigOf(store) {
  return {
    enabled: store.getMeta('qq.enabled') === '1',
    userUin: String(store.getMeta('qq.userUin') ?? '').trim(),
    botUin: String(store.getMeta('qq.botUin') ?? '').trim(),
    localModel: String(store.getMeta('qq.localModel') ?? '').trim(),
    localSwitch: store.getMeta('qq.localSwitch') === '1',
    /** Working directory for the two QQ Sessions; empty means "ask DSH". */
    workspace: String(store.getMeta('qq.workspace') ?? '').trim(),
  }
}

/**
 * Read-only payload for the panel: what the store knows, without leaking any
 * session content (only canonical names, counts, and the last action/state).
 * @param {import('./store.js').MemoryStore} store
 */
export function panelData(store, settings = {}) {
  const db = store.db
  const one = sql => Number(db.prepare(sql).get().n)
  const entities = db.prepare(`
    SELECT e.canonical, e.kind, e.weight, e.use_count, e.first_seen, e.last_seen, COUNT(o.id) AS mentions,
           (SELECT action FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS action,
           (SELECT state  FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS state,
           (SELECT detail FROM occurrences WHERE entity_id = e.id ORDER BY time DESC LIMIT 1) AS detail
    FROM entities e LEFT JOIN occurrences o ON o.entity_id = e.id
    WHERE e.deleted_at IS NULL
    GROUP BY e.id
    ORDER BY mentions DESC, e.last_seen DESC
    LIMIT ?
  `).all(PANEL_LIMIT)
  const recent = db.prepare(`
    SELECT e.canonical, e.kind, o.action, o.state, o.detail, o.time, o.turn
    FROM occurrences o JOIN entities e ON e.id = o.entity_id
    WHERE e.deleted_at IS NULL
    ORDER BY o.time DESC LIMIT ?
  `).all(RECENT_LIMIT)
  return {
    stats: {
      entities: one('SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NULL'),
      trashed: one('SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NOT NULL'),
      occurrences: one('SELECT COUNT(*) AS n FROM occurrences'),
      turns: one('SELECT COUNT(*) AS n FROM turns'),
      toolCalls: one('SELECT COUNT(*) AS n FROM tool_calls'),
      subagentRuns: one('SELECT COUNT(*) AS n FROM subagent_runs'),
      sessions: one('SELECT COUNT(*) AS n FROM sessions'),
      links: one('SELECT COUNT(*) AS n FROM entity_links'),
      pending: one('SELECT COUNT(*) AS n FROM normalize_queue WHERE done_at IS NULL AND skipped IS NULL AND attempts < 3'),
      injected: store.getMeta('inject') ?? null,
      build: store.getMeta('build') ?? null,
      normalize: store.getMeta('normalize') ?? null,
    },
    entities,
    recent,
    trash: store.trashedEntities(50),
    archived: store.archivedEntities(50),
    timeline: store.recentTurns(80),
    habits: store.habits(20),
    style: store.styleProfile(),
    activeHours: store.activeHours(),
    importStats: store.getMeta('importBundle') ?? null,
    persona: {
      active: store.activePersona() ?? DEFAULT_PERSONA_ID,
      options: PERSONAS.map(persona => {
        const edit = store.personaOverride(persona.id)
        return {
          id: persona.id,
          name: edit?.name ?? persona.name,
          summary: persona.summary,
          edited: edit !== null,
          edit: edit ?? null,
        }
      }),
    },
    relationship: store.relationship(),
    usage: store.usageToday(),
    narratives: store.recentNarratives(4),
    backup: backupStatus(store, databaseFile()),
    database: (() => {
      const file = databaseFile()
      let bytes = 0
      try {
        bytes = statSync(file).size
      } catch {
        bytes = 0
      }
      return { path: file, mb: Math.round((bytes / 1024 ** 2) * 10) / 10 }
    })(),
    // Model selection is no longer tied to chat mode: the local model is a normal
    // setting the operator may want to pick while working.
    models: { ...modelStatus(store), selectable: true, endpoint: ollamaRoot(settings?.embedUrl ?? 'http://127.0.0.1:11434') },
    /** Which embedding model semantic recall is configured to use; empty disables it. */
    embedModel: String(settings?.embedModel ?? ''),
    normalizer: normalizerConfigOf(store, settings),
    ollamaUrl: settings?.ollamaUrl ?? settings?.embedUrl ?? 'http://127.0.0.1:11434',
    proactive: proactiveStatus(store),
    mood: store.moodNow(),
    lastContact: store.lastContactAt(),
    exportCounts: {
      entities: Number(db.prepare('SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NULL').get().n),
      records: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n),
      keywords: Number(db.prepare('SELECT COUNT(*) AS n FROM keyword_stats').get().n),
    },
    sessions: store.sessionsOf(40),
  }
}
