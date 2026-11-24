# IMPLEMENTATION STATUS — مصفوفة الميزات

الحالات: **VERIFIED** (مختبر فعلياً بأمر مذكور) / **IMPLEMENTED BUT UNVERIFIED** / **PARTIAL** / **BLOCKED** / **NOT IMPLEMENTED**.

| المجال          | الميزة                                                    | الحالة                     | الدليل / السبب                                                                    |
| --------------- | --------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| الحسابات        | تسجيل، تحقق بريد، دخول، استعادة، TOTP                     | VERIFIED                   | `e2e/auth.spec.ts`، `journey.spec.ts`                                             |
| الحسابات        | Google OAuth                                              | BLOCKED                    | لا مفاتيح Google                                                                  |
| الحسابات        | رقم هاتف + OTP (دخول/استعادة بالـSMS مغلقان)              | PARTIAL                    | مختبر تكاملياً؛ لا مزود SMS؛ واجهة الإدخال والفرض لم يُنفَّذا                         |
| الحسابات        | حذف الحساب وتصدير بياناته                                 | NOT IMPLEMENTED            | —                                                                                 |
| العزل           | RLS مفروض + فحص خدمات + اختبار عزل لكل مسار               | VERIFIED                   | `isolation.test.ts` (22 جدولاً)، `e2e/isolation.spec.ts`                           |
| الأعضاء         | دعوات بالبريد، أدوار، إزالة، مغادرة                       | VERIFIED                   | `members.test.ts`، `e2e/members.spec.ts`                                          |
| المكتبة         | رفع PDF/DOCX/TXT/صور، OCR عربي، كشف تكرار                 | VERIFIED                   | `e2e/library.spec.ts`، pytest                                                     |
| المكتبة         | مجموعات، تظليل بملاحظات، استيراد Zotero (CSL-JSON)        | VERIFIED                   | `collections.test.ts`، `e2e/organisation.spec.ts`؛ Zotero Web API غير متحقق شبكياً |
| سَنَد             | استخراج منطقي الترتيب، بحث نصي v2                         | VERIFIED                   | `pnpm eval` (Recall@10 100% على مجموعة صغيرة)                                     |
| سَنَد             | بحث دلالي/هجين                                            | IMPLEMENTED BUT UNVERIFIED | مختبر بمتجهات اختبارية؛ المزود بلا رصيد                                           |
| سَنَد             | تحقق حرفي من الاقتباس                                     | VERIFIED                   | قبول خاطئ 0/28                                                                    |
| سَنَد             | تحقق بالمعنى، كشف تعارض، قوة الدليل                       | IMPLEMENTED BUT UNVERIFIED | نموذج وهمي للاختبار فقط                                                           |
| سَنَد             | تتبع الطبعة/الجزء                                         | PARTIAL                    | الصفحات مخزنة؛ الطبعة/الجزء غير مُنمذجة بعد                                        |
| الوكيل          | إجابة مستندة لأدلة + امتناع + موافقة + حصة                | IMPLEMENTED BUT UNVERIFIED | لا تشغيل حقيقي (رصيد)                                                             |
| الوكيل          | أدوات: عناوين، إشكالية، خطة، فجوات، أسلوب                 | NOT IMPLEMENTED            | —                                                                                 |
| Gateway         | OpenAI/Anthropic، تصنيف أخطاء، حصص                        | PARTIAL                    | لا Gemini، لا fallback/streaming/تكلفة                                            |
| المحرر          | Tiptap، استشهاد، حواشٍ، نسخ، فروق، مراجعة مشرف             | VERIFIED                   | `editor.spec.ts`، `review.spec.ts`                                                |
| المحرر          | قوالب رسائل، خطوط/هوامش، توثيق عربي تقليدي                | NOT IMPLEMENTED            | قرار enum للأنماط مطلوب                                                           |
| الاستشهادات     | APA/Chicago/MLA (citation-js)                             | VERIFIED                   | 96 اختباراً؛ ترخيص citeproc بانتظار قرار                                           |
| التصدير         | DOCX/PDF/MD/LaTeX، BibTeX/RIS                             | VERIFIED                   | فحص XML العربي داخل DOCX                                                          |
| المصادر العلمية | Crossref/OpenAlex/S2/PubMed/arXiv/DOAJ/ORCID/Unpaywall    | VERIFIED                   | 83 اختباراً + تقييم حي: 100/100 حقيقي، 50/50 مختلق (Crossref)                      |
| النزاهة         | سجل استخدام AI (`agent_runs`)، ادعاءات بأدلتها            | VERIFIED                   | تكامل                                                                             |
| الإشعارات       | داخل التطبيق                                              | VERIFIED                   | `notifications.test.ts`، `e2e/notifications.spec.ts`                              |
| الإدارة         | إحصاءات مجمعة، حدود الخطط (أدمن + 2FA)                    | VERIFIED                   | `e2e/admin.spec.ts`                                                               |
| الإدارة         | إدارة مستخدمين، أخطاء، مهام خلفية، تكاليف                 | NOT IMPLEMENTED            | —                                                                                 |
| الاشتراكات      | حصص شهرية مغلقة افتراضياً، عرض الاستخدام                   | VERIFIED                   | `assistant.test.ts`، `admin.test.ts`                                              |
| الدفع           | طبقة مزود معطلة افتراضياً                                  | VERIFIED (معطلة)           | لا مزود ولا تفويض                                                                 |
| الدفع           | Webhooks، تفعيل تلقائي، مطابقة                            | NOT IMPLEMENTED            | المزود غير محدد                                                                   |
| الترحيل         | محرك ترحيل + Dry Run + مطابقة مالية + Rollback            | PARTIAL                    | 26+5 اختباراً على مخطط مفترض؛ المخطط الحقيقي مطلوب                                 |
| Telegram        | تحقق توقيع Login/WebApp (بلا تغيير البوت)                 | IMPLEMENTED BUT UNVERIFIED | مختبر بتوكن وهمي؛ جداول الربط بانتظار قرار                                        |
| الأمان          | رؤوس أمان، CSP، POST فقط، فحص Origin، Rate limit للمصادقة | VERIFIED                   | ZAP: 0 FAIL / 51 PASS                                                             |
| الأمان          | Prompt Injection                                          | VERIFIED                   | مجموعة ثابتة تفشل 10 حالات عند تعطيل الدفاعات                                     |
| التشغيل         | نسخ احتياطي واستعادة مُتحققة                               | VERIFIED                   | `backup.test.ts`                                                                  |
| التشغيل         | سجلات أخطاء بلا محتوى                                     | VERIFIED                   | اختبار وحدة                                                                       |
| التشغيل         | Sentry/OTel                                               | BLOCKED                    | لا DSN                                                                            |
| التشغيل         | Staging، Blue-Green، Dockerfiles                          | NOT IMPLEMENTED            | مزود الاستضافة غير محدد                                                           |
| الأداء          | k6 بـ50 مستخدماً                                           | PARTIAL                    | 0 أخطاء؛ p95 فوق العتبة (تشبّع حاوية مشتركة)                                       |
| الهوية البصرية  | أخضر، زجاجي، بنتو، RTL، داكن                              | PARTIAL                    | الأساس منفّذ؛ الحركة والصفحات الإضافية ناقصة                                       |
