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

1. ولّد كلمتين مختلفتين. Neon يرفض الكلمات الضعيفة (رُفضت كلمات hex فقط في التشغيل 7)، فاستخدم
   أحرفاً كبيرة وصغيرة وأرقاماً و`-` `_` (64 حرفاً، آمنة داخل الرابط):
   - macOS/Linux: `openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'` (مرتين)
   - Windows PowerShell:
     `[Convert]::ToBase64String((1..48 | % { [byte](Get-Random -Max 256) })).Replace('+','-').Replace('/','_').TrimEnd('=')` (مرتين)
2. (يكفي أن تكون الكلمة صحيحة: الـworkflow يأخذ **كلمة المرور فقط** من السرّين ويبني المضيف والقاعدة
   والمعاملات من `DATABASE_ADMIN_URL`.) خذ `DATABASE_ADMIN_URL` وغيّر **الجزء بين `://` و`@` فقط**؛ المضيف واسم القاعدة
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
(أُنشئ الرمز `BAHITH-Staging-R2` بهذه الإعدادات في 2026-11-25.) عند الإنشاء تعرض Cloudflare القيمتين
**مرة واحدة فقط**؛ تُنسخان مباشرة إلى GitHub ولا تُرسلان في أي محادثة.

GitHub → Settings → Environments → `staging` → **Environment secrets**:

| الاسم                  | القيمة                                                   |
| ---------------------- | -------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | معرف الحساب (R2 → Overview، أو جزء الرابط `…/<ID>/r2/…`) |
| `R2_ACCESS_KEY_ID`     | Access Key ID من صفحة الرمز                              |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key من صفحة الرمز                          |

لا متغيرات مطلوبة: الحاوية الافتراضية `bahith-staging-files` (يمكن تغييرها بالمتغيرين `R2_BUCKET`
و`R2_BACKUP_BUCKET`، ويُرفض أي اسم لا يحتوي `staging`). النسخ الاحتياطية تحت البادئة `db-backups/` في
الحاوية نفسها، لأن الرمز مقيّد بها وحدها. لفصلها في حاوية مستقلة: أنشئ الحاوية، وأضفها إلى نطاق الرمز،
واضبط `R2_BACKUP_BUCKET`.

ما يفعله التشغيل بعد إضافتها: فحص التخزين (رفع، قراءة مطابقة، بث، رفض الوصول المجهول، حذف، تأكيد الغياب)،
ورحلة التطبيق بملفات حقيقية على R2 ثم حذف ملفات الحسابات الاختبارية وإثبات خلو بادئتها، ونسخة احتياطية تُرفع
إلى R2 ثم تُنزَّل إلى مجلد فارغ وتُستعاد منها وحدها.

## 3أ. معاينة Vercel ‏(`bahith-preview`) بخدمات مجانية

النقل مباشر: **GitHub Actions → Vercel API** (‏`.github/workflows/staging-preview.yml`). القيم لا تمر بالمحادثة،
ولا تُكتب في سجل أو ملف أو artifact (ولا حتى مشفرة). الأسرار تُحفظ في Vercel بنوع **Sensitive**
(لا تُقرأ بعد الحفظ)، وكل متغير مقيّد بـ **Preview** والفرع `feat/bahith-liquid-glass` فقط؛ الإنتاج لا يُمس.
مفتاح المصادقة `BETTER_AUTH_SECRET` يُولَّد مستقلاً لـ Staging داخل الـworkflow عند غيابه، ويعيش في Vercel فقط.

أضِف في GitHub → Settings → Environments → `staging` → **Environment secrets**:

