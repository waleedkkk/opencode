# خطة: ربط حساب opencode.ai + سياسات اللوحة

الحالة: المرحلة 1 جاهزة (بانتظار خطوة بشرية واحدة) · المرحلة 2 منجزة ومطبَّقة حيّاً.

## المرحلة 1 — الربط
- [x] اكتشاف المسار الرسمي: `POST /api/integration/{integrationID}/connect/key` ⇒ 204 + صفّ `credential`
- [x] اكتشاف المسار الرسمي: `opencode auth login opencode --method device` ⇒ رابط `opencode.ai/console/device?user_code=...`
- [x] التأكد أن `opencode.db` مشترك بين المضيف والحاوية (نفس inode 267876) ⇒ ما يُكتب يقرأه السيرفر
- [x] تنظيف صفّ الاختبار الوهمي ⇒ الحالة رجعت `apiKey:"public"`
- [x] سكربت `apply-opencode-key.mjs` للتحقّق والحقن
- [x] **الرابط يعمل**: يفتح ⇒ `console/login?next=…&reason=device` ⇒ Google / GitHub / Email
- [ ] **بانتظار المستخدم**: يفتح الرابط ويوافق ⇒ يُكتب الاعتماد في `credential`
- [ ] بعد الموافقة: التحقق أن `/api/provider` يعرض الاعتماد بدل `public` + اختبار 200 حقيقي

⚠️ رموز device قصيرة العمر (تنتهي خلال دقائق). عند انتهائها يُعاد توليد الكود فوراً.

## المرحلة 2 — سياسات اللوحة (TDD: RED → GREEN) ✅
قاعدة: `Authorization ≠ public` ⇒ Decodo فقط (لا يمرّ المفتاح الشخصي على بروكسي مجهول).

- [x] RED→GREEN: `classifyUpstream` ثلاثي (`ok | fail-fast | poison`)
- [x] RED→GREEN: 429 ⇒ فشل فوري بلا حجر/تبديل + تمرير `retry-after`
- [x] RED→GREEN: 403 بلد ⇒ حجر + تبديل
- [x] RED→GREEN: طلب مصادَق ⇒ Decodo فقط · بلا Decodo ⇒ 503 بلا اتصال
- [x] RED→GREEN: body مضغوط zstd ⇒ يُفكّ ويُكتشف
- [x] تحديث الاختبارات القديمة التي كانت تُجمّد السلوك القديم
- [x] الحزمة كاملة: **70/70** (`node --test "test/*.test.mjs"`)
- [x] `PLAN-PROXY-FAILOVER.md` مُصحَّح بالاستنتاج المُقاس

## التحقق الحيّ (بعد إعادة تشغيل اللوحة)
- [x] 429 ⇒ `HTTP 429` + `retry-after: 34350` وصل للعميل + بلا حجر جديد
- [x] مفتاح شخصي ⇒ يمرّ بـ Decodo فقط + لا حجر

## ملاحظة مهمّة
مزوّد `opencode` في `opencode.jsonc` **لا يمرّ عبر اللوحة** حالياً (لا يحتوي `opencode-proxy/v1`)
⇒ طلباته تذهب مباشرةً إلى `opencode.ai` من IP السيرفر (فرنسا) ⇒ 403 للنماذج المحجوبة أوروبياً.
عند ربط الحساب: إن أُريد تجاوز 403 ⇒ تفعيل «البروكسي السكني» من اللوحة (Decodo) ليمرّ الطلب من IP أمريكي.

---

# النتيجة النهائية (2026-11-06) — الربط نجح، والحصة المجانية مشتركة ومنهكة

## المرحلة 1 — الربط ✅ أُنجزت بالكامل
- [x] موافقة المستخدم على رابط الجهاز ⇒ `◆ Connected to OpenCode Console`
- [x] الاعتماد كُتب في `credential`: `cred_1ad6153d5001oTgfunT1eVCWH5` (type=oauth, methodID=device,
      label=Personal, email=walleed372@gmail.com, orgID=org_01M6PP27BV5PV9R5PYXT2W7KHB)
- [x] `GET /api/integration` ⇒ `opencode[connected]` · `GET /console/api/user` ⇒ 200
- [x] access token صالح حتى `2026-12-05T20:23:18Z` (refresh token ≠ bearer ⇒ 401)

