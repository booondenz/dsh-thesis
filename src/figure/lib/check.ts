/**
 * 图表体检：源文件、导出件、正文引用、图号四者对不上时，在这里被抓出来。
 *
 * 论文里最容易出错、又最丢分的一类细节是「图」：
 *
 * - 图改了忘导出，论文里还是旧图；
 * - 图在 assets 里躺着，正文从没引用（或者引用了但文件路径断了）；
 * - 图题写成「系统架构图」而不是「图 4-1 系统总体架构图」，编号直接断档；
 * - 第 4 章的图编号成 图 3-1。
 *
 * 这些都是**可机器判定**的，所以不靠人肉检查：{@link checkFigures} 只吃已经准备好的
 * 清单（不碰文件系统，方便单测），返回问题列表；{@link renderFigureReport} 渲染成
 * `06-论文/assets/图/图表清单.md`。
 *
 * @module dsh-thesis/figure/check
 */

/** 问题等级：error 会让论文明图不成；warn 是「能过但会被老师问」。 */
export type FigureSeverity = 'error' | 'warn'

/** 一条问题。 */
export interface FigureIssue {
  readonly severity: FigureSeverity
  readonly code: string
  readonly message: string
}

/** 图文件（源文件与导出件共用）。 */
export interface FigureFileEntry {
  /** 相对论文工作区根的路径（正斜杠）。 */
  readonly path: string
  readonly mtimeMs?: number
  /** 导出件的像素宽（拿得到时用来判断印刷是否够清晰）。 */
  readonly widthPx?: number
}

/** 正文里的一处图片引用。 */
export interface FigureReference {
  readonly chapter: string
  readonly chapterNo: number
  /** 在章节文件里的行号（1 起）。 */
  readonly line: number
  /** 形如 `图 4-1 系统总体架构图`；缺图题时为 alt 原文。 */
  readonly alt: string
  /** 正文里写的路径（原样）。 */
  readonly src: string
  /** 解析到的绝对/规范路径；解析不到时为 undefined（文件不存在）。 */
  readonly resolvedPath?: string
}

/** 体检输入。 */
export interface FigureCheckInput {
  readonly sources: readonly FigureFileEntry[]
  readonly images: readonly FigureFileEntry[]
  readonly references: readonly FigureReference[]
  /** 章节正文（用于判断「本章第一张图是 4-3 时，4-2 到底存不存在」）。 */
  readonly chapterTexts?: readonly { readonly chapter: string; readonly text: string }[]
}

/** 汇总里的一张图。 */
export interface FigureEntry {
  readonly stem: string
  readonly source?: string
  readonly image?: string
  readonly references: readonly string[]
}

/** 体检结果。 */
export interface FigureCheckResult {
  readonly entries: readonly FigureEntry[]
  readonly issues: readonly FigureIssue[]
  readonly errors: number
  readonly warnings: number
}

/** 规范图题：`图 4-1 系统总体架构图`（章号-序号 + 空格 + 标题）。 */
export const CAPTION_PATTERN = /^图\s*(\d+)\s*[-－—–]\s*(\d+)\s+\S/

/** 从图题里取出章号与序号；不是规范图题时返回 undefined。 */
export function parseCaption(text: string): { readonly chapter: number; readonly index: number } | undefined {
  const match = CAPTION_PATTERN.exec(text.trim())
  if (match === null) return undefined
  return { chapter: Number(match[1]), index: Number(match[2]) }
}

/** 去掉扩展名，只留文件名主干（用于把 .drawio 与 .png 配对）。 */
export function stemOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? '' : normalized.slice(0, slash)
}

