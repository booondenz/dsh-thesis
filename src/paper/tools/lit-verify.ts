/**
 * 文献核验与导入：thesis_lit_verify / thesis_lit_import。
 *
 * 两个工具解决同一个问题：**候选文献从哪来**与**凭什么敢写进论文**不能混为一谈。
 * - `thesis_lit_verify`：核验（单条或整份导出文件），只出结论，不改 refs.bib；
 * - `thesis_lit_import`：先把导出文件逐条核验，**只有核验通过的**才进 refs.bib，
 *   未通过的写进 08-合规/文献核验报告.md 并逐条说明原因。
 *
 * 失败即拒（fail closed）：网络不通 → `unchecked` → 不入库。
 */

import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { describeReadFailure, isMissingError } from '../../shared/fs-errors.ts'
import type { FetchLike, LitRecord } from '../lib/lit-api.ts'
import { loadCache, mergeRecords, saveCache, appendLitRecord } from '../lib/lit-cache.ts'
import { parseRefs } from '../lib/lit-refs.ts'
import {
  renderOutcome,
  renderVerifyReport,
  summarizeOutcomes,
  VERIFY_REPORT_HEADER,
  VERIFY_REPORT_REL,
  verifyAll,
  type CandidateRef,
  type VerifyOutcome,
} from '../lib/lit-verify.ts'
import { findThesisRoot } from '../lib/project.ts'
import { runLitSave } from './lit.ts'

export interface LitVerifyArgs {
  doi?: string
  title?: string
  authors?: string[]
  year?: number
  venue?: string
  /** 导出文件路径（.bib/.ris/.csv），给了就批量核验整个文件。 */
  path?: string
  /** 核验通过后是否顺手收录进 refs.bib，默认 false（核验工具只出结论）。 */
  save?: boolean
}

export interface LitImportArgs {
  path: string
  source?: string
  limit?: number
  /** 默认 true：核验通过的直接入库。设 false 只核验。 */
  save?: boolean
}

const REPORT_TABLE_HEAD = '| 日期 | 动作 | 来源 | 对象 | 条数 | 结论 |\n|---|---|---|---|---|---|'

async function thesisRoot(fs: FileSystem, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const root = await findThesisRoot(fs, cwd, signal)
  if (root === null) {
    throw new Error('未找到论文工作区（向上查找 00-管理/进度台账.md 失败）。请先 thesis_init，或在论文仓库目录内操作。')
  }
  return root
}

function formatDate(): string {
  return new Date().toISOString().slice(0, 10)
}

async function readLocalFile(fs: FileSystem, root: string, target: string, signal?: AbortSignal): Promise<{ name: string; text: string }> {
  const absolute = nodePath.isAbsolute(target) ? target : nodePath.join(root, target)
  try {
    const text = await fs.readText(await fs.resolve(absolute, { signal }), signal)
    return { name: nodePath.basename(absolute), text }
  } catch (error) {
    if (isMissingError(error)) {
      throw new Error(
        `找不到导出文件：${absolute}\n` +
        `请先在 Undermind / Elicit / Consensus / Zotero 里导出为 .bib 或 .ris，放到论文仓库里再传路径。`,
      )
    }
    throw new Error(describeReadFailure('文献导出文件', absolute, error, signal))
  }
}

function inferSource(fileName: string): string {
  const text = fileName.toLowerCase()
  if (text.includes('undermind')) return 'undermind'
  if (text.includes('elicit')) return 'elicit'
  if (text.includes('consensus')) return 'consensus'
  if (text.includes('zotero')) return 'zotero'
  if (text.includes('scholar')) return 'google-scholar'
  return 'file'
}

/** 追加核验报告（保留历史：每次核验一个 `## 日期` 小节）。 */
async function appendVerifyReport(fs: FileSystem, root: string, section: string, signal?: AbortSignal): Promise<string> {
  const path = nodePath.join(root, VERIFY_REPORT_REL)
  let existing: string
  try {
    existing = await fs.readText(await fs.resolve(path, { signal }), signal)
  } catch (error) {
    if (!isMissingError(error)) throw new Error(describeReadFailure('文献核验报告', path, error, signal))
    existing = VERIFY_REPORT_HEADER
  }
  const head = existing.trim() === '' ? VERIFY_REPORT_HEADER : existing.trimEnd()
  await fs.writeText(await fs.resolve(path, { signal }), `${head}\n\n${section}\n`, undefined, signal)
  return path
}

function verifyRow(date: string, source: string, title: string, status: string, note: string): string {
  return `| ${date} | 核验 | ${source} | ${title.replaceAll('|', '\\|').slice(0, 80)} | 1 | ${status}：${note.replaceAll('|', '\\|')} |`
}

function candidateFromArgs(args: LitVerifyArgs): CandidateRef {
  const title = (args.title ?? '').trim()
  const doi = (args.doi ?? '').trim()
  if (title === '' && doi === '') {
    throw new Error('请给 title 或 doi（单条核验），或用 path 指定导出的 .bib/.ris/.csv（批量核验）。')
  }
  return {
    title: title === '' ? `（仅凭 DOI 核验）${doi}` : title,
    authors: args.authors ?? [],
    year: args.year ?? null,
    venue: args.venue ?? '',
    ...(doi !== '' ? { doi } : {}),
    source: 'manual',
  }
}