## الدليل الحاسم على استخدام الحساب (ترويسات مقنّعة من لوحة `AG_OC_DEBUG_HEADERS=1`)
```
authorization: Bearer st_2f38d87b-ddda-…      ← التوكن الشخصي (لا "public")
user-agent   : opencode/latest/2.2.5/cli
x-opencode-session: ses_e51c7507bffeBuG0i1IBjksFCv
x-opencode-org-id / x-opencode-client / x-session-affinity …
```
⇒ الطلب يخرج من السيرفر **مُصادقاً بحسابك** (وليس بالمجهول).

## تمرير المزوّد عبر Decodo (تجاوز الحظر الجغرافي) ✅
- [x] `POST /api/proxies/toggle {enabled:true}` ⇒ `opencode.options.baseURL = http://127.0.0.1:8899/opencode-proxy/v1`
- [x] إعادة تشغيل الحاوية (الإعداد يُقرأ مرة واحدة) ⇒ PID 1 بدأ `2026-11-05T23:29:15Z`
- [x] `crouton-alpha-free` من IP فرنسا ⇒ 403 RegionError · من Decodo US ⇒ **0 × 403** (كلها 429/200)
- [x] صفر حجر جديد على 429 (fail-fast كما صُمّم)

## لماذا «انتهت حصتي» — الاستنتاج المُقاس
| القياس | النتيجة |
|---|---|
| التوكن الشخصي ⇒ `/inference/v1/models` | **200** · 39 نموذجاً (مقابل 80 عامة) |
| التوكن الشخصي ⇒ `/console/api/user` | 200 (walleed372@gmail.com, role=user) |
| النماذج المجانية (9 في حسابك) | **429 FreeUsageLimitError** |
| نفس النماذج بـ `Bearer public` | 429، **بنفس `retry-after`** ⇒ نفس العدّاد |
| نافذة التصفير | **00:00 UTC** (`retry-after` ينقص بالثانية حتى 00:00 ثم يعود ≈24h) |
| بعد التصفير بـ6 ثوانٍ (00:00:06) | 429 بـ`retry-after=86394` ⇒ النافذة الجديدة **منهكة فوراً** |
| النماذج المدفوعة (`glm-5.3-flash`, `deepseek-v4.1-flash`) | **402 Insufficient account funds** (لا رصيد) |
| مسح **46** نموذجاً مجانياً (models.dev) عبر Decodo | 0 × 200 · 9 × 429 · 37 × 400 «Model is unavailable» (غير متاحة لهذه الطبقة) |
| مسح 132 نموذجاً في models.dev | نقطة النهاية المستخدمة **رسمية**: `https://opencode.ai/inference/openai/v1` |

⇒ الحصة المجانية **حوض يومي مشترك** (يتبع `public` وtokenك الشخصي معاً) ويشبع عالمياً خلال ثوانٍ من 00:00 UTC.
⇒ الربط لم يمنح حصة شخصية للطبقة المجانية؛ الأثر الحقيقي للربط: 39 نموذجاً في الكتالوج + هوية مُصادَقة + Go/rصيد قابل للتفعيل.

## الحل المتبقّي (بلا تكلفة ⇒ ينتظر؛ بتكلفة ⇒ يعمل)
- [ ] **Go $10/شهر** (Go Plus $40) — 38 نموذجاً في models.dev باسم المزوّد `opencode-go`
      (`https://opencode.ai/inference/go/openai/v1`) · حدود: MiMo-V2.6-Flash 30,100 طلب/5س،
      DeepSeek V4.1 Flash 43,330/5س، Beam Free غير محدود · regions: أوروبا + أمريكا
- [ ] **رصيد Console** (Pay-as-you-go) ⇒ يزيل 402

## المسبار الحيّ (مُشغَّل داخل الحاوية، يكتب في `/root/.local/share/opencode/free-pool-probe.jsonl`)
`node /workspace/ag-dashboard/probe-free-pool.mjs watch 24 300` — كل 5 دقائق: فلنت عبر Decodo + فلنت مباشر من فرنسا
+ كراوتون عبر Decodo + فلنت بمفتاح `public` ⇒ يرصد أي نافذة حرة تتاح.
آخر قياس 00:25 UTC: 25 سطراً، **0 × 200** (لا نموذج مجاني يخدم الآن).

