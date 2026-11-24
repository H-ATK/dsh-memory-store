import { readZip, writeZip } from '../zip.js'

const entries = [
  { name: 'manifest.json', data: JSON.stringify({ format: 'test', version: 1 }) },
  { name: 'memory.json', data: JSON.stringify({ entities: [{ canonical: '测试对象' }] }) },
]
const archive = writeZip(entries)
const files = readZip(archive)
console.log('archive bytes:', archive.length)
console.log('entries:', [...files.keys()].join(', '))
console.log('manifest:', files.get('manifest.json').toString('utf8'))
console.log('memory:', files.get('memory.json').toString('utf8'))

// Uncompressed fallback must also read back.
const stored = writeZip(entries, { compress: false })
const storedFiles = readZip(stored)
console.log('store method roundtrip:', storedFiles.get('memory.json').toString('utf8'))

// Real zip tools check: PK signature at the start.
console.log('signature ok:', archive.readUInt32LE(0) === 0x04034B50)
