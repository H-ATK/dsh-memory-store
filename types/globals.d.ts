/**
 * The Host runs on Node with a few web-standard globals. These declarations keep
 * `tsc` focused on the plugin's own type drift instead of complaining that the
 * runtime exists. They describe only what this plugin touches.
 */
declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): { unref?: () => void }
declare function clearTimeout(handle: unknown): void
declare function setImmediate(handler: (...args: unknown[]) => void): unknown
declare function setInterval(handler: (...args: unknown[]) => void, timeout?: number): { unref?: () => void }
declare function clearInterval(handle: unknown): void
declare function queueMicrotask(handler: () => void): void

declare const process: {
  env: Record<string, string | undefined>
  hrtime: { bigint(): bigint }
  pid: number
  exitCode: number
  platform: string
  cwd(): string
}

declare class AbortSignal {
  static timeout(milliseconds: number): AbortSignal
}

declare function fetch(
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    cache?: string
  },
): Promise<{
  ok: boolean
  status: number
  json(): Promise<any>
}>

declare const Buffer: any

declare module 'node:fs' {
  const fs: any
  export default fs
  export function statfsSync(path: string): { bavail: number | bigint, bsize: number | bigint }
  export function mkdtempSync(prefix: string): string
  export function mkdirSync(...args: any[]): any
  export function readFileSync(...args: any[]): any
  export function copyFileSync(...args: any[]): any
  export function rmSync(...args: any[]): any
  export function existsSync(...args: any[]): boolean
  export function readdirSync(...args: any[]): any
  export function statSync(...args: any[]): any
  export function renameSync(...args: any[]): any
  export function writeFileSync(...args: any[]): any
  export function appendFileSync(...args: any[]): any
}
declare module 'node:path' {
  const path: any
  export default path
}
declare module 'node:sqlite' {
  export const DatabaseSync: any
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}
declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
  export function hostname(): string
  export function platform(): string
  export function cpus(): Array<{ model: string }>
  export function totalmem(): number
}
declare module 'node:zlib' {
  export function zstdDecompressSync(data: unknown): { toString(encoding: string): string }
  export function deflateRawSync(data: unknown): Buffer
  export function inflateRawSync(data: unknown): Buffer
}
declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Buffer): { digest(encoding: 'hex'): string }
  }
}

declare module 'node:child_process' {
  export function spawn(command: string, args: string[], options?: any): {
    unref(): void
    kill(): void
    on(event: string, listener: (value?: any) => void): void
    stdout?: { on(event: string, listener: (value?: any) => void): void }
    stderr?: { on(event: string, listener: (value?: any) => void): void }
  }
}

declare const URL: { new (value: string): { readonly pathname: string } }

interface ImportMeta {
  readonly url: string
}
