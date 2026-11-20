/** Identifier parsing and validation (DOI, ORCID iD, arXiv id, PMID). */

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/u;
const DOI_PREFIXES = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu;

/**
 * Canonical DOI (lower case, no resolver prefix) or undefined when the input is not
 * a syntactically valid DOI. DOIs are case-insensitive, so lower case is canonical.
 */
export function normalizeDoi(value: string): string | undefined {
  const doi = value.trim().replace(DOI_PREFIXES, '').trim().toLowerCase();
  return DOI_PATTERN.test(doi) && doi.length <= 300 ? doi : undefined;
}

/** ORCID check digit, ISO 7064 MOD 11-2, over the first 15 digits. */
export function orcidCheckDigit(baseDigits: string): string {
  let total = 0;
  for (const char of baseDigits) {
    total = (total + Number(char)) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? 'X' : String(result);
}

/**
 * Canonical ORCID iD (`0000-0002-1825-0097`) or undefined if the format or the
 * ISO 7064 11,2 checksum is wrong. Accepts the https://orcid.org/ form.
 */
export function normalizeOrcid(value: string): string | undefined {
  const bare = value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?orcid\.org\//iu, '')
    .replace(/-/gu, '')
    .toUpperCase();
  if (!/^\d{15}[\dX]$/u.test(bare)) return undefined;
  if (orcidCheckDigit(bare.slice(0, 15)) !== bare.slice(15)) return undefined;
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}-${bare.slice(12)}`;
}

export function isValidOrcid(value: string): boolean {
  return normalizeOrcid(value) !== undefined;
}

const ARXIV_NEW = /^\d{4}\.\d{4,5}(?:v\d+)?$/u;
const ARXIV_OLD = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/u;

/** arXiv identifier (new `2401.01234v2` or old `hep-th/9901001` style) or undefined. */
export function normalizeArxivId(value: string): string | undefined {
  const id = value
    .trim()
    .replace(/^(?:arxiv:|https?:\/\/arxiv\.org\/abs\/)/iu, '')
    .trim();
  return ARXIV_NEW.test(id) || ARXIV_OLD.test(id) ? id : undefined;
}

export function normalizePmid(value: string): string | undefined {
  const id = value.trim();
  return /^[1-9]\d{0,9}$/u.test(id) ? id : undefined;
}