---

# 2026-11-06 · السبب الجذري المؤكَّد: الوسيط كسر الحصة (ليست حصة منتهكة)

## المختبر الضابط (`opencode-lab`)
صورة رسمية `ghcr.io/anomalyco/opencode:2.2.5` (digest مطابق=live) · بلا mounts (إعداد نظيف) · `ag-net` · `OPENCODE_API_KEY=<st_…>`.

## البرهان: المتغيّر الوحيد = **من يصدر الطلب الأخير**
نفس البايتات · نفس الترويسات · نفس التوكن · نفس الـIP (`169.58.168.184`) · نفس اللحظة:

| مسار الطلب الأخير | النتيجة |
|---|---|
| Bun (عميل opencode الرسمي) → `opencode.ai` مباشرة | ✅ **200** (`PONG`، tokens حقيقية) |
| Bun → وسيط Node → `opencode.ai` | ❌ 429 `provider.free-limit` |
| Node/undici → `opencode.ai` مباشرة | ❌ 429 (نفس `retry-after`) |
| curl `--http2` / `--http1.1` → `opencode.ai` مباشرة | ❌ 429 |

إثبات داخل **نفس الحاوية وبدون إعادة تشغيل** (تغيير `baseURL` فقط):
`direct ⇒ 200` · `⇒ 429` · `direct ⇒ 200` ⇒ النقل هو السبب السببي.

⇒ **السبب الجذري:** `provider.opencode.options.baseURL` كان `http://127.0.0.1:8899/opencode-proxy/v1`،
ولوحتنا (Node `https.request`) كانت **تعيد إصدار الطلب** ⇒ الطلب لم يصدر من عميل opencode الرسمي ⇒ opencode.ai
رفض طبقة الحصة المجانية (`FreeUsageLimitError`، `retry-after` حتى 00:00 UTC). لم تكن الحصة منتهكة.

## الإصلاح المطبَّق على الإنتاج (2026-11-06 ~21:30 UTC)
- [x] `provider.opencode.options.baseURL` ⇒ `https://opencode.ai/inference/openai/v1` (مباشر)
      (نسخة احتياطية: `opencode.jsonc.bak-before-direct-baseurl-20261106-215040`)
- [x] `model` افتراضي على المستوى الأعلى ⇒ `opencode/flint-40b-free` (قبلها: لا يوجد ⇒ الحساب يختار `crouton-alpha-free` المحجوب جغرافياً)
- [x] **بلا إعادة تشغيل** — الإعداد يُحمَّل فورياً (مُثبت: `baseURL` تغيّر والطلبات تغيّر سلوكها)
- [x] تحقّق إنتاجي: `opencode run -m opencode/flint-40b-free` ⇒ `PONG` · جلسة جديدة بلا نموذج ⇒ `opencode/flint-40b-free` ⇒ `PONG`

## المصفوفة الحيّة (10 نماذج مجانية، من فرنسا، Bun مباشر)
| النموذج | النتيجة |
|---|---|
| `flint-40b-free` | ✅ PONG |
| `nemotron-3.5-super-vl-free` | ✅ PONG |
| `nemotron-3.5-lightning-free` | ✅ PONG |
| `beam-free` | ✅ PONG |
| `mimo-v2.6-flash-free` | ✅ PONG |
| `deepseek-v4.1-flash-free` | ✅ PONG |
| `glm-5.3-flash-free` | ✅ PONG |
| `crouton-alpha-free` | ❌ 403 «not available in your country» |
| `pulse-alpha-free` | ❌ 403 «not available in your country» |
| `muse-spark-1.3-contributor-free` | ❌ 400 «Model is unavailable» |

