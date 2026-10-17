# 配置

所有字段都有出厂默认值，通常不用写任何配置。`PAPER_DEFAULTS`（[src/config.ts](../src/config.ts)）
是 schema `.default()` 与代码侧回退的**单一来源**：缺配置绝不会退化成「静默关闸门」。

## 写在哪

profile 的 `cordis.patch.yml` 里，那一行插件的 `config:` 下面：

```yaml
- id: paper
  name: dsh-thesis
  config:
    workspace: D:/毕业论文/我的论文
    autopilot: { maxGoalRounds: 20 }
```

只想改少数几项时，只写那几项即可（其余补默认值）。嵌套块写法：

```yaml
    similarity: { shingle: 4, threshold: 0.3 }
```

## 全部字段

### 工作区与记忆

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | 无 | 论文工作区根。缺省从会话 cwd 向上探测 `00-管理/进度台账.md`；**配了就只认它**，路径写错直接报错 |
| `memoryPath` | `$DSH_HOME/dsh-thesis-memory.db` | 跨会话事实库（SQLite）|

### 材料与追问

| 字段 | 默认 | 说明 |
|---|---|---|
| `ingest.maxBytes` | `33554432`（32 MiB）| 单个文件读取上限，超过则拒绝并说明 |
| `ingest.maxChars` | `60000` | 单次摄取写回模型的最大字符数，超出截断并标注 |
| `intake.maxQuestions` | `12` | 一道选择题之外，追问环节最多问几个问题 |
| `intake.specRel` | `00-管理/意图规格.md` | 意图规格落盘位置（相对工作区根）|

### 原创性自查

| 字段 | 默认 | 说明 |
|---|---|---|
| `similarity.shingle` | `4` | 指纹窗口（中文字符数；英文按 4 字符近似词）|
| `similarity.threshold` | `0.3` | 判定高风险的包含率阈值（0..1，越大越宽松）|
| `similarity.minChars` | `30` | 参与比对的最短段落长度，更短的不判重（标题、公式行）|

### 写作风格自查

| 字段 | 默认 | 说明 |
|---|---|---|
| `stylecheck.reportRel` | `08-合规/AI味自查报告.md` | 报告落盘位置 |
| `stylecheck.maxParagraphChars` | `260` | 触发「长段落无锚点」判断的最短长度 |

### 答辩

| 字段 | 默认 | 说明 |
|---|---|---|
| `ppt.engine` | `auto` | `auto` / `marp` / `pandoc` / `none`；auto 探测不到就只产出 Markdown |
| `ppt.theme` | `default` | 写进 Marp frontmatter 的 `theme` |
| `ppt.timeoutMs` | `120000` | 单次外部转换超时 |
| `defense.materialsRel` | `07-答辩/答辩素材.md` | 答辩素材位置 |
| `defense.questionsRel` | `07-答辩/预答辩问题库.md` | 问题库位置 |
| `defense.defaultPages` | `11` | 幻灯默认页数（规范 10-12）|

### 代码演练

| 字段 | 默认 | 说明 |
|---|---|---|
| `codeWalkthrough.stateDir` | `.paper` | 演练状态目录（相对会话 cwd）|
| `codeWalkthrough.gates` | Go / TS / Python / Rust | 语言 → 编译验证门命令，例如 `go: { build: ['go', 'build', './...'] }` |
| `codeWalkthrough.maxCapturedOutput` | `8000` | 每条门命令输出保留的字符数 |

### 自动驾驶

| 字段 | 默认 | 说明 |
|---|---|---|
| `autopilot.enabled` | `true` | 总开关；`false` 退回「纯工具 + 技能」|
| `autopilot.maxGoalRounds` | `40` | 目标最多自动跑多少轮（防跑飞）|
| `autopilot.gateApproval` | `true` | 过 G1-G4 是否必须由人在审批界面拍板 |

### 事实回灌

| 字段 | 默认 | 说明 |
|---|---|---|
| `recall.maxEntries` | `4` | 一次最多回灌几条事实 |
| `recall.maxChars` | `600` | 回灌卡片的最大字符数 |
| `recall.minKeywordLength` | `2` | 多短的关键词不参与匹配 |

### 闸门

| 字段 | 默认 | 说明 |
|---|---|---|
| `writingGate` | `true` | 要开写但要求没谈清时，注入指令强制先追问 |
| `writingIntentPatterns` | 内置 | 判定「要开写」的正则列表 |
| `criteriaMarkers` | 内置 | 命中即视为已带验收标准、不再拦截的正则 |
| `bypassMarkers` | 内置 | 用户显式授权「直接写」的短语 |
| `maxQuestions` | `3` | 注入指令允许模型一次提出的最大问题数 |
| `destructiveGate` | `true` | 不可逆命令执行前提请拍板 |
| `destructiveToolNames` | `['bash']` | 参与高危检测的工具名 |
| `destructiveRules` | 内置 | 高危规则（标签 + 正则）|

> 在本仓库的开发环境里，命令走 `pwsh` 而不是 `bash`：想覆盖 PowerShell 命令，
> 把 `destructiveToolNames` 改成 `['bash', 'pwsh']`，或直接用默认规则集的等价正则。

## 校验与默认值的保证

- 配置 schema 由 schemastery 编译，宿主启动前校验；写错类型会在**装载时**报错，不会带病运行。
- 新增字段必须同时进 `Config`、`PAPER_DEFAULTS`、`resolveConfig` 三处；缺一处会被
  `npm run test:sandbox` 的「默认值来源一致」用例抓住。
- 开关默认值必须是**开**：缺配置不等于关闸门。
