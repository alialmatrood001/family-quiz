# تقرير العملية 11: إعداد Vercel Staging الآمن

تاريخ الفحص: 2026-07-27  
الفرع: `feature/reliability-upgrade`  
Commit الأساس: `1184811cfc1dc3b2c2c6968fefb3eca6c00d5964`

## 1. النتيجة

تم تجهيز الكود والاختبارات محليًا لمسار مستقل:

`React Staging → Vercel API → Firebase Staging`

لم يتم تسجيل الدخول إلى Vercel أو Firebase، ولم يُنشأ أو يُربط مشروع، ولم يحدث Deploy أو Push أو Commit، ولم تُستخدم بيانات Production. لا يوجد مجلد `.vercel` محلي. ملف `.env.staging.local` موجود محليًا، غير متتبع، ومُستبعد بواسطة `.gitignore`؛ لم تُعرض قيمه أو تُعدّل.

الكود جاهز للانتقال إلى **مرحلة الربط اليدوي** بعد اعتماد مشروعَي Firebase وVercel المنفصلين وإدخال متغيراتهما المشفرة. لا يُعد Staging الخارجي مختبرًا بعد لأن العملية توقفت عمدًا قبل تسجيل الدخول والإنشاء والربط.

## 2. الفصل بين البيئات

| البعد | Local Emulator | Staging | Production |
|---|---|---|---|
| Firebase project | `demo-family-quiz` فقط | مشروع مستقل يحتوي اسمه `staging` أو allowlist صريحة | المشروع الافتراضي المكتشف `family-quiz-b7960` |
| Firestore / RTDB / Auth | منافذ localhost المحددة في `firebase.json` | موارد داخل مشروع Staging فقط | لا اتصال في هذه العملية |
| Admin identity | بلا Service Account | متغيرات Vercel المشفرة فقط بعد الاعتماد | غير مهيأ لمسار Vercel الجديد |
| Transport | callable أو Vercel adapter محلي | `vercel` إجباري | callable هو الرجوع الافتراضي؛ Vercel Production غير مفعّل |
| Vercel project | لا يوجد ربط | مشروع مستقل مقترح `family-quiz-staging` | لا تغيير |
| Origin | `localhost:5173` و`127.0.0.1:5173` | `STAGING_ORIGIN` واحد مطابق حرفيًا | مرفوض من CORS الخاص بـStaging |
| Banner | غير ظاهر | `STAGING — بيانات تجريبية` | غير ظاهر وغير موجود نصه في حزمة البناء |

حواجز البناء تمنع Staging إذا كان النقل ليس Vercel، أو غابت قيم Firebase العامة، أو لم يطابق `CONFIRM_STAGING_PROJECT` المشروع، أو طابق المشروع معرف Production، أو لم يحتوِ المعرف `staging`.

حواجز الخادم تمنع الإعدادات الناقصة والمختلطة، ملف `GOOGLE_APPLICATION_CREDENTIALS`، بريد Admin من مشروع آخر، RTDB من مشروع آخر، تطابق نطاقَي Staging وProduction، أو أكثر من origin واحد. مسار Firebase Functions المُدار القديم بقي متوافقًا ولم يُحذف.

## 3. متغيرات البيئة

القالب الآمن هو `.env.staging.example`، ولا يحتوي قيمًا حقيقية.

### متغيرات المتصفح العامة

- `VITE_APP_ENV`
- `VITE_SERVER_TRANSPORT`
- `VITE_STAGING_BANNER`
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

هذه القيم تدخل حزمة Vite، ولذلك ليست أسرارًا. مع ذلك يجب أن تخص مشروع Staging فقط.

### متغيرات الخادم

- `APP_ENVIRONMENT`
- `SERVER_TRANSPORT`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_PRODUCTION_PROJECT_ID`
- `CONFIRM_STAGING_PROJECT`
- `FIREBASE_DATABASE_URL`
- `STAGING_ORIGIN`
- `PRODUCTION_ORIGIN`
- `VERCEL_ALLOWED_ORIGINS`
- `STAGING_PROJECT_ALLOWLIST` عند الحاجة فقط

المعرفات والنطاقات ليست أسرارًا، لكنها حواجز حساسة ويجب إدخالها بدقة.

### أسرار الخادم

- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`

