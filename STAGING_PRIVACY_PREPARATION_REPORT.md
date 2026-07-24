# تقرير تجهيز Staging وفصل بيانات اللاعب — العملية 7

## 1. الهدف

فصل بيانات الاتصال الخاصة عن بيانات العرض العامة، وتجهيز ملفات وحواجز Staging دون إنشاء مشروع فعلي، أو نشر، أو اتصال ببيئة Production.

## 2. التصميم السابق

كان المسار `rooms/{roomId}/players/{playerId}` يجمع `authUid` و`fullName` و`phone` مع الاسم المستعار والنقاط والترتيب والجوكر. كانت صفحات العرض واللاعب ولوحة الإدارة تشترك في قراءة مجموعة `players` العامة، كما كان Local Storage يحتفظ بالاسم الكامل والهاتف، وكان أرشيف اللعبة وبيانات الفائزين ينسخان PII إلى مستند الغرفة العام.

## 3. التصميم الجديد

| الغرض | المسار | المحتوى |
|---|---|---|
| Public | `rooms/{roomId}/players/{playerId}` | `name`, `displayName`, `emoji`, النقاط، الترتيب، حقول الجوكر، حقول آخر سؤال، النشاط والتوقيتات العامة |
| Private | `rooms/{roomId}/playerPrivate/{playerId}` | `authUid`, `fullName`, `phoneNormalized`, `recoveryNameNormalized`, `createdAt`, `updatedAt` |
| مفاتيح منع التكرار | `rooms/{roomId}/playerRegistrationKeys/{hash}` | `type`, `playerId`, `createdAt` فقط |
| الزوار | `rooms/{roomId}/visitors/{anonymousUid}` | حالة الزيارة دون حقل `authUid` داخل البيانات |

لا يحتوي Public على الهاتف أو الاسم الكامل أو البريد أو `authUid` أو بيانات الاستعادة. تجزئة مفاتيح الفهرسة ليست تشفيرًا ولا تُستخدم كبديل عن قواعد الوصول؛ قيم الهاتف والاسم وUID الأصلية لا تُخزن داخل مستندات الفهرسة.

## 4. Rules

| المسار | القراءة | الكتابة من Web SDK |
|---|---|---|
| `players` | عامة لدعم لوحة الترتيب والعرض | ممنوعة |
| `playerPrivate` | Admin Claim فقط | ممنوعة |
| `playerRegistrationKeys` | ممنوعة لجميع العملاء | ممنوعة |
| `visitors` | Admin فقط | UID المجهول يكتب مستند الزيارة المطابق له بFields محدودة |
| `answers`, `questionResults` | وفق السلوك العام الحالي | الكتابة الحساسة ممنوعة |
| `questionSecrets` | ممنوعة | ممنوعة |
| `auditLogs` | Admin فقط | ممنوعة |

Functions تستخدم Admin SDK، واللاعب لا يستطيع قراءة Private لنفسه أو لغيره. لوحة الإدارة تستخدم `getPlayerPrivateDetails` لقراءة لاعب واحد عند فتح التفاصيل ولا تنفذ Query مباشرة من React.

## 5. التسجيل

`registerPlayer` ينفذ Transaction واحدة:

1. يتحقق من حالة الغرفة.
2. يقرأ مفاتيح UID والاسم والهاتف الحتمية.
3. يعيد اللاعب نفسه عند تكرار الطلب من UID ذاته.
4. ينشئ Public وPrivate وثلاثة مفاتيح منع تكرار ذريًا.
5. يعيد `playerId` و`name` و`displayName` و`emoji` فقط.

الهاتف يطبّع إلى عشرة أرقام. لا يُطبع في Logs ولا يظهر في الاستجابة. فهارس المفاتيح أزالت تعارض Queries واسعة عند التسجيل المتزامن.

## 6. الاستعادة

على الجهاز نفسه، يحتفظ Firebase Anonymous Auth بالـUID ويستدعي العميل `recoverPlayer`؛ تبحث Function في Private وتعيد `playerId` وبيانات العرض فقط. Local Storage يحتفظ بـ`playerId` فقط، وتُزال مفاتيح الاسم الكامل والهاتف القديمة.

عند تغيير الجهاز يتغير Anonymous UID، لذلك لا يحدث ربط تلقائي بالاسم والهاتف منعًا لانتحال لاعب. الاستعادة عبر جهاز جديد مؤجلة لتدفق موافقة Admin أو رمز مؤقت في عملية مستقلة.

## 7. Migration

السكربت: `functions/scripts/migrate-player-private-data.mjs`.

- يرفض غياب Firestore Emulator أو Host غير محلي.
- يقبل فقط Project namespace يبدأ بـ`demo-`.
- يرفض `GOOGLE_APPLICATION_CREDENTIALS`.
- الوضع الافتراضي Dry Run؛ يتطلب `--apply` للتطبيق.
- ينقل PII إلى Private، ينظف Public والأرشيف والفائزين، وينقل سجلات الزوار.
- ينشئ مفاتيح منع التكرار، ويطبع أعدادًا فقط.
- يرفض التعارض بدل الكتابة فوق Private موجود.

نتيجة Fixture الاختبارية:

