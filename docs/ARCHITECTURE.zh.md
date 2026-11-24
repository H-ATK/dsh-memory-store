# 记忆库 · 实现说明

面向维护者与后续会话的当前实现快照。设计取舍另有 `dsh-memory-spec-2026-11-22.md`，本文件描述**代码实际在做什么**。

版本：`m7.1` · schema `7` · 数据库 `~/.dsh/storages/dsh-memory/memory.db`

---

## 1. 运行时结构

一个插件，两个半边，Host 侧按接缝拆成模块：

| 模块 | 职责 | 行数 |
|---|---|---|
| `index.js` | **组合根**：Config 定义 + 装配（建库、挂监听、起定时器） | ~250 |
| `capture.js` | `session/event`、`subagent/*`、工具目录 | ~150 |
| `inject.js` | `agent/pre-step`：注入那行备注 / 首轮简报 | ~130 |
| `normalizer.js` | 队列 → 记忆卡片（含预算、跟随会话模型、规则兜底） | ~230 |
| `vectors.js` | 可选本地 embedding：向量、查询、熔断 | ~140 |
| `routes.js` | 面板数据 + 合并/删除/导出路由 | ~200 |
| `repairs.js` | 自愈各趟 + 历史回放（backfill，增量 + 时间预算） | ~110 |
| `search-tool.js` | `memory_search` 工具：需要细节时由模型主动检索 | ~130 |
| `runtime.js` | 库路径、模型目标解析、一次受限调用 | ~80 |
| `store.js` | 数据层：schema、折叠、检索、维护 | ~2000 |
| `client.js` | 设置页与插件页里的面板 UI | ~530 |

拆分的边界就是 DSH 的接缝：捕获只听事件、注入只挂 `pre-step`、路由只碰 `webServer`。
组合根负责把它们接起来，任何单个模块都能被单独读懂和测试。

路由（本地回环 + DSH 连接校验）：

- `GET /dsh-memory/panel` — 面板数据
- `POST /dsh-memory/merge` — 手动合并实体
- `POST /dsh-memory/delete` — 删除对象（含出现与联想边）
- `GET /dsh-memory/export` — 导出 JSON

---

## 2. 数据流入（4 个源 + 2 类身份事件）

| 来源 | DSH 事件 | 落库 |
|---|---|---|
| 用户输入 | `session/event` | 原文进 `normalize_queue` |
| 助手回复 | `session/event` | 每轮最终正文的前 1200 字进 `turns` |
| 工具调用 | `session/event` | 名字 + 静态作用 + 本次摘要 + 时间 |
| 子代理 | `subagent/start`·`end` | 一行运行记录 |
| 会话标题 | `session/title` | `sessions.title` |
| 子代理名字 | `subagent/descriptor` | `sessions.label` |

子代理会话**只取后两类**（`metadataOnly`），对话内容不落库。

所有写入幂等：`UNIQUE(session_id, seq)`、`INSERT OR IGNORE`、`ON CONFLICT`。

---

## 3. 归一化

```
用户原话 → cleanUserText（剥 system-reminder / 代码块 / URL）
        → worthNormalizing（空、填充词、命令、纯符号、旧 [memory] 块 → 跳过）
        → 一次小模型调用（maxTokens 600，temperature 0）
        → 卡片 {canonical, kind, action, state, detail, keywords, weight}
        → entities（一条对象）+ occurrences（每次出现）
```

- 只存 `(session_id, seq)` 指针，**不存原话**
- 同一对象只有一条 `entities`，次数由 `COUNT(*)` 得出
- 例外细节留在 `occurrences.detail`
- 失败重试 3 次后放弃；失败时把模型原文前 500 字存进 `normalize_log.raw`

触发：`turn/end` 后 1.5 秒；启动 5 秒后；每次跑完若仍有积压则 20 秒后继续，直到每小时上限。

---

## 4. 检索与注入

```
你的消息 → bigram 关键词（本地，不花 token）
        → 候选实体（FTS5，全部 gram，不做位置截断）
        → 打分：命中强度 .38 + 留存度 .22 + 权重 .18 + 频次 .12 + 复习 .10
        → 取前 `injectMaxItems`（默认 5）→ 渲染单行备注 → 放进上下文
```

注入是 `agent/pre-step` 瀑布：`next()` 之后用官方 `createUserMessage` 追加一条消息。

- 渲染：**单行、无标记、无标题、无指令**
  `用量统计插件 新建页面×3 / 插件信息面板 查看 / 时区偏好×1`
