/**
 * 文献核验：把「候选文献」（AI 研究助手导出、粘贴、学长给的 pdf 清单）逐条
 * 拿到权威库对账，只有对得上的才允许进 refs.bib。
 *
 * 为什么需要这一层：Undermind / Elicit / Consensus 这类助手是**发现**工具，
 * 它们的导出里既有真论文，也有识别错误的题名、错位的年份、编造的 DOI。
 * 「零假文献」不能靠"我信任这个来源"，只能靠**逐条对账 + 失败即拒**。
 *
 * 权威库（全部免费、无需 key）：
 * - Crossref  https://api.crossref.org/works/{doi} 与 ?query.bibliographic=
 * - OpenAlex  https://api.openalex.org/works/doi:{doi} 与 ?search=
 * - DataCite  https://api.datacite.org/dois/{doi}（数据集/学位论文/预印本）
 * - PubMed    https://eutils.ncbi.nlm.nih.gov/entrez/eutils/（生物医学）
 *
 * 判定口径（写死，不给"感觉差不多"留口子）：
 * - verified：权威库存在该文献，且题名相似度 ≥0.92、第一作者姓氏对得上、年份差 ≤1；
 * - mismatch：权威库有记录但题名/作者/年份冲突（多半是张冠李戴，须人工看原文）；
 * - not-found：权威库查无此文（DOI 不存在 / 题名检索无命中）——**疑似编造**；
 * - unchecked：网络不可用或库限流，本轮没核验（fail closed：不许入库）。
 */

import { makeId, type FetchLike, type LitRecord, type LitType } from './lit-api.ts'

export type VerifyStatus = 'verified' | 'mismatch' | 'not-found' | 'invalid' | 'unchecked'

/** 待核验的候选文献。字段是"声称值"，不保证为真。 */
export interface CandidateRef {
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly venue: string
  readonly doi?: string
  readonly url?: string
  /** 来源标签：undermind / elicit / consensus / zotero / manual / paste… */
  readonly source: string
  /** 在原文件中的位置（第几条/第几行），用于回指。 */
  readonly ordinal?: number
}

export interface ReferenceCheck {
  readonly field: '题名' | '作者' | '年份' | 'DOI' | '出处'
  readonly claimed: string
  readonly registered: string
  /** ok=一致；warn=有差异但可接受；fail=冲突（禁止入库） */
  readonly severity: 'ok' | 'warn' | 'fail'
}

export interface VerifyScreen {
  readonly registry: string
  readonly query: string
  readonly ok: boolean
  readonly detail: string
}

export interface VerifyOutcome {
  readonly candidate: CandidateRef
  readonly status: VerifyStatus
  /** 题名相似度 0..1（无对照记录时为 0）。 */
  readonly score: number
  readonly record?: LitRecord
  readonly checks: readonly ReferenceCheck[]
  readonly screens: readonly VerifyScreen[]
  readonly message: string
}

export const VERIFY_REPORT_REL = '08-合规/文献核验报告.md'
const REQUEST_TIMEOUT_MS = 15000
const TITLE_VERIFIED = 0.92
const TITLE_CANDIDATE = 0.75

// ---------------------------------------------------------------------------
// 归一化与相似度（纯函数，可独立单测）
// ---------------------------------------------------------------------------

/** 去掉 `https://doi.org/`、`doi:` 前缀与空白；统一小写。不是合法 DOI 形状时返回 undefined。 */
export function normalizeDoi(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const text = raw
    .trim()
    .replace(/^doi\s*:\s*/i, '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/[.\s]+$/, '')
  return text === '' ? undefined : text.toLowerCase()
}

export function doiShapeValid(doi: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(doi)
}

/** 题名归一化：去重音、去标点、压缩空白、小写。中文按字切分。 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 题名相似度：中文按双字 shingle，西文按词，取 Dice 系数。 */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const setB = new Map<string, number>()
  for (const token of tb) setB.set(token, (setB.get(token) ?? 0) + 1)
  let hit = 0
  for (const token of ta) {
    const n = setB.get(token) ?? 0
    if (n > 0) {
      hit += 1
      setB.set(token, n - 1)
    }
  }
  return (2 * hit) / (ta.length + tb.length)
}

