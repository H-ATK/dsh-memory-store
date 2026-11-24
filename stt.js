/**
 * Speech input: record from the first capture device, decode with sherpa-onnx.
 *
 * SAPI's zh-CN dictation recognised nothing even with real audio in the WAV (peak
 * 4535), so capture is separate from recognition: winmm records, sherpa-onnx decodes
 * with the streaming zipformer model.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// Loaded lazily: the native addon keeps worker threads alive, which would stop a
// short-lived process (a test, a CLI) from exiting.
let OnlineRecognizerClass = null

/** Below this peak, the chunk is treated as silence and never decoded. */
const MIN_PEAK = 150

const CAPTURE_SOURCE = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public class DshMic {
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr hwi, int device, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, int flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr hwi, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr hwi, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr hwi);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr hwi);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr hwi);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr hwi);
  [StructLayout(LayoutKind.Sequential)]
  public struct WAVEFORMATEX { public short wFormatTag; public short nChannels; public int nSamplesPerSec; public int nAvgBytesPerSec; public short nBlockAlign; public short wBitsPerSample; public short cbSize; }
  public static string Record(int device, int seconds, int rate, string file) {
    var fmt = new WAVEFORMATEX();
    fmt.wFormatTag = 1; fmt.nChannels = 1; fmt.nSamplesPerSec = rate;
    fmt.wBitsPerSample = 16; fmt.nBlockAlign = 2; fmt.nAvgBytesPerSec = rate * 2;
    IntPtr hwi;
    if (waveInOpen(out hwi, device, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) return "OPEN_FAILED";
    int size = rate * 2 * seconds;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    IntPtr header = Marshal.AllocHGlobal(64);
    for (int i = 0; i < 64; i++) Marshal.WriteByte(header, i, 0);
    Marshal.WriteIntPtr(header, 0, buffer);
    Marshal.WriteInt32(header, 8, size);
    waveInPrepareHeader(hwi, header, 64);
    waveInAddBuffer(hwi, header, 64);
    waveInStart(hwi);
    Thread.Sleep(seconds * 1000);
    waveInStop(hwi);
    waveInReset(hwi);
    byte[] data = new byte[size];
    Marshal.Copy(buffer, data, 0, size);
    waveInClose(hwi);
    Marshal.FreeHGlobal(buffer);
    Marshal.FreeHGlobal(header);
    long peak = 0;
    for (int i = 0; i + 1 < data.Length; i += 2) { int s = Math.Abs((int)BitConverter.ToInt16(data, i)); if (s > peak) peak = s; }
    using (var fs = new FileStream(file, FileMode.Create)) {
      using (var w = new BinaryWriter(fs)) {
        w.Write(new byte[] { 82, 73, 70, 70 }); w.Write(36 + data.Length);
        w.Write(new byte[] { 87, 65, 86, 69, 102, 109, 116, 32 }); w.Write(16);
        w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate * 2);
        w.Write((short)2); w.Write((short)16);
        w.Write(new byte[] { 100, 97, 116, 97 }); w.Write(data.Length); w.Write(data);
      }
    }
    return "PEAK:" + peak;
  }
}
`

/** The model ships beside the plugin; without it, STT reports itself unavailable. */
export function modelDir() {
  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  })()
  const candidates = [
    path.join(here, 'models', 'zipformer-zh'),
    path.join(process.cwd(), 'models', 'zipformer-zh'),
    path.join(path.dirname(process.cwd()), 'dsh-memory', 'models', 'zipformer-zh'),
  ]
  for (const candidate of candidates) {
    try {
      readFileSync(path.join(candidate, 'tokens.txt'))
      return candidate
    } catch {
      // Try the next location.
    }
  }
  return candidates[0]
}

let cachedRecognizer = null
let cachedKey = ''
let cachedEngine = ''
let cachedOnline = null
let cachedOnlineKey = ''

/** Plugin directory: the models ship beside these sources. */
function hereDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** Where the original offline paraformer model lives, kept as the last resort. */
export function paraformerDir() {
  return path.join(hereDir(), 'models', 'paraformer-zh')
}

/** Both recognisers are loaded through the package's default export. */
async function loadSdk() {
  const module = await import('sherpa-onnx-node')
  return {
    Vad: module.default?.Vad,
    OnlineRecognizer: module.OnlineRecognizer ?? module.default?.OnlineRecognizer,
    OfflineRecognizer: module.default?.OfflineRecognizer,
    KeywordSpotter: module.default?.KeywordSpotter,
    readWave: module.default?.readWave,
  }
}

/**
 * Offline engines in preference order.
 *
 * Every one of them is a real option on this machine; the first whose files are
 * present wins, and the small paraformer stays installed as the floor. SenseVoice
 * leads because the paraformer-small model kept writing the wake word differently
 * every time ("到飞机", "带飞鱼", "到飞医院"), which no amount of text fuzzing fixes.
 */
export function asrCandidates() {
  const root = path.join(hereDir(), 'models')
  return [
    { name: 'SenseVoice', dir: path.join(root, 'sense-voice'), kind: 'senseVoice' },
    { name: 'paraformer-zh-2025', dir: path.join(root, 'paraformer-zh-2025'), kind: 'paraformer' },
    { name: 'paraformer-zh', dir: path.join(root, 'paraformer-zh'), kind: 'paraformer' },
  ]
}

/** Which engine actually loaded, for the panel and the logs. */
export function offlineEngineName() {
  return cachedEngine === '' ? null : cachedEngine
}

/**
 * Build the offline recogniser, best available model first.
 */
export async function getOfflineRecognizer() {
  const sdk = await loadSdk()
  if (sdk.OfflineRecognizer === undefined) return null
  for (const candidate of asrCandidates()) {
    const model = path.join(candidate.dir, 'model.int8.onnx')
    const tokens = path.join(candidate.dir, 'tokens.txt')
    try {
      readFileSync(model)
      readFileSync(tokens)
    } catch {
      continue
    }
    const key = 'offline:' + candidate.dir
    if (cachedRecognizer !== null && cachedKey === key) return cachedRecognizer
    const modelConfig = {
      tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    }
    if (candidate.kind === 'senseVoice') {
      modelConfig.senseVoice = { model, language: 'zh', useInverseTextNormalization: 1 }
    } else {
      modelConfig.paraformer = { model }
    }
    try {
      cachedRecognizer = new sdk.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig,
      })
    } catch (error) {
      console.warn(`[dsh-memory] ${candidate.name} unavailable, trying the next engine:`, error?.message ?? error)
      cachedRecognizer = null
      continue
    }
    cachedKey = key
    cachedEngine = candidate.name
    console.log(`[dsh-memory] ASR engine: ${candidate.name} · ${candidate.dir}`)
    return cachedRecognizer
  }
  return null
}

export async function getRecognizer() {
  const dir = modelDir()
  // The streaming recogniser keeps its own slot: sharing the offline cache made the
  // two engines evict each other every time the fallback was used.
  if (cachedOnline !== null && cachedOnlineKey === dir) return cachedOnline
  const sdk = await loadSdk()
  const OnlineRecognizerClass = sdk.OnlineRecognizer
  cachedOnline = new OnlineRecognizerClass({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, 'encoder-epoch-99-avg-1.onnx'),
        decoder: path.join(dir, 'decoder-epoch-99-avg-1.onnx'),
        joiner: path.join(dir, 'joiner-epoch-99-avg-1.onnx'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
  })
  cachedOnlineKey = dir
  return cachedOnline
}

/** Read a 16-bit mono WAV into float samples. */
export function readWavSamples(file) {
  const buffer = readFileSync(file)
  // Skip to the data chunk: the header our recorder writes is fixed-size, but a
  // generic scan keeps this correct for other WAVs too.
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const count = Math.min(size, buffer.length - start)
      const samples = new Float32Array(Math.floor(count / 2))
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(start + index * 2) / 32768
      }
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  return new Float32Array(0)
}

/**
 * Transcribe one WAV file.
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function transcribeWav(file) {
  const decoded = readWavSamples(file)
  if (decoded.length === 0) return ''
  // onnxruntime refuses arrays backed by native memory; hand it a plain copy.
  const plainSamples = new Float32Array(decoded.length)
  plainSamples.set(decoded)
  const samples = plainSamples
  // Offline first: one decode per chunk, and visibly better on Chinese names.
  const offline = await getOfflineRecognizer()
  if (offline !== null) {
    const stream = offline.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    offline.decode(stream)
    return String(offline.getResult(stream)?.text ?? '').trim()
  }
  const recognizer = await getRecognizer()
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) })
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  return String(result?.text ?? '').trim()
}

/** Record N seconds into a WAV file. */
export async function recordWav(seconds, device = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mic-'))
  const wav = path.join(dir, 'chunk.wav')
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -TypeDefinition ${'@'}"`,
    CAPTURE_SOURCE,
    '"@',
    `Write-Output ([DshMic]::Record(${device}, ${seconds}, 16000, '${wav.replace(/'/g, "''")}'))`,
  ].join('\n')
  const encoded = Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64')
  const output = await new Promise(resolve => {
    let text = ''
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    child.stdout?.on('data', chunk => { text += String(chunk) })
    child.stderr?.on('data', () => {})
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      resolve(text)
    }, (seconds + 20) * 1000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(text)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })
  const peakMatch = /PEAK:(\d+)/.exec(output)
  return { wav, dir, peak: peakMatch === null ? 0 : Number(peakMatch[1]) }
}

