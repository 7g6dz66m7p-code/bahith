# تشغيل نواة SANAD-X الداخلية

هذه نسخة تدريجية للمطورين، وليست واجهة بحث عامة. لا تتطلب مفاتيح نماذج ولا ترسل
المستندات إلى مزود خارجي. لا تمنح `userId` القادم من جسم طلب HTTP أي ثقة.

## استخراج ملف محلي

من جذر المستودع، مع ملف تملكه ومجلد عمل خاص خارج الملفات المتتبعة:

```bash
cd apps/worker
uv sync --frozen
uv run python -m bahith_worker.sanad /absolute/path/source.pdf \
  --mime-type application/pdf --output /absolute/path/manifest.json
```

استخدم `text/plain` للنص و
`application/vnd.openxmlformats-officedocument.wordprocessingml.document` لـDOCX.
الخروج الناجح يعرض SHA-256 وأعداد الوحدات والمقاطع والفشل فقط؛ النص في ملف manifest
الخاص. PDF الممسوح يحتاج OCR غير متاح حالياً. يعرض الفشل الجزئي قائمة `failures`؛
الصفحة الفاشلة لا تنتج مقطعاً. تفاصيل الحدود في `apps/worker/README.md`.

## الحفظ والاسترجاع

قبل استعمال الخدمات، شغّل الهجرات على قاعدة تطوير محلية وفق README. لا تشغّلها على
الإنتاج لهذا الجزء. يجب أن يوجد مستخدم وعضوية ومشروع ومصدر وملف مسجّل مرتبط بالمصدر،
وارتباط `project_sources` بالمشروع. لا تنشئ خدمات SANAD حسابات أو جلسات بديلة.

مثال استدعاء من خدمة داخلية موثوقة، بعد الحصول على سياق المستخدم والمشروع والملف:

```typescript
import { ingestExtraction, retrieve } from '@bahith/db';
import { verifyQuotation } from '@bahith/ai';

// database uses DATABASE_URL with bahith_app, never DATABASE_ADMIN_URL.
const saved = await ingestExtraction(database, { ...context, fileId, manifest });
const found = await retrieve(database, { ...context, query: question });

// Strict projection: only stored evidence can supply source/version/page metadata.
const allowed = found.results.map((row) => ({
  chunkId: row.chunkId,
  sourceId: row.sourceId,
  content: row.content,
  kind: row.kind,
  fileId: row.fileId,
  fileSha256: row.fileSha256,
  pageStart: row.pageStart,
  pageEnd: row.pageEnd,
  sourceVerificationStatus: row.verificationStatus,
}));
const match = verifyQuotation({ chunkId: selectedChunkId, quote }, allowed);
```

هذه أسماء متغيرات يحصل عليها المستدعي الفعلي، وليست بيانات اعتماد أو نتائج بحثية
افتراضية. الاختبار `sanad-ingest.test.ts` ينفّذ المسار كاملاً بملف TXT حقيقي مؤقت
موسوم صراحةً كبيانات اختبار.

للبحث الهجين مرّر `queryEmbedding: {model, values}` في `retrieve`، ومتجهات المقاطع
الحقيقية `{model, vectors}` في `ingestExtraction`. يلزم نفس اسم النموذج و1024 بُعداً
وقيم محدودة وغير صفرية. بدون ذلك يكون البحث لفظياً صراحةً؛ لا يوجد استدعاء تضمين
حي في هذه النسخة. درجات RRF للترتيب فقط ولا تعني موثوقية علمية.

`saved.failures` يعرض الصفحات غير المستخرجة. `saved.status === 'failed'` يعني عدم
وجود نص قابل للاسترجاع؛ لا يجوز تحويله إلى نتيجة بحث. إعادة manifest مطابق آمنة؛
لتغيير البايتات أو طريقة الاستخراج سجّل نسخة ملف جديدة واحتفظ بالقديمة.

## التحقق

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test:integration
```

اختبارات التكامل تستعمل PostgreSQL 16 وpgvector وRedis فعلياً عبر Testcontainers.
تغطي العضوية والأدوار، عزل فضاءين ومشروعين في الفضاء نفسه، توافق Python/TypeScript،
الصفحات والفشل الجزئي، التكرار وتثبيت نسخة الأدلة، والاسترجاع اللفظي/الهجين.
اختبارات الهجرات تشمل الصعود والتراجع. لا تقيس هذه الاختبارات دقة علمية على مجموعة
أبحاث ذهبية. لم تكتمل مواصفات Verify والوحدتين الثالثة والرابعة في الطلب المستلم.
