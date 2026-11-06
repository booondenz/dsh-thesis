/**
 * `thesis_figure` 的业务实现：建图（create）、导出（export）、体检（check）、指引（guide）。
 *
 * 三条产品原则：
 *
 * 1. **源文件优先**：`.drawio` 是唯一真源，落盘在 `06-论文/assets/图/`，随论文 git 版本化；
 *    PNG 是导出件，随时可以重出。学生答辩前改一张图，不需要重画。
 * 2. **图题与编号自动算**：给 `chapter` 就按该章已有图号递增出「图 4-2 …」，
 *    避免手写编号断档——这正是 `thesis_check` 会判错的地方。
 * 3. **没有 draw.io 也不假装成功**：导出失败/未安装都如实说，并给出三条可执行的替代路径
 *    （在线版 / VS Code 扩展 / 装桌面版）。建图本身不因导出失败而失败。
 *
 * @module dsh-thesis/figure
 */

import * as nodePath from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FigureOptions } from '../config.ts'
import { CHAPTER_META, chapterMetaFor } from '../paper/lib/layout.ts'
import { findThesisRoot, workspaceNotFoundError } from '../paper/lib/project.ts'
import { imageFormatOf, readImageInfo } from '../paper/lib/image.ts'
import { isMissingError } from '../shared/fs-errors.ts'
import {
  checkFigures, renderFigureReport, stemOf,
  type FigureFileEntry, type FigureReference,
} from './lib/check.ts'
import { DEFAULT_PAGE_HEIGHT, renderMxfile, validateMxfile } from './lib/drawio.ts'
import {
  detectDrawio, drawioGuide, exportDiagram, renderExportNotes,
  type DrawioDetection, type DrawioEngine, type ExportOutcome,
} from './lib/export.ts'
import { buildDrawing } from './lib/layout.ts'
import { describeModel, parseFigureModel, type FigureKind } from './lib/spec.ts'

/** 插件配置里与出图有关的字段（定义在 config.ts，默认值同源）。 */
export type { FigureOptions }

/** 图的源文件与导出件目录（相对论文工作区根）。 */
export const FIGURE_DIR = '06-论文/assets/图'
/** 最近一次导出的现场记录。 */
export const FIGURE_NOTES = `${FIGURE_DIR}/导出说明.md`
/** 图表清单（check 的产物）。 */
export const FIGURE_INVENTORY = `${FIGURE_DIR}/图表清单.md`
/** 章节正文目录。 */
export const CHAPTER_DIR = '06-论文/章节'

/** 工具参数。 */
export interface FigureArgs {
  readonly action: 'create' | 'export' | 'check' | 'guide'
  readonly kind?: FigureKind
  readonly name?: string
  readonly title?: string
  readonly chapter?: string
  readonly caption?: string
  readonly spec?: unknown
  readonly export?: boolean
  readonly force?: boolean
  readonly format?: 'png' | 'svg'
  readonly scale?: number
}

/** 可注入的外部依赖（测试用；生产走默认实现）。 */
export interface FigureDeps {
  readonly now?: () => Date
  readonly platform?: string
  readonly env?: Record<string, string | undefined>
  readonly detect?: (options: { configured?: string; platform?: string; env?: Record<string, string | undefined> }) => DrawioDetection
  readonly runExport?: (engine: DrawioEngine, drawioPath: string, outPath: string, options: { scale: number; format: 'png' | 'svg'; timeoutMs: number }) => ExportOutcome
  /** 文件修改时间（用于「导出件比源文件旧」检查）；拿不到返回 undefined。 */
  readonly mtimeMs?: (absPath: string) => number | undefined
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readMtime(absPath: string): number | undefined {
  try {
    return statSync(absPath).mtimeMs
  } catch {
    return undefined
  }
}

async function readOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await fs.readText(await fs.resolve(absPath, { signal }), signal)
  } catch (error) {
    if (isMissingError(error)) return undefined
    throw error
  }
}

async function listOptional(fs: FileSystem, absDir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    return (await fs.listDir(await fs.resolve(absDir, { signal }), signal)).map(entry => entry.name)
  } catch (error) {
    if (isMissingError(error)) return []
    throw error
  }
}

/** 文件名：保留中文，替换掉路径分隔符与 Windows 非法字符。 */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return slug
}