- 体积：典型 24–50 token（上限 160）
- 门槛：相关度 ≥ 0.5；直接命中 > 3 条时不做联想扩散
- 防自环：注入消息 id 记入 `injected_messages`，折叠与回填都跳过这些 id
- 兜底：任何异常都返回未修改的 decision

**注意**：DSH 的所有注入通道都会写会话日志，界面渲染日志，因此注入内容只能压到最小、**无法彻底隐藏**。

### 本地模型适配

整理卡片需要一次模型调用，所以"能不能用本地模型"取决于这一步：

| 机制 | 行为 |
|---|---|
| **跟随会话模型** | 每个会话在 `agent/pre-step` 里把 `modelSelection` 记进 `session_models`；整理时按该会话的模型调用。纯本地对话**不会**产生云端调用 |
| 显式覆盖 | 配置 `normalizeProvider`/`normalizeModel` 优先于会话模型（想让整理走云端时用） |
| 本地宽容 | 识别本地 provider（ollama / lmstudio / llama / vllm 等）→ 超时 90s、输出上限 320 token（云端 20s / 600） |
| 规则兜底 | 同一条消息失败两次后改用 `simpleCard()`：优先复用库里已有实体名，否则取最高频短词。**弱模型不会把记忆卡死** |

`session_models` 是派生数据，会话被删除时由 `prune-sessions.mjs --clean-stale` 一并清理。

**踩过的坑（2026-11-23）**：本地模型"看起来没生效"的真实原因不在插件。那台机器把 Ollama 的 `num_ctx`
固定成 8192，而 DSH 的 `compaction-basic` 默认预留 `65536` headroom，于是切换模型时压缩直接失败：

```
reserves 4096 completion tokens and 65536 headroom tokens of its 8192-token context window,
leaving no pressure budget; The previous request model is preserved
```

**切换被撤销，会话仍在用旧模型**——表现就是"记忆没继承、回答不对"。修法是在 profile 里给该路由配压缩余量：

```yaml
- name: "@deepseek-ai/dsh-compaction-basic"
  config:
    modelPolicies:
      - provider: ollama
        model: "<模型 id>"
        headroomTokens: 2048
        maxTokens: 2048
```

同时把适配器的 `maxTokens` 降到 2048（8k 窗口：2048 输出 + 2048 余量 = 4096 < 8192）。想用更大上下文，
先把 Ollama 的 `num_ctx` 提到 32768，再把 `contextWindow` 与 headroom 一起放大。

另一点容易误解：**简报只在会话第一轮发一次**。老会话切到本地模型后不会突然"想起一切"，
除非你说的话和记忆有字面重叠（召回门槛）。要延续老会话，用 fork 而不是新窗口。

### 语义召回（可选，本地 embedding）

字面与模糊都覆盖不了的**同义词**（`记忆系统` vs `记忆库`）需要向量：

| 环节 | 做法 |
|---|---|
| 对象向量 | 每对象的 `canonical + 最近动作 + 细节` → 一次 `/api/embed` 批量请求；存 `entity_vectors`（Float32，1024 维 ≈ 4KB/对象），7 天刷新 |
| 查询向量 | `agent/pre-step` 里现算，**1.5s 超时**，LRU 缓存 200 条 |
| 融合 | `store.vectorRecall()` 余弦 ≥ 0.55 的命中作为 `extraItems` 并入同一行（按 id 去重） |
| 熔断 | 连续 2 次失败 → 暂停 10 分钟并记 `store_meta.embeddingPaused`，避免大模型占用显存时每轮都等 |

实测（bge-m3，1024 维）：热查询 **32ms**；`记忆库插件 ↔ dsh用量插件` 余弦 0.667，`↔ 今天天气怎么样` 0.362 —— 所以阈值 0.55 能分开。
冷启动要加载模型（实测 34–72s，取决于显存是否被大模型占着），因此**必须**有超时与熔断。

配置：`embedModel`（默认空 = 只用字面召回）、`embedUrl`、`embedMinSimilarity`、`embedTimeoutMs`。

### 巩固与归档（拟人记忆的后半段）

