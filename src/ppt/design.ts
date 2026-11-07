/**
 * 答辩幻灯的版面设计系统（借鉴「歸藏设计」瑞士风的核心，重新实现，不引其代码）。
 *
 * 为什么放进插件：幻灯丑几乎从不是"配色没调好"，而是**版面单调 + 层级缺失**——
 * 11 页里 9 页都是「标题 + ▪ 列表」，观众看不到任何视觉锚点。这类问题可以确定性地
 * 检查出来，不该靠每次重新叮嘱。
 *
 * 本模块只做三件事：
 * 1. `DESIGN`：把版心、字号、色彩写成常量（生成器与检查器共用同一套口径）；
 * 2. `parseDeckPages`：从 Markdown 里读出每页的版面类型（`<!-- _class: xxx -->`）；
 * 3. `designIssues`：确定性规则——版面单调、要点过多、连续无图、缺封面/结尾页。
 */

/** 16:9 画布与版心（英寸）。生成脚本与检查器都以这里为准。 */
export const DESIGN = {
  canvas: { width: 13.333, height: 7.5 },
  margin: { left: 0.95, right: 0.95, top: 0.34, bottom: 0.55 },
  /** 字号（pt）：kicker / 标题 / 正文 / 数字。层级只有四档，不许逐页乱调。 */
  type: { kicker: 10.5, title: 32, lead: 21, body: 15, small: 15, tiny: 11.5, stat: 54 },
  /** 纸色 + 墨色 + 单一强调色（克莱因蓝）。不用纯白纯黑。 */
  color: { paper: '#FAFAF8', ink: '#141414', ink2: '#5A5A56', hairline: '#D9D6CC', card: '#F0EEE8', accent: '#002FA7' },
  /** 一页最多几条要点；再多就不是幻灯而是说明书。 */
  rules: { maxBullets: 4, maxBulletChars: 30, maxTitleChars: 20, minVisualPages: 2, maxSameLayoutRatio: 0.6 },
} as const

/**
 * 版面类型。名字即契约：`<!-- _class: compare -->` 会渲染成左右对照版，
 * 而不是又一段项目符号。
 */
export const DECK_LAYOUTS = [
  'cover', // 封面：题目 + 副题 + 学号/导师/日期
  'agenda', // 目录：四条路线，大号数字
  'compare', // 对照：现状 vs 本方案，一灰一亮两块
  'rows', // 逐条陈述：左标签 + 右说明 + 一句引文
  'steps', // 路线：四列，大号序号
  'cards', // 四象限卡片：关键路径/机制
  'figure', // 大图 + 右侧要点
  'columns', // 双栏/三栏并列
  'stats', // 数据页：四个大数字
  'closing', // 结尾：致谢 + 材料索引
] as const

export type DeckLayout = (typeof DECK_LAYOUTS)[number]

export interface DeckPage {
  /** 从 1 开始。 */
  readonly index: number
  /** 缺省为 `bullets`（没有任何 `_class` 的纯要点页）。 */
  readonly layout: DeckLayout | 'bullets'
  readonly title: string
  readonly bullets: readonly string[]
  /** 本页有几个 `[panel]` 分栏（≥2 时要点按栏均分，不按页计）。 */
  readonly panels: number
  readonly hasNotes: boolean
}

export interface DesignIssue {
  readonly code: string
  readonly level: 'error' | 'warn'
  readonly where: string
  readonly message: string
}

const CLASS_PATTERN = /<!--\s*_class:\s*([\w-]+)\s*-->/

/** 把 Marp Markdown 切成页，读出每页的版面类型与要点数。 */
export function parseDeckPages(markdown: string): DeckPage[] {
  const body = markdown.startsWith('---') ? markdown.slice(markdown.indexOf('\n---', 3) + 4) : markdown
  const pages: DeckPage[] = []
  for (const chunk of body.split(/^---\s*$/m)) {
    const lines = chunk.split(/\r?\n/)
    let layout: DeckLayout | 'bullets' = 'bullets'
    let title = ''
    let hasNotes = false
    let panels = 0
    const bullets: string[] = []
    for (const raw of lines) {
      const line = raw.trim()
      const cls = CLASS_PATTERN.exec(line)
      if (cls !== null) {
        const name = cls[1]!
        if ((DECK_LAYOUTS as readonly string[]).includes(name)) layout = name as DeckLayout
        continue
      }
      if (/^<!--/.test(line)) {
        hasNotes = hasNotes || /讲稿|notes?/i.test(line)
        continue
      }
      if (line.startsWith('# ')) {
        title = line.slice(2).trim()
        continue
      }
      if (/^\[panel\]/.test(line)) {
        panels += 1
        continue
      }
      if (line.startsWith('## ') && title === '') {
        title = line.slice(3).trim()
        continue
      }
      if (line.startsWith('- ')) bullets.push(line.slice(2).replace(/<!--.*?-->/g, '').trim())
    }
    if (title === '' && bullets.length === 0) continue
    pages.push({ index: pages.length + 1, layout, title, bullets, panels, hasNotes })
  }
  return pages
}

/** 视觉页：有大图或大数字的页，观众记得住的那种。 */
function isVisual(page: DeckPage): boolean {
  return page.layout === 'figure' || page.layout === 'stats'
}

/**
 * 确定性版式检查。返回空数组表示"版面不单调、每页都讲得清"。
 *
 * 刻意只查**可机器判定**的事：版面分布、要点数量、连续无图、封面结尾。
 * 配色好不好看、话术顺不顺，仍然要人看。
 */
