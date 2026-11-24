/**
 * Time sense and daily state.
 *
 * People feel "how long it has been" and "what kind of day this is". Both are
 * derived from what is already recorded (turn timestamps, thanks, boundaries) —
 * deterministic, no extra storage, and no way for a replay to inflate them.
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Local calendar day key, e.g. `2026-11-23`. */
export function dayKey(time) {
  const date = new Date(Number(time) || Date.now())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * How long ago, in words a person would use.
 * @param {number} gapMs
 * @returns {string | null}
 */
export function describeGap(gapMs) {
  const gap = Number(gapMs)
  if (!Number.isFinite(gap) || gap < 0) return null
  if (gap < 2 * MINUTE_MS) return '刚刚'
  if (gap < HOUR_MS) return `${Math.max(2, Math.round(gap / MINUTE_MS))} 分钟前`
  if (gap < 6 * HOUR_MS) return `${Math.round(gap / HOUR_MS)} 小时前`
  if (gap < DAY_MS) return '今天早些时候'
  const days = Math.floor(gap / DAY_MS)
  if (days === 1) return '昨天'
  if (days <= 3) return `${days} 天前`
  if (days <= 7) return '快一周了'
  return `好久没聊了（${days} 天）`
}

/**
 * Today's baseline state.
 *
 * @param {{
 *   now: number,
 *   lastContactAt: number | null,
 *   turnsToday: number,
 *   lastNightHour: number | null,
 *   thanksRecent: number,
 *   boundariesRecent: number,
 * }} input
 * @returns {{ valence: number, energy: number, note: string }}
 */
export function computeMood(input) {
  const now = Number(input.now) || Date.now()
  const lastContactAt = Number(input.lastContactAt) || 0
  const turnsToday = Math.max(0, Number(input.turnsToday) || 0)
  const nightHour = input.lastNightHour === null || input.lastNightHour === undefined
    ? null
    : Number(input.lastNightHour)
  const thanks = Math.max(0, Number(input.thanksRecent) || 0)
  const boundaries = Math.max(0, Number(input.boundariesRecent) || 0)

  let energy = 0.5
  if (nightHour !== null && nightHour >= 1 && nightHour <= 4) energy -= 0.25
  else if (nightHour !== null && nightHour >= 23) energy -= 0.15
  if (turnsToday >= 6) energy -= 0.1
  else if (turnsToday > 0 && turnsToday <= 2) energy += 0.05
  energy = Math.max(0, Math.min(1, energy))

  let valence = 0.5
  if (thanks > 0) valence += 0.15
  if (boundaries > 0) valence -= 0.25
  const gapDays = lastContactAt === 0 ? 0 : Math.floor((now - lastContactAt) / DAY_MS)
  if (gapDays >= 8) valence -= 0.1
  valence = Math.max(0, Math.min(1, valence))

  const moodWord = energy < 0.3 ? '有点没精神' : energy < 0.45 ? '精神一般' : energy > 0.6 ? '状态不错' : '状态还行'
  const parts = [moodWord]
  if (nightHour !== null && (nightHour >= 1 && nightHour <= 4 || nightHour >= 23)) {
    parts.push(`昨晚聊到 ${String(nightHour).padStart(2, '0')}:00`)
  }
  if (valence < 0.35) parts.push('今天有点安静')
  else if (valence > 0.62) parts.push('心情不错')
  return { valence: Number(valence.toFixed(2)), energy: Number(energy.toFixed(2)), note: parts.join('；') }
}

/**
 * The one-line time sense: how long since the last conversation.
 * @param {number | null} lastContactAt
 * @param {number} [now]
 * @returns {string | null}
 */
export function describeLastContact(lastContactAt, now = Date.now()) {
  const at = Number(lastContactAt) || 0
  if (at === 0) return null
  const gap = describeGap(now - at)
  return gap === null ? null : `上次聊是${gap}`
}
