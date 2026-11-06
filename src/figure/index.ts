/**
 * 插图装配层：注册 `thesis_figure` 工具（create / export / check / guide）。
 *
 * 与其它模块一样，业务逻辑在 `figure/actions.ts` 与 `figure/lib/*.ts`（零 cordis 依赖，
 * 可独立单测），本文件只做 `defineTool` 胶水。
 *
 * @module dsh-thesis/figure
 */

import type { Context } from '@deepseek-ai/cordis'
import { definePaperTool, sessionCwd, textOutput } from '../shared/index.ts'
import { FIGURE_TOOL_DESCRIPTION, runFigureAction, type FigureArgs, type FigureOptions } from './actions.ts'

export { FIGURE_DIR, FIGURE_NOTES, FIGURE_INVENTORY, FIGURE_TOOL_DESCRIPTION, runFigureAction, slugify, resolveChapter, nextFigureIndex, extractReferences } from './actions.ts'
export type { FigureArgs, FigureOptions, FigureDeps } from './actions.ts'
export { parseFigureModel, describeModel, FigureSpecError, FIGURE_KINDS } from './lib/spec.ts'
export type { FigureKind, FigureModel } from './lib/spec.ts'
export { buildDrawing, LAYOUT, displayWidth, FigureLayoutError } from './lib/layout.ts'
export type { FigureDrawing } from './lib/layout.ts'
export { renderMxfile, validateMxfile, STYLE, escapeXmlAttr, labelValue, DEFAULT_PAGE_WIDTH, DEFAULT_PAGE_HEIGHT } from './lib/drawio.ts'
export type { FigureCell, MxFileOptions, Rect, Point } from './lib/drawio.ts'
export { detectDrawio, exportDiagram, renderExportNotes, drawioGuide, DEFAULT_SCALE, EXPORT_TIMEOUT_MS } from './lib/export.ts'
export type { DrawioDetection, DrawioEngine, ExportOutcome, ExportNotesInput } from './lib/export.ts'
export { checkFigures, renderFigureReport, parseCaption, stemOf, CAPTION_PATTERN } from './lib/check.ts'
export type { FigureCheckInput, FigureCheckResult, FigureReference, FigureIssue, FigureFileEntry } from './lib/check.ts'

/** 注册 `thesis_figure` 工具。 */
export function registerFigure(ctx: Context, options: FigureOptions): void {
  ctx.tools.register(definePaperTool({
    name: 'thesis_figure',
    description: FIGURE_TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, description: 'create（生成 .drawio + 导出 PNG）| export（把已有 .drawio 批量导出）| check（图表清单与一致性检查）| guide（安装与手工导出指引）' },
      kind: { type: 'string', description: 'create 时必填：architecture（分层架构图）| flow（流程图）| er（数据库 E-R 图）| sequence（时序图）| custom（直接贴 mxfile XML）' },
      name: { type: 'string', description: '文件名主干（缺省取 title），如 arch-overview；落在 06-论文/assets/图/<name>.drawio' },
      title: { type: 'string', description: '图名，用于 draw.io 页签与图题，如「系统总体架构图」' },
      chapter: { type: 'string', description: '写在哪一章（如 04-系统设计 或章号 4）：据此按该章已有图号自动编号出「图 4-1 …」' },
      caption: { type: 'string', description: '直接指定完整图题（形如「图 4-1 系统总体架构图」）；给了就不再用 chapter 自动编号' },
      spec: { type: 'object', additionalProperties: true, description: '结构：architecture={layers:[{name,modules}],edges?}｜flow={nodes,edges}｜er={entities,relations?}｜sequence={participants,messages}｜custom={xml}' },
      export: { type: 'boolean', description: 'create 时是否立即导出 PNG，默认 true（本机没有 draw.io 时只提示、不失败）' },
      force: { type: 'boolean', description: 'create 时覆盖同名 .drawio，默认 false（覆盖前把旧文件另存为 <名字>-<时间戳>.drawio）' },
      format: { type: 'string', description: '导出格式：png（默认，论文用）| svg（幻灯/网页用）' },
      scale: { type: 'number', description: '导出倍率，默认 3（约 370dpi）' },
    },
    output: textOutput(),
    async execute(rawArgs, exec): Promise<string> {
      return await runFigureAction(ctx.fs, sessionCwd(exec), rawArgs as unknown as FigureArgs, options, exec.signal)
    },
  }))
}
