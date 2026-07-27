# تقرير العملية 10: الأمان والتحمل والرجوع

تاريخ الفحص: 2026-07-27  
الفرع: `feature/reliability-upgrade`  
نقطة الأساس: `9ba52e0c6ac740979678367aa8619c75bd363cb1`  
نطاق التشغيل: Firebase Emulator Suite فقط، بالمشروع التجريبي `demo-family-quiz`.

## النتيجة التنفيذية

أثبتت الاختبارات المحلية أن النقلين `callable` و`vercel` يستخدمان منطق الأعمال الخادمي نفسه، وأن الرجوع إلى Callable يتم بتغيير الإعداد فقط من دون تغيير كود أو مخطط بيانات. نجحت أحمال 50 و100 لاعب بلا فقد بيانات أو timeout، ونجحت المقارنة الوظيفية لجميع العمليات الخمس عشرة. لم يُنشأ أو يُستخدم Service Account، ولم يحدث اتصال بمشروع حقيقي، ولم يُنفذ أي Commit أو Push أو Deploy.

التغيير السلوكي الوحيد في كود API هو رفض `Content-Type` صريح غير `application/json` برمز HTTP 415 وكود ثابت `unsupported-media-type`. يظل body الذي حللته منصة Vercel مسبقًا مقبولًا إذا لم ترسل المنصة رأس Content-Type إلى handler. لم يتغير React أو التسجيل أو الأسئلة أو النقاط أو الجوكر أو الترتيب أو Firestore schema.

## Threat model

يغطي النموذج:

- انتحال لاعب آخر عبر `playerId` أو `uid` أو `authUid`.
- استخدام token مفقود أو مزور أو ذي audience لمشروع آخر.
- رفع الصلاحية عبر بريد يبدو إداريًا أو claim بقيمة `false`.
- تكرار الطلبات، السباق على الإجابات والجوكر والإنهاء، وإعادة التشغيل بعد 401.
- تسريب بيانات `playerPrivate` أو token أو رقم الهاتف عبر الردود أو السجلات.
- CORS مفتوح، methods غير مسموحة، body أكبر من 32KiB، JSON تالف، وأخطاء شبكة/timeout.
- دخول `firebase-admin` أو أسرار خادمية إلى browser bundle، أو تخزين `/api/*` في PWA/cache.
- اختلاف العقد أو البيانات بين Callable وVercel، وتعذر الرجوع الآمن.

خارج نطاق الإثبات: خصائص شبكة Vercel الحقيقية، cold starts في Staging، حدود الحصة والإجهاد الموزع، WAF/rate limiting، وإدارة أسرار Staging الفعلية.

## مجموعة اختبارات العملية 10

أضيفت الأوامر:

- `npm run test:operation10`
- `npm run test:operation10:security`
- `npm run test:operation10:parity`
- `npm run test:operation10:load`
- `npm run test:operation10:rollback`
- `npm run test:operation10:all`

يشغّل runner محاكيات Auth وFunctions وFirestore وRealtime Database، ينتظر المنافذ `5001/8080/9000/9099`، يفرض `FUNCTIONS_DISCOVERY_TIMEOUT=60`، يرفض أي project ID غير `demo-family-quiz`، ويرفض `GOOGLE_APPLICATION_CREDENTIALS`. يقوم `firebase emulators:exec` بإيقاف المحاكيات بعد انتهاء الاختبار، ويعمل runner على Windows باستدعاء Firebase CLI عبر Node.

التوزيع النهائي: 41 حالة Node في `test:operation10:all`: 25 للأمان ودورة token والخصوصية والحدود، حالتان للتكافؤ، حالتان للضغط، و12 للرجوع وعقد عميل النقل. لا توجد حالات skip أو retry عام.

## الهوية والإدارة والخصوصية

- رُفضت محاولات `submitAnswer` و`activateJoker` و`cancelJoker` و`updatePlayerProfile` للاعب آخر بـ`permission-denied`.
- رُفض حقن `uid` و`authUid` بـ`invalid-argument`. مصدر UID الوحيد هو Firebase ID Token.
- رُفض المستخدم غير المسجل، والتوكن المفقود والمزور والمصمم لمشروع آخر، بأكواد آمنة وثابتة.
- لم يمنح البريد ذو الشكل الإداري صلاحية. رُفض `admin:false` والمستخدم العادي؛ نجح `admin:true`.
- نجحت عمليات الإدارة: تعديل النقاط، قراءة `playerPrivate`، تحديث لاعب، حذف لاعب، `resetPracticeScores` و`resetQuizData`.
- لا يحتوي المستند العام أو الرد العام على `phone` أو `phoneNormalized` أو `fullName` أو `authUid` أو `recoveryNameNormalized`.
- أظهرت الاختبارات أن البيانات الخاصة موجودة في `playerPrivate` ولا تُقرأ إلا بالإدارة.
- لم تتضمن الردود stack traces أو تفاصيل token/claim.

## دورة token والشبكة وHTTP