## قواعد دائمة (مستفادة)
1. **لا تمرّر طلبات مزوّد opencode عبر أي وسيط يعيد إصدارها** (لوحتنا/Decodo-http/MITM) ⇒ 429 فوري.
2._proxy الوحيد المسموح = **نفق CONNECT** (`HTTPS_PROXY`) ⇒ Bun ينفّذ TLS بنفسه (مُثبت في المختبر: Bun+Decodo ⇒ 200).
3. التشخيص بـ Node/curl **لن يعكس** ما يراه العميل الحقيقي ⇒ أي قياس 429 عبر node = artefact لا نتيجة.
4. المسبار (`probe-free-pool.mjs`) يقيس بـ node ⇒ غير صالح كمرجع بعد هذا الاكتشاف.

---

## سكربت نفق CONNECT (جاهز، غير مُنفَّذ — 2026-11-07)

الملفات (على المضيف):
`/root/opencode-docker/workspace/ag-dashboard/recreate-opencode-with-proxy.{mjs,sh}`

لماذا recreate؟ `POST /containers/{id}/update` **لا يدعم `Env`** (مُتحقَّق: 200 مع تجاهل الحقل) ⇒ لا طريق آخر.

### ما يفعله السكربت
1. يلتقط مواصفات الحاوية الحالية كاملة (image · cmd/entrypoint · env · ports · networks · mounts · restart · exposed ports).
2. **pre-flight**:.Container لازم يكون `running` **وصحيّ** قبل أي تغيير.
3. يوقف الحاوية ⇒ يعيد تسميتها `opencode-server-pre-proxy-<ts>` (نسخة احتياطية متوقفة، **لا تُحذف**).
4. ينشئ حاوية جديدة بنفس المواصفات + `HTTPS_PROXY/HTTP_PROXY/NO_PROXY/no_proxy` (Decodo افتراضياً من `opencode_proxies.json`).
5. يشغّلها ⇒ **فحص صحة** حتى 90 ثانية على `/api/provider` (200) ⇒ عند الفشل: **تراجع تلقائي** (حذف الجديدة + إعادة تسمية القديمة + تشغيلها).
6. يطبع الـIPs الجديدة (تنبيه إن تغيّر `ag-net` 172.25.0.2) + أمر التراجع.

### أوامر الاستخدام (من المضيف)
```bash
cd /root/opencode-docker/workspace/ag-dashboard

# 1) معاينة بلا تغيير
./recreate-opencode-with-proxy.sh --dry-run

# 2) التنفيذ + اختبار حقيقي (يعمل بـCONNECT ⇒ يفكّ الحظر الجغرافي)
./recreate-opencode-with-proxy.sh --keep-ip --smoke opencode/crouton-alpha-free

# 3) التراجع إن لزم
./recreate-opencode-with-proxy.sh --rollback
```
إن لم يكن `node` على المضيف، الغلاف يشغّله داخل حاوية مساعدة عبر docker socket.
**ممنوع تشغيله من داخل `opencode-server`** (السكربت يرفض ذلك: الحاوية تتوقف أثناء العملية) ⇒ الجلسة الحالية تنتهي عند التنفيذ، والخدمة تعود بعد ~10–30 ثانية.

### نتائج الاختبار (على حاوية اختبار، الإنتاج لم يُمَس)
| المرحلة | النتيجة |
|---|---|
| `--dry-run` |.payload صحيح ( networks/ports/mounts/env مطابقة) |
| pre-flight | healthy ✓ (200) |
| stop → rename → create → start | ✓ 4/5 |
| health بعد التشغيل | ✓ 200 (baseURL مباشر) |
| smoke `opencode/crouton-alpha-free` | ✓ **PONG** (كان 403 ⇒ النفق يفكّ الحظر) |
| `--rollback` | ✓ حاوية الوكيل حُذفت · الأصلية استُعيدت · 200 |

---

## خطأ «This version of Antigravity is no longer supported» — السبب الجذري والإصلاح (2026-11-07)

### السؤال: لماذا كان يعمل أمس وما الذي حدث؟
**لم يتغيّر شيء من جانبنا** (ملفات البلUGIN آخر تعديل 2026-11-04، الحسابات 2026-11-04؛
الإعداد الوحيد المتغيّر 2026-11-06 وهو `baseURL` لمزوّد opencode.ai ولا علاقة له بـAntigravity).
**Google هي التي سحبت هوية العميل من جهتها** بين `2026-11-05T23:35:21Z` (آخر ردّ حقيقي)
و`2026-11-07T20:29:33Z` (أول نص إهمال).