| 机制 | 规则 | 作用 |
|---|---|---|
| **巩固** | 30 天内同实体、同动作、同状态、同细节的出现只留最新一条 | 同类重复不再堆成 ×30，联想不被稀释 |
| **归档** | 180 天没被提及、从未复习、留存 `≤0.05` 的对象 `archived=1` | 移出召回（`candidateCanonicals`/`recall`/`fuzzyRecall`/`relatedItems`/`recentBrief` 全部过滤），但**仍在库里** |
| 复活 | 同一对象再次出现时 `archived` 自动清 0 | 想起来了就回到记忆里 |

频次分数本来就是对数饱和（`log1p(mentions)/log(11)`），所以"被提得多"不会线性霸榜。

### 交接卡：跨窗口接着干

`tool_calls` 本来就有写入类工具的参数摘要（含完整路径）。每轮结束把本轮 `edit/write/apply_patch`
碰过的文件聚合成一条 `handoffs` 记录（**纯本地，零模型调用**）。

两个消费点：

- **首轮简报**：`最近：… · 项目：default-workspace · 上次改动：publish.yml`
- **普通召回**：`… · 刚改动：Player.kt(+3)`（只在该交接卡来自**另一个会话**时追加）

过滤规则：交接卡来自已删除的会话 → 忽略（`JOIN sessions` 保证）；召回只认 12 小时内、简报只认 24 小时内。
历史数据可由 `repairHandoffs()` 从 `tool_calls` 反推（用队列里「用户消息 seq → 轮次」的映射）。

### 模糊回退：字面匹配不到时，按名字再找一次

纯 bigram 命中不了的情况（错字 `记意库`、旧名被合并、查询比名字更长）会触发一次模糊回退：

| 规则 | 得分 |
|---|---|
| 名字完全相等 | 1.0 |
| 一个包含另一个（`记忆库插件` 含 `记忆库`） | 0.8 |
| 编辑距离 1（长度 ≤5）或 2（更长） | 0.7 / 0.55 |

实现是对几百个名字的线性扫描（`fuzzyRecall`），比建索引便宜且结果确定。
合并实体时，**被合并掉的名字会写进 `entities.aliases`**，所以旧说法仍然能召回。
实测：`记意库` → 命中 `记忆库`；`今天天气怎么样` 仍然不命中（精度没有被牺牲）。

### 跨设备导入

面板里「导出 / 导入」是一个 ZIP（`manifest.json` + `memory.json`，deflate，无第三方依赖）。
导入规则完全按需求定义：

| 情况 | 处理 |
|---|---|
| 内容与时间区间都在已有记录里 | **重复，跳过** |
| 内容相同、时间更新 | 只加时间与 `count`，不重复存正文 |
| 内容是新的 | 新增记录 |
| 同名对象 | 按 canonical 合并：时间取并集、权重取大、提及数累加 |

```powershell
node test/inspect.mjs export          # 面板导出是同一份数据
node test/inspect.mjs importMemory "D:\backup\dsh-memory.json"   # 仅导入 JSON 主体
```

### 习惯：常用关键词

每条用户消息都会被抽一次内容词（2–4 字中文片段 + 英文词，停用词过滤，单条最多 8 个），
写入 `keyword_stats`。面板「常用习惯」按次数排序，并附带从轮次时间算出的**活跃时段**。
计数按"提到该词的消息条数"，不是原始出现次数——那才是习惯信号。

### 按需检索（`memory_search` 工具）

自动注入只有一行（24–70 token），是"线索"不是"内容"。需要细节时模型可以调 `memory_search`：

```
query: 要回忆的主题       limit: 最多几条
→ { note, items[{name, kind, action, state, detail, mentions, lastSeen}], related }
```

工具内部先走正常的 `retrieve`（预算 1200 token），没命中再走 `fuzzyRecall` 按名字找。
这就是之前讨论过的 B+ 方案：**语义自动 + 情节按需**。

### 本地优先的模型路由

`models.js`：列出 Ollama 模型（`/api/tags`）、把选手的模型存进 `store_meta.modelPolicy`、
通过 `agentDefaultModel.saveSelection()` 切默认模型。

- 启动时切回本地；每轮 `turn/end` 切回本地
- 面板「这轮用云端」→ 切付费模型，下一轮自动回来
- `autoSwitch: false` 可关掉自动回切

限制：只影响下一轮/新会话（DSH 没有改当前会话模型的接口）。

### 住在电脑里（身体感）

`body.js` 把主机、核数、内存、磁盘余量、记忆文件路径拼成一段系统提示（缓存 60 秒），
并明确写"进程停下你就睡着了""你看不见屏幕前的世界"。

- 关掉：`bodyAware: false`
- 位置：人格段之后，同一个 section（少一次读取）

