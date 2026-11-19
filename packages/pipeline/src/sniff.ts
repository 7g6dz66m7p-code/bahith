/**
 * Detects the real type of uploaded bytes from their signature. The browser-declared
 * type and the file extension are not trusted.
 */
export type SniffedType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain'
  | 'image/png'
  | 'image/jpeg'
  | 'image/tiff';

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A DOCX is a ZIP whose central directory names `word/document.xml`. */
function looksLikeDocx(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return false;
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 65_536 * 4)));
  return tail.includes('word/document.xml') && tail.includes('[Content_Types].xml');
}

export function sniffMimeType(bytes: Uint8Array): SniffedType | null {
  if (bytes.byteLength === 0) return null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff';
  if (looksLikeDocx(bytes)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (isUtf8Text(bytes)) return 'text/plain';
  return null;
}
