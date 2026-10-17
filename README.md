# dsh-thesis

**把一堆材料变成一篇经得起查重与答辩的论文，和一个讲得清自己系统的你。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的单一插件。给它学校模板、
论文要求、实验数据、代码和参考文献，它先追问、再动手，按九个阶段推进：

**选题 → 开题 → 文献 → 设计 → 实现 → 测试 → 论文 → 合规 → 答辩**

**没有斜杠命令。** 在论文工作区里开口说话，插件问一道选择题确认意图，然后自己一轮轮跑下去，
只在 G1-G4 人工关卡停下来让你拍板。全程留痕（台账 / 决定日志 / 检索记录 / 检查报告）。

纯 TypeScript，零运行时第三方依赖。对外只有三个命名空间：`thesis_*`、`fact_*`、`defense_code_*`。

## 安装

在 DSH 的**插件管理器里搜索 `dsh-thesis`** 装上，重启 dsh。

从源码装（想改代码，或本机没有 pnpm）：

```bash
git clone https://github.com/booondenz/dsh-thesis.git && cd dsh-thesis
npm install && npm run build                            # DSH 没有 TS 加载器，必须先编译
dsh plugin --profile web add "$PWD"                     # 需要 pnpm
node scripts/install-into-profile.mjs --profile web     # 没有 pnpm 时的兜底
```

卸载：插件管理器里移除，或 `dsh plugin --profile web remove dsh-thesis`。

## 第一次用

把材料放进论文目录（或告诉它绝对路径），在**该目录下**开会话说：

```
这是我的论文材料，帮我做毕业设计
```

它会弹一道选择题（从零走到答辩 / 只补合规与答辩 / 只做答辩准备 / 先别自动跑），
选完就自动推进；撞上 G1-G4 关卡时在审批界面点「允许」或「拒绝」。
没有材料也能用：「我要做毕业设计，还没定题」。

## 配置

默认值都在，通常不用写。需要时在 profile 的 `cordis.patch.yml` 那一行里覆盖：

```yaml
- id: paper
  name: dsh-thesis
  config:
    workspace: D:/毕业论文/我的论文        # 缺省从会话 cwd 向上探测 00-管理/进度台账.md
    autopilot: { maxGoalRounds: 20 }      # 自动续跑的轮数上限（默认 40）
```

完整字段见 [docs/config.md](./docs/config.md)。

## 红线（写在护栏里，不是写在文档里）

1. **零假文献**：引用只能来自真实检索缓存，`thesis_lit_save` 拒绝缓存外的 id。
2. **零假数据**：数据与结果必须来自真实运行；降重不许改数据与结论。
3. **人是作者**：G1-G4 关卡由工具强制，决定必须由你拍板。
4. **规范以学校文件为准**：没有模板时用内置过渡模板并**显式标注「非学校模板」**。
5. **降重不是洗稿**：不接收费查重，报告里是本地估算，与学校结果不可等同（可回填对照）。
6. **不静默销毁数据**：读不出来 ≠ 不存在；读失败就抛错，绝不用默认值覆盖。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/usage.md](./docs/usage.md) | 使用手册：第一次会话、九阶段、常见动作、产出物、中断续跑 |
| [docs/autopilot.md](./docs/autopilot.md) | 自动驾驶：四档意图、关卡拍板、何时不介入、降级与关闭 |
| [docs/tools.md](./docs/tools.md) | 21 个工具 + 11 个技能一览（名字即契约） |
| [docs/config.md](./docs/config.md) | 全部配置字段、默认值与约束 |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | 装了没反应、没弹选择题、PDF/pptx 失败等 |
| [docs/design.md](./docs/design.md) | 设计文档与 ADR（架构、分层、质量策略、已知边界） |
| [docs/host-api.md](./docs/host-api.md) | 宿主契约：用到的 DSH 接口与实测行为 |

## 开发

```bash
npm install && npm run build   # tsc → lib/
npm test                       # node --test（Node 24 直接跑 .ts）
npm run verify                 # build + typecheck + 全部单测 + 审计 + 端到端
```

质量分层：单测/契约、真实场景端到端、真实 cordis 装配、真实 dsh 引擎装载、对外表面审计
（见 [docs/design.md](./docs/design.md) §9）。

## 许可

MIT。来源声明见 [NOTICE.md](./NOTICE.md)。
