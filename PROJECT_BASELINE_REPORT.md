# تقرير الحالة الأساسي وموثوقية المشروع

تاريخ الفحص: 2026-07-23
نطاق التقرير: العملية 1B — فحص وتوثيق فقط، دون تعديل وظائف التطبيق.

## 1. الملخص التنفيذي

المشروع تطبيق مسابقة عائلية أحادي الصفحة مبني بـReact وVite، ويستخدم Cloud Firestore مباشرة من الواجهة لتخزين حالة المسابقة والأسئلة واللاعبين والإجابات والرسائل والنتائج. البناء الحالي ينجح، لكن الجاهزية لتطوير الموثوقية محدودة بسبب غياب الاختبارات وFirebase Emulator وRules وAuthentication من المستودع، واعتماد المسارات الحساسة على الواجهة وساعة الجهاز.

أكبر المخاطر هي أن شاشة العرض العامة تحتوي أدوات تغيّر حالة المسابقة، وأن العميل يحسب صحة الإجابة والنقاط والجوكر ثم يكتبها مباشرة. توجد Callable Cloud Function باسم `finalizeQuestion`، لكنها غير مستدعاة من الواجهة الحالية، كما أنها تثق في بيانات الإجابات المحسوبة من العميل ولا تتحقق من هوية المستدعي. ما زال React هو مسار الاحتساب الفعلي، مع عدة مشغلات تلقائية ويدوية.

المشروع قابل للبناء، لكنه يحتاج أولًا إلى بيئة Emulator معزولة واختبارات سلوك موثوقة قبل تغيير مسار النتائج أو الصلاحيات.

## 2. معلومات المشروع

| البند | الحالة |
|---|---|
| إطار العمل | React 19.2.6، تطبيق SPA |
| أداة البناء | Vite 8.0.14 مع `@vitejs/plugin-react` 6.0.2 |
| Node المستخدم في الفحص | v24.15.0 |
| npm المستخدم في الفحص | 11.12.1 |
| Node المطلوب للجذر | غير محدد في `package.json` |
| Node المطلوب للدوال | 24 في `functions/package.json` |
| Firebase Web SDK | 12.13.0 |
| Framer Motion | 12.40.0 |
| Firebase Admin | 13.10.0 مثبت داخل `functions` |
| Firebase Functions | 7.2.5 مثبت داخل `functions` |
| Lock files | `package-lock.json` و`functions/package-lock.json`، كلاهما lockfileVersion 3 |

الأوامر المتاحة في الجذر:

- `npm run dev`: تشغيل Vite للتطوير.
- `npm run build`: إنشاء حزمة Production في `dist`.
- `npm run lint`: تشغيل ESLint على المشروع كاملًا.
- `npm run preview`: معاينة حزمة Vite.

أوامر `functions`:

- `npm --prefix functions run serve`: تشغيل Functions Emulator فقط عبر Firebase CLI.
- `npm --prefix functions run shell`: فتح Functions shell.
- `npm --prefix functions run start`: مرادف للـshell.
- توجد أوامر deploy وlogs، ولم تُشغّل في هذا الفحص.

هيكل النشر المعروف من الملفات محدود إلى Cloud Functions في `firebase.json`. لا توجد إعدادات Firebase Hosting أو Vercel داخل المستودع، لذلك لا يمكن تحديد منصة نشر الواجهة من الملفات الحالية.

## 3. حالة Git

| البند | القيمة |
|---|---|
| الفرع الحالي | `feature/reliability-upgrade` |
| Commit الحماية | `ed445120b8baeae94f1a53408f8d115e1f381f18` |
| Commit العملية 1A | `b6bde70e8f38a80ca018a73aba6e8ac344228f19` |
| آخر Commit عند بدء 1B | `b6bde70e8f38a80ca018a73aba6e8ac344228f19` |
| مساحة العمل عند البدء | نظيفة؛ نواتج `dist` والإعدادات المحلية المعروفة متجاهلة |
| Remote | `origin` مرتبط بمستودع GitHub |
| Upstream للفرع الحالي | غير مضبوط |
| تعارضات Git | لا توجد |

## 4. بنية المشروع

