/**
 * Weekly narrative: what this relationship has been about, one paragraph a week.
 *
 * Built from the objects touched and the turns taken — no model call, so it costs
 * nothing and cannot hallucinate. A month later this is what keeps "what were we
 * doing then" answerable without replaying every message.
 */

/** Monday 00:00 local for a timestamp. */
export function weekStart(time) {
  const date = new Date(Number(time) || Date.now())
  date.setHours(0, 0, 0, 0)
  const day = date.getDay() === 0 ? 7 : date.getDay()
  date.setDate(date.getDate() - (day - 1))
  return date.getTime()
}

/** `YYYY-MM-DD` of a week start. */
export function weekKey(time) {
  return new Date(weekStart(time)).toISOString().slice(0, 10)
}

/**
 * Compose one week's paragraph.
 *
 * @param {{ start: number, end: number, topObjects: Array<{ canonical: string, mentions: number }>, turns: number, days: number }} input
 * @returns {string}
 */
export function renderNarrative(input) {
  const names = input.topObjects.slice(0, 5).map(item => item.canonical)
  const head = `${weekKey(input.start)} 那周`
  const amount = input.turns === 0
    ? '没有聊什么'
    : `聊了 ${input.turns} 轮，分布在 ${input.days} 天`
  const focus = names.length === 0 ? '' : `，主要围绕 ${names.join('、')}`
  return `${head}：${amount}${focus}。`
}
