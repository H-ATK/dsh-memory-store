/**
 * Retrieval and rendering for the injection stage (M4).
 *
 * Pure: takes a store handle plus a query string and returns both the ranked
 * entities and the exact text block that may be injected. The block is rendered
 * deterministically so an unchanged memory produces byte-identical text, which
 * keeps the provider's context-cache prefix stable.
 */
import { bigramsOf, cleanUserText } from './normalize.js'

/** Opening and closing markers kept only to recognize older injected blocks. */
export const MEMORY_OPEN = '[memory]'
export const MEMORY_CLOSE = '[/memory]'

/**
 * Budget for one compact recall. The compact style needs an order of magnitude
 * less than the earlier sectioned block: a typical recall is 40–70 tokens.
 */
export const DEFAULT_BUDGET_TOKENS = 160

/**
 * @typedef {object} MemoryItem
 * @property {number} id
 * @property {string} canonical
 * @property {string} kind
 * @property {number} weight
 * @property {number} mentions
 * @property {number} lastSeen
 * @property {string} action
 * @property {string} state
 * @property {string} detail
 * @property {number} score
 * @property {number} [shared]
 * @property {number} [reviews]
 * @property {number} [retention]
 * @property {boolean} [inWorkspace]
 * @property {boolean} [fuzzy]
 * @property {number} [semantic]
 * @property {number} [firstSeen]
 */

/**
 * Extract the text a retrieval should read from a set of message content blocks.
 * @param {readonly any[]} messages
 * @returns {string}
 */
