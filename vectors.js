/**
 * Semantic recall: object vectors plus per-query embedding.
 *
 * The llm service exposes no embedding call, so this talks to one HTTP endpoint
 * (Ollama `/api/embed`). Every call is time-boxed and a failure streak pauses the
 * feature, because recall must never make a turn wait on a model load.
 */

/**
 * @param {{ store: any, settings: any }} input
 */
export function createVectors({ store, settings }) {
  const embedModel = String(settings.embedModel ?? '').trim()
  const embedUrl = String(settings.embedUrl ?? 'http://127.0.0.1:11434/api/embed').trim()
  const embedMinSimilarity = Number(settings.embedMinSimilarity) || 0.55
  const embedTimeoutMs = Math.max(200, Number(settings.embedTimeoutMs) || 1500)
  const pausedMs = 10 * 60_000
  const queryVectors = new Map()
  let embedFailures = 0
  let embedPausedUntil = 0

  const enabled = () => embedModel !== '' && Date.now() >= embedPausedUntil

  /**
   * @param {readonly string[]} texts
   * @returns {Promise<number[][] | null>}
   */
  const embedTexts = async texts => {
    if (!enabled() || !Array.isArray(texts) || texts.length === 0) return null
    try {
      const response = await fetch(embedUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: embedModel, input: texts }),
        signal: AbortSignal.timeout(texts.length > 1 ? Math.max(embedTimeoutMs, 10_000) : embedTimeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload?.embeddings)) throw new Error('no embeddings')
      embedFailures = 0
      return payload.embeddings
    } catch {
      embedFailures += 1
      if (embedFailures >= 2) {
        embedPausedUntil = Date.now() + pausedMs
        try {
          store.setMeta('embeddingPaused', JSON.stringify({ at: Date.now(), until: embedPausedUntil }))
        } catch {
          // Observability must never break capture.
        }
      }
      return null
    }
  }

  /** Compute and store vectors for objects that lack a fresh one. */
  const refreshVectors = async () => {
    if (!enabled()) return 0
    const rows = store.entitiesForEmbedding(embedModel, 200)
    if (rows.length === 0) return 0
    let stored = 0
    for (let index = 0; index < rows.length; index += 8) {
      const chunk = rows.slice(index, index + 8)
      const texts = chunk.map(row => `${row.canonical} ${row.action ?? ''} ${row.detail ?? ''}`.trim())
      const vectors = await embedTexts(texts)
      if (vectors === null) break
      for (let offset = 0; offset < chunk.length; offset += 1) {
        if (Array.isArray(vectors[offset]) && store.saveVector(chunk[offset].id, vectors[offset], embedModel)) stored += 1
      }
    }
    try {
      store.setMeta('embedding', JSON.stringify({ at: Date.now(), model: embedModel, stored }))
    } catch {
      // Observability must never break capture.
    }
    return stored
  }

  /**
   * The query vector, cached; null when embeddings are off or unavailable.
   * @param {string} query
   */
  const queryVector = async query => {
    if (!enabled() || query.length < 2) return null
    const cached = queryVectors.get(query)
    if (cached !== undefined) return cached
    const embedded = await embedTexts([query])
    const vector = Array.isArray(embedded?.[0]) ? embedded[0] : null
    if (vector !== null) {
      if (queryVectors.size > 200) queryVectors.clear()
      queryVectors.set(query, vector)
    }
    return vector
  }

  /**
   * Semantic hits ready to merge into a recall note.
   * @param {string} query
   * @param {string | null} workspace
   */
  const recallExtras = async (query, workspace) => {
    const vector = await queryVector(query)
    if (!Array.isArray(vector)) return []
    try {
      return store.vectorRecall(vector, {
        limit: 3,
        minSimilarity: embedMinSimilarity,
        model: embedModel,
        workspace,
      })
    } catch {
      return []
    }
  }

  return {
    embedModel,
    embedMinSimilarity,
    embedTexts,
    refreshVectors,
    queryVector,
    recallExtras,
    enabled,
    /** True while the failure streak keeps semantic recall off. */
    paused: () => Date.now() < embedPausedUntil,
  }
}
