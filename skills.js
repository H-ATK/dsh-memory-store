/**
 * Local skills: the things it can do without asking a model anything.
 *
 * Every entry is a rule plus an action. The rule is matched against the message;
 * the action runs on this machine and returns one line of result. No tokens.
 *
 * Danger level decides whether the action may run at all:
 * - 'safe'  read-only or additive (list, search, info)
 * - 'ask'   changes files (整理/归档) — runs, but says what it touched
 * - 'deny'  never (delete, format, shutdown) — refused with a reason
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { homedir, totalmem, cpus } from 'node:os'
import { spawn } from 'node:child_process'

/** Folders whose contents belong to a file type. */
const KIND_FOLDERS = {
  image: '图片',
  video: '视频',
  audio: '音频',
  doc: '文档',
  compressed: '压缩包',
  code: '代码',
  other: '其他',
}

const KIND_EXT = {
  图片: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic'],
  视频: ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'],
  音频: ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'],
  文档: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.epub'],
  压缩包: ['.zip', '.rar', '.7z', '.tar', '.gz', '.xz'],
  代码: ['.js', '.ts', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.json', '.yml', '.yaml', '.html', '.css', '.sh', '.ps1'],
}

/** Where "下载" usually lives on this machine. */
export function downloadsFolder() {
  const home = homedir()
  const candidate = path.join(home, 'Downloads')
  return existsSync(candidate) ? candidate : home
}

/**
 * @typedef {object} SkillMatch
 * @property {string} name
 * @property {'safe'|'ask'|'deny'} level
 * @property {(input: { text: string, list?: string[] }) => string | Promise<string>} run
 */

/**
 * Match one message against the skill table.
 * @param {string} text
 * @returns {{ skill: string, level: string, argument?: string } | null}
 */
export function matchSkill(text) {
  const body = String(text ?? '')
  if (/整理|归档|分类/.test(body) && /下载|桌面|文件夹/.test(body)) return { skill: 'tidy', level: 'ask' }
  if (/(找|搜)(一下)?文件|有没有.*文件|搜.*文件/.test(body)) {
    const name = body.replace(/^(帮我)?(找|搜)(一下)?(文件)?/, '').replace(/[。！？\s]/g, '').slice(0, 40)
    return { skill: 'find', level: 'safe', argument: name }
  }
  if (/磁盘|硬盘|剩多少|空间/.test(body) && !/云盘/.test(body)) return { skill: 'disk', level: 'safe' }
  if (/系统|配置|内存|多少核|什么配置/.test(body) && !/系统提示/.test(body)) return { skill: 'system', level: 'safe' }
  if (/(删除|清空|格式化|关机|重启电脑)/.test(body)) return { skill: 'danger', level: 'deny' }
  if (/截图|截个屏|截屏|抓个屏/.test(body)) return { skill: 'screenshot', level: 'safe' }
  if (/音量/.test(body) || /^(静音|开静音)/.test(body)) {
    if (/静音|关声音/.test(body)) return { skill: 'volume', level: 'safe', argument: 'mute' }
    if (/(大|加|高)/.test(body)) return { skill: 'volume', level: 'safe', argument: 'up' }
    return { skill: 'volume', level: 'safe', argument: 'down' }
  }
  if (/剪贴板/.test(body)) {
    const write = body.match(/(?:复制|写入|放到剪贴板)(?:到剪贴板)?[:：]?\s*(.+)$/)
    return write === null
      ? { skill: 'clipboard', level: 'safe' }
      : { skill: 'clipboard', level: 'safe', argument: write[1].trim() }
  }
  if (/(暂停|继续播放|播放|下一首|上一首|切歌)/.test(body)) {
    if (/下一首|切歌/.test(body)) return { skill: 'media', level: 'safe', argument: 'next' }
    if (/上一首/.test(body)) return { skill: 'media', level: 'safe', argument: 'previous' }
    return { skill: 'media', level: 'safe', argument: 'playpause' }
  }
  if (/最小化|回到桌面|显示桌面/.test(body)) return { skill: 'desktop', level: 'safe' }
  if (/^打开|帮我打开|打开一下/.test(body)) {
    return { skill: 'open', level: 'ask', argument: body.replace(/^.*?打开(一下)?/, '').trim() }
  }
  return null
}

/**
 * Run a PowerShell script and return its stdout.
 * `-EncodedCommand` takes UTF-16LE base64, so Chinese text and quotes need no escaping.
 *
 * @param {string} script
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function runPowerShell(script, timeoutMs = 20_000) {
  // UTF-8 on the way out, otherwise Chinese comes back as question marks.
  const wrapped = '[Console]::OutputEncoding = [Text.Encoding]::UTF8' + String.fromCharCode(10) + String(script)
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return new Promise(resolve => {
    let output = ''
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    child.on('error', () => done(''))
    child.on('exit', () => done(output.trim()))
    child.on?.('data', chunk => { output += String(chunk) })
    if (typeof child.stdout?.on === 'function') {
      child.stdout.on('data', chunk => { output += String(chunk) })
    }
    if (typeof child.stderr?.on === 'function') {
      child.stderr.on('data', () => {})
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      done(output.trim())
    }, timeoutMs).unref?.()
  })
}

/** Key codes for the media and volume keys Windows understands. */
const VK = { volumeUp: 175, volumeDown: 174, mute: 173, playPause: 179, next: 176, previous: 177 }

/**
 * Press one media key.
 * @param {number} code
 */
export async function pressKey(code) {
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DshKey { [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }',
    '"@',
    `[DshKey]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero)`,
    `[DshKey]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero)`,
  ].join(String.fromCharCode(10))
  await runPowerShell(script)
  return true
}

/** Take a screenshot into Pictures\\Screenshots and return its path. */
export async function takeScreenshot() {
  const script = [
    'Add-Type -AssemblyName System.Drawing, System.Windows.Forms',
    "$dir = Join-Path (Join-Path $env:USERPROFILE 'Pictures') 'Screenshots'",
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    "$f = Join-Path $dir ('shot-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png')",
    '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)',
    '$bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose(); $bmp.Dispose()',
    'Write-Output $f',
  ].join(String.fromCharCode(10))
  const file = await runPowerShell(script, 30_000)
  return file === '' ? null : file
}

/** Read the clipboard as text. */
export async function readClipboard() {
  const text = await runPowerShell('Get-Clipboard -Raw', 10_000)
  return text
}

/**
 * Put text on the clipboard.
 * @param {string} text
 */
export async function writeClipboard(text) {
  const encoded = Buffer.from(String(text), 'utf16le').toString('base64')
  const script = [
    `$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))`,
    'Set-Clipboard -Value $text',
  ].join(String.fromCharCode(10))
  await runPowerShell(script, 10_000)
  return true
}

/**
 * Open a URL, folder, or program through the OS shell.
 *
 * `spawn` with `stdio: 'ignore'` and `detached` is deliberate: this process must not
 * hold the child's pipes open, and the child must outlive the turn.
 *
 * @param {string} target
 * @returns {string}
 */
export function openTarget(target) {
  const wanted = String(target ?? '').trim()
  if (wanted === '') return '要打开什么？'
  const aliases = {
    浏览器: 'https://www.bing.com',
    记事本: 'notepad',
    计算器: 'calc',
    资源管理器: 'explorer',
    设置: 'ms-settings:',
  }
  const command = aliases[wanted] ?? wanted
  try {
    spawn('cmd', ['/c', 'start', '', command], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return `已经打开「${wanted}」。`
  } catch (error) {
    return `打不开「${wanted}」：${error?.message ?? error}`
  }
}

/** Read-only machine facts. */
export function diskInfo() {
  let free = '未知'
  try {
    const stats = statfsSyncSafe()
    free = `${Math.round(stats.freeGb)} GB`
  } catch {
    free = '读取失败'
  }
  return `磁盘剩余 ${free}。`
}

function statfsSyncSafe() {
  // Kept behind a helper so a platform without statfs degrades to "unknown".
  const root = process.platform === 'win32' ? path.parse(process.cwd()).root : '/'
  const stats = statfsSync(root)
  return { freeGb: (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3 }
}

/** Machine facts in one line. */
export function systemInfo() {
  return `这台电脑是 ${process.platform === 'win32' ? 'Windows' : process.platform}，${cpus().length} 核，${Math.round(totalmem() / 1024 ** 3)} GB 内存。`
}

/**
 * Move loose files in the download folder into type folders.
 * @param {string} [folder]
 * @returns {string}
 */
export function tidyDownloads(folder = downloadsFolder()) {
  if (!existsSync(folder)) return '没找到下载文件夹。'
  const entries = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile())
  if (entries.length === 0) return '下载文件夹是空的，不用整理。'
  let moved = 0
  for (const entry of entries) {
    const ext = path.extname(entry.name).toLowerCase()
    const target = Object.entries(KIND_EXT).find(([, list]) => list.includes(ext))?.[0] ?? KIND_FOLDERS.other
    const directory = path.join(folder, target)
    try {
      if (!existsSync(directory)) mkdirSync(directory)
      renameSync(path.join(folder, entry.name), path.join(directory, entry.name))
      moved += 1
    } catch {
      // A file in use stays where it is; the count reflects what moved.
    }
  }
  return `整理了 ${moved} 个文件到分类文件夹（图片/文档/视频/音频/压缩包/代码）。`
}

/**
 * Find files by name under the download folder.
 * @param {string} name
 * @param {string} [folder]
 */
export function findFiles(name, folder = downloadsFolder()) {
  const needle = String(name ?? '').trim().toLowerCase()
  if (needle === '') return '要找什么？'
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || found.length >= 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 8) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.toLowerCase().includes(needle)) found.push(full)
    }
  }
  walk(folder, 0)
  if (found.length === 0) return `「${name}」没找到。`
  return `找到 ${found.length} 个：\n${found.map(file => `· ${file}`).join('\n')}`
}