### الدليل (تحكّم تجريبي أحادي المتغيّر — نفس الـbody/التوكن/الحساب/المضيف)
| المتغيّر | النتيجة |
|---|---|
| UA `Antigravity/1.18.3` (القديم) | HTTP 200 لكن جسم SSE = **نص الإهمال** |
| UA `1.19.0` / `1.20.0` / `1.50.0` / `1.99.0` / `1.99.99` | ❌ نص الإهمال |
| UA `Antigravity/2.0.0` / `2.29.0` | ✅ **ردّ نموذج حقيقي** (`PONG`) |
| بلا هوية Antigravity إطلاقاً | HTTP 403 «You do not have a valid license» |

⇒ **الحدّ بالضبط = النسخة الرئيسية 2.x** ⇒ Google تحقّق من النسخة داخل الـUA رغم أن رسالة الخطأ
تقول «حمّل أحدث نسخة» (نسخة App الرسمية الآن **2.29.0**، وCLI الرسمي **1.5.3**).

### تغيّر ثانٍ في بروتوكول Google (مُثبت بـ400 INVALID_ARGUMENT)
`metadata.platform` لم يعد يقبل `MACOS` (nor `PLATFORM_MACOS/WINDOWS/LINUX/DARWIN`) —
القيمة الوحيدة المقبولة اليوم: **`PLATFORM_UNSPECIFIED`**.

### لماذا بدا الخطأ «نجاحاً» في السجل؟
البلUGIN كان يسجّل `<-200 text/event-stream` **دون فحص الجسم** ⇒ نص الإهمال مرّ كأنه ردّ
نموذج ⇒ `finish=error` + `provider.invalid-output` في opencode.

### الإصلاح المطبَّق (`/root/.config/opencode/plugins/antigravity/index.js`)
1. `USER_AGENT`: `Antigravity/1.18.3` ⇒ **`Antigravity/2.29.0`**.
2. `CLIENT_METADATA.platform`: `MACOS` ⇒ **`PLATFORM_UNSPECIFIED`**.
3. كاشف جديد: `detectDeprecationNotice(text)` + `inspectSseBody(body)` — يقرأ رأس الـSSE
   ويحوّل نص الإهمال إلى **خطأ 400 واضح** بدل «نجاح» كاذب.
   (بلا `clone()+cancel()` لأن إلغاء فرع tee يجمّد الـcomposite promise ⇒ تعليق الطلب.)
4. نسخة احتياطية: `index.js.bak-before-identity-20261107`.
5. اختبار: `test/antigravity-identity.test.mjs` (7 اختبارات) — **77/77** إجمالاً.

### التحقق
| الفحص | النتيجة |
|---|---|
| `opencode run -m antigravity/gemini-3.8-flash` | ✅ **PONG** (مرّتين) |
| E2E على استجابات Google الحقيقية (2.29.0) | `notice:false` + `PONG` |
| E2E بهوية 1.18.3 | `notice:true` ⇒ خطأ 400 واضح |
| إعادة تحميل البلUGIN | تلقائية (watcher) — بلا restart |

---

## هوية العميل في ملف تهيئة (2026-11-08)

### لماذا؟
Google تحقّق من نسخة العميل من الـUA. عند رفع Google الحدّ كان يتطلّب **تعديل كود**
في **موقعين** (البلUGIN + اللوحة). الآن التحديث = **تعديل ملف واحد**.

### الملفات
| الملف | الدور |
|---|---|
| `/root/.config/opencode/antigravity-identity.json` | **المصدر الوحيد** للهوية (UA + api-client + metadata) |
| `/root/.config/opencode/antigravity-identity.mjs` | الوحدة المشتركة: قراءة + fallback + تحذيرات |
| `/root/.config/opencode/plugins/antigravity/index.js` | يستهلك الوحدة (الدالة `currentIdentity()`) |
| `/workspace/ag-dashboard/server.mjs` | يستهلك الوحدة (`AG_HEADERS()`) |

