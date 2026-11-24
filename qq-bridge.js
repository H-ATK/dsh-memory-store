/**
 * QQ bridge over UI Automation.
 *
 * QQ has no usable protocol endpoint any more (NapCat and SnowLuma were both taken
 * down in November 2026), so this drives the real client: it reads the open chat
 * through UIA and writes replies by clipboard + the send button. It only ever acts
 * on a window it can see.
 *
 * Everything PowerShell is async and short-lived; nothing is kept in memory between
 * polls except the fingerprints used to spot new messages.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribeVoice, newestVoiceFile, newestImageFile } from './qq-voice.js'

/** The reader marks a text-less media bubble with this. */
const MEDIA_MARKER = '[附件]'
const VOICE_MARKER = '[语音]'
/** A narrow text-less bubble: ignore it rather than treating it as media. */
const EMPTY_MARKER = '[空消息]'

/** How often the open chat is polled. */
const POLL_MS = 3000

const state = {
  active: false,
  timer: null,
  busy: false,
  /** Fingerprint of the last message already handled: the read cursor. */
  cursor: '',
  /** Message count seen last time, so repeating the same text still counts. */
  lastCount: 0,
  deliver: null,
  /** Optional control-command handler; returning a string answers it directly. */
  handleCommand: null,
  /** Tells whether the answering model can see images at all. */
  isLocalModel: null,
  startedAt: 0,
  lastRead: 0,
  lastError: null,
  lastDelivered: '',
  delivering: false,
  replyUntil: 0,
  uin: '',
  nickname: '',
  /** The chat title this bridge follows; anything else is ignored, never answered. */
  contact: '',
  onContact: null,
  lastFocusAt: 0,
  /** mtime of the newest voice file already handled. */
  lastVoiceAt: 0,
  /** mtime of the newest image file already handled. */
  lastImageAt: 0,
}

/** Re-locating is disruptive: only do it when reading fails, and then rarely. */
const FOCUS_EVERY_MS = 120_000

function scriptsDir() {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts')
  } catch {
    return path.join(process.cwd(), 'scripts')
  }
}

/**
 * Run one PowerShell helper and parse the JSON line it prints.
 * @param {string} script
 * @param {string[]} args
 * @returns {Promise<any | null>}
 */
function runScript(script, args = []) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(scriptsDir(), script),
        ...args,
      ], { windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      resolve(null)
    }, 25_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).map(text => text.trim()).filter(text => text.startsWith('{')).pop()
      if (line === undefined) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve(null)
      }
    })
  })
}

function fingerprint(message) {
  return `${message.time}|${message.who}|${message.text}`
}

/**
 * QQ install locations differ per machine and per installer version. Try the
 * environment override, then the live process path, then the common install roots.
 */
function resolveQqExe() {
  const override = String(process.env.QQ_EXE ?? '').trim()
  if (override !== '') return override
  const candidates = [
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    path.join(homedir(), 'AppData', 'Local', 'Tencent', 'QQNT', 'QQ.exe'),
    path.join(homedir(), 'AppData', 'Roaming', 'Tencent', 'QQNT', 'QQ.exe'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Keep looking.
    }
  }
  return candidates[0]
}

const QQ_EXE = resolveQqExe()