/** 体检：纯函数，输入齐全时可以完全离线断言。 */
export function checkFigures(input: FigureCheckInput): FigureCheckResult {
  const issues: FigureIssue[] = []
  const push = (severity: FigureSeverity, code: string, message: string): void => {
    issues.push({ severity, code, message })
  }

  const imagesByPath = new Map(input.images.map(image => [image.path.replace(/\\/g, '/'), image]))
  const sourcesByStem = new Map<string, FigureFileEntry[]>()
  for (const source of input.sources) {
    const key = `${dirOf(source.path)}/${stemOf(source.path)}`
    const bucket = sourcesByStem.get(key) ?? []
    bucket.push(source)
    sourcesByStem.set(key, bucket)
  }

  // 1. 每个 .drawio 都要有同名的 png/svg 导出件。
  for (const source of input.sources) {
    const dir = dirOf(source.path)
    const stem = stemOf(source.path)
    const candidates = [`${dir}/${stem}.png`, `${dir}/${stem}.svg`].map(p => p.replace(/^\/+/, ''))
    const exported = candidates.map(path => imagesByPath.get(path)).find(image => image !== undefined)
    if (exported === undefined) {
      push('error', 'missing-export',
        `源文件 ${source.path} 没有导出件（同目录缺 ${stem}.png 或 ${stem}.svg）。运行 thesis_figure action=export 导出后再写正文引用。`)
      continue
    }
    if (source.mtimeMs !== undefined && exported.mtimeMs !== undefined && exported.mtimeMs < source.mtimeMs) {
      push('warn', 'stale-export',
        `${exported.path} 比源文件 ${source.path} 旧：图改过但没重新导出，论文里会显示旧图。重跑 thesis_figure action=export。`)
    }
  }

  // 1.5 导出件分辨率：按论文 15cm 栏宽折算 dpi，低于 200 dpi 印刷会发虚。
  for (const image of input.images) {
    if (image.widthPx === undefined || image.widthPx >= 1200) continue
    const dpi = Math.round(image.widthPx / 5.9)
    push('warn', 'low-resolution',
      `${image.path} 只有 ${image.widthPx}px 宽：按 15cm 栏宽排进论文约 ${dpi} dpi，印刷会发虚。用 thesis_figure action=export（3×）重新导出，或换更高分辨率截图。`)
  }

  // 2. 正文引用必须能落到真实文件；alt 必须是规范图题。
  const referenced = new Map<string, string[]>()
  const byChapter = new Map<string, { line: number; caption: string; chapterNo: number }[]>()
  for (const reference of input.references) {
    const key = reference.resolvedPath === undefined ? undefined : reference.resolvedPath.replace(/\\/g, '/')
    if (reference.resolvedPath === undefined || !imagesByPath.has(key ?? '')) {
      push('error', 'missing-image',
        `${reference.chapter}:${reference.line} 引用的图片不存在：${reference.src}。路径相对当前章节文件解析；论文仓库里的图通常写成 ../assets/图/<名字>.png。`)
    } else {
      const bucket = referenced.get(key!) ?? []
      bucket.push(reference.chapter)
      referenced.set(key!, bucket)
    }
    const caption = parseCaption(reference.alt)
    if (caption === undefined) {
      push('error', 'missing-caption',
        `${reference.chapter}:${reference.line} 的图片缺少规范图题：现在是「${reference.alt === '' ? '（空）' : reference.alt}」，应写成「图 ${reference.chapterNo}-<序号> <图名>」——图题在图下方、编号带章号。`)
    } else if (caption.chapter !== reference.chapterNo) {
      push('error', 'caption-chapter',
        `${reference.chapter}:${reference.line} 的图题章号是 ${caption.chapter}，但它在第 ${reference.chapterNo} 章：应为「图 ${reference.chapterNo}-${caption.index} …」。`)
    } else {
      const bucket = byChapter.get(reference.chapter) ?? []
      bucket.push({ line: reference.line, caption: reference.alt, chapterNo: reference.chapterNo })
      byChapter.set(reference.chapter, bucket)
    }
  }

  // 3. 每章图片的图号必须唯一、按出现顺序递增、且相邻（跳号说明中间那张图丢了）。
  //    若本章第一张图不是 4-1，只有正文里确实提到过 4-(n-1) 才放行——
  //    那说明前面还有一张图（例如截图单独放在别处），不算断档。
  const chapterText = new Map((input.chapterTexts ?? []).map(item => [item.chapter, item.text]))
  for (const [chapter, list] of byChapter) {
    const sorted = [...list].sort((a, b) => a.line - b.line)
    const parsed = sorted
      .map(item => ({ item, caption: parseCaption(item.caption) }))
      .filter(entry => entry.caption !== undefined) as { item: typeof sorted[number]; caption: { chapter: number; index: number } }[]
    const seen = new Map<number, number>()
    for (const { item, caption } of parsed) {
      const previous = seen.get(caption.index)
      if (previous !== undefined) {
        push('error', 'caption-duplicate',
          `${chapter}:${item.line} 与第 ${previous} 行都是「图 ${caption.chapter}-${caption.index}」：同一章图号不能重复。`)
        continue
      }
      seen.set(caption.index, item.line)
    }
    for (let i = 1; i < parsed.length; i += 1) {
      const previous = parsed[i - 1]!.caption
      const current = parsed[i]!.caption
      if (current.index === previous.index) continue // 重复已在上面报过，不重复计一次跳号
      if (current.index !== previous.index + 1) {
        push('error', 'caption-sequence',
          `${chapter}:${parsed[i]!.item.line} 的图号是 ${current.chapter}-${current.index}，上一张是 ${previous.chapter}-${previous.index}：每章图号应连续递增（中间缺 ${current.chapter}-${previous.index + 1}）。`)
      }
    }
    const first = parsed[0]?.caption
    if (first !== undefined && first.index > 1) {
      const text = chapterText.get(chapter) ?? ''
      const previousIndex = first.index - 1
      const mentioned = new RegExp(`图\\s*${first.chapter}\\s*[-－—–]\\s*${previousIndex}`).test(text)
      if (!mentioned) {
        push('error', 'caption-start',
          `${chapter} 的图片从 图 ${first.chapter}-${first.index} 开始，缺 图 ${first.chapter}-${previousIndex}：本章第一张图应从 -1 开始，或把那张图补回来。`)
      }
    }
  }

  // 4. assets 里的图有没有人用；纯截图（无 .drawio 源）只提示不报错。
  for (const image of input.images) {
    const key = image.path.replace(/\\/g, '/')
    if ([...referenced.keys()].some(used => used === key)) continue
    const stemKey = `${dirOf(image.path)}/${stemOf(image.path)}`
    if (sourcesByStem.has(stemKey)) {
      push('warn', 'unused-figure',
        `${image.path} 没有被任何章节引用：要么在正文补一句「如图 X-Y 所示」并放图，要么删掉这张图。`)
    }
  }

  // 5. 汇总条目（按源文件优先，其次图片）。
  const entries: FigureEntry[] = []
  const seen = new Set<string>()
  const addEntry = (stem: string, source: string | undefined, image: string | undefined): void => {
    const key = `${stem}|${source ?? ''}|${image ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const refs = [...(image === undefined ? [] : referenced.get(image.replace(/\\/g, '/')) ?? [])]
    entries.push({ stem, ...(source !== undefined ? { source } : {}), ...(image !== undefined ? { image } : {}), references: refs })
  }
  for (const source of input.sources) {
    const dir = dirOf(source.path)
    const stem = stemOf(source.path)
    const candidates = [`${dir}/${stem}.png`, `${dir}/${stem}.svg`].map(p => p.replace(/^\/+/, ''))
    const image = candidates.map(path => imagesByPath.get(path)).find(item => item !== undefined)
    addEntry(stem, source.path, image?.path)
  }
  for (const image of input.images) {
    const stems = [...sourcesByStem.keys()].filter(key => key === `${dirOf(image.path)}/${stemOf(image.path)}`)
    if (stems.length > 0) continue
    addEntry(stemOf(image.path), undefined, image.path)
  }
  entries.sort((a, b) => a.stem.localeCompare(b.stem, 'zh-Hans-CN'))

  return {
    entries,
    issues,
    errors: issues.filter(issue => issue.severity === 'error').length,
    warnings: issues.filter(issue => issue.severity === 'warn').length,
  }
}

/** 渲染成 `图表清单.md`（同时给模型看，也随论文提交）。 */
export function renderFigureReport(result: FigureCheckResult, now: Date = new Date()): string {
  const lines: string[] = []
  lines.push('# 图表清单')
  lines.push('')
  lines.push(`> 由 thesis_figure action=check 生成；时间：${now.toISOString()}`)
  lines.push('> 源文件（.drawio）是可编辑真相，导出件（.png/.svg）供论文与幻灯使用。')
  lines.push('')
  lines.push('## 一、图的清单')
  lines.push('')
  if (result.entries.length === 0) {
    lines.push('（还没有图。用 thesis_figure action=create 生成第一张。）')
  } else {
    lines.push('| 图 | 源文件 | 导出件 | 引用的章节 |')
    lines.push('|---|---|---|---|')
    for (const entry of result.entries) {
      lines.push(`| ${entry.stem} | ${entry.source ?? '（无，截图/外部图）'} | ${entry.image ?? '（未导出）'} | ${entry.references.length === 0 ? '—' : entry.references.join('、')} |`)
    }
  }
  lines.push('')
  lines.push('## 二、检查结论')
  lines.push('')
  if (result.issues.length === 0) {
    lines.push('✓ 源文件、导出件、正文引用、图号四者一致。')
  } else {
    for (const issue of result.issues) {
      lines.push(`- ${issue.severity === 'error' ? '✗' : '⚠'} ${issue.message}`)
    }
  }
  lines.push('')
  lines.push(`合计：${result.errors} 个必须修的问题、${result.warnings} 个提示。`)
  lines.push('')
  lines.push('修完重跑 `thesis_figure action=check`；导出用 `thesis_figure action=export`。')
  lines.push('')
  return lines.join('\n')
}
