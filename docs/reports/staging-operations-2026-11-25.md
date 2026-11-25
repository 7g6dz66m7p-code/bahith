# تقرير تشغيل Staging على Neon — 2026-11-25

> Workflow ‏`Staging operations` (‏`.github/workflows/staging-ops.yml`) على الفرع `claude/new-session-tv7vfk`،
> مشروع Neon Staging ‏`proud-cloud-29680152` فقط. لم يُلمس مشروع الإنتاج `floral-rice-81079531`
> ولا المنصة القديمة `al-bahith.com` ولا DNS ولا Telegram ولا الدفع. لا أسرار في المستودع أو السجلات.

## الملخص

بعد تحديث كلمتي المرور: الأدوار الثلاثة تعمل كما يجب، وRLS والعزل مُثبتان على Neon نفسه، ورحلة المستخدم
الكاملة (تسجيل ← تأكيد بريد ← دخول ← رفع ومعالجة ← بحث ← مستند ← DOCX/PDF) تنجح، والنسخ الاحتياطي
يُستعاد ويُتحقق منه. بقي أمران ينتظران أسراراً منك: المساعد البحثي بالذكاء الاصطناعي (‏`OPENAI_API_KEY`)،
وR2 (التخزين ورفع النسخة الاحتياطية).

## النتائج الفعلية (آخر تشغيل كامل: 13، ‏45662989170، commit ‏8acb85f)

| البند                         | النتيجة  | الدليل من السجل                                                                                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| الهجرات                       | نجح      | `migrations 17/17`                                                                                                                    |
| `bahith_app`                  | نجح      | دخول فعلي؛ `bypassRls:false`، `superuser:false`؛ الوصول إلى `sessions` مرفوض                                                          |
| `bahith_auth`                 | نجح      | دخول فعلي؛ بلا bypass/superuser؛ الوصول إلى `projects` مرفوض                                                                          |
| `bahith_identity_provisioner` | نجح      | `login: refused` (NOLOGIN كما يجب)                                                                                                    |
| RLS                           | نجح      | `tenant tables without forced RLS: 0`؛ `app roles with bypass: 0`                                                                     |
| عزل المستخدمين                | نجح      | `{"ownProjects":"1","crossRead":"0","crossProfile":"0","crossWrite":"42501","unboundRead":"0"}` (معاملة تُلغى)                         |
| صلاحيات Data API القديمة      | نجح      | التشغيل 12 ألغى `USAGE` على `public` للدور `authenticated`؛ بعده `foreign grantees: 0` واستعلام Neon المباشر يعيد `[]`                |
| pgvector / HNSW / FK          | نجح      | `pgvector 0.8.7; HNSW indexes on chunks: 1; foreign keys: 90`                                                                         |
| التسجيل وتأكيد البريد والدخول | نجح      | `signed in, project created, source processed`                                                                                        |
| رفع المستند ومعالجته          | نجح      | ضمن الخطوة نفسها (المصدر جاهز بمقاطع)                                                                                                 |
| البحث                         | نجح      | `PASS search — 3 passages, page 1`                                                                                                    |
| المساعد/التحقق من الادعاءات   | لم يُختبر | `PASS ... refused clearly — HTTP 503 AI_NOT_CONFIGURED`: لا `OPENAI_API_KEY` في بيئة `staging` على GitHub (رفض واضح، لا بيانات وهمية) |
| المستند والتصدير              | نجح      | `PASS create document`؛ `PASS export docx — 11828 bytes`؛ `PASS export pdf — 56643 bytes`                                             |
| تنظيف الحسابات الاختبارية     | نجح      | `test users left: 0`                                                                                                                  |
| النسخ الاحتياطي والاستعادة    | نجح      | نسخ Neon ← استعادة في pg18 فارغ: `17 migrations, row counts match`                                                                    |
| رفع النسخة إلى R2             | فشل      | أسرار R2 غير موجودة في بيئة `staging`                                                                                                 |
| فحص التخزين R2                | فشل      | أسرار R2 غير موجودة (يفشل باسم المتغيرات الناقصة)                                                                                     |

## الأخطاء المكتشفة وإصلاحها