/**
 * Record and transcribe one utterance.
 * @param {{ seconds?: number, device?: number }} [options]
 */
export async function listenFromCapture(options = {}) {
  const seconds = Math.max(2, Math.min(20, Math.round(Number(options.seconds) || 4)))
  const device = Math.max(0, Math.round(Number(options.device) || 0))
  const { wav, dir, peak } = await recordWav(seconds, device)
  let text = ''
  let error
  try {
    // Silence makes a transducers model invent words; below this level, skip it.
    if (peak < MIN_PEAK) {
      return { ok: false, text: '', peak, error: '没有收到声音' }
    }
    text = await transcribeWav(wav)
  } catch (failure) {
    error = String(failure?.message ?? failure)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Temp cleanup is best effort.
    }
  }
  if (error !== undefined) return { ok: false, text: '', peak, error }
  if (text === '') {
    return { ok: false, text: '', peak, error: peak < 200 ? '没有收到声音' : '听到了声音但没识别出词' }
  }
  return { ok: true, text, peak }
}

/** Single-shot listen used by the panel button. */
export async function listen(options = {}) {
  return listenFromCapture({ seconds: Number(options.seconds) || 4, device: options.device })
}

/** Recognizer availability, so the panel can explain instead of failing silently. */
export async function recognizerInfo() {
  try {
    const dir = modelDir()
    readFileSync(path.join(dir, 'tokens.txt'))
    return { recognizers: [{ name: 'sherpa-onnx', culture: 'zh-CN' }], hasChinese: true, engine: 'sherpa-onnx' }
  } catch {
    return { recognizers: [], hasChinese: false, engine: 'none' }
  }
}