- نجح token صالح.
- 401 الأول أدى إلى refresh واحد ثم طلب ثانٍ فقط؛ لا loop.
- فشل refresh وانتهاء الجلسة وغياب `currentUser` تحولا إلى أخطاء مستقرة.
- اختُبرت `unauthenticated` و`permission-denied` و`network-error` و`request-timeout` و`internal`.
- لا يوجد retry عام؛ الفشل الشبكي يرسل طلبًا واحدًا فقط.
- اختُبرت استجابة JSON تالفة وفارغة وHTTP 500 و429، وbody أكبر من 32KiB.
- المصدران المحليان المسموحان يعملان، والمصدر الخارجي يُرفض، وOPTIONS آمن، وGET على endpoints التشغيلية يُرفض، وhealth يعيد metadata ثابتة غير حساسة.
- الطلب ذو `Content-Type: text/plain` يُرفض بـ415.
- المهلة الافتراضية 10 ثوانٍ، و`finalizeQuestion` لها 25 ثانية، مع إمكانية تمرير مهلة اختبار أصغر من دون تغيير سياسة الإنتاج.

## التزامن، الزمن والعدالة

- التسجيل والاسترجاع المتكرران يعيدان الحالة نفسها من دون لاعب إضافي.
- إجابتان متزامنتان للاعب والسؤال نفسيهما تنتجان مستند إجابة واحدًا؛ الثانية `already-exists`.
- تفعيلان متزامنان للجوكر ينتجان `pending` و`already-pending` ولا يستهلكان جوكرين.
- الإلغاء بعد البدء/الإغلاق مرفوض.
- `controlQuestion(reveal)` المتكرر يعيد `already-revealed`.
- عند `finalizeQuestion` المتزامن ينجح مالك القفل، وقد يتلقى المنافس `aborted` مؤقتًا؛ إعادة الطلب تعيد `already-finalized`. يبقى مستند نتيجة واحد ولا تتكرر النقاط أو حركة الترتيب.
- `adjustPlayerScore` المتكرر يضيف delta في كل مرة حسب العقد الحالي، وهو سلوك موثق وليس idempotent.
- الإجابة قبل البدء وبعد الإغلاق مرفوضة. حقول timestamp غير المسموحة تُرفض، ووقت الخادم هو مصدر الثقة.
- اختبارات Baseline تؤكد معادلة الزمن الحالية والترتيب الحتمي، وإعادة finalize لا تغير النتيجة.

## Transport parity

شُغل مساران لكل عملية: مسار خطأ موحد بمدخل فارغ، ومسار نجاح كامل منفصل على كل نقل. كل العمليات تستخدم registry الخادمي نفسه. في مسار النجاح تطابقت الحالات وFirestore counts والخصوصية والجوكر والترتيب والحذف وإعادة الضبط. فرق النقاط بين التشغيلين المتتاليين كان ضمن 11 نقطة بسبب اختلاف وقت الإجابة الخادمي الفعلي، وكلاهما ضمن المعادلة نفسها؛ لذلك لم يُعامل هذا كاختلاف نقل.

| العملية | Callable | Vercel | النتيجة |
|---|---|---|---|
| registerPlayer | registered / invalid-argument | registered / invalid-argument | مطابق |
| recoverPlayer | recovered / invalid-argument | recovered / invalid-argument | مطابق |
| submitAnswer | received / invalid-argument | received / invalid-argument | مطابق |
| activateJoker | pending / invalid-argument | pending / invalid-argument | مطابق |
| cancelJoker | cancelled / invalid-argument | cancelled / invalid-argument | مطابق |
| prepareQuestion | prepared / invalid-argument | prepared / invalid-argument | مطابق |
| startQuestion | started / invalid-argument | started / invalid-argument | مطابق |
| controlQuestion | revealed / invalid-argument | revealed / invalid-argument | مطابق |
| finalizeQuestion | finalized / invalid-argument | finalized / invalid-argument | مطابق |
| adjustPlayerScore | adjusted / invalid-argument | adjusted / invalid-argument | مطابق |
| getPlayerPrivateDetails | private details / invalid-argument | private details / invalid-argument | مطابق |
| updatePlayerProfile | updated / invalid-argument | updated / invalid-argument | مطابق |
| deletePlayer | deleted / invalid-argument | deleted / invalid-argument | مطابق |
| resetPracticeScores | already-reset / invalid-argument | already-reset / invalid-argument | مطابق |
| resetQuizData | reset / invalid-argument | reset / invalid-argument | مطابق |

## نتائج الضغط

### Vercel API المحلي

| الحمل | التسجيل | الإجابات المتزامنة | finalize | أخطاء | timeouts | إجابات محسوبة | جوكر مطبق | لاعبو النتيجة |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 2784.21 ms لتسجيل 100 لاعب مرة واحدة | 1064.57 ms | 277.22 ms | 0 | 0 | 50 | 10 | 100 |
| 100 | — | 3077.81 ms | 297.28 ms | 0 | 0 | 100 | 10 | 100 |

نجحت إعادة `finalizeQuestion` بالحالة `already-finalized` وبـrunId نفسه.

### Callable

نجح `test:secure-writes:performance` ثلاث مرات متتالية. كل تشغيل شمل 50 لاعبًا ثلاث مرات و100 لاعب مرة، مع 100 تسجيل و100 إجابة متزامنة:

