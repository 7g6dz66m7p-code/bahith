# Runbook: البيئات وقواعد البيانات والتخزين (Production / Staging / Development / Test)

> الحالة في 2026-11-24: **لا توجد قاعدة إنتاج مُهيّأة لهذا المستودع**، ولا حساب Neon أو
> Cloudflare متصل بهذه الجلسة. لم يُنشأ أي مورد سحابي ولم يُشترَ شيء. كل ما يلي جاهز
> للتنفيذ فور تسليم المفاتيح، ومختبر محلياً حيث يمكن.

## 1. الفصل بين البيئات

| البيئة      | قاعدة البيانات                                                                                     | التخزين                                                | من يرحّل                                    |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| Production  | مشروع Neon مستقل (`bahith-prod`)، فرع `main`                                                       | R2 bucket ‏`bahith-prod`                               | يدوياً بعد موافقة مكتوبة (`--allow-remote`) |
| Staging     | مشروع Neon منفصل (`bahith-nonprod`)، فرع `staging` — أو Postgres داخل `docker-compose.staging.yml` | R2 bucket ‏`bahith-staging` أو MinIO الخاص بالـStaging | `migrate` في compose أو يدوياً              |
| Development | `docker compose` المحلي (`pnpm bootstrap`) أو فرع Neon ‏`dev` من مشروع non-prod                    | MinIO المحلي                                           | المطوّر                                     |
| Test / CI   | Testcontainers (قاعدة مؤقتة لكل تشغيل)                                                             | MinIO مؤقت                                             | الاختبارات نفسها                           |

**لماذا مشروعان في Neon لا فرعان فقط:** أدوار Postgres (`bahith_app`، `bahith_auth`) على
مستوى العنقود. وضع الإنتاج في مشروع مستقل يعني كلمات مرور مستقلة للأدوار، وعدم وصول أي
مفتاح غير إنتاجي إلى بيانات الإنتاج. (لم أتحقق من حدود الخطة المجانية لعدد المشاريع؛ إن لم
تسمح بمشروعين، فالبديل: فرع واحد للإنتاج ومشروع/حساب منفصل لغيره.)

## 2. تهيئة Neon (بعد تسليم المفاتيح)

1. إنشاء المشروع بـ Postgres 16 في أقرب منطقة للمستخدمين.
2. تفعيل `vector`: الهجرة `0000_foundation` تنفّذ `CREATE EXTENSION vector` بدور المالك.
3. `DATABASE_ADMIN_URL` = اتصال دور المالك (للهجرات فقط، لا يصل للتطبيق).
4. `DATABASE_URL` = ‏`postgresql://bahith_app:<كلمة جديدة>@…/…?sslmode=require`
   و`AUTH_DATABASE_URL` = ‏`postgresql://bahith_auth:<كلمة جديدة>@…`. الهجرة تُنشئ الدورين
   وتضبط كلمتيهما من هذين المتغيرين (`provisionAppRole/AuthRole`).
5. ثم: `pnpm db:migrate -- --allow-remote` و`pnpm db:seed -- --allow-remote`.

**غير متحقق بعد على Neon (مخاطر):** إنشاء أدوار NOLOGIN وسياسات `FORCE ROW LEVEL SECURITY`
ودوال `SECURITY DEFINER` بدور مالك Neon (ليس superuser). كلها تعمل على Postgres 16 العادي في
الاختبارات؛ يجب تشغيل `pnpm test:integration` مرة ضد فرع Neon تجريبي قبل الإنتاج.
للاتصال المجمّع (pooler) استخدم عنوان الـpooler للتطبيق، والعنوان المباشر للهجرات
(`SET LOCAL` داخل المعاملات يعمل مع وضع transaction pooling).

## 3. التخزين على Cloudflare R2 (متوافق مع S3)

لا تغيير في الكود: `packages/pipeline/src/storage.ts` والعامل Python يتحدثان S3 فقط.

```
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=bahith-prod            # أو bahith-staging
S3_ACCESS_KEY_ID=<R2 token access key>
S3_SECRET_ACCESS_KEY=<R2 token secret>
S3_FORCE_PATH_STYLE=true
```

- مفتاح R2 لكل بيئة بصلاحية **Object Read & Write على bucket واحد** فقط.
- الحاويات تُنشأ من لوحة Cloudflare (التطبيق لا ينشئ حاويات خارج localhost/staging).
- رفع الملفات يتحقق من SHA-256 عند الخادم؛ يجب التأكد مرة على R2 أن ميزة checksum مدعومة
  (لم يُختبر على R2 من هذه الجلسة).

## 4. Staging المعزول (مختبر محلياً)

```bash
pnpm staging:env
```

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build --wait
```

- مشروع compose مستقل (`bahith-staging`) بشبكة ومجلدات خاصة، ومنفذ `127.0.0.1:3200`.
- البريد يُلتقط في Mailpit (`127.0.0.1:8225`) ولا يُرسل شيء حقيقي.
- الدفع معطل، وSMS غير متاح، والذكاء الاصطناعي غير مهيأ ما لم تُضف مفاتيح Staging.
- لاستخدام Neon/R2 بدلاً من الخدمات المحلية: ضع عناوينها في `.env.staging` وشغّل
  `migrate web jobs worker` فقط.

بناء الصور خلف وكيل بشهادة خاصة (كما في بيئة التطوير هذه):

```bash
docker build --secret id=extra_ca,src=/path/ca.crt -f docker/node.Dockerfile --target web .
```

الشهادة تُستخدم أثناء البناء فقط ولا تبقى في الصورة.

## 5. النشر Blue-Green على al-bahith.com

انظر `docs/DEPLOYMENT_GUIDE.md`. لا يُغيَّر DNS ولا Webhook تلغرام ولا بوابة الدفع الإنتاجية
دون موافقة صاحب المشروع.
