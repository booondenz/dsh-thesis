import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FetchLike } from '../src/paper/lib/lit-api.ts'
import { parseRefs, parseCsvRows, splitAuthors, detectRefFormat } from '../src/paper/lib/lit-refs.ts'
import {
  doiShapeValid,
  familyName,
  normalizeDoi,
  renderVerifyReport,
  titleSimilarity,
  verifyAll,
  verifyCandidate,
  type CandidateRef,
} from '../src/paper/lib/lit-verify.ts'
import { FakeFs } from './paper-fixtures.ts'

// ---------------------------------------------------------------------------
// 假 HTTP：按 URL 关键字路由，记录调用次数
// ---------------------------------------------------------------------------

interface Reply {
  readonly status: number
  readonly body?: unknown
}

type FakeFetch = FetchLike & { readonly calls: string[] }

function fakeFetch(handler: (url: string) => Reply): FakeFetch {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    const reply = handler(url)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response
  }) as FakeFetch
  ;(fn as { calls: string[] }).calls = calls
  return fn
}

const REAL_DOI = '10.1109/tse.2021.3051234'

const CROSSREF_REAL = {
  message: {
    DOI: REAL_DOI,
    title: ['Efficient Transformer Inference for Edge Devices'],
    author: [{ given: 'Wei', family: 'Zhang' }, { given: 'Min', family: 'Li' }],
    issued: { 'date-parts': [[2021, 3]] },
    'container-title': ['IEEE Transactions on Software Engineering'],
    type: 'journal-article',
    URL: `https://doi.org/${REAL_DOI}`,
  },
}

function crossrefDoiHit(url: string): Reply | null {
  if (!url.includes('api.crossref.org/works/10.')) return null
  const doi = decodeURIComponent(url.split('/works/')[1]!.split('?')[0]!).toLowerCase()
  return doi === REAL_DOI ? { status: 200, body: CROSSREF_REAL } : { status: 404 }
}

/** 默认世界：真实 DOI 命中 Crossref，其它 DOI 全库查无。 */
const realWorld = (url: string): Reply => {
  const hit = crossrefDoiHit(url)
  if (hit !== null) return hit
  if (url.includes('api.openalex.org')) return { status: 404 }
  if (url.includes('api.datacite.org')) return { status: 404 }
  if (url.includes('esearch.fcgi')) return { status: 200, body: { esearchresult: { idlist: [] } } }
  if (url.includes('esummary.fcgi')) return { status: 200, body: { result: {} } }
  return { status: 404 }
}

const candidate = (over: Partial<CandidateRef>): CandidateRef => ({
  title: 'Efficient Transformer Inference for Edge Devices',
  authors: ['Wei Zhang', 'Min Li'],
  year: 2021,
  venue: 'IEEE Transactions on Software Engineering',
  source: 'elicit',
  ...over,
})

// ---------------------------------------------------------------------------
// 归一化与相似度
// ---------------------------------------------------------------------------

test('DOI 归一化：去前缀、小写、形状校验', () => {
  assert.equal(normalizeDoi('  https://doi.org/10.1109/TSE.2021.3051234 '), REAL_DOI)
  assert.equal(normalizeDoi('doi: 10.1109/TSE.2021.3051234'), REAL_DOI)
  assert.equal(normalizeDoi('https://dx.doi.org/10.1000/x'), '10.1000/x')
  assert.equal(normalizeDoi('   '), undefined)
  assert.equal(doiShapeValid(REAL_DOI), true)
  assert.equal(doiShapeValid('not-a-doi'), false)
  assert.equal(doiShapeValid('10.1/x'), false)
})

test('题名相似度：相同=1，无关≈0，中文按双字切分', () => {
  assert.equal(titleSimilarity('Attention Is All You Need', 'attention is all you need!'), 1)
  assert.equal(titleSimilarity('Deep Learning for Vision', 'A Survey of Database Indexing'), 0)
  const zh = titleSimilarity('基于深度学习的害虫识别方法', '基于深度学习的害虫识别方法研究')
  assert.ok(zh > 0.7 && zh < 1, `中文题名相似度应居中，实际 ${zh}`)
  assert.ok(titleSimilarity('图像分割', '语义分割') > 0 && titleSimilarity('图像分割', '语义分割') < 0.5)
})

test('姓氏：西文取末词，中文取首字，去掉 Jr./van 等缀词', () => {
  assert.equal(familyName('Wei Zhang'), 'zhang')
  assert.equal(familyName('Zhang, Wei'), 'zhang')
  assert.equal(familyName('John Smith Jr.'), 'smith')
  assert.equal(familyName('Ludwig van Beethoven'), 'beethoven')
  assert.equal(familyName('张三'), '张')
})

// ---------------------------------------------------------------------------
// 核验判定
// ---------------------------------------------------------------------------

test('verify：DOI 命中且字段一致 → verified，并带回权威记录', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcome = await verifyCandidate(fetchImpl, candidate({ doi: REAL_DOI }))
  assert.equal(outcome.status, 'verified')
  assert.ok(outcome.score >= 0.92)
  assert.equal(outcome.record?.doi, REAL_DOI)
  assert.equal(outcome.record?.year, 2021)
  assert.equal(outcome.checks.some(c => c.severity === 'fail'), false)
})

