/**
 * Derived-data maintenance: the self-healing passes and the history replay.
 *
 * Repairs must run *after* a scan. Occurrences recorded before the `turn` column
 * existed sit at 0, and the real turn is only written onto their queue rows while
 * a scan replays the log — repairing first finds nothing (observed as
 * `entity_links` staying at 0 across restarts).
 */

/**
 * @param {import('./store.js').MemoryStore} store
 */
export function runMemoryRepairs(store) {
  try {
    // Turn records feed habits: keywords plus tone counters. Each record is
    // processed once, so this is safe at every startup.
    const narrative = store.ensureNarrative()
    if (narrative !== null && narrative.turns > 0) console.log(`[dsh-memory] narrative for ${narrative.week}: ${narrative.turns} turns`)
    const ledger = store.backfillRelationshipTurns()
    if (ledger > 0) console.log(`[dsh-memory] relationship ledger rebuilt from ${ledger} turn(s)`)
    const harvested = store.harvestHabits(400)
    if (harvested > 0) console.log(`[dsh-memory] harvested habits from ${harvested} conversation record(s)`)
    const turns = store.repairTurns()
    store.setMeta('turnRepair', JSON.stringify({ at: Date.now(), rows: turns }))
    const handoffs = store.repairHandoffs()
    store.setMeta('handoffRepair', JSON.stringify({ at: Date.now(), handoffs }))
    const links = store.repairLinks()
    store.setMeta('linkRepair', JSON.stringify({ at: Date.now(), links }))
    // Sleep-like housekeeping: fold repeats of the same event and let long-faded
    // objects drop out of recall (they stay stored).
    const consolidated = store.consolidate({ days: 30 })
    store.setMeta('consolidate', JSON.stringify({ at: Date.now(), ...consolidated }))
    const archived = store.archiveStale({ days: 180 })
    store.setMeta('archive', JSON.stringify({ at: Date.now(), ...archived }))
    if (consolidated.removed > 0 || archived.archived > 0) {
      console.log(`[dsh-memory] consolidated ${consolidated.removed} repeats, archived ${archived.archived} faded objects`)
    }
    if (turns > 0 || links > 0 || handoffs > 0) {
      console.log(`[dsh-memory] repaired ${turns} turns, ${handoffs} handoffs and ${links} object pairs`)
    }
  } catch (error) {
    console.warn('[dsh-memory] memory repair skipped:', error?.message ?? error)
  }
}

/**
 * Replay every stored Session through the same fold the live listeners use.
 *
 * Incremental: each Session remembers the highest seq it folded. Events at or
 * below that cursor are skipped, so a restart only pays for what is new. Reading
 * the log stays necessary (the service offers no ranged read), but the fold — the
 * expensive part — shrinks to the delta.
 *
 * @param {any} sessionQuery the unified session query service
 * @param {import('./store.js').MemoryStore} store
 */
export async function backfill(sessionQuery, store, options = {}) {
  const startedAt = Date.now()
  const budgetMs = Math.max(0, Number(options.maxMs) || 0)
  let records
  try {
    records = await sessionQuery.listSessions()
  } catch (error) {
    console.warn('[dsh-memory] cannot list Sessions for backfill:', error?.message ?? error)
    return
  }
  // Resume after the last Session a previous run finished, so a bounded replay
  // still covers the whole corpus over several restarts instead of always the
  // same newest few.
  const resume = store.getMeta('backfill.resume')
  if (typeof resume === 'string' && resume !== '') {
    const at = records.findIndex(record => record?.header?.id === resume)
    if (at >= 0) records = [...records.slice(at + 1), ...records.slice(0, at + 1)]
  }
  let sessions = 0
  let metadataOnly = 0
  let events = 0
  let unchanged = 0
  let repaired = false
  let deferred = 0
  let lastId = ''
  for (const [index, record] of records.entries()) {
    // A bounded replay keeps startup predictable: whatever is left continues on
    // the next activation from where this run stopped.
    if (budgetMs > 0 && Date.now() - startedAt > budgetMs) {
      deferred = records.length - index
      break
    }
    // Let the Host breathe between logs: replaying several thousand events in one
    // synchronous run is what made startup feel stuck.
    await new Promise(resolve => setImmediate(resolve))
    const header = record?.header
    if (header === undefined || typeof header.id !== 'string' || header.id === '') continue
    const workspace = typeof header.cwd === 'string' ? header.cwd : null
    const cursor = Number(store.cursorOf(header.id)) || 0
    // A subagent's conversation is never stored, but its identity is: the title and
    // the descriptor label are exactly the names a parent gave it.
    if (header.origin === 'subagent') {
      try {
        const snapshot = await sessionQuery.readSession(header.id)
        for (const event of snapshot.events ?? []) {
          if (cursor > 0 && Number(event.seq) <= cursor) continue
          store.applySessionEvent(header.id, event, { workspace, origin: 'subagent', metadataOnly: true })
        }
        metadataOnly += 1
      } catch (error) {
        console.warn('[dsh-memory] subagent metadata skipped:', error?.message ?? error)
      }
      continue
    }
    try {
      const snapshot = await sessionQuery.readSession(header.id)
      let maxSeq = cursor
      let folded = 0
      for (const event of snapshot.events ?? []) {
        const seq = Number(event?.seq)
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
        if (cursor > 0 && Number.isFinite(seq) && seq <= cursor) continue
        if (store.applySessionEvent(header.id, event, { workspace, origin: null })) {
          events += 1
          folded += 1
        }
      }
      store.setCursor(header.id, maxSeq)
      lastId = header.id
      store.touchSession(header.id, {
        workspace,
        origin: null,
        createdAt: Number(header.createdAt) || undefined,
      })
      sessions += 1
      if (folded === 0) unchanged += 1
    } catch (error) {
      console.warn('[dsh-memory] backfill skipped one Session:', error?.message ?? error)
    }
  }
  const elapsed = Date.now() - startedAt
  try {
    store.setMeta('backfill.resume', lastId)
  } catch {
    // A missing resume hint only repeats work.
  }
  const tail = deferred > 0 ? `, ${deferred} deferred` : ''
  console.log(`[dsh-memory] backfill done in ${elapsed}ms: ${sessions} Sessions (${metadataOnly} subagent identities, ${unchanged} unchanged), ${events} new rows${tail}`)
  // Repairs are only meaningful when the scan added rows: each pass is a full table
  // scan, and running them for nothing is pure startup cost.
  if (events > 0 || metadataOnly > 0) {
    repaired = true
    runMemoryRepairs(store)
  } else {
    store.setMeta('backfill', JSON.stringify({ at: Date.now(), sessions, events, unchanged, elapsed, repaired }))
  }
  void repaired
}
