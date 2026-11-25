# إضافة أسرار GitHub لبيئة Staging (مرة واحدة)

> الأسرار تُدخَل في واجهة GitHub نفسها (مشفرة، لا تظهر لأحد ولا في السجلات). لا تُرسَل في المحادثة.

## 1. إنشاء البيئة

GitHub → المستودع `7g6dz66m7p-code/bahith` → **Settings → Environments → New environment** → الاسم: `staging`.
(كرّر لاحقاً لـ `production` وفعّل **Required reviewers** = حسابك.)

## 2. أسرار قاعدة البيانات (Environment secrets داخل `staging`)

### الأدوار الثلاثة (موجودة الآن في Neon Staging، أُنشئت بـ SQL في 2026-11-25)

| الدور                         | من يستخدمه                               | الحالة الآن                      | ما تضيفه الهجرة                                                 |
| ----------------------------- | ---------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `bahith_app`                  | `DATABASE_URL` — التطبيق والعمال         | NOLOGIN، بلا أي سمة، بلا صلاحيات | LOGIN بكلمة سرّك + صلاحيات صريحة على جداول البحث، تحت RLS إجباري |
| `bahith_auth`                 | `AUTH_DATABASE_URL` — المصادقة فقط       | NOLOGIN، NOINHERIT، بلا صلاحيات  | LOGIN بكلمة سرّك + جداول الهوية فقط (لا جداول بحث)               |
| `bahith_identity_provisioner` | لا أحد (يملك دالة إنشاء المساحة الشخصية) | NOLOGIN دائماً                    | INSERT على workspaces/memberships فقط                           |

**لا تُنشئ هذه الأدوار ولا تغيّر كلماتها من لوحة Neon:** الأدوار المنشأة من اللوحة/الـAPI تصبح أعضاء في
`neon_superuser` (صلاحيات واسعة)، وهذا يُسقط مبدأ أقل الصلاحيات. الهجرة وحدها تضبط LOGIN وكلمة المرور.

### بناء الرابطين (على جهازك، لا في المحادثة)

1. ولّد كلمتين مختلفتين (حروف hex فقط، فلا حاجة لترميز داخل الرابط):
   - macOS/Linux: `openssl rand -hex 32` (مرتين)
   - Windows PowerShell: `-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })` (مرتين)
2. خذ `DATABASE_ADMIN_URL` الذي أضفته وغيّر **الجزء بين `://` و`@` فقط**؛ المضيف واسم القاعدة
   وما بعد `?` (مثل `sslmode=require`) تبقى كما هي، والمضيف هو المباشر (بلا `-pooler`):
   - `DATABASE_URL` = `postgresql://bahith_app:<الكلمة الأولى>@<المضيف نفسه>/neondb?<المعاملات نفسها>`
   - `AUTH_DATABASE_URL` = `postgresql://bahith_auth:<الكلمة الثانية>@<المضيف نفسه>/neondb?<المعاملات نفسها>`
3. GitHub → Settings → Environments → `staging` → **Environment secrets → Add secret**
   (Secret وليس Variable، والاسم حرفياً كما في الجدول). لا تحفظ الكلمتين في أي ملف أو رسالة؛
   احفظهما فقط في مدير كلمات المرور إن احتجت إليهما لاحقاً.
4. شغّل: عدّل سطر `ops/staging-run.txt` وادفع، أو أعد تشغيل آخر run لـ **Staging operations**.
   الهجرة تفعّل LOGIN للدورين بكلمتيك، ثم تتحقق: الأدوار بلا BYPASSRLS/SUPERUSER، RLS إجباري،
   لا صلاحيات لأدوار غريبة، pgvector، وعزل مستخدمَين اصطناعيين داخل معاملة تُلغى.

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