test('verify：DOI 存在但题名对不上 → mismatch（张冠李戴）', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcome = await verifyCandidate(fetchImpl, candidate({ doi: REAL_DOI, title: 'A Completely Different Paper About Databases' }))
  assert.equal(outcome.status, 'mismatch')
  const titleCheck = outcome.checks.find(c => c.field === '题名')
  assert.equal(titleCheck?.severity, 'fail')
})

test('verify：DOI 全库查无 → not-found（疑似编造）', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcome = await verifyCandidate(fetchImpl, candidate({ doi: '10.9999/fake.2020.001' }))
  assert.equal(outcome.status, 'not-found')
  assert.match(outcome.message, /查无此文|疑似编造/)
  assert.equal(outcome.screens.length >= 4, true)
})

test('verify：网络全挂 → unchecked（fail closed，不算通过）', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error('ENOTFOUND')
  })
  const outcome = await verifyCandidate(fetchImpl, candidate({ doi: REAL_DOI }))
  assert.equal(outcome.status, 'unchecked')
  assert.match(outcome.message, /fail closed/)
})

test('verify：DOI 形状不合法 → invalid，且不发任何请求', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcome = await verifyCandidate(fetchImpl, candidate({ doi: '10.1' }))
  assert.equal(outcome.status, 'invalid')
  assert.equal(fetchImpl.calls.length, 0)
})

test('verify：没有 DOI 时按题名检索权威库', async () => {
  const fetchImpl = fakeFetch(url => {
    if (url.includes('query.bibliographic')) {
      return {
        status: 200,
        body: { message: { items: [{ ...CROSSREF_REAL.message, DOI: REAL_DOI }] } },
      }
    }
    return realWorld(url)
  })
  const outcome = await verifyCandidate(fetchImpl, candidate({}))
  assert.equal(outcome.status, 'verified')
  assert.equal(outcome.record?.doi, REAL_DOI)
})

test('verify：年份差 2 年 → mismatch（提醒核对版本）', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcome = await verifyCandidate(fetchImpl, candidate({ doi: REAL_DOI, year: 2023 }))
  assert.equal(outcome.status, 'mismatch')
})

test('verifyAll：逐条核验，单条失败不影响其它条', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcomes = await verifyAll(fetchImpl, [candidate({ doi: REAL_DOI }), candidate({ doi: '10.9999/nope' })])
  assert.deepEqual(outcomes.map(o => o.status), ['verified', 'not-found'])
})