### التحديث (بلا كود، بلا restart)
```bash
# 1) اعرف النسخة الرسمية الحالية
curl -s https://antigravity.google/download | grep -oE "data-hub-latest-version>v[0-9.]+" | head -1

# 2) عدّل سطر userAgent في الملف
nano /root/.config/opencode/antigravity-identity.json

# 3) تحقّق (ينعكس فوراً — لا إعادة تشغيل)
opencode run -m antigravity/gemini-3.8-flash "Reply with exactly: PONG"
```

### السلوك المُضمون
- **fallback:** لو الملف مفقود/فاسد ⇒ القيم المدمجة (2.29.0) + تحذير في السجل. لا انهيار.
- **fallback جزئي:** حقل تالف وحده ⇒ يُستبدل فقط؛ الباقي يبقى من الملف.
- **تحذير النسخة القديمة:** نسخة رئيسية < 2 ⇒ تحذير صريح (Google سيردّ بنص الإهمال).
- **تحذير مرة واحدة:** كل تحذير distinct يُسجَّل مرة واحدة فقط (لا تكرار مع كل طلب).

### التحقق المُنفَّذ
| الفحص | النتيجة |
|---|---|
| `node --test "test/*.test.mjs"` | ✅ **91/91** (14 اختبار هوية جديد) |
| `opencode run -m antigravity/gemini-3.8-flash` | ✅ PONG |
| اللوحة `/api/test` (daily) | ✅ 200 ok=true (كان نص إهمال قبل الإصلاح) |
| hot-update: نسخة قديمة في الملف ⇒ اللوحة القائمة | ❌ نص إهمال فوراً ⇒ **إثبات القراءة الحيّة** |
| hot-update: نسخة جديدة ⇒ انعكاس فوري | ✅ |
| إعادة تشغيل اللوحة | مرة واحدة (PID 112356 → جديد) — اللاحق بلا restart |

### نسخ احتياطية
- `server.mjs.bak-before-identity-20261108`
- `plugins/antigravity/index.js.bak-before-identity-20261107`

---

## تشخيص «Crouton Alpha Free غير متاح في بلدي» + الحل (2026-11-08)

### العَرَض
`opencode/crouton-alpha-free` ⇒ `403 RegionError: This model is not available in your country`
(وسائر النماذج المجانية تعمل).

### التشخيص (بتحكّم أحادي المتغيّر)
| الفحص | النتيجة |
|---|---|
| عنوان خروج الـVPS | `169.58.168.184` = **FR** (Contabo) ⇒ crouton محجوب جغرافياً |
| عنوان خروج بروكسي سكني | `192.177.124.138` = **US / California** ⇒ القيد الجغرافي يُرفع |
| Bun (عميل opencode) مباشر ⇒ flint | ✅ PONG |
| Bun عبر `/opencode-proxy` (Node) ⇒ flint | ❌ 429 |
| Node مباشر بنفس الترويسات ⇒ flint | ❌ 429 |

⇒ **opencode.ai يميّز النقل**: TLS من Node ⇒ `429 FreeUsageLimitError`، وTLS من Bun ⇒ `200`.
لذلك مسار `/opencode-proxy` في اللوحة (ينهي TLS في Node) **لا يصلح** لمزوّد opencode.ai المجاني.

### الخلل الثاني: مفتاح `options` مكرر في `opencode.jsonc`
```jsonc
"opencode": {
  "options": { "baseURL": "http://127.0.0.1:8899/opencode-proxy/v1" },  ← الأول (يُهمَل)
  "options": { "baseURL": "https://opencode.ai/inference/openai/v1" }     ← الأخير (يسود)
}
```
محلل JSONC في opencode يجعل **الأخير** فائزاً (إثبات: منفذان 7801/7802 ⇒ الطلب وصل 7802).
و`isOcProxyEnabled()` في اللوحة مجرد بحث نصّي ⇒ يعرض «مفعّل» كاذباً.

### الحل المطبَّق: نفق CONNECT على مستوى الحاوية
`HTTPS_PROXY`/`HTTP_PROXY` في بيئة الحاوية ⇒ Bun نفسه يفتح TLS (يبقى كاملاً)
⇒ يخرج من عنوان سكني أمريكي ⇒ **crouton يعمل**.

