/**
 * QQ voice messages arrive as AMR files in the client's own cache. There is no API to
 * fetch them, so the reader marks a voice bubble and this module picks up the newest
 * AMR file written since the last one we handled, then asks the local ASR to read it.
 */
import { execFile } from 'node:child_process'
import { readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { promisify } from 'node:util'
import { transcribeWav } from './stt.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

/**
 * pysilk lives in whatever Python the harness bundles. Nothing about that path is
 * guaranteed, so resolve it: explicit override, then the bundled runtime, then PATH.
 */
function resolvePython() {
  const override = String(process.env.DSH_PYTHON ?? '').trim()
  if (override !== '') return override
  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const entry of readdirSync(runtimes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(runtimes, entry.name, 'dependencies', 'python', 'python.exe')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // No bundled runtime: fall back to PATH.
  }
  return 'python'
}

const PYTHON = resolvePython()
const SILK_DECODER = join(here, 'scripts', 'silk-decode.py')

/** Where QQ keeps decoded voice for one account. */
export function voiceRoot(uin) {
  return join(homedir(), 'Documents', 'Tencent Files', String(uin), 'nt_qq', 'nt_data', 'Ptt')
}

/** Where QQ keeps received images for one account. */
export function imageRoot(uin) {
  return join(homedir(), 'Documents', 'Tencent Files', String(uin), 'nt_qq', 'nt_data', 'Pic')
}

/**
 * Newest received image written after `sinceMs`. QQ stores two sizes per picture
 * (`_0` original, `_720` preview); the preview is enough to look at.
 * @returns {{ path: string, mtime: number } | null}
 */
export function newestImageFile(uin, sinceMs = 0) {
  const root = imageRoot(uin)
  if (!existsSync(root)) return null
  const files = []
  walkImages(root, files)
  const fresh = files
    .filter(file => file.mtime > sinceMs)
    .sort((a, b) => b.mtime - a.mtime)
  return fresh[0] ?? null
}

function walkImages(dir, out, depth = 0) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkImages(full, out, depth + 1)
    } else if (/\.(jpe?g|png|gif|webp|bmp)$/i.test(entry.name)) {
      try {
        out.push({ path: full, mtime: statSync(full).mtimeMs })
      } catch {
        // A file removed mid-scan is not interesting.
      }
    }
  }
}

function walk(dir, out, depth = 0) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out, depth + 1)
    } else if (/\.(amr|silk|slk|wav|mp3)$/i.test(entry.name)) {
      try {
        out.push({ path: full, mtime: statSync(full).mtimeMs })
      } catch {
        // A file removed mid-scan is not interesting.
      }
    }
  }
}

/**
 * Newest voice file written after `sinceMs`.
 * @returns {{ path: string, mtime: number } | null}
 */
export function newestVoiceFile(uin, sinceMs = 0) {
  const root = voiceRoot(uin)
  if (!existsSync(root)) return null
  const files = []
  walk(root, files)
  const fresh = files.filter(file => file.mtime > sinceMs).sort((a, b) => b.mtime - a.mtime)
  return fresh[0] ?? null
}

async function toWav(source, target) {
  // QQ voice files are SILK v3 behind an .amr extension; ffmpeg cannot decode them.
  // scripts/silk-decode.py uses the pysilk binding instead.
  await run(PYTHON, [SILK_DECODER, source, target], { windowsHide: true, timeout: 60000 })
}

/**
 * Decode and recognise one voice file. If the clip is not cached yet, ask QQ to play
 * it (that is what downloads it) and wait for the file to land.
 * @returns {Promise<{ text: string, mtime: number, error?: string }>}
 */
export async function transcribeVoice(uin, sinceMs = 0) {
  let found = newestVoiceFile(uin, sinceMs)
  if (found === null) {
    try {
      await run('powershell', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', join(here, 'scripts', 'qq-play-voice.ps1'),
      ], { windowsHide: true, timeout: 30000 })
    } catch {
      // Playback is best effort; the file may still land.
    }
    // The download starts on play and takes a moment to appear on disk.
    for (let attempt = 0; attempt < 12 && found === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      found = newestVoiceFile(uin, sinceMs)
    }
  }
  if (found === null) return { text: '', mtime: sinceMs, error: 'no voice file' }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-voice-'))
  const wav = join(dir, 'voice.wav')
  try {
    await toWav(found.path, wav)
    const text = String(await transcribeWav(wav)).trim()
    return { text, mtime: found.mtime }
  } catch (error) {
    return { text: '', mtime: found.mtime, error: String(error?.message ?? error) }
  }
}
