/**
 * Host half of the memory store bundle — the composition root.
 *
 * Responsibilities are split by seam:
 *   capture.js     session/event, subagent/*, tool catalog
 *   inject.js      agent/pre-step (the one line the model sees)
 *   normalizer.js  queued user text → memory card, off the hot path
 *   vectors.js     optional local embeddings for semantic recall
 *   routes.js      panel payload, merge, delete, export
 *   repairs.js     self-healing passes and the history replay
 *   runtime.js     database path, model target resolution, one bounded call
 *
 * Every registration is an effect owned by this plugin's context, so unloading the
 * plugin closes the database and drops every listener and timer.
 */
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from './store.js'
import { createToolCatalog, mountCapture } from './capture.js'
import { mountInjection } from './inject.js'
import { DEFAULT_PERSONA_ID, renderPersona } from './personas.js'
import { syncProactive } from './proactive.js'
import { bodyFacts, renderBody } from './body.js'
import { applySelection, listOllamaModels, readModelPolicy, writeModelPolicy } from './models.js'
import { checkDownloads, rememberObservation } from './observer.js'
import { downloadsFolder } from './skills.js'
import { needsBackup, runBackup } from './backup.js'
import { cleanForSpeech } from './voice.js'
import { handleCommand } from './qq-commands.js'
import { disarmReplyWindow, qqWaitingReply, sendQq, startQqBridge, stopQqBridge } from './qq-bridge.js'
import { createNormalizer } from './normalizer.js'
import { backfill, runMemoryRepairs } from './repairs.js'
import { mountRoutes } from './routes.js'
import { BUILD, databaseFile } from './runtime.js'
import { mountSearchTool } from './search-tool.js'
import { createVectors } from './vectors.js'