```bash
# من حاوية مساعدة (لا تُشغّله من داخل الحاوية الهدف):
node /workspace/ag-dashboard/recreate-opencode-with-proxy.mjs \
     --keep-ip --smoke opencode/crouton-alpha-free
# rollback: node recreate-opencode-with-proxy.mjs --rollback
```
> `POST /containers/<id>/update` يتجاهل `Env` (مُتحقَّق) ⇒ إضافة متغيّر env تتطلّب recreate.
> الـbind mounts تحمي `opencode.jsonc` والبلGIN والبيانات ⇒ لا wipes.
> بعد الـrecreate: `sh /workspace/ag-dashboard/restore-container-env.sh` (يُثبّت node ويُشغّل اللوحة).

### التحقق بعد التنفيذ (كلها بأرقام)
| الفحص | النتيجة |
|---|---|
| `opencode run -m opencode/crouton-alpha-free` | ✅ **PONG** (كان 403 RegionError) |
| `opencode run -m opencode/flint-40b-free` | ✅ PONG |
| `opencode run -m antigravity/gemini-3.8-flash` | ✅ PONG (البلGIN سليم) |
| اللوحة `/api/test` (Antigravity daily) | ✅ 200 ok=true (2058ms) |
| `https://opencd.duckdns.org` | ✅ 200 |
| عناوين الحاوية | ag-net=172.25.0.2 · hermes=172.27.0.3 · mcp=172.26.0.3 · default=172.22.0.3 (بلا تغيير) |
| حاوية احتياطية | `opencode-server-pre-proxy-20261108T105710` (متوقّفة، للتراجع) |

### ملاحظات
- `HTTPS_PROXY` affects Bun traffic (خادم opencode + البلGIN)؛ طلبات Node (اللوحة) تبقى مباشرة.
- `NO_PROXY` يشمل `localhost,127.0.0.1,::1,opencode-server,omniroute,opencd.duckdns.org`.
- المبدّل في اللوحة (`/api/proxies/toggle`) يبقى بلا فائدة لمزوّد opencode.ai ⇒ يحتاج إعادة تصميم.

---

## اللوحة تتحكم بالبروكسي الحقيقي (2026-11-08)

### لماذا تغيّرت اللوحة
المسار القديم (`/opencode-proxy` داخل اللوحة) **لا يصلح** لمزوّد opencode.ai:
| النقل | النتيجة |
|---|---|
| Bun (عميل opencode) عبر اللوحة (Node ينهي TLS) | ❌ `429 FreeUsageLimitError` |
| Bun عبر نفق CONNECT (TLS من العميل) | ✅ `200` |

⇒ النفق lives في `env` الحاوية (`HTTPS_PROXY`) ⇒ تغييره = **recreate** (Docker's `update` يتجاهل `Env`).

### ما تغيّر
| الملف | التغيير |
|---|---|
| `oc-container-proxy.mjs` (جديد) | قراءة الحالة الحقيقية من الحاوية + تشغيل مساعد إعادة الإنشاء + `buildHelperArgs`/`parseProxyEnv`/`maskProxyUrl` |
| `server.mjs` | `isOcProxyEnabled()` صار **قراءةً من الحاوية** (كان بحثاً نصّياً = «مفعّل» كاذب) · مسار `GET /api/proxies/oc-proxy` · `POST /api/proxies/toggle` صار يعيد إنشاء الحاوية · `POST /api/proxies/oc-proxy/rollback` · زر «↩︎ تراجع» + وصف صحيح في الواجهة |
| `recreate-opencode-with-proxy.mjs` | `--drop-proxy` لإزالة النفق (`--no-proxy` بقي قائمة `NO_PROXY`) |
| `test/oc-container-proxy.test.mjs` (جديد) | 10 اختبارات |

### التحقق
| الفحص | النتيجة |
|---|---|
| `node --test "test/*.test.mjs"` | ✅ **101/101** |
| `GET /api/proxies/oc-proxy` | ✅ `enabled:true` · `http://<proxy-user>:***@dc.decodo.com:10001` · container `opencode-server` |
| `POST /api/proxies/toggle` (already enabled) | ✅ `{ok:true,unchanged:true}` (لا إعادة إنشاء بلا داعٍ) |
| `opencode/crouton-alpha-free` | ✅ PONG |
| `opencode.jsonc` | حُذفت كتلة `options` الميتة (المباشرة فقط) |
