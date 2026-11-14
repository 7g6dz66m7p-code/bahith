# تقرير المرحلة 1 — المستودع والمعمارية وقاعدة البيانات

- **التاريخ:** 2026-11-14
- **الفرع:** `claude/new-session-tv7vfk` (انظر «انحرافات عن البرومبت» رقم 1)
- **آخر commit مُتحقَّق منه:** `e33169c`

## الملخص

أُنشئ المستودع بالهيكل والمكدس المعتمدين: مخطط Drizzle لـ23 جدولاً على Postgres 16 + pgvector، مع RLS مفروض على كل جدول بحثي ودور تطبيق بلا `BYPASSRLS` و`withWorkspace`، وهجرات لها تراجع مختبَر، وتطبيق ويب عربي أولاً، وعامل Python على BullMQ، وCI من خمس وظائف، وخمسة ADRs.
معايير القبول الأربعة تحققت، مع تحفظين صريحين: تشغيل النسخة النظيفة يحتاج `pnpm bootstrap` و`pnpm db:migrate` بين الأمرين المذكورين في المعيار، والزمن قيس والتخزين المؤقت دافئ.
يوجد قرار معلّق لصاحب المشروع: طلب دمج سابق (رقم 1) بنهج مختلف سيتعارض مع هذا الفرع عند الدمج.

## فحص بيئة العمل (القسم 5)

| البند            | النتيجة                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `pwd`            | `/home/user/bahith`                                                                               |
| `git status`     | فرع `claude/new-session-tv7vfk`، شجرة نظيفة                                                       |
| `git log`        | commit واحد: `55ce983 Initial commit`                                                             |
| المحتوى          | `README.md` فقط (سطر `# bahith`). لا `package.json` ولا ADRs ولا اختبارات ⇒ لا خط أساس للاختبارات |
| Node / pnpm      | v22.23.4 / 10.28.0                                                                                |
| Python           | 3.13.18 (مع uv 0.11.32 وruff)                                                                     |
| Docker / Compose | 29.9.2 / v5.6.1 — **خدمة Docker لم تكن تعمل** وشُغّلت يدوياً (`dockerd`) داخل بيئة الجلسة            |
| gitleaks         | لم يكن مثبتاً؛ ثُبّت 8.24.3 من إصدارات GitHub                                                        |

اكتُشف لاحقاً (من سجل GitHub Actions لا من النسخة المحلية) وجود فرع `feat/bahith-foundation` وطلب دمج مسودة رقم 1. التفاصيل في «ما أحتاجه من صاحب المشروع».

## ما تم تنفيذه

- **هيكل Monorepo** (pnpm workspaces + Turborepo، TypeScript strict، ESLint بقواعد الأنواع، Prettier) — الملفات: `package.json`، `pnpm-workspace.yaml`، `turbo.json`، `packages/config/`
- **Husky + gitleaks + lint-staged** (الخطاف يفشل إن غاب gitleaks) — `.husky/pre-commit`
- **الخدمات المحلية:** Postgres 16 + pgvector، Redis 7، MinIO، كلها على `127.0.0.1` وبفحوص صحة — `docker-compose.yml`
- **إدارة الأسرار:** `.env.example` بالأسماء فقط، و`pnpm bootstrap` يولّد `.env` غير مُتتبَّع بكلمات مرور عشوائية — `.env.example`، `scripts/setup-env.mjs`
- **مخطط Drizzle (23 جدولاً)** — `packages/db/src/schema/`
  users، workspaces، memberships، projects، research_plans، sources، project_sources، files، chunks، conversations، messages، claims، claim_evidence، documents، document_versions، citations، literature_matrix_rows، agent_runs، exports، plans، subscriptions، usage_counters، audit_log
