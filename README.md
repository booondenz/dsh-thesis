# dsh-thesis

**把一堆材料变成一篇经得起查重与答辩的论文，和一个讲得清自己系统的你。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的单一插件。给它学校模板、论文要求、
实验数据、代码和参考文献，它会**先追问、再动手**——把要求问成一份可证伪的《意图规格》，再按九个阶段推进：

**选题 → 开题 → 文献 → 设计 → 实现 → 测试 → 论文 → 合规 → 答辩**

全程留痕（进度台账 + 决定日志 + 检索记录 + 检查报告），每一步都要你拍板。对外只呈现一个领域模型：
`thesis_*`（论文工作区）、`fact_*`（跨会话事实）、`defense_code_*`（答辩层代码演练），没有第四套命名。
纯 TypeScript，零运行时第三方依赖。

---

## 安装

在 DSH 的**插件管理器里搜索 `dsh-thesis`** 装上，重启 dsh 即可（装好应能看到上面三个命名空间的工具）。

从源码安装（想改代码，或本机没有 pnpm）：

```bash
git clone https://github.com/booondenz/dsh-thesis.git && cd dsh-thesis
npm install && npm run build                            # DSH 没有 TS 加载器，必须发布编译后的 JS
dsh plugin --profile web add "$PWD"                     # 需要 pnpm
node scripts/install-into-profile.mjs --profile web     # 没有 pnpm 时的兜底
```

卸载：插件管理器里移除，或 `dsh plugin --profile web remove dsh-thesis`（兜底安装用 `install-into-profile.mjs --remove`）。

**升级 DSH 后「装了但没反应」**：宿主会在装载前校验 `package.json` 里 `@deepseek-ai/dsh*` 的
`peerDependencies`，不满足就把该行静默 `disabled`（stderr 打印 `disabling profile plugin row`）。
本插件声明 `>=0.2.0-rc.2 <0.3.0-0`；跨小版本时先跑 `npm run test:host-load`（用宿主自己的预检函数判定）
与 `npm run test:host`（真实 cordis 装配），再把 range 改成实测过的版本。

---

## 30 秒上手

装好并重启后，把材料丢进工作区（或告诉它绝对路径），在对话里说：

```
这是我的论文材料，帮我做毕业设计
```

它会 `thesis_ingest` 读材料 → `thesis_intake` **一次问你一个问题** → 落盘 `00-管理/意图规格.md`
→ `thesis_init` 建工作区 → 按阶段推进。没有材料也能用（「我要做毕业设计，还没定题」→ 选题工作坊）。

> **把会话开在论文目录里**最省事：多数工具从会话 cwd 向上探测 `00-管理/进度台账.md` 来定位工作区。
> 也可以用 `config: { workspace: /path/to/你的论文 }` 显式指定（路径写错会直接报错，绝不写到别处）。

---

## 能力一览

| 环节 | 工具 | 要点 |
|---|---|---|
| 材料与要求 | `thesis_ingest` `thesis_intake` | docx/xlsx/pptx/pdf/md/csv/代码 → 文本与**代码结构**摘要；再逐题追问成意图规格，断点续问 |
| 工作区与关卡 | `thesis_init` `thesis_progress` `thesis_decide` | 九阶段目录 + 台账 + 决定日志；**G1-G4 关卡未过不许推进** |
| 文献 | `thesis_lit_search` `thesis_lit_save` `thesis_lit_note` | Semantic Scholar → DBLP → arXiv → Crossref 降级检索；**只认真实检索缓存，零假文献** |
| 写作与合规 | `thesis_review` `thesis_check` `thesis_stylecheck` `thesis_build` `thesis_originality` | 逐章评审 / 全文五项检查 / 去 AI 味自查 / 出 `论文.docx`（优先 pandoc，否则内置零依赖生成器）/ 本地降重度量 + 复测 |
| 答辩 | `thesis_defense` `thesis_slides` `defense_code_*` | 素材 + 六类问题库；Marp 兼容幻灯（含讲稿与证据锚点）；代码演练把系统拆成讲得清的模块 |
| 跨会话事实 | `fact_search` `fact_remember` `fact_context` | SQLite 记住学校规范、导师要求、写作偏好；相关时自动放回上下文 |

