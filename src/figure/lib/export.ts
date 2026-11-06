/**
 * draw.io 命令行导出：探测桌面板、执行导出、把每次尝试写成可复查的说明。
 *
 * 形态与 `ppt/convert.ts` 一致（探测 → 执行 → 校验产物 → 如实报告），原因也一样：
 * **退出码 0 不等于成功**。draw.io 桌面版在若干情况下会「正常退出但没写文件」
 * （路径不存在、被安全软件拦住、Electron 起不来），所以导出之后必须再确认
 * 文件存在且非空，否则学生会拿到一个空图却以为导出成功了。
 *
 * 探测刻意**不启动 GUI**：`drawio --version` 在桌面版上会拉起窗口，所以这里改为
 * 「在 PATH 与常见安装目录里找可执行文件」，只做文件系统检查。
 *
 * 没有可用的 draw.io 也不算死路：`.drawio` 源文件已经落盘，学生可以在
 * app.diagrams.net 或 VS Code 的 Draw.io 扩展里打开并导出 PNG，{@link drawioGuide}
 * 给出可直接照做的步骤。
 *
 * @module dsh-thesis/figure/export
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'

/** 一次命令执行的记录（写进导出说明）。 */
export interface ExportCommandRecord {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly status: number | null
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
  readonly timedOut: boolean
}

/** 可注入的执行器（默认 spawnSync；测试传替身）。 */
export interface SpawnOptions {
  readonly cwd?: string
  readonly encoding?: string
  readonly timeout?: number
  readonly maxBuffer?: number
}
export interface SpawnResult {
  readonly status: number | null
  readonly stdout: string | null
  readonly stderr: string | null
  readonly error?: Error
}
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnResult

/** 探测到的 draw.io 可执行文件。 */
export interface DrawioEngine {
  readonly command: string
  readonly label: string
  readonly source: 'config' | 'path' | 'common'
}

/** 探测结果。 */
export interface DrawioDetection {
  /** 找到的可执行文件；没找到时 `undefined`（不是错误，是「本机没装」）。 */
  readonly engine?: DrawioEngine
  /** 探测过的候选路径（写给用户看，避免「为什么没找到」）。 */
  readonly probes: readonly string[]
  /** 探测失败的原因摘要。 */
  readonly problems: readonly string[]
}

/** 单次导出超时（draw.io 冷启动 + 渲染，60 秒足够）。 */
export const EXPORT_TIMEOUT_MS = 60_000
/** 默认导出倍率：740 单位宽的图 → 2220px，排进 15cm 栏宽约 376dpi。 */
export const DEFAULT_SCALE = 3

const EXCERPT = 600

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnResult {
  return spawnSync(command, [...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    encoding: options.encoding ?? 'utf8',
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  })
}

function fsExists(path: string): boolean {
  return existsSync(path)
}

function fsSize(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

function displayCommand(command: string, args: readonly string[]): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value)
  return [command, ...args].map(quote).join(' ')
}

