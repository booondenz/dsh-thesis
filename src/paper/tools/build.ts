/**
 * thesis_build：产出论文 docx（+ 可选 pdf）。
 *
 * 引擎选择（见 {@link chooseEngine}）：
 * - 有学校模板且装了 pandoc：pandoc（--reference-doc 套学校样式）；
 * - 否则用 python-docx（assets/build_docx.py，DSH 自带运行时里就有）——
 *   封面、目录域、分节页码、页眉横线、三线表都在这一步完成；
 * - 都没有时退回内置零依赖转换器（lib/docx.ts），并在构建说明里显式标注。
 *
 * 二进制例外（文档化）：ctx.fs 无二进制写入能力，docx/pdf 字节由本工具
 * 通过 node:fs 直接写入论文仓库 06-论文/产出/ 目录。文本工作全部走 ctx.fs。
 */

import * as nodePath from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeFailure, spawnCommand } from '../../shared/spawn.ts'
import { buildDocx, type DocxImage } from '../lib/docx.ts'
import { readImageInfo } from '../lib/image.ts'
import { CHAPTER_META, isWrittenChapter } from '../lib/layout.ts'
import { parseLedger } from '../lib/ledger.ts'
import { findThesisRoot } from '../lib/project.ts'
import { buildDocxWithPython, detectPythonDocx, readDocxBytes, type PyBuildConfig } from '../lib/py-docx.ts'

export interface BuildArgs {
  format?: 'docx' | 'pdf' | 'both'
  engine?: 'auto' | 'py' | 'pandoc' | 'internal'
}

export type WriteBinary = (absPath: string, data: Uint8Array) => Promise<void>

const OUT_DIR = '06-论文/产出'
const TEMPLATE_DIR = '06-论文/assets/学校模板'

async function readOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await fs.readText(await fs.resolve(absPath, { signal }), signal)
  } catch {
    return undefined
  }
}

async function listOptional(fs: FileSystem, absPath: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const entries = await fs.listDir(await fs.resolve(absPath, { signal }), signal)
    return entries.map(e => e.name)
  } catch {
    return []
  }
}

function pandocAvailable(): boolean {
  return spawnCommand('pandoc', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS }).ok
}

/**
 * 封面信息（可选）：`06-论文/封面信息.json`。
 *
 * 写坏或不写都不阻断构建——拿不到就用脚本里的占位符，构建照常产出。
 */
async function readCoverInfo(fs: FileSystem, root: string, signal?: AbortSignal): Promise<Partial<PyBuildConfig>> {
  const text = await readOptional(fs, nodePath.join(root, '06-论文/封面信息.json'), signal)
  if (text === undefined) return {}
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
  const fields = ['school', 'college', 'major', 'student', 'student_id', 'advisor', 'date'] as const
  const cover: Record<string, string> = {}
  for (const field of fields) {
    const value = parsed[field]
    if (typeof value === 'string' && value.trim() !== '') cover[field] = value
  }
  return cover
}

/** 引擎探测的超时（毫秒）：探测不该拖住工具调用。 */
const PROBE_TIMEOUT_MS = 10_000
/** 单次 pandoc 转换的超时（毫秒）：大型论文 + 模板可能慢，但必须有上限。 */
const CONVERT_TIMEOUT_MS = 120_000

/** 章节里的图片引用：`![图题](路径)`，路径可写成 `<带空格的路径>`。 */
const IMAGE_REF = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g

/**
 * 把图片引用解析成磁盘路径：先按章节文件所在目录（Markdown 的常规语义），
 * 再按论文仓库根（学生把路径写成 `06-论文/assets/图/x.png` 时也能用）。
 */
function resolveChapterImage(src: string, chapterAbs: string, root: string): string | undefined {
  const decoded = src.includes('%') ? decodeURI(src) : src
  const candidates = nodePath.isAbsolute(decoded)
    ? [decoded]
    : [nodePath.resolve(nodePath.dirname(chapterAbs), decoded), nodePath.resolve(root, decoded)]
  return candidates.find(candidate => existsSync(candidate))
}

