/**
 * Intent routing: decide, locally and for free, what this message needs.
 *
 * Three outcomes:
 * - 'memory'   a question about the user's own history; the store can answer it
 * - 'escalate' clearly hard work (code, errors, big refactors) worth a paid model
 * - 'chat'     everything else
 */

const MEMORY_PATTERNS = [
  /认识(多久|多长时间|几天)/,
  /(记得|记得吗|还记得)/,
  /我(常用|经常)(什么词|哪些词)/,
  /(上次|最近)(聊|说)(了)?(什么|啥|到哪)/,
  /我是谁|我叫什么/,
  /(我们|咱俩)(聊过|说过)/,
  /几点了|现在几点/,
]

const HARD_PATTERNS = [
  /\u0060\u0060\u0060/,
  /(重构|实现|修复|调试|优化|迁移|部署|上线)/,
  /(报错|异常|崩溃|失败|stack ?trace|traceback)/i,
  /(写|改|加|删)(一个|几个)?(函数|类|组件|接口|脚本)/,
  /(帮我|给我)(写|实现|改)/,
  /(sql|正则|表达式|docker|git|接口)/i,
]

/**
 * @param {string} text the latest human message
 * @returns {'memory' | 'escalate' | 'chat'}
 */
export function classifyIntent(text) {
  const body = String(text ?? '')
  if (body === '') return 'chat'
  if (MEMORY_PATTERNS.some(pattern => pattern.test(body))) return 'memory'
  const hardHits = HARD_PATTERNS.filter(pattern => pattern.test(body)).length
  // Length alone is a weak signal, so it needs a hard marker too.
  if (hardHits >= 1 && (body.length >= 24 || hardHits >= 2)) return 'escalate'
  return 'chat'
}

/**
 * A local answer for the memory questions, or null when this is not one.
 * @param {any} store
 * @param {string} text
 * @param {number} [now]
 * @returns {string | null}
 */
export function localAnswer(store, text, now = Date.now()) {
  const body = String(text ?? '')
  if (!MEMORY_PATTERNS.some(pattern => pattern.test(body))) return null
  const relationship = store.relationship(now)
  if (/认识(多久|多长时间|几天)/.test(body)) {
    return relationship.knownDays <= 0
      ? '这是我们第一次正经说话。'
      : `认识 ${relationship.knownDays} 天了，聊过 ${relationship.turns} 轮。`
  }
  if (/几点了|现在几点/.test(body)) {
    return `现在是 ${new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。`
  }
  if (/我(常用|经常)(什么词|哪些词)/.test(body)) {
    const words = store.habits(5).map(row => String(row.term))
    return words.length === 0 ? '还没攒够词。' : `你最常用的是 ${words.join('、')}。`
  }
  if (/(上次|最近)(聊|说)(了)?(什么|啥|到哪)/.test(body)) {
    const last = store.recentTurns(1)[0]
    if (last === undefined) return '还没有记录。'
    return `上次说的是「${String(last.user_text ?? '').slice(0, 60)}」。`
  }
  if (/我是谁|我叫什么/.test(body)) {
    return relationship.address === null
      ? '我还不知道你想让我怎么称呼你。'
      : `你是「${relationship.address}」。`
  }
  return null
}
