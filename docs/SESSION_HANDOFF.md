# SESSION HANDOFF — BAHITH

> اقرأ هذا أولاً. آخر تحديث: 2026-11-25.

## الحالة

- الفرع `claude/new-session-tv7vfk` مدفوع؛ PR ‏#2 مسودة؛ لا دمج في `main` ولا نشر إنتاجي.
- Neon: إنتاج `floral-rice-81079531` (فارغ، لم يُلمس)؛ Staging `proud-cloud-29680152` مُرحَّل ومُتحقق.
- R2: ‏`bahith-private-files` (إنتاج، لم يُلمس)، ‏`bahith-staging-files` (Staging، بلا رمز API بعد).
- لا اتصال Postgres مباشر من هذه البيئة: كل عمل على Neon عبر `staging-ops.yml`
  (يُطلق بتعديل `ops/staging-run.txt` ودفعه).

## 2026-11-25 (Staging operations، التشغيلات 8–16)

التقرير الكامل: `docs/reports/staging-operations-2026-11-25.md`.

- **ناجح على Neon Staging (التشغيل 13):** 17/17 هجرة؛ RLS إجباري؛ دخول فعلي للأدوار الثلاثة كما يجب؛
  عزل (قراءة عابرة 0، كتابة عابرة 42501)؛ صفر صلاحيات لأدوار غريبة (أُلغي `USAGE` لـ`authenticated` في 12)؛
  رحلة كاملة (تسجيل، بريد، دخول، رفع ومعالجة، بحث، مستند، DOCX، PDF)؛ نسخ احتياطي ← استعادة ← تحقق.
- **إصلاحات الاستعادة:** روابط أدوار محلية، أدوار Neon بديلة NOLOGIN (`neondb_owner`…) ثم REASSIGN/DROP،
  تخطي `pg_session_jwt`، ولقطة واحدة للنسخة والأعداد (`pg_dump --snapshot`).
- **ينتظر أسرارك:** `OPENAI_API_KEY` في بيئة `staging` (المساعد يرفض الآن `503 AI_NOT_CONFIGURED`)، وأسرار R2
  (التخزين ورفع النسخة).
- **التشغيل 16:** المساعد عبر OpenAI يجيب فعلياً (عربي/إنجليزي بإحالات صفحات، امتناع، تحقق من ادعاء)؛
  استرجاع الملف عبر التطبيق بمطابقة SHA-256 ورفضه لمساحة أخرى (403). R2 جاهز في الـworkflow (رحلة على R2،
  حذف وإثبات، نسخة إلى R2 واستعادة منها) وينتظر ثلاثة أسرار فقط: `R2_ACCOUNT_ID`، `R2_ACCESS_KEY_ID`،
  `R2_SECRET_ACCESS_KEY` (الحاوية افتراضياً `bahith-staging-files`).
- لا ميزة حذف مصدر/ملف في التطبيق (قرار تصميمي معلّق: أثره على الاستشهادات والأدلة).
- بقايا Neon Auth لم تُحذف (بلا موافقة): مخطط `neon_auth` (جداول فارغة)، والدور `authenticator` (LOGIN).

## 2026-11-25 (الجولة الثالثة)

- Neon Staging (proud-cloud): عُطّل Data API وNeon Auth (404 بعد الحذف). الإنتاج floral-rice فارغ.
- الهجرات تعمل مع مالك غير superuser (Neon): 0002/0004 مراجعة 2 + EQUIVALENT_REVISIONS؛ مختبر على pg18.
- `staging-ops.yml` يعمل عند تغيير `ops/staging-run.txt` (الإطلاق اليدوي يتطلب وجود الملف على main).
  التشغيل 45600846483 (محاولتان): الأسرار الثلاثة فارغة داخل البيئة `staging` → توقف قبل أي اتصال.
  لإعادة التشغيل: عدّل `ops/staging-run.txt` وادفع، أو أعد تشغيل الـrun من GitHub.
- R2: `bahith-staging-files` (Staging)، `bahith-private-files` (إنتاج، لم يُلمس).
- الأداء: `docs/reports/performance.md`؛ OCR: `docs/reports/ocr-arabic.md`؛ VPS: `deploy/README.md`.

## الدمج

دُمجت أعمال الوكلاء الثلاثة (الإشعارات 0012، المكتبة 0013، `packages/migration`) مع رقم الهاتف 0011 ولوحة الإدارة 0010. كل الاختبارات ناجحة (انظر `TEST_REPORT.md`).

## أوامر الاستئناف

```bash
cd /home/user/bahith && git log --oneline -1
(dockerd > /tmp/dockerd.log 2>&1 &)   # إن لم يكن Docker يعمل
pnpm install && pnpm lint && pnpm typecheck && pnpm test
pnpm test:integration --concurrency=1 && pnpm eval
pnpm --filter @bahith/web exec playwright test --trace off
AI_CHAT_MODEL=openai:gpt-4.1 OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 pnpm --filter @bahith/eval eval:assistant   # عند توفر الرصيد
git push -u origin claude/new-session-tv7vfk   # عند إصلاح الصلاحيات
```

## 2026-11-25

- OpenAI يعمل فعلياً (سرّ شبكي لـ api.openai.com؛ `.env` المحلي: `OPENAI_API_KEY=proxy-injected`،
  `AI_CHAT_MODEL=openai:gpt-5.4-mini`). التفاصيل: `docs/reports/openai-integration.md`.
- Staging: `pnpm staging:env` ثم `docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build --wait`؛
  الرحلة: `LOAD_BASE_URL=http://localhost:3200 LOAD_MAIL_URL=http://127.0.0.1:8225 pnpm --filter @bahith/web exec tsx load/prepare.ts > env.json`
  ثم `STAGING_EXPECT_AI=1 tsx load/staging-journey.ts env.json`.
- Docker هنا: مرآة `mirror.gcr.io` في `/etc/docker/daemon.json` (Docker Hub يحد الطلبات)، والبناء بـ
  `--secret id=extra_ca,src=/root/.ccr/ca-bundle.crt` وbuild-args للوكيل.
- قرار معلّق: بوابة eval على CI (x11/x12) — مطابقة المسافات في التحقق الحرفي.

## المتبقي (بالأولوية)

1. واجهة إدخال الهاتف وفرض الإلزام (`REQUIRE_PHONE_VERIFICATION`) — الخادم جاهز (0011 + plugin).
2. تغييرات المخطط التي طلبها محرك الترحيل (`docs/migration/legacy-schema-requests.md`).
3. الدفع: Webhooks موقعة، تفعيل تلقائي idempotent، مطابقة مالية (مزود غير محدد بعد).
4. Dockerfiles + Staging + Blue-Green (مزود الاستضافة غير محدد).
5. Gateway متعدد المزودين (Gemini، fallback، streaming، تتبع التكلفة).
6. الأداء تحت الحمل (تشبّع عملية Node واحدة) — اختبار 10/50/100 على عتاد مناسب.
7. الوكيل متعدد الأدوات (العناوين، الإشكالية، الخطة، الفجوات…).

انظر `IMPLEMENTATION_STATUS.md` للمصفوفة الكاملة.
