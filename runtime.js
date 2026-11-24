/**
 * Host runtime helpers shared by the memory plugin: where the database lives, how
 * one normalization call is made, and what build string the store records.
 */
import path from 'node:path'
import { CLOUD_OUTPUT_TOKENS, SYSTEM_PROMPT } from './normalize.js'

/** Written into the store on activation so the loaded generation is observable. */
export const BUILD = '2026-11-25T04:30+08:00 m15.92'

/** Delay before another drain pass while the backlog lasts. */
export const DRAIN_DELAY_MS = 20_000

/** The profile-owned database path, so every plugin instance shares one store. */
export function databaseFile() {
  const base = process.env.DSH_PROFILE_DIR
    || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || '.', '.dsh')
  return path.join(base, 'storages', 'dsh-memory', 'memory.db')
}

/**
 * The provider/model one normalization call should use when nothing else decides.
 * @param {any} ctx
 * @param {any} settings
 */
export function resolveTarget(ctx, settings) {
  const provider = String(settings.normalizeProvider ?? '').trim()
  const model = String(settings.normalizeModel ?? '').trim()
  if (provider !== '' && model !== '') return { provider, model }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection !== undefined
      && typeof selection.provider === 'string' && selection.provider !== ''
      && typeof selection.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // A profile without the settings owner simply cannot normalize.
  }
  return null
}

/**
 * One bounded model call, reduced to text plus usage.
 * @param {any} llm
 * @param {{ provider: string, model: string }} target
 * @param {string} user
 * @param {AbortSignal} signal
 * @param {number} [maxTokens]
 */
export async function callModel(llm, target, user, signal, maxTokens = CLOUD_OUTPUT_TOKENS) {
  const parts = []
  let usage
  const stream = llm.stream({
    provider: target.provider,
    model: target.model,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    temperature: 0,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') parts.push(String(chunk.text ?? ''))
    else if (chunk.type === 'usage') usage = chunk.usage
  }
  return { text: parts.join(''), usage }
}