| المسار | الوظيفة |
|---|---|
| `package.json` | حزم الواجهة وأوامر Vite وESLint |
| `package-lock.json` | قفل إصدارات حزم الجذر |
| `vite.config.js` | Vite مع React plugin فقط |
| `index.html` | قالب HTML ونقطة تحميل `src/main.jsx` |
| `src/main.jsx` | إنشاء React root داخل `StrictMode` |
| `src/App.jsx` | معظم منطق الواجهة وFirestore والمسابقات؛ 8,881 سطرًا |
| `src/App.css` | معظم تنسيق التطبيق؛ 20,221 سطرًا |
| `src/index.css` | تنسيق عام محدود |
| `src/assets` و`public` | الصور والصوتيات والأصول الثابتة |
| `firebase.json` | إعداد Cloud Functions فقط |
| `.firebaserc` | مشروع Firebase الافتراضي المكتشف: `family-quiz-b7960` |
| `functions/package.json` | Runtime وحزم وأوامر Cloud Functions |
| `functions/index.js` | `testFunction` و`finalizeQuestion`؛ 324 سطرًا |
| `eslint.config.js` | إعداد ESLint للمتصفح وReact؛ لا يعرّف بيئة Node للدوال |
| `SECURITY_ADMIN_CODE_INCIDENT.md` | توثيق حادث رمز الإدارة ومعالجته في العملية 1A |

لا توجد مجلدات مستقلة للخدمات أو Hooks؛ جميع Hooks وأغلب عمليات Firebase موجودة داخل `src/App.jsx`. لا توجد ملفات اختبارات أو TypeScript.

## 5. مخطط التدفق الحالي

```text
المقدم
→ زر في AdminControl أو DisplayScreen
→ preloadQuestionForReady()
→ كتابة rooms/family-quiz-001 بالحالة ready والسؤال والتوقيتات
→ مؤقت محلي لمدة 3 ثوانٍ
→ activatePreloadedQuestion()
→ كتابة stage=question وquestionSentAt
→ onSnapshot في useRoom()
→ جهاز المتسابق يعرض currentQuestion
→ submitAnswer()
→ حساب الصحة والوقت والنقاط والجوكر داخل React
→ addDoc إلى rooms/{roomId}/answers
→ revealCorrectAnswer() ثم showResultsFast()
→ calculateResultsForCurrentQuestion() داخل React
→ Transaction لقفل المعالجة ثم Batch للاعبين والغرفة
→ resultsDisplaySnapshot داخل مستند الغرفة
→ onSnapshot يعرض النتائج

المسار الموجود ولكن غير المستخدم حاليًا:
عميل غير موجود → Callable finalizeQuestion → Admin SDK → Firestore
```

## 6. مسار إرسال السؤال

### المشغلات

يوجد مساران فعليان من React:

1. لوحة التحكم المحلية `AdminControl`:
   - الأزرار عند `src/App.jsx` نحو 5474–5548.
   - الدالة `advanceFromDashboard` عند 5176–5213.
2. شاشة العرض `DisplayScreen`:
   - عناصر التحكم عند 6893–6998.
   - `goNextQuestion` عند 6800–6816.
   - `startReadyThenSend` عند 6699–6771.

الأسئلة التصويتية تمر عبر `startCategoryVote` ثم `resolveCategoryVote` عند 1102–1163. الأسئلة العادية تمر عبر:

- `buildQuestionPayload` عند 1016–1053.
- `preloadQuestionForReady` عند 1055–1100.
- `activatePreloadedQuestion` عند 1166–1202.
- يوجد fallback تلقائي في `AutoActivateReadyQuestion` عند 2193–2212.

### كتابات Firestore

كل الإرسال مباشر من React إلى المستند:

`rooms/family-quiz-001`

أهم الحقول المكتوبة في مرحلة `ready`:

- `stage`
- `currentQuestion`
- `currentQuestionIndex`
- `questionStartedAtMs`
- `answerRevealAtMs`
- `answerStartAtMs`
- `answerEndAtMs`
- `questionSentAt`
- حقول الوسائط
- `processedQuestionId`
- `resultsCalculated`
- `processingQuestionId`
- خرائط نقاط/ترتيب مؤقتة
- `nextQuestionReadyUntilMs`
- `nextQuestionReadyQuestionIndex`
- `usedQuestionIds`
- `stageStartedAtMs`
- `updatedAt`

