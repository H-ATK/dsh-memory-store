/**
 * Static checks the unit tests cannot give us without a compiler.
 *
 *   1. Module graph: every `import { … } from './x.js'` names a real export of x.
 *      This is the failure mode a split introduces — renaming an export breaks the
 *      importer only at runtime, where a plugin error is easy to miss.
 *   2. No duplicate top-level declarations in one file.
 *   3. Library layers (`store`, `retrieve`, `normalize`) never print to stdout;
 *      only the composition and maintenance layers may log.
 *   4. No leftover TODO/FIXME markers.
 *
 *   node test/lint.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MODULES = [
  'index.js', 'runtime.js', 'capture.js', 'inject.js', 'normalizer.js',
  'vectors.js', 'routes.js', 'repairs.js', 'search-tool.js', 'zip.js', 'style.js', 'personas.js', 'mood.js', 'proactive.js', 'body.js', 'models.js', 'intent.js', 'skills.js', 'observer.js', 'backup.js', 'narrative.js', 'voice.js', 'stt.js', 'store.js', 'retrieve.js',
  'normalize.js', 'tools.js', 'client.js', 'qq-bridge.js', 'qq-commands.js', 'qq-voice.js',
]
const SILENT = new Set(['store.js', 'retrieve.js', 'normalize.js'])

const failures = []
const fail = (file, message) => failures.push(`${file}: ${message}`)
const source = new Map(MODULES.map(file => [file, readFileSync(path.join(ROOT, file), 'utf8')]))

console.log('[1] 导出符号')
const exportsOf = new Map()
for (const file of MODULES) {
  const text = source.get(file)
  const names = new Set()
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)) {
    names.add(match[1])
  }
  for (const match of text.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()
      if (name !== '') names.add(name)
    }
  }
  exportsOf.set(file, names)
  console.log(`  ${file.padEnd(14)} ${names.size} 个导出`)
}

console.log('\n[2] 跨模块导入是否都有对应导出')
let importCount = 0
for (const file of MODULES) {
  const text = source.get(file)
  for (const match of text.matchAll(/^import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.-]+)'/gm)) {
    const target = match[2]
    const available = exportsOf.get(target)
    if (available === undefined) {
      fail(file, `导入自未知模块 ./${target}`)
      continue
    }
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name === '' || name === 'type') continue
      importCount += 1
      if (!available.has(name)) fail(file, `./${target} 没有导出 ${name}`)
    }
  }
  for (const match of text.matchAll(/^import\s+(\w+)\s+from\s*'\.\/([\w.-]+)'/gm)) {
    importCount += 1
    if (!exportsOf.get(match[2])?.has('default') && !source.get(match[2])?.includes('export default')) {
      fail(file, `./${match[2]} 没有默认导出（${match[1]}）`)
    }
  }
}
console.log(`  检查了 ${importCount} 个具名导入`)

console.log('\n[3] 单文件内重复声明')
for (const file of MODULES) {
  const text = source.get(file)
  const seen = new Map()
  for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm)) {
    const name = match[1]
    if (seen.has(name)) fail(file, `重复声明 ${name}（第 ${seen.get(name)} 行与第 ${match.index} 附近）`)
    else seen.set(name, text.slice(0, match.index).split('\n').length)
  }
}
console.log('  完成')

console.log('\n[4] 库层不得写 stdout')
for (const file of SILENT) {
  const text = source.get(file)
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (/^\s*console\.log\(/.test(line)) fail(file, `第 ${index + 1} 行有 console.log`)
  })
}
console.log(`  检查 ${[...SILENT].join(', ')}`)

console.log('\n[5] 无遗留标记')
for (const file of MODULES) {
  if (/\b(TODO|FIXME|XXX)\b/.test(source.get(file))) fail(file, '仍有 TODO/FIXME')
}
console.log('  完成')

if (failures.length === 0) {
  console.log('\nRESULT: all checks passed')
  process.exitCode = 0
} else {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  console.log(`\nRESULT: ${failures.length} failure(s)`)
  process.exitCode = 1
}
