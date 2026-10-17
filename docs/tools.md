# 工具与技能

工具名、命令面、技能名都是**对外契约**：改名就是破坏性变更。`npm run audit` 会把这三样
都核对一遍（21 个工具 / 0 条斜杠命令 / 11 个技能 + 命名与 BOM 检查）。

## 命名空间

| 前缀 | 管什么 |
|---|---|
| `thesis_*` | 论文工作区里的东西（材料、要求、章节、检查、构建、答辩素材、幻灯） |
| `defense_code_*` | 答辩层的代码演练（把系统拆成讲得清的模块） |
| `fact_*` | 跨会话事实（学校规范、导师要求、写作偏好） |

## `thesis_*`（15 个）

| 工具 | 一句话 | 关键约束 |
|---|---|---|
| `thesis_ingest` | 把材料读成文本与结构摘要 | docx/xlsx/pptx/pdf/md/csv/bib + 源码目录；源码只给结构，不贴正文；已存在的摘要不覆盖 |
| `thesis_intake` | 一次问一个要求问题，问成《意图规格》 | 必答项不齐拒绝 `done`；材料里能读出来的不重复问 |
| `thesis_init` | 建论文工作区 | 空目录才能建；九阶段目录 + 台账 + 七章模板 + 技能包 + git |
| `thesis_progress` | 看进度 / 过 G1-G4 | 关卡是**拒绝**不是提醒；关联任务未完成不许过关 |
| `thesis_decide` | 记一条关键决定 | 内容/理由/备选三段，写进决定日志 |
| `thesis_lit_search` | 真实检索文献 | Semantic Scholar → DBLP → arXiv → Crossref 降级；写检索缓存与审计记录 |
| `thesis_lit_save` | 收录进 `refs.bib` | **只接受检索缓存里的 id**（零假文献的落点）；DOI 重复自动跳过 |
| `thesis_lit_note` | 生成阅读笔记骨架 | 五节模板；已存在不覆盖 |
| `thesis_review` | 单章六项评审 | 字数区间 / 大纲小节 / 引用编号 / 图表编号 / 未完成标记 / G2 清单 |
| `thesis_check` | 全文五项检查 | 引用双向一致、字数、图表编号、术语定义顺序、学校模板探测 |
| `thesis_stylecheck` | 六条 AI 味启发式 | 模板套话、空洞结论、自我暴露、翻译腔、句式单一、无锚点长段落 |
| `thesis_build` | 出 `论文.docx` | 有 pandoc 用 pandoc + 学校模板，没有用内置零依赖生成器（显式标注） |
| `thesis_originality` | 本地降重度量 | scan / verify / report；**不接收费查重**，报告里是本地估算 |
| `thesis_defense` | 答辩素材 + 六类问题库 | 每个问题带证据锚点（哪个文件哪一行） |
| `thesis_slides` | 答辩幻灯 | Marp 兼容 Markdown；outline / convert / check / guide；pptx 依赖外部引擎 |

## `defense_code_*`（3 个）

| 工具 | 一句话 |
|---|---|
| `defense_code_status` | 我的系统我讲得清吗（阶段、里程碑、验证门、未过的问题） |
| `defense_code_next` | 下一个该弄懂的模块（todo + 评分要点） |
| `defense_code_update` | 登记 / 推进 / 评分 / 重试（每次改动立即落盘） |

语言矩阵内置 Go / TS / Python / Rust；其它语言在配置里补 `codeWalkthrough.gates`。

## `fact_*`（3 个）

| 工具 | 一句话 |
|---|---|
| `fact_search` | 上次记下的学校规范还在吗（key/value 子串检索） |
| `fact_remember` | 记住一条跨会话仍成立的稳定事实 |
| `fact_context` | 把这个课题已知的稳定事实一次性拉回来 |

只记**跨会话仍然成立**的东西（学校规范、导师偏好、课题稳定事实）；进度、临时任务、一次性
实验数字不进记忆，那些在台账与实验记录里。

## 技能（11 个）

随插件发布，`thesis_init` 把它们复制进论文仓库 `.dsh/skills/`，跟着论文一起 git 版本化。

| 技能 | 解决什么 |
|---|---|
| `thesis-pipeline` | 全流程总纲：阶段、关卡、工具地图、会话入口顺序 |
| `thesis-opener` | 选题与开题（课题怎么定、开题报告怎么写） |
| `thesis-literature` | 文献调研：检索策略、阅读笔记、综述组织 |
| `thesis-eng-design` | 需求 / 设计 / 选型论证的写法 |
| `thesis-writing` | 逐章写作规范与验收标准 |
| `thesis-citation` | GB/T 7714 引用格式（只解决「格式对不对」） |
| `thesis-defense` | 答辩素材、问题库、幻灯与讲稿 |
| `code-walkthrough` | 把系统拆成答辩讲得清的模块（配 `defense_code_*`） |
| `paper-intake` | 材料到手后的追问方法论（怎么问出可证伪的要求） |
| `paper-dedup` | 原创性与降重：本地度量、改写处方、复测 |
| `thesis-inquiry` | 写作要求被质疑、导师口径模糊时怎么问清 |

## 没有斜杠命令

`ctx.commands` 一次都不注册。入口是自动驾驶（[autopilot.md](./autopilot.md)），
或者直接跟模型说话让它调工具。
