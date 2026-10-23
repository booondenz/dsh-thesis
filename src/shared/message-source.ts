/**
 * 注入消息的 source 约定。
 *
 * 宿主从 v4 会话格式起要求消息 source 是**生产者自有的 kind**：共享兜底值
 * `plugin` 会被直接拒写，错误是 `format v4 message requires a producer-owned
 * source kind`，而且发生在写会话日志时——整条会话都起不来。2.0.1 发布后真踩过。
 *
 * 第三方插件的规范形态是 `plugin:<包名>`：宿主的 v3→v4 迁移器给未知生产者生成的
 * 就是这个值（`@deepseek-ai/dsh-session-format-v3-to-v4` 里的 `producerKind`），
 * 因此旧会话迁移后与新消息同源同 kind，前端不会把同一类上下文认成两种东西。
 *
 * @module dsh-thesis/shared/message-source
 */

/** 插件标识（与 package.json 的 name 一致）。 */
export const PLUGIN_ID = 'dsh-thesis'

/** 生产者自有 kind。**不要改回 `plugin`**，否则 v4 会话写不进去。 */
export const THESIS_SOURCE_KIND = `plugin:${PLUGIN_ID}`

/** 注入消息 source 的基础形状（`form`/`sections` 由调用方补充）。 */
export const THESIS_SOURCE = { kind: THESIS_SOURCE_KIND } as const
