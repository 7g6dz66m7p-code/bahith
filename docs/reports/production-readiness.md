# تقرير الجاهزية الإنتاجية — BAHITH — 2026-11-25

الفرع `claude/new-session-tv7vfk`، Pull Request ‏#2 (مسودة). لا دمج في `main` ولا نشر إنتاجي.

## 1. ما يعمل فعلياً (مُتحقق بتشغيل حقيقي)

| الوظيفة                                                             | الدليل                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SANAD-X: مطابقة حرفية مع توحيد المسافات فقط (verbatim-v2)           | 79 اختبار وحدة (منها 200 حالة خاصية)؛ `pnpm eval`: اقتباسات الصفحة الصحيحة 100% محلياً و91.7% على CI، قبول خاطئ 0/28                   |
| Quality Gate على GitHub Actions                                     | التشغيلان 23 و24 ناجحان كاملاً (lint، unit، integration، eval، E2E، gitleaks)                                                          |
| المساعد البحثي مع OpenAI (Responses API)                            | `eval:assistant` حقيقي: دقة استشهاد 97.1%، امتناع صحيح 100%، صفر مختلق؛ إجابات عربية وإنجليزية داخل حاويات Staging وبعد إعادة تشغيلها |
| التسجيل، تأكيد البريد (SMTP عبر STARTTLS في Staging)، الدخول، 2FA   | E2E بلغتين + الهاتف + رحلة Staging                                                                                                    |
| رفع المصادر، OCR عربي، البحث، التصدير DOCX/PDF                      | رحلة Staging (Chromium داخل الصورة) + E2E                                                                                             |
| قاعدة البيانات على Postgres 18 (نسخة Neon)                          | 340/342 اختبار تكامل على pg18، والاثنان المتبقيان (النسخ الاحتياطي) نجحا بعميل pg18                                                   |
| الترحيلات + التحقق بعد النشر                                        | 17 هجرة + `verify-deployment` على pg18 نظيف بصلاحيات افتراضية مشابهة لـ Neon: صفر مشكلات                                              |
| النسخ الاحتياطي والاستعادة                                          | اختبار التكامل (نسخ ← استعادة في خادم فارغ ← تحقق checksums والأعداد) على pg16 وpg18                                                  |
| الدفع (طبقة بلا مزود)                                               | 9 اختبارات تكامل: تفعيل مرة واحدة، تكرار Webhook، عدم تطابق المبلغ، استرداد، مطابقة؛ Webhook يرد 503 وهو معطل                         |
| Telegram (ربط بتوقيع)                                               | E2E بتوكن اختبار مولّد لكل تشغيل                                                                                                       |
| الهاتف (صفحة التحقق)                                                | E2E بمرسل capture محلي؛ الإلزام غير مفعّل                                                                                              |
| حدود الذكاء الاصطناعي حسب الباقة + الرموز لكل نموذج + تكلفة تقديرية | اختبارات تكامل + لوحة الإدارة                                                                                                         |
| الهاتف والحاسوب                                                     | Playwright: ‏ar/en على Desktop Chrome و**Pixel 7** (22 اختبار جوال) + فحوص 360/768/1440                                               |
| الأمان                                                              | ZAP (بعد الإصلاح): ‏0 FAIL، 51 PASS؛ gitleaks نظيف؛ pip-audit: صفر؛ npm: صفر High/Critical (3 متوسطة في أدوات التطوير فقط)            |

## 2. ما أُنجز في البنية السحابية

- **Neon:** ‏`BAHITH-Production` (‏`floral-rice-81079531`، فرانكفورت، pg18، 0.25–1 CU) أُنشئ بموافقتك **فارغاً**.
  Staging = ‏`proud-cloud-29680152` (فرانكفورت). لم تُرحَّل أي قاعدة سحابية: هذه البيئة لا تسمح باتصالات
  Postgres المباشرة، فالترحيل عبر workflow ‏`Database migrate (Neon)` في GitHub Actions بعد إضافة الأسرار.
- **اكتشاف أمني في Staging Neon:** Data API مفعّل ويمنح الدور `authenticated` كل الصلاحيات على أي جدول
  جديد في `public`. أُضيف إلغاء تلقائي لصلاحيات الأدوار الغريبة بعد كل ترحيل، وفشل صريح إن بقيت.
  يُنصح أيضاً بتعطيل Data API وNeon Auth على مشروع Staging (BAHITH لا يستخدمهما).