/** 读一张图；只接受 PNG/JPEG，其它格式如实报「不能嵌入」。 */
async function loadImage(absPath: string): Promise<DocxImage | undefined> {
  try {
    const data = new Uint8Array(await readFile(absPath))
    const info = readImageInfo(data)
    if (info === undefined) return undefined
    return { data, width: info.width, height: info.height, format: info.format }
  } catch {
    return undefined
  }
}

/**
 * 把一章正文里的图片引用统一改写成**绝对路径**，并把图片字节收集起来。
 *
 * 为什么要改写成绝对路径：pandoc 的临时 Markdown 在系统临时目录里生成，
 * 相对路径到那里必然解析不到；内置引擎则按绝对路径查 {@link DocxImage}。
 * 找不到的图片不静默丢弃——保留原引用并记一条问题，构建说明与工具返回值都会带上。
 */
async function prepareChapterImages(
  text: string,
  chapterAbs: string,
  chapterRel: string,
  root: string,
  images: Map<string, DocxImage>,
  problems: string[],
): Promise<string> {
  const matches = [...text.matchAll(IMAGE_REF)]
  if (matches.length === 0) return text
  let out = ''
  let cursor = 0
  for (const match of matches) {
    const whole = match[0]
    const alt = match[1] ?? ''
    const src = match[2] ?? match[3] ?? ''
    out += text.slice(cursor, match.index)
    cursor = match.index + whole.length
    const abs = resolveChapterImage(src, chapterAbs, root)
    if (abs === undefined) {
      problems.push(`${chapterRel}：图片不存在 ${src}`)
      out += whole
      continue
    }
    // 用正斜杠写进 Markdown：pandoc 在 Windows 上也认；反斜杠会被当成 Markdown 转义符。
    const key = abs.replace(/\\/g, '/')
    if (!images.has(key)) {
      const image = await loadImage(abs)
      if (image === undefined) {
        problems.push(`${chapterRel}：不是可嵌入的 PNG/JPEG（${src}），已按原样保留`)
        out += whole
        continue
      }
      images.set(key, image)
    }
    out += `![${alt}](<${key}>)`
  }
  return out + text.slice(cursor)
}

export interface BuildOutcome {
  readonly docxPath: string
  readonly pdfPath?: string
  readonly engine: BuildEngine
  readonly template: string | undefined
  readonly chapters: readonly string[]
  readonly missing: readonly string[]
  /** 成功嵌入 docx 的图片数量。 */
  readonly images: number
  /** 图片方面的问题（路径不存在 / 格式不支持），逐条写进构建说明。 */
  readonly imageProblems: readonly string[]
  /** python-docx 引擎的实际解释器（引擎没用上时为空）。 */
  readonly python?: { command: string, version: string }
}

export type BuildEngine = 'py' | 'pandoc' | 'internal'

/** 引擎的人话名字（构建说明与工具返回值共用，避免两处措辞漂移）。 */
export function engineLabel(engine: BuildEngine): string {
  return engine === 'py'
    ? 'python-docx（封面/目录/分节页码/页眉/三线表）'
    : engine === 'pandoc'
      ? 'pandoc'
      : '内置过渡引擎（仅基础排版）'
}

/**
 * 选引擎。抽成纯函数是为了能测：真机上「有没有 pandoc / python-docx」没法在单测里造。
 *
 * 顺序：显式指定优先；auto 时——有学校模板的 pandoc（学校样式最准）> python-docx
 * （排版最完整）> 无模板的 pandoc（只有基础样式）> 内置引擎。
 */
export function chooseEngine(input: {
  readonly requested: BuildArgs['engine']
  readonly hasPandoc: boolean
  readonly hasTemplate: boolean
  readonly hasPython: boolean
}): BuildEngine {
  const { requested, hasPandoc, hasTemplate, hasPython } = input
  const requestedOrDefault = requested ?? 'auto'
  if (requestedOrDefault === 'internal') return 'internal'
  if (requestedOrDefault === 'pandoc') {
    if (!hasPandoc) throw new Error('请求 pandoc 引擎但本机未安装 pandoc。请安装 pandoc，或改用 py / internal 引擎。')
    return 'pandoc'
  }
  if (requestedOrDefault === 'py') {
    if (!hasPython) throw new Error('请求 python-docx 引擎但没找到装了 python-docx 的解释器（DSH 自带运行时里通常有）。')
    return 'py'
  }
  if (hasPandoc && hasTemplate) return 'pandoc'
  if (hasPython) return 'py'
  if (hasPandoc) return 'pandoc'
  return 'internal'
}