/** 把章节参数（文件名 / 序号 / 章标题）解析成章节元数据。 */
export function resolveChapter(chapter: string): { readonly file: string; readonly chapterNo: number } | undefined {
  const raw = chapter.trim().replace(/\.md$/i, '')
  const direct = chapterMetaFor(raw)
  if (direct !== undefined) return { file: direct.meta.file, chapterNo: direct.chapterNo }
  if (/^\d+$/.test(raw)) {
    const meta = CHAPTER_META[Number(raw) - 1]
    if (meta !== undefined) return { file: meta.file, chapterNo: Number(raw) }
  }
  const index = CHAPTER_META.findIndex(meta => meta.title === raw || meta.file.includes(raw))
  if (index === -1) return undefined
  const meta = CHAPTER_META[index]!
  return { file: meta.file, chapterNo: index + 1 }
}

/** 该章已有的最大图号 + 1（按「图 4-N」统计，正文引用与图题都算）。 */
export function nextFigureIndex(chapterText: string, chapterNo: number): number {
  const pattern = new RegExp(`图\\s*${chapterNo}\\s*[-－—–]\\s*(\\d+)`, 'g')
  let max = 0
  for (const match of chapterText.matchAll(pattern)) max = Math.max(max, Number(match[1]))
  return max + 1
}

/** 默认图名（学生没写 title 时的兜底，不猜业务内容）。 */
const DEFAULT_TITLES: Readonly<Record<FigureKind, string>> = {
  architecture: '系统总体架构图',
  flow: '业务流程图',
  er: '数据库 E-R 图',
  sequence: '接口时序图',
  custom: '示意图',
}

/** 章节里的图片引用（含行号与图题）。 */
export function extractReferences(text: string): { readonly line: number; readonly alt: string; readonly src: string }[] {
  const references: { line: number; alt: string; src: string }[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    for (const match of line.matchAll(pattern)) {
      references.push({ line: index + 1, alt: match[1] ?? '', src: match[2] ?? '' })
    }
  })
  return references
}

/** 解析图片路径：先按章节文件所在目录，再按论文根。 */
async function resolveImage(
  fs: FileSystem,
  root: string,
  chapterAbs: string,
  src: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (nodePath.isAbsolute(src)) return src
  const candidates = [
    nodePath.resolve(nodePath.dirname(chapterAbs), src),
    nodePath.resolve(root, src),
  ]
  for (const candidate of candidates) {
    try {
      const info = await fs.stat(await fs.resolve(candidate, { signal }), signal)
      if (info !== undefined && !info.isDirectory) return candidate
    } catch {
      // 探测失败按「不存在」处理：这里只用于生成检查清单，不写任何东西。
    }
  }
  return undefined
}

