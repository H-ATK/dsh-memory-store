# 记忆库 · 排障手册

症状 → 命令 → 看什么。所有命令都在仓库根目录执行。

```powershell
cd <插件目录>
node test/inspect.mjs <命令>
```

**除 `repair` 外全部只读**：读命令会先把库复制到临时文件再打开，不会碰线上库、也不会和 Host 抢写锁。

---

## 快速判断

| 症状 | 命令 | 看什么 |
|---|---|---|
| 不知道该看哪里 | `status` | build、schema、各表行数、最近一次注入 |
| 注入没出现 | `injected --limit 5` | 是否有记录、原文是什么 |
| 注入内容不对 | `recall "你当时说的话"` | 命中明细：分数、共享片段数、时间 |
| 新窗口想不起来 | `brief` + `sessions` | 简报内容、会话属于哪个工作区 |
| 面板空白 / 打不开 | `status` | build 是否是预期版本（不是就需重启） |
| 对话直接报错 | `logs --limit 2` | `turn/end` 的 `reason` |
| 记忆不更新 / 越来越旧 | `queue` | 待处理是否堆积、失败原因 |
| 联想不出来 | `links` | 边是否存在、从哪个对象出发 |
| 工具描述是 `tool: xxx` | `calls --limit 5` | 「退回占位描述的行」是否为 0 |
| 交接卡指向不存在的会话 | `changes` + `prune-sessions.mjs --clean-stale` | 见 §10 |
| 库变大想省空间 | `corpus` | 对话正文 vs 工具结果的占比 |
| 数据乱了想重建 | `repair` | **写命令**，见 §9 |
| 记忆太多太散 | `consolidate` | 折叠重复、归档陈旧，见 §11 |
| 删错了想找回 | `trash` → `restore "对象名"` | 面板删除是软删，可恢复 |
| 两个对象被合并过头 | `split "旧名" "新名" --days 7` | 把最近的记录拆出去 |
| 想在另一台设备上也有记忆 | `export` → 拷文件 → `importMemory "文件"` | 只迁知识，不迁原始会话 |
| 启动慢 | 看 §16 | 延迟 / 增量 / 时间预算 |

---

## 1. `status` — 一切从这里开始

```
build      2026-11-23T09:20+08:00 m8.0
schema     8
内容
  实体 110 · 出现 385 · 会话 17 · 联想 60
  队列 总 670 · 待处理 2 · 跳过 286 · 放弃 1
  归一化 580 次（失败 31）· 输入 124900 / 输出 106500 token
最近一次注入
  2026/11/23 08:41:56 · brief · 3 条 · 12 token
```

要点：

- **`build` 不是你改完代码的版本 → 没重启。** 改插件代码必须重启 DSH（linked 包不参与热重载）。
- `schema` 落后于代码里的 `SCHEMA_VERSION` → 启动时迁移没跑，看 Host 日志。
- `activated` 是本次激活时间，用来对时间线。
- 「最近一次注入」的 `mode` 是 `brief`（新会话首轮）或 `recall`（普通召回）。

---

## 2. `injected` — 到底注进去了什么

```powershell
node test/inspect.mjs injected --limit 5
```

它按 `injected_messages` 里记的 id 去会话日志里把原文捞回来：

```
[2026/11/23 08:36:24] session-ca6719fe-d3a seq 3583
  用量总览页面 调整界面×13 / 工作区与模型选择 选择区更显眼…
  56 字符 · 约 35 token · 含标记 false
```

判断标准：

- **没有记录** → 注入压根没触发：你这句话和记忆没有足够字面重叠（门槛 `injectMinScore` 默认 0.5），或 `injectMemories` 被关了。
- **有记录但内容不对** → 用 `recall` 复现，看命中明细。
- `含标记 false` 是正常的：现在用消息 id 防自环，正文里没有 `[memory]`。

---

## 3. `recall` — 复现一次召回

```powershell
node test/inspect.mjs recall "dsh用量插件的注入隐藏" --items 5 --min 0.5
```

```
  注入文本: dsh插件 规划×13 / dsh用量插件 询问隐藏×30 / … · 刚改动：store.js(+4)
  3 条直接命中 + 1 条联想 · 约 47 token
  明细
    dsh插件    project  分 0.937 · 共享 4 · 复习 10 · 本工作区 是 · 2026/11/23 07:50:31
```

看三件事：

| 字段 | 含义 | 异常表现 |
|---|---|---|
| `共享` | 与查询共享的 bigram 数 | < 2 会被过滤（除非总分 ≥ 0.8）→ 说明"字面对不上" |
| `分` | 综合分 | 都低于门槛 → 该调 `injectMinScore` 或确实没记忆 |
| `本工作区` | 是否也出现在当前工作区 | 是 → 打分会 +0.10，属于设计内的偏置 |

顺序规则：**相关性决定能不能进，`last_seen` 决定排序**（最近优先）。
`刚改动` 只在交接卡来自**另一个会话**时出现。

---

## 4. `brief` + `sessions` — 新窗口为什么"想不起来"

```powershell
node test/inspect.mjs brief
node test/inspect.mjs sessions --limit 6
```

