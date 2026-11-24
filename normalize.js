/**
 * Prompt, cleaning, and parsing for the normalization stage (M3).
 *
 * Pure functions only: no DSH import, no SQLite, so `test/normalize.mjs` can
 * check the whole pipeline without a model call.
 */

/** Messages that carry no memorable content and must not cost a request. */
const FILLER = new Set([
  '好', '好的', '好', '行', '可以', '收到', '谢谢', '感谢', '继续', '继续吧', '嗯', '嗯嗯',
  'ok', 'okay', 'yes', 'no', 'test', '测试', '在吗', '稍等', '等等', '不对', '再来',
])

/** Upper bound on text sent to the model for one turn. */
export const MAX_INPUT_CHARS = 600

/**
 * Strip harness scaffolding and noise from one user message.
 *
 * Measured on a real corpus, user messages average 548 characters and 11% carry
 * a `<system-reminder>` block naming the working directory, skills, and tools;
 * sending that to a model would turn the reminder's nouns into "memories".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cleanUserText(value) {
  let text = typeof value === 'string' ? value : ''
  if (text === '') return ''
  // Whole scaffolding blocks, plus any unbalanced tail.
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
  text = text.replace(/<system-reminder>[\s\S]*$/i, ' ')
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, ' ')
  // Fenced code contributes tool-ish tokens, not durable facts.
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`[^`\n]{1,80}`/g, ' ')
  // Bare URLs are noise for meaning.
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text
}

/**
 * Decide whether one cleaned message is worth a model call.
 * @param {string} cleaned output of {@link cleanUserText}
 * @returns {{ worth: boolean, reason: string }}
 */
export function worthNormalizing(cleaned) {
  const text = typeof cleaned === 'string' ? cleaned.trim() : ''
  if (text === '') return { worth: false, reason: 'empty' }
  if (text.length < 4) return { worth: false, reason: 'too-short' }
  if (FILLER.has(text.toLowerCase())) return { worth: false, reason: 'filler' }
  if (/^[/!.]/.test(text)) return { worth: false, reason: 'command' }
  if (!/[\p{L}\p{N}]/u.test(text)) return { worth: false, reason: 'no-letters' }
  // Mirrors the store-level guard: injected memory must never be re-recorded.
  if (text.includes('[memory]')) return { worth: false, reason: 'injected' }
  return { worth: true, reason: '' }
}

/** The fixed instruction. Kept byte-stable so the model prefix stays cacheable. */
export const SYSTEM_PROMPT = [
  '你是记忆整理器。把用户的一句话压缩成一条可长期复用的记忆卡片。',
  '只输出一个 JSON 对象，不要解释、不要代码块、不要多余文字。',
  '字段：',
  'canonical: 对象的规范名词，2-8 字，尽量与候选一致；',
  'kind: object | topic | preference | project | person 之一；',
  'action: 用户对该对象做了什么，2-6 字，没有则空字符串；',
  'state: 关键状态，如「已吃」「未吃」「已完成」「进行中」，没有则空字符串；',
  'detail: 仅在状态细节重要时写，≤20 字，否则空字符串；',
  'keywords: 最多 3 个关键词数组；',
  'weight: 0-1000 的整数，越像长期偏好越高。',
  '即使这句话里有好几件事，也只输出最主要的一件，绝不输出数组或多个对象。',
  '整条输出必须在一行内完成，第一个字符是 {，最后一个字符是 }。',
  '如果这句话没有可记忆的内容，输出 {"skip":true}。',
].join('\n')

/**
 * Compose the single user message for one turn.
 * @param {string} cleaned
 * @param {readonly string[]} candidates existing canonical names
 * @returns {string}
 */
export function buildUserPrompt(cleaned, candidates = []) {
  const list = candidates.length === 0 ? '（无）' : candidates.join('、')
  return `已有记忆对象（可复用则沿用其名词）：${list}\n待整理：${cleaned}`
}

/**
 * Parse the model reply into a validated card.
 * @param {string} raw
 * @returns {{ skip: true } | { skip: false, card: NormalizedCard } | null} null when unusable
 */
export function parseCard(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text === '') return null
  // Tolerate fences and leading prose even though the prompt forbids them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) text = fenced[1].trim()
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    text = text.slice(start, end + 1)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    // A small model can stop at its token cap mid-object; keep the fields that
    // already arrived instead of throwing the whole turn away.
    value = salvage(text)
    if (value === undefined) return null
  }
  if (value === null || typeof value !== 'object') return null
  if (value.skip === true) return { skip: true }

  const canonical = short(value.canonical, 24)
  if (canonical === '') return null
  const kinds = new Set(['object', 'topic', 'preference', 'project', 'person'])
  const kind = kinds.has(value.kind) ? value.kind : 'topic'
  const keywords = Array.isArray(value.keywords)
    ? value.keywords.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 5).map(item => short(item, 16))
    : []
  const weight = clamp(decimal(value.weight, 500), 0, 1000)
  return {
    skip: false,
    card: {
      canonical,
      kind,
      action: short(value.action, 16),
      state: short(value.state, 16),
      detail: short(value.detail, 80),
      keywords,
      weight,
    },
  }
}

/**
 * Providers that run on this machine. Used to be tolerant about latency and
 * output length, never to change what a card means.
 * @param {unknown} provider
 */
