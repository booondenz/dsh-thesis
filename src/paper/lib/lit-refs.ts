/**
 * 候选文献解析：把 Undermind / Elicit / Consensus / Zotero / Google Scholar
 * 导出的 `.bib`、`.ris`、`.csv` 读成统一的 `CandidateRef[]`。
 *
 * 只做**解析**，不做判断：解析结果一律视为「声称值」，必须再过
 * `lit-verify.ts` 的权威库对账才能进 refs.bib。解析器不联网、不改写元数据，
 * 解析不了的字段留空并给出警告（警告会出现在核验报告里）。
 */

import type { CandidateRef } from './lit-verify.ts'

export type RefFormat = 'bibtex' | 'ris' | 'csv'

export interface ParsedRefs {
  readonly format: RefFormat
  readonly candidates: CandidateRef[]
  readonly warnings: string[]
}

const BIB_EXT = /\.(bib|bibtex)$/i
const RIS_EXT = /\.ris$/i
const CSV_EXT = /\.(csv|tsv)$/i

/** 按扩展名与内容特征判断格式；都不像时返回 null。 */
export function detectRefFormat(fileName: string, text: string): RefFormat | null {
  if (BIB_EXT.test(fileName)) return 'bibtex'
  if (RIS_EXT.test(fileName)) return 'ris'
  if (CSV_EXT.test(fileName)) return 'csv'
  if (/^\s*@\w+\s*\{/m.test(text)) return 'bibtex'
  if (/^\s*TY\s{2}-\s/m.test(text)) return 'ris'
  if (/^\s*(title|题名|"title")\s*[,;\t]/im.test(text)) return 'csv'
  return null
}

export function parseRefs(fileName: string, text: string, source: string): ParsedRefs {
  const format = detectRefFormat(fileName, text)
  if (format === null) {
    throw new Error(
      `无法识别 ${fileName} 的格式。支持 Undermind / Elicit / Consensus / Zotero 导出的 .bib、.ris、.csv。` +
      `请在这些工具里选择「Export → BibTeX / RIS / CSV」后重试；不支持直接粘贴的散乱文本（那种只能逐条用 thesis_lit_verify 的 title/doi 参数核验）。`,
    )
  }
  if (format === 'bibtex') return { format, ...parseBibtex(text, source) }
  if (format === 'ris') return { format, ...parseRis(text, source) }
  return { format, ...parseCsv(text, source) }
}

// ---------------------------------------------------------------------------
// 作者拆分
// ---------------------------------------------------------------------------

/** 作者串 → 姓名数组。兼容 `A; B`、`A and B`、JSON 数组、`A, B, C`（≥3 个时的兜底）。 */
export function splitAuthors(raw: string): string[] {
  const text = raw.trim()
  if (text === '') return []
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed.map(item => (typeof item === 'string' ? item : '')).map(s => s.trim()).filter(s => s !== '')
      }
    } catch {
      // 不是合法 JSON：继续按分隔符拆。
    }
  }
  const clean = text.replace(/\s+and\s+/gi, ';').replace(/\s*&\s*/g, ';')
  const semicolon = clean.split(';').map(s => s.trim()).filter(s => s !== '')
  if (semicolon.length > 1) return semicolon
  if (semicolon.length === 1) {
    // `Zhang, San, Li, Si` 这种没有分号的全名列表：只在 ≥4 段且段数成对时按逗号拆。
    const parts = clean.split(',').map(s => s.trim()).filter(s => s !== '')
    if (parts.length >= 4 && parts.length % 2 === 0) {
      const grouped: string[] = []
      for (let i = 0; i < parts.length; i += 2) grouped.push(`${parts[i]!} ${parts[i + 1]!}`)
      return grouped
    }
    return semicolon
  }
  return []
}

