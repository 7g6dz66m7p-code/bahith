/**
 * Builds eval/references/dataset.json: the fixed evaluation set for fabricated-reference
 * detection (`verifyReference` in packages/scholarly).
 *
 *   SCHOLARLY_CONTACT_EMAIL=bahith-dev@example.org NODE_USE_ENV_PROXY=1 \
 *     pnpm --filter @bahith/scholarly exec tsx ../../eval/references/build-dataset.ts [--from-sample]
 *
 * Steps
 * 1. Sample real journal articles from Crossref (`/works?sample=100&filter=type:journal-article`,
 *    plus Arabic-script articles found with `query.bibliographic` on common Arabic title words).
 *    Works without a title, a first author with a family name, an issued year or a journal
 *    name are dropped. The normalised pool is saved to crossref-sample.json; `--from-sample`
 *    re-derives the dataset from that snapshot instead of sampling again (Crossref sampling is
 *    random, so only the snapshot makes the real items reproducible).
 * 2. Derive, with the seeded PRNG below:
 *    - 100 real references (85 general + 15 Arabic-script when available);
 *    - 50 fabricated references: 25 with a DOI under a real registrant prefix and a random
 *      suffix, 25 title-only. Titles and authors are assembled from cross-domain word lists so
 *      that they describe no real study;
 *    - 25 mismatched references: a real DOI with another real work's title/authors/year.
 * 3. Ground-truth checks against Crossref (not against the detector): every fabricated DOI must
 *    answer 404, and no invented title may share ≥ 50% of its words (token Jaccard) or its
 *    normalised text with any of Crossref's top 5 bibliographic hits. A candidate that fails
 *    is redrawn; the counts are recorded in `buildChecks`.
 *
 * Re-running without `--from-sample` replaces the real items with a new random sample: commit
 * the result deliberately. Run Prettier on the two JSON files afterwards (lint-staged does).
 */
import { readFile, writeFile } from 'node:fs/promises';

import {
  createScholarlyClients,
  CROSSREF_LIST_POOL,
  isScholarlyError,
  loadScholarlyConfig,
  normalizeText,
  sanitizeUrl,
  tokenJaccard,
  type ScholarlyClients,
} from '../../packages/scholarly/src/index';
import {
  crossrefWorkSchema,
  normalizeCrossrefWork,
} from '../../packages/scholarly/src/providers/crossref';
import {
  DATASET_PATH,
  int,
  mulberry32,
  pick,
  SAMPLE_PATH,
  shuffle,
  writeLine,
  type Dataset,
  type DatasetAuthor,
  type DatasetInput,
  type DatasetItem,
  type PoolWork,
  type SampleSnapshot,
} from './lib';

/** Seed of every random choice made after sampling. Change it only to build a new dataset. */
export const SEED = 20_261_121;

const COUNTS = { realGeneral: 85, realArabic: 15, fakeDoi: 25, titleOnly: 25, mismatched: 25 };
/** Mismatched pairs drawn from Arabic-script works (when the Arabic pool is large enough). */
const ARABIC_MISMATCHED = 5;
const MAX_AUTHORS = 10;
const CROSSREF = 'https://api.crossref.org';
const SAMPLE_SELECT =
  'DOI,type,title,subtitle,container-title,issued,published,published-print,published-online,author';
const ARABIC_QUERY_WORDS = ['دراسة', 'أثر', 'تحليل', 'واقع'];
const ARABIC_SCRIPT = /[؀-ۿ]/u;
/** Invented titles are redrawn when a Crossref hit is this close (token Jaccard). */
const INVENTED_TITLE_MAX_JACCARD = 0.5;

const out = process.stdout;
const err = process.stderr;

// ---------------------------------------------------------------------------------------
// 1. Sampling