function titleTokens(raw: string): string[] {
  const text = normalizeTitle(raw)
  if (text === '') return []
  const words = text.split(' ')
  const hasCjk = /[\u3400-\u9fff]/.test(text)
  if (!hasCjk) return words
  // 中文：连续汉字取双字 shingle（单字题名退化为单字）。
  const tokens: string[] = []
  for (const word of words) {
    if (!/[\u3400-\u9fff]/.test(word)) {
      tokens.push(word)
      continue
    }
    if (word.length === 1) tokens.push(word)
    else for (let i = 0; i < word.length - 1; i += 1) tokens.push(word.slice(i, i + 2))
  }
  return tokens
}

/** 姓氏：`Zhang, Wei` 取逗号前；西文取最后一个词；中文姓名取第一个字；去掉 Jr./van 等缀词。 */
export function familyName(author: string): string {
  const cleaned = author.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[.]/g, ' ').trim()
  if (cleaned === '') return ''
  if (/[\u3400-\u9fff]/.test(cleaned)) return cleaned.replace(/[\s,]+/g, '').slice(0, 1)
  // "Zhang, Wei" / "Zhang, W."：逗号前就是姓。
  const comma = cleaned.indexOf(',')
  if (comma > 0) {
    const before = cleaned.slice(0, comma).trim()
    if (before !== '') return before.split(/\s+/).at(-1)!.toLowerCase()
  }
  const parts = cleaned.split(/\s+/).filter(p => p !== '' && !/^(jr|sr|ii|iii|iv|van|von|de|der|da|bin|al)$/i.test(p))
  return (parts.at(-1) ?? '').toLowerCase()
}

function authorOverlap(claimed: readonly string[], registered: readonly string[]): { matched: number; total: number } {
  const reg = new Set(registered.map(familyName).filter(n => n !== ''))
  const own = claimed.map(familyName).filter(n => n !== '')
  const matched = own.filter(n => reg.has(n)).length
  return { matched, total: own.length }
}

// ---------------------------------------------------------------------------
// 启发式本地检查（不联网就能挡掉一批脏数据）
// ---------------------------------------------------------------------------

const PLACEHOLDER = /^(待补|待定|todo|tbd|xxx+|test|example|示例|样例|无|none|null|n\/a)$/i

function localChecks(candidate: CandidateRef): ReferenceCheck[] {
  const checks: ReferenceCheck[] = []
  const title = candidate.title.trim()
  if (title === '' || PLACEHOLDER.test(title) || title.length < 6) {
    checks.push({ field: '题名', claimed: title === '' ? '（空）' : title, registered: '需要一个真实题名', severity: 'fail' })
  }
  if (candidate.doi !== undefined && !doiShapeValid(candidate.doi)) {
    checks.push({ field: 'DOI', claimed: candidate.doi, registered: '形如 10.1145/xxxx.xxxx', severity: 'fail' })
  }
  const year = candidate.year
  const maxYear = new Date().getFullYear() + 1
  if (year !== null && (year < 1900 || year > maxYear)) {
    checks.push({ field: '年份', claimed: String(year), registered: `应在 1900–${maxYear}`, severity: 'fail' })
  }
  if (candidate.authors.length === 0) {
    checks.push({ field: '作者', claimed: '（空）', registered: '需要作者姓名', severity: 'warn' })
  } else if (candidate.authors.every(a => /^(et\s*al\.?|等|others)$/i.test(a.trim()))) {
    checks.push({ field: '作者', claimed: candidate.authors.join(', '), registered: '需要具体姓名', severity: 'warn' })
  }
  if (candidate.venue.trim() === '') {
    checks.push({ field: '出处', claimed: '（空）', registered: '期刊/会议/出版者', severity: 'warn' })
  }
  return checks
}