/** Start the QQ client; it remembers the session and comes straight back. */
export function launchQq() {
  try {
    const child = spawn(QQ_EXE, ['--force-renderer-accessibility'], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch (error) {
    state.lastError = String(error?.message ?? error)
    return false
  }
}

/**
 * Make sure the QQ window is on screen. Minimised-to-tray windows stop repainting
 * their UI tree, so the reader goes blind until the window is restored.
 * @returns {Promise<{ wasHidden: boolean } | null>}
 */
async function ensureVisible() {
  const result = await runScript('qq-open.ps1')
  if (result?.ok !== true) return null
  const wasHidden = result.wasVisible === false || result.wasMinimised === true
  if (wasHidden) {
    // Give Chromium a moment to repaint the restored window before reading it.
    await new Promise(resolve => setTimeout(resolve, 600))
  }
  return { wasHidden }
}

/**
 * Open the conversation with the configured contact: nickname first, QQ number second.
 * Without this the reader only ever sees whatever chat the user left open.
 * @returns {Promise<boolean>}
 */
async function focusContact() {
  if (state.uin === '' && state.nickname === '') return false
  const args = []
  if (state.nickname !== '') args.push('-Nickname', state.nickname)
  if (state.uin !== '') args.push('-Uin', state.uin)
  const result = await runScript('qq-focus.ps1', args)
  state.lastFocusAt = Date.now()
  if (result?.ok === true) {
    state.lastError = null
    return true
  }
  state.lastError = result?.reason ?? 'focus failed'
  return false
}

async function poll(prime = false) {
  if (!state.active || state.busy) return
  state.busy = true
  let hideAfter = false
  try {
    // Read first. Restoring and re-locating on every poll stole focus from the user
    // and made the window appear to pop up on its own.
    let data = await runScript('qq-read.ps1')
    if (data === null || data.ok !== true) {
      // Restoring is cheap and must be retried every poll: a window that went to the
      // tray has to come back the moment a message arrives.
      const restored = await ensureVisible()
      if (restored !== null) {
        if (prime || Date.now() - state.lastFocusAt > FOCUS_EVERY_MS) {
          await focusContact()
        }
        data = await runScript('qq-read.ps1')
        // Hidden again only AFTER any reply is sent: sending needs a visible window.
        hideAfter = restored.wasHidden
      }
    }
    if (data === null || data.ok !== true) {
      state.lastError = data?.error ?? 'read failed'
      return
    }
    state.lastError = null
    state.lastRead = Date.now()

    // Which chat is open right now? Switching QQ's sidebar changes what the reader
    // sees, and without this check those messages from other people were treated as
    // new input: the model reasoned about them and replied into a stranger's window.
    const contact = String(data.contact ?? '').trim()
    if (contact !== '') {
      if (state.contact === '') {
        state.contact = contact
        state.onContact?.(contact)
        console.log('[dsh-memory] qq contact learned:', JSON.stringify(contact))
      } else if (contact !== state.contact) {
        state.lastError = `another chat is open: ${contact}`
        // Leave the cursor alone: switching back must resume where it left off.
        return
      }
    }

    const messages = Array.isArray(data.messages) ? data.messages : []
    const total = Number(data.count ?? messages.length)
    if (messages.length === 0) return
    const last = messages[messages.length - 1]
    const lastKey = fingerprint(last)

    if (prime) {
      // Anchoring on the newest message swallows anything the user sent that we never
      // answered — including a message sent just before a restart. Anchor on the last
      // reply we wrote instead, so unanswered messages above it are picked up once.
      let anchor = messages.length - 1
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].who === 'self') {
          anchor = index
          break
        }
      }
      state.cursor = fingerprint(messages[anchor])
      state.lastCount = total
      const pending = messages.slice(anchor + 1).filter(message => message.who === 'other')
      if (pending.length > 0) {
        console.log(`[dsh-memory] qq prime: ${pending.length} unanswered message(s) pending`)
      }
      return
    }

    // Everything after the cursor is new. If the cursor scrolled out of view, only
    // the last line is trusted; if the count grew but the text repeats, the user
    // typed the same thing again and it still counts once.
    let start = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (fingerprint(messages[index]) === state.cursor) {
        start = index
        break
      }
    }
    let fresh = start >= 0 ? messages.slice(start + 1) : [last]
    if (fresh.length === 0 && total > state.lastCount) fresh = [last]
    state.cursor = lastKey
    state.lastCount = total

    for (const message of fresh) {
      if (message.who !== 'other') continue
      let text = String(message.text ?? '').trim()
      if (text === '') continue
      // A narrow empty bubble is noise, not media.
      if (text === EMPTY_MARKER) continue
      // A voice bubble shows its length and a "转文字" link (e.g. "2″转文字").
      const looksVoice = text === VOICE_MARKER || /转文字$/u.test(text)
      const isMedia = text === MEDIA_MARKER
      if (looksVoice) {
        // Explicitly a voice bubble: decoding may play it to force the download.
        const voice = await transcribeVoice(state.uin, state.lastVoiceAt)
        state.lastVoiceAt = voice.mtime
        if (voice.text !== '') {
          text = voice.text
          console.log('[dsh-memory] qq voice ->', JSON.stringify(text.slice(0, 60)))
        } else {
          console.log('[dsh-memory] qq voice failed:', voice.error ?? 'empty')
          text = `[语音消息，没能识别${voice.error ? '：' + voice.error : ''}]`
        }
      } else if (isMedia) {
        // A bare box: never play it. Double-clicking an image opens the picture viewer
        // full screen, which is worse than not answering. Read the cache only.
        const voice = newestVoiceFile(state.uin, state.lastVoiceAt)
        const image = newestImageFile(state.uin, state.lastImageAt)
        const imageWins = image !== null && (voice === null || image.mtime > voice.mtime)
        if (imageWins) {
          state.lastImageAt = image.mtime
          // A text-only local model cannot read the picture; say so instead of handing
          // it something it will silently ignore.
          if (state.isLocalModel?.() === true) {
            console.log('[dsh-memory] qq image skipped: local model')
            await sendQq('我这边用的是本地模型，看不了图片。切到付费模式再发一次就能看了。')
            state.delivering = false
            continue
          }
          text = `用户发来一张图片，文件路径：${image.path}\n请先用 read_image 工具读取这张图片，再根据图片内容回答用户。`
          console.log('[dsh-memory] qq image ->', image.path)
        } else if (voice !== null) {
          const decoded = await transcribeVoice(state.uin, state.lastVoiceAt)
          state.lastVoiceAt = decoded.mtime
          text = decoded.text !== ''
            ? decoded.text
            : `[语音消息，没能识别${decoded.error ? '：' + decoded.error : ''}]`
          if (decoded.text !== '') console.log('[dsh-memory] qq voice ->', JSON.stringify(text.slice(0, 60)))
        } else {
          console.log('[dsh-memory] media bubble with no cache file')
          text = '[收到一个附件，但缓存里没找到对应文件]'
        }
      }
      if (state.delivering) continue
      state.delivering = true
      state.lastDelivered = text
      console.log('[dsh-memory] qq message:', JSON.stringify(text))
      try {
        // Short messages may be control commands ("状态", "本地模型"); answer those
        // here so they never cost a model call.
        const reply = await state.handleCommand?.(text)
        if (typeof reply === 'string' && reply !== '') {
          console.log('[dsh-memory] qq command reply:', JSON.stringify(reply.slice(0, 60)))
          await sendQq(reply)
          state.delivering = false
          continue
        }
        armReplyWindow()
        await state.deliver?.(text)
      } catch (error) {
        state.lastError = String(error?.message ?? error)
      } finally {
        state.delivering = false
      }
    }
    // Only now may the window go back to the tray: replies above needed it visible.
    return
  } finally {
    if (hideAfter) {
      await runScript('qq-hide.ps1')
    }
    state.busy = false
  }
}

