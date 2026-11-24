/**
 * Observation: things the machine notices without being asked.
 *
 * Right now it watches the download folder. A new file is a real event worth one
 * short line, and noticing it locally costs nothing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'

/** Snapshot key in store_meta. */
const SNAPSHOT = 'observe.downloads'

/**
 * @param {string} folder
 * @returns {string[]} file names, newest first
 */
export function listDownloads(folder) {
  if (!existsSync(folder)) return []
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Compare the folder with the last snapshot and return a line when something new
 * arrived. The first run only records a baseline, so a fresh install does not
 * announce the entire folder.
 *
 * @param {any} store
 * @param {{ folder: (() => string), now?: () => number }} io
 * @returns {string | null}
 */
export function checkDownloads(store, io) {
  const folder = io.folder()
  const files = listDownloads(folder)
  let previous = null
  try {
    const raw = store.getMeta(SNAPSHOT)
    if (typeof raw === 'string' && raw !== '') previous = JSON.parse(raw)
  } catch {
    previous = null
  }
  try {
    store.setMeta(SNAPSHOT, JSON.stringify({ at: (io.now ?? Date.now)(), files }))
  } catch {
    // Observation must never break a turn.
  }
  if (previous === null || !Array.isArray(previous.files)) return null
  const before = new Set(previous.files)
  const added = files.filter(name => !before.has(name))
  if (added.length === 0) return null
  const sample = added.slice(0, 2).join('、')
  return added.length === 1
    ? `下载目录刚多了 1 个文件：${sample}`
    : `下载目录刚多了 ${added.length} 个文件：${sample} 等`
}

/**
 * Keep the pending observation in meta so the next turn can mention it once.
 * @param {any} store
 * @param {string | null} note
 */
export function rememberObservation(store, note) {
  try {
    store.setMeta('observe.pending', note === null ? '' : note)
    return true
  } catch {
    return false
  }
}

/** Read and clear the pending note. */
export function takeObservation(store) {
  try {
    const raw = store.getMeta('observe.pending')
    if (typeof raw !== 'string' || raw === '') return null
    store.setMeta('observe.pending', '')
    return raw
  } catch {
    return null
  }
}
