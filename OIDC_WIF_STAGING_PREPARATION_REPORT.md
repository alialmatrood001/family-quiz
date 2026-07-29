# تقرير فحص وتجهيز Vercel OIDC / Google WIF لـStaging

التاريخ: 2026-07-29
الفرع: `feature/reliability-upgrade`
Commit الأساس: `2f4da476cabe4f80fe15ce8a47fe11e3302afec7`
النطاق: تجهيز وفحص محلي فقط، دون إنشاء موارد أو Login أو Link أو Deploy.

## النتيجة التنفيذية

لم يكن مسار Vercel في الكود السابق متوافقًا مع OIDC؛ كان يتطلب
`FIREBASE_ADMIN_CLIENT_EMAIL` و`FIREBASE_ADMIN_PRIVATE_KEY` ثم يستخدم `cert()`.
أما `applicationDefault()` فكان مقصورًا على Firebase runtime المُدار، ولا يكفي
وحده في Vercel من دون external-account configuration.

أصبح المسار المقترح:

`Vercel request OIDC header → request-local token supplier → Google STS → keyless service-account impersonation → Firebase Admin Credential`

- لا يُنشأ ملف JSON.
- لا يُستخدم `GOOGLE_APPLICATION_CREDENTIALS`.
- لا يوجد private key في Vercel.
- لا يُخزن OIDC token أو Google access token ولا يدخل المتصفح أو logs.
- access token الناتج قصير العمر، وطلب impersonation مضبوط على 900 ثانية.
- Emulator بقي بلا credential ومقيدًا بـ`demo-family-quiz` وlocalhost.
- `legacy-key` بقي خيارًا صريحًا منفصلًا، ويُرفض خلطه مع OIDC.