function toYear(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const m = /\b(1[89]\d{2}|20\d{2})\b/.exec(raw)
  return m === null ? null : Number.parseInt(m[1]!, 10)
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

interface RawEntry {
  readonly type: string
  readonly key: string
  readonly fields: Map<string, string>
}

/** 扫出所有 `@type{key, body}`；用花括号配对找条目结尾，能容忍嵌套 `{}` 与多行字段。 */
export function bibEntries(text: string): RawEntry[] {
  const entries: RawEntry[] = []
  const start = /@(\w+)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = start.exec(text)) !== null) {
    const type = (match[1] ?? '').toLowerCase()
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      start.lastIndex = match.index + match[0].length
      continue
    }
    const open = text.indexOf('{', match.index)
    let depth = 0
    let end = open
    for (; end < text.length; end += 1) {
      const ch = text[end]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const inner = text.slice(open + 1, end)
    const comma = inner.indexOf(',')
    const key = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const body = comma === -1 ? '' : inner.slice(comma + 1)
    entries.push({ type, key, fields: parseBibFields(body) })
    start.lastIndex = end + 1
  }
  return entries
}

function parseBibFields(body: string): Map<string, string> {
  const fields = new Map<string, string>()
  let i = 0
  while (i < body.length) {
    // 跳过空白与逗号
    while (i < body.length && /[\s,]/.test(body[i]!)) i += 1
    const eq = body.indexOf('=', i)
    if (eq === -1) break
    const name = body.slice(i, eq).trim().toLowerCase()
    i = eq + 1
    while (i < body.length && /\s/.test(body[i]!)) i += 1
    let value = ''
    if (body[i] === '{') {
      let depth = 0
      const from = i
      for (; i < body.length; i += 1) {
        if (body[i] === '{') depth += 1
        else if (body[i] === '}') {
          depth -= 1
          if (depth === 0) {
            i += 1
            break
          }
        }
      }
      value = body.slice(from + 1, i - 1)
    } else if (body[i] === '"') {
      const from = i + 1
      i = body.indexOf('"', from)
      if (i === -1) i = body.length
      value = body.slice(from, i)
      i += 1
    } else {
      const from = i
      while (i < body.length && !/[,}\n]/.test(body[i]!)) i += 1
      value = body.slice(from, i)
    }
    if (name !== '') fields.set(name, cleanBibValue(value))
  }
  return fields
}

function cleanBibValue(raw: string): string {
  return raw
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseBibtex(text: string, source: string): { candidates: CandidateRef[]; warnings: string[] } {
  const warnings: string[] = []
  const candidates: CandidateRef[] = []
  const entries = bibEntries(text)
  entries.forEach((entry, index) => {
    const title = entry.fields.get('title') ?? ''
    if (title === '') {
      warnings.push(`第 ${index + 1} 条（${entry.key || '无 key'}）没有 title，已跳过。`)
      return
    }
    const doi = entry.fields.get('doi')
    const candidate: CandidateRef = {
      title,
      authors: splitAuthors(entry.fields.get('author') ?? entry.fields.get('editor') ?? ''),
      year: toYear(entry.fields.get('year')),
      venue: entry.fields.get('journal') ?? entry.fields.get('booktitle') ?? entry.fields.get('publisher') ?? entry.fields.get('school') ?? '',
      ...(doi !== undefined ? { doi } : {}),
      ...(entry.fields.get('url') !== undefined ? { url: entry.fields.get('url')! } : {}),
      source,
      ordinal: index + 1,
    }
    candidates.push(candidate)
  })
  return { candidates, warnings }
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

const RIS_FIELD: Record<string, string> = {
  TI: 'title',
  T1: 'title',
  BT: 'title',
  AU: 'author',
  A1: 'author',
  PY: 'year',
  Y1: 'year',
  JO: 'venue',
  JF: 'venue',
  T2: 'venue',
  JA: 'venue',
  DO: 'doi',
  UR: 'url',
  L2: 'url',
}

function parseRis(text: string, source: string): { candidates: CandidateRef[]; warnings: string[] } {
  const warnings: string[] = []
  const candidates: CandidateRef[] = []
  const records: Array<Map<string, string[]>> = []
  let current = new Map<string, string[]>()
  let open = false
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(line)
    if (m === null) continue
    const tag = m[1]!
    const value = m[2]!.trim()
    if (tag === 'TY') {
      current = new Map<string, string[]>()
      open = true
      continue
    }
    if (tag === 'ER') {
      if (open && current.size > 0) records.push(current)
      open = false
      continue
    }
    if (!open) continue
    const field = RIS_FIELD[tag]
    if (field === undefined) continue
    current.set(field, [...(current.get(field) ?? []), value])
  }
  records.forEach((record, index) => {
    const title = record.get('title')?.[0]?.replace(/<[^>]+>/g, '').trim() ?? ''
    if (title === '') {
      warnings.push(`第 ${index + 1} 条 RIS 没有 TI（题名），已跳过。`)
      return
    }
    const doi = record.get('doi')?.[0]
    const url = record.get('url')?.[0]
    candidates.push({
      title,
      authors: (record.get('author') ?? []).flatMap(splitAuthors),
      year: toYear(record.get('year')?.[0]),
      venue: record.get('venue')?.[0] ?? '',
      ...(doi !== undefined ? { doi } : {}),
      ...(url !== undefined ? { url } : {}),
      source,
      ordinal: index + 1,
    })
  })
  return { candidates, warnings }
}

// ---------------------------------------------------------------------------
// CSV（Elicit / Consensus / Scopus 导出的表格）
// ---------------------------------------------------------------------------

/** RFC4180 风格解析：支持双引号包裹、`""` 转义、字段内换行。 */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some(cell => cell.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some(cell => cell.trim() !== '')) rows.push(row)
  return rows
}

