# تقييم كشف المراجع المختلقة — `eval/references`

مجموعة بيانات ثابتة وسكربت تشغيل يقيسان دالة `verifyReference` من الحزمة `@bahith/scholarly` (`packages/scholarly/src/verify.ts`) على مراجع حقيقية ومختلقة ومتناقضة، مقابل معيار القبول: **«100 DOI حقيقي يُؤكَّد، و50 مرجعاً مختلقاً يُرفض بنسبة 100%»**.

## المجموعة (`dataset.json`)

| النوع        | العدد | كيف بُني                                                                                                                                                                                                                                                                                   | النتيجة المتوقعة                                                       |
| ------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `real`       | 100   | عيّنة عشوائية من Crossref (`/works?sample=100&filter=type:journal-article`)، منها 15 بعنوان عربي (عيّنات `query.bibliographic` على كلمات «دراسة، أثر، تحليل، واقع»). البيانات كما سُجّلت (عنوان، مؤلفون، سنة، مجلة)، والـDOI مكتوب بصيغ مختلفة (مجرد، `https://doi.org/`، `doi:`، أحرف كبيرة) | `verified` فقط                                                         |
| `fabricated` | 50    | 25 بـDOI غير مسجّل تحت بادئة ناشر حقيقية + لاحقة عشوائية، و25 بعنوان فقط بلا DOI. العناوين والمؤلفون مركّبة من قوائم كلمات من حقول متباعدة (40% منها بالعربية)                                                                                                                              | `not_found`؛ ويُقبل `mismatch` أيضاً لأنه رفض (المرجع كما كُتب غير موجود) |
| `mismatched` | 25    | DOI حقيقي مع عنوان ومؤلفي وسنة ومجلة عمل حقيقي آخر (منها 5 أزواج عربية)                                                                                                                                                                                                                   | `mismatch` فقط                                                         |

`unverifiable` (تعذّر سؤال المزوّد) **لا يُحتسب نجاحاً أبداً** لأي نوع.

**تحققات الحقيقة الأرضية عند البناء** (مستقلة عن قواعد قرار الكاشف): كل DOI مختلق يجب أن يُرجع Crossref له 404، وكل عنوان مختلق يُعاد سحبه إن طابق نصاً مطبّعاً أو شارك ≥ 50% من كلماته (Jaccard) أيّاً من أول 5 نتائج بحث في Crossref. عدد مرات إعادة السحب مسجّل في `buildChecks`.

**قابلية التكرار:** كل الاختيارات بعد أخذ العيّنة تأتي من مولّد عشوائي ببذرة ثابتة (`SEED` في `build-dataset.ts`، وهي في رأس الملف). عيّنة Crossref نفسها عشوائية، لذلك تُحفظ كما هي في `crossref-sample.json`، و`--from-sample` يعيد اشتقاق المجموعة منها. التقييم ثابت لأن `dataset.json` مُلتزَم في المستودع.

## التشغيل

يحتاج شبكة إلى `api.crossref.org` و`api.openalex.org`، وبريد تواصل (عنوان العنصر النائب يكفي). في بيئة الصندوق يحتاج Node 22 إلى `NODE_USE_ENV_PROXY=1` ليمر عبر الوكيل.

```bash
# التقييم (حيّ دائماً، بلا تخزين مؤقت؛ نحو 10 دقائق)
SCHOLARLY_CONTACT_EMAIL=bahith-dev@example.org NODE_USE_ENV_PROXY=1 \
  pnpm --filter @bahith/eval exec tsx references/run.ts

# تشخيص: إعداد Crossref وحده (بلا OpenAlex)، يُوسم كذلك في كل المخرجات
SCHOLARLY_CONTACT_EMAIL=bahith-dev@example.org NODE_USE_ENV_PROXY=1 \
  pnpm --filter @bahith/eval exec tsx references/run.ts --crossref-only

# إعادة بناء المجموعة (يستبدل العيّنة الحقيقية!) أو إعادة اشتقاقها من العيّنة المحفوظة
SCHOLARLY_CONTACT_EMAIL=bahith-dev@example.org NODE_USE_ENV_PROXY=1 \
  pnpm --filter @bahith/eval exec tsx references/build-dataset.ts [--from-sample]
pnpm exec prettier --write eval/references/*.json
```

`OPENALEX_API_KEY` اختياري لكنه موصى به بشدة: ميزانية بحث OpenAlex المجانية اليومية بلا مفتاح تنفد سريعاً (والبحث بالـDOI مجاني)، وحينها يصبح كل مرجع بلا DOI `unverifiable` ويفشل التقييم.

