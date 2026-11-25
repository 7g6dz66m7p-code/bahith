# دليل التشغيل: التطوير المحلي

## 1. التهيئة من نسخة نظيفة

```bash
pnpm install
```

```bash
pnpm bootstrap
```

```bash
docker compose up -d --wait
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

```bash
pnpm dev
```

- `pnpm bootstrap` ينشئ `.env` (غير مُتتبَّع) بكلمات مرور عشوائية. إعادة تشغيله لا تغيّر القيم الموجودة.
- `pnpm dev` يشغّل تطبيق الويب (المنفذ 3000) وعامل Python معاً.
- الخدمات المحلية تُنشر على `127.0.0.1` فقط: Postgres 5432، Redis 6379، MinIO 9000 (واجهة الإدارة 9001).

## 2. قاعدة البيانات

### دوران للاتصال

| المتغير              | الدور                        | الاستخدام                                  |
| -------------------- | ---------------------------- | ------------------------------------------ |
| `DATABASE_ADMIN_URL` | المالك/المدير                | الهجرات والبذر فقط                         |
| `DATABASE_URL`       | `bahith_app` (بلا BYPASSRLS) | التطبيق والعامل؛ يخضع لـRow-Level Security |

كود التطبيق يقرأ ويكتب البيانات البحثية حصراً عبر:

```ts
await database.withWorkspace(workspaceId, async (tx) => {
  return tx.select().from(schema.projects);
});
```

خارج `withWorkspace` لا يظهر أي صف من الجداول البحثية.

### إضافة هجرة

1. عدّل المخطط في `packages/db/src/schema/`.
2. ولّد SQL الصعود:

   ```bash
   pnpm --filter @bahith/db run generate --name=<short_name>
   ```

3. اكتب هجرة التراجع يدوياً في `packages/db/migrations/down/<tag>.sql` (إلزامي؛ التحميل يفشل دونها).
4. جدول جديد فيه بيانات بحثية يجب أن:
   - يحمل `workspace_id` عبر `workspaceIdColumn()` و`...tenantExtras('<table>', t)`؛
   - يستخدم مفاتيح أجنبية مركّبة `(workspace_id, x_id)` نحو الجداول البحثية الأخرى؛
   - يُضاف له في هجرة مخصصة (`generate --custom`): `GRANT` لدور `bahith_app` و`ALTER TABLE ... FORCE ROW LEVEL SECURITY`؛
   - يُضاف له صف في `packages/db/test/integration/fixtures.ts` (اختبار العزل يفشل إن لم تُغطَّ كل الجداول).
5. شغّل:

   ```bash
   pnpm --filter @bahith/db run test
   ```

   ```bash
   pnpm --filter @bahith/db run test:integration
   ```

لا تعدّل هجرة سبق تطبيقها: المشغّل يقارن checksum ويرفض. أضف هجرة جديدة (expand ← migrate ← contract).

### التراجع

```bash
pnpm db:rollback
```

### قواعد غير محلية

`pnpm db:migrate` و`db:rollback` و`db:seed` ترفض أي خادم غير `localhost` ما لم يُمرَّر `--allow-remote`. لا يُمرَّر هذا الخيار إلا بعد موافقة مكتوبة من صاحب المشروع (القاعدة الهندسية 5).

## 3. الاختبارات

| الأمر                   | يحتاج Docker | ماذا يختبر                                                                         |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `pnpm test`             | لا           | وحدة: حرّاس المخطط، مشغّل الهجرات، الإعدادات، الصحة، العامل                          |
| `pnpm test:integration` | نعم          | العزل (RLS) على كل الجداول، الهجرات صعوداً وتراجعاً، البحث العربي، المتجهات، الطابور |
| `pnpm test:e2e`         | لا           | Playwright بمشروعين: `ar` و`en`                                                    |

اختبارات التكامل تشغّل حاوياتها بنفسها (Testcontainers) ولا تمس قاعدة `docker compose`.

## 4. حل المشكلات

| العَرَض                                                         | السبب والحل                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Run "pnpm bootstrap" to create .env` عند `docker compose up` | لا يوجد `.env`. شغّل `pnpm bootstrap`.                                                             |
| `pre-commit: gitleaks is not installed`                       | ثبّت gitleaks (انظر README) ثم أعد الـcommit.                                                      |
| `/api/health` يُرجع 503                                        | الحقل `checks` يحدد الخدمة المتوقفة. تحقق من `docker compose ps` ومن تشغيل `pnpm db:migrate`.     |
| `password authentication failed for user "bahith_app"`        | تغيّرت كلمة المرور في `.env` بعد إنشاء الدور. أعد `pnpm db:migrate` (يعيد ضبطها).                  |
| `Migration ... was modified after it was applied`             | عُدّلت هجرة مطبَّقة. تراجع عن التعديل وأضف هجرة جديدة. محلياً فقط: `docker compose down -v` لبدء نظيف. |
| `Could not find a working container runtime strategy`         | Docker غير شغّال؛ اختبارات التكامل تحتاجه.                                                         |
| فشل سحب صورة MinIO                                            | الصورة المستخدمة بناء مجتمعي (`coollabsio/minio`) لأن `minio/minio` لم تعد تُنشر على Docker Hub.   |