`brief` 显示新会话首轮会发的那行（跨工作区、最近优先、带项目与上次改动）：

```
简报: 最近：时区偏好、跨工作区记忆、对话窗口 · 项目：default-workspace · 上次改动：publish.yml
约 39 token · 覆盖 110 个对象
```

`sessions` 里核对**工作区**：

```
2026/11/23 08:41:57  main  验证是否成功  C:\...\AndroidStudioProject
```

常见误区：以为"新窗口能想起 X 项目"，但那个新窗口其实建在**另一个工作区**里。工作区在会话创建时确定，插件跟着它走——不过记忆本身是跨工作区的，别的项目相关时照样召回。

---

## 5. `logs` — 对话报错时

```powershell
node test/inspect.mjs logs --limit 2
```

看 `turn/end` 的 `reason`：

| reason | 结论 |
|---|---|
| `{"kind":"completed"}` | 正常 |
| `{"kind":"error","error":{"code":"MALFORMED_RESPONSE", …"unsupported stop reason refusal"}}` | **模型拒答**，不是插件问题。见 `docs/ARCHITECTURE.zh.md` §11 |
| `{"kind":"aborted", …}` | 被用户/父会话中断 |
| `{"kind":"error", …"RATE_LIMIT"/"TIMEOUT"}` | 网络/限流，重试即可 |

同一命令还会打出 `llm/retry*` 事件，能看出是不是自动重试后仍然失败。

---

## 6. `queue` — 记忆不更新

```powershell
node test/inspect.mjs queue
```

- **待处理持续堆积** → 归一化没在跑：看 `normalize` 是否关闭、`store_meta.normalizeTarget` 是否为空（模型路由没解析到）、或撞上每小时上限。
- **失败原因集中** → `unparseable` 说明模型输出不符合 JSON（现在会存原文，直接看「输出」那行）。
- **跳过原因** → `model-skip`（模型判断无记忆价值）、`empty`（清洗后为空）、`too-short`；这些是设计内行为。

---

## 7. `links` — 联想质量

```powershell
node test/inspect.mjs links
```

- 边为 0 → 历史数据没建联，跑一次 `repair`（Host 启动时也会自动重建）。
- 出现"时区偏好 ↔ 各种东西"这类泛化关联 → 高频对象稀释联想，属已知限制；可在面板里合并/清理此类对象。

---

## 8. `corpus` — 要不要存原文

```powershell
node test/inspect.mjs corpus
```

给出当前语料与「全存对话正文 / 连工具结果一起」的体积对比。结论见 `docs/ARCHITECTURE.zh.md` §10：
只存对话正文约 +24%，工具结果才是大头。

---

## 9. `repair` — 唯一会写的命令

```powershell
node test/inspect.mjs repair
```

幂等，等价于启动时的那套自愈：

- 合并只差大小写/空格的实体
- 用队列回填缺失的 `turn`
- 从 `tool_calls` 反推**交接卡**
- 按 `(会话, 轮次)` 重建联想边
- 把 `tool: xxx` 占位描述换成真实作用

**可以直接在 Host 运行时跑**（SQLite WAL 允许短暂并发写），但最好在没在对话时跑。

输出示例：

```
大小写重复合并 0 · 轮次回填 0 行 · 交接卡 158 条 · 联想重建 0 条 · 工具描述 0 行
```

---

## 10. `embed` + 语义召回

```powershell
node test/inspect.mjs embed                     # 给待处理对象算向量（写命令）
node test/inspect.mjs embed --model bge-m3
node test/inspect.mjs recall "记忆系统" --semantic bge-m3
```

- 向量存在 `entity_vectors`，7 天后刷新；`embed` 只处理缺向量或过期的对象
- **查询超时 1.5s 就退回字面召回**，不会卡住对话
- 连续 2 次失败会**熔断 10 分钟**（`store_meta.embeddingPaused`）——大模型占用显存时 embedding 模型会被挤掉，重载要几十秒，熔断就是防这个
- 想看是否在熔断：`node test/inspect.mjs status` 里看 `embeddingPaused`

## 11. `consolidate` — 巩固与归档（写命令）

```powershell
node test/inspect.mjs consolidate
node test/inspect.mjs consolidate --days 30 --archive-days 180
```

- **巩固**：30 天内同实体 + 同动作 + 同状态 + 同细节的出现只留最新一条
- **归档**：180 天未提及、从未复习、留存 ≤0.05 的对象置 `archived=1`

归档对象**仍在库中**，只是不再被召回（`recall`/`fuzzyRecall`/联想/简报全部过滤）。再次提到它会自动复活。

启动时也会跑一次（`runMemoryRepairs`），所以平时不用手动执行。

## 12. 回收站：软删除与恢复

```powershell
node test/inspect.mjs trash                 # 看删了哪些
node test/inspect.mjs restore "对象名"        # 恢复
node test/inspect.mjs purge "对象名"          # 彻底删除
```

面板上的删除是**软删**：只写 `entities.deleted_at`，行、出现、联想边都保留，所以点错了能救回来。