تعطي Vercel الـOIDC token للـFunction في رأس `x-vercel-oidc-token`، لا كقيمة
يمكن الاعتماد عليها عند module initialization. لذلك أصبح handler يربط token
بسياق الطلب باستخدام `AsyncLocalStorage` قبل استدعاء Firebase Admin. توضح
[وثائق Vercel OIDC](https://vercel.com/docs/oidc) سلوك الرأس ومدة token،
وتوفر [مراجع Vercel OIDC](https://vercel.com/docs/oidc/reference) تفاصيل claims
والمكتبة المساعدة.

## المعمارية والضمانات

يبني `IdentityPoolClient` من `google-auth-library` إعداد external account داخل
الذاكرة باستخدام `subject_token_supplier`. هذا النمط موثق في
[Google Auth Library](https://github.com/googleapis/google-auth-library-nodejs)
لـOIDC providers التي تحتاج supplier مخصصًا.

قبل تسليم token إلى Google:

- المشروع الخادمي يجب أن يكون `family-quiz-staging`.
- مشروع Production المحظور يجب أن يكون `family-quiz-b7960`.
- mode يجب أن يكون `oidc`.
- issuer وaudience وsubject يجب أن تطابق الهوية المعتمدة حرفيًا.
- subject يقبل `environment:production` فقط داخل مشروع Vercel Staging المستقل؛
  Preview وDevelopment ومشروع Vercel آخر مرفوضة.
- wildcard وإعدادات mixed mode مرفوضة.
- token يجب أن يكون JWT سليم البنية وغير منتهي أو قريب من الانتهاء.

فحص claims المحلي هو fail-fast فقط ولا يُعامل كتوقيع موثوق. Google STS وWIF
Provider هما من يتحقق فعليًا من توقيع Vercel issuer والـallowed audience
والـattribute condition.

## متغيرات البيئة

### إعداد التطبيق والخادم

- `APP_ENVIRONMENT`
- `SERVER_TRANSPORT`
- `FIREBASE_ADMIN_AUTH_MODE`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_PRODUCTION_PROJECT_ID`
- `CONFIRM_STAGING_PROJECT`
- `FIREBASE_DATABASE_URL`
- `STAGING_ORIGIN`
- `PRODUCTION_ORIGIN`
- `VERCEL_ALLOWED_ORIGINS`

### إعداد WIF

- `GOOGLE_CLOUD_PROJECT`
- `GCP_PROJECT_NUMBER`
- `GCP_WORKLOAD_IDENTITY_POOL_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER_ID`
- `GCP_SERVICE_ACCOUNT_EMAIL`
- `VERCEL_OIDC_ISSUER`
- `VERCEL_OIDC_AUDIENCE`
- `VERCEL_OIDC_SUBJECT`

`VERCEL_OIDC_TOKEN` متغير/رأس نظام تديره Vercel، ولا يُدخل يدويًا ولا يُحفظ.
لا توجد أي قيمة خادمية باسم `VITE_*`.

### Legacy غير المفعّل

- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`

لا يقبل الكود وجود أي منهما مع إعدادات OIDC.

## هل نحتاج Service Account؟

نعم: المعمارية الحالية تستخدم Service Account مخصصًا لـStaging **بلا مفتاح**
كهوية نهائية عبر impersonation. هذا يوحد صلاحيات Firebase Auth وFirestore
وRealtime Database تحت IAM ويمكن إلغاؤه أو تقييده دون تدوير secrets. توصي
[أفضل ممارسات Google](https://docs.cloud.google.com/iam/docs/best-practices-for-using-service-accounts-in-deployment-pipelines)
باستخدام WIF وتجنب مفاتيح Service Account في خطوط التشغيل الخارجية.

## أقل صلاحيات IAM

### على Service Account نفسه

- `roles/iam.workloadIdentityUser`: يمنح فقط للـfederated principal المطابق
  للـsubject المعتمد، على Service Account المحدد. يتضمن
  `iam.serviceAccounts.getAccessToken` اللازم لـimpersonation. لا يحتاج المسار
  إلى `roles/iam.serviceAccountTokenCreator` ولا إلى إنشاء مفتاح.

مرجع الصلاحية:
[IAM service-account roles](https://docs.cloud.google.com/iam/docs/service-account-permissions).

### أدوار Service Account داخل مشروع Staging

- `roles/datastore.user`: قراءة/كتابة ومعاملات Firestore. لا يحتاج إدارة
  فهارس أو قواعد أو نسخ احتياطية.
- التحقق العادي من Firebase ID Token لا يحتاج إدارة مستخدمين. إذا كان
  `checkRevoked` أو قراءة المستخدم مطلوبة، يستخدم `roles/firebaseauth.viewer`.
- إذا ستُدار الحسابات أو ستُعين custom claims خادميًا:
  `roles/firebaseauth.admin`، لأنه يتضمن `firebaseauth.users.update`.
- Realtime Database لا تستخدمه عمليات المسابقة الخادمية الحالية. لا يُمنح
  دور إضافي قبل الحاجة. وثائق Admin Database توثق `roles/editor` للوصول
  الإداري الكامل إلى data plane، وهو واسع ولا يحقق least privilege المطلوب؛
  لذلك يجب حسمه واختباره في Staging قبل منحه، أو تصميم
  `databaseAuthVariableOverride` وقواعد محدودة. لا يكفي افتراض أن
  `roles/firebasedatabase.admin` يمنح أقل صلاحية data-plane، لأنه دور إدارة
  موارد/instances بحسب قائمة الصلاحيات.

مراجع:
[Firestore IAM](https://docs.cloud.google.com/firestore/docs/security/iam)،
[Firebase Authentication roles](https://firebase.google.com/docs/projects/iam/roles-predefined-product)،
[Realtime Database Admin SDK](https://firebase.google.com/docs/database/admin/start).

## القيم التي يجب جمعها لاحقًا

- Project Number الخاص بـ`family-quiz-staging`.
- Workload Identity Pool ID.
- Workload Identity Provider ID.
- بريد Service Account المخصص بلا مفتاح.
- issuer المعتمد.
- allowed audience المعتمد.
- subject condition المطابق لمشروع Vercel Staging وبيئة `production`.

لا يحتاج الكود credential configuration file؛ يبني resource audience التالي
داخل الذاكرة:

`//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`

## خطوات Google Cloud اليدوية — لم تُنفذ

1. افتح المشروع `family-quiz-staging` وتأكد أن رقمه لا يخص Production.
2. فعّل، عند الموافقة، IAM وSecurity Token Service وIAM Service Account
   Credentials APIs، وتأكد أن Firebase Auth وFirestore وRTDB APIs المطلوبة
   مفعلة في مشروع Staging فقط.
3. أنشئ Service Account مخصصًا لـVercel Staging بلا أي key.
4. امنحه `roles/datastore.user` فقط كبداية، وأضف دور Firebase Auth المناسب
   فقط إذا كان runtime سيقرأ/يدير المستخدمين أو custom claims.
5. لا تمنح RTDB دورًا واسعًا حتى يكتمل قرار data-plane السابق.
6. أنشئ Workload Identity Pool في مشروع Staging.
7. أنشئ OIDC Provider داخل Pool:
   - issuer URI يساوي issuer المعتمد حرفيًا.
   - allowed audience يساوي Vercel audience المعتمد حرفيًا.
   - mapping: `google.subject=assertion.sub`.
   - condition تقيد `assertion.aud` و`assertion.sub` بالقيم المعتمدة.
8. امنح principal الخاص بالـsubject فقط
   `roles/iam.workloadIdentityUser` على Service Account. لا تمنح كامل Pool.
9. راجع IAM policy وتأكد من غياب Production والمشاريع أو البيئات الأخرى.
10. لا تنشئ Service Account key ولا credential JSON.

يوضح
[دليل Google لنشر WIF](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
إنشاء provider والـattribute mappings وservice-account impersonation، وتوصي
[أفضل ممارسات WIF](https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation)
بتقييد providers متعددة المستأجرين بـattribute condition.

## خطوات Vercel اليدوية — لم تُنفذ

1. افتح مشروع Vercel المنفصل `family-quiz-staging`.
2. فعّل Secure Backend Access / OIDC باستخدام Team issuer المعتمد.
3. تأكد أن deployment المقصود هو بيئة `production` داخل مشروع Staging
   المنفصل؛ Preview وDevelopment لا تطابقان subject الحالي.
4. أضف متغيرات الخادم وWIF المذكورة أعلاه إلى هذا المشروع فقط.
5. لا تضف `FIREBASE_ADMIN_PRIVATE_KEY` أو
   `FIREBASE_ADMIN_CLIENT_EMAIL` أو `GOOGLE_APPLICATION_CREDENTIALS`.
6. لا تضف `VERCEL_OIDC_TOKEN` يدويًا؛ Vercel يرسله في رأس الطلب.
7. بعد موافقة مستقلة، نفذ deployment على مشروع Staging فقط ثم افحص health
   وعملية Firestore وAuth وRTDB محدودة، مع مراقبة STS/IAM دون تسجيل tokens.

## الاختبارات المنفذة

| الحزمة | النتيجة |
|---|---:|
| OIDC/WIF الجديدة | 7/7 |
| Operation 11 | 8/8 |
| Operation 10 all | 41/41 |
| Functions unit | 14/14 |
| Vercel API integration | 19/19 |
| Privacy | 6/6 |
| ESLint | ناجح |
| Build Staging | ناجح |
| Build Callable | ناجح |

التشغيل الأول لاختبارات الخصوصية نجح 6/6، لكن Firebase CLI أعاد خطأ teardown
عامًا بعد انتهاء الاختبارات. أُعيدت الحزمة في Emulator Suite نظيفة ونجحت
6/6 مع exit code صفر.

لم تتصل اختبارات OIDC بـGoogle أو Vercel؛ استُخدم fake
`IdentityPoolClient` وتحقق الاختبار أن token بقي request-local، وأن credential
singleton، وأن initializer لم يجر أي network call.

## المخاطر والقيود

- لم يحدث تبادل STS حقيقي؛ يلزم smoke test بعد إنشاء WIF.
- claim preflight المحلي لا يتحقق من التوقيع؛ Google Provider هو جهة الثقة
  النهائية، لذلك إعداد issuer/audience/condition اليدوي حرج.
- صلاحية RTDB data-plane الأقل لم تُحسم بسبب اتساع الدور الموثق؛ لا تمنح
  `roles/editor` تلقائيًا.
- OIDC token متاح فقط داخل request؛ أي background task خارج request لن يستطيع
  تجديد Google credential بعد انتهاء cache.
- Vercel قد يحتفظ بـOIDC token حتى 45 دقيقة وTTL نحو 60 دقيقة بحسب وثائقه؛
  Google access token منفصل وقصير العمر.
- `npm audit` أبلغ عن 15 vulnerability في شجرة functions الحالية
  (1 منخفضة، 11 متوسطة، 3 عالية). لم ينفذ `npm audit fix` لأنه خارج النطاق.
- تحذير حجم Vite ونسخة `firebase-functions` ما زالا مؤجلين.

## القرار

الكود جاهز **لإنشاء Workload Identity Pool وProvider وService Account بلا
مفتاح في Staging فقط**. ليس جاهزًا للنشر أو ربط Production. قبل أول deployment
يجب اعتماد أدوار IAM، خصوصًا قرار RTDB، ثم تنفيذ smoke test حقيقي في Staging.
