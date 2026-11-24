/**
 * Minimal ZIP (store + deflate), writer and reader, with no dependencies.
 *
 * The plugin needs exactly one thing: bundle a JSON payload as a `.zip` that any
 * archiver can open, and read such a bundle back. That means local file headers,
 * a central directory, and CRC-32 — not the whole format.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** CRC-32 (the polynomial ZIP uses), table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = buffer => {
  let crc = 0xFFFFFFFF
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const DOS_TIME = 0
const DOS_DATE = 0x21 // 1980-01-01, the only date ZIP writers are allowed to fake
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * Build a ZIP archive from named entries.
 * @param {Array<{ name: string, data: Buffer | string }>} entries
 * @param {{ compress?: boolean }} [options]
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const compress = options.compress !== false
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const deflated = compress ? deflateRawSync(raw) : raw
    const useDeflate = compress && deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuffer, end])
}

/**
 * Read a ZIP archive written above (store or deflate entries).
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]))
  if (endOffset < 0) throw new Error('not a zip archive')
  const count = buffer.readUInt16LE(endOffset + 10)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  const files = new Map()
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014B50) throw new Error('broken central directory')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const body = buffer.subarray(dataStart, dataStart + compressedSize)
    files.set(name, method === METHOD_DEFLATE ? inflateRawSync(body) : Buffer.from(body))

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}
