# خطة: اختبار شامل للبروكسيات + دعم SOCKS5 + إصلاح الهاتف

## الحالة: APPROVED (المستخدم وافق على التصميم)

## الملفات
- `ag-dashboard/proxy-tunnel.mjs` (جديد) — منطق النفق: http/https/socks5
- `ag-dashboard/test/proxy-tunnel.test.mjs` (جديد) — اختبارات node:test
- `ag-dashboard/server.mjs` — يستورد الوحدة، يضيف endpoints، CSS للهاتف، JS للواجهة

## المهام (TDD: RED → GREEN → REFACTOR)

### 1. وحدة النفق `proxy-tunnel.mjs` ✅
- [x] RED→GREEN: socks5 بلا مصادقة + atyp=3 (domain) + مصادقة user/pass + رفض
- [x] RED→GREEN: http CONNECT + Proxy-Authorization + رفض + unsupported scheme
- [x] RED→GREEN: https (TLS إلى البروكسي ثم CONNECT)
- [x] RED→GREEN: testProxy يعيد IP / يفشل بأسباب

### 2. وحدة المسبح `proxy-pool.mjs` ✅
- [x] checkPool: تقسيم ok/failed + progress + concurrency + probe يرمي
- [x] pruneFailed: يحذف الفاشل فقط + يرفض إفراغ المسبح
- [x] mutation check ×3 ⇒ الاختبارات تكشف الطفرات

### 3. نقاط API في `server.mjs` ✅
- [x] RED→GREEN: POST /api/proxies/test-all + GET status + POST prune + backup
- [x] RED→GREEN: guest ممنوع
- [x] mutation check ×3 ⇒ فعّالة
- [x] test-all/status محمية admin

### 4. واجهة اللوحة ✅
- [x] زر «🧪 اختبار الكل» + شريط تقدّم + جدول نتائج + زر «حذف الفاشل»
- [x] استعادة النتيجة بعد إعادة تحميل الصفحة (refreshCheckStatus)
- [x] تبويب يبقى في النطاق (لا يتجاوز أفقياً) — تحقّق: scrollW==clientW==412

### 5. إصلاح الهاتف (CSS) ✅
- [x] `body{width:100%;overflow-x:hidden}` + `min-width:0`
- [x] `word-break:break-all` لنصوص البروكسي (.pxurl)
- [x] `.row{flex-wrap:wrap}` + الأزرار تنزل سطراً < 520px
- [x] تبويبات 3 أعمدة + `text-overflow:ellipsis`
- [x] نفس المعالجة في GUEST_PAGE
- [x] تحقّق آلي: 0 عناصر تتجاوز الشاشة على viewport 412px

### 6. أخطاء اكتُشفت وأُصلحت أثناء الاختبار الحي
- [x] `ECONNRESET` غير مُعالَج ⇒ **سقوط السيرفر كلياً** (اكتُشف عند تشغيل 965 بروكسي)
- [x] `TLSSocket` "socket disconnected before secure TLS connection was established"
- [x] `process.on("uncaughtException"/"unhandledRejection")` كشبكة أمان أخيرة
- [x] عدّاد ok/failed كان يبقى صفراً أثناء الفحص ⇒ صار حيّاً

### 7. التحقق النهائي
- [x] 31/31 اختبار يمر (`node --test "test/*.test.mjs"`)
- [x] فحص حي على 965 ⇒ 93/88 سليم، والباقي فاشل (السيرفر لم يسقط)
- [x] prune ⇒ الملف يحتوي الناجح فقط + نسخ احتياطية (965 / 88 / 38 / 28)
- [x] prune idempotent: الضغط مرتين ⇒ `alreadyClean:true` بلا خطأ
- [x] قائمة الفاشل القديمة تُمسح بعد التنظيف ⇒ لا تظهر بعد إعادة تحميل الصفحة
- [x] تشغيل فعلي عبر البروكسي ⇒ opencode.ai يستجيب (الخطأ المتبقي `FreeUsageLimitError` 429 = حصة المجاني، لا خلل بروكسي)
- [x] الهاتف (viewport 412px): 0 عناصر تتجاوز الشاشة، scrollW==clientW، الأزرار تحت العناوين

### 8. الحالة النهائية للمسبح الحي
- المسبح الحالي: 28 بروكسي (17 http + 11 socks5) — مفعّل في `opencode.jsonc`
- ملاحظة: البروكسيات المجانية تتعطّل بسرعة (965 → 88 → 28 عبر فحوصات متتالية)