مرحلة التفعيل تكتب `stage="question"` و`questionSentAt=serverTimestamp()` وحقول بداية المرحلة.

### الذرية والتكرار والتوقيت

- لا تُستخدم Transaction أو Batch في إرسال السؤال نفسه.
- التحقق في `activatePreloadedQuestion` هو `getDoc` ثم `updateDoc` منفصلان، وليس عملية ذرية.
- توجد حواجز محلية بـ`useRef` وstate لمنع الضغط المتكرر داخل المكوّن نفسه، لكنها لا تمنع نافذتين أو جهازين من التنفيذ بالتوازي.
- معرف السؤال وفهرسه يُستخدمان لمنع تفعيل طلب قديم، لكن لا يوجد `stateVersion` أو `questionVersion` أو `nonce`.
- وقت `questionSentAt` من الخادم، لكن `questionStartedAtMs` وبداية/نهاية الإجابة تُحسب من `Date.now()` في جهاز المقدم.
- `getServerNow` عند 149–151 يعيد الساعة المحلية كما هي ولا يطبق offset الخادم المحسوب في `useRoom`.

## 7. مسار استقبال السؤال

جهاز المتسابق يعرف ببدء السؤال من خلال `useRoom` في `src/App.jsx` عند 562–592:

- ينشئ `onSnapshot` على `rooms/family-quiz-001`.
- ينسخ بيانات المستند إلى state محلي.
- `PlayerPanel` عند 8413 وما بعده يقرأ `room.stage` و`room.currentQuestion`.
- عندما تصبح المرحلة `question`، يعرض `QuestionScreen`.

المستمع يُنشأ داخل `useEffect([])` ويُلغى باستدعاء `unsub()` في cleanup. Hooks الأخرى تنشئ مستمعين منفصلين إلى:

- `players`: عند 594–617.
- `questions`: عند 619–652.
- جميع الأسئلة: عند 682–703.
- إجابات السؤال الحالي: عند 705–731.
- جميع الإجابات: عند 734–753.
- الرسائل: عند 756–777.
- الزوار عبر مجموعة اللاعبين: عند 779–800.

الاستنتاجات:

- لا يوجد polling لبدء السؤال؛ المسار الأساسي real-time عبر `onSnapshot`.
- React `StrictMode` قد ينشئ/يلغي المستمع مرة إضافية في التطوير، لكن cleanup موجود.
- يمكن أن توجد مستمعات متكررة لنفس المجموعة بسبب تركيب عدة Hooks في `AdminPanel` و`DisplayScreen`، خصوصًا `players` و`answers`.
- لا توجد callbacks صريحة لأخطاء `onSnapshot`.
- لا يُفحص `snapshot.metadata.fromCache` أو `hasPendingWrites`.
- لا توجد معالجة مخصصة لـ`visibilitychange` أو `pageshow` أو `online/offline`.
- Firestore SDK يعيد الاتصال عادةً تلقائيًا، لكن التطبيق لا يعرض حالة الاتصال ولا يطبق retry أو إعادة مزامنة صريحة.
- لا يوجد رقم نسخة للحالة؛ الاعتماد على `stage` ومعرف السؤال قد يسمح مؤقتًا بعرض حالة مخزنة أو متأخرة.
- فشل المستمع أو رفض Rules قد يترك الواجهة على حالة قديمة دون رسالة واضحة، وقد يبدو كأن التحديث يحتاج refresh.
- لا يوجد Service Worker في المشروع الحالي، لذلك لا يوجد كاش PWA خاص يمكنه تقديم نسخة JavaScript قديمة.

## 8. مسار إرسال الإجابة

`QuestionScreen` يستدعي `submitAnswer` عند اختيار الإجابة. الدالة موجودة في `src/App.jsx` عند 8544–8615.

العميل يحسب ويرسل:

- `selectedIndex`
- `isCorrect`
- `basePoints`
- `points`
- `answeredAt`
- `answerStartAtMs`
- `answerTimeSeconds`
- `jokerApplied`
- `jokerMultiplier`
- `jokerTiming`
- بيانات اللاعب، السؤال، التدريب، والتصويت
- `createdAt=serverTimestamp()`

الكتابة مباشرة من React باستخدام `addDoc` إلى:

`rooms/family-quiz-001/answers`