export async function runBuild(
  fs: FileSystem,
  args: BuildArgs,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  writeBinary: WriteBinary,
): Promise<BuildOutcome> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) throw new Error('未找到论文工作区。请先在论文仓库目录内操作。')

  const format = args.format ?? 'docx'
  if ((format === 'pdf' || format === 'both') && (args.engine === 'internal' || args.engine === 'py')) {
    throw new Error('PDF 需要 pandoc（并安装 LaTeX 引擎）；py / internal 引擎只产出 docx。')
  }

  // 章节收集（按模板顺序；只收录"已撰写"章节）
  const chapterParts: string[] = []
  const included: string[] = []
  const missing: string[] = []
  const images = new Map<string, DocxImage>()
  const imageProblems: string[] = []
  for (const [index, meta] of CHAPTER_META.entries()) {
    const chapterAbs = nodePath.join(root, '06-论文/章节', `${meta.file}.md`)
    const text = await readOptional(fs, chapterAbs, signal)
    if (text === undefined || !isWrittenChapter(text, index + 1, meta)) {
      missing.push(meta.file)
      continue
    }
    included.push(meta.file)
    chapterParts.push(await prepareChapterImages(text, chapterAbs, meta.file, root, images, imageProblems))
  }
  if (included.length === 0) throw new Error('没有任何已撰写章节（06-论文/章节/*.md 均为空）。')

  // 标题：台账 state.title，缺省通用
  let title = '本科毕业论文（设计）'
  const ledgerText = await readOptional(fs, nodePath.join(root, '00-管理/进度台账.md'), signal)
  if (ledgerText !== undefined) {
    const parsed = parseLedger(ledgerText)
    if (parsed.found && parsed.state.title !== undefined && parsed.state.title !== '') title = parsed.state.title
  }
  const markdown = chapterParts.join('\n\n')

  // 模板探测
  const templateFiles = await listOptional(fs, nodePath.join(root, TEMPLATE_DIR), signal)
  const template = templateFiles.find(f => /\.(docx?|dotx?)$/i.test(f))

  // 引擎选择：pandoc 与 python-docx 都要现场探测（装没装、装了能不能用）
  const requested = args.engine ?? 'auto'
  const hasPandoc = requested === 'py' || requested === 'internal' ? false : pandocAvailable()
  const pyDetection = requested === 'internal' ? { probes: [] as string[] } : detectPythonDocx()
  const engine = chooseEngine({ requested, hasPandoc, hasTemplate: template !== undefined, hasPython: pyDetection.python !== undefined })

  // docx 字节
  const docxPath = nodePath.join(root, OUT_DIR, '论文.docx')
  let docxBytes: Uint8Array
  let python: { command: string, version: string } | undefined
  if (engine === 'internal') {
    docxBytes = buildDocx({ title, markdown, images })
  } else if (engine === 'py') {
    // 封面信息是可选的：学生在 06-论文/封面信息.json 里写学校/学院/姓名，没有就用占位符。
    const cover = await readCoverInfo(fs, root, signal)
    const config: PyBuildConfig = { root, out: docxPath, title, ...cover }
    const outcome = await buildDocxWithPython(pyDetection.python!, config)
    python = { command: outcome.command, version: outcome.version }
    docxBytes = await readDocxBytes(docxPath)
  } else {
    // pandoc：合并内容写临时文件后转换
    const tmpMd = nodePath.join(tmpdir(), `dsh-thesis-build-${process.pid}-${Date.now()}.md`)
    await writeFile(tmpMd, `${title}\n\n${'='.repeat(Math.max(4, title.length))}\n\n${markdown}`, 'utf8')
    try {
      const argv = ['-f', 'markdown', '-t', 'docx', '-o', docxPath]
      if (template !== undefined) argv.push('--reference-doc', nodePath.join(root, TEMPLATE_DIR, template))
      argv.push(tmpMd)
      const result = spawnCommand('pandoc', argv, { timeoutMs: CONVERT_TIMEOUT_MS })
      if (!result.ok) throw new Error(`pandoc 转换失败：${describeFailure('pandoc', result)}`)
      docxBytes = new Uint8Array(await readFile(docxPath))
    } finally {
      await rm(tmpMd, { force: true }).catch(() => {})
    }
  }
  await writeBinary(docxPath, docxBytes)

  // pdf（仅 pandoc）
  let pdfPath: string | undefined
  if (format === 'pdf' || format === 'both') {
    if (engine !== 'pandoc') throw new Error('PDF 需要 pandoc。')
    const out = nodePath.join(root, OUT_DIR, '论文.pdf')
    const tmpMd = nodePath.join(tmpdir(), `dsh-thesis-build-${process.pid}-${Date.now()}.md`)
    await writeFile(tmpMd, `${title}\n\n${'='.repeat(Math.max(4, title.length))}\n\n${markdown}`, 'utf8')
    try {
      const result = spawnCommand('pandoc', ['-f', 'markdown', '-t', 'pdf', '-o', out, tmpMd], { timeoutMs: CONVERT_TIMEOUT_MS })
      if (!result.ok) throw new Error(`PDF 转换失败（通常缺 LaTeX 引擎）：${describeFailure('pandoc', result)}`)
      pdfPath = out
    } finally {
      await rm(tmpMd, { force: true }).catch(() => {})
    }
  }

  // 构建说明（文本，走 ctx.fs）
  const note = [
    '# 构建说明',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 引擎：${engineLabel(engine)}`,
    ...(python !== undefined ? [`- python：${python.version}（${python.command}）`] : []),
    `- 学校模板：${template ?? '未发现（请将学校模板放入 06-论文/assets/学校模板/ 后重建）'}`,
    `- 收录章节：${included.join('、') || '无'}`,
    `- 未收录章节（空或缺失）：${missing.join('、') || '无'}`,
    `- 插图：${images.size} 张已嵌入${imageProblems.length > 0 ? `，${imageProblems.length} 处有问题（见下）` : ''}`,
    ...(imageProblems.length > 0 ? ['', '图片问题：', ...imageProblems.map(problem => `- ${problem}`)] : []),
    `- 产物：论文.docx${pdfPath !== undefined ? '、论文.pdf' : ''}`,
    '',
  ].join('\n')
  await fs.writeText(await fs.resolve(nodePath.join(root, OUT_DIR, '构建说明.md'), { signal }), note, undefined, signal)

  return { docxPath, ...(pdfPath !== undefined ? { pdfPath } : {}), engine, template, chapters: included, missing, images: images.size, imageProblems, ...(python !== undefined ? { python } : {}) }
}

export function buildSummary(outcome: BuildOutcome): string {
  const lines = [
    `构建完成：${outcome.docxPath}`,
    ...(outcome.pdfPath !== undefined ? [`PDF：${outcome.pdfPath}`] : []),
    `- 引擎：${engineLabel(outcome.engine)}`,
    ...(outcome.python !== undefined ? [`- python：${outcome.python.version}（${outcome.python.command}）`] : []),
    `- 学校模板：${outcome.template ?? '未发现'}`,
    `- 收录章节：${outcome.chapters.join('、')}`,
    ...(outcome.missing.length > 0 ? [`- 未收录（空/缺失）：${outcome.missing.join('、')}`] : []),
    `- 插图：${outcome.images} 张已嵌入${outcome.imageProblems.length > 0 ? `；${outcome.imageProblems.length} 处需处理（见构建说明）` : ''}`,
    ...outcome.imageProblems.map(problem => `  · ${problem}`),
    '',
    '打开 论文.docx 检查排版；构建细节见 06-论文/产出/构建说明.md。',
  ]
  return lines.join('\n')
}
