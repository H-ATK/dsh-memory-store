/**
 * Live capture listeners: every Session event goes through the same fold the
 * backfill uses, and a finished turn schedules normalization.
 */
import { LIVE_PURPOSE_LIMIT, TOOL_PURPOSES } from './tools.js'

/**
 * Did the user rename the assistant? "叫你小柒" / "以后叫你小柒" / "你的名字叫小柒".
 * Lives here because it is a naming habit, not part of any wake-word machinery.
 *
 * @param {string} text
 * @returns {string | null} the new name
 */
function parseRename(text) {
  const body = String(text ?? '')
  const patterns = [
    /(?:以后|从今以后|就)?(?:叫你|喊你|称呼你(?:为|作)?)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/u,
    /(?:你的名字|你叫)(?:改成|是|叫)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/u,
  ]
  for (const pattern of patterns) {
    const match = body.match(pattern)
    if (match !== null) {
      const name = match[1].replace(/(?:吧|啊|呀|了|就行|好了)$/u, '')
      if (name.length >= 1) return name
    }
  }
  return null
}

/**
 * Static tool purposes.
 *
 * Two sources, in priority order: the bundled concise map (stable, short, one
 * string per tool), then the live registry for anything the map does not know.
 * The registry alone is unreliable here: by the time this plugin activates every
 * tool is usually already registered, so no `tools/change` event follows and an
 * activation-time snapshot can stay permanently empty.
 *
 * @param {any} ctx
 */
export function createToolCatalog(ctx) {
  const purposes = new Map(Object.entries(TOOL_PURPOSES))
  const diagnostics = { service: false, schemas: 0, definitions: 0, error: null }

  const remember = (name, description) => {
    if (typeof name !== 'string' || name === '') return false
    if (typeof description !== 'string' || description.trim() === '') return false
    if (purposes.has(name)) return false // the bundled purpose wins
    const text = description.replace(/\s+/g, ' ').trim()
    purposes.set(name, text.length > LIVE_PURPOSE_LIMIT ? `${text.slice(0, LIVE_PURPOSE_LIMIT - 1)}…` : text)
    return true
  }

  const refresh = () => {
    try {
      const tools = ctx.get('tools')
      if (tools === undefined) return
      diagnostics.service = true
      const schemas = tools.schemas?.() ?? []
      diagnostics.schemas = schemas.length
      for (const schema of schemas) remember(schema?.name, schema?.description)
      const definitions = tools.definitions?.() ?? []
      diagnostics.definitions = definitions.length
      for (const definition of definitions) remember(definition?.name, definition?.description)
    } catch (error) {
      diagnostics.error = String(error?.message ?? error)
    }
  }
  refresh()
  try {
    ctx.on('tools/change', refresh)
  } catch {
    // An older Host without the event still captures with the bundled map.
  }
  return {
    refresh,
    diagnostics: () => JSON.stringify(diagnostics),
    describe(name) {
      if (!purposes.has(name)) refresh()
      return purposes.get(name) ?? `tool: ${name}`
    },
  }
}

/**
 * Mount the live capture listeners.
 *
 * @param {{ ctx: any, store: any, settings: any, scheduleNormalization: (delay: number) => void }} input
 */
/**
 * Learn the assistant's name from the conversation: "以后叫你小柒" becomes the wake
 * word, so speech and text agree without a separate field to edit.
 *
 * @param {any} store
 * @param {string} text
 * @returns {string | null} the new name, when it changed
 */
export function learnName(store, text) {
  const name = parseRename(text)
  if (name === null) return null
  if (store.wakeWord() === name) return null
  store.setWakeWord(name)
  try {
    store.setMeta('wake.source', 'spoken')
  } catch {
    // Observability only.
  }
  return name
}

export function mountCapture({ ctx, store, settings, scheduleNormalization }) {
  if (!settings.capture) return

  // A brand-new Session has no `sessions` row until a title or descriptor lands;
  // record its identity on the first event so the first-turn brief can find the
  // workspace it belongs to.
  const knownSessions = new Set()
  ctx.on('session/event', (session, event) => {
    try {
      const id = String(session?.id ?? '')
      const header = session?.header
      const workspace = typeof header?.cwd === 'string' ? header.cwd : null
      const origin = typeof header?.origin === 'string' ? header.origin : null
      if (id !== '' && !knownSessions.has(id)) {
        knownSessions.add(id)
        store.touchSession(id, {
          workspace,
          origin,
          createdAt: Number(header?.createdAt) || undefined,
        })
      }
      if (event?.type === 'tool/call' && !settings.captureTools) return
      store.applySessionEvent(id, event, { workspace, origin })
      const seq = Number(event?.seq)
      if (Number.isFinite(seq) && seq > 0) store.setCursor(id, seq)
      // A finished turn is the natural moment to distill its user message.
      if (event?.type === 'turn/end') {
        scheduleNormalization(1500)
        try {
          // Habits update immediately; the record is marked so it never counts twice.
          store.harvestHabits(4)
        } catch {
          // Habit tracking must never break capture.
        }
      }
    } catch (error) {
      console.warn('[dsh-memory] failed to store one event:', error?.message ?? error)
    }
  })

  if (settings.captureSubagents) {
    ctx.on('subagent/start', info => {
      try {
        store.recordSubagentStart(info)
      } catch (error) {
        console.warn('[dsh-memory] failed to store a subagent start:', error?.message ?? error)
      }
    })
    ctx.on('subagent/end', info => {
      try {
        store.recordSubagentEnd(info)
      } catch (error) {
        console.warn('[dsh-memory] failed to store a subagent end:', error?.message ?? error)
      }
    })
  }
}
