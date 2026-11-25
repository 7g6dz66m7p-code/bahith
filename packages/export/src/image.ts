import type { ImageBlock } from './model';

export type RasterType = 'png' | 'jpg' | 'gif' | 'bmp';

const RASTER_TYPES: Record<string, RasterType> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/** Image types HTML/PDF embed as data URIs (no SVG: it can carry script and links). */
const HTML_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

export function rasterType(mime: string): RasterType | undefined {
  return RASTER_TYPES[mime];
}

export function isHtmlEmbeddable(mime: string): boolean {
  return HTML_TYPES.has(mime);
}

export interface Size {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);
const i32le = (b: Uint8Array, i: number) => u16le(b, i) | (u16le(b, i + 2) << 16) | 0;

/** Reads pixel dimensions from PNG, JPEG, GIF or BMP headers; `undefined` if unknown. */
export function sniffSize(bytes: Uint8Array): Size | undefined {
  // PNG: signature, then IHDR width/height (big-endian).
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return positive({ width: u32be(bytes, 16), height: u32be(bytes, 20) });
  }
  // GIF: logical screen size (little-endian).
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return positive({ width: u16le(bytes, 6), height: u16le(bytes, 8) });
  }
  // BMP: BITMAPINFOHEADER width/height (height may be negative for top-down).
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return positive({ width: i32le(bytes, 18), height: Math.abs(i32le(bytes, 22)) });
  }
  // JPEG: walk segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16be(bytes, i + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return positive({ width: u16be(bytes, i + 7), height: u16be(bytes, i + 5) });
      i += 2 + length;
    }
  }
  return undefined;
}

function positive(size: Size): Size | undefined {
  return size.width > 0 && size.height > 0 ? size : undefined;
}

/** Explicit size from the block, else the sniffed one, scaled down to fit `maxWidth`. */
export function displaySize(block: ImageBlock, maxWidth: number): Size | undefined {
  const sniffed = sniffSize(block.data);
  const width = block.widthPx ?? sniffed?.width;
  const height =
    block.heightPx ??
    (sniffed !== undefined && width !== undefined
      ? Math.round((sniffed.height * width) / sniffed.width)
      : undefined);
  if (width === undefined || height === undefined) return undefined;
  if (width <= maxWidth) return { width, height };
  return { width: Math.round(maxWidth), height: Math.round((height * maxWidth) / width) };
}

export function toDataUri(block: ImageBlock): string {
  return `data:${block.mime};base64,${Buffer.from(block.data).toString('base64')}`;
}
