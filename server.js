import express from "express";
import { chromium } from "playwright";
import os from "os";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";

function authOk(req){
  const tok = req.header("X-Agent-Token") || "";
  return AGENT_TOKEN && tok === AGENT_TOKEN;
}

app.get("/health", (req,res)=> res.json({ ok:true, service:"aiws-agent-runner" }));

app.post("/run", async (req,res)=>{
  if (!authOk(req)) return res.status(401).json({ error:"Unauthorized" });

  const {
    job_id, goal, start_url, allow_domains, max_steps, mode,
    worker_origin, file_ids
  } = req.body || {};

  if (!worker_origin) return res.status(400).json({ error:"Missing worker_origin" });
  if (!job_id) return res.status(400).json({ error:"Missing job_id" });
  if (!goal) return res.status(400).json({ error:"Missing goal" });

  const runner = {
    job_id,
    goal,
    start_url: start_url || null,
    allow_domains: allow_domains || "",
    max_steps: Math.min(Math.max(parseInt(max_steps || 12,10), 3), 30),
    mode: mode || "auto",
    worker_origin: String(worker_origin).replace(/\/+$/,''),
    file_ids: Array.isArray(file_ids) ? file_ids.map(String).slice(0,20) : []
  };

  const steps = [];
  let browser = null;
  let page = null;

  try{
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-features=site-per-process"
      ]
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "AIWS-AgentRunner/1.0 (Playwright)"
    });
    page = await ctx.newPage();

    if (runner.start_url){
      await page.goto(runner.start_url, { waitUntil:"domcontentloaded", timeout: 45000 });
    } else {
      await page.goto("about:blank");
    }

    let last = null;
    for (let i=1; i<=runner.max_steps; i++){
      const snapshot = await makeSnapshot(page);
      const next = await nextAction(runner, i, snapshot, last);
      if (next.done){
        steps.push(await makeStepLog(i, next.action?.type || "done", "done", next.note, page, false));
        return res.json({
          ok:true,
          job_id: runner.job_id,
          final_url: page.url(),
          result: next.note || "✅ Done",
          steps
        });
      }

      // SAFE mode: stop if needs_human
      if (next.needs_human && runner.mode === "safe"){
        steps.push(await makeStepLog(i, next.action?.type || "stop", "needs_human", next.note || "Needs human", page, true));
        return res.json({
          ok:true,
          job_id: runner.job_id,
          final_url: page.url(),
          result: "⚠️ يحتاج تدخل بشري (تسجيل دخول/OTP/CAPTCHA).",
          steps
        });
      }

      const execRes = await execAction(runner, page, next.action || {});
      last = { action: next.action, exec: execRes };

      steps.push(await makeStepLog(i, next.action?.type || "?", execRes.status, execRes.note, page, true));
      if (execRes.status !== "ok" && runner.mode === "safe"){
        return res.json({
          ok:true,
          job_id: runner.job_id,
          final_url: page.url(),
          result: "⚠️ توقف بسبب خطأ أثناء التنفيذ (Safe mode).",
          steps
        });
      }
    }

    return res.json({
      ok:true,
      job_id: runner.job_id,
      final_url: page.url(),
      result: "⏱️ انتهى الحد الأقصى للخطوات.",
      steps
    });
  }catch(e){
    const note = String(e?.message || e);
    if (page){
      try{
        steps.push(await makeStepLog(steps.length+1, "error", "error", note, page, true));
      }catch(_){}
    }
    return res.status(500).json({ error:"Runner error", detail: note, steps });
  }finally{
    if (browser) await browser.close().catch(()=>{});
  }
});

async function nextAction(runner, step, snapshot, last){
  const url = runner.worker_origin + "/api/agent/next_action";
  const r = await fetch(url, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Agent-Token": AGENT_TOKEN
    },
    body: JSON.stringify({
      job_id: runner.job_id,
      step,
      snapshot,
      last
    })
  });
  const j = await r.json().catch(()=>null);
  if (!r.ok){
    return { done:true, needs_human:false, note: "فشل الحصول على الخطوة التالية من Worker.", action:{type:"done"} };
  }
  // normalize
  j.action = j.action || { type:"done" };
  j.done = Boolean(j.done);
  j.needs_human = Boolean(j.needs_human);
  j.note = j.note || "";
  return j;
}

