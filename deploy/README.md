# نشر BAHITH على خادم VPS مستقل

> لا يُشترى خادم ولا يُغيَّر أي سجل DNS للنطاق الرئيسي دون موافقة صاحب المشروع.
> هذا الدليل يجهّز `staging.al-bahith.com` فقط؛ المنصة القديمة على `al-bahith.com` لا تُمس.

## المكونات على الخادم

| الخدمة                 | الدور                                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `caddy`                | HTTPS تلقائي (Let's Encrypt)، موازنة الحمل بين نسخ web، رؤوس الأمان |
| `web` × `WEB_REPLICAS` | Next.js (نسخة Node لكل نواة)                                        |
| `jobs`                 | طوابير BullMQ (فهرسة، تضمين، إشعارات)                               |
| `worker`               | Python: استخراج PDF/DOCX وOCR عربي (tessdata_best)                  |
| `redis`                | الطوابير (AOF، بلا إخلاء)                                           |
| خارجي                  | Neon (قاعدة البيانات)، Cloudflare R2 (الملفات)، OpenAI              |

**المقاس المقترح للبداية:** 4 vCPU و8 GB ذاكرة و80 GB قرص (Ubuntu 24.04) لـ Staging.
القياس الفعلي عند 50/100 مستخدم يحدد مقاس الإنتاج (الخطوة 6).

## 1. تهيئة الخادم (مرة واحدة)

```bash
scp deploy/bootstrap-vps.sh root@<IP>:/root/ && ssh root@<IP> 'bash /root/bootstrap-vps.sh'
```

Docker من مستودعه الرسمي، جدار حماية (22/80/443 فقط)، تحديثات أمنية تلقائية، مستخدم `bahith`.

## 2. ملف البيئة `/etc/bahith/staging.env` (صلاحية 0640، root:bahith)

كل أسماء `.env.example` مع قيم Staging: `DATABASE_URL`/`AUTH_DATABASE_URL` (Neon Staging)،
`REDIS_URL=redis://:<REDIS_PASSWORD>@redis:6379`، `S3_*` (R2 ‏`bahith-staging-files`)،
`BETTER_AUTH_URL=https://staging.al-bahith.com`، `BETTER_AUTH_SECRET` جديد، `OPENAI_API_KEY`،
`AI_CHAT_MODEL=openai:gpt-5.4-mini`، `AI_EMBEDDING_MODEL=openai:text-embedding-3-small`، و`SMTP_*`.

## 3. البناء على الخادم

```bash
git clone https://github.com/7g6dz66m7p-code/bahith && cd bahith && git checkout claude/new-session-tv7vfk
for t in web jobs; do docker build --build-arg PG_CLIENT_MAJOR=18 -f docker/node.Dockerfile --target $t -t bahith-node:latest-$t .; done
docker build -f docker/worker.Dockerfile -t bahith-worker:latest .
```

## 4. DNS (بموافقتك، في Hostinger)

سجل واحد فقط: `A staging → <IP الخادم>` (و`AAAA` إن وُجد IPv6). لا تغيير على `@` أو `www`.

## 5. التشغيل

```bash
BAHITH_ENV=staging BAHITH_HOST=staging.al-bahith.com ACME_EMAIL=<بريدك> WEB_REPLICAS=3 \
  docker compose -p bahith-staging -f deploy/compose.yml up -d --wait
curl -fsS https://staging.al-bahith.com/api/health
```

الترحيلات لا تعمل من هنا: تعمل من GitHub Actions (`Database migrate (Neon)`).

## 6. الاختبار من خارج الخادم

```bash
LOAD_BASE_URL=https://staging.al-bahith.com pnpm --filter @bahith/web exec tsx load/prepare.ts > env.json
STAGING_EXPECT_AI=1 pnpm --filter @bahith/web exec tsx load/staging-journey.ts env.json
docker run --rm -v "$PWD/load:/load:ro" -e VUS=50 -e DURATION=120s ... grafana/k6:0.57.0 run /load/k6-smoke.js
```

(k6 من جهاز آخر غير الخادم، حتى لا يقيس الحمل نفسه.)

## 7. التراجع

- إصدار سابق: `BAHITH_TAG=<الوسم السابق> docker compose ... up -d` (الصور القديمة تبقى على الخادم).
- قاعدة البيانات: كل هجرة لها نسخة down مختبرة؛ والنسخة الاحتياطية اليومية تُستعاد وتُتحقق آلياً.
- إيقاف كامل لـ Staging لا يمس `al-bahith.com`.
