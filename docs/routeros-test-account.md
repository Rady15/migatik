# حساب RouterOS بأقل صلاحيات للاختبار والتشغيل (Least-Privilege API Account)

> قاعدة إلزامية: لا يُستخدم حساب admin الكامل في المنصة ولا في الاختبارات، ولا تُكتب كلمات المرور في السجلات أو سجل الطرفية أبداً.

## 1) مجموعة صلاحيات القراءة فقط (للاختبار والاكتشاف)

```routeros
/user group add name=mtcm-readonly policy=local,telnet,ssh,ftp,reboot,read,write,policy,test,winbox,password,web,sniff,sensitive,api,!romon
```

الصيغة الآمنة الموصى بها (قراءة + API فقط):

```routeros
/user group add name=mtcm-readonly policy=read,api,winbox,local,!write,!password,!policy,!test,!ftp,!reboot,!sniff,!sensitive
```

## 2) مجموعة صلاحيات التشغيل (قراءة + الكتابة اللازمة للكروت والحجب فقط)

```routeros
/user group add name=mtcm-operator policy=read,write,api,winbox,local,!password,!policy,!test,!ftp,!reboot,!sniff,!sensitive
```

> ملاحظة صادقة: صلاحية `write` في RouterOS تسمح بكتابة أي عنصر ضمن القيود الممنوحة، وليس هناك تفويض على مستوى القائمة (menu-level) في RouterOS قبل الإصدار الحديث؛ لهذا يُنصح بإبقاء المجموعة بدون `!sensitive`-paths الحرجة ومراقبة `/log` — وتُسجَّل كل عملية كتابة من المنصة في ActivityLog.

## 3) إنشاء المستخدم

```routeros
# للاختبار (قراءة فقط):
/user add name=mtcm-test group=mtcm-readonly password="<كلمة مرور قوية 20+ حرفاً>"

# للتشغيل الفعلي (كروت/حجب):
/user add name=mtcm-app group=mtcm-operator password="<كلمة مرور قوية 20+ حرفاً>"
```

## 4) تقييد الوصول للـ API

```routeros
# تفعيل الخدمة:
/ip service enable api
# تقييد available-from لعناوين المنصة فقط:
/ip service set api address=<عناوين خوادم المنصة>/32
# أو عبر جدار الحماية:
/ip firewall filter add chain=input protocol=tcp dst-port=8728 src-address=<عناوين المنصة> action=accept place-before=0
/ip firewall filter add chain=input protocol=tcp dst-port=8728 action=drop
```

## 5) آمن التشغيل من المنصة

- كلمة المرور تُخزَّن مشفّرة AES-256-GCM في قاعدة البيانات (`Router.apiPasswordEnc`) ولا تُفك إلا في الذاكرة عند الاتصال.
- لا تمر كلمة المرور إلى أي سجل/استجابة API/شاشة — تحقّقنا من ذلك في `withRouterCredentials` و`integration-test.ts` (يُطبع `***hidden***` فقط).
- أوامر الاختبار كلها `print` (قراءة) — لا شيء مدمّر.

## 6) التحقق من صلاحيات الحساب قبل الاختبار

```routeros
/user print detail where name=mtcm-test
# ثم من جهاز داخل الشبكة:
ROUTER_HOST=192.168.1.3 ROUTER_USER=mtcm-test ROUTER_PASS=**** bun run scripts/integration-test.ts
```

الحساب المحدود قد يرجع `!trap` لبعض المصادر المتقدمة — التقرير يصنّفها `unsupported`/`fail` صادقاً حسب الرسالة.
