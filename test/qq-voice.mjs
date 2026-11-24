/**
 * Smoke test: find a cached QQ voice file, decode it, and recognise it.
 */
import { newestVoiceFile, transcribeVoice } from '../qq-voice.js'

const uin = '10000000'

const file = newestVoiceFile(uin, 0)
console.log('newest voice file:', file === null ? 'none' : `${file.path} (${new Date(file.mtime).toLocaleString()})`)

const started = Date.now()
const result = await transcribeVoice(uin, 0)
console.log('elapsed:', Date.now() - started, 'ms')
console.log('text:', JSON.stringify(result.text))
console.log('error:', result.error ?? 'none')
