/**
 * Model routing: local first, cloud only when asked.
 *
 * DSH exposes the default model selection as a service (`agentDefaultModel`), so the
 * plugin can hand the agent back to a local model after a cloud turn. What it cannot
 * do is change a Session that already started: this routes the *default* that the
 * next turn/session picks up.
 */

/**
 * The server root behind a configured endpoint: `http://host:11434/api/embed` becomes
 * `http://host:11434`, because listing models asks a different path.
 * @param {string} url
 */
export function ollamaRoot(url) {
  return String(url ?? '').replace(/\/api\/[^/]*\/?$/, '').replace(/\/+$/, '') || 'http://127.0.0.1:11434'
}

/**
 * The models an Ollama server currently has.
 * @param {string} url e.g. http://127.0.0.1:11434
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<{ id: string, sizeGb: number }>>}
 */
export async function listOllamaModels(url, fetchImpl = fetch) {
  const response = await fetchImpl(`${ollamaRoot(url)}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`ollama HTTP ${response.status}`)
  const payload = await response.json()
  const models = Array.isArray(payload?.models) ? payload.models : []
  return models.map(model => ({
    id: String(model?.name ?? model?.model ?? '').replace(/:latest$/, ''),
    sizeGb: Math.round((Number(model?.size) || 0) / 1024 ** 3 * 10) / 10,
  })).filter(model => model.id !== '')
}

/** The stored policy, with defaults for a fresh profile. */
export function readModelPolicy(store) {
  let stored = null
  try {
    const raw = store.getMeta('modelPolicy')
    if (typeof raw === 'string' && raw !== '') stored = JSON.parse(raw)
  } catch {
    stored = null
  }
  return {
    local: stored?.local ?? null,
    paid: stored?.paid ?? null,
    autoSwitch: stored?.autoSwitch !== false,
  }
}

/** @param {any} store @param {any} policy */
export function writeModelPolicy(store, policy) {
  try {
    store.setMeta('modelPolicy', JSON.stringify(policy))
    return true
  } catch {
    return false
  }
}

/**
 * Ask DSH to use one model selection from now on.
 * @param {any} service the `agentDefaultModel` service
 * @param {{ provider: string, model: string }} selection
 */
export async function applySelection(service, selection) {
  if (service === undefined || selection === null || selection === undefined) return false
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return false
  let lastError = null
  // 插件热更新期间 DSH 会拒绝嵌套的 HMR 事务；等它结束后重试几次。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await service.saveSelection({ provider: selection.provider, model: selection.model })
      return true
    } catch (error) {
      lastError = error
      if (!/HMR transactions cannot be nested/i.test(String(error?.message ?? error))) break
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  console.warn('[dsh-memory] model switch failed:', lastError?.message ?? lastError)
  return false
}

/** What the panel shows. */
export function modelStatus(store) {
  const policy = readModelPolicy(store)
  let cloudOnce = false
  try {
    cloudOnce = store.getMeta('cloudOnce') === 'on'
  } catch {
    cloudOnce = false
  }
  return { ...policy, cloudOnce }
}