- **العزل:** سياسات RLS (27 سياسة) + `FORCE ROW LEVEL SECURITY` على 21 جدولاً، مفاتيح أجنبية مركّبة `(workspace_id, id)` بين الجداول البحثية، دور `bahith_app` بصلاحيات دنيا — `packages/db/migrations/0001_schema.sql`، `0002_security.sql`
- **`withWorkspace(id, fn)` و`withUser(id, fn)`** بربط بنطاق المعاملة — `packages/db/src/client.ts`
- **الفهارس:** HNSW على `chunks.embedding` (cosine، 1024 بُعداً) وGIN على `chunks.tsv` — `packages/db/src/schema/sources.ts`
- **البحث العربي:** `app.normalize_arabic` + `arabicTsQuery` — `packages/db/migrations/0000_foundation.sql`، `packages/db/src/search.ts`
- **قيود نزاهة أكاديمية في المخطط:** مقطع «الملخص فقط» لا يحمل رقم صفحة؛ مصدر `verified` يلزمه مزوّد وتاريخ تحقق؛ `claims.support_status` إلزامي؛ `audit_log` إلحاق فقط؛ `document_versions` بلا تعديل
- **مشغّل هجرات بصعود وتراجع** وفحص checksum ورفض القواعد غير المحلية دون `--allow-remote` — `packages/db/src/migrator.ts`، `packages/db/src/cli/`، `packages/db/migrations/down/`
- **تطبيق الويب:** Next.js 16 (App Router) + next-intl (ar افتراضي، en)، RTL/LTR، كل النصوص من `messages/*.json` وقاعدة lint تمنع النصوص داخل المكونات، و`/api/health` — `apps/web/`
- **عامل Python:** مستهلك BullMQ بمهمة `system.ping`، تحقق Pydantic، سجلات بلا بيانات المهام — `apps/worker/`
- **حزم هيكلية:** `packages/ai` (إعداد النماذج `provider:model` بلا افتراضي)، `packages/citations` (قائمة الأنماط)، `packages/ui` (فارغة للمرحلة 2)، `eval/` (يفشل عمداً حتى المرحلة 3)
- **CI:** خمس وظائف — lint/format/typecheck + تطابق المخطط والهجرات، unit، integration (Testcontainers)، e2e (Playwright)، gitleaks على كامل التاريخ — `.github/workflows/ci.yml`
- **الوثائق:** `docs/PRD.md`، `docs/adr/0001…0005`، `docs/runbooks/local-development.md`، `README.md`، ونسخة البرومبت الرئيسي في `CLAUDE.md`

## الأوامر المشغّلة ونتائجها الفعلية

كلها شُغّلت محلياً على `e33169c`.

| الأمر                                        | النتيجة                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`             | نجح                                                                                                                |
| `pnpm format:check`                          | `All matched files use Prettier code style!`                                                                       |
| `pnpm lint`                                  | 7 مهام ناجحة من 7 (ESLint لست حزم + ruff للعامل)                                                                   |
| `pnpm typecheck`                             | 5 مهام ناجحة من 5                                                                                                  |
| `pnpm test`                                  | **88 ناجح، 0 فاشل، 0 متخطى** — db 55، web 11، ai 7، citations 2، worker 13 (واختبارا تكامل العامل مستبعدان بالوسم) |
| `pnpm test:integration`                      | **152 ناجح، 0 فاشل، 0 متخطى** — db 147، web 3، worker 2 (Postgres وRedis حقيقيان عبر Testcontainers)               |
| `pnpm test:e2e`                              | **6 ناجح، 0 فاشل** (3 مواصفات × مشروعي `ar` و`en`)                                                                 |
| `cd apps/worker && uv run pytest`            | 13 ناجح، 2 مستبعدان بالوسم `integration`                                                                           |
| `pnpm eval`                                  | **يفشل عمداً (exit 1)** برسالة «متاح من المرحلة 3» — لا مجموعة ذهبية بعد                                            |
| `gitleaks git --redact`                      | `no leaks found` (كامل التاريخ)                                                                                    |
| `drizzle-kit check` / `drizzle-kit generate` | `Everything's fine` / `No schema changes, nothing to migrate`                                                      |
| `pnpm db:migrate` (على قاعدة compose)        | `Applied 3 migration(s): 0000_foundation, 0001_schema, 0002_security`؛ التشغيل الثاني: `Database is up to date.`   |
| `pnpm db:rollback` ثم `pnpm db:migrate`      | `Rolled back 1 migration(s): 0002_security` ثم `Applied 1 migration(s): 0002_security`                             |
| `psql "$DATABASE_URL"` بدور التطبيق          | `bahith_app` / `rolbypassrls = f` / الخطط = 2 / المشاريع المرئية بلا سياق = 0                                      |
| `curl /api/health` (مع `pnpm dev`)           | `200` — `{"status":"ok","checks":{"database":"up","redis":"up"}}`                                                  |
| `curl /` ثم `/ar` و`/en`                     | `307 → /ar` (و`→ /en` مع `Accept-Language: en`)؛ `<html lang="ar" dir="rtl">` و`<html lang="en" dir="ltr">`        |
| منتِج Node ← عامل Python (تحقق يدوي)          | `node producer got result from python worker: {"pong":"from-node"}` (bullmq 6.7.6 ← bullmq 3.6.1 لـPython)         |
| GitHub Actions                               | التشغيلان 3 و4 ناجحان في الوظائف الخمس (الروابط أدناه)                                                             |