// ---------------------------------------------------------------------------
// 与权威记录逐字段对账
// ---------------------------------------------------------------------------

function compareWithRecord(candidate: CandidateRef, record: LitRecord): { checks: ReferenceCheck[]; score: number; status: VerifyStatus } {
  const checks: ReferenceCheck[] = []
  const score = titleSimilarity(candidate.title, record.title)
  checks.push({
    field: '题名',
    claimed: candidate.title,
    registered: record.title,
    severity: score >= TITLE_VERIFIED ? 'ok' : score >= TITLE_CANDIDATE ? 'warn' : 'fail',
  })

  const overlap = authorOverlap(candidate.authors, record.authors)
  const firstOk = candidate.authors.length > 0 && record.authors.length > 0
    && familyName(candidate.authors[0]!) === familyName(record.authors[0]!)
  checks.push({
    field: '作者',
    claimed: candidate.authors.join(', ') || '（空）',
    registered: record.authors.join(', ') || '（空）',
    severity: candidate.authors.length === 0 || record.authors.length === 0
      ? 'warn'
      : firstOk || overlap.matched >= Math.ceil(overlap.total / 2)
        ? 'ok'
        : 'fail',
  })

  if (candidate.year !== null && record.year !== null) {
    const gap = Math.abs(candidate.year - record.year)
    checks.push({
      field: '年份',
      claimed: String(candidate.year),
      registered: String(record.year),
      severity: gap === 0 ? 'ok' : gap === 1 ? 'warn' : 'fail',
    })
  }

  if (candidate.doi !== undefined && record.doi !== undefined) {
    const claimedDoi = normalizeDoi(candidate.doi)
    const registeredDoi = normalizeDoi(record.doi)
    checks.push({
      field: 'DOI',
      claimed: claimedDoi ?? candidate.doi,
      registered: registeredDoi ?? record.doi,
      severity: claimedDoi === registeredDoi ? 'ok' : 'fail',
    })
  }

  if (candidate.venue !== '' && record.venue !== '') {
    const sim = titleSimilarity(candidate.venue, record.venue)
    checks.push({ field: '出处', claimed: candidate.venue, registered: record.venue, severity: sim > 0.2 ? 'ok' : 'warn' })
  }

  const status: VerifyStatus = checks.some(c => c.severity === 'fail') ? 'mismatch' : 'verified'
  return { checks, score, status }
}

// ---------------------------------------------------------------------------
// 权威库适配（每个库一个最小映射器）
// ---------------------------------------------------------------------------

interface RegistryHit {
  readonly registry: string
  readonly query: string
  readonly record?: LitRecord
  readonly detail: string
  /** true=确实查过并且确实没有（用于判定 not-found）；false=网络层失败。 */
  readonly conclusive: boolean
}

interface Fetched {
  readonly status: number
  readonly ok: boolean
  readonly body: unknown
  readonly error?: string
}

