# إضافة أسرار GitHub لبيئة Staging (مرة واحدة)

> الأسرار تُدخَل في واجهة GitHub نفسها (مشفرة، لا تظهر لأحد ولا في السجلات). لا تُرسَل في المحادثة.

## 1. إنشاء البيئة

GitHub → المستودع `7g6dz66m7p-code/bahith` → **Settings → Environments → New environment** → الاسم: `staging`.
(كرّر لاحقاً لـ `production` وفعّل **Required reviewers** = حسابك.)

## 2. أسرار قاعدة البيانات (Environment secrets داخل `staging`)

من Neon: مشروع **BAHITH-Staging (Frankfurt, proud-cloud-29680152)** → **Connect** → الدور `neondb_owner`،
قاعدة `neondb`، **Connection pooling: OFF** (اتصال مباشر)، انسخ الرابط.

| الاسم                | القيمة                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_ADMIN_URL` | الرابط المنسوخ كما هو (يبدأ بـ `postgresql://neondb_owner:...`)                   |
| `DATABASE_URL`       | الرابط نفسه بعد استبدال `neondb_owner:<كلمة المرور>` بـ `bahith_app:<كلمة جديدة>` |
| `AUTH_DATABASE_URL`  | الرابط نفسه بعد استبدالها بـ `bahith_auth:<كلمة جديدة أخرى>`                      |

كلمتا المرور الجديدتان: 32 حرفاً عشوائياً على الأقل من أحرف وأرقام فقط (مثلاً من مدير كلمات المرور).
الترحيل يضبطهما على الدورين تلقائياً؛ لا تُنشئ الأدوار يدوياً في Neon.

## 3. أسرار R2 لـ Staging

Cloudflare → **R2 → Manage R2 API Tokens → Create API token**:
الصلاحية **Object Read & Write**، والنطاق **Apply to specific buckets only → `bahith-staging-files`**.

| النوع    | الاسم                  | القيمة                        |
| -------- | ---------------------- | ----------------------------- |
| Secret   | `R2_ACCOUNT_ID`        | معرف الحساب (يظهر في صفحة R2) |
| Secret   | `R2_ACCESS_KEY_ID`     | Access Key ID من الرمز        |
| Secret   | `R2_SECRET_ACCESS_KEY` | Secret Access Key من الرمز    |
| Variable | `R2_BUCKET`            | `bahith-staging-files`        |
| Variable | `R2_BACKUP_BUCKET`     | `bahith-staging-files`        |

## 4. بعد الإضافة

أخبرني، وسأشغّل بالترتيب: **Database migrate (Neon) → staging**، ثم **Storage check (R2 staging)**،
ثم **Database backup and restore test → staging**، وأقرأ النتائج.