### 主动问候（P3）

`proactive: true` 时，插件用 `schedule` 服务创建一个每日任务（`target: new_once`），
到点由 DSH 投递一条"你主动开口"的指令，模型以当前人格回话。

- 幂等：规格（时间/时区/人格）存在 `store_meta.proactive.task`，没变就不重建
- 可关：关掉时尝试 `delete`/`remove`/`revoke`，删不掉只记日志
- 面板：人格区显示"主动问候：每天 10:00"或"关闭"
- 投递：`new_once` 意味着每次是一段新会话，不会插进你正在聊的窗口

### 行为风格（比关键词更像人）

只有关键词算不上"像人"。所以同一套习惯统计里还记了**语气与行为**，全部本地计数、零模型调用：

| 信号 | 来源 | 用途 |
|---|---|---|
| 平均字数 / 短句率 / 长文率 | 每条用户消息 | 判断"简短"还是"长文" |
| 感叹号 / 问号 / 省略号 | 标点计数 | "爱感叹""爱省略""爱提问" |
| 表情 | emoji 区段 | "常用表情" |
| 您 / 请·麻烦 | 敬语词 | "用您""客气" |
| 帮我·直接·立刻 | 祈使词 | "直接" |
| 英文占比 | 拉丁字母比例 | "中英混用" |
| 代码块 | ``` 计数 | "常贴代码" |

聚合在 `style_stats`，达到 20 条消息后生成画像（实测当前库：**长文 · 直接 · 中英混用**，
平均 193 字/条、祈使 0.41、礼貌词 0.06）。

消费方式：

- **首轮简报**追加一句 `风格：长文、直接、中英混用`（约 12 token，每个会话一次）
- **`memory_search`** 对"我说话什么风格"这类查询直接返回画像，不走检索
- **面板「常用习惯」**顶部展示画像与各项频次

### 习惯的自动收集

习惯不是实时逐条累加，而是从 **`memory_records`（内容去重后的对话）** 收割：

| 时机 | 动作 |
|---|---|
| 每轮结束 | `harvestHabits(4)` 处理刚写的记录 |
| 启动时 | `harvestHabits(400)` 补上停机期间的记录 |
| 历史回填 | `node test/habits-history.mjs` 从会话日志重建（实测 305 轮 → 304 条记录） |

每条记录带 `habits_done` 标记，处理一次即置位——重启不会重复计数。
`habits()` 只返回 2–3 字、出现 ≥2 次的词，连接词（还有就是/好了/然后）在收集和展示两侧都被过滤。

### 跨设备导入

### 启动成本

启动慢的根因不在插件折叠，而在 `sessionQuery.readSession()` 的整日志回放校验（实测 32.6 MB / 41383 事件
≈ 1.4 s 解析，加上校验更多）。因此：

| 措施 | 效果 |
|---|---|
| `backfillDelayMs`（默认 3s） | 界面先出来，再开始回放 |
| 会话之间 `setImmediate` 让出 | 回放期间 Host 保持可响应 |
| `session_cursors` 增量折叠 | 已处理的事件不再写库 |
| `backfillMaxMs`（默认 8s）+ `backfill.resume` 轮转 | 单次有上限，下次从断点继续，不会永远跳过 |

### 当前工作区加权（不是过滤）

同一实体若也出现在当前工作区，打分 +0.10，排序仍按时间。跨工作区记忆保持全局：
别的项目相关时照样能召回，只是"本项目"的先出现。

### 新会话首轮简报（跨工作区）

会话第一轮、且该会话没发过简报时，改为发一条全局概览而不是普通召回：

```
最近：时区偏好、dsh、审批策略
```

约 11 token，只发一次（`session_briefs` 记录）。

- **跨工作区**：记忆按设计就是全局共享的，简报不能只看当前工作区，否则"换个窗口就想不起来别的项目"。
- **按最近活动排序**，不按被提及次数。
- **只列名字、不带次数、不带指令**：早期版本写成"本工作区 59 条记忆：xx×30…"，
  模型会顺着那个数字去"巡视项目"，而不是回答用户当前的问题。
- 子代理会话不发简报（父会话已给上下文）。

### 排序：相关性决定要不要，时间决定顺序

`retrieved` 的条目先过相关性门槛（分数 + 至少共享 2 个 bigram），**再按 `last_seen` 从新到旧排序**。
简报同样按最近活动排序。高频但陈旧的对象（如被反复提及的"时区偏好"）不会再占据列表首位。

---

## 5. 记忆模型

| 机制 | 实现 |
|---|---|
| 遗忘 | `retention = e^(-天数/τ)`，`τ = 90 + 45×ln(1+复习次数)` 天 |
| 强化 | 每次注入 `use_count+1`、`last_used_at=now` |
| 联想 | 同轮共现建 `entity_links`；回忆时带出至多 2 个，需 ≥1 次共现 |
| 巩固 | 面板手动合并；合并可逆（occurrences 保留指针） |
| 自愈 | 大小写/空格重复实体、缺失 turn、联想表，启动时幂等重建 |

---

## 6. 存储

| 表 | 用途 |
|---|---|
| `entities` | 语义记忆：对象/项目/偏好/人物 |
| `occurrences` | 情节记忆：每次出现的指针 + 动作/状态/细节 |
| `sessions` | 会话标题、子代理名字、工作区 |
| `entity_links` | 联想边（a<b 有序对，co_count） |
| `turns` | 每轮助手摘要（≤1200 字） |
| `tool_calls` | 工具调用记录 |
| `subagent_runs` | 子代理运行记录 |
| `normalize_queue` / `normalize_log` | 归一化队列与调用账目 |
| `injected_messages` | 已注入消息 id |
| `session_briefs` | 已发过首轮简报的会话 |
| `handoffs` | 每轮改过的文件（交接卡） |
| `memory_records` | 按内容哈希去重的完整对话（导出/导入的单位） |
| `keyword_stats` | 常用词统计（习惯） |
| `relationship_turns` / `relationship_events` | 关系：轮次（幂等计数）、边界/感谢/承诺事件 |

`turns` 上多了 `user_text` / `assistant_text`：**每轮完整对话**（上限 6 万字符）。
实测全存正文只让库涨 24%，所以不再截断。

`memory_records` 的语义：同内容同时间 = 重复（跳过）；同内容不同时间 = 只加时间与次数。
这是导入去重的全部规则。

`entities.imported_mentions` 记录"从别的设备合并来的提及数"，让跨设备导入后计数不失真。
| `session_cursors` / `store_meta` | 回填游标与构建/诊断信息 |

`entities` 上有两个"离开召回"的标记，语义不同：

| 列 | 谁写的 | 含义 | 恢复方式 |
|---|---|---|---|
| `archived` | 自动（180 天未用 + 留存 <0.05） | 淡忘 | 再提一次，或 `inspect` 里取消归档 |
| `deleted_at` | 用户（面板删除） | 主动删掉 | 回收站恢复，或彻底清除 |

两者都不删数据：行、出现、联想边都还在。`purgeEntity` 才是真删。

---

## 7. 面板

设置 → 记忆库（`settings.section`，id `memory-store`），插件页也有入口（`plugins.bundle.config`）。

能力：

- 统计卡片、对象列表（次数/复习/权重/最后动作）、最近出现
- **搜索**：按名字过滤（客户端本地筛，零请求）
- **合并**：把一个对象并进另一个（旧名进 `aliases`）
- **删除**：软删（`entities.deleted_at`），对象立刻离开召回与列表，但行、出现、联想边都保留（`POST /dsh-memory/delete`）
- **回收站**：列出已删对象，一键恢复（`POST /dsh-memory/restore`）；彻底删除只在 `inspect purge`
- **导出 JSON**：`GET /dsh-memory/export`，含实体与联想边

两个写接口都走同一道准入：认证后仅限 loopback。

两个入口，同一套内容：**设置 → 记忆库** 与 **插件 → 记忆库**（介绍下方）。

统计卡（对象/出现/会话/轮次/工具/联想/待整理）、最近一次注入、会话与子代理列表、对象列表（筛选 + 合并）、最近出现时间线、复习次数。文案跟随 DSH locale（`ctx.locale`）。

---

## 8. 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `capture` | 开 | 记录新对话 |
| `backfillOnEnable` | 开 | 启动回填历史 |
| `captureTools` / `captureSubagents` | 开 | 工具 / 子代理记录 |
| `normalize` | 开 | 异步整理成卡片 |
| `normalizeBatch` / `normalizeMaxPerHour` | 8 / 60 | 批量与每小时上限 |
| `normalizeProvider` / `normalizeModel` | 空 | 跟随默认模型 |
| `injectMemories` | 开 | 自动注入 |
| `injectBudgetTokens` / `injectMaxItems` / `injectMinScore` | 160 / 5 / 0.5 | 注入上限与门槛 |
| `briefOnNewSession` | 开 | 新会话首轮发一次简报（最近记忆的名字，跨工作区） |
| `briefMaxItems` | 3 | 简报里列几个对象 |
| `handoff` | 开 | 每轮记录改动文件，并在别的窗口带一行"刚改动" |

---

## 9. 成本（累计实测）

| 项 | 数值 |
|---|---|
| 归一化调用 | 560 次，失败 31 次（5.5%） |
| 累计 token | 输入 121,018 / 输出 103,530 |
| 累计花费 | 约 ¥0.54 |
| 单轮注入 | 24–50 token |
| 单轮归一化 | 约 ¥0.0008 |

---

## 10. 存储体积与"全存原文"的代价

当前语料：340 轮、736 条用户消息、4,946 条助手消息。

| 存法 | 增量 | 记忆库总量 |
|---|---|---|
| 现状（摘要截断 1200 字） | — | 3.83 MB |
| 用户 + 助手最终正文，不截断 | +1.16 MB | **4.73 MB** |
| 再加工具结果正文 | +10.11 MB | 13.68 MB |
| 再加流式分片（原始事件） | 约 ×10 | 100 MB 量级 |

关键结论：**只存"对话正文"只多 24%**；体积暴涨的是工具结果与流式分片（占原始事件 90% 以上）。存文本本身**不消耗 token**，但如果检索把全文返回给模型，注入 token 会随之上升——当前注入只用名字与动作，所以不受影响。

---

## 11. 已知限制

- 注入无法彻底隐藏（框架限制，见 §4）
- 多开 DSH 进程会争用 SQLite 写锁，未做单实例保护
- ~~回填是全量重扫~~ → 已改为**增量**：每个会话记 `session_cursors.max_seq`，重启只折叠比游标新的事件（日志本身仍需整读，服务没有按区间读的接口）
- 高频对象（如"时区偏好"）会与大量实体建联，可能稀释联想质量
- 归一化失败率约 5%，多发生在多需求长段落上

### `MALFORMED_RESPONSE` 不一定是插件问题

实测案例（2026-11-23）：一个会话以 `turn/end {reason: {kind:"error", error:{message:"DeepSeek Messages stream: unsupported stop reason refusal", code:"MALFORMED_RESPONSE"}}}` 结束。

排查结论：**模型拒绝回答**（DeepSeek 返回 `stop_reason: refusal`），而 DSH 的适配器没有映射这个停止原因，于是报成 `MALFORMED_RESPONSE`。插件在该会话里只做了一次正常注入（简报 `最近：…`），没有任何工具调用或写库动作，与该失败无关。

触发场景：助手被要求"验证是否成功"后开始读取 DSH 内部数据（`.dsh` 配置、profile、`session_projcache`、自身会话缓存），在准备复述内部信息时被模型安全策略拒答。

排查顺序（照这个顺序看，能省时间）：

1. 找该会话最新日志文件，筛 `turn/end` 看 `reason`——`kind:"error"` 就是这个结论。
2. 看 `user/message` 与 `tool/call` 序列，确认是否在读取/复述内部数据。
3. 看 `injected_messages` + `store_meta.inject`，确认插件只注入了一行备注。
4. 若注入缺失或报错，再怀疑本插件；否则直接重试会话。

注意：DSH 侧把这个拒绝报成 `MALFORMED_RESPONSE` 属于核心行为，本插件不改。

## 12. 验证与排障

```powershell
node test/replay.mjs        # 真实语料离线回放 + schema 迁移
node test/normalize.mjs     # 清洗、跳过、prompt、卡片解析
node test/retrieve.mjs      # 排序、时间优先、紧凑渲染、预算
node test/merge.mjs         # 合并、事务、外键
node test/memory-model.mjs  # 遗忘、强化、联想、简报、身份、修复

node test/inspect.mjs status          # 状态总览
node test/inspect.mjs recall "查询"    # 复现一次召回
node test/inspect.mjs injected        # 注入原文
node test/inspect.mjs repair          # 唯一写命令：重建派生数据
```

`inspect.mjs` 是唯一排查入口，读命令先把库复制到临时文件再用，不碰线上库。
症状 → 命令的对照表见 `docs/TROUBLESHOOTING.zh.md`。

## 13. 未做

实体拆分、跨设备同步、工具版检索（语义自动 + 情节按需）、lint 换成真正的类型检查。