تُدخل لاحقًا في Vercel كمتغيرات مشفرة ومقصورة على مشروع Staging وبيئة Preview المطلوبة. يمنع حفظها في ملف أو Git أو logs. لم يُنشأ Service Account أو مفتاح في هذه العملية.

### متغيرات الاختبار المستقبلي

- `TEST_STAGING_BASE_URL`
- `TEST_STAGING_PROJECT_ID`
- `CONFIRM_STAGING_LOAD_TARGET`

يجب أن تتطابق جميعها مع Staging، وأن يُرفض التشغيل إذا طابقت Production.

## 4. CORS وHTTP والكاش

- عمليات API تبقى POST فقط، وhealth يبقى GET.
- Staging يقبل origin واحدًا مطابقًا حرفيًا لـ`STAGING_ORIGIN`، إضافة إلى localhost للاختبارات المحلية.
- wildcard والنطاق الخارجي ونطاق Production والنطاق المشابه المخادع مرفوضة.
- إعداد CORS الناقص أو المختلط يفشل مغلقًا بكود `staging-configuration-invalid`.
- جميع ردود API، بما فيها الأخطاء وhealth وOPTIONS، تضبط:
  - `Cache-Control: no-store, max-age=0`
  - `Pragma: no-cache`
  - `Expires: 0`
- health يعرض فقط: حالة الخدمة، اسم الخدمة، البيئة، والنقل. لا يعرض project ID أو credentials أو token أو بيانات لاعب.
- لا يوجد Service Worker أو PWA cache حاليًا؛ عميل النقل نفسه يستخدم `cache: no-store`.

## 5. الشريط المرئي

يبني `build:staging` شريطًا واضحًا أعلى التطبيق بالنص:

`STAGING — بيانات تجريبية`

اختبار البناء فحص محتوى الحزمة الناتجة وأثبت أن النص موجود في Staging فقط، وغائب من callable وVercel Production. لم يُعدّل `App.jsx` أو أي تدفق داخل واجهة المسابقة.

## 6. أوامر البناء والاختبار

- `npm run build:callable`: Production الحالية مع callable وشريط Staging معطل.
- `npm run build:staging`: وضع staging، نقل Vercel، تحقق صارم، وشريط ظاهر.
- `npm run build:vercel`: بناء Vercel Production المستقبلي بلا شريط؛ لا ينشر.
- `npm run test:operation11`: اختبارات الحواجز وCORS وhealth والرجوع.
- `npm run test:operation11:builds`: يبني الأوضاع الثلاثة ويفحص وجود الشريط.
- `npm run test:operation11:all`: يجمع اختبارات العملية 11 والبناء الثلاثي.

## 7. نتائج الفحوصات

| الفحص | النتيجة |
|---|---|
| Operation 11 guards/HTTP | 8/8 ناجحة |
| Operation 11 builds | 3/3 ناجحة |
| Operation 10 full | 41/41 ناجحة |
| Unit | 14/14 ناجحة |
| Client transport/boundaries | 14/14 ناجحة |
| Vercel API integration | 19/19 ناجحة |
| Privacy/staging guards | 6/6 ناجحة |
| Secure writes | 2/2 ناجحة |
| ESLint | ناجح، 0 أخطاء و0 تحذيرات |
| `git diff --check` | ناجح |

إجمالي مرات تنفيذ حالات الاختبار المسجلة: 104 ناجحة، 0 فاشلة. بعض الحالات تُعاد داخل حزمة Operation 10، لذلك هذا عدد executions وليس عدد الاختبارات الفريدة.

اختبار حمل Operation 10 نجح محليًا:

| اللاعبون | التسجيل | الإجابات | finalize | أخطاء | timeouts |
|---:|---:|---:|---:|---:|---:|
| 50 | 2118.79 ms | 842.94 ms | 291.82 ms | 0 | 0 |
| 100 | مستخدمون معاد استعمالهم داخل harness | 2553.87 ms | 259.36 ms | 0 | 0 |

التحذيرات غير المانعة:

- Vite يحذر من chunk يتجاوز 500 kB؛ لم يُعالج لأنه خارج العملية.
- Firebase Emulator يطبع توصية ترقية `firebase-functions`؛ لم تُثبّت حزم ولم تُجر ترقية.
- رسائل `PERMISSION_DENIED` في اختبارات القواعد متوقعة وتمثل حالات الرفض المطلوبة.