- **R2:** ‏`bahith-private-files` (موجود، للإنتاج) و`bahith-staging-files` (أُنشئ اليوم).
- **النطاق:** ‏`al-bahith.com` على Hostinger (المنصة القديمة تعمل، شهادة Let's Encrypt حتى 2026-12-25). لم يُغيَّر شيء.
- **Staging محلي بالحاويات:** Caddy + ‏3 نسخ web + jobs + worker + Postgres + Redis + MinIO + Mailpit (TLS).

## 3. ما لم يتحقق (بصراحة)

- **الحمل:** صفر أخطاء حتى 100 مستخدم، لكن عتبات p95 عند 50 و100 مستخدم لم تتحقق؛ الجهاز نفسه (4 أنوية،
  90% استخدام) يشغّل k6 وكل الخدمات. لم تُخفَّض العتبات؛ يلزم قياس على بنية Staging حقيقية.
- **x11 على CI:** ‏Tesseract 5.5 بمسارات AVX2/FMA في مشغلات GitHub يقرأ «راوياً» خطأً، فالاقتباس غير موجود
  في النص فعلاً ويُرفض (سلوك صحيح). البوابة تنجح (91.7% ≥ 90%).
- **Anthropic احتياطياً:** مكتمل في الكود ومختبر بنماذج وهمية؛ لا يمكن حفظ مفتاح Anthropic في هذه البيئة،
  فلم يُختبر باستدعاء حقيقي.
- **ZAP:** تحذيرات قائمة: CSP ‏`unsafe-inline` (يلزم nonce)، و«غياب رموز CSRF» (الحماية بفحص Origin
  وSameSite، لا نماذج تقليدية)، و`NEXT_LOCALE` بلا HttpOnly (تفضيل لغة فقط).

## 4. المطلوب منك (قائمة واحدة)

### أسرار GitHub (Settings → Environments)

- **بيئة `staging`:** ‏`DATABASE_ADMIN_URL` (اتصال `neondb_owner` المباشر لمشروع proud-cloud)،
  و`DATABASE_URL` (‏`postgresql://bahith_app:<كلمة جديدة قوية>@<المضيف>/neondb?sslmode=require`)،
  و`AUTH_DATABASE_URL` (‏`bahith_auth` بكلمة أخرى). ثم شغّل workflow ‏«Database migrate (Neon)» ‏→ staging.
- **بيئة `production`:** الأسرار نفسها لمشروع floral-rice، مع **Required reviewers = أنت**. التشغيل يحتاج موافقتك.
- **للنسخ الاحتياطي:** ‏`R2_ACCOUNT_ID`، و`R2_BACKUP_BUCKET`، و`R2_ACCESS_KEY_ID`، و`R2_SECRET_ACCESS_KEY` (رمز R2 مقيّد بالحاوية).

### أسرار منصة الاستضافة (لا تمر عبر هذه البيئة)

- `OPENAI_API_KEY` (المفتاح نفسه المخصص لباحث)، و`AI_CHAT_MODEL=openai:gpt-5.4-mini`، و`AI_EMBEDDING_MODEL=openai:text-embedding-3-small`.
- `S3_*` لـ R2 (نقطة النهاية `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`، المنطقة `auto`).
- `BETTER_AUTH_SECRET` جديد، و`BETTER_AUTH_URL=https://al-bahith.com`.
- `ANTHROPIC_API_KEY` + `AI_CHAT_FALLBACK_MODEL` (اختياري).
- `AI_MODEL_PRICES_JSON` (أسعار عقدك؛ لعرض التكلفة).

### قرارات وخدمات

1. **الاستضافة** لتطبيق Node + عامل Python + Redis (خادم VPS بحاويات أو منصة حاويات). Vercel لا يناسب العامل.
2. **DNS/SSL:** موافقة على `staging.al-bahith.com` أولاً، ثم خطة التحويل للنطاق الرئيسي (Blue-Green).
3. **Google OAuth:** ‏`GOOGLE_CLIENT_ID/SECRET` مع Redirect ‏`https://al-bahith.com/api/auth/callback/google`.
4. **البريد:** مزود SMTP بنطاق موثّق (SPF/DKIM)، و`SMTP_*`.
5. **SMS:** اختيار المزود ومفاتيحه (الإلزام يبقى معطلاً حتى نجاح إرسال حقيقي).
6. **الدفع:** اختيار البوابة، وسر توقيع Webhook، وأسعار الباقات.
7. **Telegram:** ‏`TELEGRAM_BOT_TOKEN` للبوت الحالي (لن يُغيَّر Webhook البوت).
8. **Sentry:** ‏DSN (التكامل يُكمَل عند توفره).
9. **الترحيل القديم:** ملف `u747978280_bahith.sql`.
10. **Neon Staging:** تعطيل Data API وNeon Auth (أو موافقتك لأعطلهما عبر API).
11. **حدود الاستخدام:** عدد طلبات الذكاء الاصطناعي الشهرية لكل باقة.
