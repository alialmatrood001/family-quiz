# Firebase Emulator development setup

## 1. الهدف

هذه البيئة مخصصة لتطوير واختبار المسابقة محليًا دون قراءة أو تعديل بيانات Firebase الإنتاجية. ربط المحاكيات موجود داخل شرط `import.meta.env.DEV` ولا يعمل في Production build.

## 2. المتطلبات

- Node.js 24 المتوافق مع Runtime الدوال الحالي.
- npm.
- Java 21 LTS لتشغيل Firestore Emulator.
- Firebase CLI. الإصدار المستخدم عند الإعداد: 15.20.0.

لا تحتاج البيئة إلى service account أو Admin credentials أو أسرار جديدة.

## 3. تشغيل المحاكيات

شغّل في نافذة PowerShell أولى:

```powershell
npm run emulators
```

ثم شغّل Vite في نافذة ثانية:

```powershell
npm run dev
```

لم تُضف حزمة `concurrently`؛ يجب إبقاء النافذتين مفتوحتين أثناء التطوير.

## 4. عناوين الخدمات

| الخدمة | العنوان |
|---|---|
| Emulator UI | `http://127.0.0.1:4000` |
| Firestore | `127.0.0.1:8080` |
| Functions | `127.0.0.1:5001` |
| Authentication | `127.0.0.1:9099` |
| Realtime Database | `127.0.0.1:9000` |

Emulator Hub يستخدم المنفذ التلقائي الذي تختاره Firebase CLI.

## 5. التأكد أن التطبيق متصل بالمحاكي

- افتح Emulator UI وتأكد أن الخدمات الأربع ظاهرة.
- افتح تطبيق Vite محليًا، ثم راقب ظهور قراءات وكتابات Firestore داخل Emulator UI.
- يجب أن يبدأ المحاكي بلا بيانات إنتاجية.
- تظهر رسالة Development في Console تفيد باتصال Firebase Emulator Suite.
- أضف بيانات تجريبية فقط وتأكد أنها تظهر محليًا ولا تظهر في Firebase Console.

لفحص Firestore بطريقة غير تخريبية، أثناء تشغيل المحاكيات:

```powershell
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
npm run emulators:check
Remove-Item Env:FIRESTORE_EMULATOR_HOST
```

الفحص يرفض العمل دون `FIRESTORE_EMULATOR_HOST` محلي، ثم يكتب `emulatorHealth/check` ويقرأه ويحذفه.

يمكن أيضًا تشغيل المحاكيات والفحص وإيقافها تلقائيًا:

```powershell
npm run emulators:exec:check
```

## 6. الاستيراد والتصدير

لحفظ بيانات الاختبار من محاكيات تعمل:

```powershell
npm run emulators:export
```

لتشغيل المحاكيات مع البيانات المحفوظة:

```powershell
npm run emulators:import
```

المجلد `emulator-data/` متجاهل من Git ولا يجب رفعه.

## 7. التحذيرات

- `firestore.rules` و`database.rules.json` قواعد تطوير مفتوحة ومؤقتة فقط.
- **DEVELOPMENT EMULATOR RULES — DO NOT DEPLOY.**
- لا تشغّل اختبارات التطوير على Production.
- لا تستخدم service account.
- لا تشغّل `firebase deploy`.
- لا تعتمد على بيانات Emulator بعد إيقافه إلا إذا صدّرتها أولًا.
- لا تستخدم بيانات مستخدمين حقيقية.

## 8. وضع Production

`src/firebase-emulators.js` لا ينفذ أي اتصال عندما تكون `import.meta.env.DEV` غير صحيحة. يجب أن يبقى فحص حزمة `dist` خاليًا من عناوين منافذ المحاكيات قبل أي إصدار.

## 9. المشكلات المعروفة

- `npm run lint` يفشل حاليًا بستة أخطاء `no-undef` قديمة داخل `functions/index.js` لأن إعداد ESLint لا يعرّف بيئة Node وCommonJS للدوال.
- لا توجد اختبارات Functions فعلية رغم وجود `firebase-functions-test`.
- قواعد التطوير الحالية ليست بديلًا عن Authentication وFirestore Rules الإنتاجية.
- Firebase CLI يعرض تنبيهًا بأن إصدار `firebase-functions` يحتاج تحديثًا؛ لم تُحدّث الحزمة ضمن هذه العملية.
- الخدمات غير المشغلة مثل Storage وPub/Sub قد تتصل بالإنتاج إذا أضيف استدعاء لها لاحقًا. الدوال الحالية تستخدم Firestore فقط، وهو موجه للمحاكي أثناء التشغيل المحلي.