لا توجد Cloud Function تتحقق من الإجابة قبل الحفظ. `calculateBasePoints` عند 370–384 و`calculateFinalPoints` عند 386–393 يعملان في المتصفح.

### التكرار والتعديل والتأكيد

- الإجابة الحقيقية تستخدم `addDoc`، لذلك معرف المستند عشوائي وليس ثابتًا حسب اللاعب والسؤال.
- توجد حواجز UX: state محلي، `localStorage`، ونتيجة `useAnswers`.
- يمكن تجاوزها من جهاز/متصفح آخر أو بعد مسح التخزين، ما يسمح بأكثر من مستند إجابة لنفس اللاعب والسؤال.
- مسار النتائج يرتب الإجابات ثم يبني `Map` حسب اللاعب؛ عند التكرار تصبح الإجابة الأخيرة زمنيًا هي المستخدمة عمليًا.
- لا يوجد مسار UI لتعديل الإجابة، لكن منع التعديل الحقيقي يعتمد على Rules غير الموجودة في المستودع.
- `answeredAt` يعتمد على ساعة جهاز المتسابق، وكذلك النقاط الزمنية.
- الواجهة تعرض «تم إرسال إجابتك» وتكتب القفل المحلي قبل اكتمال `await addDoc`.
- لا توجد `try/catch` داخل `submitAnswer` لفك القفل أو إظهار فشل الكتابة.
- لا يُستخدم `hasPendingWrites` لتأكيد وصول الإجابة إلى الخادم.
- عند انقطاع الشبكة قد تبقى الواجهة مقفلة على أنها أرسلت، وقد تُرسل الكتابة لاحقًا عند عودة الاتصال بحسب حالة SDK؛ لا يوجد تحقق خادمي من أن السؤال ما زال مفتوحًا عند الوصول.

## 9. مسار احتساب النتائج

### المسار الفعلي في React

المسار المستخدم حاليًا هو:

- إنهاء السؤال: الدالة `endQuestionAndReveal` في القسم الخاص بإجراءات Firebase داخل `src/App.jsx`.
- كشف الإجابة: `revealCorrectAnswer` عند 1299–1332.
- إظهار النتائج: `showResultsFast` عند 1818–1830.
- احتساب النتائج: `calculateResultsForCurrentQuestion` عند 1527–1816.
- التشغيل التلقائي: `AutoProcessResults` عند 2279–2312.
- العرض: `ResultsDisplay` عند 3451–3611.
- الانتقال للسؤال التالي: `advanceFromDashboard` أو `goNextQuestion`.

`claimQuestionProcessing` يستخدم Firestore Transaction لوضع قفل مؤقت في مستند الغرفة. بعد ذلك يقرأ React الإجابات واللاعبين، ويثق في `points` و`isCorrect` والجوكر الموجودة في مستندات الإجابات. يكتب تحديثات اللاعبين وSnapshot الغرفة في `writeBatch` واحد، مع `lastQuestionId` لمنع إضافة النقاط مرة ثانية للاعب نفسه.

تظهر حالة «جاري احتساب النتائج» في `ResultsDisplay` عندما لا يوجد `resultsDisplaySnapshot` صالح للسؤال الحالي، وتظهر «جاري تجميع النتائج» في أدوات شاشة العرض حتى يتطابق `processedQuestionId`.

احتمالات التعليق:

- فشل القراءة أو الكتابة أو رفض Rules.
- قفل `processingQuestionId` ما زال حديثًا.
- وجود `stage="results"` دون Snapshot صالح.
- تحرك المرحلة أو تغير السؤال أثناء عملية طويلة.
- عدم وجود جهاز Admin/Display مركب يشغّل الأتمتة.
- خطأ يُسجل في `resultsError` دون عرضه بوضوح في شاشة النتائج.

يوجد retry يدوي بعد نحو 3.5 ثوانٍ في شاشة العرض، وزر تجاوز بدون نقاط. توجد آلية stale lock بعد 9 ثوانٍ، لكن لا يوجد orchestration خادمي رسمي أو retry مركزي.

### `finalizeQuestion`

موجودة في `functions/index.js` عند 54–324:

- النوع: Callable Cloud Function من الجيل الثاني عبر `onCall`.
- المنطقة: غير محددة في الكود؛ تستخدم المنطقة الافتراضية لمنصة Firebase Functions.
- Runtime: Node 24.
- Admin SDK: مستخدم للوصول إلى Firestore.
- المدخلات: `roomId` اختياري، `questionId`، و`nextStage`.
- لا يوجد فحص `request.auth` أو صلاحية Admin.
- لا تتحقق من أن `questionId` هو السؤال الحالي أو أن المرحلة مناسبة.
- تثق في `answer.points` و`answer.isCorrect` وحقول الجوكر القادمة أصلًا من العميل.
- تستخدم Transaction لقفل المعالجة، ثم Batch منفصلًا لتحديث اللاعبين، ثم تحديثًا منفصلًا لمستند الغرفة.
- `lastQuestionId` يقلل مضاعفة النقاط عند إعادة المحاولة، لكن العملية الكاملة ليست ذرية بين Batch اللاعبين وتحديث الغرفة.
- إذا استُدعيت مرتين، يمنع القفل أو `processedQuestionId` التنفيذ المتزامن عادةً؛ وبعد انتهاء صلاحية القفل يمكن إعادة المحاولة.
- لا توجد مهلة تطبيقية صريحة، ولا retry من الواجهة، ولا استدعاء فعلي لها من التطبيق.

البحث لم يجد `getFunctions` أو `httpsCallable` أو استدعاء `finalizeQuestion` داخل `src`. لذلك يوجد مساران مكتوبان للاحتساب، لكن React وحده هو المسار المتصل حاليًا. كما تُركب أتمتة النتائج في أكثر من موضع، ويعتمد منع السباق على القفل المشترك.

مصدر النتائج ليس وحيدًا تمامًا:

- Live results تعتمد `resultsDisplaySnapshot` في مستند الغرفة.
- Preview/الأرشيف يعيد حساب Snapshots داخل React من جميع الإجابات عبر `buildPreviewResultsSnapshot` عند 3613–3700.
- `questionResultsById` يُكتب ككائن كامل في عدة مسارات، ما قد يستبدل نتائج أسئلة سابقة بدل دمجها.

## 10. حالة Firebase

### Firestore

البنية المكتشفة:

```text
rooms/{roomId}
├─ players/{playerId}
├─ questions/{questionId}
├─ answers/{randomAnswerId}
└─ messages/{messageId}
```

مستند الغرفة يحمل أيضًا:

- `currentQuestion` و`stage` والتوقيتات.
- `questionPackages` و`categoryVote`.
- حالة النتائج والأقفال و`resultsDisplaySnapshot`.
- `questionResultsById`.
- خرائط الجوكر والنقاط وحركة الترتيب.
- `gameHistory` وسجل التجاوز.
- إعدادات الاختبار والجوائز والفيديو.

هذا المستند كثير التحديث ويجمع تاريخًا وSnapshots وخرائط متزايدة، ما يرفع خطر الاقتراب من حد حجم مستند Firestore وزيادة تنازع الكتابات.

### Cloud Functions

| الدالة | النوع | المصادقة | الاستخدام |
|---|---|---|---|
| `testFunction` | HTTP `onRequest` v2 | لا يوجد تحقق | فحص بسيط |
| `finalizeQuestion` | Callable `onCall` v2 | لا يوجد `request.auth` | غير مستدعاة من الواجهة |

تم ضبط `maxInstances: 10`. المنطقة غير محددة. Admin SDK مهيأ بـ`initializeApp()`.

### Realtime Database

- لا يوجد استيراد لـ`firebase/database` في كود التطبيق.
- لا توجد إعدادات أو Rules لـRTDB في المستودع.
- لا يوجد Presence باستخدام RTDB.
- يوجد بديل Presence تقريبي داخل Firestore: سجلات زوار في `players` تُحدّث كل 20 ثانية عند 8467–8498.
- لا يمكن معرفة هل RTDB مفعلة في Firebase Console من الملفات فقط.

### Authentication

- لا يوجد استيراد أو استخدام لـFirebase Authentication في الواجهة.
- لا يوجد `onAuthStateChanged` أو تسجيل دخول أو Custom Claims.
- لا توجد صلاحية Admin موثوقة من الخادم.
- العملية 1A عطلت لوحة الإدارة في Production، لكن شاشة العرض العامة ما زالت تحتوي أدوات تحكم حساسة.

### Rules

