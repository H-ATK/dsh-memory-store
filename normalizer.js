/**
 * Normalization runner: one small model request turns a queued user message into a
 * memory card. Never on the hot path — it drains after a turn ends and on a timer.
 */
import {
  CLOUD_OUTPUT_TOKENS,
  CLOUD_TIMEOUT_MS,
  LOCAL_OUTPUT_TOKENS,
  LOCAL_TIMEOUT_MS,
  bigramsOf,
  buildUserPrompt,
  cleanUserText,
  isLocalProvider,
  parseCard,
  pickNormalizeTarget,
  simpleCard,
  worthNormalizing,
} from './normalize.js'
import { DRAIN_DELAY_MS, callModel, resolveTarget } from './runtime.js'

/**
 * @param {{ ctx: any, store: any, settings: any, vectors?: { refreshVectors: () => Promise<number> } }} input
 */
export function createNormalizer({ ctx, store, settings, vectors }) {
  const normalizeEnabled = settings.normalize !== false
  let normalizing = false
  let normalizeTimer
  const recentCalls = []

  const overBudget = () => {
    const cutoff = Date.now() - 60 * 60 * 1000
    while (recentCalls.length > 0 && recentCalls[0] < cutoff) recentCalls.shift()
    return recentCalls.length >= Math.max(1, Number(settings.normalizeMaxPerHour) || 60)
  }

  const run = async () => {
    // The panel owns this choice: local / cloud / off. Empty means "use the profile
    // configuration", so an untouched install behaves exactly as before.
    const mode = String(store.getMeta('normalize.mode') ?? '').trim()
    if (mode === 'off') {
      try {
        store.setMeta('normalizeTarget', 'disabled')
      } catch {
        // Diagnostics must never break capture.
      }
      return
    }
    if (!normalizeEnabled || normalizing) return
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return
    // Explicit configuration wins; otherwise each Session normalizes on the model
    // it is actually running on, so a local-only conversation never needs a cloud
    // call. The profile default is the last resort.
    let configured
    if (mode === 'local') {
      configured = {
        provider: 'ollama',
        model: String(store.getMeta('normalize.model') ?? '').trim(),
      }
    } else if (mode === 'cloud') {
      configured = {
        provider: String(store.getMeta('normalize.provider') ?? '').trim(),
        model: String(store.getMeta('normalize.model') ?? '').trim(),
      }
    } else {
      configured = {
        provider: String(settings.normalizeProvider ?? '').trim(),
        model: String(settings.normalizeModel ?? '').trim(),
      }
    }
    const fallbackTarget = resolveTarget(ctx, settings)
    const followSession = settings.normalizeFollowSession !== false
    if (configured.provider === '' && fallbackTarget === null) {
      try {
        store.setMeta('normalizeTarget', 'no-default-model')
      } catch {
        // Diagnostics must never break capture.
      }
      return
    }
    const batch = Math.max(1, Math.min(50, Number(settings.normalizeBatch) || 8))
    const rows = store.queuePending(batch)
    if (rows.length === 0) return
    normalizing = true
    let ok = 0
    let skipped = 0
    let failed = 0
    const usedModels = new Map()
    try {
      for (const row of rows) {
        if (overBudget()) break
        const cleaned = cleanUserText(row.text)
        const verdict = worthNormalizing(cleaned)
        if (!verdict.worth) {
          store.markQueueSkipped(row.id, verdict.reason)
          skipped += 1
          continue
        }
        const target = pickNormalizeTarget({
          configured,
          session: followSession ? store.sessionModel(String(row.session_id)) : null,
          fallback: fallbackTarget,
        })
        if (target === null) {
          failed += 1
          store.markQueueFailed(row.id, 'no-model')
          continue
        }
        const key = `${target.provider}/${target.model}`
        usedModels.set(key, (usedModels.get(key) ?? 0) + 1)
        const local = isLocalProvider(target.provider)
        const candidates = store.candidateCanonicals(bigramsOf(cleaned))

        // A small local model that has already failed twice gets a rule-based card
        // instead of a third attempt: memory keeps accumulating without the model.
        if (settings.normalizeFallback !== false && Number(row.attempts) >= 2) {
          const card = simpleCard(cleaned, { candidates })
          if (card === null) {
            skipped += 1
            store.markQueueSkipped(row.id, 'fallback-empty')
            continue
          }
          store.applyCard({
            sessionId: row.session_id,
            seq: row.seq,
            turn: row.turn,
            time: row.added_at,
            card,
          })
          store.markQueueDone(row.id)
          store.logNormalize({ queueId: row.id, ...target, ok: true, error: 'fallback' })
          ok += 1
          continue
        }

        recentCalls.push(Date.now())
        let outcome
        try {
          outcome = await callModel(
            llm,
            target,
            buildUserPrompt(cleaned, candidates),
            AbortSignal.timeout(local ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS),
            local ? LOCAL_OUTPUT_TOKENS : CLOUD_OUTPUT_TOKENS,
          )
        } catch (error) {
          failed += 1
          const message = error?.message ?? String(error)
          store.markQueueFailed(row.id, message)
          store.logNormalize({ queueId: row.id, ...target, ok: false, error: message })
          continue
        }
        const tokens = {
          inputTokens: Number(outcome.usage?.inputTokens) || 0,
          outputTokens: Number(outcome.usage?.outputTokens) || 0,
        }
        const parsed = parseCard(outcome.text)
        if (parsed === null) {
          failed += 1
          store.markQueueFailed(row.id, 'unparseable')
          // Keep the raw reply for one failed attempt so the verbosity cause is
          // visible instead of guessed.
          store.logNormalize({
            queueId: row.id, ...target, ok: false, error: 'unparseable', raw: outcome.text, ...tokens,
          })
          continue
        }
        if (parsed.skip === true) {
          skipped += 1
          store.markQueueSkipped(row.id, 'model-skip')
          store.logNormalize({ queueId: row.id, ...target, ok: true, ...tokens })
          continue
        }
        store.applyCard({
          sessionId: row.session_id,
          seq: row.seq,
          turn: row.turn,
          time: row.added_at,
          card: parsed.card,
        })
        store.markQueueDone(row.id)
        store.logNormalize({ queueId: row.id, ...target, ok: true, ...tokens })
        ok += 1
      }
    } catch (error) {
      console.warn('[dsh-memory] normalization stopped early:', error?.message ?? error)
    } finally {
      normalizing = false
      try {
        store.setMeta('normalizeTarget', JSON.stringify({
          configured: configured.provider === '' ? null : configured,
          fallback: fallbackTarget,
          followSession,
          used: Object.fromEntries(usedModels),
        }))
        store.setMeta('normalize', JSON.stringify({
          at: Date.now(),
          lastRun: { ok, skipped, failed },
          ...store.queueStats(),
          ...store.normalizeStats(),
        }))
      } catch {
        // Observability must never break capture.
      }
      // New cards need vectors before the next semantic recall can use them.
      if (ok > 0 && vectors !== undefined) {
        try {
          await vectors.refreshVectors()
        } catch {
          // Embedding is best-effort; the cards are already stored.
        }
      }
      // Keep draining the backlog while the hourly budget allows, so the initial
      // import does not need one turn per batch.
      try {
        if (normalizeEnabled && !overBudget() && store.queueStats().pending > 0) {
          schedule(DRAIN_DELAY_MS)
        }
      } catch {
        // A drained queue is not an error.
      }
    }
  }

  const schedule = delay => {
    if (!normalizeEnabled) return
    if (normalizeTimer !== undefined) clearTimeout(normalizeTimer)
    normalizeTimer = setTimeout(() => {
      normalizeTimer = undefined
      void run()
    }, delay)
    if (typeof normalizeTimer.unref === 'function') normalizeTimer.unref()
  }

  const dispose = () => {
    if (normalizeTimer !== undefined) clearTimeout(normalizeTimer)
    normalizeTimer = undefined
  }

  return { run, schedule, dispose, enabled: normalizeEnabled }
}