| التشغيل | تسجيل أول 50 | تسجيل 50 التالية | إجابات 100 | finalize 100 | أخطاء/timeouts |
|---|---:|---:|---:|---:|---:|
| 1 | 8492.69 ms | 892.47 ms | 2056.20 ms | 320.45 ms | 0 / 0 |
| 2 | 10127.95 ms | 1363.82 ms | 1650.40 ms | 277.01 ms | 0 / 0 |
| 3 | 7878.73 ms | 878.03 ms | 1653.23 ms | 292.66 ms | 0 / 0 |

ظهر cold-start مرتفع في أول جولة 50 لاعبًا (31.8–39.4 ثانية للإجابات)، ثم انخفضت الجولات الدافئة بشدة. هذه قياسات محاكي محلي وليست تقديرًا لأداء الإنتاج.

## الرجوع Rollback

لا يحتاج الرجوع تغيير كود أو schema:

1. اضبط `VITE_SERVER_TRANSPORT=callable` في بيئة البناء المقصودة.
2. ابنِ artifact جديدًا وشغّل smoke tests قبل أي نشر لاحق.
3. لا تحذف `/api` أو Firebase Functions أثناء فترة الرجوع.
4. غياب المتغير أو قيمته الفارغة يعني `callable`.
5. القيمة غير `callable` أو `vercel` تفشل بـ`invalid-server-transport` ولا تنتقل تلقائيًا إلى نقل آخر.
6. Production لم يتغير في هذه العملية، ولا يوجد تبديل تلقائي إلى Vercel.

نجح تدفق حرج بالشكل نفسه على النقلين، وتطابقت العمليات الخمس عشرة منطقيًا.

## Firebase Admin والسجلات وPWA

- يفشل initializer خارج المحاكيات بوضوح إذا كانت إعدادات الإنتاج ناقصة، قبل إنشاء اتصال.
- المحاكيات لا تحتاج Service Account، و`GOOGLE_APPLICATION_CREDENTIALS` ممنوع في runner.
- فحص `src` و`dist` لم يجد `firebase-admin` أو `FIREBASE_ADMIN_PRIVATE_KEY` أو private-key markers.
- لا يوجد `firebase-admin` داخل `src`، ولا import من `api` إلى `src`، ولا import من `src` إلى server modules.
- `httpsCallable` المباشر موجود فقط في adapter المخصص.
- التقط اختبار token قيمة sentinel ولم تظهر في console، ولم تظهر قيم الهاتف/الاسم/token التجريبية في emulator debug logs.
- لا يوجد Service Worker أو Workbox أو cache strategy. يرسل عميل Vercel `cache: no-store` ولا يستخدم local/session storage لتخزين Authorization أو الردود.

## نتائج حزم الانحدار

| الحزمة | النتيجة |
|---|---|
| Operation 10 security | 25/25 |
| Operation 10 parity | 2/2 |
| Operation 10 load | 2/2 |
| Operation 10 all | 41/41 بعد التشغيل النهائي |
| Functions unit | 14/14 |
| Client transport/boundaries | 14/14 |
| Vercel API integration | 19/19 |
| Admin flow | 1/1 |
| Baseline integration | 19/19 |
| Secure writes | 2/2 |
| Privacy/staging guards | 6/6 |
| Baseline performance | 1/1 |
| Secure-writes performance | 3/3 تشغيلات |
| ESLint | ناجح، 0 أخطاء |
| Build callable | ناجح |
| Build vercel | ناجح |
| `git diff --check` | ناجح |

تحذيرات غير حاجبة: تحذير Vite لحجم chunk أكبر من 500KiB، وتحذير Firebase Emulator بأن `firebase-functions` قديم. لم تُعالج هذه التحذيرات لأن العملية 10 تمنع تغييرات غير مرتبطة.

## المخاطر المتبقية قبل Vercel Staging

- يجب اختبار CORS والـenvironment variables والـFirebase Admin credentials داخل Staging فعلي منفصل، من دون Service Account file.
- لا يوجد حتى الآن قياس cold-start أو limits أو concurrency في بيئة Vercel الحقيقية.
- لا يوجد rate limiter/WAF داخل هذه الطبقة؛ يجب اتخاذ قرار Staging مبني على حدود المنصة والتهديد.
- المنافس المتزامن على finalize قد يرى `aborted` مؤقتًا قبل أن تنتهي العملية الأولى؛ العميل لا يكرر تلقائيًا، وإعادة المشرف اليدوية آمنة.
- أداء المحاكيات شديد التفاوت، خصوصًا أول جولة Callable، ولا يمثل SLA إنتاج.
- تحذير ترقية `firebase-functions` وحجم حزمة Vite مؤجلان.

## القرار

جاهز **لإعداد Vercel Staging المنفصل فقط** مع إبقاء Production وFirebase Functions الحالية بلا تغيير. لا يُعد هذا تصريحًا بالنشر إلى Production. يجب أن تبدأ العملية التالية بإعداد Staging وقيود origin والأسرار المُدارة، ثم smoke/load محدودين داخل Staging وخطة رجوع مجربة.
