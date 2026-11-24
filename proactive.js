/**
 * Proactive companionship: one daily greeting, created through DSH's `schedule`
 * service so it arrives as a real turn instead of a notification.
 *
 * Off by default. A persona that speaks first must be asked for, and it must be
 * switchable off again — otherwise it is a bug, not a companion.
 */
import { DEFAULT_PERSONA_ID, personaById } from './personas.js'

/** Meta key holding the created task id and the spec it was created from. */
const TASK_META = 'proactive.task'
/** Meta key holding the last sync result, for the panel. */
const STATE_META = 'proactive.state'

/**
 * The prompt the scheduler delivers. It lands as a user message, so it has to read
 * like an instruction the assistant can act on in character — not like a notice.
 *
 * @param {{ name: string, address?: string | null }} input
 */
export function proactivePrompt(input) {
  const name = String(input?.name ?? '你')
  const address = typeof input?.address === 'string' && input.address !== '' ? input.address : null
  return [
    `（系统提示：现在到了你们打招呼的时间，是${name}主动开口，不是在回答用户。）`,
    `主动和${address === null ? '用户' : `「${address}」`}说句话：用你自己的语气，一两句，像人一样自然。`,
    '如果你们很久没聊，可以顺势提一句；如果还欠着事，可以顺口问一下进度。',
    '不要解释这来自定时任务，不要列清单，不要问"有什么可以帮你"。',
  ].join('\n')
}

/**
 * Create, keep, or remove the daily greeting to match the current settings.
 *
 * @param {{
 *   schedule: any,
 *   store: any,
 *   settings: { proactive?: boolean, proactiveTime?: string, proactiveZone?: string, proactiveAdaptive?: boolean },
 * }} input
 * @returns {Promise<{ enabled: boolean, taskId?: string, action: string, error?: string }>}
 */
export async function syncProactive(input) {
  const { schedule, store, settings } = input
  const enabled = settings.proactive === true
  let recorded = null
  try {
    const raw = store.getMeta(TASK_META)
    if (typeof raw === 'string' && raw !== '') recorded = JSON.parse(raw)
  } catch {
    recorded = null
  }

  const remember = state => {
    try {
      store.setMeta(STATE_META, JSON.stringify(state))
    } catch {
      // Observability only.
    }
    return state
  }

  if (!enabled) {
    if (recorded?.id === undefined) return remember({ enabled: false, action: 'off' })
    // Best effort: the method name has varied between DSH releases.
    for (const method of ['delete', 'remove', 'revoke', 'retire']) {
      try {
        if (typeof schedule[method] === 'function') {
          await schedule[method](recorded.id)
          store.setMeta(TASK_META, '')
          return remember({ enabled: false, action: 'removed' })
        }
      } catch (error) {
        console.warn(`[dsh-memory] proactive: ${method} failed:`, error?.message ?? error)
      }
    }
    return remember({ enabled: false, action: 'remove-failed' })
  }

  // Adaptive timing: greet when this user usually shows up, not at a fixed hour.
  // A configured HH:MM still wins when the user set one explicitly AND adaptation
  // is off; otherwise the learned hour decides.
  // The scheduler wants HH:mm:ss; a bare HH:mm is rejected at creation.
  const rawTime = typeof settings.proactiveTime === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(settings.proactiveTime)
    ? settings.proactiveTime
    : '09:00:00'
  const configured = rawTime.length === 5 ? `${rawTime}:00` : rawTime
  const adaptive = settings.proactiveAdaptive !== false
  const samples = typeof store.hourSampleSize === 'function' ? store.hourSampleSize() : 0
  const learnedHour = adaptive && samples >= 20 && typeof store.preferredHour === 'function'
    ? store.preferredHour()
    : null
  const time = learnedHour === null
    ? configured
    : `${String(learnedHour).padStart(2, '0')}:00:00`
  const zone = typeof settings.proactiveZone === 'string' && settings.proactiveZone !== ''
    ? settings.proactiveZone
    : 'Asia/Shanghai'
  const persona = personaById(store.activePersona() ?? DEFAULT_PERSONA_ID)
  const spec = JSON.stringify({ time, zone, persona: persona.id })

  if (recorded !== null && recorded.spec === spec && recorded.id !== undefined) {
    return remember({ enabled: true, time, zone, learnedHour, samples, taskId: recorded.id, action: 'kept' })
  }

  try {
    const entry = await schedule.create({
      title: '主动问候',
      prompt: proactivePrompt({ name: persona.name, address: store.address() }),
      timing: { kind: 'daily', daily: { time, time_zone: zone } },
      target: { kind: 'new_once' },
    })
    const id = String(entry?.id ?? '')
    store.setMeta(TASK_META, JSON.stringify({ id, spec }))
    return remember({ enabled: true, time, zone, learnedHour, samples, taskId: id, action: recorded === null ? 'created' : 'recreated' })
  } catch (error) {
    return remember({ enabled: true, time, zone, learnedHour, samples, action: 'failed', error: String(error?.message ?? error) })
  }
}

/** What the panel shows about the schedule, from the last sync. */
export function proactiveStatus(store) {
  try {
    const raw = store.getMeta(STATE_META)
    if (typeof raw === 'string' && raw !== '') return JSON.parse(raw)
  } catch {
    // fall through to the default
  }
  return { enabled: false, time: '09:00', taskId: null, action: 'unknown' }
}