async function execAction(runner, page, action){
  const type = String(action.type || "").toLowerCase();
  try{
    if (type === "navigate"){
      const u = String(action.url || "");
      if (!u) return { status:"error", note:"Missing url" };
      await page.goto(u, { waitUntil:"domcontentloaded", timeout: 45000 });
      return { status:"ok", note:"navigated" };
    }
    if (type === "click"){
      const sel = String(action.selector || "");
      if (!sel) return { status:"error", note:"Missing selector" };
      await page.click(sel, { timeout: 15000 });
      await page.waitForTimeout(800);
      return { status:"ok", note:"clicked" };
    }
    if (type === "type"){
      const sel = String(action.selector || "");
      const text = String(action.text || "");
      if (!sel) return { status:"error", note:"Missing selector" };
      await page.fill(sel, text, { timeout: 15000 });
      return { status:"ok", note:"typed" };
    }
    if (type === "press"){
      const key = String(action.key || "Enter");
      await page.keyboard.press(key);
      await page.waitForTimeout(800);
      return { status:"ok", note:"pressed "+key };
    }
    if (type === "wait"){
      const ms = Math.min(Math.max(parseInt(action.wait_ms||1000,10), 200), 15000);
      await page.waitForTimeout(ms);
      return { status:"ok", note:"waited "+ms+"ms" };
    }
    if (type === "upload"){
      const sel = String(action.selector || "");
      const fileId = String(action.file_id || "");
      if (!sel || !fileId) return { status:"error", note:"Missing selector/file_id" };
      const tmp = await downloadFile(runner, fileId);
      await page.setInputFiles(sel, tmp, { timeout: 15000 });
      return { status:"ok", note:"uploaded file" };
    }
    if (type === "extract"){
      const text = await page.evaluate(()=> document.body?.innerText?.slice(0, 12000) || "");
      return { status:"ok", note:"EXTRACT:\n"+text };
    }
    if (type === "done"){
      return { status:"ok", note:"done" };
    }
    return { status:"error", note:"Unknown action type: "+type };
  }catch(e){
    return { status:"error", note:String(e?.message||e) };
  }
}

async function downloadFile(runner, fileId){
  const url = runner.worker_origin + "/api/agent/file?job_id=" + encodeURIComponent(runner.job_id) + "&file_id=" + encodeURIComponent(fileId);
  const r = await fetch(url, { headers:{ "X-Agent-Token": AGENT_TOKEN }});
  if (!r.ok) throw new Error("Failed to download file for upload");
  const buf = Buffer.from(await r.arrayBuffer());
  const tmpPath = path.join(os.tmpdir(), `aiws_${runner.job_id}_${fileId}`);
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

async function makeSnapshot(page){
  // Basic structured snapshot
  const data = await page.evaluate(()=>{
    const take = (arr, n) => Array.from(arr).slice(0,n);
    const links = take(document.querySelectorAll("a[href]"), 40).map(a=>({
      text: (a.innerText||"").trim().slice(0,80),
      href: a.href
    })).filter(x=>x.text || x.href);

    const buttons = take(document.querySelectorAll("button, input[type=submit], input[type=button]"), 30).map(b=>({
      text: (b.innerText||b.value||"").trim().slice(0,80)
    })).filter(x=>x.text);

    const inputs = take(document.querySelectorAll("input, textarea, select"), 40).map(el=>({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || ""
    }));

    const text = (document.body?.innerText || "").replace(/\n{3,}/g,"\n\n").slice(0, 12000);
    const html = (document.documentElement?.outerHTML || "").slice(0, 160000);
    return { links, buttons, forms: inputs, text, html };
  });

  return {
    url: page.url(),
    title: await page.title().catch(()=> ""),
    text: data.text,
    links: data.links,
    forms: data.forms,
    html: data.html
  };
}

async function makeStepLog(step, actionType, status, note, page, withShot){
  const obj = {
    step,
    action_type: actionType,
    status,
    note: note || "",
    url: page ? page.url() : ""
  };
  if (withShot && page){
    try{
      const buf = await page.screenshot({ type:"jpeg", quality: 60, fullPage: false });
      obj.screenshot_b64 = Buffer.from(buf).toString("base64");
    }catch(_e){}
  }
  return obj;
}

app.listen(PORT, ()=> console.log("Agent Runner listening on", PORT));