function toRel(root: string, absPath: string): string {
  return nodePath.relative(root, absPath).replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runCreate(
  fs: FileSystem,
  root: string,
  args: FigureArgs,
  options: FigureOptions,
  signal: AbortSignal | undefined,
  deps: FigureDeps,
): Promise<string> {
  if (args.kind === undefined) {
    throw new Error('缺少 kind：可选 architecture（分层架构图）/ flow（流程图）/ er（数据库 E-R 图）/ sequence（时序图）/ custom（直接贴 draw.io 的 XML）。')
  }
  const model = parseFigureModel(args.kind, args.spec)
  const title = (args.title ?? '').trim() === '' ? DEFAULT_TITLES[args.kind] : args.title!.trim()
  const drawing = buildDrawing(model)

  if (model.kind === 'custom') {
    const check = validateMxfile(model.model.xml)
    if (!check.ok) throw new Error(`custom 图的 XML 不合法：${check.reason}`)
  }

  const base = slugify(args.name ?? title)
  if (base === '') throw new Error('name（或 title）去掉非法字符后是空的，请给一个能当文件名的名字，例如 arch-overview。')

  const targetRel = `${FIGURE_DIR}/${base}.drawio`
  const targetAbs = nodePath.join(root, targetRel)
  const existing = await readOptional(fs, targetAbs, signal)
  let backupRel: string | undefined
  if (existing !== undefined) {
    if (args.force !== true) {
      throw new Error(`图源文件已存在：${targetRel}。要覆盖请传 force: true（覆盖前会另存旧文件），或用 name 换一个名字。`)
    }
    const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
    const backupName = `${base}-${stamp}.drawio`
    // 备份放进 历史/ 子目录：export 与 check 只扫当前目录，旧版本不会被当成"待导出的图"。
    await fs.writeText(await fs.resolve(nodePath.join(root, FIGURE_DIR, '历史', backupName), { signal }), existing, undefined, signal)
    backupRel = `${FIGURE_DIR}/历史/${backupName}`
  }

  const xml = model.kind === 'custom'
    ? model.model.xml
    : renderMxfile({
      name: title,
      cells: drawing.cells,
      pageHeight: Math.max(DEFAULT_PAGE_HEIGHT, Math.ceil(drawing.height) + 40),
      now: deps.now?.() ?? new Date(),
    })
  await fs.writeText(await fs.resolve(targetAbs, { signal }), xml, undefined, signal)

  // 图题与编号：给了 chapter 就按该章已有图号递增。
  let caption = args.caption?.trim()
  let chapterNote = ''
  if (caption === undefined || caption === '') {
    if (args.chapter !== undefined && args.chapter.trim() !== '') {
      const chapter = resolveChapter(args.chapter)
      if (chapter === undefined) {
        throw new Error(`无法识别章节「${args.chapter}」：可用 ${CHAPTER_META.map(meta => meta.file).join(' / ')}（也可写章号 1-7）。`)
      }
      const chapterText = (await readOptional(fs, nodePath.join(root, CHAPTER_DIR, `${chapter.file}.md`), signal)) ?? ''
      const index = nextFigureIndex(chapterText, chapter.chapterNo)
      caption = `图 ${chapter.chapterNo}-${index} ${title}`
      chapterNote = `（第 ${chapter.chapterNo} 章已有 ${index - 1} 张图，自动编号为 ${chapter.chapterNo}-${index}）`
    } else {
      caption = title
      chapterNote = '（未给 chapter，图题里没有编号；写正文时请改成「图 4-1 …」并保持连续）'
    }
  }

  // 导出（失败不阻塞建图，但必须如实报告）。
  const detection = (deps.detect ?? detectDrawio)({
    ...(options.drawioPath !== undefined ? { configured: options.drawioPath } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  })
  const format = args.format ?? 'png'
  const scale = args.scale ?? options.scale
  let exported: ExportOutcome | undefined
  let exportError: string | undefined
  const shouldExport = args.export !== false
  if (shouldExport && detection.engine !== undefined) {
    try {
      exported = (deps.runExport ?? exportDiagram)(detection.engine, targetAbs, nodePath.join(root, FIGURE_DIR, `${base}.${format}`), {
        scale,
        format,
        timeoutMs: options.timeoutMs,
      })
    } catch (error) {
      exportError = error instanceof Error ? error.message : String(error)
    }
  }
  const notes = renderExportNotes({
    items: [{
      figureRel: targetRel,
      ...(exported !== undefined ? { imageRel: toRel(root, exported.outPath) } : {}),
      ...(exported !== undefined ? { outcome: exported } : {}),
      ...(exportError !== undefined ? { error: exportError } : {}),
    }],
    detection,
    format,
    scale,
    now: deps.now?.() ?? new Date(),
  })
  await fs.writeText(await fs.resolve(nodePath.join(root, FIGURE_NOTES), { signal }), notes, undefined, signal)

  const imageRel = exported !== undefined ? toRel(root, exported.outPath) : `${FIGURE_DIR}/${base}.${format}`
  const snippet = `![${caption}](../assets/图/${base}.${format})`
  const lines: string[] = []
  lines.push(`已生成图源文件：${targetRel}`)
  lines.push(`- 种类：${model.kind}（${describeModel(model)}）`)
  if (backupRel !== undefined) lines.push(`- 旧文件已备份：${backupRel}`)
  lines.push(`- 图题：${caption}${chapterNote}`)
  for (const note of drawing.notes) lines.push(`- 版面提示：${note}`)
  if (exported !== undefined) {
    lines.push(`- 导出：${imageRel}（draw.io ${scale}×）`)
  } else if (!shouldExport) {
    lines.push('- 导出：已跳过（export=false）。需要图片时运行 thesis_figure action=export。')
  } else if (detection.engine === undefined) {
    lines.push('- 导出：未执行 —— 本机没有找到 draw.io 桌面版。')
    lines.push('  按 thesis_figure action=guide 的三条路径之一导出 PNG，再运行 action=check 核对。')
  } else {
    lines.push(`- 导出：失败 —— ${(exportError ?? '未知原因').split('\n')[0]}`)
    lines.push(`  现场记录见 ${FIGURE_NOTES}；修好后运行 thesis_figure action=export 重试。`)
  }
  lines.push('')
  lines.push('写进章节（正文先引用，图题在图下方）：')
  lines.push('')
  const citeNumber = /^图\s*(\d+[-–—]\d+)/.exec(caption)?.[1]
  lines.push('```markdown')
  lines.push(citeNumber === undefined
    ? '（图题里没有编号：正文引用时先补成「图 4-1 …」再写「如图 4-1 所示」）'
    : `如图 ${citeNumber} 所示，……`)
  lines.push('')
  lines.push(snippet)
  lines.push('```')
  lines.push('')
  lines.push('写法：图片单独成行、alt 就是图题（构建时图在上、图题排在图下方）；路径相对章节文件（06-论文/章节/）。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function runExport(
  fs: FileSystem,
  root: string,
  args: FigureArgs,
  options: FigureOptions,
  signal: AbortSignal | undefined,
  deps: FigureDeps,
): Promise<string> {
  const entries = (await listOptional(fs, nodePath.join(root, FIGURE_DIR), signal)).filter(name => /\.drawio$/i.test(name))
  if (entries.length === 0) {
    throw new Error(`还没有可导出的图源文件（${FIGURE_DIR}/*.drawio）。先运行 thesis_figure action=create。`)
  }
  const filter = args.name?.trim()
  const selected = (filter === undefined || filter === ''
    ? entries
    : entries.filter(name => stemOf(name) === stemOf(filter) || name === filter))
  if (selected.length === 0) {
    throw new Error(`在 ${FIGURE_DIR} 里没有找到名为「${filter}」的 .drawio；现有：${entries.join('、')}`)
  }

  const detection = (deps.detect ?? detectDrawio)({
    ...(options.drawioPath !== undefined ? { configured: options.drawioPath } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  })
  const format = args.format ?? 'png'
  const scale = args.scale ?? options.scale
  const now = deps.now?.() ?? new Date()

  if (detection.engine === undefined) {
    const notes = renderExportNotes({
      items: selected.map(name => ({ figureRel: `${FIGURE_DIR}/${name}` })),
      detection,
      format,
      scale,
      now,
    })
    await fs.writeText(await fs.resolve(nodePath.join(root, FIGURE_NOTES), { signal }), notes, undefined, signal)
    throw new Error(
      `未发现 draw.io 桌面版，无法自动导出（源文件已保留，不会丢）。\n${detection.problems.join('\n')}\n`
      + `三条替代路径见 thesis_figure action=guide；导出记录已写入 ${FIGURE_NOTES}。`,
    )
  }

  const items: { figureRel: string; imageRel?: string; outcome?: ExportOutcome; error?: string }[] = []
  const failures: string[] = []
  for (const name of selected) {
    const drawioAbs = nodePath.join(root, FIGURE_DIR, name)
    const outAbs = nodePath.join(root, FIGURE_DIR, `${stemOf(name)}.${format}`)
    const figureRel = toRel(root, drawioAbs)
    try {
      const outcome = (deps.runExport ?? exportDiagram)(detection.engine, drawioAbs, outAbs, { scale, format, timeoutMs: options.timeoutMs })
      items.push({ figureRel, imageRel: toRel(root, outAbs), outcome })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      items.push({ figureRel, error: message })
      failures.push(`- ${figureRel}：${message.split('\n')[0]}`)
    }
  }

  const notes = renderExportNotes({ items, detection, format, scale, now })
  await fs.writeText(await fs.resolve(nodePath.join(root, FIGURE_NOTES), { signal }), notes, undefined, signal)

  const lines: string[] = []
  lines.push(`导出完成：${items.length - failures.length}/${items.length} 张（${format}，${scale}×）。`)
  for (const item of items) {
    lines.push(item.error === undefined
      ? `- ✓ ${item.figureRel} → ${item.imageRel}`
      : `- ✗ ${item.figureRel}：${item.error.split('\n')[0]}`)
  }
  lines.push('')
  lines.push(`现场记录：${FIGURE_NOTES}`)
  if (failures.length > 0) {
    throw new Error(`${lines.join('\n')}\n\n${failures.length} 张图导出失败。`)
  }
  lines.push('下一步：把图片写进对应章节（图题在图下方），然后运行 thesis_figure action=check 核对。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function runCheck(
  fs: FileSystem,
  root: string,
  signal: AbortSignal | undefined,
  deps: FigureDeps,
): Promise<string> {
  const mtime = deps.mtimeMs ?? readMtime
  const figureDirAbs = nodePath.join(root, FIGURE_DIR)
  const figureFiles = await listOptional(fs, figureDirAbs, signal)

  const sources: FigureFileEntry[] = []
  const images: FigureFileEntry[] = []
  for (const name of figureFiles) {
    const abs = nodePath.join(figureDirAbs, name)
    const rel = toRel(root, abs)
    const modified = mtime(abs)
    if (/\.drawio$/i.test(name)) {
      sources.push({ path: rel, ...(modified !== undefined ? { mtimeMs: modified } : {}) })
      continue
    }
    if (!/\.(png|jpe?g|svg)$/i.test(name)) continue
    let widthPx: number | undefined
    if (imageFormatOf(name) !== undefined) {
      try {
        widthPx = readImageInfo(new Uint8Array(readFileSync(abs)))?.width
      } catch {
        widthPx = undefined
      }
    }
    images.push({ path: rel, ...(modified !== undefined ? { mtimeMs: modified } : {}), ...(widthPx !== undefined ? { widthPx } : {}) })
  }

  const references: FigureReference[] = []
  const chapterTexts: { chapter: string; text: string }[] = []
  for (const [index, meta] of CHAPTER_META.entries()) {
    const chapterAbs = nodePath.join(root, CHAPTER_DIR, `${meta.file}.md`)
    const text = await readOptional(fs, chapterAbs, signal)
    if (text === undefined) continue
    chapterTexts.push({ chapter: meta.file, text })
    for (const reference of extractReferences(text)) {
      const resolved = await resolveImage(fs, root, chapterAbs, reference.src, signal)
      if (resolved === undefined) {
        references.push({ chapter: meta.file, chapterNo: index + 1, line: reference.line, alt: reference.alt, src: reference.src })
        continue
      }
      const rel = toRel(root, resolved)
      references.push({ chapter: meta.file, chapterNo: index + 1, line: reference.line, alt: reference.alt, src: reference.src, resolvedPath: rel })
      if (!images.some(image => image.path === rel) && /\.(png|jpe?g|svg)$/i.test(rel)) {
        let widthPx: number | undefined
        if (imageFormatOf(rel) !== undefined) {
          try {
            widthPx = readImageInfo(new Uint8Array(readFileSync(resolved)))?.width
          } catch {
            widthPx = undefined
          }
        }
        const modified = mtime(resolved)
        images.push({ path: rel, ...(modified !== undefined ? { mtimeMs: modified } : {}), ...(widthPx !== undefined ? { widthPx } : {}) })
      }
    }
  }

  const result = checkFigures({ sources, images, references, chapterTexts })
  const report = renderFigureReport(result, deps.now?.() ?? new Date())
  await fs.writeText(await fs.resolve(nodePath.join(root, FIGURE_INVENTORY), { signal }), report, undefined, signal)

  const head = `图表体检：${result.entries.length} 张图，${result.errors} 个必须修的问题、${result.warnings} 个提示。`
  const detail = result.issues.length === 0
    ? '✓ 源文件、导出件、正文引用、图号四者一致。'
    : result.issues.map(issue => `${issue.severity === 'error' ? '✗' : '⚠'} ${issue.message}`).join('\n')
  return `${head}\n${detail}\n\n完整清单：${FIGURE_INVENTORY}（导出用 thesis_figure action=export）`
}

// ---------------------------------------------------------------------------

/**
 * 工具入口：按 action 分派。
 *
 * 找不到论文工作区时给出与其它 `thesis_*` 工具一致的错误，而不是静默返回空结果。
 */
export async function runFigureAction(
  fs: FileSystem,
  cwd: string | undefined,
  args: FigureArgs,
  options: FigureOptions,
  signal?: AbortSignal,
  deps: FigureDeps = {},
): Promise<string> {
  // guide 是「本机怎么装/怎么导」的说明，不需要论文工作区。
  if (args.action === 'guide') return drawioGuide()

  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw workspaceNotFoundError(cwd)

  switch (args.action) {
    case 'create': return await runCreate(fs, root, args, options, signal, deps)
    case 'export': return await runExport(fs, root, args, options, signal, deps)
    case 'check': return await runCheck(fs, root, signal, deps)
    default:
      throw new Error(`未知 action「${String(args.action)}」：可用 create / export / check / guide。`)
  }
}

/** 工具描述（与论文写作技能的口径一致）。 */
export const FIGURE_TOOL_DESCRIPTION =
  '论文插图（draw.io 为准）：create 按结构化规格生成可编辑的 06-论文/assets/图/<名字>.drawio（architecture 分层架构 / flow 流程图 / er 数据库 E-R / sequence 时序图 / custom 手写 mxfile），调用 draw.io 桌面版导出 3× PNG，并按章节已有图号自动给出「图 4-1 …」图题与可直接粘贴的 Markdown；'
  + 'export 把已存在的 .drawio 批量导出为 PNG/SVG（探测 PATH 与常见安装目录，失败给出确切命令与三条替代路径，绝不假装成功）；'
  + 'check 核对源文件/导出件/正文引用/图号四者一致，写 06-论文/assets/图/图表清单.md；guide 只输出安装与手工导出指引。'