export const Config = z.object({
  capture: z.boolean().default(true).description({
    zh: '记录插件启用后新产生的对话、工具调用和子代理运行',
    en: 'Record conversation, tool calls, and subagent runs produced while the plugin is enabled',
  }),
  backfillOnEnable: z.boolean().default(true).description({
    zh: '插件启用时回填全部历史会话（所有工作区），重复执行不会重复计数',
    en: 'Backfill every past Session from all workspaces when the plugin is enabled; repeated runs never double count',
  }),
  backfillDelayMs: z.number().default(3000).description({
    zh: '启动后等多久再开始回填（让界面先出来；回填本身是增量的）',
    en: 'How long to wait after activation before replaying history, so the UI paints first (the replay itself is incremental)',
  }),
  backfillMaxMs: z.number().default(8000).description({
    zh: '回填最多占用多久；超出的会话下次启动接着处理（轮转，不会永远跳过）',
    en: 'How long the replay may run; sessions it cannot reach continue on the next activation (rotating, never skipped forever)',
  }),
  captureTools: z.boolean().default(true).description({
    zh: '记录工具名、静态作用和每次调用做了什么',
    en: 'Record each tool name, its static purpose, and what the call did',
  }),
  captureSubagents: z.boolean().default(true).description({
    zh: '只记录子代理干了什么和耗时，不记录子代理会话内容',
    en: 'Record what each subagent run did and how long it took, never its session content',
  }),
  normalize: z.boolean().default(true).description({
    zh: '把用户输入异步整理成记忆卡片（对象/动作/状态），每轮一次小模型请求；相同含义只累加次数与时间',
    en: 'Asynchronously turn user input into memory cards (object/action/state) with one small model request per turn; identical meaning only accumulates count and time',
  }),
  normalizeBatch: z.number().default(8).description({
    zh: '每次最多整理多少条待处理消息（默认 8，约合 ¥0.01）',
    en: 'How many pending messages one run may normalize (default 8, roughly ¥0.01)',
  }),
  normalizeMaxPerHour: z.number().default(60).description({
    zh: '每小时最多发起的整理请求数，用于封顶开销',
    en: 'Maximum normalization requests per hour, capping spend',
  }),
  normalizeProvider: z.string().default('').description({
    zh: '整理用的提供方，留空则跟随当前默认模型',
    en: 'Provider used for normalization; empty follows the current default model',
  }),
  normalizeModel: z.string().default('').description({
    zh: '整理用的模型，留空则跟随每个会话实际使用的模型（本地会话→本地整理）',
    en: 'Model used for normalization; empty follows each Session\'s own model (a local conversation normalizes locally)',
  }),
  normalizeFollowSession: z.boolean().default(true).description({
    zh: '整理时跟随会话当前模型，而不是固定用默认模型；这样纯本地对话不会产生云端调用',
    en: 'Normalize with the Session\'s current model instead of the profile default, so a local-only conversation never calls the cloud',
  }),
  normalizeFallback: z.boolean().default(true).description({
    zh: '同一条消息连续失败两次后改用本地规则生成卡片，避免弱模型把记忆卡住',
    en: 'After two failures on one message, build the card with local rules instead of letting a weak model stall memory',
  }),
  injectMemories: z.boolean().default(true).description({
    zh: '在模型开始思考前，把命中的记忆放进对话（按消息 id 防自环，正文不带标记）',
    en: 'Place matched memories into the conversation before the model reads a step; injected text carries a [memory] marker and is never re-recorded',
  }),
  injectBudgetTokens: z.number().default(160).description({
    zh: '单次注入的记忆最长 token 数（精简风格通常只用 40–70）',
    en: 'Maximum tokens of memory injected per step (the compact style usually uses 40–70)',
  }),
  injectMinScore: z.number().default(0.5).description({
    zh: '注入所需的最低相关度（0-1，越高越保守）',
    en: 'Minimum relevance to inject (0-1; higher is more conservative)',
  }),
  injectMaxItems: z.number().default(5).description({
    zh: '单次注入最多列几条记忆，控制那行文字的长度',
    en: 'Maximum memories listed per injection, bounding the line length',
  }),
  briefOnNewSession: z.boolean().default(true).description({
    zh: '新会话的第一轮发一次简报（最近记忆的对象名，跨工作区），让新窗口知道有历史可查',
    en: 'Send one brief on a new Session\'s first turn — the names of the most recent memories, across every workspace',
  }),
  briefMaxItems: z.number().default(3).description({
    zh: '简报里列几个对象',
    en: 'How many objects the brief lists',
  }),
  handoff: z.boolean().default(true).description({
    zh: '每轮记录改过哪些文件，并在别的窗口开着时带一行"刚改动"，让新窗口知道接着改哪里',
    en: 'Record which files each turn changed, and show a "just changed" fragment in another window so work can be picked up',
  }),
  proactive: z.boolean().default(false).description({
    zh: '每天固定时间主动问候（通过 DSH 的定时任务投递，默认关闭）',
    en: 'Send one daily proactive greeting through DSH scheduling (off by default)',
  }),
  proactiveTime: z.string().default('09:00').description({
    zh: '主动问候的时间，HH:MM',
    en: 'Daily greeting time, HH:MM',
  }),
  proactiveZone: z.string().default('Asia/Shanghai').description({
    zh: '主动问候使用的时区',
    en: 'Time zone for the daily greeting',
  }),
  backup: z.boolean().default(true).description({
    zh: '每天自动导出一份 zip 备份，保留最近 N 份',
    en: 'Write one zip backup per day and keep the last N',
  }),
  backupKeep: z.number().default(7).description({
    zh: '保留几份备份',
    en: 'How many backups to keep',
  }),
  injectPointers: z.boolean().default(true).description({
    zh: '同一话题连续对话时不再重复注入记忆（省 token）',
    en: 'Skip re-injecting the same memory while the topic continues',
  }),
  qqEnabled: z.boolean().default(false).description({
    zh: '通过 UI 自动化在 QQ 里收发消息（QQ 需已登录，窗口会被自动打开）',
    en: 'Send and receive through QQ using UI automation (QQ must be signed in; the window is opened when needed)',
  }),
  qqBotUin: z.string().default('').description({
    zh: '机器人 QQ 号（负责发消息的账号）',
    en: 'Robot QQ number (the account that sends messages)',
  }),
  qqUserUin: z.string().default('').description({
    zh: '你自己的 QQ 号（只接收这个号发来的消息）',
    en: 'Your own QQ number (messages from anyone else are ignored)',
  }),
  qqLocalModel: z.string().default('').description({
    zh: '面板里选中的本地模型；开关打开时，每轮结束后切回它',
    en: 'Local model chosen in the panel; after every turn it is switched back to when the toggle is on',
  }),
  qqLocalSwitch: z.boolean().default(false).description({
    zh: '自动切换本地模型：每轮对话结束后切回本地模型（没有本地模型时不可开启）',
    en: 'After every turn switch back to the local model (disabled when no local model exists)',
  }),
  observe: z.boolean().default(true).description({
    zh: '本地观察下载目录，有新文件时在下一轮顺口提一句（不调用模型）',
    en: 'Watch the download folder locally and mention new files on the next turn',
  }),
  localSkills: z.boolean().default(true).description({
    zh: '本机能做的事（整理下载、找文件、系统信息）由本地直接执行，不调用模型',
    en: 'Run local errands (tidy downloads, find files, system info) without calling a model',
  }),
  localAnswers: z.boolean().default(true).description({
    zh: '关于你的事（认识多久、常用词、上次聊什么）由本地直接回答，不走召回',
    en: 'Answer questions about the user from local data instead of recall scoring',
  }),
  bodyAware: z.boolean().default(true).description({
    zh: '让助手知道它住在这台电脑里（主机、内存、记忆文件位置、重启会睡着）',
    en: 'Tell the assistant it lives on this machine (host, memory, sleep between restarts)',
  }),
  proactiveAdaptive: z.boolean().default(true).description({
    zh: '主动问候时间跟随用户活跃习惯自动调整',
    en: 'Let the proactive greeting time follow the learned active hour',
  }),
  persona: z.boolean().default(true).description({
    zh: '把人格作为系统提示的一部分注入（可在面板里切换人格）',
    en: 'Inject the selected persona as part of the system prompt (switchable in the panel)',
  }),
  searchTool: z.boolean().default(true).description({
    zh: '提供 memory_search 工具：自动注入只给一行线索，需要细节时由模型主动检索',
    en: 'Expose the memory_search tool: the automatic note is one line, so the model can ask for details when it needs them',
  }),
  embedModel: z.string().default('').description({
    zh: '语义召回的 embedding 模型（如 bge-m3）；留空则只用字面召回',
    en: 'Embedding model for semantic recall (for example bge-m3); empty keeps recall lexical only',
  }),
  embedUrl: z.string().default('http://127.0.0.1:11434/api/embed').description({
    zh: 'embedding 接口地址（Ollama 的 /api/embed）',
    en: 'Embedding endpoint (Ollama /api/embed)',
  }),
  embedMinSimilarity: z.number().default(0.55).description({
    zh: '语义命中的最低余弦相似度',
    en: 'Minimum cosine similarity for a semantic hit',
  }),
  embedTimeoutMs: z.number().default(1500).description({
    zh: '单次查询 embedding 的超时；超时就退回字面召回，不阻塞对话',
    en: 'Timeout for one query embedding; on timeout recall falls back to lexical and never blocks the turn',
  }),
})

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const settings = { capture: true, backfillOnEnable: true, captureTools: true, captureSubagents: true, ...config }
  if (!settings.capture && !settings.backfillOnEnable) return

  const catalog = createToolCatalog(ctx)
  let store
  try {
    store = new MemoryStore(databaseFile(), { describeTool: name => catalog.describe(name) })
  } catch (error) {
    console.warn('[dsh-memory] store unavailable, capture disabled:', error?.message ?? error)
    return
  }
  ctx.effect(() => () => { store.close() }, 'dsh-memory: close the memory database')

  try {
    store.setMeta('build', BUILD)
    store.setMeta('activatedAt', new Date().toISOString())
    // Entities recorded before canonical normalization may differ only by case or
    // spacing; fold them once at startup so counts are not split.
    const mergedDuplicates = store.repairCanonicalDuplicates()
    if (mergedDuplicates > 0) {
      store.setMeta('canonicalRepair', JSON.stringify({ at: Date.now(), merged: mergedDuplicates }))
      console.log(`[dsh-memory] merged ${mergedDuplicates} case/space duplicate entities`)
    }
    // History recorded before association existed has no links; this pass is
    // idempotent. It runs after the backfill (see `runMemoryRepairs`), with a
    // fallback for profiles where no scan is available.
    if (!settings.backfillOnEnable) {
      ctx.effect(() => {
        const handle = setTimeout(() => runMemoryRepairs(store), 10_000)
        if (typeof handle.unref === 'function') handle.unref()
        return () => clearTimeout(handle)
      }, 'dsh-memory: memory repair fallback')
    }
  } catch (error) {
    console.warn('[dsh-memory] cannot record build metadata:', error?.message ?? error)
  }

  // Heal rows recorded before any purpose was readable.
  if (settings.captureTools) {
    ctx.effect(() => {
      const handle = setTimeout(() => {
        try {
          const repaired = store.repairToolDescriptions(name => catalog.describe(name))
          store.setMeta('toolDiagnostics', catalog.diagnostics())
          store.setMeta('toolRepair', JSON.stringify({ at: Date.now(), repaired }))
          if (repaired > 0) console.log(`[dsh-memory] repaired ${repaired} tool descriptions`)
        } catch (error) {
          console.warn('[dsh-memory] tool description repair skipped:', error?.message ?? error)
        }
      }, 2000)
      if (typeof handle.unref === 'function') handle.unref()
      return () => clearTimeout(handle)
    }, 'dsh-memory: repair tool descriptions')
  }

  const vectors = createVectors({ store, settings })
  if (vectors.embedModel !== '') {
    ctx.effect(() => {
      const handle = setTimeout(() => { void vectors.refreshVectors() }, 12_000)
      if (typeof handle.unref === 'function') handle.unref()
      return () => clearTimeout(handle)
    }, 'dsh-memory: embedding warmup')
  }

  const normalizer = createNormalizer({ ctx, store, settings, vectors })
  ctx.effect(() => () => { normalizer.dispose() }, 'dsh-memory: stop the normalization timer')

  if (settings.persona !== false) {
    // A section, not a per-turn note: this is who the assistant is, so it must read
    // like part of the prompt rather than something pasted into the conversation.
    const mountPersona = owner => {
      try {
        const prompt = owner.get?.('systemPrompt') ?? owner.systemPrompt
        if (prompt === undefined || typeof prompt.section !== 'function') return
        owner.effect(() => prompt.section({
          name: 'dsh-memory-persona',
          order: 10,
          text: () => {
            const activeId = store.activePersona() ?? DEFAULT_PERSONA_ID
            const lines = [renderPersona(activeId, store.personaOverride(activeId))]
            // A separate section would sort after this one anyway; keeping the body
            // sentence here means one read of the prompt, not two.
            if (settings.bodyAware !== false) lines.push(renderBody(bodyFacts(databaseFile())))
            const relationship = store.renderRelationship()
            if (relationship !== null) lines.push(relationship)
            const mood = store.renderMoodLine()
            if (mood !== null) lines.push(mood)
            return lines.join('\n')
          },
        }), 'dsh-memory: persona section')
      } catch (error) {
        console.warn('[dsh-memory] persona section skipped:', error?.message ?? error)
      }
    }
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], scoped => mountPersona(scoped))
    else mountPersona(ctx)
  }

  // Proactive: one daily greeting, created through the schedule service. Off by
  // default — a companion that speaks first must be asked for.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['schedule'], scoped => {
      const schedule = scoped.get?.('schedule') ?? scoped.schedule
      if (schedule === undefined || typeof schedule.create !== 'function') return
      const run = async () => {
        try {
          const result = await syncProactive({ schedule, store, settings })
          if (result.action !== 'off') console.log('[dsh-memory] proactive:', result.action, result.taskId ?? '', result.error ?? '')
        } catch (error) {
          console.warn('[dsh-memory] proactive sync failed:', error?.message ?? error)
        }
      }
      ctx.effect(() => {
        void run()
        return () => {}
      }, 'dsh-memory: proactive greeting')
    })
  }

  // Model choice belongs to the operator. An earlier version switched back to the
  // local model at startup and after every turn; that silently undid a deliberate
  // switch to a paid model, so it is gone. "本轮使用api" still works: it is driven by
  // an explicit request and restores the previous model itself.

  // Safety: a model with no refusals and no approval prompts still must not wipe
  // the disk. This guard sits on the tool layer, so it does not depend on the model.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], scoped => {
      const tools = scoped.get?.('tools') ?? scoped.tools
      if (tools === undefined || typeof tools.guard !== 'function') return
      const CATASTROPHIC = [
        /format\s+[a-z]:/i,
        /rm\s+-rf\s+\/\s*$/i,
        /del\s+\/f\s+\/s\s+\/q\s+[a-z]:\\s*$/i,
        /shutdown\s+\/(s|r)/i,
        /diskpart/i,
        /Remove-Item\s+-Recurse\s+-Force\s+[a-z]:\\\s*$/i,
      ]
      ctx.effect(() => tools.guard(exec => {
        const input = exec?.input ?? exec?.args ?? exec?.arguments ?? exec
        const text = typeof input === 'string' ? input : JSON.stringify(input ?? '')
        const hit = CATASTROPHIC.find(pattern => pattern.test(text))
        if (hit === undefined) return undefined
        console.warn('[dsh-memory] safety guard blocked a destructive command')
        return { reason: '这条命令会破坏系统，被插件的安全闸拦下了。' }
      }), 'dsh-memory: safety guard')
    })
  }

  // Backups: one zip a day next to the database, keeping the last few.
  if (settings.backup !== false) {
    const backup = () => {
      try {
        // The timer can outlive the store during dispose.
        if (store.db?.isOpen === false) return
        if (!needsBackup(store)) return
        const result = runBackup(store, { databasePath: databaseFile(), keep: Math.max(1, Number(settings.backupKeep) || 7) })
        if (result.ok) console.log('[dsh-memory] backup written:', result.file)
        else console.warn('[dsh-memory] backup failed:', result.error)
      } catch (error) {
        console.warn('[dsh-memory] backup skipped:', error?.message ?? error)
      }
    }
    const timer = setInterval(backup, 12 * 60 * 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'dsh-memory: backup timer')
    setImmediate(backup)
  }

  // Observation: a local watcher, so "something just arrived" needs no model.
  if (settings.observe !== false) {
    const check = () => {
      try {
        const note = checkDownloads(store, { folder: downloadsFolder })
        if (note !== null) {
          rememberObservation(store, note)
          console.log('[dsh-memory] observed:', note)
        }
      } catch (error) {
        console.warn('[dsh-memory] observation skipped:', error?.message ?? error)
      }
    }
    const timer = setInterval(check, 5 * 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'dsh-memory: observation timer')
    ctx.inject?.(['timer'], scoped => {
      const timers = scoped.get?.('timer') ?? scoped.timer
      timers?.timeout?.(check, 10_000)
    })
  }

  mountInjection({ ctx, store, settings, vectors })
  mountCapture({ ctx, store, settings, scheduleNormalization: normalizer.schedule })
  mountSearchTool({ ctx, store, settings, vectors })

  // QQ channel: drive the real client through UI automation.
  //
  // The configuration lives in the store, not in plugin settings, so the panel can
  // change it and the bridge can restart without a DSH restart.
  const qqConfig = () => ({
    enabled: store.getMeta('qq.enabled') === '1',
    userUin: String(store.getMeta('qq.userUin') ?? '').trim(),
  })

  {
    /**
     * Short QQ messages can be control commands. Answering them here keeps them off
     * the model and gives an immediate receipt, as the operator asked.
     */
    /** Fixed command table lives in qq-commands.js so it can be tested alone. */
    const listModelsForQq = async () => {
      const local = await listOllamaModels(settings.embedUrl ?? 'http://127.0.0.1:11434').catch(() => [])
      const cloud = []
      try {
        const llm = ctx.get?.('llm') ?? ctx.llm
        if (llm !== undefined && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
          for (const provider of llm.listProviders()) {
            if (provider?.id === 'ollama') continue
            const list = await llm.listModels(provider.id).catch(() => [])
            for (const model of list ?? []) {
              const id = String(model.id)
              const name = String(model.name ?? model.id)
              const free = model?.free === true || model?.isFree === true ||
                model?.pricing?.free === true || /(?:^|[-_:])free$|\(free\)/i.test(`${id} ${name}`)
              const official = String(provider.id).startsWith('deepseek')
              cloud.push({
                provider: provider.id,
                providerName: String(provider.name ?? provider.id),
                id,
                name,
                kind: official ? '官方 API' : '第三方 API',
                billing: free ? '免费' : '付费',
              })
            }
          }
        }
      } catch {
        // Keep the local list even when a cloud provider is unavailable.
      }
      return {
        local: local.map(model => ({ ...model, provider: 'ollama', kind: '本地', billing: '免费' })),
        cloud,
      }
    }
    const handleQqCommand = text => handleCommand(text, {
      policy: () => readModelPolicy(store),
      selection: () => {
        try {
          return ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? null
        } catch {
          return null
        }
      },
      localModel: () => String(store.getMeta('qq.localModel') ?? '').trim() || (readModelPolicy(store).local?.model ?? ''),
      localSwitch: () => store.getMeta('qq.localSwitch') === '1',
      setLocalSwitch: on => store.setMeta('qq.localSwitch', on ? '1' : '0'),
      listModels: listModelsForQq,
      setPaid: selection => {
        const policy = readModelPolicy(store)
        policy.paid = selection
        writeModelPolicy(store, policy)
      },
      setLocal: selection => {
        const policy = readModelPolicy(store)
        policy.local = selection
        writeModelPolicy(store, policy)
        // The QQ switch reads this field; keep it in step with the chosen slot.
        store.setMeta('qq.localModel', selection.model)
      },
      /** No slot configured: offer the first model of that kind, and remember the offer. */
      offerDefault: async kind => {
        try {
          const data = await listModelsForQq()
          if (kind === 'local') {
            if (data.local.length === 0) return '本机没有发现任何本地模型（Ollama 里一个模型都没有）。'
            const first = data.local[0]
            store.setMeta('qq.pending', JSON.stringify({ kind: 'local', provider: 'ollama', model: first.id }))
            return `本机还没有配置本地模型。帮你把列表第一个 ${first.id} 设为默认本地模型？回复「好」。`
          }
          if (data.cloud.length === 0) return '没有发现可用的 API 模型。'
          const first = data.cloud[0]
          store.setMeta('qq.pending', JSON.stringify({ kind: 'paid', provider: first.provider, model: first.id }))
          return `还没配置付费模型。帮你把列表第一个 ${first.name}（${first.providerName}）设为付费槽？回复「好」。`
        } catch (error) {
          return `读取模型列表失败：${error?.message ?? error}`
        }
      },
      takePending: () => {
        const raw = store.getMeta('qq.pending')
        if (typeof raw !== 'string' || raw === '') return null
        store.setMeta('qq.pending', '')
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      },
      confirmPending: async pending => {
        if (pending?.kind === 'local') {
          const policy = readModelPolicy(store)
          policy.local = { provider: pending.provider, model: pending.model }
          writeModelPolicy(store, policy)
          store.setMeta('qq.localModel', pending.model)
          const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
          const ok = await applySelection(service, policy.local)
          return ok
            ? `已把 ${pending.model} 设为默认本地模型并切过去。`
            : `已把 ${pending.model} 设为默认本地模型，但切换没成功。`
        }
        if (pending?.kind === 'paid') {
          const policy = readModelPolicy(store)
          policy.paid = { provider: pending.provider, model: pending.model }
          writeModelPolicy(store, policy)
          return `已把 ${pending.provider} / ${pending.model} 设为付费槽。`
        }
        return null
      },
      apply: async selection => {
        const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
        return applySelection(service, selection)
      },
      // Before switching away, remember where we were so "切回付费模型" can go back.
      // Never remember the local model itself as the "paid" return target.
      rememberCurrent: () => {
        try {
          const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
          const local = readModelPolicy(store).local
          if (local !== null && local !== undefined &&
            selection?.provider === local.provider && selection?.model === local.model) return
          if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
            store.setMeta('qq.previousModel', JSON.stringify({ provider: selection.provider, model: selection.model }))
          }
        } catch {
          // Best effort only.
        }
      },
      restorePaid: async () => {
        try {
          const raw = store.getMeta('qq.previousModel')
          if (typeof raw !== 'string' || raw === '') return null
          const selection = JSON.parse(raw)
          if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return null
          const local = readModelPolicy(store).local
          if (local !== null && local !== undefined &&
            selection.provider === local.provider && selection.model === local.model) return null
          const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
          const ok = await applySelection(service, selection)
          return ok ? selection : null
        } catch {
          return null
        }
      },
      /** Forget the recorded QQ Sessions; the next delivery builds new ones. */
      resetSessions: () => {
        store.setMeta('qq.localSessionId', '')
        store.setMeta('qq.paidSessionId', '')
        console.log('[dsh-memory] qq sessions cleared')
      },
      /** Is the paid model already the one in force? */
      paidActive: () => {
        const paid = readModelPolicy(store).paid
        if (paid === null || paid === undefined) return false
        try {
          const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
          return selection?.provider === paid.provider && selection?.model === paid.model
        } catch {
          return false
        }
      },
      /** Switch this turn to the paid model; turn/end puts the old one back. */
      beginCloudTurn: async () => {
        const paid = readModelPolicy(store).paid
        if (paid === null || paid === undefined) return false
        try {
          const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
          if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
            store.setMeta('qq.previousModel', JSON.stringify({ provider: selection.provider, model: selection.model }))
          }
        } catch {
          // Best effort only.
        }
        const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
        const ok = await applySelection(service, paid)
        if (ok) store.setMeta('qq.restorePending', '1')
        return ok
      },
    })

    let stopped = false
    let runningKey = ''

    /**
     * A QQ Session is rotated once its event log grows past this. Context is the real
     * limit, but the event count is the cheap proxy: one turn is a handful of events.
     */
    const QQ_ROTATE_SEQ = 400

    /**
     * Delete one Session's stored log and projection cache. Used when the window is full
     * (the operator wants it gone, not archived) and when a corrupt log refuses to load.
     * @param {string} sessionId
     */
    const purgeSessionFiles = sessionId => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const sessionsRoot = join(homedir(), '.dsh', 'sessions')
      try {
        for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!group.isDirectory()) continue
          const dir = join(sessionsRoot, group.name, sessionId)
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        // Nothing to delete is fine.
      }
      const cache = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
      try {
        if (existsSync(cache)) rmSync(cache, { force: true })
      } catch {
        // Same.
      }
    }

    /**
     * QQ gets its own dedicated Sessions, one per billing mode, because a Session's
     * model is fixed when it is created — switching the default never moves an existing
     * Session off its model. Reusing two long-lived Sessions keeps context AND lets a
     * switch actually change which model answers.
     *
     * @param {'local' | 'paid'} kind
     * @returns {Promise<string | null>} the Session id, or null when that slot is unset
     */
    const ensureQqSession = async kind => {
      const metaKey = kind === 'local' ? 'qq.localSessionId' : 'qq.paidSessionId'
      const title = kind === 'local' ? '本地模型qq对话' : '付费模型qq对话'
      const policy = readModelPolicy(store)
      const selection = kind === 'local'
        ? {
          provider: String(policy.local?.provider ?? 'ollama'),
          model: String(policy.local?.model ?? store.getMeta('qq.localModel') ?? ''),
        }
        : {
          provider: String(policy.paid?.provider ?? ''),
          model: String(policy.paid?.model ?? ''),
        }
      if (selection.model === '') return null
      const agents = ctx.get?.('agents') ?? ctx.agents
      if (agents === undefined) return null

      const known = String(store.getMeta(metaKey) ?? '')
      if (known !== '') {
        // Rotate before the window fills: a full Session either refuses new turns or
        // silently truncates, and QQ has no way to see that happened.
        const seq = Number(store.cursorOf(known)) || 0
        if (seq >= QQ_ROTATE_SEQ) {
          console.log(`[dsh-memory] qq session full: ${title} · seq=${seq} · deleting`)
          store.setMeta(metaKey, '')
          // The operator asked for the full window to be removed, not archived.
          purgeSessionFiles(known)
        } else {
          try {
            const live = typeof agents.get === 'function' ? agents.get(known) : undefined
            if (live !== undefined) return known
          } catch {
            // Fall through to resume.
          }
          try {
            const resumed = await agents.resume({ resumeSessionId: known, agentOptions: selection })
            console.log(`[dsh-memory] qq session resumed: ${title} · seq=${seq}`)
            return String(resumed.agent.id)
          } catch (error) {
            // The recorded Session is unreadable (usually a corrupt log after a hard
            // stop). Delete it so it stops failing on every restart, then build a new one.
            console.log(`[dsh-memory] qq session resume failed (${error?.message ?? error}); replacing it`)
            store.setMeta(metaKey, '')
            purgeSessionFiles(known)
          }
        }
      }

      try {
        const sessionId = `session-${randomUUID()}`
        // A Session created outside a workspace misbehaves: its tool surface and
        // working directory come from the host process directory. Prefer the workspace
        // a real conversation is using; fall back to the service default.
        const wd = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
        const serviceDefault = typeof wd?.defaultDirectory === 'string' ? wd.defaultDirectory : ''
        const configured = String(store.getMeta('qq.workspace') ?? '').trim()
        // The panel wins. With nothing configured, ask the workspace registry: the
        // workingDirectory service reports the profile directory, which is not a
        // workspace at all and makes tools misbehave.
        let cwd = configured
        let source = 'panel'
        if (cwd === '') {
          source = 'workspace'
          try {
            const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
            const list = typeof registry?.list === 'function' ? registry.list() : []
            const first = Array.isArray(list) ? list[0] : undefined
            if (first !== undefined && typeof first.path === 'string' && first.path !== '') cwd = first.path
          } catch {
            // Fall through.
          }
        }
        if (cwd === '') {
          source = 'service'
          cwd = serviceDefault !== '' ? serviceDefault : process.cwd()
        }
        console.log(`[dsh-memory] qq session cwd: ${cwd} (${source})`)
        console.log(`[dsh-memory] qq session cwd: ${cwd}`)
        const handle = await agents.create({
          sessionId,
          meta: { cwd },
          agentOptions: selection,
        })
        // DSH stores a Session title as a `session/title` event. The payload needs all
        // three fields — a bare { title } writes an invalid event and makes the whole
        // Session log unreadable ("stored log is corrupt").
        try {
          const session = handle?.agent?.session
          if (typeof session?.append === 'function') {
            session.append('session/title', {
              title,
              messageSeqs: [],
              source: { kind: 'user' },
            })
            console.log(`[dsh-memory] qq session titled: ${title}`)
          } else {
            console.log('[dsh-memory] qq session title skipped: no session handle')
          }
        } catch (error) {
          console.warn('[dsh-memory] qq session title failed:', error?.message ?? error)
        }
        store.setMeta(metaKey, String(handle.agent.id))
        console.log(`[dsh-memory] qq session created: ${title} · ${selection.provider}/${selection.model}`)
        return String(handle.agent.id)
      } catch (error) {
        console.warn('[dsh-memory] qq session create failed:', error?.message ?? error)
        return null
      }
    }

    /**
     * Which billing mode a QQ turn should use: the standing local switch wins, then the
     * model currently in force.
     * @returns {'local' | 'paid'}
     */
    const qqTurnKind = () => {
      if (store.getMeta('qq.localSwitch') === '1') return 'local'
      const policy = readModelPolicy(store)
      const local = policy.local
      if (local === null || local === undefined) return 'paid'
      try {
        const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
        return selection?.provider === local.provider && selection?.model === local.model ? 'local' : 'paid'
      } catch {
        return 'paid'
      }
    }

    const start = key => {
      if (stopped) return
      const config = qqConfig()
      startQqBridge({
        uin: config.userUin,
        // Only the conversation with this title is read and answered. Learned on the
        // first poll and persisted, so switching QQ's sidebar no longer triggers a reply
        // into somebody else's window.
        contact: String(store.getMeta('qq.contactName') ?? '').trim(),
        onContact: name => {
          try {
            store.setMeta('qq.contactName', name)
          } catch {
            // Persistence is a convenience, not a requirement.
          }
        },
        handleCommand: handleQqCommand,
        // The local models here are text-only; the bridge needs to know that before it
        // hands over a picture path nobody can read.
        isLocalModel: () => qqTurnKind() === 'local',
        deliver: async text => {
          const schedule = ctx.get?.('schedule') ?? ctx.schedule
          if (schedule === undefined) {
            console.warn('[dsh-memory] qq deliver failed: schedule service unavailable')
            return
          }
          // Route every message into the Session that matches its billing mode, so a
          // local conversation really runs on the local model.
          const kind = qqTurnKind()
          let sessionId = await ensureQqSession(kind)
          if (sessionId === null) {
            const latest = store.sessionsOf(1)[0]
            if (latest === undefined) return
            sessionId = String(latest.session_id)
            console.warn('[dsh-memory] qq deliver falling back to latest session')
          }
          console.log('[dsh-memory] qq deliver ->', kind, 'session=', sessionId, JSON.stringify(text))
          await schedule.create({
            title: 'QQ 消息',
            prompt: text,
            timing: { kind: 'after', after_seconds: 1 },
            target: { kind: 'session', sessionId },
          })
          console.log('[dsh-memory] qq deliver queued')
        },
      })
      runningKey = key
      console.log('[dsh-memory] qq bridge started · uin=' + config.userUin)
    }

    // Toggle the bridge on or off whenever the panel changes the configuration.
    const sync = () => {
      const config = qqConfig()
      const key = config.enabled && config.userUin !== '' ? config.userUin : ''
      if (key === runningKey) return
      if (runningKey !== '') stopQqBridge()
      runningKey = ''
      if (key !== '') start(key)
    }
    setImmediate(sync)
    const timer = setInterval(sync, 5000)
    timer.unref?.()
    ctx.effect(() => () => {
      stopped = true
      clearInterval(timer)
      stopQqBridge()
    }, 'dsh-memory: qq bridge')

    // After every turn, switch back to the local model when the operator asked for
    // it. No local model configured means no switch at all — the toggle is inert.
    // NOTE: the listener signature is (session, event); read the event directly.
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'turn/end') return
        // A one-turn cloud request dominates: put the old model back and stop.
        if (store.getMeta('qq.restorePending') === '1') {
          store.setMeta('qq.restorePending', '0')
          const raw = store.getMeta('qq.previousModel')
          if (typeof raw === 'string' && raw !== '') {
            try {
              const previous = JSON.parse(raw)
              if (typeof previous?.provider === 'string' && typeof previous?.model === 'string') {
                const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
                void applySelection(service, previous)
                return
              }
            } catch {
              // Fall through to the standing local switch.
            }
          }
        }
        const config = qqConfig()
        if (!config.localSwitch) return
        const policy = readModelPolicy(store)
        const local = policy.local
        if (local === null || typeof local.provider !== 'string' || local.provider === '') return
        const model = String(store.getMeta('qq.localModel') ?? '').trim() || local.model
        if (typeof model !== 'string' || model === '') return
        const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
        void applySelection(service, { provider: local.provider, model })
      } catch (error) {
        console.warn('[dsh-memory] local model switch skipped:', error?.message ?? error)
      }
    })

    // Reply hook: only while a QQ question is waiting for its answer, so typing in
    // the GUI never leaks into QQ. Signature is (session, event).
    ctx.on('session/event', (session, event) => {
      try {
        if (!qqWaitingReply()) return
        if (event?.type !== 'assistant/message') return
        const content = Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
        const text = content.filter(block => block?.type === 'text').map(block => block.text).join(' ').trim()
        // The first assistant message of a turn is usually a tool call with no text.
        // Keep waiting for the one that actually says something.
        if (text === '') return
        disarmReplyWindow()
        console.log('[dsh-memory] qq reply ->', JSON.stringify(text.slice(0, 80)))
        void sendQq(cleanForSpeech(text, 1800)).then(result => {
          console.log('[dsh-memory] qq reply sent:', JSON.stringify(result))
        })
      } catch (error) {
        console.warn('[dsh-memory] qq reply skipped:', error?.message ?? error)
      }
    })
  }

  if (settings.backfillOnEnable) {
    // Wait for the session query service instead of racing it at boot, then wait a
    // little longer: replaying history is not on the critical path, and doing it
    // inside activation is what made startup feel stuck.
    const delay = Math.max(0, Number(settings.backfillDelayMs) || 3000)
    const start = sessionQuery => {
      ctx.effect(() => {
        const handle = setTimeout(() => {
          void backfill(sessionQuery, store, { maxMs: Number(settings.backfillMaxMs) || 8000 })
        }, delay)
        if (typeof handle.unref === 'function') handle.unref()
        return () => clearTimeout(handle)
      }, 'dsh-memory: deferred backfill')
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionQuery'], scoped => {
        start(scoped.sessionQuery)
      })
    } else {
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery !== undefined) start(sessionQuery)
      else console.warn('[dsh-memory] sessionQuery unavailable, history backfill skipped')
    }
  }

  // Distill whatever previous runs left pending, well after activation so the
  // model route and the tool catalog are both ready.
  normalizer.schedule(5000)

  const mountPanel = owner => {
    try {
      mountRoutes(owner, store, settings)
    } catch (error) {
      console.warn('[dsh-memory] panel route skipped:', error?.message ?? error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], scoped => {
      mountPanel(scoped)
    })
  } else {
    mountPanel(ctx)
  }
}