يكتب السكربت `results/latest.json` و`results/latest.md` (غير مُلتزَمين)، ويطبع الملخص، ويخرج بـ`0` إن تحققت كل الأهداف، و`1` إن فات أي هدف، و`2` لخطأ في الإعداد. سجلات تشغيلات بعينها محفوظة بتاريخها في `results/`.

### الأهداف (كلها شرط للنجاح)

| المقياس                                             | الهدف |
| --------------------------------------------------- | ----- |
| المراجع الحقيقية `verified`                         | 100%  |
| المراجع المختلقة مرفوضة (`not_found` أو `mismatch`) | 100%  |
| قبول خاطئ (مختلق أو متناقض صار `verified`)          | 0     |
| المراجع المتناقضة `mismatch`                        | 100%  |
| عناصر `unverifiable` أو أخطاء                       | 0     |

## آخر النتائج (تشغيل حيّ، 2026-11-22)

| الإعداد                                   | حقيقي `verified` | مختلق مرفوض | قبول خاطئ | متناقض `mismatch` | `unverifiable` | الأهداف      |
| ----------------------------------------- | ---------------- | ----------- | --------- | ----------------- | -------------- | ------------ |
| Crossref + OpenAlex (الافتراضي)           | 100/100          | 25/50       | 0         | 25/25             | 25             | **لم تتحقق** |
| Crossref وحده (`--crossref-only`، تشخيصي) | 100/100          | 50/50       | 0         | 25/25             | 0              | تحققت        |

العناصر الـ25 غير القابلة للتحقق في الإعداد الافتراضي كلها مراجع مختلقة بلا DOI (`fab-title-*`): أجاب Crossref بلا تطابق، لكن بحث OpenAlex أعاد HTTP 429 لأن الميزانية اليومية المجانية بلا مفتاح نفدت (`x-ratelimit-remaining-usd: 0`، `Retry-After` نحو 18 ساعة)، والكاشف عن قصد لا يحكم بـ`not_found` حين تعذّر سؤال أحد السجلّين. التفاصيل في `results/run-2026-11-22-*.md`.

## الحدود

- **يعتمد على الشبكة ويُشغَّل اختيارياً**؛ ليس جزءاً من `pnpm test` ولا من CI. نتائجه تتغير إن تغيّرت بيانات السجلات أو حدود المزوّدين.
- **انحياز العيّنة:** `sample` في Crossref يعكس ما يسجّله Crossref (مقالات دوريات، طغيان الإنجليزية، سجلات قديمة رقمية)، والعناوين العربية مأخوذة عبر كلمات بحث شائعة فهي ليست عيّنة عشوائية من الأدبيات العربية. المصادر غير المسجّلة في Crossref (كتب عربية كثيرة، رسائل جامعية) غير ممثَّلة.
- المسار الحقيقي بـDOI يقارن Crossref بنفسه تقريباً، فهو يقيس سلامة البحث والمطابقة والتطبيع لا اختلاف السجلات بين المزوّدين. **لا توجد مراجع حقيقية بلا DOI** في هذه المجموعة، فحساسية مسار البحث بالعنوان غير مقيسة هنا.
- العناوين المختلقة مركّبة آلياً، وهي أسهل من اختلاقات النماذج اللغوية التي تحاكي عناوين حقيقية قريبة جداً.

---

## English

A fixed dataset (100 real Crossref-sampled works incl. 15 Arabic-script, 50 fabricated — 25 unregistered DOIs under real prefixes, 25 title-only — and 25 real DOIs carrying another work's metadata) and a live runner for `verifyReference`. Real items keep their registered metadata; fabricated items are invented on purpose (seeded word lists) and checked at build time against Crossref (fake DOIs must 404; invented titles must not resemble any top-5 hit). `unverifiable` never counts as a pass. Run with `SCHOLARLY_CONTACT_EMAIL=… NODE_USE_ENV_PROXY=1 pnpm --filter @bahith/eval exec tsx references/run.ts`; exit code 1 when a target is missed. Latest live run (2026-11-22): Crossref+OpenAlex — real 100/100 verified, fabricated 25/50 rejected with 25 title-only items `unverifiable` (anonymous OpenAlex search budget exhausted, HTTP 429), 0 false acceptances, mismatched 25/25, so targets **not met**; diagnostic `--crossref-only` — 100/100, 50/50, 0, 25/25, 0 unverifiable, targets met. Network-dependent, opt-in, not in CI; Crossref sampling bias applies; without `OPENALEX_API_KEY` the anonymous OpenAlex budget runs out and title-only references become `unverifiable`.