/** Run one skill and return its line. */
export async function runSkill(match) {
  if (match.skill === 'danger') return '这个操作我不会自己做。真要做，请自己执行或明确告诉我在哪个目录下做什么。'
  if (match.skill === 'screenshot') {
    const file = await takeScreenshot()
    return file === null ? '截图没成功。' : `截图存好了：${file}`
  }
  if (match.skill === 'volume') {
    const map = { up: VK.volumeUp, down: VK.volumeDown, mute: VK.mute }
    await pressKey(map[match.argument] ?? VK.volumeDown)
    const word = match.argument === 'mute' ? '静音切换' : match.argument === 'up' ? '调大一点' : '调小一点'
    return `音量${word}了。`
  }
  if (match.skill === 'clipboard') {
    if (typeof match.argument === 'string' && match.argument !== '') {
      await writeClipboard(match.argument)
      return `已经复制到剪贴板：${match.argument.slice(0, 40)}`
    }
    const text = await readClipboard()
    if (text === '') return '剪贴板是空的。'
    return `剪贴板里是：${text.slice(0, 300)}`
  }
  if (match.skill === 'media') {
    const map = { playpause: VK.playPause, next: VK.next, previous: VK.previous }
    await pressKey(map[match.argument] ?? VK.playPause)
    return '好。'
  }
  if (match.skill === 'desktop') {
    await pressKey(0x44) // Win+D
    return '窗口都收起来了。'
  }
  if (match.skill === 'open') return openTarget(match.argument ?? '')
  if (match.skill === 'tidy') return tidyDownloads()
  if (match.skill === 'find') return findFiles(match.argument ?? '')
  if (match.skill === 'disk') return diskInfo()
  if (match.skill === 'system') return systemInfo()
  return '这个我还不会。'
}