**فحص أن اختبار العزل ليس شكلياً:** عند توصيل الاختبار عمداً بحساب superuser (يتجاوز RLS) فشل **112 من 118**؛ ثم أُعيد الإعداد الصحيح.

**أخطاء كشفتها الاختبارات وأُصلحت أثناء المرحلة:**

1. جدول تحويل الحروف في `normalize_arabic` كان يبدّل (ى ← ه) و(ة ← ي) خطأً. كشفه اختبار التكامل؛ أُعيدت كتابة الخريطة بأكواد Unicode صريحة.
2. `pnpm setup` أمر مدمج في pnpm فلم يكن سكربت المشروع يعمل. كشفه التشغيل من نسخة نظيفة؛ أُعيدت التسمية إلى `pnpm bootstrap`.
3. Turborepo كان يحجب متغيرات الوسيط والشهادات عن المهام، ففشل أول `uv run` للعامل خلف proxy. كشفه التشغيل من نسخة نظيفة؛ أُضيفت المتغيرات إلى `globalPassThroughEnv`.
4. فحص صحة MinIO استخدم `curl` غير الموجود في الصورة؛ استُبدل بفحص bash.

## معايير القبول

| المعيار                                                          | الحالة             | الدليل                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up && pnpm dev` من نسخة نظيفة في أقل من 10 دقائق | **تحقق — بتحفظين** | `git clone` جديد ← `pnpm install` ← `pnpm bootstrap` ← `docker compose up -d --wait` ← `pnpm db:migrate` ← `pnpm db:seed` ← `pnpm dev`: الويب (`/api/health` 200، `/ar` 200) والعامل (`worker started`) بعد **18 ثانية**. التحفظان: (1) يلزم `pnpm bootstrap` و`pnpm db:migrate` بين الأمرين؛ (2) القياس وصور Docker ومخزن pnpm مخزّنة مؤقتاً. القياس البارد الكامل (سحب الصور وتنزيل الحزم من الصفر) **لم يُقَس**. |
| CI أخضر                                                          | **تحقق**           | [التشغيل 4 على `e33169c`](https://github.com/7g6dz66m7p-code/bahith/actions/runs/43533490131) و[التشغيل 3 على `f5b3f39`](https://github.com/7g6dz66m7p-code/bahith/actions/runs/43532546871): الوظائف الخمس `success`. تشغيل commit هذا التقرير نفسه يُفحص بعد الدفع.                                                                                                                                            |
| اختبار العزل ينجح على كل الجداول البحثية                         | **تحقق**           | `packages/db/test/integration/isolation.test.ts`: 118 اختباراً. لكل جدول فيه `workspace_id` (20 جدولاً: 19 بحثياً + memberships): A يقرأ صفوفه كلها وصفر من B والعكس، صفر صفوف بلا سياق، لا تعديل ولا حذف لصفوف B، لا نقل صفوف إلى B. ويتحقق الاختبار أن قائمة الجداول في القاعدة تطابق المخطط وأن لكل جدول بيانات للمستخدمَين.                                                                                     |
| 5 ADRs مكتوبة                                                    | **تحقق**           | `docs/adr/0001-modular-monolith.md` … `0005-ai-provider-layer.md`                                                                                                                                                                                                                                                                                                                                               |

## القرارات المعمارية

- ADR-0001: مونوليث معياري داخل Monorepo — تطبيق Next.js واحد + عامل Python، والمنطق في `packages/*`.
- ADR-0002: PostgreSQL 16 + pgvector + RLS — عزل مفروض في القاعدة، مفاتيح مركّبة، FTS عربي مطبَّع، متجهات 1024، هجرات بتراجع.
- ADR-0003: عامل Python عبر BullMQ — العميل الرسمي لـPython، طابور واحد ومهام بالاسم، سجلات بلا بيانات.
- ADR-0004: المصادقة بـBetter Auth — لأن كلمة المرور و2FA ضمن النطاق؛ الأدوار تبقى في جداولنا. التنفيذ في المرحلة 2.
- ADR-0005: طبقة المزوّدين — Vercel AI SDK، `provider:model` من البيئة بلا نموذج افتراضي، مخرجات Zod. التنفيذ في المرحلة 3.

### انحرافات عن البرومبت (قرارات صغيرة قابلة للتراجع)

1. **اسم الفرع:** `claude/new-session-tv7vfk` بدل `phase-1-…`، لأن بيئة الجلسة تسمح بالدفع إلى هذا الفرع فقط.
2. **صيغة سياسة RLS:** `workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid` بدل الصيغة الحرفية، حتى يُرجع غياب السياق صفر صفوف بدل خطأ، ولأن الإعداد يعود نصاً فارغاً بعد انتهاء المعاملة في اتصال الـpool.
3. **صورة MinIO:** `coollabsio/minio:RELEASE.2025-10-15T17-29-55Z` (بناء مجتمعي للإصدار نفسه). `minio/minio` رُفض سحبها من Docker Hub («repository does not exist»)، و`quay.io` محجوب بسياسة شبكة هذه الجلسة.
4. **TypeScript 6.0.3 لا 7.0:** `typescript-eslint` يدعم `<6.1.0` فقط.
5. **ESLint 9.39.5 لا 10:** إضافات `eslint-config-next` (react، jsx-a11y، import) لا تدعم ESLint 10 بعد.
6. **Drizzle 0.45 المستقر** لا 1.0 (ما زال rc).
7. **Playwright مثبَّت على 1.63.0** (الأحدث 1.65.1) ليطابق متصفح بيئة الجلسة.
8. **`CLAUDE.md`:** حُفظ البرومبت الرئيسي في جذر المستودع كما يقترح سطره الأول.
9. **`apps/web/AGENTS.md`:** ملف يولّده `next dev` تلقائياً ويطلب إبقاءه في المستودع.

## الاعتماديات المضافة

النسخ المثبتة هي أحدث الإصدارات المستقرة على npm وPyPI وقت التنفيذ، عدا الاستثناءات المذكورة في «انحرافات عن البرومبت». التراخيص مقروءة من بيانات الحزم المثبتة.

| الحزمة                                                            | السبب                                    | الترخيص          |
| ----------------------------------------------------------------- | ---------------------------------------- | ---------------- |
| turbo 2.11                                                        | تشغيل مهام الـmonorepo                   | MIT              |
| typescript 6.0                                                    | TypeScript strict                        | Apache-2.0       |
| eslint 9، @eslint/js، typescript-eslint، globals                  | الفحص الساكن بقواعد الأنواع              | MIT              |
| eslint-config-next، eslint-config-prettier                        | قواعد Next.js ومنع تعارض التنسيق         | MIT              |
| prettier، husky، lint-staged                                      | التنسيق وخطاف pre-commit                 | MIT              |
| next 16، react 19، react-dom                                      | الواجهة والـAPI                          | MIT              |
| next-intl 4                                                       | الترجمة والتوجيه بحسب اللغة              | MIT              |
| tailwindcss 4، @tailwindcss/postcss                               | التنسيق بخصائص منطقية                    | MIT              |
| zod 4                                                             | التحقق من المدخلات والإعدادات            | MIT              |
| drizzle-orm، drizzle-kit                                          | ORM وتوليد الهجرات                       | Apache-2.0 / MIT |
| pg، @types/pg                                                     | مشغّل Postgres (اختير لنضج أدوات OTel له) | MIT              |
| ioredis 5                                                         | اتصال Redis (وهو ما يقبله BullMQ)        | MIT              |
| tsx                                                               | تشغيل سكربتات الهجرة بـTypeScript        | MIT              |
| vitest 5                                                          | اختبارات الوحدة والتكامل                 | MIT              |
| testcontainers، @testcontainers/postgresql، @testcontainers/redis | حاويات حقيقية في الاختبارات              | MIT              |
| @playwright/test                                                  | اختبارات E2E                             | Apache-2.0       |
| bullmq (Python) 3.6                                               | استهلاك طابور BullMQ من العامل           | MIT              |
| pydantic، pydantic-settings                                       | التحقق من الحمولات والإعدادات في العامل  | MIT              |
| pytest، pytest-asyncio، ruff، testcontainers (Python)             | اختبار وفحص العامل                       | MIT / Apache-2.0 |

صور Docker: `pgvector/pgvector:pg16` (PostgreSQL License)، `redis:7-alpine` (Redis 7.4: **RSALv2/SSPLv1** لا BSD — يسمح بالاستخدام الداخلي كخدمة، ويمنع تقديم Redis نفسه كخدمة مُدارة)، `coollabsio/minio` (**AGPL-3.0** — خدمة مستقلة للتطوير المحلي فقط، لا تُربط بالكود).

## ما لم يكتمل / المشكلات المعروفة

- **`pnpm eval` غير منفَّذ:** يفشل عمداً. المجموعة الذهبية جزء من المرحلة 3.
- **لا bucket في MinIO:** الخدمة تعمل لكن لا شيء ينشئ الـbucket ولا عميل S3 في الكود بعد (المرحلة 3). متغيرات `S3_*` معرَّفة وغير مستخدمة.
- **جدول `users` بلا RLS:** جدول هوية عام، ودور التطبيق يقرأ كل صفوفه. يُحسم مع جداول المصادقة في المرحلة 2 (سؤال مفتوح في ADR-0004).
- **لا `AppError` موحَّد برسائل مترجمة:** توجد أخطاء مُصنَّفة بأكواد ثابتة (`DbError`، `EnvError`، `AiConfigError`، `JobError`). التوحيد والترجمة مع أول مسارات API في المرحلة 2.
- **حدود الخطط فارغة:** `plans` تُبذر بـ`free` و`pro` و`limits = {}`، أي لا شيء مسموح، حتى تُحدَّد الحصص.
- **القياس البارد لزمن النسخة النظيفة لم يُجرَ** (انظر جدول المعايير).
- **shadcn/ui، Sentry، OpenTelemetry، Langfuse، axe-core، commitlint:** غير مثبتة؛ خارج نطاق المرحلة 1.
- **أثر جانبي عولج:** تشغيل `pnpm setup` المدمج بالخطأ أضاف مقطع `PNPM_HOME` إلى `~/.bashrc` في حاوية الجلسة؛ أُزيل. لا أثر على المستودع.

## المخاطر والديون التقنية

- **ESLint 9 لم يعد مدعوماً** (تحذير npm). الترقية إلى 10 مرهونة بدعم إضافات `eslint-config-next`.
- **ترخيص Redis 7.4** ليس مفتوح المصدر بتعريف OSI. إن كان ذلك غير مقبول فالبديل Valkey (BSD-3) وهو متوافق مع BullMQ؛ لم يُختبر هنا.
- **صورة MinIO مجتمعية** وآخر تحديث لها أكتوبر 2025، وMinIO نفسه AGPL. الكود سيتعامل مع واجهة S3 فقط، فالاستبدال (Garage، SeaweedFS…) ممكن دون تغيير الكود.
- **`claim_evidence` قابل للتعديل والحذف من دور التطبيق.** طلب الدمج رقم 1 يجعل سلسلة الأدلة غير قابلة للتعديل؛ فكرة تستحق النقل إن وافق صاحب المشروع.
- **تراجع `0002_security` يحذف الدور `bahith_app` على مستوى الخادم كله**؛ لا يصلح لخادم يضم أكثر من قاعدة تستخدم الدور نفسه.
- **عميل BullMQ لـPython** يتأخر عن عميل Node في بعض الميزات؛ التوافق مُتحقَّق منه يدوياً لمهمة واحدة فقط، واختبار العقد الآلي بين اللغتين مؤجل إلى المرحلة 3.
- **بُعد التضمين 1024 ثابت في المخطط**؛ تغييره لاحقاً يتطلب هجرة وإعادة تضمين.
- **إجراءات GitHub مثبتة برقم الإصدار الرئيسي** (`@v4`، `@v6`) لا بـSHA. gitleaks مثبّت بالنسخة ومجموع SHA-256.
- **CI يعمل على `push` فقط**؛ طلبات الدمج من forks لن تُفحص.
- **التطبيع العربي عدواني نسبياً** (ة ← ه، ؤ ← و، ئ ← ي) وبلا تجذير؛ أثره على الدقة والاسترجاع يُقاس في المرحلة 3.
- **الفضاء من نوع `personal` فقط** في `workspace_kind`؛ إضافة أنواع أخرى تحتاج هجرة.

## ما أحتاجه من صاحب المشروع

1. **قرار بشأن طلب الدمج رقم 1** ([`feat/bahith-foundation`](https://github.com/7g6dz66m7p-code/bahith/pull/1)، مسودة، أُنشئ قبل هذه الجلسة بدقائق): يؤسس المشروع بنهج مختلف (npm وحزمة واحدة، 10 جداول في `db/migrations/001_foundation.sql`، اختبارات PGlite) لا يطابق المكدس في القسم 6 من البرومبت. لم ألمسه. الفرعان يعدّلان الملفات نفسها (`README.md`، `.env.example`، `.gitignore`، `package.json`، `.github/workflows/ci.yml`، `docs/adr/0001`، `docs/adr/0002`) فسيتعارضان عند الدمج. الخيارات: (أ) اعتماد هذا الفرع وإغلاق رقم 1 بعد نقل ما يلزم منه (مثل `docs/BAHITH-BLUEPRINT.md` وفكرة سلسلة الأدلة غير القابلة للتعديل)؛ (ب) العكس؛ (ج) دمج يدوي. توصيتي (أ) لأنه المطابق للبرومبت.
2. **الموافقة على تقرير المرحلة 1** قبل بدء المرحلة 2، وهل أفتح طلب دمج لهذا الفرع نحو `main`.
3. **للمرحلة 2:** بيانات عميل Google OAuth، مزوّد بريد لرسائل التحقق والاستعادة، والبتّ في سؤال ADR-0004 (دور قاعدة بيانات مستقل للمصادقة).
4. **قيم الحصص** للخطتين المجانية والمدفوعة (أي مقاييس وأي حدود).
5. **للمرحلة 3 (يمكن تأجيله):** المزوّدون والنماذج للأدوار الثلاثة (محادثة، تضمين بـ1024 بُعداً، إعادة ترتيب) ومفاتيحهم، وسياسة إقامة البيانات.
6. **تأكيد أو تغيير:** بُعد التضمين 1024، ونمط Chicago المقصود (author-date أم notes-bibliography)، وقبول صورة MinIO المجتمعية للتطوير المحلي.

## الخطوة التالية المقترحة

**المرحلة 2 — الهوية والواجهة والحسابات:** رموز التصميم (فاتح/داكن) والخطوط وهيكل RTL/LTR بـshadcn/ui في `packages/ui`، ثم Better Auth (بريد، Google، 2FA) مع هجرة جداول المصادقة والفضاء الشخصي التلقائي.
ثم لوحة التحكم بمربع الأوامر (`Ctrl/⌘+K`) دون ذكاء اصطناعي، مع `AppError` مترجم، واختبار عزل لكل مسار API، وE2E للتسجيل بلغتين، وفحص axe.
