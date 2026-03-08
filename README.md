# Agent Runner (Fly.io + Playwright) — يعمل من الهاتف

هذا السيرفر ينفّذ التصفح الحقيقي (click/type/upload) ويعتمد على Cloudflare Worker لإنتاج الخطوة التالية (LLM) وتنزيل الملفات.

## أسرار/بيئة مطلوبة
- `AGENT_TOKEN` : نفس القيمة الموجودة في Worker (AGENT_TOKEN)

## نشر بدون كمبيوتر (من الهاتف) عبر GitHub Actions
1) أنشئ Repo جديد على GitHub (مثلاً: `aiws-agent-runner`)
2) ارفع محتويات هذا المجلد بالكامل إلى repo (server.js + package.json + Dockerfile + fly.toml + .github/workflows)
3) على Fly.io:
   - أنشئ App باسم **aiws-agent-runner** (أو عدّل fly.toml باسم مختلف)
   - احصل على `FLY_API_TOKEN`
4) في GitHub repo → Settings → Secrets and variables → Actions → New repository secret
   - `FLY_API_TOKEN` = توكن Fly
   - `AGENT_TOKEN` = نفس توكن Worker
5) اعمل Commit إلى main → سيتم النشر تلقائيًا (Actions)

بعد النشر سيصبح لديك رابط:
`https://YOURAPP.fly.dev`

## ربطه بالـWorker
في Worker vars:
- `AGENT_RUNNER_URL = https://YOURAPP.fly.dev`

## ملاحظات
- بعض المواقع تمنع الأتمتة أو تطلب CAPTCHA/OTP.
- Safe mode في التطبيق يوقف التنفيذ إذا احتاج تدخل بشري.