/** Where the silero VAD model lives. */
export function vadModelPath() {
  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  })()
  return path.join(here, 'models', 'vad', 'silero_vad.onnx')
}

/**
 * A VAD instance that must outlive one chunk: it keeps a sentence whole even when
 * the sentence straddles the boundary between two recordings.
 * @returns {Promise<any | null>}
 */
export async function createVad() {
  const model = vadModelPath()
  try {
    readFileSync(model)
  } catch {
    return null
  }
  const sdk = await loadSdk()
  if (sdk.Vad === undefined) return null
  try {
    return new sdk.Vad({
      sileroVad: {
        model,
        // Stricter than the default: background music kept the VAD convinced someone
        // was talking, so no sentence was ever cut and the loop went silent.
        threshold: 0.6,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        maxSpeechDuration: 8,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      debug: 0,
    })
  } catch (error) {
    console.warn('[dsh-memory] VAD unavailable:', error?.message ?? error)
    return null
  }
}

/** Record one chunk and hand back its samples (no decoding). */
export async function recordChunk(seconds, device = 0) {
  const { wav, dir, peak } = await recordWav(seconds, device)
  let samples = null
  try {
    const decoded = readWavSamples(wav)
    // Copy once here: every consumer then gets ordinary memory, never a native view.
    const plain = new Float32Array(decoded.length)
    plain.set(decoded)
    samples = plain
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Temp cleanup is best effort.
    }
  }
  return { samples, peak }
}

