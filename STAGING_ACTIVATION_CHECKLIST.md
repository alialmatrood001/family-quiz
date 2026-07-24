# Staging activation checklist

هذه القائمة توثيق للعملية التالية فقط. لم تُنفذ أي خطوة نشر ضمن العملية 7.

- [ ] إنشاء مشروع Firebase Staging يدويًا باسم واضح يحتوي `staging`.
- [ ] تفعيل Firestore وRealtime Database.
- [ ] تفعيل Authentication وAnonymous Sign-in.
- [ ] تفعيل Email/Password للإدارة عند الحاجة.
- [ ] إنشاء حساب إدارة Staging وإضافة Custom Claim باسم `admin: true`.
- [ ] نسخ `.env.staging.example` إلى ملف محلي غير متتبع وإدخال إعداد Web App الخاص بـStaging.
- [ ] إضافة Alias باسم `staging` يدويًا عبر `firebase use --add`.
- [ ] ضبط `CONFIRM_STAGING_PROJECT` ليطابق Project ID حرفيًا.
- [ ] تشغيل `npm run staging:check -- --project <staging-project-id>`.
- [ ] تشغيل `npm run staging:deploy:dry-run -- --project <staging-project-id>` ومراجعة المكونات.
- [ ] التأكد من عدم وجود `GOOGLE_APPLICATION_CREDENTIALS`.
- [ ] بناء نسخة Staging باستخدام ملف البيئة المحلي.
- [ ] نشر Functions وRules وHosting إلى Alias `staging` فقط في عملية مستقلة.
- [ ] تشغيل Smoke Test بعد النشر باستخدام الحارس نفسه.
- [ ] مراجعة Logs للتأكد من غياب PII وTokens.
- [ ] عدم ربط Domain إنتاجي بمشروع Staging.
- [ ] عدم تشغيل Migration على Production دون خطة مستقلة ونسخة احتياطية ومراجعة يدوية.
