# باحث | BAHITH

منصة بحث أكاديمي **عربية أولاً** تساعد طلبة الدراسات العليا والباحثين على إدارة البحث من السؤال البحثي إلى التصدير. مبدؤها الحاكم: كل ادعاء يرتبط بدليل قابل للتحقق (مصدر + صفحة + مقطع)، أو يُوسم صراحةً بأنه استنتاج أو فرضية أو غير مدعوم.

- المتطلبات: [`docs/PRD.md`](docs/PRD.md)
- القرارات المعمارية: [`docs/adr/`](docs/adr)
- تقارير المراحل: [`docs/reports/`](docs/reports)
- قواعد العمل الملزمة لوكلاء البرمجة والمساهمين: [`CLAUDE.md`](CLAUDE.md)

## المتطلبات المسبقة

| الأداة                  | النسخة  | ملاحظة                                    |
| ----------------------- | ------- | ----------------------------------------- |
| Node.js                 | ≥ 22.12 | انظر `.nvmrc`                             |
| pnpm                    | 10.x    | `corepack enable`                         |
| Docker + Docker Compose | حديثة   | للخدمات المحلية ولاختبارات التكامل        |
| uv                      | حديثة   | لعامل Python — https://docs.astral.sh/uv/ |
| gitleaks                | ≥ 8.19  | يشغّله خطاف pre-commit                     |

## التشغيل السريع

```bash
pnpm install
```

```bash
pnpm bootstrap
```

```bash
docker compose up -d --wait
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

```bash
pnpm dev
```

ثم افتح <http://localhost:3000> (يُحوَّل إلى `/ar` أو `/en` حسب لغة المتصفح). فحص الصحة: <http://localhost:3000/api/health>.

`pnpm bootstrap` ينشئ `.env` محلياً بكلمات مرور عشوائية؛ الملف غير مُتتبَّع، و`.env.example` يحمل أسماء المتغيرات فقط.

## الأوامر

| الأمر                   | الوظيفة                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `pnpm lint`             | ESLint (مع قواعد الأنواع) وruff للعامل                        |
| `pnpm typecheck`        | TypeScript strict                                             |
| `pnpm test`             | اختبارات الوحدة (Vitest وpytest)                              |
| `pnpm test:integration` | اختبارات التكامل على Postgres وRedis حقيقيين (Testcontainers) |
| `pnpm test:e2e`         | Playwright بالعربية والإنجليزية                               |
| `pnpm eval`             | تقييم جودة RAG — متاح من المرحلة 3 (يفشل عمداً قبلها)          |
| `pnpm format`           | Prettier                                                      |
| `pnpm db:migrate`       | تطبيق الهجرات وتهيئة دور التطبيق                              |
| `pnpm db:rollback`      | التراجع عن آخر هجرة (`-- --steps=N` لأكثر من واحدة)           |
| `pnpm db:seed`          | البيانات المرجعية (الخطط)                                     |

عامل Python مباشرة: `cd apps/worker && uv run pytest`.

## هيكل المستودع

```
apps/
  web/          Next.js: الواجهة + Route Handlers
  worker/       Python: معالجة المستندات (يستهلك من BullMQ)
packages/
  db/           مخطط Drizzle، الهجرات، سياسات RLS، withWorkspace
  ai/           طبقة المزوّدين (الوكلاء والبرومبتات من المرحلة 3)
  citations/    citeproc + CSL (من المرحلة 4)
  ui/           نظام التصميم (من المرحلة 2)
  config/       ESLint، tsconfig، Tailwind
eval/           المجموعة الذهبية (من المرحلة 3)
docs/           PRD، ADRs، runbooks، تقارير المراحل
```

تفاصيل التطوير اليومي (إضافة هجرة، حل المشكلات): [`docs/runbooks/local-development.md`](docs/runbooks/local-development.md).
