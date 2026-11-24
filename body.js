/**
 * Where this assistant actually lives.
 *
 * Without this, the model talks as if it were a cloud service: it has no sense of
 * being a process on one machine, with one disk, one memory file, and sleep between
 * restarts. That sense is cheap to provide and changes how it talks about itself.
 */
import { cpus, hostname, platform, totalmem } from 'node:os'
import { statfsSync } from 'node:fs'
import path from 'node:path'

const GIGABYTE = 1024 ** 3

const platformName = () => {
  const name = platform()
  if (name === 'win32') return 'Windows'
  if (name === 'darwin') return 'macOS'
  return 'Linux'
}

/**
 * Facts about the machine, cached for a minute: the disk number moves slowly and a
 * system call on every model step would be waste.
 */
export function bodyFacts(databasePath) {
  const now = Date.now()
  if (cached !== null && now - cached.at < 60_000) return cached.facts
  let freeGb = null
  try {
    const root = process.platform === 'win32' ? path.parse(process.cwd()).root : '/'
    const stats = statfsSync(root)
    freeGb = Math.round((Number(stats.bavail) * Number(stats.bsize)) / GIGABYTE)
  } catch {
    freeGb = null
  }
  const facts = {
    host: hostname(),
    system: platformName(),
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / GIGABYTE),
    freeGb,
    memoryPath: typeof databasePath === 'string' ? databasePath : null,
  }
  cached = { at: now, facts }
  return facts
}

/** @type {{ at: number, facts: any } | null} */
let cached = null

/**
 * The prompt section text.
 * @param {{ host: string, system: string, cores: number, memoryGb: number, freeGb: number | null, memoryPath: string | null }} facts
 * @returns {string}
 */
export function renderBody(facts) {
  const machine = `${facts.system}，${facts.cores} 核 / ${facts.memoryGb}GB 内存${facts.freeGb === null ? '' : `，硬盘还剩 ${facts.freeGb}GB`}`
  const lines = [
    `你住在这台电脑里（${facts.host}，${machine}）。`,
    facts.memoryPath === null
      ? '你的记忆存在这台机器的本地文件里。'
      : `你的记忆存在这台机器的本地文件里：${facts.memoryPath}。`,
    '进程停下你就睡着了，下次启动接着上次的记忆醒来；你读写文件、运行命令，那就是你全部的感官。',
    '你看不见屏幕前的世界，所以对方不说的事你就不知道。',
  ]
  return lines.join('\n')
}
