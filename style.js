/**
 * Behaviour profile: what this user is like when they talk, derived locally.
 *
 * Habits used to mean keywords only. Tone is the other half of "sounds like me":
 * how long the messages are, whether they say 请 or drop it, whether they shout,
 * whether they write Chinese or mix English. Everything here is deterministic —
 * counting characters, not calling a model.
 */

/** Emoji and pictograph ranges worth counting as a tone signal. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu

const count = (text, pattern) => (text.match(pattern) ?? []).length

/**
 * One message's raw signals.
 * @param {string} text
 */
export function signalsOf(text) {
  const body = String(text ?? '')
  const chars = body.replace(/\s+/g, '').length
  const latin = (body.match(/[A-Za-z]/g) ?? []).length
  return {
    messages: 1,
    chars,
    lines: body.split('\n').length,
    exclam: count(body, /[！!]/g),
    question: count(body, /[？?]/g),
    ellipsis: count(body, /…|\.{3,}/g),
    emoji: count(body, EMOJI),
    honorific: count(body, /您/g),
    polite: count(body, /请|麻烦|劳驾|拜托/g),
    direct: count(body, /帮我|给我|帮我|直接|立刻|马上|去做|改一下/g),
    code: count(body, /```/g),
    latinChars: latin,
    short: chars > 0 && chars <= 12 ? 1 : 0,
    long: chars >= 120 ? 1 : 0,
  }
}

/** Counter keys persisted in `style_stats`. */
export const SIGNAL_KEYS = [
  'messages', 'chars', 'lines', 'exclam', 'question', 'ellipsis',
  'emoji', 'honorific', 'polite', 'direct', 'code', 'latinChars', 'short', 'long',
]

/**
 * Turn totals into a short, human-readable profile.
 *
 * @param {Record<string, number>} totals
 * @returns {{ ready: boolean, messages: number, labels: string[], metrics: Record<string, number> }}
 */
export function profileOf(totals) {
  const messages = Number(totals.messages) || 0
  if (messages < 20) return { ready: false, messages, labels: [], metrics: {} }
  const per = key => (Number(totals[key]) || 0) / messages
  const metrics = {
    chars: Math.round((Number(totals.chars) || 0) / messages),
    exclam: per('exclam'),
    question: per('question'),
    ellipsis: per('ellipsis'),
    emoji: per('emoji'),
    honorific: per('honorific'),
    polite: per('polite'),
    direct: per('direct'),
    latin: (Number(totals.latinChars) || 0) / Math.max(1, Number(totals.chars) || 1),
    shortRate: per('short'),
    longRate: per('long'),
    codeRate: per('code'),
  }
  const labels = []
  if (metrics.chars <= 20) labels.push('简短')
  else if (metrics.chars >= 120) labels.push('长文')
  if (metrics.direct >= 0.3 && metrics.polite < 0.15) labels.push('直接')
  else if (metrics.polite >= 0.3) labels.push('客气')
  if (metrics.exclam >= 0.5) labels.push('爱感叹')
  if (metrics.ellipsis >= 0.3) labels.push('爱省略')
  if (metrics.emoji >= 0.2) labels.push('常用表情')
  if (metrics.honorific >= 0.2) labels.push('用「您」')
  if (metrics.latin >= 0.25) labels.push('中英混用')
  if (metrics.codeRate >= 0.2) labels.push('常贴代码')
  if (labels.length === 0) labels.push('平稳')
  return { ready: true, messages, labels: labels.slice(0, 4), metrics }
}