- لا توجد Firestore Rules أو RTDB Rules أو Storage Rules في المستودع.
- `firebase.json` لا يشير إلى ملفات Rules.
- لا يمكن معرفة القواعد المنشورة فعليًا دون الاتصال ببيئة Firebase، وهو خارج نطاق الفحص.
- الواجهة تحتوي عمليات مباشرة لتعديل النقاط واللاعبين وحالة الغرفة والأسئلة والإجابات والجوكر؛ السماح أو المنع الفعلي يعتمد كليًا على القواعد المنشورة غير الموثقة هنا.

### Emulator

- لا يوجد قسم `emulators` في `firebase.json`.
- يوجد Script لتشغيل Functions Emulator فقط، لكنه يعتمد على Firebase CLI غير المدرج كحزمة محلية.
- لا يوجد Firestore Emulator مهيأ.
- التطبيق لا يستدعي `connectFirestoreEmulator` أو `connectFunctionsEmulator`.
- في وضع التطوير يتصل التطبيق بإعداد Firebase العادي، وليس ببيئة محلية معزولة.
- لم يُشغّل Emulator في هذا الفحص لأنه غير مهيأ كاملًا.

## 11. حالة PWA

| البند | الحالة |
|---|---|
| `vite-plugin-pwa` | غير مثبت وغير مستخدم |
| Manifest | غير موجود |
| `start_url` / `scope` / `display` | غير محددة |
| أيقونات PWA | لا توجد إعدادات Manifest؛ توجد أصول عادية فقط |
| Service Worker | غير موجود |
| التسجيل | لا يوجد تسجيل في `src/main.jsx` |
| `registerType` | غير محدد |
| `skipWaiting` / `clientsClaim` | غير موجودة |
| `cleanupOutdatedCaches` | غير موجودة |
| Precache / Runtime caching | غير موجود |
| كاش Firebase | لا توجد استراتيجية Service Worker |
| إدارة تحديثات | غير موجودة |
| وضع standalone/iOS/Android | لا يوجد كشف |
| صفحة تثبيت | غير موجودة |
| إعادة تحميل/إعادة اتصال | لا توجد معالجة مخصصة |
| Wake Lock | غير مستخدم |

لا توجد حاليًا احتمالية تشغيل نسخة قديمة بسبب Service Worker تابع لهذا المشروع، لأنه غير موجود. تظل سياسات كاش المتصفح أو منصة الاستضافة خارج ما يمكن إثباته من المستودع.

## 12. حالة الأمان

تفاصيل حادث رمز الإدارة موثقة في:

`SECURITY_ADMIN_CODE_INCIDENT.md`

لم تُكرر أي قيمة سرية في هذا التقرير. لم يظهر private key أو service account أو ملف `.env` متتبع.

الملاحظات الأمنية الرئيسية:

- شاشة العرض العامة عبر `?view=display` تتضمن أزرارًا تبدأ المسابقة وترسل الأسئلة وتنهيها وتحسب أو تتجاوز النتائج.
- لا توجد هوية Admin موثوقة.
- العميل يكتب الإجابات والنقاط وصحة الإجابة والجوكر مباشرة.
- العميل يستطيع تنفيذ كتابات حساسة إلى الغرفة واللاعبين والأسئلة.
- لا توجد Rules في المستودع لمراجعة نموذج الصلاحيات.
- Callable `finalizeQuestion` لا تتحقق من هوية المستدعي.
- إعداد Firebase Web موجود في العميل كما هو متوقع لتطبيق ويب؛ لا يُعامل وحده كسر، لكن الحماية يجب أن تأتي من Authentication وRules والخادم.

## 13. نتيجة البناء والفحوصات