test('报告：表格含结论与未通过明细', async () => {
  const fetchImpl = fakeFetch(realWorld)
  const outcomes = await verifyAll(fetchImpl, [candidate({ doi: REAL_DOI }), candidate({ doi: '10.9999/nope' })])
  const report = renderVerifyReport('2026-05-01', outcomes, '单条核验')
  assert.match(report, /\| 1 \| verified \|/)
  assert.match(report, /\| 2 \| not-found \|/)
  assert.match(report, /### 未通过的条目/)
})

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

const BIB_FIXTURE = `% Undermind export
@article{zhang2021efficient,
  title = {Efficient Transformer Inference for Edge Devices},
  author = {Zhang, Wei and Li, Min},
  year = {2021},
  journal = {IEEE Transactions on Software Engineering},
  doi = {10.1109/TSE.2021.3051234},
}

@inproceedings{chen2020survey,
  title = {A Survey of {Edge} Computing},
  author = {Chen, Hao},
  year = {2020},
  booktitle = {Proceedings of ICPP},
  doi = {10.9999/fake.2020.001}
}
`

const RIS_FIXTURE = `TY  - JOUR
TI  - Efficient Transformer Inference for Edge Devices
AU  - Zhang, Wei
AU  - Li, Min
PY  - 2021
JO  - IEEE Transactions on Software Engineering
DO  - 10.1109/TSE.2021.3051234
ER  -

TY  - CONF
TI  - A Survey of Edge Computing
AU  - Chen, Hao
PY  - 2020
T2  - ICPP
DO  - 10.9999/fake.2020.001
ER  -
`

const CSV_FIXTURE = `Title,Authors,Year,Venue,DOI
"Efficient Transformer Inference for Edge Devices","Wei Zhang; Min Li",2021,IEEE Transactions on Software Engineering,10.1109/TSE.2021.3051234
"A Survey of Edge Computing",Hao Chen,2020,ICPP,10.9999/fake.2020.001
`

test('BibTeX：条目扫描（嵌套花括号/多行字段/and 作者）', () => {
  const parsed = parseRefs('undermind.bib', BIB_FIXTURE, 'undermind')
  assert.equal(parsed.format, 'bibtex')
  assert.equal(parsed.candidates.length, 2)
  const first = parsed.candidates[0]!
  assert.equal(first.title, 'Efficient Transformer Inference for Edge Devices')
  assert.deepEqual(first.authors, ['Zhang, Wei', 'Li, Min'])
  assert.equal(first.year, 2021)
  assert.equal(first.doi, '10.1109/TSE.2021.3051234')
  assert.equal(first.source, 'undermind')
  assert.equal(parsed.candidates[1]!.title, 'A Survey of Edge Computing')
})

test('RIS：多记录、AU 多次出现、T2 作为出处', () => {
  const parsed = parseRefs('consensus.ris', RIS_FIXTURE, 'consensus')
  assert.equal(parsed.format, 'ris')
  assert.equal(parsed.candidates.length, 2)
  assert.deepEqual(parsed.candidates[0]!.authors, ['Zhang, Wei', 'Li, Min'])
  assert.equal(parsed.candidates[1]!.venue, 'ICPP')
})

test('CSV：引号字段、分号作者、表头同义词', () => {
  const parsed = parseRefs('elicit.csv', CSV_FIXTURE, 'elicit')
  assert.equal(parsed.format, 'csv')
  assert.equal(parsed.candidates.length, 2)
  assert.deepEqual(parsed.candidates[0]!.authors, ['Wei Zhang', 'Min Li'])
  assert.equal(parsed.candidates[0]!.doi, '10.1109/TSE.2021.3051234')
})

test('CSV：缺题名列时报错而不是瞎猜', () => {
  assert.throws(() => parseRefs('x.csv', 'Authors,Year\nA,2020\n', 'x'), /没有题名列/)
})

test('CSV：RFC4180 引号与字段内换行', () => {
  const rows = parseCsvRows('a,"b,1",c\n"x\ny",z,w\n')
  assert.deepEqual(rows[0], ['a', 'b,1', 'c'])
  assert.deepEqual(rows[1], ['x\ny', 'z', 'w'])
})

test('作者拆分：分号/and/JSON/逗号成对', () => {
  assert.deepEqual(splitAuthors('A B; C D'), ['A B', 'C D'])
  assert.deepEqual(splitAuthors('A B and C D'), ['A B', 'C D'])
  assert.deepEqual(splitAuthors('["A B","C D"]'), ['A B', 'C D'])
  assert.deepEqual(splitAuthors('Zhang, Wei, Li, Min'), ['Zhang Wei', 'Li Min'])
  assert.deepEqual(splitAuthors(''), [])
})

test('格式识别：扩展名优先，其次内容特征，都不像返回 null', () => {
  assert.equal(detectRefFormat('a.bib', ''), 'bibtex')
  assert.equal(detectRefFormat('a.ris', ''), 'ris')
  assert.equal(detectRefFormat('a.csv', ''), 'csv')
  assert.equal(detectRefFormat('paste.txt', '@article{x,\n title={t}\n}'), 'bibtex')
  assert.equal(detectRefFormat('paste.txt', '随便一段话'), null)
  assert.throws(() => parseRefs('paste.txt', '随便一段话', 'manual'), /无法识别/)
})

// ---------------------------------------------------------------------------
// 工具级：导入 → 只收录核验通过的
// ---------------------------------------------------------------------------

test('thesis_lit_import：核验通过的入库，查无的只进报告', async () => {
  const fs = new FakeFs()
  const { runInit } = await import('../src/paper/tools/init.ts')
  const { runLitImport, runLitVerify } = await import('../src/paper/tools/lit-verify.ts')
  await runInit(fs, { root: '/tmp/thesis-verify', git: false }, '/nonexistent')
  await fs.writeText(await fs.resolve('/tmp/thesis-verify/undermind.bib'), BIB_FIXTURE)

  const fetchImpl = fakeFetch(realWorld)
  const out = await runLitImport(fs, { path: 'undermind.bib' }, '/tmp/thesis-verify', undefined, fetchImpl)
  assert.match(out, /解析 2 条/)
  assert.match(out, /通过 1/)
  assert.match(out, /查无 1/)

  const bib = fs.peek('/tmp/thesis-verify/02-文献/refs.bib')!
  assert.match(bib, /10\.1109\/tse\.2021\.3051234/)
  assert.doesNotMatch(bib, /10\.9999\/fake/)
  assert.match(out, /未通过/)

  const report = fs.peek('/tmp/thesis-verify/08-合规/文献核验报告.md')!
  assert.match(report, /not-found/)
  assert.match(report, /未通过的条目/)

  const cache = JSON.parse(fs.peek('/tmp/thesis-verify/02-文献/.lit-cache.json')!) as { records: Record<string, unknown> }
  assert.equal(Object.keys(cache.records).length, 1)

  const record = fs.peek('/tmp/thesis-verify/02-文献/检索记录.md')!
  assert.match(record, /\| 核验 \|/)

  // verify 单条：不写 refs.bib
  const before = bib.length
  const single = await runLitVerify(fs, { doi: REAL_DOI, title: 'Efficient Transformer Inference for Edge Devices' }, '/tmp/thesis-verify', undefined, fetchImpl)
  assert.match(single, /通过 1/)
  assert.equal(fs.peek('/tmp/thesis-verify/02-文献/refs.bib')!.length, before)
})
