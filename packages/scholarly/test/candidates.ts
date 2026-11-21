import { bibliographicQuery, type ReferenceCandidate } from '../src/verify';

/**
 * Reference candidates shared by the fixture recorder, the unit tests and the live tests.
 * `fabricatedDoi` and `fabricatedTitle` are invented on purpose: they are the inputs the
 * detector must reject, never data presented as real.
 */
const real = {
  doi: '10.1038/nature14539',
  title: 'Deep learning',
  authors: ['LeCun, Yann', 'Bengio, Yoshua', 'Hinton, Geoffrey'],
  year: 2015,
  container: 'Nature',
} satisfies ReferenceCandidate;

const wrongTitle = {
  doi: '10.1038/nature14539',
  title: 'Convolutional networks for biomedical image segmentation',
  authors: ['LeCun, Yann'],
  year: 2015,
} satisfies ReferenceCandidate;

const fabricatedDoi = { doi: '10.9999/fake.2024.12345' } satisfies ReferenceCandidate;

const realTitleOnly = {
  title: 'Deep learning',
  authors: ['LeCun, Yann'],
  year: 2015,
  container: 'Nature',
} satisfies ReferenceCandidate;

const fabricatedTitle = {
  title: 'الأثر الكمومي لأحبار المخطوطات الأندلسية في خوارزميات التعلم العميق',
  authors: ['حدّاد، ليلى'],
  year: 2021,
} satisfies ReferenceCandidate;

export const CANDIDATES = {
  real,
  wrongTitle,
  fabricatedDoi,
  realTitleOnly,
  fabricatedTitle,
  realTitleOnlyQuery: bibliographicQuery(realTitleOnly),
  fabricatedTitleQuery: bibliographicQuery(fabricatedTitle),
};
