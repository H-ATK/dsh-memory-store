/**
 * `memory_search`: on-demand recall as a tool.
 *
 * The automatic note is deliberately tiny (one line, 24–70 tokens). When the model
 * needs substance — "what did we decide about this" — it can ask, and get the
 * details the compact line omits.
 */
import { retrieve } from './retrieve.js'

const PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '要回忆的主题或关键词（中文原句即可）',
    },
    limit: {
      type: 'number',
      description: '最多返回几条（默认 5）',
    },
  },
  required: ['query'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string' },
          action: { type: 'string' },
          state: { type: 'string' },
          detail: { type: 'string' },
          mentions: { type: 'number' },
          lastSeen: { type: 'string' },
        },
        required: ['name'],
      },
    },
    related: { type: 'array', items: { type: 'string' } },
  },
  required: ['note', 'items'],
}

const formatItem = item => {
  const parts = [item.canonical]
  if (item.action) parts.push(item.action)
  if (item.state) parts.push(`（${item.state}）`)
  if (item.detail) parts.push(`：${String(item.detail).slice(0, 80)}`)
  if (Number(item.mentions) > 1) parts.push(` ×${item.mentions}`)
  return parts.join(' ')
}

/**
 * @param {{ ctx: any, store: any, settings: any }} input
 */
export function mountSearchTool({ ctx, store, settings, vectors }) {
  if (settings.searchTool === false) return
  if (typeof ctx.inject !== 'function') return

  ctx.inject(['tools'], scoped => {
    const tools = scoped.tools
    if (tools === undefined || typeof tools.register !== 'function') return
    /** Same query within this window answers from the previous result. */
    const REPEAT_WINDOW_MS = 5 * 60 * 1000
    const recentQueries = new Map()
    /**
     * A weak model keeps re-searching by appending its own results to the query, so the
     * string never repeats and per-query dedupe never fires. Cap the rate instead: past
     * the limit the tool refuses, which is the only signal such a model respects.
     */
    const CALL_LIMIT = 6
    const CALL_WINDOW_MS = 60 * 1000
    const callTimes = []
    const tooFrequent = () => {
      const now = Date.now()
      while (callTimes.length > 0 && now - callTimes[0] > CALL_WINDOW_MS) callTimes.shift()
      callTimes.push(now)
      return callTimes.length > CALL_LIMIT
    }
    try {
      ctx.effect(() => tools.register({
        name: 'memory_search',
        description: '在本地记忆库里按主题检索过去的工作记录（对象/动作/状态/细节）。自动注入只给一行线索，需要细节时用这个工具。',
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (args, value) => {
            const items = Array.isArray(value?.items) ? value.items : []
            const lines = [String(value?.note ?? '没有找到相关记忆。')]
            for (const item of items) lines.push(`- ${formatItem(item)}`)
            if (Array.isArray(value?.related) && value.related.length > 0) {
              lines.push(`联想：${value.related.join('、')}`)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args) {
          if (tooFrequent()) {
            return {
              note: '搜索太频繁，已被限制（一分钟内最多 6 次）。不要再调用工具，直接用已经拿到的内容回答用户。',
              items: [],
            }
          }
          let query = String(args?.query ?? '').trim()
          if (query === '') return { note: '没有查询词。', items: [] }
          // Long queries are the loop's fingerprint: the model pasted its own results
          // back in. Keep the head, which is what the user actually said.
          if (query.length > 80) {
            query = query.slice(0, 80)
            console.log('[dsh-memory] memory_search query truncated to 80 chars')
          }
          const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5))
          // A small model will happily re-run the same search hundreds of times when the
          // result does not say what it hoped. Answer repeats from the last result and
          // tell it to stop.
          const repeat = recentQueries.get(query)
          if (repeat !== undefined && Date.now() - repeat.at < REPEAT_WINDOW_MS) {
            return {
              note: '这个词刚刚搜过了，结果和上面完全一样。不要再重复搜索，直接用已有内容回答。',
              items: repeat.items,
              related: repeat.related,
            }
          }
          const remember = value => {
            const items = Array.isArray(value?.items) ? value.items : []
            recentQueries.set(query, { at: Date.now(), items, related: value?.related ?? [] })
            if (recentQueries.size > 64) {
              const oldest = [...recentQueries.entries()].sort((a, b) => a[1].at - b[1].at)[0]
              if (oldest !== undefined) recentQueries.delete(oldest[0])
            }
            return value
          }
          // Behaviour questions are answered from the style profile, not retrieval.
          if (/风格|语气|习惯|说话方式|口吻/.test(query)) {
            const profile = store.styleProfile()
            if (!profile.ready) return { note: `还需要更多对话才能总结习惯（当前 ${profile.messages}/20 条）。`, items: [] }
            return remember({
              note: `你的说话风格：${profile.labels.join('、')}（共 ${profile.messages} 条消息）`,
              items: [{
                name: profile.labels.join('、'),
                kind: 'habit',
                action: '风格',
                state: '',
                detail: `平均 ${profile.metrics.chars} 字 · 感叹 ${profile.metrics.exclam.toFixed(2)}/条 · 省略 ${profile.metrics.ellipsis.toFixed(2)}/条 · 礼貌词 ${profile.metrics.polite.toFixed(2)}/条`,
                mentions: profile.messages,
                lastSeen: '',
              }],
            })
          }
          // Literal matching misses natural questions ("我之前做过什么插件").
          // The embedding path answers those; both lists merge by identity.
          let extras = []
          if (vectors !== undefined && settings.embedModel !== '') {
            try {
              extras = await vectors.recallExtras(query, null)
            } catch {
              // Semantic recall is optional; lexical results still stand.
            }
          }
          const found = retrieve(store, query, {
            budgetTokens: 1200,
            minScore: 0.3,
            maxItems: limit,
            limit: 12,
            extraItems: extras,
          })
          if (found.text === null) {
            // Nothing matched literally: the names themselves are worth one try.
            const fuzzy = store.fuzzyRecall(query, { limit })
            if (fuzzy.length === 0) return remember({ note: '没有找到相关记忆。', items: [] })
            return remember({
              note: `按名字找到 ${fuzzy.length} 条：`,
              items: fuzzy.map(item => ({
                name: item.canonical,
                kind: item.kind,
                action: item.action ?? '',
                state: item.state ?? '',
                detail: item.detail ?? '',
                mentions: item.mentions,
                lastSeen: new Date(Number(item.lastSeen)).toLocaleString('zh-CN', { hour12: false }),
              })),
            })
          }
          return remember({
            note: `找到 ${found.items.length} 条（约 ${found.tokens} token）：`,
            items: found.items.map(item => ({
              name: item.canonical,
              kind: item.kind,
              action: item.action ?? '',
              state: item.state ?? '',
              detail: item.detail ?? '',
              mentions: item.mentions,
              lastSeen: new Date(Number(item.lastSeen)).toLocaleString('zh-CN', { hour12: false }),
            })),
            related: found.related.map(item => item.canonical),
          })
        },
      }), 'dsh-memory: memory_search tool')
    } catch (error) {
      console.warn('[dsh-memory] memory_search tool skipped:', error?.message ?? error)
    }
  })
}