function excerpt(text: string | null | undefined, limit = EXCERPT): string {
  const trimmed = (text ?? '').trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断）`
}

/** 各平台常见的 draw.io 安装位置（只列桌面版；不含需要联网的网页版）。 */
const COMMON_INSTALLS: Readonly<Record<string, readonly string[]>> = {
  win32: [
    'C:\\Program Files\\draw.io\\draw.io.exe',
    'C:\\Program Files (x86)\\draw.io\\draw.io.exe',
  ],
  darwin: ['/Applications/draw.io.app/Contents/MacOS/draw.io'],
  linux: ['/usr/bin/drawio', '/snap/bin/drawio', '/opt/drawio/drawio'],
}

/** 可执行文件名（Windows 需要扩展名）。 */
const EXECUTABLE_NAMES: Readonly<Record<string, readonly string[]>> = {
  win32: ['drawio.exe', 'draw.io.exe', 'drawio'],
  darwin: ['drawio', 'draw.io'],
  linux: ['drawio', 'draw.io'],
}

function namesFor(platform: string): readonly string[] {
  return EXECUTABLE_NAMES[platform] ?? EXECUTABLE_NAMES.linux ?? ['drawio']
}

function installsFor(platform: string): readonly string[] {
  return COMMON_INSTALLS[platform] ?? COMMON_INSTALLS.linux ?? []
}

/**
 * 探测本机的 draw.io 桌面版。
 *
 * 顺序：显式配置 → PATH → 常见安装目录。返回第一个真实存在的可执行文件；
 * 全部不存在时 `engine` 为 undefined，`problems` 里说明「本机未发现 draw.io 桌面版」。
 */
export function detectDrawio(options: {
  readonly configured?: string
  readonly env?: Record<string, string | undefined>
  readonly platform?: string
  readonly exists?: (path: string) => boolean
} = {}): DrawioDetection {
  const exists = options.exists ?? fsExists
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const probes: string[] = []
  const problems: string[] = []

  if (options.configured !== undefined && options.configured.trim() !== '') {
    const configured = options.configured.trim()
    probes.push(configured)
    if (exists(configured)) {
      return { engine: { command: configured, label: 'draw.io（配置指定）', source: 'config' }, probes, problems }
    }
    problems.push(`配置的 draw.io 路径不存在：${configured}`)
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  const pathEntries = pathValue.split(nodePath.delimiter).filter(entry => entry.trim() !== '')
  for (const name of namesFor(platform)) {
    for (const dir of pathEntries) {
      const candidate = nodePath.join(dir, name)
      probes.push(candidate)
      if (exists(candidate)) {
        return { engine: { command: candidate, label: `draw.io（PATH：${candidate}）`, source: 'path' }, probes, problems }
      }
    }
  }

  const candidates = [...installsFor(platform)]
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (localAppData !== undefined && localAppData !== '') {
      candidates.unshift(nodePath.join(localAppData, 'Programs', 'draw.io', 'draw.io.exe'))
    }
    const programFiles = env.ProgramFiles
    if (programFiles !== undefined && programFiles !== '') {
      candidates.push(nodePath.join(programFiles, 'draw.io', 'draw.io.exe'))
    }
  }
  for (const candidate of candidates) {
    probes.push(candidate)
    if (exists(candidate)) {
      return { engine: { command: candidate, label: `draw.io（安装目录：${candidate}）`, source: 'common' }, probes, problems }
    }
  }

  problems.push('本机未发现 draw.io 桌面版（PATH 与常见安装目录都没有 drawio 可执行文件）。')
  return { probes, problems }
}

/** 导出参数。 */
export interface ExportOptions {
  readonly scale?: number
  readonly format?: 'png' | 'svg'
  readonly timeoutMs?: number
  readonly spawn?: SpawnFn
  readonly exists?: (path: string) => boolean
  readonly size?: (path: string) => number | undefined
  readonly cwd?: string
}

/** 一次导出的结果。 */
export interface ExportOutcome {
  readonly ok: true
  readonly record: ExportCommandRecord
  readonly outPath: string
  readonly bytes: number | undefined
}

/**
 * 把 `.drawio` 导出成图片。
 *
 * 失败一律抛错，错误里带**完整命令**与退出码：学生会看到自己该在哪一步修什么，
 * 而不是一句「导出失败」。
 */
export function exportDiagram(
  engine: DrawioEngine,
  drawioPath: string,
  outPath: string,
  options: ExportOptions = {},
): ExportOutcome {
  const spawn = options.spawn ?? defaultSpawn
  const exists = options.exists ?? fsExists
  const size = options.size ?? fsSize
  const format = options.format ?? 'png'
  const scale = options.scale ?? DEFAULT_SCALE
  const args = [
    '--export',
    '--format', format,
    '--scale', String(scale),
    '--border', '10',
    '--output', outPath,
    drawioPath,
  ]
  const started = Date.now()
  let result: SpawnResult
  try {
    result = spawn(engine.command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      encoding: 'utf8',
      timeout: options.timeoutMs ?? EXPORT_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(
      `draw.io 导出未能启动：${String(error)}\n命令：${displayCommand(engine.command, args)}`,
    )
  }
  const elapsedMs = Date.now() - started
  const stderr = result.stderr ?? ''
  const timedOut = result.status === null && result.error !== undefined && /ETIMEDOUT|timed out/i.test(result.error.message)
  const record: ExportCommandRecord = {
    label: 'draw.io 导出',
    command: engine.command,
    args,
    status: result.status,
    ok: result.status === 0,
    stdout: excerpt(result.stdout),
    stderr: excerpt(stderr !== '' ? stderr : result.error?.message),
    elapsedMs,
    timedOut,
  }

  if (!record.ok) {
    const why = record.timedOut ? '超时被终止' : `退出码 ${record.status ?? 'null'}`
    throw new Error(
      `draw.io 导出失败（${why}）。\n命令：${displayCommand(record.command, record.args)}\n`
      + `${record.stderr === '' ? '' : `stderr：${record.stderr.split('\n')[0] ?? ''}\n`}`
      + '排查：确认 draw.io 能手工打开这个 .drawio；若装了桌面版但不在 PATH，请在配置里指定 figure.drawioPath。',
    )
  }
  if (!exists(outPath)) {
    throw new Error(
      `draw.io 退出码为 0，但没有写出 ${outPath}。\n命令：${displayCommand(record.command, record.args)}\n`
      + '这通常是路径不可写或被安全软件拦截；可先手工在 draw.io 里导出一次确认。',
    )
  }
  const bytes = size(outPath)
  if (bytes === 0) {
    throw new Error(`draw.io 写出的 ${outPath} 是 0 字节（静默失败）。\n命令：${displayCommand(record.command, record.args)}`)
  }
  return { ok: true, record, outPath, bytes }
}

/** 导出说明的一项（一张图）。 */
export interface ExportNotesItem {
  readonly figureRel: string
  readonly imageRel?: string
  readonly outcome?: ExportOutcome
  readonly error?: string
}

/** 导出说明的输入（一次导出可能包含多张图）。 */
export interface ExportNotesInput {
  readonly items: readonly ExportNotesItem[]
  readonly detection: DrawioDetection
  readonly format: 'png' | 'svg'
  readonly scale: number
  readonly now?: Date
}

/**
 * 渲染导出说明（无论成功失败都落盘）：探测了哪些路径、跑了什么命令、退出码与输出摘要。
 * 这份文件是「图为什么没导出来」的唯一现场，避免学生只看到一句错误提示。
 */
export function renderExportNotes(input: ExportNotesInput): string {
  const now = input.now ?? new Date()
  const lines: string[] = []
  lines.push('# 插图导出说明')
  lines.push('')
  lines.push(`> 由 thesis_figure 生成；时间：${now.toISOString()}`)
  lines.push('> `.drawio` 是可编辑源文件（唯一真源），PNG/SVG 是导出件，供论文与幻灯使用。')
  lines.push('')
  lines.push('## 一、draw.io 探测结果')
  lines.push('')
  if (input.detection.engine !== undefined) {
    lines.push(`- 可用：${input.detection.engine.label}`)
    lines.push(`- 命令：\`${input.detection.engine.command}\``)
  } else {
    lines.push('- 未发现 draw.io 桌面版。')
  }
  for (const problem of input.detection.problems) lines.push(`- ${problem}`)
  if (input.detection.probes.length > 0) {
    lines.push('')
    lines.push(`- 已检查的候选路径：${input.detection.probes.slice(0, 8).join('、')}${input.detection.probes.length > 8 ? ` 等 ${input.detection.probes.length} 个` : ''}`)
  }
  lines.push('')
  lines.push('## 二、导出记录')
  lines.push('')
  lines.push(`格式：${input.format}；倍率：${input.scale}×`)
  lines.push('')
  if (input.items.length === 0) {
    lines.push('（本次没有需要导出的图）')
    lines.push('')
  }
  for (const item of input.items) {
    lines.push(`### ${item.figureRel}`)
    lines.push('')
    lines.push(`- 导出件：${item.imageRel === undefined ? '（未产出）' : `\`${item.imageRel}\``}`)
    if (item.outcome !== undefined) {
      const record = item.outcome.record
      lines.push(`- 命令：\`${displayCommand(record.command, record.args)}\``)
      lines.push(`- 退出码：${record.status ?? 'null'}；耗时：${record.elapsedMs} ms${record.timedOut ? '（超时）' : ''}`)
      lines.push(`- 产物：\`${item.outcome.outPath}\`${item.outcome.bytes === undefined ? '' : `（${item.outcome.bytes} 字节）`}`)
      if (record.stdout !== '') {
        lines.push('- stdout 摘要：')
        lines.push('')
        lines.push('```text')
        lines.push(record.stdout)
        lines.push('```')
      }
      if (record.stderr !== '') {
        lines.push('- stderr 摘要：')
        lines.push('')
        lines.push('```text')
        lines.push(record.stderr)
        lines.push('```')
      }
    } else if (item.error !== undefined) {
      lines.push('- 结果：**未产出图片**')
      lines.push('')
      lines.push('```text')
      lines.push(excerpt(item.error, 2000))
      lines.push('```')
    }
    lines.push('')
  }
  lines.push('## 三、没有 draw.io 桌面版时（三选一）')
  lines.push('')
  lines.push('1. **在线版**：打开 https://app.diagrams.net → 打开源文件 → 文件 → 导出为 → PNG（缩放 300%）。')
  lines.push('2. **VS Code 扩展**：安装 `hediet.vscode-drawio`（Draw.io Integration），打开 .drawio 后按 `F1` → `Draw.io: Export`。')
  lines.push('3. **装桌面版**（推荐长期使用）：`winget install --id JGraph.Draw -e`；装好后重跑 `thesis_figure action=export`。')
  lines.push('')
  return lines.join('\n')
}

