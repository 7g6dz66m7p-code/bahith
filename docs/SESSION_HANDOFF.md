# SESSION HANDOFF — BAHITH

> اقرأ هذا أولاً. آخر تحديث: 2026-11-24.

## الحالة

- **آخر commit محلي:** `4cad1eb` على `claude/new-session-tv7vfk` (والفرع `feat/bahith-production-completion` مُنشأ عند النقطة نفسها).
- **GitHub:** الدفع مرفوض (403). الحساب المربوط `ahmbdr10-tech` بلا صلاحية كتابة على `7g6dz66m7p-code/bahith`. البعيد ما زال عند `9d8a20c`. توجد نسخة bundle مُتحقق منها أُرسلت للمالك (`…-4cad1eb.bundle`).
- **مزود الذكاء الاصطناعي:** مفتاح OpenAI محفوظ سراً شبكياً، لكن الحساب بلا رصيد (`credit_balance_exhausted`).

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
