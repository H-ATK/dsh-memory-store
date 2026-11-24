/**
 * `agent/pre-step` injection: the one line of memory the model sees before it
 * starts thinking.
 *
 * The seam is the documented one: the decision's messages are appended to the
 * durable log and become the step's surface. DSH's own default decision appends a
 * synthetic runtime-context message the same way. A message without `source` would
 * throw inside the loop, hence `createUserMessage`.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MEMORY_OPEN, describeChange, queryTextOf, renderBrief, retrieve } from './retrieve.js'
import { classifyIntent, localAnswer } from './intent.js'
import { matchSkill, runSkill } from './skills.js'
import { takeObservation } from './observer.js'

/**
 * @param {{ ctx: any, store: any, settings: any, vectors: any }} input
 */
export function mountInjection({ ctx, store, settings, vectors }) {
  if (settings.injectMemories === false) return

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision === null || decision.kind !== 'enter') return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      if (messages.length === 0) return decision
      const query = queryTextOf(messages)
      if (query === '' || query.includes(MEMORY_OPEN)) return decision

      // Something the machine noticed goes first: one short line, then it is gone.
      const observed = settings.observe !== false ? takeObservation(store) : null
      if (observed !== null) {
        const note = `（你留意到：${observed}）`
        const message = createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'user' } })
        try {
          store.recordInjected(String(message.id))
        } catch {
          // Best effort.
        }
        return { ...decision, messages: [...messages, message] }
      }

      // Local skills run first: a file errand needs no model at all.
      if (settings.localSkills !== false) {
        try {
          const match = matchSkill(query)
          if (match !== null) {
            const result = await runSkill(match)
            const note = `（本地执行：${result}）`
            const message = createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'user' } })
            try {
              store.recordInjected(String(message.id))
              store.bumpUsage('local')
              store.setMeta('inject', JSON.stringify({ at: Date.now(), mode: 'skill', items: 0, tokens: Math.ceil(note.length / 1.6), names: [match.skill] }))
            } catch {
              // Observability only.
            }
            return { ...decision, messages: [...messages, message] }
          }
        } catch (error) {
          console.warn('[dsh-memory] local skill failed:', error?.message ?? error)
        }
      }

      // Questions about the user's own history are answered from the store: no
      // recall scoring, no relevance guess, one short line.
      let localNote = null
      if (settings.localAnswers !== false && classifyIntent(query) === 'memory') {
        try {
          localNote = localAnswer(store, query)
        } catch {
          localNote = null
        }
      }
      if (localNote !== null) {
        const answer = `（本地直答：${localNote}）`
        try {
          store.bumpUsage('local')
          store.setMeta('inject', JSON.stringify({ at: Date.now(), mode: 'local', items: 0, tokens: Math.ceil(answer.length / 1.6), names: [] }))
        } catch {
          // Observability only.
        }
        const direct = createUserMessage({ content: [{ type: 'text', text: answer }], source: { kind: 'user' } })
        try {
          store.recordInjected(String(direct.id))
        } catch {
          // Best effort.
        }
        return { ...decision, messages: [...messages, direct] }
      }

      let text = null
      let mode = 'recall'
      let names = []
      let related = []
      let tokens = 0

      // A brand-new window gets one orientation line before any recall: the most
      // recent objects across every workspace, since memory is shared across
      // workspaces by design. A subagent is not a new window — its parent already
      // supplied context, so a brief there would be pure token overhead.
      const agentId = String(payload?.agent?.id ?? '')
      const workspace = store.sessionWorkspace(agentId)
      // Remember the model this Session runs on: normalization follows it, so a
      // local conversation never needs a cloud call.
      try {
        store.recordSessionModel(agentId, payload?.modelSelection)
      } catch {
        // A missed model only means normalization falls back to the default.
      }
      // Chat mode widens recall (nothing is filtered out) but keeps every memory
      // line: knowing about the work is not the same as talking about it.
      const handoffOn = settings.handoff !== false
      // Semantic hits, when an embedding model is configured. Time-boxed by the
      // vector index, so a slow embedding server can only cost the fallback.
      const extras = await vectors.recallExtras(query, workspace)

      if (settings.briefOnNewSession !== false
        && Number(payload?.turn) === 1
        && agentId !== ''
        && !store.wasBriefed(agentId)) {
        const identity = store.sessionIdentity(agentId)
        if (identity.origin !== 'subagent') {
          const brief = store.recentBrief(Math.max(1, Number(settings.briefMaxItems) || 3))
          // What another window changed lately is the most useful anchor a fresh
          // window can get, and its absolute path says where the project lives.
          const handoff = handoffOn ? store.recentHandoff({ hours: 24, excludeSessionId: agentId }) : null
          const style = store.styleProfile()
          const line = renderBrief(brief, {
            project: store.recentProject(),
            change: handoff === null ? null : describeChange(handoff.files),
            style: style.ready ? style.labels : null,
          })
          if (line !== null) {
            text = line
            mode = 'brief'
            names = brief.items.map(item => item.canonical)
            try {
              store.markBriefed(agentId)
            } catch {
              // A missed marker only means one extra brief later.
            }
          }
        }
      }

      if (text === null) {
        const handoff = handoffOn ? store.recentHandoff({ hours: 12, excludeSessionId: agentId }) : null
        const found = retrieve(store, query, {
          // In chat mode nothing is filtered by workspace or by "is this work".
          budgetTokens: Math.max(60, Number(settings.injectBudgetTokens) || 160),
          minScore: Number(settings.injectMinScore) || 0.5,
          maxItems: Math.max(1, Number(settings.injectMaxItems) || 5),
          workspace,
          change: handoff === null ? null : describeChange(handoff.files),
          extraItems: extras,
          limit: 8,
        })
        if (found.text === null) return decision
        // Same topic as the previous turn and close in time: the model still has it
        // in context. Injecting it again is pure cost.
        const fresh = found.items.map(item => item.canonical)
        let previous = null
        try {
          const raw = store.getMeta('inject.last')
          if (typeof raw === 'string' && raw !== '') previous = JSON.parse(raw)
        } catch {
          previous = null
        }
        if (settings.injectPointers !== false && previous !== null
          && previous.session === agentId
          && Array.isArray(previous.names)
          && Date.now() - Number(previous.at) < 10 * 60_000) {
          const overlap = fresh.filter(name => previous.names.includes(name)).length
          if (fresh.length > 0 && overlap / fresh.length >= 0.6) {
            try {
              store.bumpUsage('skipped')
              store.setMeta('inject.last', JSON.stringify({ at: Date.now(), session: agentId, names: fresh, mode: 'skipped' }))
            } catch {
              // Observability only.
            }
            return decision
          }
        }
        try {
          store.setMeta('inject.last', JSON.stringify({ at: Date.now(), session: agentId, names: fresh }))
        } catch {
          // Observability only.
        }
        text = found.text
        names = found.items.map(item => item.canonical)
        related = found.related.map(item => item.canonical)
        tokens = found.tokens
        // Recall is rehearsal: every injected memory survives longer next time.
        try {
          store.reinforce(found.items.map(item => item.id))
        } catch {
          // Reinforcement is best-effort; the injection still proceeds.
        }
      }

      const injected = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      // Track the id so the store never records its own injection — the text
      // itself carries no marker, which keeps it reading like a plain note.
      try {
        store.recordInjected(String(injected.id))
      } catch {
        // Losing the id only risks re-recording the note once.
      }
      try {
        store.setMeta('inject', JSON.stringify({
          at: Date.now(),
          mode,
          items: names.length,
          related,
          tokens: tokens || Math.ceil(text.length / 1.6),
          names,
        }))
      } catch {
        // Observability must never break a turn.
      }
      return { ...decision, messages: [...messages, injected] }
    } catch (error) {
      // Injection is an enhancement: a failure returns the untouched decision.
      console.warn('[dsh-memory] memory injection skipped:', error?.message ?? error)
      return decision
    }
  })
}
