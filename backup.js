/**
 * Automatic backups: a zip of everything, once a day, next to the database.
 *
 * The export route already builds the archive; this only schedules it and keeps the
 * last N files, so a crash or a bad merge never means losing the whole memory.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeZip } from './zip.js'

/** Where backups live, relative to the database file. */
export function backupFolder(databasePath) {
  return path.join(path.dirname(databasePath), 'backups')
}

const stamp = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/**
 * Write one backup archive and prune older ones.
 *
 * @param {any} store
 * @param {{ databasePath: string, keep?: number, now?: number }} input
 * @returns {{ ok: boolean, file?: string, pruned?: number, error?: string }}
 */
export function runBackup(store, input) {
  const now = Number(input.now) || Date.now()
  const folder = backupFolder(input.databasePath)
  const keep = Math.max(1, Number(input.keep) || 7)
  try {
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    const bundle = store.exportBundle()
    const archive = writeZip([
      { name: 'manifest.json', data: JSON.stringify({ format: 'dsh-memory-bundle', version: 1, exportedAt: bundle.exportedAt, counts: { entities: bundle.entities.length, records: bundle.records.length } }, null, 2) },
      { name: 'memory.json', data: JSON.stringify(bundle) },
    ])
    const file = path.join(folder, `dsh-memory-${stamp(now)}.zip`)
    writeFileSync(file, archive)

    const files = readdirSync(folder)
      .filter(name => name.startsWith('dsh-memory-') && name.endsWith('.zip'))
      .sort()
    const surplus = files.slice(0, Math.max(0, files.length - keep))
    for (const name of surplus) rmSync(path.join(folder, name), { force: true })
    try {
      store.setMeta('backup.last', JSON.stringify({ at: now, file, bytes: archive.length, pruned: surplus.length }))
    } catch {
      // Observability only.
    }
    return { ok: true, file, pruned: surplus.length }
  } catch (error) {
    try {
      store.setMeta('backup.last', JSON.stringify({ at: now, error: String(error?.message ?? error) }))
    } catch {
      // Observability only.
    }
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** The last backup, for the panel. */
export function backupStatus(store, databasePath) {
  let last = null
  try {
    const raw = store.getMeta('backup.last')
    if (typeof raw === 'string' && raw !== '') last = JSON.parse(raw)
  } catch {
    last = null
  }
  const folder = backupFolder(databasePath)
  let count = 0
  try {
    count = readdirSync(folder).filter(name => name.endsWith('.zip')).length
  } catch {
    count = 0
  }
  return { folder, last, count }
}

/** True when today's backup has not been written yet. */
export function needsBackup(store, now = Date.now()) {
  try {
    const raw = store.getMeta('backup.last')
    if (typeof raw !== 'string' || raw === '') return true
    const last = JSON.parse(raw)
    return last?.at === undefined || stamp(last.at) !== stamp(now)
  } catch {
    return true
  }
}