export function isLocalProvider(provider) {
  const name = typeof provider === 'string' ? provider.toLowerCase() : ''
  return /ollama|lmstudio|lm-studio|llama|gguf|vllm|local|koboldcpp|text-generation-webui/.test(name)
}

/** Token bounds per provider class: local models need a short leash. */
export const LOCAL_OUTPUT_TOKENS = 320
export const CLOUD_OUTPUT_TOKENS = 600
export const LOCAL_TIMEOUT_MS = 90_000
export const CLOUD_TIMEOUT_MS = 20_000

/**
 * Pick the provider/model used to normalize one Session's memory.
 *
 * Precedence: an explicit config pair wins; otherwise the model that Session is
 * actually running on; otherwise the profile default. Following the Session means
 * a local-only conversation never needs a cloud call.
 *
 * @param {{ configured?: { provider?: string, model?: string }, session?: { provider?: string, model?: string } | null, fallback?: { provider?: string, model?: string } | null }} input
 * @returns {{ provider: string, model: string } | null}
 */
export function pickNormalizeTarget(input = {}) {
  const valid = value => value !== null && value !== undefined
    && typeof value.provider === 'string' && value.provider !== ''
    && typeof value.model === 'string' && value.model !== ''
  if (valid(input.configured)) {
    return { provider: String(input.configured.provider), model: String(input.configured.model) }
  }
  if (valid(input.session)) {
    return { provider: String(input.session.provider), model: String(input.session.model) }
  }
  if (valid(input.fallback)) {
    return { provider: String(input.fallback.provider), model: String(input.fallback.model) }
  }
  return null
}

/** Words that carry no memory on their own. */
const FILLER_GRAMS = new Set([
  '这个', '那个', '就是', '然后', '现在', '可以', '需要', '还是', '或者', '因为', '所以',
  '但是', '如果', '已经', '没有', '什么', '怎么', '一个', '一下', '不是', '我们', '你们',
  '为了', '这样', '那样', '时候', '问题', '东西', '地方', '方式', '情况', '进行', '开始',
  '帮我', '帮忙', '麻烦', '给我', '请你', '看看', '明天', '今天', '昨天', '先把', '然后',
])

/**
 * A model-free card for one message, used when a small local model keeps failing
 * to produce JSON: memory keeps working, just with less structure.
 *
 * Reusing a name the store already knows beats inventing one: if the message
 * mentions an existing object, that object is the memory's subject. Otherwise the
 * most frequent 2–4 character run is a serviceable fallback.
 *
 * @param {string} cleaned output of {@link cleanUserText}
 * @param {{ candidates?: readonly string[] }} [options]
 * @returns {NormalizedCard | null}
 */
export function simpleCard(cleaned, options = {}) {
  const text = typeof cleaned === 'string' ? cleaned : ''
  if (text === '') return null
  const detail = short(text, 40)
  // 1. An existing object named in the message wins, longest first.
  const candidates = Array.isArray(options.candidates) ? options.candidates : []
  const known = candidates
    .filter(name => typeof name === 'string' && name.length >= 2 && text.includes(name))
    .sort((left, right) => right.length - left.length)
  if (known.length > 0) {
    return { canonical: known[0].slice(0, 24), kind: 'topic', action: '', state: '', detail, keywords: [], weight: 480 }
  }
  // 2. Otherwise the most repeated 2–4 character run, filler excluded.
  const counts = new Map()
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    for (let size = 2; size <= 4; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        const gram = run.slice(start, start + size)
        if (FILLER_GRAMS.has(gram)) continue
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
  }
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 2)
  }
  if (counts.size === 0) return null
  const [canonical] = [...counts].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1]
    return right[0].length - left[0].length
  })[0]
  if (typeof canonical !== 'string' || canonical.length < 2) return null
  return { canonical: canonical.slice(0, 24), kind: 'topic', action: '', state: '', detail, keywords: [], weight: 420 }
}

/**
 * @typedef {object} NormalizedCard
 * @property {string} canonical
 * @property {string} kind
 * @property {string} action
 * @property {string} state
 * @property {string} detail
 * @property {string[]} keywords
 * @property {number} weight
 */

/**
 * Recover a truncated JSON object by closing it at a safe boundary.
 * @param {string} text
 * @returns {object | undefined}
 */
function salvage(text) {
  const body = text.trim().replace(/[,:\s]+$/, '')
  const candidates = [`${body}}`]
  const lastComma = body.lastIndexOf(',')
  if (lastComma > 0) candidates.push(`${body.slice(0, lastComma)}}`)
  const lastQuote = body.lastIndexOf('"')
  if (lastQuote > 0) candidates.push(`${body.slice(0, lastQuote + 1)}}`)
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Try the next, more aggressive cut.
    }
  }
  return undefined
}

/** @param {unknown} value @param {number} max */
function short(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

/** @param {unknown} value @param {number} fallback */
function decimal(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

/** @param {number} value @param {number} low @param {number} high */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/**
 * Bigram keywords for local candidate lookup, reusing the store's shadow rule.
 * @param {string} text
 * @returns {string[]}
 */
export function bigramsOf(text) {
  const out = []
  for (const run of String(text ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) out.push(run.slice(index, index + 2))
  }
  for (const word of String(text ?? '').match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) out.push(word)
  return out
}
