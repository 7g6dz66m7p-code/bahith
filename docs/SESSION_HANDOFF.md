# SESSION HANDOFF — BAHITH

> اقرأ هذا أولاً. آخر تحديث: 2026-11-24.

## الحالة

- **آخر commit محلي:** `4cad1eb` على `claude/new-session-tv7vfk` (والفرع `feat/bahith-production-completion` مُنشأ عند النقطة نفسها).
- **GitHub:** الدفع مرفوض (403). الحساب المربوط `ahmbdr10-tech` بلا صلاحية كتابة على `7g6dz66m7p-code/bahith`. البعيد ما زال عند `9d8a20c`. توجد نسخة bundle مُتحقق منها أُرسلت للمالك (`…-4cad1eb.bundle`).
- **مزود الذكاء الاصطناعي:** مفتاح OpenAI محفوظ سراً شبكياً، لكن الحساب بلا رصيد (`credit_balance_exhausted`).

## عمل جارٍ في worktrees (لم يُدمج بعد)

| الفرع                              | المحتوى                                                             | الحالة |
| ---------------------------------- | ------------------------------------------------------------------- | ------ |
| `worktree-agent-a0cc97dccc96906b3` | الإشعارات (هجرة 0010 لديه)                                          | جارٍ    |
| `worktree-agent-ac0e5bcb485e43bed` | المجموعات والتظليل وZotero (هجرة 0011 لديه)                         | جارٍ    |
| `worktree-agent-a000f99bc4379f142` | `packages/migration`: ترحيل القاعدة القديمة (Dry Run) وجسر Telegram | جارٍ    |

**عند الدمج:** على main هجرة `0010_platform_admin` موجودة؛ أعد ترقيم هجرات الوكلاء (احذف ملفات SQL/snapshot/journal المولدة، أعد `drizzle-kit generate` فوق main، أعد إلحاق GRANT/FORCE RLS يدوياً، وحدّث `migrator.test.ts` و`migrations.test.ts` و`isolation.test.ts` و`schema.test.ts`).

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

## المتبقي (بالأولوية)

1. دمج الوكلاء الثلاثة واختبار الكل.
2. رقم الهاتف الإجباري + OTP (واجهة مزود محايدة، معطلة حتى اختيار مزود SMS).
3. الدفع: Webhooks موقعة، تفعيل تلقائي idempotent، مطابقة مالية (مزود غير محدد بعد).
4. Dockerfiles + Staging + Blue-Green (مزود الاستضافة غير محدد).
5. Gateway متعدد المزودين (Gemini، fallback، streaming، تتبع التكلفة).
6. الأداء تحت الحمل (تشبّع عملية Node واحدة) — اختبار 10/50/100 على عتاد مناسب.
7. الوكيل متعدد الأدوات (العناوين، الإشكالية، الخطة، الفجوات…).

انظر `IMPLEMENTATION_STATUS.md` للمصفوفة الكاملة.