| الأمر | النتيجة | الأخطاء/التحذيرات | معالجة لاحقة؟ |
|---|---|---|---|
| `node --version` | نجح: v24.15.0 | لا يوجد | لا |
| `npm.cmd --version` | نجح: 11.12.1 | لا يوجد | لا |
| `npm.cmd ls --depth=0` | نجح | الحزم مثبتة | لا |
| `npm.cmd --prefix functions ls --depth=0` | نجح | الحزم مثبتة | لا |
| `npm run build` | نجح | JavaScript نحو 815 KB وCSS نحو 342 KB؛ تحذير chunk أكبر من 500 KB | نعم |
| `npm run lint` | فشل | 6 أخطاء `no-undef` في `functions/index.js`: أربعة لـ`require` واثنان لـ`exports` | نعم |
| اختبارات الجذر | لم تُشغّل | لا يوجد Script باسم `test` ولا ملفات اختبارات | نعم |
| اختبارات Functions | لم تُشغّل | توجد حزمة `firebase-functions-test` لكن لا يوجد Script أو ملفات اختبار | نعم |
| Functions lint مستقل | لم يُشغّل | لا يوجد Script مستقل | نعم |
| Emulator | لم يُشغّل | غير مهيأ في `firebase.json` ولا يتصل به التطبيق | نعم |

فشل ESLint قديم وموجود في إعداد المشروع قبل إنشاء هذا التقرير؛ العملية 1B لم تعدّل `functions/index.js` أو إعداد ESLint.

## 14. المخاطر مرتبة

| الرقم | الخطر | المستوى | التأثير | الملف/المسار | العملية المقترحة |
|---:|---|---|---|---|---|
| 1 | شاشة العرض العامة تحتوي أدوات تحكم وكتابات حساسة دون هوية Admin | حرجة | أي زائر للمسار قد يغيّر مراحل المسابقة والنتائج | `src/App.jsx:6414–6998` | Rules وAuthentication ثم فصل صلاحيات العرض |
| 2 | غياب Rules من المستودع مع كتابات مباشرة واسعة من العميل | حرجة | لا يمكن تدقيق أو ضمان منع تعديل النقاط والحالة | `firebase.json` و`src/App.jsx` | Rules وAuthentication |
| 3 | العميل يحسب ويرسل الصحة والنقاط والجوكر والتوقيت | حرجة | قابلية التلاعب بالنتائج من متصفح المتسابق | `src/App.jsx:8544–8615` | إرسال الإجابة والتحقق من السيرفر |
| 4 | `finalizeQuestion` بلا تحقق هوية وتثق في حقول الإجابة العميلية | حرجة | استدعاء غير مصرح أو احتساب بيانات متلاعب بها | `functions/index.js:54–324` | تأمين Callable وإعادة الحساب من بيانات موثوقة |
| 5 | الإجابات تستخدم معرفات عشوائية ولا تفرض إجابة واحدة | عالية | تكرار الإجابة واختيار آخر إجابة أثناء الاحتساب | `src/App.jsx:8595` | معرف حتمي/Transaction/تحقق خادمي |
| 6 | React ما زال مسار الاحتساب الفعلي بينما Cloud Function غير مستخدمة | عالية | منطق مزدوج وانحراف وسلوك سباق بين المشغلات | `src/App.jsx:1527–1816` و`functions/index.js` | توحيد `finalizeQuestion` |
| 7 | التوقيت والنقاط يعتمدان على ساعات الأجهزة | عالية | عدم عدالة وفروق عند انحراف الساعة أو التلاعب بها | `src/App.jsx:59–60,149–151,370–393` | وقت خادم موحد |
| 8 | إرسال السؤال مرحلتان غير ذريتين وبلا رقم نسخة | عالية | نقرات/نوافذ متزامنة قد تكتب حالة متعارضة | `src/App.jsx:1055–1202` | liveState/version وTransaction |
| 9 | النتائج قد تبقى دون Snapshot صالح مع أخطاء غير ظاهرة | عالية | توقف على «جاري احتساب النتائج» والحاجة لتجاوز يدوي | `src/App.jsx:3451–3544` | orchestration خادمي وحالة خطأ/retry رسمية |
| 10 | مستند الغرفة ضخم وكثير التحديث، وبعض الكتابات تستبدل `questionResultsById` | عالية | فقدان نتائج سابقة أو بلوغ حد حجم المستند | `src/App.jsx:1633–1793` و`functions/index.js` | فصل liveState والنتائج/الأرشيف |
| 11 | مستمعات `onSnapshot` بلا error handlers أو metadata أو حالة اتصال | متوسطة | فشل صامت أو عرض حالة قديمة | `src/App.jsx:562–800` | تحسين الاستقبال وإعادة الاتصال |
| 12 | لا توجد اختبارات آلية أو اختبار 50 لاعبًا | متوسطة | تغييرات الموثوقية بلا شبكة أمان | المشروع كاملًا | Emulator واختبارات حمل وسلوك |
| 13 | لا توجد بيئة Emulator معزولة والتطوير يتصل بالإعداد العادي | متوسطة | خطر لمس بيانات حقيقية أثناء التطوير | `firebase.json` و`src/App.jsx` | إعداد Emulator |
| 14 | PWA وService Worker وManifest غير موجودة | متوسطة | لا تثبيت أو تحديث/كاش مضبوط للأجهزة | `vite.config.js` و`src/main.jsx` | عملية PWA لاحقة |
| 15 | ESLint لا يميز بيئة Node للدوال | منخفضة | فحص CI يفشل رغم أن البناء ينجح | `eslint.config.js` و`functions/index.js` | ضبط ESLint للدوال |
| 16 | تضخم `App.jsx` و`App.css` وتشابك UI مع Firebase | منخفضة | صعوبة الاختبار والصيانة وارتفاع خطر الانحدار | `src/App.jsx` و`src/App.css` | إعادة هيكلة متأخرة بعد تثبيت السلوك |