- Dry Run: ثلاثة لاعبين؛ إنشاء Private للاعبين اثنين، لاعب منقول مسبقًا دون تغيير، لاعب ناقص الهاتف مدعوم، وتنقية أرشيف الغرفة.
- Apply داخل Emulator: نجح، وأزيلت `authUid/fullName/phone/phoneNormalized` من Public.
- إعادة التشغيل: `privateCreated=0`, `publicSanitized=0`, `conflicts=0`.
- Fixture التعارض: رُفض دون تعديل Public.

لم تُستخدم أو تُقرأ أي بيانات Production.

## 8. Staging

الملفات المجهزة:

- `.firebaserc.example`
- `.env.staging.example`
- `scripts/assert-staging-target.mjs`
- `scripts/staging-deploy-dry-run.mjs`
- `STAGING_ACTIVATION_CHECKLIST.md`

لم تتغير `.firebaserc` الفعلية. `src/firebase.js` يدعم إعدادات `VITE_FIREBASE_*` الاختيارية مع بقاء الإعداد الحالي fallback. ملفات الأمثلة تحتوي Placeholders فقط.

Scripts:

- `staging:check`
- `staging:smoke`
- `staging:deploy:dry-run`
- `migration:players:dry-run`
- `migration:players:emulator`

أمر `deploy` السابق داخل `functions/package.json` أصبح Dry Run محميًا ولا ينفذ `firebase deploy`.

## 9. حارس المشروع

الحارس يقرأ Project ID والتأكيد الصريح `CONFIRM_STAGING_PROJECT`، ويقرأ Production ID المعروف محليًا من `.firebaserc`. يرفض:

- Placeholder أو قيمة غائبة.
- Production ID المعروف.
- Project ID لا يحتوي `staging` وليس في Allowlist.
- عدم تطابق التأكيد مع الهدف.
- وجود Service Account.

اختبارات الحارس أثبتت رفض Placeholder وProduction وقبول هدف Staging مؤكد فقط. لا يطبع Tokens.

## 10. Smoke Tests

Smoke Test يعمل الآن على `demo-family-quiz` داخل Emulator فقط، ويغطي:

- Admin واثنين من اللاعبين.
- إنشاء Public وPrivate.
- الجوكر، تجهيز وبدء السؤال، الإجابات، الإنهاء والنتيجة.
- تعديل نقاط إداري وAudit Log.
- التحقق من غياب الهاتف والاسم الكامل وUID اللاعب من Public والنتيجة وSnapshot وAudit.
- التنظيف وإغلاق المحاكيات.

## 11. نتائج الاختبارات

| الفحص | النتيجة |
|---|---|
| Build | ناجح؛ تحذير Vite لحجم chunk أكبر من 500KB |
| ESLint | ناجح |
| Unit | 14/14 |
| Baseline Integration | 19/19 |
| Secure Full Flow + Rules | 2/2 |
| Admin/client flow | 1/1 |
| Privacy/Migration/Smoke/Guard | 6/6 |
| Performance | 1/1 |
| Migration Dry Run | ناجح |
| Migration Apply داخل Emulator | ناجح |
| Migration Idempotency | ناجح |
| تعارض Migration | رُفض بأمان |
| Placeholder guard | مرفوض |
| Production guard | مرفوض |

رسائل `PERMISSION_DENIED` في Rules Tests متوقعة لأنها تثبت منع الكتابات والقراءات غير المصرح بها.

## 12. الأداء

قياسات Emulator وليست تقديرًا للإنتاج:

| القياس | النتيجة |
|---|---:|
| تسجيل أول 50 لاعبًا، شامل البدء البارد | 8065.91 ms |
| إضافة اللاعبين 51–100 | 897.42 ms |
| قراءة لوحة ترتيب عامة لـ100 لاعب | 53.11 ms |
| حجم Public تقريبي | 489 bytes |
| حجم Private تقريبي | 269 bytes |
| Finalize لـ50 لاعبًا — جولة باردة | 2325.02 ms |
| Finalize لـ50 لاعبًا — الجولة الثانية | 265.61 ms |
| Finalize لـ50 لاعبًا — الجولة الثالثة | 340.38 ms |
| Finalize لـ100 لاعب | 265.85 ms |

قبل فهارس التسجيل الحتمية أظهرت Queries المعاملات تعارضًا مرتفعًا؛ استبدالها بمفاتيح خادمية نقطية خفّض زمن التسجيل بوضوح مع الحفاظ على الذرية ومنع التكرار.

## 13. المخاطر المتبقية

- لم يُنشأ مشروع Staging فعلي ولم تُفعّل خدماته.
- لم تُفعّل Anonymous Auth أو Admin Auth في Staging.
- لم يحدث Deploy أو Smoke Test على Staging فعلي.
- استعادة الحساب عبر جهاز جديد مؤجلة.
- App Check غير مفعّل.
- مراقبة الأخطاء وAnalytics خارج نطاق العملية.
- بيانات Production القديمة تحتاج Migration مستقلة، ونسخة احتياطية، وDry Run ومراجعة قبل أي تطبيق.
- إصدار `firebase-functions` يعطي تحذير تحديث داخل Emulator؛ لم تُثبت حزم جديدة ضمن هذه العملية.
- حزمة الواجهة ما زالت أكبر من حد تحذير Vite.

## 14. العملية التالية

إنشاء مشروع Firebase Staging يدويًا، ربط Alias، تفعيل Auth، ثم نشر Functions وRules وHosting إلى Staging فقط باستخدام حارس المشروع وSmoke Tests. لا تُنفذ هذه الخطوات ضمن العملية 7.
