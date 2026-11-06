/**
 * 图片头部解析：只为拿到像素宽高，好让 Word 里的图按原比例排版、且不超出栏宽。
 *
 * 不引入图像库：论文插图只有 PNG（draw.io 导出、系统截图）与 JPEG（照片/手机截图），
 * 两种格式的尺寸都在文件头前几十字节里，读几十个字节即可。解析不出来时返回 undefined，
 * 调用方按「未知尺寸」降级（用默认宽度），绝不猜一个尺寸然后把图拉变形。
 *
 * @module dsh-thesis/paper/image
 */

/** 识别出的图片格式与像素尺寸。 */
export interface ImageInfo {
  readonly format: 'png' | 'jpeg'
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/** 读 PNG 的 IHDR（宽高就在 16..23 字节）。 */
function pngInfo(bytes: Uint8Array): ImageInfo | undefined {
  const width = readU32BE(bytes, 16)
  const height = readU32BE(bytes, 20)
  if (width <= 0 || height <= 0) return undefined
  return { format: 'png', width, height }
}

/** 扫描 JPEG 的 SOFn 段拿宽高。 */
function jpegInfo(bytes: Uint8Array): ImageInfo | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    // 填充字节 0xFF 与无载荷标记（RSTn / SOI / EOI）直接跳过。
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = readU16BE(bytes, offset + 2)
    if (length < 2) return undefined
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = readU16BE(bytes, offset + 5)
      const width = readU16BE(bytes, offset + 7)
      if (width <= 0 || height <= 0) return undefined
      return { format: 'jpeg', width, height }
    }
    offset += 2 + length
  }
  return undefined
}

/** 解析图片宽高；不认识或数据不完整时返回 undefined。 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (isPng(bytes)) return pngInfo(bytes)
  if (isJpeg(bytes)) return jpegInfo(bytes)
  return undefined
}

/** 从文件名推断格式（用于 Word 的 content-type）；不认识返回 undefined。 */
export function imageFormatOf(path: string): 'png' | 'jpeg' | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpeg'
  return undefined
}