## 15. الديون التقنية

- `App.jsx` يجمع إعداد Firebase وHooks وعمليات البيانات والواجهة والأتمتة في 8,881 سطرًا.
- `App.css` يبلغ 20,221 سطرًا مع طبقات تنسيق متكررة.
- منطق احتساب النتائج مكرر بين React وCloud Functions.
- منطق Snapshot التاريخي يعيد الحساب من الإجابات داخل React.
- الواجهة مرتبطة مباشرة بمسارات Firestore وحقولها.
- لا توجد طبقة خدمات أو مخطط بيانات موحد أو validation مشترك.
- لا توجد اختبارات وحدات أو تكامل أو end-to-end.
- `firebase-functions-test` مثبتة بلا اختبارات.
- إعداد ESLint يعامل ملفات Functions كبيئة متصفح.
- README ما زال نص قالب Vite ولا يشرح تشغيل النظام أو بنيته.
- لا يوجد TypeScript أو schema validation.
- لا توجد مراقبة رسمية للاتصال أو latency أو acknowledgements.
- لا توجد إعدادات Emulator أو Rules قابلة للمراجعة.
- لا توجد PWA أو استراتيجية تحديث.
- الحزمة الرئيسية كبيرة ولا يوجد code splitting ظاهر.

## 16. خريطة العمليات التالية

الترتيب المقترح، دون تنفيذ:

1. إعداد Firebase Emulator Suite وربط التطبيق به في التطوير، مع بيانات اختبار معزولة.
2. تثبيت عقد `finalizeQuestion` واختبار idempotency والأخطاء قبل جعلها المصدر الرسمي.
3. بناء اختبارات تكامل ومحاكاة 50 لاعبًا والإجابات المتزامنة والانقطاع.
4. فصل `liveState` صغير ذي `stateVersion` عن مستند الغرفة التاريخي.
5. تحسين استقبال السؤال وإعادة الاتصال واكتشاف cache/pending/error.
6. إضافة Presence وتأكيد استلام السؤال والمرحلة للأجهزة.
7. نقل إرسال الإجابة والتحقق والتوقيت والنقاط إلى مسار خادمي.
8. تطبيق Authentication وAdmin Claims وFirestore Rules واختبارها في Emulator.
9. تصميم PWA وتحديثاتها وكاشها بعد استقرار بروتوكول live state.
10. إعادة هيكلة `App.jsx` والخدمات والHooks بعد وجود اختبارات تحمي السلوك.

## 17. توصية العملية التالية مباشرة

العملية التالية الوحيدة الموصى بها هي:

**إعداد بيئة Firebase Emulator معزولة وربط وضع التطوير بها، ثم إضافة اختبارات baseline لمسارات الغرفة والإجابة والنتائج.**

السبب: أي تعديل مباشر لـ`finalizeQuestion` أو Rules أو live state الآن سيؤثر في بيانات ومسارات حساسة بلا بيئة آمنة أو اختبارات. Emulator هو الأساس الذي يسمح بإعادة إنتاج التعليق والتكرار والانقطاع، واختبار 50 لاعبًا، والتحقق من Rules وCloud Functions لاحقًا دون لمس الإنتاج.

لم تُنفذ أي عملية من خريطة الطريق ضمن العملية 1B.
