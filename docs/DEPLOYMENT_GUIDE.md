# DEPLOYMENT GUIDE (مسودة — مزود الاستضافة غير محدد)

الهدف: النشر على `https://al-bahith.com/` دون تعطيل المنصة القديمة، ولا تغيير DNS أو Webhook تلغرام أو بوابة الدفع إلا بموافقة المالك.

## المكونات

web (Next.js `next start`)، jobs (Node: ingest + embed)، worker (Python + Tesseract ara/eng)، Postgres 16 + pgvector، Redis 7، تخزين S3/R2، SMTP.

## التسلسل المقترح (Blue-Green)

1. Staging معزول (قاعدة/تخزين منفصلان) — `pnpm db:migrate` ثم `pnpm db:plan-limits` ثم اختبار دخان ورحلة `journey.spec.ts` مقابل Staging.
2. بيئة Green للإنتاج بجانب المنصة القديمة (Blue) على نطاق فرعي داخلي.
3. ترحيل البيانات: Dry Run ← مراجعة ← تطبيق ← تحقق (`docs/runbooks/legacy-migration.md` عند دمجه) ← مزامنة الفرق.
4. التحويل: تغيير DNS/الوكيل إلى Green **بموافقة المالك فقط**، مع إبقاء Blue جاهزاً للرجوع.
5. الرجوع: إعادة توجيه الحركة إلى Blue؛ القاعدة الجديدة لا تكتب في القديمة.

## النسخ الاحتياطي

`docs/runbooks/backup-restore.md` (مختبر).

## مطلوب من المالك

مزود الاستضافة، أسرار الإنتاج، SMTP، مزود SMS، بوابة الدفع، تفويض الدفع الحي، صلاحية GitHub.