斜杠命令 9 个：`/thesis-status` `/thesis-decide` `/thesis-lit` `/thesis-check` `/thesis-build`
`/thesis-ingest` `/thesis-intake` `/thesis-originality` `/thesis-defense`。

技能包 11 个（随插件发布，`thesis_init` 复制进论文仓库 `.dsh/skills/` 与论文一起 git 版本化）：
`thesis-pipeline` `thesis-opener` `thesis-literature` `thesis-eng-design` `thesis-writing` `thesis-citation`
`thesis-defense` `code-walkthrough` `paper-intake` `paper-dedup` `thesis-inquiry`。

---

## 红线（写在护栏里，不是写在文档里）

1. **零假文献**：引用只能来自真实检索缓存，`thesis_lit_save` 拒绝缓存外的 id，`thesis_check` 复核双向一致。
2. **零假数据**：实验数据与运行结果必须来自真实运行；`thesis_originality` 明确禁止为降重改动数据与结论。
3. **人是作者**：G1-G4 关卡由工具强制；决定必须由你拍板。
4. **规范以学校文件为准**：模板缺失时用内置过渡模板并**显式标注「非学校模板」**，绝不假装合规。
5. **降重不是洗稿**：不接收费查重系统，报告里的重复率是**本地估算**，与学校结果不可等同（可回填对照）。
6. **不静默销毁数据**：读不出来 ≠ 不存在。读取失败时工具抛错并保持原文件不动，绝不用默认值覆盖。

---

## 已知边界

- **PDF 是尽力而为**：扫描版（无文本层）、对象流/加密 PDF 可能抽不出文字，会明确报原因而不是编造内容。
- **旧格式不支持**：`.doc`/`.xls`/`.ppt` 请先另存为新格式。
- **幻灯不自研生成器**：只产出 Marp 兼容 Markdown，`.pptx` 依赖外部 marp/pandoc；两者都缺时给出可执行命令与兜底路径。
- **子进程不可取消**：pandoc/marp/git 走 `spawnSync`，有超时但没有信号传递。
- **类型来自本地 shim**：为让仓库零依赖即可 `tsc` 通过，宿主契约声明在 `src/types/shims.d.ts`，真实签名核对见 [docs/host-api.md](./docs/host-api.md)。
- **代码演练语言矩阵**：内置 Go/TS/Python/Rust，其余语言需在配置里补 `gates`。

---

## 配置

所有字段都有默认值，需要时在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: paper
  name: dsh-thesis
  config:
    workspace: /path/to/thesis            # 缺省从会话 cwd 向上探测 00-管理/进度台账.md（配了就只认它）
    memoryPath: /path/to/paper-memory.db  # 缺省 $DSH_HOME/paper-memory.db
    similarity: { shingle: 4, threshold: 0.3 }   # 原创性自查度量
    ppt: { engine: auto }                        # auto | marp | pandoc | none
    writingGate: true                     # 要求没立稳时拦下「开始写」
    destructiveGate: true                 # 不可逆命令前提请拍板
```

其余字段（`ingest` / `intake` / `stylecheck` / `defense` / `codeWalkthrough` / `recall`）见
[DESIGN.md](./DESIGN.md) §4 配置契约，默认值见 [src/config.ts](./src/config.ts)。

---

## 开发

```bash
npm install && npm run build   # tsc → lib/
npm test                       # node --test tests/（Node 24 直接跑 .ts）
npm run verify                 # 完整验收：build + typecheck + 全部单测 + 审计 + 端到端
```

质量分层：`test:sandbox`（430 单测/契约）、`test:e2e`（65 条真实场景端到端）、`test:host`（真实 cordis 装配与闸门）、
`test:host-load`（真实 dsh 引擎装载与 peer 预检）、`audit`（对外表面契约一致）、`test:net`（可选，真实学术 API）。

详细设计见 [DESIGN.md](./DESIGN.md)，宿主契约见 [docs/host-api.md](./docs/host-api.md)，来源声明见 [NOTICE.md](./NOTICE.md)。

## 许可

MIT