## 8. خطوات Firebase Staging اليدوية — لا تُنفذ ضمن هذه العملية

1. سجّل الدخول إلى Firebase Console بحساب مخول.
2. أنشئ مشروعًا جديدًا مستقلًا، واختر معرفًا واضحًا يحتوي `staging`. لا تستخدم المشروع `family-quiz-b7960`.
3. سجّل Web App جديدًا داخل مشروع Staging وخذ قيم Web Config العامة فقط.
4. فعّل Authentication بنفس providers المعتمدة حاليًا في التطبيق، وبنفس إعدادات Staging فقط. لا تنسخ مستخدمي Production.
5. أنشئ Firestore Database في المنطقة المعتمدة للمشروع، بلا استيراد بيانات Production.
6. أنشئ Realtime Database داخل مشروع Staging، وسجل عنوانه الدقيق.
7. راجع ثم انشر لاحقًا، بعد موافقة مستقلة، الملفات الحالية:
   - `firestore.rules`
   - `firestore.indexes.json`
   - `database.rules.json`
8. أنشئ مستخدمي اختبار منفصلين. امنح المشرف claim ‏`admin: true` بطريقة إدارية موثوقة ومحدودة لمشروع Staging؛ البريد وحده لا يمنح الإدارة.
9. لا تنشئ أو تحفظ ملف Service Account. قبل الربط الفعلي، اعتمد وسيلة credential خادمية للمشروع؛ إذا استُخدمت آلية المتغيرات الحالية، تُدخل القيم المطلوبة مباشرة في مخزن Vercel المشفر ولا تمر عبر ملف محلي.
10. تحقق يدويًا من تطابق project ID في Auth وFirestore وRTDB وWeb Config وAdmin variables قبل أي اختبار.

## 9. خطوات Vercel Staging اليدوية — توقف قبل تنفيذها

Vercel CLI موجود محليًا بإصدار `54.7.1`. لم يحدث login أو link.

1. نفّذ `vercel.cmd login` فقط بعد الموافقة.
2. من Vercel Dashboard اختر **Add New → Project** واستورد المستودع.
3. سمّ المشروع المستقل `family-quiz-staging`.
4. اضبط Root Directory على جذر هذا المشروع وFramework Preset على Vite.
5. اضبط Build Command على `npm run build:staging` وOutput Directory على `dist`.
6. اربط Preview deployments بالفرع المعتمد؛ الفرع الحالي هو `feature/reliability-upgrade`. لا تغيّر Production project أو Production branch للموقع الحالي.
7. أضف متغيرات المتصفح والخادم السابقة إلى مشروع `family-quiz-staging` فقط، وبالنطاق Preview المطلوب. ضع الأسرار في Vercel Encrypted Environment Variables.
8. بعد معرفة النطاق الثابت، اجعله القيمة الوحيدة في `STAGING_ORIGIN` و`VERCEL_ALLOWED_ORIGINS`، وضع نطاق Production الدقيق في `PRODUCTION_ORIGIN` للحظر.
9. راجع أن `.vercel/project.json`—عند إنشائه لاحقًا بواسطة الربط—يشير إلى `family-quiz-staging` فقط قبل أي أمر.
10. نفّذ Preview deploy فقط بعد موافقة منفصلة. لا تستخدم `vercel --prod`.
11. افحص `/api/health`: يجب أن يعيد `environment: staging` و`transport: vercel` ورؤوس `no-store`.

## 10. خطة Smoke Test على Staging

تُنفذ بعد إنشاء الموارد والربط، باستخدام حساب لاعب وحساب Admin اختباريين فقط. لكل عملية تُختبر حالة نجاح وحالة رفض واحدة على الأقل:

| العملية | النجاح | الرفض المطلوب |
|---|---|---|
| `registerPlayer` | تسجيل لاعب Staging | body غير صالح/هوية غير صالحة |
| `recoverPlayer` | استعادة المالك | لاعب غير مرتبط |
| `submitAnswer` | أول إجابة داخل النافذة | تكرار/لاعب آخر/بعد الإغلاق |
| `activateJoker` | pending مرة واحدة | التكرار لا يستهلك جوكرًا ثانيًا |
| `cancelJoker` | إلغاء قبل القفل | بعد القفل |
| `updatePlayerProfile` | المالك يعدل allowlist | لاعب آخر/حقل إداري |
| `prepareQuestion` | Admin يجهز | غير Admin |
| `startQuestion` | Admin يبدأ | غير Admin/حالة غير صالحة |
| `controlQuestion` | reveal/close صحيح | غير Admin/action غير معروف |
| `finalizeQuestion` | نتيجة واحدة | الاستدعاء الثاني idempotent |
| `adjustPlayerScore` | Admin يعدل مع audit | غير Admin/قيمة خارج الحد |
| `getPlayerPrivateDetails` | Admin فقط | لاعب عادي |
| `deletePlayer` | Admin يحذف العام والخاص | غير Admin |
| `resetPracticeScores` | Admin يعيد الضبط | غير Admin |
| `resetQuizData` | Admin يعيد بيانات الاختبار | غير Admin |

بعدها يُفحص أن public player response/document لا يحتوي `phone` أو `fullName` أو `authUid`، وأن كل request خاص يحمل `Cache-Control: no-store`، وأن origin خارجي وProduction origin مرفوضان.

## 11. خطة الحمل على Staging

1. شغّل guard قبل أي تحميل، ويجب أن تتطابق `TEST_STAGING_PROJECT_ID` و`CONFIRM_STAGING_LOAD_TARGET` مع مشروع Staging وأن تختلف عن Production.
2. ابدأ بـ50 لاعبًا: تسجيل، تفعيل جوكر لعينة، بدء سؤال، إجابات متزامنة، إغلاق وfinalize.
3. سجّل registration/answer/finalize latency، p50/p95/p99، عدد HTTP 4xx/5xx، timeouts، إجابات Firestore، استهلاك الجوكر، وعدد نتائج اللاعبين.
4. لا تنتقل إلى 100 لاعب إلا إذا كانت الأخطاء وtimeouts صفرًا، وعدد الإجابات والنتائج متطابقًا، وfinalize idempotent.
5. كرر السيناريو نفسه مع100 لاعب دون تقليل الضغط أو إضافة retry يخفي فشلًا.
6. راقب Vercel function logs وFirebase quotas دون تسجيل tokens أو هواتف أو بيانات خاصة.
7. أوقف الاختبار فور ظهور project ID أو origin غير متوقع.

## 12. خطة الرجوع

الرجوع لا يحتاج تغيير schema أو منطق:

1. اضبط `VITE_SERVER_TRANSPORT=callable`.
2. اضبط `VITE_APP_ENV=production` و`VITE_STAGING_BANNER=false`.
3. نفّذ `npm run build:callable`.
4. أعد اختبارات `test:server-client` و`test:operation10:rollback`.
5. لا تغيّر Firebase Functions القديمة؛ بقيت متاحة لهذا الغرض.

اختبارات العملية 11 أثبتت محليًا أن callable هو الوضع الافتراضي وأن الشريط غائب في بناء الرجوع.

## 13. المخاطر والأعمال المؤجلة

### عالية

- Staging الخارجي لم يُنشأ أو يُربط أو يُختبر بعد؛ الأدلة الحالية محلية ومحاكيات فقط.
- طريقة اعتماد Firebase Admin على Vercel تحتاج قرارًا أمنيًا معتمدًا قبل إدخال أي credential. الكود الحالي يقبل متغيرات مشفرة ويرفض الملفات.
- قواعد Firestore وRTDB والفهارس لم تُنشر إلى مشروع Staging؛ يلزم نشر منفصل ومراجعة target.

### متوسطة

- يجب تثبيت نطاق Staging النهائي ثم إدخاله حرفيًا في CORS؛ Preview URLs المتغيرة لا تقبل wildcard.
- يجب إنشاء Admin claims منفصلة وعدم نسخ مستخدمين أو بيانات من Production.
- اختبار الحمل الخارجي 50/100 لم ينفذ بعد كي لا يحدث اتصال أو Deploy.

### منخفضة

- تحذير حجم حزمة Vite قائم.
- تحذير أداة المحاكي بشأن إصدار `firebase-functions` قائم.

## 14. قرار الانتقال

الطبقة المحلية وحواجزها واختباراتها **جاهزة للـCommit بعد المراجعة**، لكن Staging نفسه **غير جاهز للنشر أو الاستخدام** حتى تُنفذ خطوات الإنشاء والربط اليدوية بموافقة مستقلة، ثم smoke test والحمل على البيئة المنفصلة.
