import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Fontsource packages whose Arabic + Latin faces are inlined into HTML/PDF. */
export const DEFAULT_FONT_PACKAGES = [
  '@fontsource/noto-naskh-arabic',
  '@fontsource/ibm-plex-sans-arabic',
] as const;

const WEIGHTS = [400, 700] as const;

export interface EmbeddedFonts {
  /** `@font-face` rules with woff2 data URIs; empty when nothing was found. */
  css: string;
  /** Family names that were embedded, in priority order. */
  families: string[];
  /** Packages that could not be resolved or read. */
  missing: string[];
}

const cache = new Map<string, { css: string; family: string } | null>();

function loadPackage(name: string): { css: string; family: string } | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let loaded: { css: string; family: string } | null = null;
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve(`${name}/package.json`));
    let family = '';
    const rules: string[] = [];
    for (const weight of WEIGHTS) {
      const source = readFileSync(join(root, `${weight}.css`), 'utf8');
      for (const block of source.match(/@font-face\s*\{[^}]*\}/gu) ?? []) {
        const file = /url\(\.\/files\/([\w.-]+\.woff2)\)/u.exec(block)?.[1];
        const fam = /font-family:\s*'([^']+)'/u.exec(block)?.[1];
        const range = /unicode-range:\s*([^;]+);/u.exec(block)?.[1];
        if (file === undefined || fam === undefined) continue;
        family = fam;
        const data = readFileSync(join(root, 'files', file)).toString('base64');
        rules.push(
          `@font-face{font-family:'${fam}';font-style:normal;font-weight:${weight};font-display:block;` +
            `src:url(data:font/woff2;base64,${data}) format('woff2');` +
            (range === undefined ? '' : `unicode-range:${range};`) +
            '}',
        );
      }
    }
    if (rules.length > 0 && family.length > 0) loaded = { css: rules.join('\n'), family };
  } catch {
    loaded = null;
  }
  cache.set(name, loaded);
  return loaded;
}

/**
 * Reads the woff2 files shipped by the fontsource packages and inlines them as base64
 * so the HTML is self-contained (the PDF renderer has no network access).
 */
export function loadEmbeddedFonts(
  packages: readonly string[] = DEFAULT_FONT_PACKAGES,
): EmbeddedFonts {
  const result: EmbeddedFonts = { css: '', families: [], missing: [] };
  const css: string[] = [];
  for (const name of packages) {
    const loaded = loadPackage(name);
    if (loaded === null) {
      result.missing.push(name);
      continue;
    }
    css.push(loaded.css);
    result.families.push(loaded.family);
  }
  result.css = css.join('\n');
  return result;
}