async function reportAndSave(
  fs: FileSystem,
  root: string,
  outcomes: readonly VerifyOutcome[],
  label: string,
  save: boolean,
  signal?: AbortSignal,
): Promise<{ reportPath: string; savedText: string }> {
  const date = formatDate()
  const section = renderVerifyReport(date, outcomes, label)
  const reportPath = await appendVerifyReport(fs, root, section, signal)
  for (const outcome of outcomes) {
    await appendLitRecord(fs, root, verifyRow(date, outcome.candidate.source, outcome.candidate.title, outcome.status, outcome.message), signal)
  }
  let savedText = ''
  if (save) {
    const records = outcomes.flatMap(o => (o.status === 'verified' && o.record !== undefined ? [o.record] : []))
    if (records.length > 0) {
      const cache = mergeRecords(await loadCache(fs, root, signal), records)
      await saveCache(fs, root, cache, signal)
      savedText = await runLitSave(fs, { ids: records.map(r => r.id) }, root, signal)
    } else {
      savedText = '没有核验通过的条目，未写入 refs.bib。'
    }
  }
  return { reportPath, savedText }
}

function renderOutcomes(outcomes: readonly VerifyOutcome[], maxDetail = 8): string {
  const lines: string[] = []
  const passed = outcomes.filter(o => o.status === 'verified')
  const failed = outcomes.filter(o => o.status !== 'verified')
  if (passed.length > 0) {
    lines.push('### 核验通过', '')
    for (const outcome of passed.slice(0, maxDetail)) lines.push(renderOutcome(outcome), '')
  }
  if (failed.length > 0) {
    lines.push('### 未通过（禁止写入 refs.bib，须换文献或人工核对原文）', '')
    for (const outcome of failed.slice(0, 20)) lines.push(renderOutcome(outcome), '')
    if (failed.length > 20) lines.push(`（还有 ${failed.length - 20} 条未显示，见核验报告。）`, '')
  }
  return lines.join('\n')
}

export async function runLitVerify(
  fs: FileSystem,
  args: LitVerifyArgs,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<string> {
  const root = await thesisRoot(fs, cwd, signal)

  let candidates: CandidateRef[]
  let label: string
  if (args.path !== undefined && args.path.trim() !== '') {
    const file = await readLocalFile(fs, root, args.path.trim(), signal)
    const parsed = parseRefs(file.name, file.text, inferSource(file.name))
    if (parsed.candidates.length === 0) throw new Error(`${file.name} 里没有解析出任何文献条目（格式：${parsed.format}）。`)
    candidates = parsed.candidates
    label = `${file.name}（${parsed.format}，${parsed.candidates.length} 条）`
  } else {
    candidates = [candidateFromArgs(args)]
    label = '单条核验'
  }

  const outcomes = await verifyAll(fetchImpl, candidates, signal)
  const { reportPath, savedText } = await reportAndSave(fs, root, outcomes, label, args.save === true, signal)

  const lines: string[] = [`核验完成：${label}`, summarizeOutcomes(outcomes), '', renderOutcomes(outcomes)]
  if (savedText !== '') lines.push('### 入库结果', '', savedText, '')
  lines.push(`报告：${nodePath.relative(root, reportPath).split(nodePath.sep).join('/')}`)
  if (!args.save) {
    lines.push('下一步：确认结论后，用 thesis_lit_import 把整份导出文件入库（只收核验通过的），或 thesis_lit_verify 带 save: true 收录本条。')
  }
  return lines.join('\n')
}

export async function runLitImport(
  fs: FileSystem,
  args: LitImportArgs,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<string> {
  if (args.path === undefined || args.path.trim() === '') {
    throw new Error('path 必填：Undermind / Elicit / Consensus / Zotero 导出的 .bib / .ris / .csv 路径。')
  }
  const root = await thesisRoot(fs, cwd, signal)
  const file = await readLocalFile(fs, root, args.path.trim(), signal)
  const source = args.source ?? inferSource(file.name)
  const parsed = parseRefs(file.name, file.text, source)
  if (parsed.candidates.length === 0) throw new Error(`${file.name} 里没有解析出任何文献条目（格式：${parsed.format}）。`)

  const limited = args.limit !== undefined && args.limit > 0 ? parsed.candidates.slice(0, args.limit) : parsed.candidates
  const outcomes = await verifyAll(fetchImpl, limited, signal)
  const save = args.save !== false
  const { reportPath, savedText } = await reportAndSave(fs, root, outcomes, `${file.name}（${parsed.format}，来源 ${source}）`, save, signal)

  const lines: string[] = []
  lines.push(`导入 ${file.name}：解析 ${parsed.candidates.length} 条，本次核验 ${limited.length} 条（格式 ${parsed.format}，来源 ${source}）。`)
  if (parsed.warnings.length > 0) {
    lines.push('', '解析警告：')
    for (const warning of parsed.warnings.slice(0, 10)) lines.push(`- ${warning}`)
  }
  lines.push('', summarizeOutcomes(outcomes), '')
  if (save) {
    lines.push('### 入库结果', '', savedText, '')
  } else {
    lines.push('（save: false：只核验未入库。）', '')
  }
  lines.push(renderOutcomes(outcomes))
  lines.push(`报告：${nodePath.relative(root, reportPath).split(nodePath.sep).join('/')}`)
  const verified = outcomes.filter(o => o.status === 'verified')
  if (verified.length > 0) {
    lines.push('', '下一步：对核验通过的文献用 thesis_lit_note 生成阅读笔记；未通过的不要改写引用，换用 thesis_lit_search 另找一篇。')
  }
  return lines.join('\n')
}

export { REPORT_TABLE_HEAD }
export type { LitRecord }
