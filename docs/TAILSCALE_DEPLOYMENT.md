#ربط الميكروتك بالمنصة عبر Tailscale (بدون VPS / Domain / Port Forward)

##الفكرة
بدل ما المنصة (Vercel) تحاول توصل للراوتر (وراء NAT)، وهو ده اللي كان بيفشل، بنخلي **المنصة والراوتر في نفس شبكة Tailscale** (100.x.x.x).المنصة تشتغل على الـ Proxmox بتاعك (مجاناً)، وTailscale Funnel بيديلك رابط HTTPS عام من غير ما تشتري domain.

```
Internet → https://mcm-platform.<tailnet>.ts.net → Proxmox (:3000)
                                                       │ (tailnet)
                                                       ▼
                                              MikroTik CHR :8728
```

---

##الجزء 1: Tailscale على الحساب (مرة واحدة)
1. اعمل حساب مجاني على https://tailscale.com (لا بطاقة ائتمان).
2. افتح https://login.tailscale.com/admin/settings/keys واعمل **Auth key**:
   - ✅ Reusable
   - ✅ Tags: `tag:server` (للمنصة) و`tag:router` (للراوتر)
   - انسخ المفتاح (`tskey-auth-...`).

---

##الجزء 2: تشغيل المنصة على Proxmox
```bash
cd mikrotik-cloud-manager-full
cp .env.example .env
#عدّل .env:
#  DATABASE_URL = رابط Supabase (اللي شغال)
#  APP_SECRET   = قيمة قوية (لازم تطابق اللي استخدمتها في Vercel)
#  BRIDGE_TOKEN = أي قيمة عشوائية
#  TS_AUTHKEY   = المفتاح من الجزء 1

docker compose -f docker-compose.tailscale.yml up -d --build
```
بعد ما الحاوية `mcm-ts-funnel` تتصل (حوالي 30 ثانية)، فعّل الـ Funnel:
```bash
docker exec mcm-ts-funnel tailscale funnel 3000
```
هطلع لك رسالة فيها الرابط: `https://mcm-platform.<tailnet>.ts.net` — احفظه.

---

##الجزء 3: Tailscale على الراوتر (CHR)
الصق المحتوى من `docs/TAILSCALE_ROUTER_SETUP.rsc` في **New Terminal** بعد ما تبدّل `TS_AUTHKEY` بالمفتاح.

> ⚠️ أول أمر (`/system/device-mode/update container=yes`) هي عمل **Reboot** للراوتر. استنى 30 ثانية وأعد الاتصال.

بعدين في Tailscale admin console:
- Machines → `mikrotik-chr` → Edit route settings → ✅ approve `192.168.1.0/24`

---

##الجزء 4: ربط الراوتر بالمنصة
1. افتح الرابط `https://mcm-platform.<tailnet>.ts.net`.
2. في `.env` على Proxmox تأكد `PUBLIC_PLATFORM_URL` = نفس الرابط (أو أعد تشغيل الحاوية).
3. ادخل **إدارة السيرفرات → ربط تلقائي** وخد أمر الربط.
4. الصقه في طرفية الميكروتك.
5. السيرفر هيظهر تلقائياً **online** بالبيانات الحقيقية.

---

## ملاحظات
- الـ Funnel عام (أي حد عنده الرابط يقدر يفتح اللوحة) → حط كلمة مرور قوية لـ `admin`.
- لو حابب تدخل بس من أجهزتك: استخدم `tailscale serve 3000` بدل `funnel` (داخل الـ tailnet بس).
- الراوتر والمنصة في نفس الـ tailnet → الاتصال مش محتاج أي IP عام أو منفذ مفتوح.

---

## استكشاف الأعطال

### أخطاء 500 متكررة «Can't reach database server … supabase.com:6543»
ده **مش عطل في Supabase** في الغالب — بعض مزوّدي الإنترنت (زي TE Data في مصر) بيرجّعوا
`Server failed` (SERVFAIL) لنطاق `supabase.com` بالكامل، بينما المواقع التانية بتفتح عادي.

اتأكد بالأمر ده (من PowerShell):

```powershell
Resolve-DnsName aws-1-eu-west-1.pooler.supabase.com -Type A
Resolve-DnsName aws-1-eu-west-1.pooler.supabase.com -Type A -Server 1.1.1.1
```

لو الأول فشل والتاني نجح → غيّر DNS الجهاز (مرة واحدة، ويفضل بعد إعادة التشغيل):

```powershell
# PowerShell كمسؤول
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses ("1.1.1.1","8.8.8.8","9.9.9.9")
Clear-DnsClientCache
```

بعدها `npm run build` مش مطلوب — يكفي التأكد إن `/api/health` رجّع `ready`.

> بالإضافة لذلك، طبقة قاعدة البيانات فيها إعادة محاولة تلقائية (5 محاولات / ~5.5 ثانية)
> لأخطاء الاتصال المؤقتة `P1001/P1002/P2024/P2028`، فانقطاعات اللحظات مش هتظهر للمستخدم.

## Auto-start on Windows (survives reboot)

`start.ps1` loads `.env`, starts the standalone server on `0.0.0.0:3000` with
`NEXT_PUBLIC_SKIP_SOCKET=1`, and restarts it automatically if it exits. Output
goes to `logs/server.log` (rotated at 5 MB, git-ignored).

A Scheduled Task runs it hidden at logon:

```powershell
$user = "$env:USERDOMAIN\$env:USERNAME"
$root = "C:\path\to\project"

Register-ScheduledTask -TaskName "MikroTik Cloud Manager" `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\start.ps1`"" `
    -WorkingDirectory $root) `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew) `
  -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) -Force
```

Manual control:

```powershell
Start-ScheduledTask   -TaskName "MikroTik Cloud Manager"
Stop-ScheduledTask    -TaskName "MikroTik Cloud Manager"
Get-ScheduledTaskInfo -TaskName "MikroTik Cloud Manager"
Get-Content .\logs\server.log -Tail 30
```

> The task fires at user logon, so enable automatic logon (or log in once after a
> reboot) for the site to come back up on its own. `start.ps1` also refuses to
> start a second copy when port 3000 is already in use.
