import JSZip from 'jszip';

export interface DocxParts {
  zip: JSZip;
  document: string;
  documentBytes: Uint8Array;
  footnotes: string;
  styles: string;
  settings: string;
  /** Contents of every `word/footer*.xml`. */
  footers: string[];
}

/** Opens a .docx with JSZip (an implementation independent of the writer's fflate). */
export async function openDocx(bytes: Uint8Array): Promise<DocxParts> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
  const footerNames = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/u.test(name));
  return {
    zip,
    document: await read('word/document.xml'),
    documentBytes: (await zip.file('word/document.xml')?.async('uint8array')) ?? new Uint8Array(),
    footnotes: await read('word/footnotes.xml'),
    styles: await read('word/styles.xml'),
    settings: await read('word/settings.xml'),
    footers: await Promise.all(footerNames.map(read)),
  };
}

/** Top-level `<w:p>` elements (paragraphs do not nest in WordprocessingML). */
export function paragraphs(xml: string): string[] {
  return xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu) ?? [];
}

/** The single paragraph containing `text`; throws if there is not exactly one. */
export function paragraphWith(xml: string, text: string): string {
  const found = paragraphs(xml).filter((p) => p.includes(text));
  if (found.length !== 1)
    throw new Error(`expected one paragraph with the text, found ${found.length}`);
  return found[0] ?? '';
}

/** `<w:r>` runs of a paragraph. */
export function runs(paragraphXml: string): string[] {
  return paragraphXml.match(/<w:r>[\s\S]*?<\/w:r>/gu) ?? [];
}

export function count(haystack: string, needle: string | RegExp): number {
  if (typeof needle === 'string') return haystack.split(needle).length - 1;
  return (haystack.match(new RegExp(needle.source, `${needle.flags.replace('g', '')}g`)) ?? [])
    .length;
}