export function queryTextOf(messages) {
  const parts = []
  for (const message of messages ?? []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return cleanUserText(parts.join('\n'))
}

/**
 * Rough token estimate for a rendered block: CJK characters count as one token,
 * Latin words as one each. Deliberately conservative to stay under a budget.
 * @param {string} text
 */
export function estimateTokens(text) {
  const cjk = (String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (String(text).replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
    .match(/[A-Za-z0-9][A-Za-z0-9_'-]*/g) ?? []).length
  return cjk + latin
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

/**
 * The shortest phrase that still carries the memory's meaning.
 *
 * Preferences keep their detail (that is the durable fact); everything else keeps
 * only the last action, because states and details are the bulky part and the
 * name plus action is usually enough to decide whether to look closer.
 *
 * @param {MemoryItem} item
 */
function phraseOf(item) {
  const isPreference = item.kind === 'preference' || item.kind === 'person'
  if (isPreference) {
    return clip(item.detail, 24) || clip(item.state, 16) || clip(item.action, 12)
  }
  return clip(item.action, 12) || clip(item.state, 12)
}

/**
 * One item as a terse note fragment: `名字 动作×N`.
 * @param {MemoryItem} item
 */
export function renderItem(item) {
  const phrase = phraseOf(item)
  const count = Number(item.mentions) > 1 ? `×${item.mentions}` : ''
  return `${item.canonical}${phrase === '' ? '' : ` ${phrase}`}${count}`
}

/**
 * Render a recall as one plain line.
 *
 * Deliberately has no markers, no section headings, and no instructions: a
 * labelled block invites the model to announce it ("根据注入的记忆…"), which is
 * exactly the force-fed feel this style avoids. The text reads like a terse
 * personal note instead.
 *
 * @param {readonly MemoryItem[]} items already ranked
 * @param {{ budgetTokens?: number, related?: readonly MemoryItem[], change?: string | null }} [options]
 * @returns {{ text: string | null, items: MemoryItem[], related: MemoryItem[], tokens: number }}
 */
export function renderBlock(items, options = {}) {
  const budget = Math.max(60, options.budgetTokens ?? DEFAULT_BUDGET_TOKENS)
  const related = Array.isArray(options.related) ? options.related : []
  const chosen = []
  const relatedShown = []
  const parts = []
  let used = 0
  const push = text => {
    const cost = estimateTokens(text) + 1
    if (used + cost > budget) return false
    parts.push(text)
    used += cost
    return true
  }
  for (const item of items) {
    if (!push(renderItem(item))) break
    chosen.push(item)
  }
  for (const item of related) {
    if (chosen.length === 0) break
    if (!push(`${item.canonical}×${item.mentions}`)) break
    relatedShown.push(item)
  }
  if (parts.length === 0) return { text: null, items: [], related: [], tokens: 0 }
  // A different window's last change, appended to the same line: it tells the
  // model where the work it is being asked to continue actually lives.
  const change = options.change === undefined || options.change === null ? '' : String(options.change)
  const body = parts.join(' / ')
  return {
    text: change === '' ? body : `${body} · 刚改动：${change}`,
    items: chosen,
    related: relatedShown,
    tokens: used + (change === '' ? 0 : estimateTokens(change) + 3),
  }
}

/**
 * A one-fragment description of what a handoff touched: `Player.kt(+3)`.
 * @param {readonly string[]} files
 * @returns {string | null}
 */
export function describeChange(files) {
  const list = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file !== '') : []
  if (list.length === 0) return null
  const name = list[0].split(/[\\/]/).pop() || list[0]
  return list.length > 1 ? `${name}(+${list.length - 1})` : name
}

/**
 * The one-time orientation line for a new Session, across every workspace.
 *
 * Deliberately quiet: names only, newest first, no counts and no instructions.
 * A line that advertises "59 memories" invites the model to tour a project
 * instead of answering the question it was asked.
 *
 * @param {{ total: number, items: ReadonlyArray<{ canonical: string }> } | null} brief
 * @param {{ project?: string | null, change?: string | null, style?: readonly string[] | null }} [extras]
 * @returns {string | null}
 */
export function renderBrief(brief, extras = {}) {
  if (brief === null || brief === undefined) return null
  const items = Array.isArray(brief.items) ? brief.items : []
  if (items.length === 0 || !(Number(brief.total) > 0)) return null
  const parts = [`最近：${items.map(item => item.canonical).join('、')}`]
  if (typeof extras.project === 'string' && extras.project !== '') parts.push(`项目：${extras.project}`)
  if (typeof extras.change === 'string' && extras.change !== '') parts.push(`上次改动：${extras.change}`)
  if (Array.isArray(extras.style) && extras.style.length > 0) parts.push(`风格：${extras.style.join('、')}`)
  return parts.join(' · ')
}

/**
 * Retrieve and render in one step.
 * @param {{ recall: (grams: readonly string[], options?: any) => MemoryItem[], fuzzyRecall?: (text: string, options?: any) => MemoryItem[], relatedItems?: (ids: number[], minCo?: number, limit?: number) => MemoryItem[] }} store
 * @param {string} query
 * @param {{
 *   limit?: number, budgetTokens?: number, minScore?: number, maxItems?: number,
 *   workspace?: string | null, change?: string | null,
 *   extraItems?: readonly MemoryItem[], relatedLimit?: number, minCoMentions?: number,
 * }} [options]
 * @returns {{ items: MemoryItem[], text: string | null, tokens: number, related: MemoryItem[] }}
 */
export function retrieve(store, query, options = {}) {
  const cleaned = cleanUserText(query)
  // Read-side gate only: the write-side skip rules (`worthNormalizing`) reject
  // short and filler text, but "播放器" is a perfectly valid retrieval query.
  if (cleaned.length < 2) return { items: [], text: null, tokens: 0, related: [] }
  const grams = bigramsOf(cleaned)
  if (grams.length === 0) return { items: [], text: null, tokens: 0, related: [] }
  let items = store.recall(grams, {
    limit: options.limit ?? 8,
    workspace: options.workspace,
  })
  // Nothing matched literally. Before giving up, try the names themselves: a typo,
  // a longer phrasing that contains the name, or a name merged away earlier.
  if (items.length === 0 && typeof store.fuzzyRecall === 'function') {
    items = store.fuzzyRecall(cleaned, { limit: 3, workspace: options.workspace })
  }
  const minScore = options.minScore ?? 0.34
  // A single incidental gram ("插件", "用量") matches many entities in a topical
  // corpus; require a second shared gram unless the match is strong overall.
  // Semantic hits computed by the caller (local embeddings). They join the same
  // line and are deduplicated by identity, so a memory can qualify either way.
  const extra = Array.isArray(options.extraItems) ? options.extraItems : []
  const kept = items.filter(item => item.score >= minScore
    && ((item.shared ?? 0) >= 2 || item.score >= 0.8))
  const merged = [...kept]
  for (const item of extra) {
    if (item === null || item === undefined) continue
    if (!merged.some(existing => Number(existing.id) === Number(item.id))) merged.push(item)
  }
  if (merged.length === 0) return { items: [], text: null, tokens: 0, related: [] }
  // Relevance decides *whether* a memory qualifies; recency decides the order it
  // is presented in. Newest first is what "优先想起最近的记忆" asks for.
  const ordered = [...merged].sort((left, right) => Number(right.lastSeen) - Number(left.lastSeen))
  // Token budget alone lets many tiny fragments pile up into a long line; a hard
  // item cap keeps the note short enough to read as a remark.
  const maxItems = Math.max(1, Math.min(20, options.maxItems ?? 5))
  const capped = ordered.slice(0, maxItems)
  // One hop of association, bounded so it cannot crowd out the direct matches.
  // One shared turn is already a real association ("these two came up together"),
  // and the list is ordered by co-mention count, so the strongest come first.
  // A broad recall skips the hop: with several direct matches the context is
  // already specific, and a single long turn can pair unrelated objects.
  const related = typeof store.relatedItems === 'function' && capped.length <= 3
    ? store.relatedItems(capped.map(item => item.id), options.minCoMentions ?? 1, options.relatedLimit ?? 2)
    : []
  const rendered = renderBlock(capped, {
    budgetTokens: options.budgetTokens,
    related,
    change: options.change,
  })
  return { items: rendered.items, text: rendered.text, tokens: rendered.tokens, related: rendered.related }
}