export function designIssues(pages: readonly DeckPage[]): DesignIssue[] {
  const issues: DesignIssue[] = []
  if (pages.length === 0) return issues
  const { rules } = DESIGN

  // 1. 封面 / 结尾
  if (pages[0]!.layout !== 'cover') {
    issues.push({
      code: 'design-no-cover',
      level: 'warn',
      where: '第 1 页',
      message: '第一页不是封面版（`<!-- _class: cover -->`）：答辩开场需要题目、姓名、学号、导师、日期一屏交代清楚。',
    })
  }
  if (pages[pages.length - 1]!.layout !== 'closing') {
    issues.push({
      code: 'design-no-closing',
      level: 'warn',
      where: `第 ${pages.length} 页`,
      message: '最后一页不是结尾版（`<!-- _class: closing -->`）：留一页写「谢谢，请提问」与代码/数据/论文位置。',
    })
  }

  // 2. 版面单调：默认要点页占比过高
  const defaultPages = pages.filter(p => p.layout === 'bullets')
  if (pages.length >= 5 && defaultPages.length / pages.length > rules.maxSameLayoutRatio) {
    issues.push({
      code: 'design-bullet-wall',
      level: 'warn',
      where: `${defaultPages.map(p => `第 ${p.index} 页`).slice(0, 6).join('、')}${defaultPages.length > 6 ? ' 等' : ''}`,
      message:
        `${defaultPages.length}/${pages.length} 页是「标题 + 要点」的同一种版式。版面单一是幻灯"看起来糙"的首要原因：` +
        `对照用 compare、路线用 steps、机制用 cards、数据用 stats、架构图用 figure。`,
    })
  }

  // 3. 同一种非默认版面用过头
  const byLayout = new Map<string, DeckPage[]>()
  for (const page of pages) {
    if (page.layout === 'bullets') continue
    byLayout.set(page.layout, [...(byLayout.get(page.layout) ?? []), page])
  }
  for (const [layout, group] of byLayout) {
    if (pages.length >= 8 && group.length / pages.length > rules.maxSameLayoutRatio) {
      issues.push({
        code: 'design-layout-monotone',
        level: 'warn',
        where: group.map(p => `第 ${p.index} 页`).join('、'),
        message: `「${layout}」版式占 ${group.length}/${pages.length} 页，观众会觉得都是同一页在翻。换一两页别的版面。`,
      })
    }
  }

  // 4. 每页要点数与长度
  for (const page of pages) {
    if (page.layout === 'cover' || page.layout === 'closing' || page.layout === 'agenda') continue
    // 分栏版式按"每栏"计要点：compare/columns 一页 6–9 条，摊到 2–3 栏是正常的。
    const perColumn = page.panels >= 2 ? page.bullets.length / page.panels : page.bullets.length
    if (perColumn > rules.maxBullets) {
      issues.push({
        code: 'design-too-many-bullets',
        level: 'warn',
        where: `第 ${page.index} 页`,
        message: `${page.bullets.length} 条要点${page.panels >= 2 ? `（${page.panels} 栏，每栏约 ${Math.round(perColumn)} 条）` : ''}（每页建议 ≤${rules.maxBullets}）：` +
          '讲的时候只会念，观众也读不完。合并同类项或拆页。',
      })
    }
    for (const bullet of page.bullets) {
      if (cjkLen(bullet) > rules.maxBulletChars) {
        issues.push({
          code: 'design-bullet-too-long',
          level: 'warn',
          where: `第 ${page.index} 页`,
          message: `要点 ${cjkLen(bullet)} 字（≤${rules.maxBulletChars}）：「${bullet.slice(0, 18)}…」改成结论句，细节留在讲稿里。`,
        })
        break
      }
    }
    if (page.title !== '' && cjkLen(page.title) > rules.maxTitleChars) {
      issues.push({
        code: 'design-title-too-long',
        level: 'warn',
        where: `第 ${page.index} 页`,
        message: `标题 ${cjkLen(page.title)} 字（≤${rules.maxTitleChars}）：标题写主张，不写范围。`,
      })
    }
  }

  // 5. 视觉锚点：全文要有图或数据，且不能连续太多页没有
  const visuals = pages.filter(isVisual)
  if (visuals.length < rules.minVisualPages) {
    issues.push({
      code: 'design-no-visual',
      level: 'warn',
      where: '全文',
      message: `没有架构图也没有数据页（建议 ≥${rules.minVisualPages} 页）：答辩评委记的是图和数字，不是要点。` +
        `架构用 figure + 06-论文/assets/图/ 里的 PNG，结果用 stats。`,
    })
  }
  let run = 0
  for (const page of pages) {
    if (page.layout === 'cover' || page.layout === 'closing' || page.layout === 'agenda') continue
    if (isVisual(page)) {
      run = 0
      continue
    }
    run += 1
    if (run === 4) {
      issues.push({
        code: 'design-no-visual-run',
        level: 'warn',
        where: `第 ${page.index - 3}–${page.index} 页`,
        message: '连续 4 页只有文字：中间插一页图或数据，给观众一个喘气的锚点。',
      })
    }
  }

  return issues
}

/** 中文按字计、西文按 0.5 字计——幻灯上的长度用"视觉字数"衡量才准。 */
export function cjkLen(text: string): number {
  let total = 0
  for (const ch of text) total += /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.5
  return Math.round(total)
}
