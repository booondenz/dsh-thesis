# 排查

## 装了但没反应 / 工具看不见

宿主在装载前会校验 `package.json` 里 `@deepseek-ai/dsh*` 的 `peerDependencies`，
**不满足就把这一行静默 `disabled`**（stderr 只有一句 `dsh: disabling profile plugin row …`）。
本插件声明：

```
@deepseek-ai/dsh-tools: >=0.2.0-rc.2 <0.3.0-0
```

排查顺序：

1. 确认 dsh 版本：`dsh --version`。跨小版本（0.3+）时这条 range 就要放宽，不能硬装。
2. 跑 `npm run test:host-load`：它用**宿主自己的预检函数**判断真实副本会不会被停用。
3. 跑 `npm run test:host`：真实 cordis 装配 + 真实工具注册表。
4. 装了插件管理器却报 `installation rejected`：多半是旧版本缓存。`dsh plugin add dsh-thesis@<确切版本>` 钉住版本，
   或 `pnpm cache delete dsh-thesis` 后再装。

## 重启后还是旧行为

- `dsh plugin add` 装的是 **npm 上的那一版**，改了源码不重装不会生效；本地开发用
  `node scripts/install-into-profile.mjs --profile web`（把 profile 指到本仓库，重启生效）。
- DSH 没有 TS 加载器：**必须先 `npm run build`**（产出 `lib/`），直接指向源码不会工作。
- 确认改到的是同一个 profile：`--profile web` 要和实际启动参数一致。

## 说了话但没弹那道选择题

自动驾驶只在「**论文工作区** + **主 agent** + **还没有意图规格**」时问。看会话日志：

| 日志 | 含义 |
|---|---|
| `已有意图规格` | `00-管理/意图规格.md` 已存在，不再重复问（删掉它或换工作区可重新选）|
| `意图选择题没有拿到答案` | UI 不接受非工具调用的问题卡片，或你取消了 |
| `宿主没有 userQuestions 服务` | 这套组合没有问答面 |
| `宿主没有 goals 服务` | 只会跑一轮，不自动续轮 |

前三行都意味着：插件有意**不猜**你的意图。直接说话即可，工具都在。

## 关卡没问就过了

`autopilot.gateApproval` 被设成了 `false`。改成 `true` 就恢复「过人卡必须由人拍板」。

## PDF 读不出文字

扫描版（没有文本层）、加密 PDF、只有 CID 字体且无 ToUnicode 映射的 PDF 抽不出内容。
工具会**如实说明原因**，不会编造。处理办法：先用 OCR 或另存一份带文本层的 PDF 再摄取。

## `.pptx` 没生成

幻灯的真相是 Markdown（`07-答辩/PPT.md`），`.pptx` 交给外部工具：

```bash
npx -y @marp-team/marp-cli 07-答辩/PPT.md --pptx
# 或
pandoc 07-答辩/PPT.md -o 07-答辩/PPT.pptx
```

两者都没有时，`thesis_slides convert` 会写一份 `07-答辩/PPT转换说明.md`（探测结果 + 确切命令 + 退出码），
**绝不假装成功**。装了 marp 之后重跑即可。

## 旧格式打不开

`.doc` / `.xls` / `.ppt` 不支持，先另存为 `.docx` / `.xlsx` / `.pptx`。

## 工具写到别的目录去了？

不会，但会**报错**：配了 `workspace` 却找不到 `00-管理/进度台账.md` 时，工具直接失败而不是退回 cwd 探测。
这正是防「写错地方」的设计。要么改 `workspace`，要么先在工作区跑 `thesis_init`。

## 读文件失败 vs 文件不存在

两者严格区分：读失败（权限 / IO）会抛错并保持原文件不动，绝不会用默认值覆盖。
「读不出来 ≠ 不存在」是整个仓库的硬约束。

## 中文乱码

工作区里的文件统一 UTF-8（无 BOM）。Windows 上用 PowerShell 查看时加 `-Encoding utf8`：

```powershell
Get-Content 00-管理\进度台账.md -Encoding utf8
```

## 代价与限速

- 自动续跑每一轮都是一次完整模型调用，`autopilot.maxGoalRounds` 是唯一刹车；调小它比事后心疼便宜。
- 外部命令（pandoc / marp / git）走 `spawnSync`：有超时，**没有信号传递**（按下停止不会杀掉子进程）。
