/**
 * Browser half of the memory store bundle (M5).
 *
 * One page, reachable from Settings and from the bundle's own page in Plugins.
 * Data comes from the Host's `/dsh-memory/panel` route, guarded by the DSH
 * connection check, so this page needs no credentials of its own.
 *
 * All user-visible text goes through the Harness locale service (`ctx.locale`),
 * never a navigator guess: the plugin must follow the DSH UI language.
 *
 * Kept as plain `React.createElement` like every Client plugin: no build step,
 * no Harness Client package imports, only `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-store',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'dsh-memory'
    const PANEL_ROUTE = '/dsh-memory/panel'
    const SLOT = 'settings.section'
    const BUNDLE_SLOT = 'plugins.bundle.config'
    const BUNDLE_NAME = 'dsh-memory-store'
    const ENTRY_ID = 'memory-store'

    /** Flat dictionaries: `ctx.locale.register` takes one map per language. */
    const DICT = {
      zh: {
        'label': '记忆库',
        'title': '记忆库',
        'subtitle': '跨所有工作区共享；相同含义只累计次数与时间，不保存原话。',
        'filter': '筛选对象',
        'refresh': '刷新',
        'refreshing': '刷新中…',
        'loading': '正在读取记忆库…',
        'readFailed': '读取失败：',
        'retry': '重试',
        'lastInjection': '最近一次注入：',
        'items': '项',
        'objects': '记忆对象（{n}）',
        'emptyObjects': '还没有记录到对象。',
        'recent': '最近出现',
        'emptyRecent': '还没有出现记录。',
        'merge': '合并…',
        'mergeInto': '合并到…',
        'confirm': '确认',
        'cancel': '取消',
        'merged': '已合并「{from}」→「{to}」',
        'mergeFailed': '合并失败：',
        'delete': '删除',
        'deleteConfirm': '确定删除「{name}」？它的所有出现记录都会一起删掉。',
        'deleted': '已删除「{name}」（{n} 条出现）',
        'deleteFailed': '删除失败：',
        'trash': '回收站（{n}）',
        'emptyTrash': '回收站是空的。',
        'restore': '恢复',
        'restored': '已恢复「{name}」',
        'restoreFailed': '恢复失败：',
        'export': '导出记忆',
        'embedTitle': '⚠ 语义检索需要 bge-m3 模型',
        'embedReady': '语义检索已就绪',
        'embedReadyHint': '作用：你说"QQ 通道"这种关键词它能对上，说"我之前干过啥"这种自然问法也能命中，靠的就是它。',
        'normalizerTitle': '记忆整理模型',
        'normalizerHint': '把对话提炼成记忆卡用的模型。每轮对话都会跑一次，所以推荐本地模型：不花钱、离线也能用。这一步只做「抽取」，不算推理，8B 左右的小模型就够。作者实测 mimo-9b：平均 3 秒整理一条，输出 JSON 全部合法，比 14B 快一倍。云端按 token 计费，会在后台悄悄花钱。',
        'normalizerRecommend': '推荐：mimo-9b（作者亲测，3 秒一条，输出稳定）',
        'normalizerLocal': '本地（推荐）',
        'normalizerCloud': '云端',
        'normalizerOff': '不整理',
        'normalizerPick': '用哪个本地模型：',
        'normalizerNoPick': '还没选，请点上面指定一个',
        'normalizerNoLocal': '这台电脑上没有本地模型，先去 Ollama 拉一个（例如 ollama pull qwen3:4b）',
        'normalizerOffHint': '不整理时记忆仍然记录原文，但不会生成记忆卡，检索只能靠关键词。',
        'embedWhat': 'bge-m3 是一个「嵌入模型」：它不聊天，只把文字变成一组数字（向量）。两段话的向量越接近，意思就越接近。',
        'embedWhy': '记忆的召回分两半：一半靠关键词（你说"QQ 通道"它能对上），一半靠语义（你说"我之前干过啥"它也能懂）。语义这半靠 bge-m3 支撑。',
        'embedWithout': '没装这个模型时记忆仍然能用，只是只能靠关键词——问对词才想得起来，自然地问就想不起来。换电脑后记得重新装一次。',
        'embedHow': '安装命令：ollama pull bge-m3（约 1.2 GB）',
        'exportDone': '导出完成，检查浏览器的下载列表。',
        'exportFailed': '导出失败：',
        'import': '导入记忆',
        'importing': '导入中…',
        'imported': '导入完成：新增 {records} 条对话、合并 {merged} 条、跳过重复 {dup} 条、对象 {insertedEntities} 个',
        'importFailed': '导入失败：',
        'habits': '常用习惯（{n}）',
        'emptyHabits': '还没有足够的关键词统计。',
        'timeline': '时间线（{n}）',
        'emptyTimeline': '还没有完整的对话记录。',
        'archived': '已归档（{n}）',
        'emptyArchived': '没有已归档的对象。',
        'unarchive': '恢复',
        'unarchived': '已恢复「{name}」',
        'unarchiveFailed': '恢复失败：',
        'times': '×{n}',
        'activeHours': '活跃时段',
        'collapse': '折叠',
        'models': '本地模型',
        'narratives': '这些周我们聊过什么',
        'narrativesEmpty': '还没攒够一周的记录。',
        'backup': '自动备份',
        'backupOn': '每天自动备份一份到 {folder}，保留最近 {keep} 份。',
        'backupNone': '还没有备份，点下面按钮立刻做一份。',
        'backupLast': '上次备份：{at} · {count} 份在硬盘上',
        'backupNow': '立即备份',
        'backupDone': '备份完成',
        'backupFailed': '备份失败：',
        'usage': '今天：本地处理 {local} 次 · 本机执行 {skill} 次 · 走模型 {cloud} 次 · 省下重复注入 {skipped} 次',
        'usageHint': '本地处理不花钱；走模型的就是你看到的对话。',
        'modelsHint': '选中一个本地模型，它就成为默认本地模型。切到付费模型、或遇到需要花钱的任务时走云端，其余时间都用本地的。',
        'modelsCurrent': '当前本地模型：{model}',
        'modelsNone': '未指定本地模型（默认用 DSH 里的设置）',
        'modelsLoading': '正在读取本地模型…',
        'modelsEmpty': '没读到模型。检查 Ollama 是否在运行：{endpoint}。',
        'modelsPick': '用这个',
        'modelsPicked': '已切到本地模型：{model}',
        'modelsUsing': '正在使用',
        'modelsPickHint': '下面是这台电脑上已经装好的模型。点「用这个」就切换过去。',
        'modelsLoad': '点击选择本地模型',
        'modelsFailed': '操作失败：',
        'chatFailed': '切换失败：',
        'persona': '人格（{name}）',
        'personaHint': '人格决定它怎么说话、在意什么、不做什么。切换立刻生效，下一轮就用新的说话方式。',
        'usePersona': '切换',
        'personaEdit': '编辑',
        'personaSave': '保存',
        'personaCancel': '取消',
        'personaReset': '恢复默认',
        'personaSaved': '保存好了',
        'personaEditFailed': '保存失败：',
        'personaFieldName': '名字',
        'personaFieldTone': '说话方式',
        'personaFieldValues': '在意什么',
        'personaFieldAvoid': '不做什么',
        'personaFieldHelp': '怎么帮你',
        'relationship': '关系：{stage}（亲密度 {warm}）· {turns} 轮对话',
        'relationshipAddress': '称呼：{address}',
        'relationshipPromise': '还欠着一件事：{note}',
        'moodLine': '今天：{note}',
        'proactiveOn': '主动问候：每天 {time}',
        'proactiveOff': '主动问候：关闭（配置里设 proactive: true 打开）',
        'personaSwitched': '已切换到「{name}」',
        'personaFailed': '切换失败：',
        'transferHint': '导出会把整个记忆库打成 zip：对话流水、记忆卡、关系状态、习惯词、配置，全都在里面。导入时按表合并，已经存在的行不会被覆盖。',
        'transferCounts': '当前可导出：{entities} 个对象 · {records} 条对话 · {keywords} 个习惯词',
        'lastImport': '上次导入：新增 {records} · 合并 {merged} · 跳过重复 {dup}',
        'chooseFile': '选择记忆文件…',
        'expand': '展开',
        'stat.objects': '记忆对象',
        'stat.occurrences': '出现次数',
        'stat.turns': '已记录轮次',
        'stat.tools': '工具调用',
        'stat.sessions': '会话',
        'stat.links': '联想',
        'stat.queued': '待整理',
        'sessions': '会话与子代理（{n}）',
        'emptySessions': '还没有记录到会话。',
        'untitled': '（未命名）',
        'subagent': '子代理',
        'reviews': '复习 {n} 次',
      },
      en: {
        'label': 'Memory store',
        'title': 'Memory store',
        'subtitle': 'Shared across every workspace; identical meaning only accumulates count and time, never the original sentence.',
        'filter': 'Filter objects',
        'refresh': 'Refresh',
        'refreshing': 'Refreshing…',
        'loading': 'Reading the memory store…',
        'readFailed': 'Failed to read: ',
        'retry': 'Retry',
        'lastInjection': 'Last injection: ',
        'items': 'items',
        'objects': 'Objects ({n})',
        'emptyObjects': 'No objects recorded yet.',
        'recent': 'Recent',
        'emptyRecent': 'No occurrences yet.',
        'merge': 'Merge…',
        'mergeInto': 'Merge into…',
        'confirm': 'OK',
        'cancel': 'Cancel',
        'merged': 'Merged "{from}" into "{to}"',
        'mergeFailed': 'Merge failed: ',
        'delete': 'Delete',
        'deleteConfirm': 'Delete "{name}"? All of its occurrences go with it.',
        'deleted': 'Deleted "{name}" ({n} occurrences)',
        'deleteFailed': 'Delete failed: ',
        'trash': 'Trash ({n})',
        'emptyTrash': 'The trash is empty.',
        'restore': 'Restore',
        'restored': 'Restored "{name}"',
        'restoreFailed': 'Restore failed: ',
        'export': 'Export memory',
        'embedTitle': '⚠ Semantic recall needs the bge-m3 model',
        'embedReady': 'Semantic recall is ready',
        'embedReadyHint': 'Role: it catches keyword queries like "QQ channel" and natural questions like "what did I do before".',
        'normalizerTitle': 'Memory normalization model',
        'normalizerHint': 'The model that turns conversation into memory cards. It runs every turn, so local is recommended: free and offline. This step only extracts structure, it is not reasoning — an 8B-class model is enough. Measured by the author: mimo-9b averages 3s per card with valid JSON every time, twice as fast as 14B. Cloud bills per token and spends quietly in the background.',
        'normalizerRecommend': 'Recommended: mimo-9b (author-tested, 3s per card, stable output)',
        'normalizerLocal': 'Local (recommended)',
        'normalizerCloud': 'Cloud',
        'normalizerOff': 'Off',
        'normalizerPick': 'Local model:',
        'normalizerNoPick': 'nothing selected yet — pick one above',
        'normalizerNoLocal': 'No local model on this machine; pull one first (ollama pull qwen3:4b)',
        'normalizerOffHint': 'With normalization off the raw turns are still kept, but no memory cards are built and recall falls back to keywords.',
        'embedWhat': 'bge-m3 is an embedding model: it does not chat, it turns text into vectors. Two sentences whose vectors are close mean similar things.',
        'embedWhy': 'Recall has two halves: keywords catch "QQ channel", embeddings catch "what did I do before". The second half needs bge-m3.',
        'embedWithout': 'Without it memory still works, but only literal keyword queries land — ask the right word or nothing comes back. Reinstall it after moving machines.',
        'embedHow': 'Install: ollama pull bge-m3 (about 1.2 GB)',
        'exportDone': 'Export finished — check your downloads.',
        'exportFailed': 'Export failed: ',
        'import': 'Import memory',
        'importing': 'Importing…',
        'imported': 'Imported {records} conversations, merged {merged}, skipped {dup} duplicates, {insertedEntities} objects',
        'importFailed': 'Import failed: ',
        'habits': 'Habits ({n})',
        'emptyHabits': 'Not enough keyword history yet.',
        'timeline': 'Timeline ({n})',
        'emptyTimeline': 'No full conversation records yet.',
        'archived': 'Archived ({n})',
        'emptyArchived': 'Nothing archived.',
        'unarchive': 'Restore',
        'unarchived': 'Restored "{name}"',
        'unarchiveFailed': 'Restore failed: ',
        'times': '×{n}',
        'activeHours': 'Active hours',
        'collapse': 'Collapse',
        'models': 'Local models',
        'narratives': 'What the weeks were about',
        'narrativesEmpty': 'Not a full week of history yet.',
        'backup': 'Backups',
        'backupOn': 'One automatic backup per day in {folder}, keeping the latest {keep}.',
        'backupNone': 'No backup yet — press the button to make one now.',
        'backupLast': 'Last backup: {at} · {count} on disk',
        'backupNow': 'Back up now',
        'backupDone': 'Backup written',
        'backupFailed': 'Backup failed: ',
        'usage': 'Today: {local} handled locally · {skill} run on this machine · {cloud} model turns · {skipped} duplicate injections skipped',
        'usageHint': 'Local handling costs nothing; model turns are the replies you see.',
        'modelsHint': 'Picking one makes it the default local model. Paid models and tasks that need them go to the cloud; everything else runs locally.',
        'modelsCurrent': 'Local model: {model}',
        'modelsNone': 'No local model pinned (DSH setting applies)',
        'modelsLoading': 'Loading local models…',
        'modelsEmpty': 'Nothing found. Check Ollama is running at {endpoint}.',
        'modelsPick': 'Use',
        'modelsPicked': 'Switched to {model}',
        'modelsUsing': 'in use',
        'modelsPickHint': 'These models are already installed on this machine. Pick one to switch to it.',
        'modelsLoad': 'Choose a local model',
        'modelsFailed': 'Failed: ',
        'chatFailed': 'Switch failed: ',
        'persona': 'Persona ({name})',
        'personaHint': 'A persona decides how it talks, what it cares about, and what it never does. A switch applies from the next turn.',
        'usePersona': 'Use',
        'personaEdit': 'Edit',
        'personaSave': 'Save',
        'personaCancel': 'Cancel',
        'personaReset': 'Reset',
        'personaSaved': 'Saved',
        'personaEditFailed': 'Save failed: ',
        'personaFieldName': 'Name',
        'personaFieldTone': 'Tone',
        'personaFieldValues': 'Values',
        'personaFieldAvoid': 'Never',
        'personaFieldHelp': 'How it helps',
        'relationship': 'Relationship: {stage} (closeness {warm}) · {turns} turns',
        'relationshipAddress': 'Calls you: {address}',
        'relationshipPromise': 'Open promise: {note}',
        'moodLine': 'Today: {note}',
        'proactiveOn': 'Proactive greeting: daily at {time}',
        'proactiveOff': 'Proactive greeting: off (set proactive: true to enable)',
        'personaSwitched': 'Switched to "{name}"',
        'personaFailed': 'Switch failed: ',
        'transferHint': 'Export packs the entire memory database into one zip: turns, memory cards, relationship state, habit terms and configuration. Import merges table by table and never overwrites existing rows.',
        'transferCounts': 'Ready to export: {entities} objects · {records} conversations · {keywords} habits',
        'lastImport': 'Last import: {records} new · {merged} merged · {dup} skipped',
        'chooseFile': 'Choose a memory file…',
        'expand': 'Expand',
        'stat.objects': 'Objects',
        'stat.occurrences': 'Occurrences',
        'stat.turns': 'Turns',
        'stat.tools': 'Tool calls',
        'stat.sessions': 'Sessions',
        'stat.links': 'Associations',
        'stat.queued': 'Queued',
        'sessions': 'Sessions and subagents ({n})',
        'emptySessions': 'No Sessions recorded yet.',
        'untitled': '(untitled)',
        'subagent': 'subagent',
        'reviews': 'recalled {n}×',
      },
    }

    /** Filled in by `apply`; without it, fall back to the DSH document language. */
    let translate = null

    function text(key, values) {
      let template
      if (translate !== null) {
        try {
          const value = translate(key)
          if (typeof value === 'string' && value !== '' && value !== key) template = value
        } catch {
          // A broken dictionary must not blank the page.
        }
      }
      if (template === undefined) {
        const lang = String(document.documentElement.getAttribute('lang') || navigator.language || '')
          .toLowerCase()
          .startsWith('zh') ? 'zh' : 'en'
        template = DICT[lang][key] ?? DICT.en[key] ?? key
      }
      if (values === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        values[name] === undefined ? match : String(values[name])
      ))
    }

    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      label: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    function stamp(time) {
      const date = new Date(Number(time) || 0)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function stat(label, value, tone) {
      return h('div', {
        key: label,
        style: {
          flex: '1 1 96px',
          minWidth: 96,
          padding: '10px 12px',
          borderRadius: 10,
          background: C.layer2,
          border: `1px solid ${C.border}`,
        },
      }, [
        h('div', { key: 'v', style: { fontSize: 18, fontWeight: 600, color: tone || C.label, fontVariantNumeric: 'tabular-nums' } }, String(value)),
        h('div', { key: 'l', style: { marginTop: 2, fontSize: 11, color: C.muted } }, label),
      ])
    }

    function kindTone(kind) {
      if (kind === 'preference') return C.brand
      if (kind === 'project') return C.warn
      if (kind === 'person') return C.error
      return C.muted
    }

    const textButton = (label, onClick, tone) => h('button', {
      onClick,
      style: {
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: tone || C.muted,
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    }, label)

    function EntityRow({ item, control }) {
      const detail = [item.action, item.state, item.detail]
        .filter(value => typeof value === 'string' && value !== '')
        .join(' / ')
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(96px, 168px) 84px 1fr auto minmax(72px, auto)',
          alignItems: 'baseline',
          gap: 10,
          padding: '7px 2px',
          borderBottom: `1px solid ${C.border}`,
          fontSize: 12.5,
        },
      }, [
        h('div', { key: 'name', style: { color: C.label, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.canonical),
        h('div', { key: 'kind', style: { color: kindTone(item.kind), fontSize: 11 } }, item.kind),
        h('div', { key: 'detail', style: { color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail || '—'),
        h('div', { key: 'meta', style: { color: C.muted, fontSize: 11, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } },
          `×${item.mentions} · ${stamp(item.last_seen)}${Number(item.use_count) > 0 ? ` · ${text('reviews', { n: item.use_count })}` : ''}`),
        h('div', { key: 'ctl', style: { justifySelf: 'end' } }, control),
      ])
    }

    function RecentRow({ item }) {
      const detail = [item.action, item.state, item.detail]
        .filter(value => typeof value === 'string' && value !== '')
        .join(' / ')
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '76px minmax(80px, 150px) 1fr',
          gap: 10,
          alignItems: 'baseline',
          padding: '6px 2px',
          borderBottom: `1px solid ${C.border}`,
          fontSize: 12,
        },
      }, [
        h('div', { key: 't', style: { color: C.muted, fontSize: 11 } }, stamp(item.time)),
        h('div', { key: 'n', style: { color: C.label } }, item.canonical),
        h('div', { key: 'd', style: { color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail || '—'),
      ])
    }

    function SessionRow({ item }) {
      // A subagent child is known by the name its parent gave it, not by a title.
      const isSubagent = String(item.origin) === 'subagent'
      const name = isSubagent
        ? (item.label || item.run_name || item.title || text('untitled'))
        : (item.title || text('untitled'))
      const meta = [isSubagent ? text('subagent') : null, item.outcome, stamp(item.updated_at)]
        .filter(value => typeof value === 'string' && value !== '')
        .join(' · ')
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 10,
          alignItems: 'baseline',
          padding: '6px 2px',
          borderBottom: `1px solid ${C.border}`,
          fontSize: 12,
        },
      }, [
        h('div', { key: 'n', style: { color: C.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(name)),
        h('div', { key: 'm', style: { color: isSubagent ? kindTone('person') : C.muted, fontSize: 11, whiteSpace: 'nowrap' } }, meta),
      ])
    }

    /**
     * Cards that are operated rather than read. Kept by id so every call site does not
     * have to remember the flag; anything not listed stays a quiet stat card.
     */
    const ACTION_SECTIONS = new Set(['qq', 'models', 'persona', 'transfer'])

    /**
     * One collapsible block.
     *
     * Two looks, so "settings you operate" never reads like "numbers you read":
     *  - action: brand-tinted left bar, slightly raised background, a 功能 tag
     *  - stat (default): plain, quiet, for counts and lists
     */
    function Section({ id, title, count, open, onToggle, children, empty, emptyText, variant }) {
      const action = variant === 'action' || ACTION_SECTIONS.has(id)
      return h('div', {
        style: {
          marginBottom: 14,
          borderRadius: 10,
          // Operable cards carry a blue tint; readable cards stay neutral. No left bar:
          // a rounded stripe read like a stray crescent.
          background: action ? 'rgba(86, 156, 255, 0.12)' : C.layer1,
          border: `1px solid ${action ? 'rgba(86, 156, 255, 0.45)' : C.border}`,
        },
      }, [
        h('button', {
          key: 'h',
          onClick: () => onToggle(id),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px',
            background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
            color: C.label, fontSize: 12, fontWeight: 600,
          },
        }, [
          h('span', { key: 'c', style: { color: C.muted, width: 12 } }, open ? '▾' : '▸'),
          h('span', { key: 't', style: { flex: 1, display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('span', { key: 'x' }, title),
            action
              ? h('span', {
                key: 'tag',
                style: { fontSize: 9.5, fontWeight: 500, color: C.brand, border: `1px solid ${C.brand}`, borderRadius: 4, padding: '0 4px', lineHeight: '14px' },
              }, '功能')
              : null,
          ]),
          typeof count === 'number' ? h('span', { key: 'n', style: { color: C.muted, fontWeight: 400 } }, String(count)) : null,
        ]),
        open
          ? h('div', { key: 'b', style: { padding: '0 12px 10px' } },
            empty ? h('div', { style: { fontSize: 12, color: C.muted, padding: '6px 2px' } }, emptyText) : children)
          : null,
      ])
    }

    function MemoryPanel() {
      const [state, setState] = useState({ phase: 'loading', data: null, error: null })
      const [query, setQuery] = useState('')
      const [merging, setMerging] = useState(null)
      const [target, setTarget] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      // Declared with the other hooks: this component returns early while loading,
      // so a hook after those returns would change the hook order on the next render.
      // Every foldable block starts collapsed: the page opens as a short overview and
      // the operator expands only what they came for.
      const [openSections, setOpenSections] = useState({
        narratives: false, models: false, persona: false, habits: false, sessions: false, objects: false, trash: false,
        archived: false, timeline: false, recent: false, transfer: false,
      })
      const [importing, setImporting] = useState(false)
      const [personaBusy, setPersonaBusy] = useState(false)
      const [modelBusy, setModelBusy] = useState(false)
      const [localModels, setLocalModels] = useState(null)
      const [modelError, setModelError] = useState(null)
      const [editingPersona, setEditingPersona] = useState(null)
      const [personaDraft, setPersonaDraft] = useState({})
      // Follow the real loop: the switch is not authoritative on its own.
      // QQ channel: configuration lives on the Host, this is only the edit buffer.
      const [exporting, setExporting] = useState(false)
      const [normalizerDraft, setNormalizerDraft] = useState(null)
      const [normalizerSaving, setNormalizerSaving] = useState(false)
      const [qq, setQq] = useState(null)
      const [qqDraft, setQqDraft] = useState(null)
      const [qqSaving, setQqSaving] = useState(false)
      const [qqNote, setQqNote] = useState(null)
      // Cloud models come from the live llm registry, not a hard-coded list.
      const [cloudModels, setCloudModels] = useState(null)
      const [cloudBusy, setCloudBusy] = useState(false)
      const loadCloudModels = useCallback(async () => {
        try {
          const response = await fetch('/dsh-memory/cloudmodels', { cache: 'no-store' })
          const payload = await response.json()
          setCloudModels(Array.isArray(payload?.models) ? payload.models : [])
        } catch {
          setCloudModels([])
        }
      }, [])
      const pickPaidModel = async (provider, model) => {
        if (cloudBusy) return
        setCloudBusy(true)
        try {
          const response = await fetch('/dsh-memory/paidmodel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider, model, activate: true }),
          })
          const payload = await response.json()
          setNote(payload?.ok === true ? `已切到 ${model}` : String(payload?.error ?? '切换失败'))
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error))
        } finally {
          setCloudBusy(false)
        }
      }
      const loadQq = useCallback(async () => {
        try {
          const response = await fetch('/dsh-memory/qq', { cache: 'no-store' })
          if (!response.ok) return
          const payload = await response.json()
          if (payload?.ok !== true) return
          setQq(payload)
          setQqDraft(current => current ?? {
            botUin: String(payload.config?.botUin ?? ''),
            userUin: String(payload.config?.userUin ?? ''),
            enabled: payload.config?.enabled === true,
            localModel: String(payload.config?.localModel ?? ''),
            localSwitch: payload.config?.localSwitch === true,
            workspace: String(payload.config?.workspace ?? ''),
          })
        } catch {
          // The panel shows "未连接" instead.
        }
      }, [])
      useEffect(() => {
        void loadQq()
        const timer = window.setInterval(() => void loadQq(), 5000)
        return () => window.clearInterval(timer)
      }, [loadQq])
      const saveNormalizer = async patch => {
        // Only the changed fields: the host keeps whatever is not sent.
        const next = { ...(normalizerDraft ?? {}), ...patch }
        setNormalizerDraft(next)
        setNormalizerSaving(true)
        try {
          const response = await fetch('/dsh-memory/normalizer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const payload = await response.json()
          if (payload?.ok === true) {
            setNote(null)
            await load()
          } else {
            setNote(payload?.error ?? 'save failed')
          }
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error))
        } finally {
          setNormalizerSaving(false)
        }
      }

      const saveQq = async patch => {
        const next = { ...(qqDraft ?? {}), ...patch }
        setQqDraft(next)
        setQqSaving(true)
        try {
          const response = await fetch('/dsh-memory/qq', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const payload = await response.json()
          if (payload?.ok === true) {
            setQq(payload)
            setQqNote(null)
          } else {
            setQqNote(payload?.error ?? 'save failed')
          }
        } catch (error) {
          setQqNote(error instanceof Error ? error.message : String(error))
        } finally {
          setQqSaving(false)
        }
      }
      const toggleSection = id => setOpenSections(current => ({ ...current, [id]: !current[id] }))

      const load = useCallback(async () => {
        setState(current => ({ ...current, phase: current.data === null ? 'loading' : 'refreshing' }))
        try {
          const response = await fetch(PANEL_ROUTE, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || 'invalid payload')
          setState({ phase: 'ready', data: payload, error: null })
        } catch (error) {
          setState({ phase: 'failed', data: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const data = state.data
      const entities = useMemo(() => {
        const list = Array.isArray(data?.entities) ? data.entities : []
        const needle = query.trim().toLowerCase()
        if (needle === '') return list
        return list.filter(item => String(item.canonical).toLowerCase().includes(needle))
      }, [data, query])

      const recent = Array.isArray(data?.recent) ? data.recent : []
      const trash = Array.isArray(data?.trash) ? data.trash : []
      const sessions = Array.isArray(data?.sessions) ? data.sessions : []
      const stats = data?.stats ?? {}

      const submitMerge = async () => {
        if (merging === null || target === '' || busy) return
        setBusy(true)
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/merge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ from: merging, into: target }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('merged', { from: merging, to: target }))
          setMerging(null)
          setTarget('')
          await load()
        } catch (error) {
          setNote(`${text('mergeFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const submitDelete = async name => {
        if (busy) return
        const question = text('deleteConfirm', { name })
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) return
        setBusy(true)
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ canonical: name }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('deleted', { name, n: Number(payload.occurrences) || 0 }))
          setMerging(null)
          await load()
        } catch (error) {
          setNote(`${text('deleteFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const submitRestore = async name => {
        if (busy) return
        setBusy(true)
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ canonical: name }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('restored', { name }))
          await load()
        } catch (error) {
          setNote(`${text('restoreFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const loadModels = async (force = false) => {
        if (localModels !== null && !force) return
        setLocalModels([])
        try {
          const response = await fetch('/dsh-memory/models', { cache: 'no-store' })
          const payload = await response.json()
          setModelError(typeof payload?.error === 'string' ? payload.error : null)
          setLocalModels(Array.isArray(payload?.models) ? payload.models : [])
        } catch {
          setLocalModels([])
        }
      }

      // The list loads itself as soon as the panel data is in; the old "choose a
      // model" button was one click of pure ceremony.
      useEffect(() => {
        if (state.data !== null && localModels === null) void loadModels()
      }, [state.data, localModels])

      useEffect(() => {
        if (state.data !== null && cloudModels === null) void loadCloudModels()
      }, [state.data, cloudModels, loadCloudModels])

      const submitModel = async (model, cloudOnce = false) => {
        if (modelBusy) return
        setModelBusy(true)
        setNote(null)
        try {
          const response = await fetch(cloudOnce ? '/dsh-memory/cloudonce' : '/dsh-memory/pickmodel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(cloudOnce ? {} : { model }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(cloudOnce ? text('modelsCloudOnceHint') : text('modelsPicked', { model }))
          await load()
        } catch (error) {
          setNote(`${text('modelsFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setModelBusy(false)
        }
      }

      const startPersonaEdit = option => {
        setEditingPersona(option.id)
        setPersonaDraft({
          name: option.edit?.name ?? option.name ?? '',
          tone: option.edit?.tone ?? '',
          values: option.edit?.values ?? '',
          avoid: option.edit?.avoid ?? '',
          help: option.edit?.help ?? '',
        })
      }

      const savePersonaEdit = async id => {
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/persona/edit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ id, fields: personaDraft }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('personaSaved'))
          setEditingPersona(null)
          await load()
        } catch (error) {
          setNote(`${text('personaEditFailed')}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const submitBackup = async () => {
        if (modelBusy) return
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/backup', { method: 'POST', cache: 'no-store' })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('backupDone'))
          await load()
        } catch (error) {
          setNote(`${text('backupFailed')}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const submitPersona = async id => {
        if (personaBusy) return
        setPersonaBusy(true)
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/persona', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ id }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('personaSwitched', { name: id }))
          await load()
        } catch (error) {
          setNote(`${text('personaFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setPersonaBusy(false)
        }
      }

      const submitUnarchive = async name => {
        if (busy) return
        setBusy(true)
        setNote(null)
        try {
          const response = await fetch('/dsh-memory/unarchive', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ canonical: name }),
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('unarchived', { name }))
          await load()
        } catch (error) {
          setNote(`${text('unarchiveFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const controlFor = item => {
        if (merging !== item.canonical) {
          return h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, [
            textButton(text('merge'), () => {
              setMerging(item.canonical)
              setTarget('')
              setNote(null)
            }),
            textButton(text('delete'), () => void submitDelete(item.canonical), C.danger ?? C.label),
          ])
        }
        const others = (Array.isArray(data?.entities) ? data.entities : [])
          .map(entry => entry.canonical)
          .filter(name => name !== item.canonical)
        return h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, [
          h('select', {
            key: 's',
            value: target,
            onChange: event => setTarget(event.target.value),
            style: {
              height: 22,
              maxWidth: 148,
              borderRadius: 6,
              border: `1px solid ${C.borderStrong}`,
              background: C.layer1,
              color: C.label,
              fontSize: 11,
            },
          }, [
            h('option', { key: '', value: '' }, text('mergeInto')),
            ...others.map(name => h('option', { key: name, value: name }, name)),
          ]),
          textButton(busy ? '…' : text('confirm'), () => void submitMerge(), C.brand),
          textButton(text('cancel'), () => { setMerging(null); setTarget('') }),
        ])
      }

      const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 } }, [
        h('div', { key: 'title', style: { flex: 1 } }, [
          h('div', { key: 't', style: { fontSize: 15, fontWeight: 600, color: C.label } }, text('title')),
          h('div', { key: 's', style: { marginTop: 3, fontSize: 11.5, color: C.muted } }, text('subtitle')),
        ]),
        h('button', {
          key: 'export',
          onClick: async () => {
            if (exporting) return
            setExporting(true)
            setNote(null)
            try {
              const response = await fetch('/dsh-memory/export', { cache: 'no-store' })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              const blob = await response.blob()
              const url = URL.createObjectURL(blob)
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = 'dsh-memory.zip'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
              URL.revokeObjectURL(url)
              setNote(text('exportDone'))
            } catch (error) {
              setNote(`${text('exportFailed')}${error instanceof Error ? error.message : String(error)}`)
            } finally {
              setExporting(false)
            }
          },
          disabled: exporting,
          style: {
            fontSize: 11.5, color: C.brand, background: 'transparent', border: 'none',
            padding: 0, cursor: exporting ? 'default' : 'pointer', whiteSpace: 'nowrap',
          },
        }, exporting ? '…' : text('export')),
        h('input', {
          key: 'q',
          value: query,
          placeholder: text('filter'),
          onChange: event => setQuery(event.target.value),
          style: {
            width: 168,
            height: 30,
            padding: '0 10px',
            borderRadius: 8,
            border: `1px solid ${C.borderStrong}`,
            background: C.layer1,
            color: C.label,
            fontSize: 12,
            outline: 'none',
          },
        }),
        h('button', {
          key: 'r',
          onClick: () => void load(),
          style: {
            height: 30,
            padding: '0 12px',
            borderRadius: 8,
            border: `1px solid ${C.borderStrong}`,
            background: C.layer1,
            color: C.label,
            fontSize: 12,
            cursor: 'pointer',
          },
        }, state.phase === 'refreshing' ? text('refreshing') : text('refresh')),
      ])

      if (state.phase === 'loading') {
        return h('div', { style: { padding: 4, color: C.muted, fontSize: 12.5 } }, text('loading'))
      }
      if (state.phase === 'failed') {
        return h('div', { style: { padding: 4, fontSize: 12.5 } }, [
          h('div', { key: 'e', style: { color: C.error, marginBottom: 8 } }, `${text('readFailed')}${state.error ?? ''}`),
          textButton(text('retry'), () => void load(), C.label),
        ])
      }

      // Every heavy list is folded by default so the page opens compact.
      const submitImport = async event => {
        const file = event?.target?.files?.[0]
        if (file === undefined || file === null || importing) return
        setImporting(true)
        setNote(null)
        try {
          const bytes = await file.arrayBuffer()
          const response = await fetch('/dsh-memory/import', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            cache: 'no-store',
            body: bytes,
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`)
          setNote(text('imported', {
            records: payload.insertedRecords ?? 0,
            merged: payload.mergedRecords ?? 0,
            dup: payload.duplicateRecords ?? 0,
            insertedEntities: payload.insertedEntities ?? 0,
          }))
          await load()
        } catch (error) {
          setNote(`${text('importFailed')}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setImporting(false)
          if (event?.target) event.target.value = ''
        }
      }

      const archived = Array.isArray(data?.archived) ? data.archived : []
      const timeline = Array.isArray(data?.timeline) ? data.timeline : []
      const habits = Array.isArray(data?.habits) ? data.habits : []
      const activeHours = Array.isArray(data?.activeHours) ? data.activeHours : []
      const style = data?.style ?? null

      const injected = (() => {
        if (typeof stats.injected !== 'string') return null
        try { return JSON.parse(stats.injected) } catch { return null }
      })()

      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
        marginBottom: 4, borderRadius: 8, background: C.layer2,
        border: `1px solid ${C.border}`, fontSize: 12, color: C.muted,
      }
      const faded = { flex: 1, textDecoration: 'line-through' }

      // Semantic recall is only real when the configured embedding model is actually
      // installed; otherwise the notice explains what is missing.
      const embedName = String(data?.embedModel ?? '').trim()
      const embedReady = embedName !== ''
        && Array.isArray(localModels)
        && localModels.some(model => model.id === embedName || model.id === embedName.replace(/:latest$/, ''))

      return h('div', { style: { padding: '2px 2px 24px', background: C.base, color: C.label } }, [
        header,
        embedReady
          ? h('div', {
            key: 'embedOk',
            style: {
              marginBottom: 14,
              padding: '10px 14px',
              borderRadius: 10,
              background: C.layer2,
              border: `1px solid ${C.ok}`,
              fontSize: 11.5,
              color: C.label,
              lineHeight: 1.7,
            },
          }, [
            h('div', {
              key: 't',
              style: { fontSize: 12.5, fontWeight: 700, color: C.ok, marginBottom: 4 },
            }, `✓ ${text('embedReady')}（${embedName}）`),
            h('div', { key: 'why', style: { color: C.muted } }, text('embedWhat')),
            h('div', { key: 'role', style: { color: C.muted } }, text('embedReadyHint')),
          ])
          // The semantic half of recall depends on an embedding model that is easy to
          // forget on a new machine, so say it plainly at the top instead of hiding it
          // in a settings hint.
          : h('div', {
          key: 'embedNotice',
          style: {
            marginBottom: 14,
            padding: '12px 14px',
            borderRadius: 10,
            background: C.layer2,
            border: `1px solid ${C.warn}`,
            fontSize: 11.5,
            color: C.label,
            lineHeight: 1.75,
          },
        }, [
          h('div', {
            key: 't',
            style: { fontSize: 12.5, fontWeight: 700, color: C.warn, marginBottom: 6 },
          }, text('embedTitle')),
          h('div', { key: 'what', style: { marginBottom: 4 } }, text('embedWhat')),
          h('div', { key: 'why', style: { marginBottom: 4 } }, text('embedWhy')),
          h('div', { key: 'without', style: { marginBottom: 4, color: C.muted } }, text('embedWithout')),
          h('div', { key: 'how', style: { fontFamily: 'ui-monospace, monospace', color: C.brand } }, text('embedHow')),
        ]),
          h('div', {
          key: 'normalizer',
          style: { marginTop: 14, marginBottom: 14, padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.layer1 },
        }, [
          h('div', { key: 't', style: { fontSize: 12.5, fontWeight: 700, color: C.label, marginBottom: 4 } }, text('normalizerTitle')),
          h('div', { key: 'h', style: { fontSize: 11.5, color: C.muted, lineHeight: 1.7, marginBottom: 6 } }, text('normalizerHint')),
          h('div', { key: 'rec', style: { fontSize: 11.5, color: C.ok, fontWeight: 600, marginBottom: 8 } }, text('normalizerRecommend')),
          (() => {
            const config = normalizerDraft ?? data?.normalizer ?? {}
            const mode = String(config.mode ?? 'local')
            const picked = String(config.model ?? '')
            const modeButton = (id, label, color) => h('button', {
              key: id,
              onClick: () => void saveNormalizer({ mode: id }),
              disabled: normalizerSaving,
              style: {
                height: 28, padding: '0 12px', borderRadius: 8, fontSize: 11.5, cursor: 'pointer',
                border: `${mode === id ? 2 : 1}px solid ${mode === id ? color : C.border}`,
                background: mode === id ? C.layer2 : C.base,
                color: mode === id ? color : C.label,
                fontWeight: mode === id ? 700 : 400,
              },
            }, label)
            return [
              h('div', { key: 'modes', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } }, [
                modeButton('local', text('normalizerLocal'), C.ok),
                modeButton('cloud', text('normalizerCloud'), C.warn),
                modeButton('off', text('normalizerOff'), C.muted),
              ]),
              mode === 'local'
                ? (Array.isArray(localModels) && localModels.length > 0
                  ? h('div', { key: 'pick', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                    h('span', { key: 'l', style: { fontSize: 11.5, color: C.label } }, text('normalizerPick')),
                    h('select', {
                      key: 's',
                      value: picked,
                      onChange: event => void saveNormalizer({ model: event.target.value }),
                      style: {
                        height: 28, padding: '0 8px', borderRadius: 8, fontSize: 11.5,
                        background: C.layer2, color: C.label, border: `1px solid ${C.border}`,
                      },
                    }, localModels.map(model => h('option', { key: model.id, value: model.id }, `${model.id}（${model.sizeGb} GB）`))),
                    picked === ''
                      ? h('span', { key: 'n', style: { fontSize: 11, color: C.warn } }, text('normalizerNoPick'))
                      : null,
                  ])
                  : h('div', { key: 'none', style: { fontSize: 11.5, color: C.warn } }, text('normalizerNoLocal')))
                : null,
              mode === 'off'
                ? h('div', { key: 'offhint', style: { fontSize: 11, color: C.muted, lineHeight: 1.6 } }, text('normalizerOffHint'))
                : null,
            ]
          })(),
        ]),
        h('div', { key: 'stats', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } }, [
          stat(text('stat.objects'), stats.entities ?? 0),
          stat(text('stat.occurrences'), stats.occurrences ?? 0),
          stat(text('stat.sessions'), stats.sessions ?? 0),
          stat(text('stat.turns'), stats.turns ?? 0),
          stat(text('stat.tools'), stats.toolCalls ?? 0),
          stat(text('stat.links'), stats.links ?? 0),
          stat(text('stat.queued'), stats.pending ?? 0, (stats.pending ?? 0) > 0 ? C.warn : C.muted),
        ]),
        data?.usage === null || data?.usage === undefined ? null : h('div', {
          key: 'usage',
          style: { marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}` },
        }, [
          h('div', { key: 'a', style: { fontSize: 11.5, color: C.label } }, text('usage', {
            local: (data.usage.local ?? 0) + (data.usage.recall ?? 0),
            skill: data.usage.skill ?? 0,
            cloud: data.usage.cloud ?? 0,
            skipped: data.usage.skipped ?? 0,
          })),
          h('div', { key: 'b', style: { fontSize: 11, color: C.muted, marginTop: 3 } }, text('usageHint')),
        ]),

        injected === null ? null : h('div', {
          key: 'inj',
          style: { marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}`, fontSize: 11.5, color: C.muted } },
          `${text('lastInjection')}${injected.items} ${text('items')} / ${injected.tokens} token — ${(injected.names || []).join('、')}`),
        note === null ? null : h('div', {
          key: 'note',
          style: { marginBottom: 12, padding: '7px 12px', borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}`, fontSize: 11.5, color: C.label } },
          note),

        qq?.config?.enabled === true ? h('div', {
          key: 'qq-critical-banner',
          style: {
            marginBottom: 12, padding: '10px 12px', borderRadius: 10,
            border: `2px solid ${C.warn}`, background: C.layer2,
            color: C.warn, fontSize: 12.5, fontWeight: 700, lineHeight: 1.8,
          },
        }, '⚠️ QQ 通道正在运行：机器人账号必须把「和你的 QQ 对话窗口」打开，并一直留在桌面。不能把该对话单独拉成独立窗口，否则不生效。') : null,

        h(Section, {
          key: 'qq', id: 'qq',
          title: `QQ 通道 · ${qq?.config?.enabled === true ? '开' : '关'}`,
          open: openSections.qq === true, onToggle: toggleSection,
        }, h('div', { key: 'b' }, [
          h('div', {
            key: 'critical',
            style: {
              marginBottom: 10, padding: '10px 12px', borderRadius: 10,
              border: `2px solid ${C.warn}`, background: C.layer2,
              color: C.warn, fontSize: 12.5, fontWeight: 700, lineHeight: 1.8,
            },
          }, '⚠️ 重要：机器人账号必须把「和你的 QQ 对话窗口」打开，并一直留在桌面。不能把该对话单独拉成独立窗口，否则 QQ 通道不生效（读不到消息，也不会回复）。'),
          h('div', { key: 'hint', style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.7 } },
            '通过界面自动化操作 QQ 客户端：收发文字、识别对方发来的语音。本地模型和付费模型各有独立会话，互不干扰。QQ 需要保持登录。'),
          h('div', { key: 'state', style: { fontSize: 11.5, color: qq?.status?.online === true ? C.brand : C.warn, marginBottom: 10 } },
            qq === null
              ? '未连接 Host'
              : qq.status?.online === true
                ? `在线 · 最近读取 ${new Date(Number(qq.status.lastRead) || Date.now()).toLocaleTimeString()}`
                : `离线${qq.status?.lastError ? ' · ' + String(qq.status.lastError) : ''}`),
          h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 } }, [
            h('div', { key: 'bot', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
              h('span', { key: 'l', style: { width: 96, fontSize: 12, color: C.muted } }, '机器人 QQ 号'),
              h('input', {
                key: 'i',
                value: String(qqDraft?.botUin ?? ''),
                placeholder: '发消息用的号',
                onChange: event => setQqDraft(current => ({ ...(current ?? {}), botUin: event.target.value })),
                style: { flex: 1, padding: '7px 10px', fontSize: 13, borderRadius: 8, border: `1px solid ${C.border}`, background: C.base, color: C.label },
              }),
            ]),
            h('div', { key: 'user', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
              h('span', { key: 'l', style: { width: 96, fontSize: 12, color: C.muted } }, '你的 QQ 号'),
              h('input', {
                key: 'i',
                value: String(qqDraft?.userUin ?? ''),
                placeholder: '只接收这个号的消息',
                onChange: event => setQqDraft(current => ({ ...(current ?? {}), userUin: event.target.value })),
                style: { flex: 1, padding: '7px 10px', fontSize: 13, borderRadius: 8, border: `1px solid ${C.border}`, background: C.base, color: C.label },
              }),
            ]),
            h('div', { key: 'ws', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
              h('span', { key: 'l', style: { width: 96, fontSize: 12, color: C.muted } }, '会话工作区'),
              h('input', {
                key: 'i',
                value: String(qqDraft?.workspace ?? ''),
                placeholder: '留空则用 DSH 默认工作区（QQ 会话在这个目录里跑）',
                onChange: event => setQqDraft(current => ({ ...(current ?? {}), workspace: event.target.value })),
                style: { flex: 1, padding: '7px 10px', fontSize: 13, borderRadius: 8, border: `1px solid ${C.border}`, background: C.base, color: C.label },
              }),
            ]),
          ]),
          h('div', { key: 'bar', style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } }, [
            textButton(
              qqDraft?.enabled === true ? '停用 QQ 通道' : '启用 QQ 通道',
              () => void saveQq({ enabled: qqDraft?.enabled !== true }),
              qqDraft?.enabled === true ? C.warn : C.brand,
            ),
            textButton('保存', () => void saveQq({}), C.brand),
            qqSaving ? h('span', { key: 's', style: { fontSize: 11, color: C.muted } }, '保存中…') : null,
            qqNote === null ? null : h('span', { key: 'e', style: { fontSize: 11, color: C.warn } }, String(qqNote)),
          ]),
        ])),

        h(Section, {
          key: 'models', id: 'models', title: text('models'),
          open: openSections.models === true, onToggle: toggleSection,
        }, h('div', { key: 'b' }, [
          h('div', { key: 'hint', style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.7 } }, text('modelsHint')),
          h('div', { key: 'pick', style: { fontSize: 11.5, color: C.label, marginBottom: 8 } }, text('modelsPickHint')),
          h('div', { key: 'currow', style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } }, [
            h('div', { key: 'cur', style: { flex: 1, fontSize: 11.5, color: C.label } },
              data?.models?.local === null || data?.models?.local === undefined
                ? text('modelsNone')
                : text('modelsCurrent', { model: String(data.models.local.model ?? '') })),
            // Pulling a model in another window must not require reloading the page.
            textButton('刷新列表', () => {
              void loadModels(true)
            }, C.muted),
          ]),
          localModels === null
            ? h('div', { key: 'loading', style: { fontSize: 11.5, color: C.muted, marginTop: 4 } }, text('modelsLoading'))
            : localModels.length === 0
              ? h('div', { key: 'empty', style: { fontSize: 11.5, color: C.warn, lineHeight: 1.6 } }, [
                h('div', { key: 'm' }, text('modelsEmpty', { endpoint: String(data?.models?.endpoint ?? '') })),
                modelError === null ? null : h('div', { key: 'e', style: { color: C.muted, marginTop: 3 } }, modelError),
              ])
              : h('div', { key: 'list' }, localModels.map(model => {
                const active = model.id === data?.models?.local?.model
                return h('div', {
                  key: model.id,
                  style: {
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginBottom: 6,
                    borderRadius: 8, background: active ? C.layer2 : C.base,
                    border: `${active ? 2 : 1}px solid ${active ? C.brand : C.border}`,
                  },
                }, [
                  h('span', { key: 'n', style: { flex: 1, fontSize: 12.5, fontWeight: active ? 700 : 400, color: C.label } }, model.id),
                  h('span', { key: 'kind', style: { fontSize: 10.5, color: C.ok, fontWeight: 600 } }, '本地 · 免费'),
                  h('span', { key: 's', style: { fontSize: 11, color: C.muted } }, `${model.sizeGb} GB`),
                  active
                    ? h('span', {
                      key: 'a',
                      style: { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: C.base, background: C.brand },
                    }, text('modelsUsing'))
                    : textButton(modelBusy ? '…' : text('modelsPick'), () => void submitModel(model.id), C.brand),
                ])
              })),
          h('div', { key: 'cloudlist', style: { marginTop: 14 } }, [
            h('div', { key: 't', style: { fontSize: 12.5, fontWeight: 700, color: C.label, marginBottom: 4 } }, '云端 API 模型（实时）'),
            h('div', { key: 'h', style: { fontSize: 11, color: C.muted, marginBottom: 6, lineHeight: 1.6 } },
              '这些是 API 模型；右侧标明官方/第三方和付费/免费。切换即生效并记住。'),
            cloudModels === null
              ? h('div', { key: 'l', style: { fontSize: 11.5, color: C.muted } }, '正在读取…')
              : cloudModels.length === 0
                ? h('div', { key: 'e', style: { fontSize: 11.5, color: C.muted } }, '没有可用的云端模型')
                : h('div', { key: 'l' }, cloudModels.map(model => {
                  const active = data?.models?.paid?.provider === model.provider && data?.models?.paid?.model === model.id
                  return h('div', {
                    key: model.provider + '/' + model.id,
                    style: {
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', marginBottom: 5,
                      borderRadius: 8, background: active ? C.layer2 : C.base,
                      border: `${active ? 2 : 1}px solid ${active ? C.brand : C.border}`,
                    },
                  }, [
                    h('span', { key: 'n', style: { flex: 1, fontSize: 12.5, fontWeight: active ? 700 : 400, color: C.label } }, model.name),
                    h('span', {
                      key: 'p',
                      style: { fontSize: 10.5, color: C.muted, textAlign: 'right', lineHeight: 1.5 },
                    }, [
                      h('span', { key: 'provider' }, model.providerName),
                      h('span', { key: 'sep1' }, ' · '),
                      h('span', { key: 'kind' }, model.kind ?? 'API'),
                      h('span', { key: 'sep2' }, ' · '),
                      h('span', {
                        key: 'billing',
                        style: { color: model.billing === '免费' ? C.ok : C.warn, fontWeight: 600 },
                      }, model.billing ?? '付费'),
                    ]),
                    active
                      ? h('span', { key: 'a', style: { fontSize: 11, fontWeight: 600, color: C.brand } }, '使用中')
                      : textButton(cloudBusy ? '…' : '切换', () => void pickPaidModel(model.provider, model.id), C.brand),
                  ])
                })),
          ]),
          h('div', {
            key: 'localswitch',
            style: { marginTop: 14, padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.layer1 },
          }, [
            h('div', { key: 't', style: { fontSize: 12.5, fontWeight: 700, color: C.label, marginBottom: 4 } }, '自动切换本地模型'),
            h('div', { key: 'h', style: { fontSize: 11.5, color: C.muted, lineHeight: 1.7, marginBottom: 8 } },
              '开启后，每轮对话结束自动切回本地模型；本机没有本地模型时不可开启，也不会切换。QQ 命令：开启自动切换本地模型 / 关闭自动切换本地模型。'),
            h('div', { key: 'b', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
              textButton(
                qqDraft?.localSwitch === true ? '关闭自动切换' : '开启自动切换',
                () => void saveQq({ localSwitch: qqDraft?.localSwitch !== true }),
                qqDraft?.localSwitch === true ? C.warn : C.brand,
              ),
              h('span', { key: 's', style: { fontSize: 11.5, color: qqDraft?.localSwitch === true ? C.brand : C.muted } },
                qqDraft?.localSwitch === true ? '当前：开' : '当前：关'),
              String(data?.models?.local?.model ?? '') === ''
                ? h('span', { key: 'n', style: { fontSize: 11, color: C.warn } }, '本机没有本地模型')
                : null,
            ]),
          ]),
        ])),

        h(Section, {
          key: 'persona', id: 'persona',
          title: text('persona', { name: data?.persona?.options?.find(option => option.id === data.persona.active)?.name ?? '' }),
          open: openSections.persona === true, onToggle: toggleSection,
        }, h('div', { key: 'b' }, [
          h('div', { key: 'hint', style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.6 } }, text('personaHint')),
          data?.relationship === null || data?.relationship === undefined ? null : h('div', {
            key: 'rel',
            style: { marginBottom: 10, padding: '7px 10px', borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}`, fontSize: 11.5, color: C.label },
          }, [
            h('div', { key: 'r' }, text('relationship', {
              stage: data.relationship.stage ?? '',
              warm: data.relationship.warm ?? 0,
              turns: data.relationship.turns ?? 0,
            })),
            data.relationship.address === null || data.relationship.address === undefined ? null : h('div', {
              key: 'a', style: { color: C.muted, marginTop: 3 },
            }, text('relationshipAddress', { address: data.relationship.address })),
            data?.proactive === null || data?.proactive === undefined ? null : h('div', {
              key: 'p', style: { color: C.muted, marginTop: 3 },
            }, data.proactive.enabled === true
              ? text('proactiveOn', { time: data.proactive.time })
              : text('proactiveOff')),
            data?.mood === null || data?.mood === undefined ? null : h('div', {
              key: 'm', style: { color: C.muted, marginTop: 3 },
            }, text('moodLine', { note: String(data.mood.note ?? '') })),
            Array.isArray(data.relationship.promises) && data.relationship.promises.length > 0 ? h('div', {
              key: 'promise', style: { color: C.muted, marginTop: 3 },
            }, text('relationshipPromise', { note: data.relationship.promises[0].note })) : null,
          ]),
          editingPersona === null ? null : h('div', {
            key: 'personaEditor',
            style: { marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: C.layer2, border: `1px solid ${C.brand}` },
          }, [
            ...[
              ['name', text('personaFieldName')],
              ['tone', text('personaFieldTone')],
              ['values', text('personaFieldValues')],
              ['avoid', text('personaFieldAvoid')],
              ['help', text('personaFieldHelp')],
            ].map(([field, label]) => h('label', {
              key: field,
              style: { display: 'block', marginBottom: 8 },
            }, [
              h('div', { key: 'l', style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, label),
              h('textarea', {
                key: 'i',
                rows: field === 'name' ? 1 : 2,
                value: personaDraft[field] ?? '',
                onChange: event => setPersonaDraft(current => ({ ...current, [field]: event.target.value })),
                placeholder: text('personaFieldTone'),
                style: {
                  width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '6px 8px',
                  borderRadius: 6, border: `1px solid ${C.border}`, background: C.base, color: C.label,
                  resize: 'vertical', fontFamily: 'inherit',
                },
              }),
            ])),
            h('div', { key: 'actions', style: { display: 'flex', gap: 10, marginTop: 4 } }, [
              textButton(text('personaSave'), () => void savePersonaEdit(editingPersona), C.brand),
              textButton(text('personaCancel'), () => setEditingPersona(null), C.muted),
            ]),
          ]),

          ...(data?.persona?.options ?? []).map(option => h('div', {
            key: option.id,
            style: {
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', marginBottom: 4,
              borderRadius: 8, background: option.id === data?.persona?.active ? C.layer2 : 'transparent',
              border: `1px solid ${option.id === data?.persona?.active ? C.brand : C.border}`,
            },
          }, [
            h('span', { key: 'n', style: { width: 76, color: C.label, fontSize: 12, fontWeight: 600 } }, option.name),
            h('span', { key: 's', style: { flex: 1, color: C.muted, fontSize: 11.5 } }, option.summary),
            option.id === data?.persona?.active
              ? h('span', { key: 'a', style: { fontSize: 11.5, color: C.brand } }, '●')
              : textButton(personaBusy ? '…' : text('usePersona'), () => void submitPersona(option.id), C.brand),
            textButton(text('personaEdit'), () => startPersonaEdit(option), C.muted),
          ])),
        ])),

        h(Section, {
          key: 'narratives', id: 'narratives', title: text('narratives'),
          open: openSections.narratives === true, onToggle: toggleSection,
        }, (data?.narratives ?? []).length === 0
          ? h('div', { style: { fontSize: 11.5, color: C.muted } }, text('narrativesEmpty'))
          : h('div', { key: 'l' }, (data?.narratives ?? []).map(item => h('div', {
            key: item.week,
            style: { padding: '7px 10px', marginBottom: 4, borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}`, fontSize: 11.5, color: C.label, lineHeight: 1.6 },
          }, String(item.text ?? ''))))),

        h(Section, {
          key: 'habits', id: 'habits', title: text('habits', { n: habits.length }), count: habits.length,
          open: openSections.habits, onToggle: toggleSection,
          empty: habits.length === 0, emptyText: text('emptyHabits'),
        }, [
          style !== null && style.ready === true
            ? h('div', {
              key: 'style',
              style: { marginBottom: 8, padding: '7px 10px', borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}`, fontSize: 11.5, color: C.label },
            }, [
              h('div', { key: 'a' }, `风格：${(style.labels || []).join('、')}（${style.messages} 条消息）`),
              h('div', { key: 'b', style: { color: C.muted, marginTop: 3 } },
                `平均 ${style.metrics?.chars ?? 0} 字 · 感叹 ${Number(style.metrics?.exclam ?? 0).toFixed(2)}/条 · 省略 ${Number(style.metrics?.ellipsis ?? 0).toFixed(2)}/条 · 礼貌 ${Number(style.metrics?.polite ?? 0).toFixed(2)}/条`),
            ])
            : h('div', { key: 'style', style: { marginBottom: 8, fontSize: 11.5, color: C.muted } },
              `风格：还需要更多对话（${style?.messages ?? 0}/20）`),
          h('div', { key: 'l' }, habits.map((item, index) => h('div', {
            key: `h-${index}`, style: rowStyle,
          }, [
            h('span', { key: 't', style: { flex: 1, color: C.label } }, String(item.term)),
            h('span', { key: 'c' }, text('times', { n: Number(item.count) || 0 })),
          ]))),
          activeHours.length === 0 ? null : h('div', {
            key: 'hours', style: { marginTop: 8, fontSize: 11.5, color: C.muted },
          }, `${text('activeHours')}：${activeHours.map(row => `${row.hour}:00×${row.turns}`).join('  ')}`),
        ]),

        h(Section, {
          key: 'objects', id: 'objects', title: text('objects', { n: entities.length }), count: entities.length,
          open: openSections.objects, onToggle: toggleSection,
          empty: entities.length === 0, emptyText: text('emptyObjects'),
        }, h('div', { key: 'l' }, entities.map((item, index) => h(EntityRow, {
          key: `${item.canonical}-${index}`,
          item,
          control: controlFor(item),
        })))),

        h(Section, {
          key: 'sessions', id: 'sessions', title: text('sessions', { n: sessions.length }), count: sessions.length,
          open: openSections.sessions, onToggle: toggleSection,
          empty: sessions.length === 0, emptyText: text('emptySessions'),
        }, h('div', { key: 'l' }, sessions.map((item, index) => h(SessionRow, { key: `s-${index}`, item })))),

        h(Section, {
          key: 'trash', id: 'trash', title: text('trash', { n: trash.length }), count: trash.length,
          open: openSections.trash, onToggle: toggleSection,
          empty: trash.length === 0, emptyText: text('emptyTrash'),
        }, h('div', { key: 'l' }, trash.map((item, index) => h('div', {
          key: `t-${index}`, style: rowStyle,
        }, [
          h('span', { key: 'n', style: faded }, String(item.canonical)),
          h('span', { key: 'c', style: { fontSize: 11 } }, String(item.occurrences ?? 0)),
          textButton(busy ? '…' : text('restore'), () => void submitRestore(String(item.canonical)), C.brand),
        ])))),

        h(Section, {
          key: 'archived', id: 'archived', title: text('archived', { n: archived.length }), count: archived.length,
          open: openSections.archived, onToggle: toggleSection,
          empty: archived.length === 0, emptyText: text('emptyArchived'),
        }, h('div', { key: 'l' }, archived.map((item, index) => h('div', {
          key: `a-${index}`, style: rowStyle,
        }, [
          h('span', { key: 'n', style: { flex: 1 } }, String(item.canonical)),
          h('span', { key: 'k', style: { fontSize: 11 } }, String(item.kind ?? '')),
          textButton(busy ? '…' : text('unarchive'), () => void submitUnarchive(String(item.canonical)), C.brand),
        ])))),

        h(Section, {
          key: 'timeline', id: 'timeline', title: text('timeline', { n: timeline.length }), count: timeline.length,
          open: openSections.timeline, onToggle: toggleSection,
          empty: timeline.length === 0, emptyText: text('emptyTimeline'),
        }, h('div', { key: 'l' }, timeline.map((item, index) => h('div', {
          key: `tl-${index}`,
          style: { padding: '7px 10px', marginBottom: 4, borderRadius: 8, background: C.layer2, border: `1px solid ${C.border}` },
        }, [
          h('div', { key: 'h', style: { fontSize: 11, color: C.muted } },
            `${new Date(Number(item.time)).toLocaleString()} · ${String(item.session ?? '')}`),
          h('div', { key: 'u', style: { fontSize: 12, color: C.label, marginTop: 3 } },
            String(item.user_text ?? '').slice(0, 400)),
          item.assistant_text === null || item.assistant_text === undefined || item.assistant_text === ''
            ? null
            : h('div', { key: 'a', style: { fontSize: 11.5, color: C.muted, marginTop: 3 } },
              String(item.assistant_text).slice(0, 400)),
        ])))),

        h(Section, {
          key: 'recent', id: 'recent', title: text('recent'), count: recent.length,
          open: openSections.recent, onToggle: toggleSection,
          empty: recent.length === 0, emptyText: text('emptyRecent'),
        }, h('div', { key: 'l' }, recent.map((item, index) => h(RecentRow, { key: `r-${index}`, item })))),

        h(Section, {
          key: 'transfer', id: 'transfer', title: text('export') + ' / ' + text('import'), count: undefined,
          open: openSections.transfer, onToggle: toggleSection,
        }, h('div', { key: 'b' }, [
          h('div', { key: 'hint', style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.6 } },
            text('transferHint')),
          h('div', { key: 'counts', style: { fontSize: 11.5, color: C.muted, marginBottom: 10 } },
            text('transferCounts', {
              entities: data?.exportCounts?.entities ?? 0,
              records: data?.exportCounts?.records ?? 0,
              keywords: data?.exportCounts?.keywords ?? 0,
            })),
          h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } }, [
            // A plain <a download> is a navigation request and carries no session
            // credentials, so the route answers 401. Fetch first, then save the blob.
            h('button', {
              key: 'e',
              onClick: async () => {
                if (exporting) return
                setExporting(true)
                setNote(null)
                try {
                  const response = await fetch('/dsh-memory/export', { cache: 'no-store' })
                  if (!response.ok) throw new Error(`HTTP ${response.status}`)
                  const blob = await response.blob()
                  const url = URL.createObjectURL(blob)
                  const anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = 'dsh-memory.zip'
                  document.body.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                  URL.revokeObjectURL(url)
                  setNote(text('exportDone'))
                } catch (error) {
                  setNote(`${text('exportFailed')}${error instanceof Error ? error.message : String(error)}`)
                } finally {
                  setExporting(false)
                }
              },
              disabled: exporting,
              style: {
                display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 14px',
                borderRadius: 8, border: `1px solid ${C.brand}`, color: C.brand,
                fontSize: 12, background: 'transparent',
                cursor: exporting ? 'default' : 'pointer',
              },
            }, exporting ? '…' : text('export')),
            h('label', {
              key: 'i',
              style: {
                display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 14px',
                borderRadius: 8, border: `1px solid ${C.borderStrong}`, color: C.label,
                fontSize: 12, cursor: importing ? 'default' : 'pointer', background: C.layer1,
              },
            }, [
              h('span', { key: 't' }, importing ? text('importing') : text('import')),
              h('input', {
                key: 'f',
                type: 'file',
                accept: '.zip,application/zip',
                disabled: importing,
                onChange: event => void submitImport(event),
                style: { display: 'none' },
              }),
            ]),
          ]),
          h('div', {
            key: 'backup',
            style: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` },
          }, [
            h('div', { key: 't', style: { fontSize: 12, fontWeight: 600, color: C.label, marginBottom: 4 } }, text('backup')),
            h('div', { key: 's', style: { fontSize: 11.5, color: C.muted, lineHeight: 1.6 } },
              data?.backup?.last === null || data?.backup?.last === undefined
                ? text('backupNone')
                : `${text('backupLast', { at: new Date(Number(data.backup.last.at)).toLocaleString(), count: data.backup.count ?? 0 })}\n${text('backupOn', { folder: String(data.backup.folder ?? ''), keep: 7 })}`),
            h('div', { key: 'b', style: { marginTop: 8 } }, [
              textButton(modelBusy ? '…' : text('backupNow'), () => void submitBackup(), C.brand),
            ]),
          ]),
          data?.importStats === null || data?.importStats === undefined ? null : h('div', {
            key: 's', style: { marginTop: 10, fontSize: 11, color: C.muted },
          }, String(data.importStats).slice(0, 300)),
        ])),
      ])
    }

    /**
     * The bundle page asks a configuration entry for both a `summary` one-liner
     * and the `page` body. Only the page body is the real panel.
     */
    function BundleConfigPanel(props) {
      if (props !== null && typeof props === 'object' && props.view === 'summary') return null
      return h(MemoryPanel)
    }

    return {
      inject: ['slots', 'locale'],
      /** Client plugin entry: the Harness calls this with the Client context. */
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-memory: dictionaries')
          const bound = ctx.locale.bind(NS)
          translate = key => bound(key)
        } catch (error) {
          // Without the locale service the page falls back to the DSH document language.
          console.warn('[dsh-memory] locale unavailable:', error)
        }

        // Settings navigation row: a full page of its own.
        ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: ENTRY_ID,
          order: 40,
          label: () => text('label'),
        }, MemoryPanel)))

        // The plugin's own page, where users look for a bundle's interface first.
        ctx.effect(() => ctx.slots.inject(BUNDLE_SLOT, () => ctx.slots.register({
          name: BUNDLE_SLOT,
          key: BUNDLE_NAME,
        }, BundleConfigPanel)))
      },
    }
  },
})
