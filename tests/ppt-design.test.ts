import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESIGN, DECK_LAYOUTS, cjkLen, designIssues, parseDeckPages } from '../src/ppt/design.ts'

const FRONT = '---\nmarp: true\ntheme: default\npaginate: true\n---\n\n'

test('parseDeckPages：读出封面/数据页/结尾页与要点数', () => {
  const deck = `${FRONT}<!-- _class: cover -->
# 题目

---

<!-- _class: stats -->
## 测试结果

- 303–755 ms 选主
- 93.63 个/秒

<!-- 讲稿：数据是 bench 跑的 -->

---

<!-- _class: closing -->
# 谢谢，请提问
`
  const pages = parseDeckPages(deck)
  assert.deepEqual(pages.map(p => p.layout), ['cover', 'stats', 'closing'])
  assert.equal(pages[1]!.bullets.length, 2)
  assert.equal(pages[1]!.hasNotes, true)
  assert.equal(pages[0]!.title, '题目')
})

test('parseDeckPages：没有 _class 的页记作 bullets（纯要点页）', () => {
  const pages = parseDeckPages(`${FRONT}## 选题背景\n\n- 一条\n- 两条\n`)
  assert.equal(pages.length, 1)
  assert.equal(pages[0]!.layout, 'bullets')
})

test('designIssues：合格的版面不报警', () => {
  const deck = `${FRONT}<!-- _class: cover -->
# 题目

---

<!-- _class: figure -->
## 架构

- 同构节点

---

<!-- _class: stats -->
## 结果

- 93.63 个/秒

---

<!-- _class: closing -->
# 谢谢，请提问
`
  assert.deepEqual(designIssues(parseDeckPages(deck)), [])
})

test('designIssues：bullet wall 会被点名（本次真实踩过的坑）', () => {
  const slide = (t: string): string => `## ${t}\n\n- 一条要点\n- 两条要点\n- 三条要点\n`
  const deck = `${FRONT}${slide('一')}\n---\n${slide('二')}\n---\n${slide('三')}\n---\n${slide('四')}\n---\n${slide('五')}\n`
  const issues = designIssues(parseDeckPages(deck))
  const codes = issues.map(i => i.code)
  assert.ok(codes.includes('design-bullet-wall'), codes.join(','))
  assert.ok(codes.includes('design-no-cover'))
  assert.ok(codes.includes('design-no-closing'))
  assert.ok(codes.includes('design-no-visual'))
  const wall = issues.find(i => i.code === 'design-bullet-wall')!
  assert.match(wall.message, /版面单一/)
  assert.equal(wall.level, 'warn')
})

test('designIssues：单页要点过多与要点过长分别报出', () => {
  const long = '这是一条特别长的要点'.repeat(4)
  const deck = `${FRONT}<!-- _class: cover -->
# 题目

---

## 多要点

- 一
- 二
- 三
- 四
- 五
- 六

---

## 长要点

- ${long}

---

<!-- _class: closing -->
# 谢谢
`
  const codes = designIssues(parseDeckPages(deck)).map(i => i.code)
  assert.ok(codes.includes('design-too-many-bullets'))
  assert.ok(codes.includes('design-bullet-too-long'))
})

test('designIssues：连续 4 页纯文字给一条提示', () => {
  const page = (t: string): string => `<!-- _class: columns -->\n## ${t}\n\n- 要点\n`
  const deck = `${FRONT}<!-- _class: cover -->\n# 题\n\n---\n${page('一')}\n---\n${page('二')}\n---\n${page('三')}\n---\n${page('四')}\n`
  const codes = designIssues(parseDeckPages(deck)).map(i => i.code)
  assert.ok(codes.includes('design-no-visual-run'))
})

test('cjkLen：中文按 1、西文按 0.5 计（结果取整）', () => {
  assert.equal(cjkLen('中文四字'), 4)
  assert.equal(cjkLen('abcd'), 2)
  assert.equal(cjkLen('Raft 共识'), 5)
})

test('设计常量：四档字号、单一强调色、版心留白', () => {
  assert.deepEqual(Object.keys(DESIGN.type).sort(), ['body', 'kicker', 'lead', 'small', 'stat', 'tiny', 'title'])
  assert.equal(DESIGN.color.accent, '#002FA7')
  assert.notEqual(DESIGN.color.paper.toUpperCase(), '#FFFFFF')
  assert.notEqual(DESIGN.color.ink.toUpperCase(), '#000000')
  assert.equal(DESIGN.rules.maxBullets, 4)
  assert.equal(new Set(DECK_LAYOUTS).size, DECK_LAYOUTS.length)
  assert.ok(DECK_LAYOUTS.includes('figure') && DECK_LAYOUTS.includes('stats'))
})