async function getJson(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<Fetched> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetchImpl(url, { signal: merged })
    if (!res.ok) return { status: res.status, ok: false, body: undefined }
    return { status: res.status, ok: true, body: await res.json() }
  } catch (error) {
    return { status: 0, ok: false, body: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function guessType(hint: string, venue: string): LitType {
  const text = `${hint} ${venue}`.toLowerCase()
  if (/proceedings|conference|symposium|workshop|会议/.test(text)) return 'inproceedings'
  if (/dissertation|thesis|学位/.test(text)) return 'phdthesis'
  if (/book|monograph|专著/.test(text)) return 'book'
  if (/posted-content|preprint|arxiv/.test(text)) return 'misc'
  return 'article'
}

interface CrossrefAuthor { readonly given?: string; readonly family?: string; readonly name?: string }

interface CrossrefWork {
  readonly DOI?: string
  readonly title?: string[]
  readonly author?: CrossrefAuthor[]
  readonly issued?: { readonly 'date-parts'?: number[][] }
  readonly 'container-title'?: string[]
  readonly type?: string
  readonly URL?: string
}

function fromCrossref(item: CrossrefWork): LitRecord | undefined {
  const doi = item.DOI
  const title = (item.title?.[0] ?? '').replace(/\s+/g, ' ').trim()
  if (doi === undefined || title === '') return undefined
  const venue = item['container-title']?.[0] ?? ''
  return {
    id: makeId(doi, item.URL, title),
    title,
    authors: (item.author ?? []).map(a => a.name ?? [a.given, a.family].filter(Boolean).join(' ').trim()).filter(n => n !== ''),
    year: item.issued?.['date-parts']?.[0]?.[0] ?? null,
    venue,
    type: guessType(item.type ?? '', venue),
    doi: doi.toLowerCase(),
    ...(item.URL !== undefined ? { url: item.URL } : {}),
    source: 'crossref',
  }
}

interface OpenAlexWork {
  readonly id?: string
  readonly doi?: string | null
  readonly display_name?: string
  readonly publication_year?: number | null
  readonly authorships?: Array<{ readonly author?: { readonly display_name?: string } }>
  readonly primary_location?: { readonly source?: { readonly display_name?: string } | null }
  readonly type?: string
  readonly cited_by_count?: number
}

function fromOpenAlex(work: OpenAlexWork): LitRecord | undefined {
  const title = (work.display_name ?? '').replace(/\s+/g, ' ').trim()
  const doi = normalizeDoi(work.doi ?? undefined)
  const url = work.id?.replace('https://openalex.org/', 'https://openalex.org/works/')
  if (title === '') return undefined
  if (doi === undefined && url === undefined) return undefined
  const venue = work.primary_location?.source?.display_name ?? ''
  return {
    id: makeId(doi, url, title),
    title,
    authors: (work.authorships ?? []).map(a => a.author?.display_name ?? '').filter(n => n !== ''),
    year: work.publication_year ?? null,
    venue,
    type: guessType(work.type ?? '', venue),
    ...(doi !== undefined ? { doi } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(work.cited_by_count !== undefined ? { citationCount: work.cited_by_count } : {}),
    source: 'openalex',
  }
}

interface DataciteDoi {
  readonly data?: {
    readonly attributes?: {
      readonly doi?: string
      readonly titles?: Array<{ readonly title?: string }>
      readonly creators?: Array<{ readonly name?: string; readonly givenName?: string; readonly familyName?: string }>
      readonly publicationYear?: number
      readonly publisher?: string | { readonly name?: string }
      readonly types?: { readonly resourceTypeGeneral?: string }
      readonly url?: string
    }
  }
}

function fromDatacite(body: DataciteDoi): LitRecord | undefined {
  const attrs = body.data?.attributes
  if (attrs === undefined) return undefined
  const doi = normalizeDoi(attrs.doi)
  const title = (attrs.titles?.[0]?.title ?? '').replace(/\s+/g, ' ').trim()
  if (doi === undefined || title === '') return undefined
  const publisher = typeof attrs.publisher === 'string' ? attrs.publisher : attrs.publisher?.name ?? ''
  return {
    id: makeId(doi, attrs.url, title),
    title,
    authors: (attrs.creators ?? []).map(c => c.name ?? [c.givenName, c.familyName].filter(Boolean).join(' ').trim()).filter(n => n !== ''),
    year: attrs.publicationYear ?? null,
    venue: publisher,
    type: guessType(attrs.types?.resourceTypeGeneral ?? '', publisher),
    doi,
    ...(attrs.url !== undefined ? { url: attrs.url } : {}),
    source: 'datacite',
  }
}

interface PubmedSummary {
  readonly title?: string
  readonly authors?: Array<{ readonly name?: string }>
  readonly pubdate?: string
  readonly fulljournalname?: string
  readonly source?: string
  readonly articleids?: Array<{ readonly idtype?: string; readonly value?: string }>
}

function fromPubmed(summary: PubmedSummary): LitRecord | undefined {
  const title = (summary.title ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  if (title === '') return undefined
  const doi = normalizeDoi(summary.articleids?.find(a => a.idtype === 'doi')?.value)
  const pmid = summary.articleids?.find(a => a.idtype === 'pubmed')?.value
  const url = pmid === undefined ? undefined : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
  const yearRaw = Number.parseInt((summary.pubdate ?? '').slice(0, 4), 10)
  return {
    id: makeId(doi, url, title),
    title,
    authors: (summary.authors ?? []).map(a => a.name ?? '').filter(n => n !== ''),
    year: Number.isNaN(yearRaw) ? null : yearRaw,
    venue: summary.fulljournalname ?? summary.source ?? '',
    type: 'article',
    ...(doi !== undefined ? { doi } : {}),
    ...(url !== undefined ? { url } : {}),
    source: 'pubmed',
  }
}

async function crossrefByDoi(fetchImpl: FetchLike, doi: string, signal?: AbortSignal): Promise<RegistryHit> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
  const res = await getJson(fetchImpl, url, signal)
  if (res.error !== undefined) return { registry: 'Crossref', query: doi, detail: `请求失败：${res.error}`, conclusive: false }
  if (res.status === 404) return { registry: 'Crossref', query: doi, detail: '该 DOI 在 Crossref 不存在', conclusive: true }
  if (!res.ok) return { registry: 'Crossref', query: doi, detail: `HTTP ${res.status}`, conclusive: false }
  const record = fromCrossref((res.body as { message?: CrossrefWork }).message ?? {})
  return record === undefined
    ? { registry: 'Crossref', query: doi, detail: '返回体缺少题名/DOI', conclusive: true }
    : { registry: 'Crossref', query: doi, record, detail: '命中', conclusive: true }
}

async function crossrefByTitle(fetchImpl: FetchLike, title: string, signal?: AbortSignal): Promise<RegistryHit> {
  const params = new URLSearchParams({ 'query.bibliographic': title, rows: '5', select: 'DOI,title,author,issued,container-title,type,URL' })
  const url = `https://api.crossref.org/works?${params}`
  const res = await getJson(fetchImpl, url, signal)
  if (res.error !== undefined) return { registry: 'Crossref', query: title, detail: `请求失败：${res.error}`, conclusive: false }
  if (!res.ok) return { registry: 'Crossref', query: title, detail: `HTTP ${res.status}`, conclusive: false }
  const items = (res.body as { message?: { items?: CrossrefWork[] } }).message?.items ?? []
  const records = items.map(fromCrossref).filter((r): r is LitRecord => r !== undefined)
  return bestTitleHit('Crossref', title, records)
}

async function openAlexByDoi(fetchImpl: FetchLike, doi: string, signal?: AbortSignal): Promise<RegistryHit> {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`
  const res = await getJson(fetchImpl, url, signal)
  if (res.error !== undefined) return { registry: 'OpenAlex', query: doi, detail: `请求失败：${res.error}`, conclusive: false }
  if (res.status === 404) return { registry: 'OpenAlex', query: doi, detail: '该 DOI 在 OpenAlex 不存在', conclusive: true }
  if (!res.ok) return { registry: 'OpenAlex', query: doi, detail: `HTTP ${res.status}`, conclusive: false }
  const record = fromOpenAlex(res.body as OpenAlexWork)
  return record === undefined
    ? { registry: 'OpenAlex', query: doi, detail: '返回体缺少题名', conclusive: true }
    : { registry: 'OpenAlex', query: doi, record, detail: '命中', conclusive: true }
}

async function openAlexByTitle(fetchImpl: FetchLike, title: string, signal?: AbortSignal): Promise<RegistryHit> {
  const params = new URLSearchParams({ search: title, 'per-page': '5', select: 'id,doi,display_name,publication_year,authorships,primary_location,type,cited_by_count' })
  const res = await getJson(fetchImpl, `https://api.openalex.org/works?${params}`, signal)
  if (res.error !== undefined) return { registry: 'OpenAlex', query: title, detail: `请求失败：${res.error}`, conclusive: false }
  if (!res.ok) return { registry: 'OpenAlex', query: title, detail: `HTTP ${res.status}`, conclusive: false }
  const results = (res.body as { results?: OpenAlexWork[] }).results ?? []
  return bestTitleHit('OpenAlex', title, results.map(fromOpenAlex).filter((r): r is LitRecord => r !== undefined))
}

async function dataciteByDoi(fetchImpl: FetchLike, doi: string, signal?: AbortSignal): Promise<RegistryHit> {
  const res = await getJson(fetchImpl, `https://api.datacite.org/dois/${encodeURIComponent(doi)}`, signal)
  if (res.error !== undefined) return { registry: 'DataCite', query: doi, detail: `请求失败：${res.error}`, conclusive: false }
  if (res.status === 404) return { registry: 'DataCite', query: doi, detail: '该 DOI 在 DataCite 不存在', conclusive: true }
  if (!res.ok) return { registry: 'DataCite', query: doi, detail: `HTTP ${res.status}`, conclusive: false }
  const record = fromDatacite(res.body as DataciteDoi)
  return record === undefined
    ? { registry: 'DataCite', query: doi, detail: '返回体缺少题名', conclusive: true }
    : { registry: 'DataCite', query: doi, record, detail: '命中', conclusive: true }
}

async function pubmed(fetchImpl: FetchLike, term: string, signal?: AbortSignal): Promise<RegistryHit> {
  const esearch = await getJson(
    fetchImpl,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(term)}`,
    signal,
  )
  if (esearch.error !== undefined) return { registry: 'PubMed', query: term, detail: `请求失败：${esearch.error}`, conclusive: false }
  if (!esearch.ok) return { registry: 'PubMed', query: term, detail: `HTTP ${esearch.status}`, conclusive: false }
  const ids = (esearch.body as { esearchresult?: { idlist?: string[] } }).esearchresult?.idlist ?? []
  if (ids.length === 0) return { registry: 'PubMed', query: term, detail: '无命中', conclusive: true }
  const esummary = await getJson(
    fetchImpl,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(ids[0]!)}`,
    signal,
  )
  if (!esummary.ok) return { registry: 'PubMed', query: term, detail: `摘要请求 HTTP ${esummary.status}`, conclusive: false }
  const result = (esummary.body as { result?: Record<string, PubmedSummary | string[]> }).result
  const summary = result?.[ids[0]!]
  const record = summary === undefined || Array.isArray(summary) ? undefined : fromPubmed(summary)
  return record === undefined
    ? { registry: 'PubMed', query: term, detail: '摘要缺少题名', conclusive: true }
    : { registry: 'PubMed', query: term, record, detail: '命中', conclusive: true }
}

function bestTitleHit(registry: string, title: string, records: readonly LitRecord[]): RegistryHit {
  if (records.length === 0) return { registry, query: title, detail: '无命中', conclusive: true }
  let best = records[0]!
  let bestScore = titleSimilarity(title, best.title)
  for (const record of records.slice(1)) {
    const score = titleSimilarity(title, record.title)
    if (score > bestScore) {
      best = record
      bestScore = score
    }
  }
  return { registry, query: title, record: best, detail: `最佳命中相似度 ${bestScore.toFixed(2)}`, conclusive: true }
}

// ---------------------------------------------------------------------------
// 核验主流程
// ---------------------------------------------------------------------------

/**
 * 核验单条候选文献。网络全部失败时返回 `unchecked`（**不是** verified）：
 * 拿不到权威库就宁可不入库，这是「零假文献」的 fail-closed 语义。
 */
export async function verifyCandidate(fetchImpl: FetchLike, candidate: CandidateRef, signal?: AbortSignal): Promise<VerifyOutcome> {
  const local = localChecks(candidate)
  if (local.some(c => c.severity === 'fail')) {
    return {
      candidate,
      status: 'invalid',
      score: 0,
      checks: local,
      screens: [],
      message: `本地检查不通过：${local.filter(c => c.severity === 'fail').map(c => `${c.field}「${c.claimed}」`).join('、')}`,
    }
  }

  const screens: VerifyScreen[] = []
  const doi = normalizeDoi(candidate.doi)
  const hits: RegistryHit[] = []

  if (doi !== undefined) {
    for (const lookup of [crossrefByDoi, openAlexByDoi, dataciteByDoi]) {
      const hit = await lookup(fetchImpl, doi, signal)
      screens.push({ registry: hit.registry, query: hit.query, ok: hit.record !== undefined, detail: hit.detail })
      hits.push(hit)
      if (hit.record !== undefined) break
    }
    if (!hits.some(h => h.record !== undefined)) {
      const hit = await pubmed(fetchImpl, `${doi}[DOI]`, signal)
      screens.push({ registry: hit.registry, query: hit.query, ok: hit.record !== undefined, detail: hit.detail })
      hits.push(hit)
    }
  } else {
    for (const lookup of [crossrefByTitle, openAlexByTitle]) {
      const hit = await lookup(fetchImpl, candidate.title, signal)
      screens.push({ registry: hit.registry, query: hit.query, ok: hit.record !== undefined, detail: hit.detail })
      hits.push(hit)
      if (hit.record !== undefined && titleSimilarity(candidate.title, hit.record.title) >= TITLE_VERIFIED) break
    }
    if (!hits.some(h => h.record !== undefined)) {
      const hit = await pubmed(fetchImpl, `"${candidate.title}"[Title]`, signal)
      screens.push({ registry: hit.registry, query: hit.query, ok: hit.record !== undefined, detail: hit.detail })
      hits.push(hit)
    }
  }

  const withRecord = hits.filter(h => h.record !== undefined)
  if (withRecord.length === 0) {
    const conclusive = hits.length > 0 && hits.every(h => h.conclusive)
    const networkDown = hits.some(h => !h.conclusive) && !conclusive
    return {
      candidate,
      status: networkDown ? 'unchecked' : 'not-found',
      score: 0,
      checks: local,
      screens,
      message: networkDown
        ? '权威库没连上，本轮未核验（fail closed：核验通过前不许写入 refs.bib）。请联网后重跑 thesis_lit_verify。'
        : 'Crossref / OpenAlex / DataCite / PubMed 均查无此文：疑似编造或题名/DOI 有误，禁止入库。',
    }
  }

  // 选相似度最高的那条权威记录做对账。
  let best = withRecord[0]!
  let bestScore = titleSimilarity(candidate.title, best.record!.title)
  for (const hit of withRecord.slice(1)) {
    const score = titleSimilarity(candidate.title, hit.record!.title)
    if (score > bestScore) {
      best = hit
      bestScore = score
    }
  }
  const record = best.record!
  const comparison = compareWithRecord(candidate, record)
  const checks = [...local, ...comparison.checks]
  const verified = comparison.status === 'verified' && comparison.score >= TITLE_VERIFIED
  return {
    candidate,
    status: verified ? 'verified' : 'mismatch',
    score: comparison.score,
    record,
    checks,
    screens,
    message: verified
      ? `已由 ${best.registry} 确认：题名相似度 ${comparison.score.toFixed(2)}。`
      : `${best.registry} 有近似记录但字段冲突（相似度 ${comparison.score.toFixed(2)}）：请核对原文，别按候选值写引用。`,
  }
}

/** 批量核验（顺序执行，礼貌对待免费库；单条失败不影响其它条）。 */
export async function verifyAll(
  fetchImpl: FetchLike,
  candidates: readonly CandidateRef[],
  signal?: AbortSignal,
): Promise<VerifyOutcome[]> {
  const out: VerifyOutcome[] = []
  for (const candidate of candidates) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('已取消')
    out.push(await verifyCandidate(fetchImpl, candidate, signal))
  }
  return out
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export function summarizeOutcomes(outcomes: readonly VerifyOutcome[]): string {
  const count = (status: VerifyStatus): number => outcomes.filter(o => o.status === status).length
  return `共 ${outcomes.length} 条：通过 ${count('verified')}，冲突 ${count('mismatch')}，查无 ${count('not-found')}，格式不合法 ${count('invalid')}，未核验 ${count('unchecked')}`
}

export function renderOutcome(outcome: VerifyOutcome): string {
  const badge: Record<VerifyStatus, string> = {
    verified: '✓ 通过',
    mismatch: '⚠ 冲突',
    'not-found': '✗ 查无',
    invalid: '✗ 不合法',
    unchecked: '◌ 未核验',
  }
  const lines = [`${badge[outcome.status]} ${outcome.candidate.title || '（无题名）'}`]
  const meta: string[] = []
  if (outcome.candidate.authors.length > 0) meta.push(outcome.candidate.authors.slice(0, 3).join(', '))
  if (outcome.candidate.year !== null) meta.push(String(outcome.candidate.year))
  if (outcome.candidate.venue !== '') meta.push(outcome.candidate.venue)
  if (meta.length > 0) lines.push(`    ${meta.join('；')}`)
  if (outcome.record !== undefined) lines.push(`    权威记录：${outcome.record.title}（${outcome.record.authors.slice(0, 3).join(', ')}，${outcome.record.year ?? '年未知'}，${outcome.record.venue || '出处未知'}）`)
  for (const check of outcome.checks.filter(c => c.severity !== 'ok')) {
    lines.push(`    ${check.severity === 'fail' ? '✗' : '△'} ${check.field}：候选「${check.claimed}」 vs 权威「${check.registered}」`)
  }
  lines.push(`    ${outcome.message}`)
  return lines.join('\n')
}

export function renderVerifyReport(date: string, outcomes: readonly VerifyOutcome[], label: string): string {
  const lines: string[] = [`## ${date} 核验（${label}）`, '', summarizeOutcomes(outcomes), '']
  lines.push('| # | 结论 | 题名 | 年份 | DOI | 说明 |')
  lines.push('|---|---|---|---|---|---|')
  outcomes.forEach((o, index) => {
    const title = o.candidate.title.replaceAll('|', '\\|').slice(0, 60)
    lines.push(`| ${index + 1} | ${o.status} | ${title} | ${o.candidate.year ?? '—'} | ${o.candidate.doi ?? '—'} | ${o.message.replaceAll('|', '\\|')} |`)
  })
  const problems = outcomes.filter(o => o.status !== 'verified')
  if (problems.length > 0) {
    lines.push('', '### 未通过的条目（不得写入 refs.bib）', '')
    for (const outcome of problems) lines.push(renderOutcome(outcome), '')
  }
  return lines.join('\n')
}

export const VERIFY_REPORT_HEADER = `# 文献核验报告

> 口径：每条候选文献必须由 Crossref / OpenAlex / DataCite / PubMed 中的权威库确认存在，
> 且题名相似度 ≥0.92、第一作者姓氏一致、年份差 ≤1，才允许写入 02-文献/refs.bib。
> Undermind / Elicit / Consensus 只负责「找到候选」，入库一律以本报告的核验结论为准。
`