/** 安装与手工导出的指引（工具 `action=guide` 与失败信息共用）。 */
export function drawioGuide(figureRel?: string): string {
  const target = figureRel ?? '06-论文/assets/图/xxx.drawio'
  const lines: string[] = []
  lines.push('# draw.io 出图指引')
  lines.push('')
  lines.push('论文里的图用 **draw.io 源文件 + 高分辨率 PNG**：源文件可改、PNG 能进 Word，')
  lines.push('两者都留在 `06-论文/assets/图/` 里，随论文一起 git 版本化。')
  lines.push('')
  lines.push('## 一、装桌面版（可选，装了就能自动导出）')
  lines.push('')
  lines.push('```powershell')
  lines.push('# Windows（winget 自带，装完重新打开终端）')
  lines.push('winget install --id JGraph.Draw -e')
  lines.push('```')
  lines.push('')
  lines.push('```bash')
  lines.push('# macOS')
  lines.push('brew install --cask drawio')
  lines.push('# Ubuntu/Debian')
  lines.push('sudo snap install drawio')
  lines.push('```')
  lines.push('')
  lines.push('## 二、导出命令（桌面版）')
  lines.push('')
  lines.push('```powershell')
  lines.push(`drawio --export --format png --scale 3 --border 10 --output 06-论文/assets/图/xxx.png ${target}`)
  lines.push('```')
  lines.push('')
  lines.push('导出后用 `thesis_figure action=check` 核对：源文件、图片、正文引用三者是否对齐。')
  lines.push('')
  lines.push('## 三、没有桌面版也能导出')
  lines.push('')
  lines.push('1. 在线版：https://app.diagrams.net → 打开 .drawio → 文件 → 导出为 → PNG（缩放 300%）。')
  lines.push('2. VS Code：安装 `hediet.vscode-drawio`，打开 .drawio → `F1` → `Draw.io: Export` → PNG。')
  lines.push('')
  lines.push('## 四、让图不糙的四条硬规则')
  lines.push('')
  lines.push('1. **一张图只讲一件事**：总体架构图就只放层与模块，别把数据库字段也塞进去。')
  lines.push('2. **模块名用名词、动词留给箭头**：方框写「任务服务」，箭头标「HTTP/JSON」。')
  lines.push('3. **字号不小于 10pt**：导出后按论文栏宽（约 15cm）看，字太小就合并模块，别缩字号。')
  lines.push('4. **图题在图下方、正文先引用**：图 4-1 系统总体架构图；正文写「如图 4-1 所示」。')
  lines.push('')
  return lines.join('\n')
}