| الاسم                                                       | من أين                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                                              | Vercel → Account Settings → Tokens → Create: النطاق **فريق المشروع فقط** (لا "Full Account")، الانتهاء **يوم واحد** (أو 7). احذفه بعد التشغيل.                        |
| `REDIS_URL`                                                 | Upstash Console → Create Database (Free، منطقة قريبة من Neon، **Eviction: off**) → رابط `rediss://…` من تبويب Connect (TLS إجباري؛ الـworkflow يرفض `redis://`).      |
| `SMTP_PASSWORD`                                             | Resend → API Keys → Create: الصلاحية **Sending access** (وقيّدها بالنطاق إن تحقق).                                                                                     |
| `RESEND_API_KEY`                                            | Resend → مفتاح ثانٍ **Full access**، يبقى في GitHub فقط: الاختبار يقرأ به رسالة التحقق المرسلة إلى عنوان اختبار Resend (`delivered+…@resend.dev`). لا يُرسل إلى Vercel. |
| `R2_ACCOUNT_ID`، `R2_ACCESS_KEY_ID`، `R2_SECRET_ACCESS_KEY` | كما في القسم 3 (رمز R2 مقيّد بالحاوية `bahith-staging-files`).                                                                                                         |

**R2 آلياً (بدل إدخال قيمه الثلاث):** أضف سرّين مؤقتين في `staging`:
`CLOUDFLARE_BOOTSTRAP_TOKEN` (Cloudflare → My Profile → API Tokens → Custom: **User · API Tokens · Edit** و
**Account · Account Settings · Read**، انتهاء الغد) و`GH_SECRETS_TOKEN` (GitHub fine-grained: هذا المستودع فقط،
**Environments: Read and write**، انتهاء يوم). ثم عدّل `ops/staging-provision.txt` وادفع: الـworkflow
`Staging provision (R2 credential)` يُنشئ رمزاً على `bahith-staging-files` وحدها (Object Read & Write)، ويختبره
(كتابة/قراءة/حذف)، ويخزن القيم الثلاث بتشفير GitHub الرسمي (sealed box)، ثم يلغي رمز Cloudflare المؤقت ويحذف
السرّين المؤقتين. إن وُجدت أسرار R2 مسبقاً لا يُنشئ شيئاً. ألغِ رمز GitHub من إعدادات حسابك بعدها.

اختياري (Variable لا Secret): `SMTP_FROM` — الافتراضي `onboarding@resend.dev` (عنوان Resend التجريبي، يكفي
لعناوين الاختبار). للإرسال إلى بريد حقيقي: تحقّق من نطاق فرعي في Resend (سجلات DNS في Hostinger بموافقتك)
واضبط `SMTP_FROM=no-reply@<النطاق الفرعي>`.

التشغيل: عدّل `ops/staging-preview.txt` على الفرع `feat/bahith-liquid-glass` وادفع. الـworkflow:

1. يتحقق من وجود الأسرار (بالأسماء فقط)، ويبني رابطي `bahith_app`/`bahith_auth` من مضيف `DATABASE_ADMIN_URL`.
2. يكتب المتغيرات في Vercel (Sensitive للأسرار)، ثم يعيد نشر الفرع وينتظر READY ويثبت رابط الفرع عليه.
3. يشغّل `jobs` والعامل Python (OCR) **على المشغّل نفسه** طوال الاختبار (Vercel لا يشغّل العمال).
4. ينشئ **تجاوز حماية مؤقتاً** (Protection Bypass for Automation)، يختبر به الصحة، والتسجيل، والتحقق من البريد،
   والدخول، ولوحة التحكم (ar/en)، والمشروع، والرفع، والمعالجة، والبحث، وSANAD-X، والمساعد، والمسودة والتصدير،
   والعزل — ثم **يلغي التجاوز** مهما كانت النتيجة. حماية المعاينة نفسها لا تتغير.
5. يحذف ملفات الحسابات الاختبارية من R2 ويثبت خلوها، ثم يحذف الحسابات من Neon.

قيود معروفة: Vercel يحدّ جسم الطلب في الدوال (حوالي 4.5 MB)، فالرفع الأكبر يفشل على المعاينة (لا على VPS).
والمعالجة تعمل فقط أثناء تشغيل الـworkflow؛ ملف يُرفع يدوياً على المعاينة يبقى «قيد المعالجة» حتى التشغيل التالي.

## 4. بعد الإضافة

أخبرني، وسأشغّل بالترتيب: **Database migrate (Neon) → staging**، ثم **Storage check (R2 staging)**،
ثم **Database backup and restore test → staging**، وأقرأ النتائج.
