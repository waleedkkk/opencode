# خطة: تبديل البروكسي تلقائياً عند خطأ opencode.ai (Failover)

## الحالة: ✅ منجزة ومتحقَّق منها حيّاً — ومُصحَّحة بعد القياس الفعلي (2026-11-05)

## القرارات (من الموافقة)
- **الحجر مؤقت** — لا حذف من `opencode_proxies.json`
- **حتى 5 بروكسيات** في كل طلب
- **مدة الحجر: ساعة**
- **قسم «🔒 محجور (N)»** في اللوحة + زر «↩ إرجاعهم للمسبح»

## التصحيح الحاسم (بعد القياس على IP المستخدم نفسه)
الاستنتاج القديم «429 = حصة هذا الـIP ⇒ احجره وبدّل» **خطأ**. القياس الفعلي:
- من IPك المخصّص (`169.58.168.184`، فرنسا) وبحزمة Bun الحقيقية ⇒ 7 نماذج أعطت **429** و2 أعطت **403** و1 أعطت **400**.
- 40+ IP خروج مختلف (18 مجانية + 10 Decodo + 12 مزروعة) ⇒ **صفر 200**، وكلها 429 بـ`retry-after` واحد.
- الاستخراج من `opencode.db`: **0 رسائل assistant** لمزوّد opencode في 3–5 نوفمبر، بينما 47–111 رسالة/يوم في 26–29 أكتوبر.

⇒ الـ429 يأتي من **حوض مجهول مشترك** (`Bearer public`) وليس من عدّادك، ومدة `retry-after` هي وقت التصفير اليومي (00:00 UTC). لذلك:

| الخطأ | مرتبط بالـIP؟ | السلوك الصحيح |
|---|---|---|
| `403` «not available in your country» | **نعم** (بوابة بلد/نموذج) | حجر هذا البروكسي + بدّل (IP آخر قد يمرّ) |
| `429` `FreeUsageLimitError` | **لا** (الحوض مشترك) | **فشل فوري** بلا حجر وبلا تبديل، وتمرير `retry-after` إلى العميل |
| طلبات مصادَقة (`Authorization ≠ public`) | — | **Decodo فقط** (لا بروكسي مجهول يرى المفتاح) |

## المهام (TDD: RED → GREEN) — الكل ✅

### 1. وحدة `proxy-failover.mjs` — مخزن الحجر
- [x] إضافة/استعلام/انتهاء/تحرير/بقاء بعد إعادة التشغيل/ملف تالف

### 2. وحدة `proxy-policy.mjs` (جديدة) — مصدر الحقيقة الوحيد للتصنيف
- [x] `classifyUpstream`: 429 ⇒ `fail-fast` (بلا حجر) · 403 بلد ⇒ `poison` · غير ذلك `ok`
- [x] `isPersonalKeyRequest`: `Bearer public` ⇒ مجهول، أي رمز آخر ⇒ شخصي
- [x] `selectProxiesForRequest`: الطلب الشخصي محصور في المضيفين الموثوقين (`host` أو `host:port`)

### 3. `server.mjs`
- [x] `forwardViaProxy` يعيد `fail-fast` ⇒ العميل يرى 429 الحقيقي + `retry-after` + لا حجر
- [x] `403` ⇒ حجر + تبديل (سلوك سابق محفوظ)
- [x] `ocBodyText` يفكّ **zstd** أيضاً (gzip/deflate/br موجودة)
- [x] الطلب المصادَق يذهب إلى Decodo فقط؛ بلا Decodo ⇒ 503 **بلا** اتصال بأي بروكسي مجهول

### 4. API + الواجهة
- [x] `GET /api/proxies/quarantine`
- [x] `POST /api/proxies/quarantine/clear`
- [x] قسم «🔒 محجور (N)» + زر الإرجاع + عدّاد «(4 محجور)»

### 5. التحقق النهائي
- [x] **70/70** اختبار يمر (`node --test "test/*.test.mjs"`)
- [x] اختبارات جديدة: 8 على مستوى الخادم + 11 على مستوى الوحدة

## ملاحظات تشغيلية
- الخطأ الحقيقي من opencode.ai هو `RegionError` / 403 «This model is not available in your country».
- فحص «اختبار كل البروكسيات» يفحص IP فقط (api.ipify.org) ⇒ لا يكشف الحظر الجغرافي؛ الحجر أثناء التشغيل هو ما يكشفه.
- متغيّرات بيئة: `AG_OC_INFERENCE_BASE`، `AG_OC_TARGET_INSECURE`، `AG_PROXY_QUARANTINE_FILE`، `AG_OC_MAX_TRIES`، `AG_OC_QUARANTINE_TTL_MS`، `AG_OC_TRUSTED_PROXY_HOSTS` (افتراضي `dc.decodo.com`)، `AG_OC_TRUSTED_PROXY_ENTRIES` (تضييق `host:port`).
- ربط الحساب الرسمي: `POST /api/integration/opencode/connect/key` (سيرفر OpenCode) أو `opencode auth login opencode --method device`.