function toPoolWork(item: ReturnType<typeof normalizeCrossrefWork>['item']): PoolWork | undefined {
  const title = item.title?.trim();
  const container = item['container-title']?.trim();
  const year = item.issued?.['date-parts'][0][0];
  const doi = item.DOI;
  const authors: DatasetAuthor[] = [];
  for (const name of item.author ?? []) {
    if (name.family === undefined) continue;
    authors.push(
      name.given === undefined
        ? { family: name.family }
        : { family: name.family, given: name.given },
    );
    if (authors.length === MAX_AUTHORS) break;
  }
  const firstHasFamily = item.author?.[0]?.family !== undefined;
  if (
    title === undefined ||
    normalizeText(title) === '' ||
    container === undefined ||
    year === undefined ||
    doi === undefined ||
    !firstHasFamily ||
    authors.length === 0
  ) {
    return undefined;
  }
  return { doi, title, authors, year, container, arabic: ARABIC_SCRIPT.test(title) };
}

interface SampleStats {
  received: number;
  invalidPayload: number;
  incomplete: number;
}

async function sampleOnce(
  clients: ScholarlyClients,
  email: string,
  params: Record<string, string>,
  requests: string[],
  stats: SampleStats,
): Promise<PoolWork[]> {
  const url = new URL('/works', CROSSREF);
  url.searchParams.set('sample', '100');
  url.searchParams.set('filter', 'type:journal-article');
  url.searchParams.set('select', SAMPLE_SELECT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('mailto', email);
  const response = await clients.http.get({
    provider: 'crossref',
    url,
    rateLimitPool: CROSSREF_LIST_POOL,
    headers: { Accept: 'application/json', 'User-Agent': `BAHITH-eval (mailto:${email})` },
  });
  requests.push(sanitizeUrl(url));
  const body: unknown = JSON.parse(response.body);
  const items =
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'object' &&
    body.message !== null &&
    'items' in body.message &&
    Array.isArray(body.message.items)
      ? (body.message.items as unknown[])
      : undefined;
  if (items === undefined) throw new Error('Unexpected Crossref sample payload');
  const works: PoolWork[] = [];
  for (const raw of items) {
    stats.received += 1;
    const parsed = crossrefWorkSchema.safeParse(raw);
    if (!parsed.success) {
      stats.invalidPayload += 1;
      continue;
    }
    const work = toPoolWork(normalizeCrossrefWork(parsed.data, response).item);
    if (work === undefined) stats.incomplete += 1;
    else works.push(work);
  }
  return works;
}

async function sample(clients: ScholarlyClients, email: string): Promise<SampleSnapshot> {
  const requests: string[] = [];
  const stats: SampleStats = { received: 0, invalidPayload: 0, incomplete: 0 };
  const general = new Map<string, PoolWork>();
  const arabic = new Map<string, PoolWork>();
  const neededGeneral = COUNTS.realGeneral + 2 * COUNTS.mismatched + 10;
  for (let call = 0; call < 6 && general.size < neededGeneral; call += 1) {
    for (const work of await sampleOnce(clients, email, {}, requests, stats)) {
      if (!general.has(work.doi)) general.set(work.doi, work);
    }
    writeLine(err, `general sample ${call + 1}: ${general.size} usable works`);
  }
  // Every query word is sampled (not only until the pool is large enough) so that the
  // Arabic items are not all drawn from one word's result set.
  for (const word of ARABIC_QUERY_WORDS) {
    const works = await sampleOnce(
      clients,
      email,
      { 'query.bibliographic': word },
      requests,
      stats,
    );
    for (const work of works) {
      if (work.arabic && !general.has(work.doi) && !arabic.has(work.doi))
        arabic.set(work.doi, work);
    }
    writeLine(err, `arabic sample: ${arabic.size} usable Arabic-script works`);
  }
  writeLine(
    err,
    `received ${stats.received}, invalid payload ${stats.invalidPayload}, incomplete ${stats.incomplete}`,
  );
  const byDoi = (a: PoolWork, b: PoolWork): number => (a.doi < b.doi ? -1 : a.doi > b.doi ? 1 : 0);
  return {
    sampledAt: new Date().toISOString(),
    requests,
    general: [...general.values()].sort(byDoi),
    arabic: [...arabic.values()].sort(byDoi),
  };
}

// ---------------------------------------------------------------------------------------
// 2. Invented references. Every combination pairs vocabulary from unrelated fields, so the
// titles are well-formed but describe no study that exists.

const EN = {
  adjectives: [
    'Stochastic',
    'Recursive',
    'Thermodynamic',
    'Bayesian',
    'Ethnographic',
    'Nonlinear',
    'Topological',
    'Hermeneutic',
    'Photonic',
    'Spectral',
    'Postcolonial',
    'Mesoscale',
  ],
  phenomena: [
    'resonance',
    'drift',
    'entanglement',
    'attenuation',
    'polarization',
    'sedimentation',
    'reciprocity',
    'dormancy',
    'hysteresis',
    'fragmentation',
  ],
  things: [
    'lichen bioluminescence',
    'Ottoman tax registers',
    'tram timetable folklore',
    'cuttlefish chromatophores',
    'glacial meltwater sermons',
    'medieval bookbinding glue',
    'desert locust swarm ballads',
    'saffron futures contracts',
    'municipal pigeon censuses',
    'ceramic glaze microbiomes',
    'lullaby meter',
    'tidal mill ledgers',
  ],
  contexts: [
    'coastal Andalusian monasteries',
    'post-industrial sourdough bakeries',
    'Antarctic research station kitchens',
    'rural telegraph offices',
    'Baltic amber workshops',
    'Saharan caravan inns',
    'high-altitude beekeeping cooperatives',
    'nineteenth-century lighthouse logs',
  ],
  methods: [
    'graph neural surrogates',
    'wavelet ethnography',
    'Monte Carlo hermeneutics',
    'participatory spectroscopy',
    'agent-based philology',
    'isotopic discourse analysis',
  ],
  subtitles: [
    'a mixed-methods appraisal',
    'evidence from a longitudinal cohort',
    'a quasi-experimental reassessment',
    'lessons from a multi-site pilot',
    'a preregistered replication',
    'a comparative field study',
  ],
  populations: [
    'retired lighthouse keepers',
    'amateur mycologists',
    'urban falconers',
    'itinerant clockmakers',
    'harbour pilots',
    'organ tuners',
  ],
  families: [
    'Whitcombe',
    'Okonkwo-Hale',
    'Marchetti',
    'Lindqvist',
    'Ferreira-Dunn',
    'Haverford',
    'Nakashima-Roe',
    'Albrecht',
    'Castellanos',
    'Prendergast',
    'Varga',
    'Oyelaran',
    'Thistlewood',
    'Kowalczyk',
    'Abernathy',
  ],
  givens: [
    'Imogen',
    'Tobias',
    'Priya',
    'Mateo',
    'Saoirse',
    'Henrik',
    'Amara',
    'Felix',
    'Ines',
    'Rowan',
    'Keiko',
    'Dmitri',
  ],
};

const AR = {
  subjects: [
    'التذبذب الكمومي',
    'أحبار المخطوطات الأندلسية',
    'هجرة الجراد الصحراوي',
    'ألوان الخزف الفاطمي',
    'إيقاع التهاليل الشعبية',
    'رطوبة الكهوف الجيرية',
    'أسعار الزعفران الآجلة',
    'تآكل الفسيفساء البحرية',
    'ذاكرة الحمام الزاجل',
    'ضوء الفطريات الليلية',
  ],
  objects: [
    'فقه المعاملات المصرفية',
    'جودة الخبز البلدي',
    'تصميم المنارات الساحلية',
    'تعليم الخط الكوفي',
    'أداء محطات الأرصاد القطبية',
    'نسج السجاد اليدوي',
    'صيانة الطواحين المائية',
    'تسعير تذاكر الترام',
  ],
  kinds: ['ميدانية', 'تجريبية', 'مقارنة', 'طولية', 'استكشافية'],
  populations: [
    'مربي النحل في المرتفعات',
    'صانعي الساعات المتجولين',
    'حراس المنارات المتقاعدين',
    'هواة علم الفطريات',
    'طلبة الخط العربي',
    'بحارة الصيد الساحلي',
  ],
  adjectives: ['احتمالي', 'طوبولوجي', 'تأويلي', 'حراري', 'شبكي'],
  contexts: [
    'الأديرة الأندلسية الساحلية',
    'مخابز المدن الصناعية',
    'قوافل الصحراء الكبرى',
    'ورش الكهرمان البلطيقي',
  ],
  families: [
    'الحدّاد',
    'العطّار',
    'القبّاني',
    'الشمّري',
    'الزيّات',
    'البنّاء',
    'الدبّاغ',
    'الورّاق',
    'السقّاف',
    'النحّاس',
  ],
  givens: ['ليلى', 'سامر', 'نور', 'حسام', 'ريم', 'طارق', 'هالة', 'يوسف', 'سلمى', 'مازن'],
};

/** Arabic preposition لـ attached to a noun phrase (لـ + ال → لل). */
const li = (phrase: string): string =>
  phrase.startsWith('ال') ? `لل${phrase.slice(2)}` : `ل${phrase}`;

function inventTitle(random: () => number, arabic: boolean): string {
  const pattern = int(random, 0, 2);
  if (arabic) {
    const subject = pick(random, AR.subjects);
    const object = pick(random, AR.objects);
    if (pattern === 0) {
      return `أثر ${subject} في ${object}: دراسة ${pick(random, AR.kinds)} على ${pick(random, AR.populations)}`;
    }
    if (pattern === 1)
      return `قياس ${subject} وعلاقته ب${object} لدى ${pick(random, AR.populations)}`;
    return `نحو نموذج ${pick(random, AR.adjectives)} ${li(subject)} في ${pick(random, AR.contexts)}`;
  }
  const thing = pick(random, EN.things);
  if (pattern === 0) {
    return `${pick(random, EN.adjectives)} ${pick(random, EN.phenomena)} of ${thing} in ${pick(random, EN.contexts)}`;
  }
  if (pattern === 1) {
    return `Modelling ${thing} with ${pick(random, EN.methods)}: ${pick(random, EN.subtitles)}`;
  }
  return `Toward a ${pick(random, EN.adjectives).toLowerCase()} theory of ${thing} among ${pick(random, EN.populations)}`;
}

function inventAuthors(random: () => number, arabic: boolean): DatasetAuthor[] {
  const names = arabic ? AR : EN;
  const count = int(random, 1, 4);
  const families = shuffle(random, names.families).slice(0, count);
  return families.map((family) => ({ family, given: pick(random, names.givens) }));
}

function lettersAndDigits(random: () => number): string {
  const letters = Array.from({ length: 4 }, () =>
    String.fromCharCode(97 + int(random, 0, 25)),
  ).join('');
  const digits = String(int(random, 100_000, 999_999));
  return `${letters}.${digits}`;
}

// ---------------------------------------------------------------------------------------
// 3. Ground-truth checks (Crossref, independent of the detector's decision rules)

async function doiIsUnregistered(clients: ScholarlyClients, doi: string): Promise<boolean> {
  try {
    await clients.crossref.getWork(doi);
    return false;
  } catch (error) {
    if (isScholarlyError(error, 'SCHOLARLY_NOT_FOUND')) return true;
    throw error;
  }
}

async function titleIsUnknown(clients: ScholarlyClients, title: string): Promise<boolean> {
  const result = await clients.crossref.searchWorks(title, { rows: 5 });
  const target = normalizeText(title);
  return result.records.every((record) => {
    const other = record.item.title;
    if (other === undefined) return true;
    return (
      normalizeText(other) !== target && tokenJaccard(title, other) < INVENTED_TITLE_MAX_JACCARD
    );
  });
}

// ---------------------------------------------------------------------------------------
// Derivation

function inputOf(work: PoolWork, doi?: string): DatasetInput {
  const input: DatasetInput = {
    title: work.title,
    authors: work.authors,
    year: work.year,
    container: work.container,
  };
  if (doi !== undefined) input.doi = doi;
  return input;
}

function doiVariant(random: () => number, doi: string): { doi: string; form: string } {
  const r = random();
  if (r < 0.2) return { doi: `https://doi.org/${doi}`, form: 'https://doi.org/ URL' };
  if (r < 0.3) return { doi: `doi:${doi}`, form: '"doi:" prefix' };
  if (r < 0.4) return { doi: doi.toUpperCase(), form: 'upper case' };
  return { doi, form: 'bare' };
}

async function derive(
  clients: ScholarlyClients,
  snapshot: SampleSnapshot,
): Promise<Pick<Dataset, 'items' | 'buildChecks'>> {
  const random = mulberry32(SEED);
  const general = shuffle(random, snapshot.general);
  const arabic = shuffle(random, snapshot.arabic);
  const arabicReal = Math.min(COUNTS.realArabic, arabic.length);
  const arabicPairs = arabic.length - arabicReal >= 2 * ARABIC_MISMATCHED ? ARABIC_MISMATCHED : 0;
  const generalReal = COUNTS.realGeneral + COUNTS.realArabic - arabicReal;
  const realWorks = [...general.slice(0, generalReal), ...arabic.slice(0, arabicReal)];
  const generalPairs = COUNTS.mismatched - arabicPairs;
  if (general.length < generalReal + 2 * generalPairs) {
    throw new Error(`Crossref pool too small: ${general.length} general works`);
  }
  const checks = {
    sampledGeneral: snapshot.general.length,
    sampledArabic: snapshot.arabic.length,
    realArabicScript: arabicReal,
    fakeDoiRegisteredRedrawn: 0,
    inventedTitleTooCloseRedrawn: 0,
    mismatchPairsSkipped: 0,
  };
  const items: DatasetItem[] = [];
  const pad = (n: number, width = 3): string => String(n).padStart(width, '0');

  realWorks.forEach((work, i) => {
    const variant = doiVariant(random, work.doi);
    items.push({
      id: `real-${pad(i + 1)}`,
      kind: 'real',
      input: inputOf(work, variant.doi),
      expected: 'verified',
      accepted: ['verified'],
      source: `Crossref /works?sample (${work.arabic ? 'Arabic-word query' : 'type:journal-article'}) on ${snapshot.sampledAt.slice(0, 10)}; metadata as registered; DOI given as ${variant.form}`,
    });
  });

  // Fabricated references. Each candidate is checked; a failing one is redrawn.
  const usedTitles = new Set<string>();
  const newTitle = async (isArabic: boolean): Promise<string> => {
    for (;;) {
      const title = inventTitle(random, isArabic);
      const key = normalizeText(title);
      if (usedTitles.has(key)) continue;
      usedTitles.add(key);
      if (await titleIsUnknown(clients, title)) return title;
      checks.inventedTitleTooCloseRedrawn += 1;
    }
  };
  // Two in five fabricated references are Arabic.
  const isArabicAt = (i: number): boolean => i % 5 === 1 || i % 5 === 3;

  // Prefixes and journal names are borrowed from a real work in the same script as the title.
  const sameScript = (arabicItem: boolean): PoolWork[] =>
    realWorks.filter((work) => work.arabic === arabicItem);

  for (let i = 0; i < COUNTS.fakeDoi; i += 1) {
    const arabicItem = isArabicAt(i);
    const owner = pick(random, sameScript(arabicItem));
    const prefix = owner.doi.split('/')[0] ?? '10.1000';
    const year = int(random, 1998, 2024);
    let doi = '';
    for (;;) {
      doi = `${prefix}/${lettersAndDigits(random)}`;
      if (await doiIsUnregistered(clients, doi)) break;
      checks.fakeDoiRegisteredRedrawn += 1;
    }
    items.push({
      id: `fab-doi-${pad(i + 1, 2)}`,
      kind: 'fabricated',
      input: {
        doi,
        title: await newTitle(arabicItem),
        authors: inventAuthors(random, arabicItem),
        year,
        container: owner.container,
      },
      expected: 'not_found',
      accepted: ['not_found', 'mismatch'],
      source: `invented (seed ${SEED}): real registrant prefix ${prefix} + random suffix, Crossref 404 confirmed at build; journal name borrowed from a real work with that prefix; title/authors from word lists`,
    });
    writeLine(err, `fabricated DOI ${i + 1}/${COUNTS.fakeDoi}`);
  }

  for (let i = 0; i < COUNTS.titleOnly; i += 1) {
    const arabicItem = isArabicAt(i);
    const input: DatasetInput = {
      title: await newTitle(arabicItem),
      authors: inventAuthors(random, arabicItem),
      year: int(random, 1998, 2024),
    };
    if (random() < 0.5) input.container = pick(random, sameScript(arabicItem)).container;
    items.push({
      id: `fab-title-${pad(i + 1, 2)}`,
      kind: 'fabricated',
      input,
      expected: 'not_found',
      accepted: ['not_found', 'mismatch'],
      source: `invented (seed ${SEED}): title-only, no DOI; title/authors from word lists, no close Crossref hit at build${input.container === undefined ? '' : '; journal name borrowed from a real work'}`,
    });
    writeLine(err, `fabricated title ${i + 1}/${COUNTS.titleOnly}`);
  }

  // Mismatched: owner i keeps its DOI; donor i supplies title/authors/year/journal.
  const pairPools: [PoolWork[], number][] = [
    [general.slice(generalReal), generalPairs],
    [arabic.slice(arabicReal), arabicPairs],
  ];
  let pairIndex = 0;
  for (const [pool, wanted] of pairPools) {
    const owners = pool.slice(0, Math.floor(pool.length / 2));
    const donors = pool.slice(Math.floor(pool.length / 2));
    let made = 0;
    for (let i = 0; i < owners.length && i < donors.length && made < wanted; i += 1) {
      const owner = owners[i] as PoolWork;
      const donor = donors[i] as PoolWork;
      const sameTitle = normalizeText(owner.title) === normalizeText(donor.title);
      const sameFirstAuthor =
        normalizeText(owner.authors[0]?.family ?? '') ===
        normalizeText(donor.authors[0]?.family ?? '');
      if (sameTitle || sameFirstAuthor) {
        checks.mismatchPairsSkipped += 1;
        continue;
      }
      made += 1;
      pairIndex += 1;
      items.push({
        id: `mis-${pad(pairIndex, 2)}`,
        kind: 'mismatched',
        input: inputOf(donor, owner.doi),
        expected: 'mismatch',
        accepted: ['mismatch'],
        source: `real DOI of one sampled Crossref work (${owner.arabic ? 'Arabic' : 'general'} pool) with the title/authors/year/journal of another (${donor.doi})`,
      });
    }
    if (made < wanted) throw new Error(`Only ${made} of ${wanted} mismatched pairs could be built`);
  }
  return { items, buildChecks: checks };
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const config = loadScholarlyConfig(process.env);
  const email = config.contactEmail;
  if (email === undefined) {
    writeLine(err, 'SCHOLARLY_CONTACT_EMAIL is required (e.g. bahith-dev@example.org).');
    return 2;
  }
  // Sample responses are large; allow more time per attempt than the 10 s default.
  const clients = createScholarlyClients(config, { timeoutMs: 60_000 });
  let snapshot: SampleSnapshot;
  if (process.argv.includes('--from-sample')) {
    snapshot = JSON.parse(await readFile(SAMPLE_PATH, 'utf8')) as SampleSnapshot;
    writeLine(err, `using saved sample from ${snapshot.sampledAt}`);
  } else {
    snapshot = await sample(clients, email);
    await writeFile(SAMPLE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  const { items, buildChecks } = await derive(clients, snapshot);
  const counts = { real: 0, fabricated: 0, mismatched: 0 };
  for (const item of items) counts[item.kind] += 1;
  const dataset: Dataset = {
    schemaVersion: 1,
    name: 'BAHITH fabricated-reference detection set',
    generatedAt: new Date().toISOString(),
    generator: 'eval/references/build-dataset.ts',
    seed: SEED,
    note: `Real items were sampled at random from the Crossref REST API on ${snapshot.sampledAt.slice(0, 10)} and carry their registered metadata unchanged. Fabricated items are invented on purpose and must be rejected; they are not real references. Mismatched items pair a real DOI with another real work's metadata.`,
    crossref: {
      endpoint: `${CROSSREF}/works?sample=100`,
      sampledAt: snapshot.sampledAt,
      requests: snapshot.requests,
    },
    expectations: {
      real: 'verified',
      fabricated:
        'not_found (mismatch also counts as rejected: the reference as written does not exist)',
      mismatched: 'mismatch',
    },
    buildChecks,
    counts,
    items,
  };
  await writeFile(DATASET_PATH, `${JSON.stringify(dataset, null, 2)}\n`);
  writeLine(out, `wrote ${DATASET_PATH}: ${JSON.stringify(counts)} ${JSON.stringify(buildChecks)}`);
  return 0;
}

process.exitCode = await main();