/**
 * @param {{
 *   deliver: (text: string) => Promise<unknown>,
 *   handleCommand?: (text: string) => Promise<string | null>,
 *   uin?: string,
 *   nickname?: string,
 * }} input
 */
export function startQqBridge(input) {
  stopQqBridge()
  state.active = true
  state.deliver = input.deliver
  state.handleCommand = input.handleCommand ?? null
  state.isLocalModel = input.isLocalModel ?? null
  console.log('[dsh-memory] qq bridge handleCommand:', typeof state.handleCommand)
  state.uin = String(input.uin ?? '').trim()
  state.nickname = String(input.nickname ?? '').trim()
  // Remember which chat is "ours": a known title is enforced from the first poll, an
  // empty one gets learned from whatever is open, then locked.
  state.contact = String(input.contact ?? '').trim()
  state.onContact = typeof input.onContact === 'function' ? input.onContact : null
  state.cursor = ''
  state.lastCount = 0
  // Only media that arrives from now on counts; without this, the first media bubble
  // after a restart would pick up whatever file was already lying in the cache.
  state.lastVoiceAt = Date.now() - 60000
  state.lastImageAt = Date.now() - 60000
  state.startedAt = Date.now()
  state.lastRead = 0
  state.lastFocusAt = 0
  state.lastError = null
  // Prime first: existing history must not be mistaken for new messages.
  void poll(true)
  state.timer = setInterval(() => { void poll(false) }, POLL_MS)
  state.timer.unref?.()
  return true
}

export function stopQqBridge() {
  state.active = false
  if (state.timer !== null) {
    clearInterval(state.timer)
    state.timer = null
  }
  state.deliver = null
}

/** Send one text message through the open chat. */
export async function sendQq(text) {
  const body = String(text ?? '').trim()
  if (body === '') return { ok: false, error: 'empty' }
  const segments = body.length > 1800 ? splitText(body, 1800) : [body]
  let ok = true
  for (const segment of segments) {
    const result = await runScript('qq-send.ps1', ['-Text', segment])
    if (result?.ok !== true) ok = false
  }
  return { ok }
}

function splitText(text, size) {
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

/** Bridge state for the panel and diagnostics. */
export function qqStatus() {
  return {
    active: state.active,
    since: state.startedAt,
    lastRead: state.lastRead,
    lastError: state.lastError,
    online: state.lastRead > 0 && Date.now() - state.lastRead < POLL_MS * 3,
  }
}

/** True while a QQ message is out for an answer; the reply hook uses this window. */
export function qqWaitingReply() {
  return Date.now() < state.replyUntil
}

/** The assistant's reply may take a while; keep the window open for it. */
export function armReplyWindow(ms = 180_000) {
  state.replyUntil = Date.now() + Math.max(1000, ms)
}

/** The reply was delivered, nothing else belongs to this question. */
export function disarmReplyWindow() {
  state.replyUntil = 0
}