type Field = 'title' | 'authors' | 'year' | 'venue' | 'doi' | 'url'

const HEADER_ALIASES: Readonly<Record<Field, readonly string[]>> = {
  title: ['title', '题名', '标题', 'paper title', 'name', 'document title'],
  authors: ['authors', 'author', '作者', 'creators', 'author names'],
  year: ['year', 'publication year', '出版年', '年份', 'published', 'date'],
  venue: ['venue', 'journal', 'source title', 'source', 'publication', '期刊', '会议', 'published in', 'container title'],
  doi: ['doi', 'doi link', 'doi url', 'digital object identifier'],
  url: ['url', 'link', 'uri', 'pdf', 'landing page url'],
}

function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[*_"]/g, '').replace(/\s+/g, ' ').trim()
}

function mapHeaders(header: readonly string[]): Map<Field, number> {
  const mapped = new Map<Field, number>()
  header.forEach((cell, index) => {
    const norm = normalizeHeader(cell)
    for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
      if (mapped.has(field)) continue
      if (HEADER_ALIASES[field].some(alias => norm === alias || norm.startsWith(`${alias} (`) || norm.startsWith(`${alias} -`))) {
        mapped.set(field, index)
      }
    }
  })
  return mapped
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const counts: Array<[string, number]> = [[',', 0], [';', 0], ['\t', 0]]
  for (const ch of firstLine) {
    const slot = counts.find(([d]) => d === ch)
    if (slot !== undefined) slot[1] += 1
  }
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

function parseCsv(text: string, source: string): { candidates: CandidateRef[]; warnings: string[] } {
  const warnings: string[] = []
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''), detectDelimiter(text))
  if (rows.length === 0) return { candidates: [], warnings: ['文件为空。'] }
  const header = rows[0]!
  const mapped = mapHeaders(header)
  if (!mapped.has('title')) {
    throw new Error(
      `CSV 表头里没有题名列（现有：${header.slice(0, 8).join(' / ')}）。` +
      `请确认导出的是文献列表（列名含 Title/题名），而不是筛选结果或统计表。`,
    )
  }
  const get = (row: readonly string[], field: Field): string | undefined => {
    const index = mapped.get(field)
    if (index === undefined) return undefined
    const value = row[index]?.trim()
    return value === undefined || value === '' ? undefined : value
  }
  const candidates: CandidateRef[] = []
  rows.slice(1).forEach((row, index) => {
    const title = get(row, 'title')
    if (title === undefined) {
      warnings.push(`第 ${index + 2} 行没有题名，已跳过。`)
      return
    }
    const doi = get(row, 'doi')
    const url = get(row, 'url')
    candidates.push({
      title,
      authors: splitAuthors(get(row, 'authors') ?? ''),
      year: toYear(get(row, 'year')),
      venue: get(row, 'venue') ?? '',
      ...(doi !== undefined ? { doi } : {}),
      ...(url !== undefined ? { url } : {}),
      source,
      ordinal: index + 2,
    })
  })
  return { candidates, warnings }
}