| التشغيل | الخطأ                                                                          | الإصلاح (commit)                                                                                           |
| ------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 8       | الاستعادة: روابط الأدوار تشير إلى Neon بينما الخادم الهدف محلي                 | روابط محلية للخادم المؤقت (a9c79ee)                                                                        |
| 8       | PDF ‏38 بايت: لا Chromium على المشغّل                                           | تثبيت Chromium قبل تشغيل التطبيق (a9c79ee)                                                                 |
| 8       | فحص التخزين: `tsx` غير موجود في `@bahith/pipeline`                             | التشغيل عبر `@bahith/jobs` + رسالة واضحة بأسماء الإعدادات الناقصة (a9c79ee)                                |
| 9       | `BETTER_AUTH_SECRET` المؤقت يظهر في السجل                                      | `::add-mask::` (8ad697b)                                                                                   |
| 9       | `role "neondb_owner" does not exist` عند الاستعادة                             | أدوار بديلة NOLOGIN ثم `REASSIGN OWNED`/`DROP`؛ ملكية `bahith_*` تبقى (8ad697b)                            |
| 10      | `extension "pg_session_jwt" is not available`                                  | تخطي امتدادات Neon التي لا تنشئها هجرات BAHITH، ورفض الاستعادة إن غاب امتداد مطلوب (vector) (31dc00d)      |
| 11      | `authenticated` (Data API) ما زال يملك `USAGE` على `public`؛ الفحص للجداول فقط | فحص واحد يشمل المخططات والأعمدة والتسلسلات والدوال والصلاحيات الافتراضية، والإلغاء يشمل `public` (947e10c) |
| 12      | `Restored row count differs for table accounts` (تسجيلات أثناء النسخ)          | النسخة والأعداد والهجرات من لقطة واحدة (`pg_export_snapshot` + `pg_dump --snapshot`) (8acb85f)             |
| 13      | رسالة R2 غامضة (`Invalid endpoint`)                                            | فحص صريح بأسماء الأسرار الناقصة قبل الرفع                                                                  |

## الاختبارات المحلية بعد الإصلاحات

| الأمر                                         | النتيجة                           |
| --------------------------------------------- | --------------------------------- |
| `pnpm --filter @bahith/db test`               | 141 ناجح، 0 فاشل، 0 متخطى         |
| تكامل `@bahith/db` كاملاً (pg16)               | 21 ملفاً، 346 ناجح، 0 فاشل         |
| `backup.test.ts` على pg18 (عميل pg18)         | 4 ناجح                            |
| اختبار النسخ أثناء الكتابة على الكود القديم   | يفشل (`memberships`) كما هو متوقع |
| `pnpm --filter @bahith/db lint` / `typecheck` | صفر أخطاء                         |
| gitleaks (pre-commit)                         | `no leaks found` في كل commit     |

## ما لم يُحذف (يحتاج موافقتك)

بقايا Neon Auth في Staging لا يستخدمها BAHITH: المخطط `neon_auth` (جداول فارغة) والدور `authenticator`
(LOGIN، يديره Neon). لا صلاحيات لهما على مخططَي BAHITH. حذفهما تغيير على Neon لم يُطلب صراحة.

## المطلوب منك

1. **OpenAI لـ Staging:** سرّ `OPENAI_API_KEY` في GitHub → Settings → Environments → `staging`
   (الـworkflow يفعّل المساعد تلقائياً عند وجوده، ويختبر الإجابة المستشهدة والامتناع والتحقق من الادعاءات).
2. **R2:** رمز Cloudflare R2 مقيّد بالحاوية `bahith-staging-files` (Object Read & Write)، ثم الأسرار
   `R2_ACCOUNT_ID` و`R2_ACCESS_KEY_ID` و`R2_SECRET_ACCESS_KEY` والمتغيران `R2_BUCKET` و`R2_BACKUP_BUCKET`
   (التفاصيل: `docs/runbooks/github-secrets.md` القسم 3).
3. (اختياري) الموافقة على حذف بقايا Neon Auth من Staging.

بعدها يكفي تعديل `ops/staging-run.txt` ودفعه لإعادة التشغيل الكامل.