/** Decode raw 16 kHz mono samples. */
export async function transcribeSamples(samples) {
  if (samples === null || samples.length === 0) return ''
  const offline = await getOfflineRecognizer()
  if (offline === null) return ''
  // The VAD hands back a view on native memory; onnxruntime refuses external buffers.
  const internal = new Float32Array(samples.length)
  internal.set(samples)
  const stream = offline.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples: internal })
  offline.decode(stream)
  return String(offline.getResult(stream)?.text ?? '').trim()
}

/**
 * Where the keyword-spotting model lives.
 *
 * The spotter listens to the sound itself (pinyin phone sequence), so "大肥鱼" still
 * wakes it when the recogniser writes "大飞鱼". That is the whole reason it is here.
 */
export function kwsDir() {
  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  })()
  const candidates = [
    path.join(here, 'models', 'kws-zh'),
    path.join(process.cwd(), 'models', 'kws-zh'),
    path.join(path.dirname(process.cwd()), 'dsh-memory', 'models', 'kws-zh'),
  ]
  for (const candidate of candidates) {
    try {
      readFileSync(path.join(candidate, 'keywords.txt'))
      return candidate
    } catch {
      // Try the next location.
    }
  }
  return candidates[0]
}

let cachedSpotter = null
let spotterKey = ''

/**
 * Build (once) the keyword spotter, or null when the model is not installed.
 * @returns {Promise<any | null>}
 */
export async function getSpotter() {
  const dir = kwsDir()
  if (cachedSpotter !== null && spotterKey === dir) return cachedSpotter
  const sdk = await loadSdk()
  if (sdk.KeywordSpotter === undefined) return null
  try {
    readFileSync(path.join(dir, 'tokens.txt'))
    readFileSync(path.join(dir, 'keywords.txt'))
  } catch {
    return null
  }
  try {
    cachedSpotter = new sdk.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          decoder: path.join(dir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          joiner: path.join(dir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx'),
        },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: path.join(dir, 'keywords.txt'),
      keywordsScore: 1.0,
      keywordsThreshold: 0.25,
      // Eight, not the usual four: with only four active paths the correct pinyin
      // sequence loses to the alternatives on real speech. Measured on the user's
      // own chunks, four paths matched none of four, eight matched three of four.
      // The threshold made no difference at all in the same sweep.
      maxActivePaths: 8,
      numTrailingBlanks: 1,
    })
  } catch (error) {
    console.warn('[dsh-memory] keyword spotter unavailable:', error?.message ?? error)
    return null
  }
  spotterKey = dir
  spotterStream = null
  return cachedSpotter
}

let spotterStream = null

/**
 * Feed one chunk to the wake-word spotter.
 *
 * The stream is permanent: keyword spotting is a streaming model, so chunks are
 * appended to the same stream and decoded as they arrive. Calling inputFinished()
 * or reset() between chunks aborts the native decoder, which crashed the process
 * in testing. A stream per chunk would raise recall (75% vs 50% on real audio) but
 * each stream leaks about 0.4 MB and rebuilding the spotter does not return it, so
 * streaming is the only mode that can run for days.
 *
 * @param {Float32Array} samples 16 kHz mono
 * @returns {string | null} the keyword as written in keywords.txt, or null
 */
export function spotSamples(samples) {
  const spotter = cachedSpotter
  if (spotter === null || samples === null || samples.length === 0) return null
  // onnxruntime refuses buffers backed by native memory; hand it a plain copy.
  const internal = new Float32Array(samples.length)
  internal.set(samples)
  let hit = null
  try {
    if (spotterStream === null) spotterStream = spotter.createStream()
    spotterStream.acceptWaveform({ sampleRate: 16000, samples: internal })
    while (spotter.isReady(spotterStream)) {
      spotter.decode(spotterStream)
      const result = spotter.getResult(spotterStream)
      if (result?.keyword && hit === null) hit = String(result.keyword)
    }
  } catch (error) {
    console.warn('[dsh-memory] keyword spot failed:', error?.message ?? error)
    spotterStream = null
    return null
  }
  return hit
}