- 软删后该对象不再出现在召回、联想、简报、面板列表里
- **再提一次会自动复活**（和归档一样）
- `purge` 才是真删（连同出现、联想边、向量）

## 13. 交接卡（跨窗口接着干）

```powershell
node test/inspect.mjs changes --limit 6
```

`changes` 打印写入类工具调用（`edit`/`write`/`apply_patch`）以及按时间聚合后的文件列表——那就是交接卡的原料：

```
2026/11/23 09:03  edit  session-ca67  C:\...\dsh-memory\store.js
按时间聚合
  session-ca67 · 2026/11/23 09:03 → dsh-memory\store.js , dsh-memory\retrieve.js
```

交接卡在真实注入里表现为一行后缀：

```
… · 刚改动：store.js(+4)
```

排查要点：

- **没有"刚改动"** → 可能当前会话就是写入方（插件只显示**别的会话**的交接卡），或超过 12 小时，或 `handoff` 被关。
- **指向了已删除的会话** → 跑 `node test/prune-sessions.mjs --clean-stale --apply`，清理陈旧会话的派生数据（交接卡/简报/游标/会话身份），**记忆实体保留**。
- 想重建历史交接卡 → `node test/inspect.mjs repair`（幂等）。

---

## 14. 备份与恢复

```powershell
# 备份（必须连 -wal 一起拷，否则会丢最近写入）
Copy-Item "$env:USERPROFILE\.dsh\storages\dsh-memory\memory.db*" "D:\backup\"
```

恢复时把三个文件（`memory.db`、`-wal`、`-shm`）一起放回去再启动 DSH。
只拷主库会丢掉 WAL 里尚未回写的数据——这一点在迁移演练时踩过。

### 清理会话（移动而非删除）

DSH 没有"删除会话"的接口，只能操作文件。仓库里的脚本**移动而不是删除**：

```powershell
node test/prune-sessions.mjs            # 试运行，只打印
node test/prune-sessions.mjs --apply    # 真正移动
```

它做三件事：

1. 把目标会话目录**移动**到 `~/.dsh/session-trash/<时间戳>/`（不 unlink）
2. 顺带移动 `storages/session_projcache/sessions/<id>.json`
3. 备份并修改 `storages/workspace.json`，从工作区登记里去掉这些 id

**之后必须重启 DSH**，会话列表才会按磁盘重新加载。

要还原：把回收站里的目录搬回 `~/.dsh/sessions/<工作区目录>/`，并用 `workspace.json.bak-<时间戳>` 覆盖回去。

注意：删会话**不会**删记忆。那几次对话蒸馏出的实体仍在 `memory.db` 里——这是设计（会话可删、记忆长存）。
但它们的交接卡/简报等**派生数据**会变成噪音，用 `--clean-stale` 清掉。

---

## 14. 习惯与风格

```powershell
node test/inspect.mjs style          # 当前画像 + 常用词
node test/inspect.mjs harvest        # 把待处理记录收进习惯统计
node test/habits-history.mjs         # 从历史会话回填（幂等，可先 --dry）
```

- 画像要 **20 条消息**才生成（样本太少没有意义）
- 习惯从 `memory_records` 收割，每条记录只处理一次（`habits_done`）
- 关键词只显示 2–3 字、出现 ≥2 次的词；连接词在收集阶段就被丢掉
- 「风格」会出现在新会话首轮简报末尾，也可以直接问 `memory_search`："我说话什么风格"

## 15. 启动慢怎么调

启动的主要成本不是插件折叠，而是 `sessionQuery.readSession()` 的整日志回放校验。可调的三处：

| 配置 | 默认 | 作用 |
|---|---|---|
| `backfillDelayMs` | 3000 | 启动后等多久再回放，让界面先出来 |
| `backfillMaxMs` | 8000 | 单次回放的时间上限；超出部分下次启动轮转继续 |
| `backfillOnEnable` | true | 关掉就完全不回放历史（只记新对话） |

实测基线（32.6 MB / 41383 事件）：解压+解析 1.4s、折叠 0.7s、自愈 0.1s。
如果启动仍然慢，先跑 `node test/bench-startup.mjs` 看是哪一段。

## 16. 验证套件（改完代码必跑）

```powershell
node test/lint.mjs          # 静态检查：导出符号、重复声明、库层不写 stdout
node node_modules/typescript/bin/tsc -p tsconfig.json   # 类型检查（0 错误为准）
node test/replay.mjs        # 真实语料离线回放 + schema 迁移
node test/normalize.mjs     # 清洗、跳过、prompt、卡片解析
node test/retrieve.mjs      # 排序、时间优先、紧凑渲染、预算
node test/merge.mjs         # 合并、事务、外键
node test/memory-model.mjs  # 遗忘、强化、联想、简报、身份、交接卡、巩固、归档、向量、修复

# 端到端：用假 Cordis 上下文加载真实插件，跑捕获 / 注入 / 路由
node --experimental-loader ./test/e2e/loader.mjs test/e2e.mjs
```

`npm run verify` 跑前五套，`npm run e2e` 跑端到端。

全绿再提交；任一失败先看最后一段的 `FAIL` 行。
