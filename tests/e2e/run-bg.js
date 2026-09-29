/*
 * Prueba de SEGUNDO PLANO de verdad (npm run e2e:bg).
 *
 * run-e2e.js usa Playwright, que se engancha a TODAS las pestañas y hace que
 * Chrome las trate como visibles: no sirve para probar el segundo plano. Aquí
 * se habla con Chromium por CDP "a mano" y SOLO con la pestaña del panel de la
 * extensión (donde "está" el usuario); las pestañas de Flow (simulado) se
 * abren de fondo con chrome.tabs.create({active:false}) y nadie se engancha a
 * ellas, así que Chrome las oculta, frena sus temporizadores y no les da
 * requestAnimationFrame, como en el uso real.
 *
 *   FBR_BG=normal|raf|long   (por defecto: normal,raf)
 *   - normal: todo en segundo plano.
 *   - raf:    además la lista del "+" solo se pinta con la pestaña a la vista → plan B "Animar".
 *   - long:   un vídeo tarda 6 min (más de 5 min oculta: Chrome aplica el frenado "intensivo").
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const CHROME = process.env.CHROME_BIN || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const TMP = path.join(__dirname, ".tmp");
const OUT = path.join(__dirname, ".out");
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT_ID = [...crypto.createHash("sha256").update(EXT).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const SCEN = {
  voicebg: { voice: true, arm: true, desc: "VOZ con la pestaña de HeyGen OCULTA (el usuario en otra) y PREPARADA (cereza): HeyGen solo reacciona con fotogramas y la voz sale al parar" },
  voicebgnoarm: { voice: true, arm: false, desc: "VOZ con HeyGen OCULTA y SIN preparar: el modo «despierto» (page-hook) debe bastar para que reproduzca" },
  normal: { desc: "Flow en pestañas de fondo; el usuario en otra pestaña", u2: "", u3: "", range: ["1-2", "3"], expectPlanB: false },
  raf: { desc: 'Fondo + la lista del "+" solo se pinta con fotogramas (rAF): el modo "despierto" la hace pintarse', u2: "rafList=1", u3: "rafList=1", range: ["1-2", "3"], expectPlusMenu: true },
  stall: { desc: 'Problemas reales del usuario: vídeo atascado al "100%" y caja de prompt sin pintar mientras la pestaña está oculta', u2: "hiddenStall=1&lazyPanel=1", u3: "hiddenStall=1&lazyPanel=1", range: ["1-2", "3"], expectPlanB: false, expectNamed: true },
  retry: { desc: "La imagen 002 se bloquea 3 veces y los 2 primeros vídeos también: se reintenta suavizando hasta que salen", u2: "policyImage=2&policyImageTimes=3&policyVideo=2", u3: "", range: ["1-2", "3"], expectPlanB: false, expectRetries: true },
  lazy: { desc: "Solo caja de prompt sin pintar estando oculta", u2: "lazyPanel=1", u3: "lazyPanel=1", range: ["1-2", "3"] },
  stallonly: { desc: 'Solo vídeo atascado al "100%" estando oculta', u2: "hiddenStall=1", u3: "hiddenStall=1", range: ["1-2", "3"], expectNamed: true },
  capture: { desc: "PREPARADAS (captura, como tras pulsar la cereza): caja sin pintar + vídeo atascado + lista del \"+\" con rAF, sin mirar nunca Flow", u2: "hiddenStall=1&lazyPanel=1&rafList=1", u3: "hiddenStall=1&lazyPanel=1&rafList=1", range: ["1-2", "3"], arm: true, expectNamed: true, expectPlusMenu: true },
  pm: { desc: "Caja de prompt ProseMirror REAL (lee su modelo), pestañas preparadas y sin foco", u2: "pm=1", u3: "pm=1", range: ["1-2", "3"], arm: true, expectNamed: true },
  sendenter: { desc: "Flow que ignora el clic y solo envía con Enter (ProseMirror real): la extensión debe encontrar el método sin duplicar envíos", u2: "pm=1&sendNeeds=enter", u3: "pm=1&sendNeeds=enter", range: ["1-2", "3"], arm: true, expectNamed: true, expectEnter: true },
  trusted: { desc: "Flow real según el log v2.4.0: solo envía con FOCO y clic REAL; pestañas preparadas, sin mirarlas", u2: "pm=1&needsTrusted=1&needsFocus=1", u3: "pm=1&needsTrusted=1&needsFocus=1", range: ["1-2", "3"], arm: true, expectNamed: true, checkDetach: true },
  long: { desc: "Un vídeo tarda 6 min con la pestaña oculta (frenado intensivo de Chrome)", u2: "videoMs=360000", u3: "", range: ["1", "3"], expectPlanB: false, timeoutMin: 12 },
};

function getJson(url) {
  return new Promise((res, rej) => http.get(url, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const { res, rej } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return new Cdp(ws); }
  send(method, params, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
}

async function run(name, sc) {
  console.log(`\n=== Segundo plano "${name}": ${sc.desc}`);
  const results = [];
  const check = (label, ok, detail) => { results.push(ok); console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); };
  const prof = path.join(TMP, `profile-bg-${name}`);
  fs.rmSync(prof, { recursive: true, force: true });
  fs.mkdirSync(path.join(prof, "Default"), { recursive: true });
  fs.writeFileSync(path.join(prof, "Default", "Preferences"), JSON.stringify({ download: { prompt_for_download: true } }));
  const chrome = spawn(CHROME, [
    `--user-data-dir=${prof}`, "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
    // Simula el clic del usuario en la cereza (permiso de captura) — solo para pruebas.
    ...(sc.arm ? [`--allowlisted-extension-id=${EXT_ID}`] : []),
    "--remote-debugging-port=9336", "--host-resolver-rules=MAP flow.google.com 127.0.0.1:8443, MAP app.heygen.com 127.0.0.1:8443, MAP resource2.heygen.ai 127.0.0.1:8443", "--ignore-certificate-errors",
    "--no-proxy-server", "--window-size=1300,900", "about:blank",
  ], { stdio: "ignore" });
  try {
    let ver;
    for (let i = 0; i < 60 && !ver; i++) { try { ver = await getJson("http://127.0.0.1:9336/json/version"); } catch (e) { await sleep(250); } }
    const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/sidepanel.html` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    await sleep(1500);
    await ev(`const root = await navigator.storage.getDirectory(); await fbrSetRootHandle(await root.getDirectoryHandle("Escritorio", { create: true })); location.reload();`).catch(() => {});
    await sleep(1500);
    // Pestañas de Flow DE FONDO (nadie se engancha a ellas).
    await ev(`await chrome.tabs.create({ url: "https://flow.google.com/u/2/project/aaa?${sc.u2}", active: false }); await chrome.tabs.create({ url: "https://flow.google.com/u/3/project/bbb?${sc.u3}", active: false });`);
    await sleep(2500);
    if (sc.arm) {
      const r = await ev(`const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" }); const out = []; for (const t of tabs) out.push(await chrome.runtime.sendMessage({ type: "ARM_TAB", tabId: t.id })); return out;`);
      console.log("  preparar pestañas:", JSON.stringify(r));
      await sleep(1500);
      // ¿Sigue preparada tras un F5? (la captura es de la pestaña, no de la página)
      const afterReload = await ev(`const [t] = await chrome.tabs.query({ url: "https://flow.google.com/u/2/*" }); await chrome.tabs.reload(t.id); await new Promise((r) => setTimeout(r, 3000)); const g = await chrome.runtime.sendMessage({ type: "GET_ARMED" }); return Object.keys(g.armed).length;`);
      check("tras F5 en una pestaña preparada, sigue preparada", afterReload === 2, `${afterReload} preparadas`);
    }
    const kit = fs.readFileSync(path.join(ROOT, "examples", "sample-kit.txt"), "utf8");
    await ev(`
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      set("prompts", ${JSON.stringify(kit)}); set("accA_num", "2"); set("accA_range", "${sc.range[0]}"); set("accB_num", "3"); set("accB_range", "${sc.range[1]}");
      document.querySelector('input[name=dest][value=folder]').checked = true;
      const gm = document.getElementById("genMode"); gm.value = "paired"; gm.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      document.getElementById("start").click();
      await new Promise((r) => setTimeout(r, 400));
      if (!document.getElementById("startMsg").hidden) document.getElementById("start").click();`);
    const t0 = Date.now();
    let st = {};
    let flowActive = false;
    while (Date.now() - t0 < (sc.timeoutMin || 6) * 60000) {
      await sleep(3000);
      st = await ev(`const d = await chrome.storage.local.get(["batch_u2", "batch_u3"]); const act = await chrome.tabs.query({ active: true }); return { d, act: act.map((t) => t.url) };`);
      if (st.act.some((u) => u.includes("flow.google.com"))) flowActive = true;
      const b2 = st.d.batch_u2, b3 = st.d.batch_u3;
      if (b2 && b3 && b2.status !== "running" && b3.status !== "running") break;
    }
    const b2 = st.d.batch_u2, b3 = st.d.batch_u3;
    const log = await ev(`return (await chrome.storage.local.get("fbrLog")).fbrLog.map((e) => formatLogEntry(e)).join("\\n");`);
    fs.writeFileSync(path.join(OUT, `log-bg-${name}.txt`), log + "\n");
    const shot = await cdp.send("Page.captureScreenshot", {}, sessionId);
    fs.writeFileSync(path.join(OUT, `panel-bg-${name}.png`), Buffer.from(shot.data, "base64"));
    const files = await ev(`const out = {}; try { const root = await navigator.storage.getDirectory(); const d = await (await root.getDirectoryHandle("Escritorio")).getDirectoryHandle(${JSON.stringify(b2 ? b2.config.batchFolder : "x")}); for await (const [n, h] of d.entries()) out[n] = (await h.getFile()).size; } catch (e) {} return out;`);
    console.log(`  (${Math.round((Date.now() - t0) / 1000)} s · log en tests/e2e/.out/log-bg-${name}.txt)`);
    const want = [...sc.range[0].split("-").map(Number), 3].filter((v, i, a) => a.indexOf(v) === i);
    const wantScenes = sc.range[0] === "1-2" ? [1, 2] : [1];
    check("las dos cuentas terminaron", b2 && b3 && b2.status === "done" && b3.status === "done", `u2=${b2 && b2.status} u3=${b3 && b3.status}`);
    if (sc.arm) check("las dos pestañas estaban preparadas (captura) y Chrome las trató como visibles", /EMPIEZA el lote en u2.*pestaña visible.*preparada/.test(log) && /EMPIEZA el lote en u3.*pestaña visible.*preparada/.test(log));
    else check("las pestañas de Flow estuvieron OCULTAS todo el tiempo", /EMPIEZA el lote en u2.*pestaña OCULTA/.test(log) && /EMPIEZA el lote en u3.*pestaña OCULTA/.test(log));
    check("nunca se cambió la vista a Flow", !flowActive);
    const names = [...wantScenes, 3].map((n) => `mundofut_${String(n).padStart(3, "0")}.mp4`);
    check(`vídeos guardados: ${names.join(", ")}`, names.every((n) => files[n] === 350000 + parseInt(n.match(/_(\d{3})\./)[1], 10)) && Object.keys(files).length === names.length, JSON.stringify(files));
    if (sc.expectPlanB) check('plan B "Animar" usado al no pintarse la lista', /adjuntada con "Animar"/.test(log));
    if (sc.name === "trusted" || sc.checkDetach) {
      await sleep(1500);
      const att = await ev(`const t = await chrome.debugger.getTargets(); return t.filter((x) => x.url.includes("flow.google.com") && x.attached).length;`);
      check("al terminar, la extensión suelta el depurador (desaparece la barra)", att === 0, `${att} pestañas de Flow aún enganchadas`);
    }
    if (sc.expectEnter) check('encontró el envío con Enter (real o simulado) y lo usó primero después', /aceptó el envío con "Enter(Real)?"/.test(log) && !/Flow no aceptó el envío/.test(log));
    if (sc.expectPlusMenu) check('la lista del "+" se pintó con la pestaña oculta (sin plan B)', (log.match(/adjuntada con el menú "\+"/g) || []).length === 3 && !/plan B/.test(log));
    if (sc.expectNamed) check("cada vídeo identificado sin ambigüedad y descargado nada más generarse (sin pasada final)", (log.match(/Vídeo generado en/g) || []).length === 3 && !/Aparecieron \d+ vídeos/.test(log) && !/Fase 2B: descargo/.test(log), `${(log.match(/Vídeo generado en/g) || []).length} generados`);
    if (sc.expectRetries) check("se reintentó suavizando (imagen 3 rondas, vídeo 2 reintentos) hasta conseguirlo", /ronda 3\/5/.test(log) && (log.match(/Reintento \d\/6: pido al Agent el mismo vídeo/g) || []).length >= 2);
    void want;
  } finally {
    chrome.kill();
    await sleep(800);
  }
  return results;
}

// VOZ en segundo plano de verdad: la pestaña de HeyGen se abre DE FONDO y
// nadie la mira (el panel es la pestaña activa). Solo narración en el kit.
async function runVoiceBg(name, sc) {
  console.log(`\n=== Segundo plano "${name}": ${sc.desc}`);
  const results = [];
  const check = (label, ok, detail) => { results.push(ok); console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); };
  const prof = path.join(TMP, `profile-bg-${name}`);
  fs.rmSync(prof, { recursive: true, force: true });
  fs.mkdirSync(path.join(prof, "Default"), { recursive: true });
  const chrome = spawn(CHROME, [
    `--user-data-dir=${prof}`, "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ...(sc.arm ? [`--allowlisted-extension-id=${EXT_ID}`] : []),
    "--remote-debugging-port=9336", "--host-resolver-rules=MAP flow.google.com 127.0.0.1:8443, MAP app.heygen.com 127.0.0.1:8443, MAP resource2.heygen.ai 127.0.0.1:8443", "--ignore-certificate-errors",
    "--no-proxy-server", "--window-size=1300,900", "about:blank",
  ], { stdio: "ignore" });
  try {
    let ver;
    for (let i = 0; i < 60 && !ver; i++) { try { ver = await getJson("http://127.0.0.1:9336/json/version"); } catch (e) { await sleep(250); } }
    const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/sidepanel.html` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    await sleep(1500);
    await ev(`const root = await navigator.storage.getDirectory(); await fbrSetRootHandle(await root.getDirectoryHandle("Escritorio", { create: true })); location.reload();`).catch(() => {});
    await sleep(1500);
    await ev(`await chrome.tabs.create({ url: "https://app.heygen.com/create-v4/4585a5a3482e49fea0fef3496df511e4?vt=l&panel=scene&subPanel=voice&audioOnPause=1&needsFrames=1", active: false });`);
    await sleep(3000);
    const vis0 = await ev(`const [t] = await chrome.tabs.query({ url: "https://app.heygen.com/*" }); const r = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => document.visibilityState }); return r[0].result;`);
    if (sc.arm) {
      const r = await ev(`const [t] = await chrome.tabs.query({ url: "https://app.heygen.com/*" }); return await chrome.runtime.sendMessage({ type: "ARM_TAB", tabId: t.id });`);
      console.log("  preparar HeyGen:", JSON.stringify(r));
      await sleep(1000);
    }
    const narration = "Esta voz se genera con la pestaña de HeyGen oculta, sin mirarla.";
    await ev(`
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      set("prompts", ""); set("narration", ${JSON.stringify(narration)});
      document.querySelector('input[name=dest][value=folder]').checked = true;
      const gm = document.getElementById("genMode"); gm.value = "paired"; gm.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      document.getElementById("start").click();
      await new Promise((r) => setTimeout(r, 600));
      if (!document.getElementById("startMsg").hidden) document.getElementById("start").click();`);
    const t0 = Date.now();
    let vs = {};
    let hgActive = false;
    while (Date.now() - t0 < 4 * 60000) {
      await sleep(2000);
      const st = await ev(`const d = await chrome.storage.local.get("fbrVoice"); const act = await chrome.tabs.query({ active: true }); return { v: d.fbrVoice || {}, act: act.map((t) => t.url) };`);
      vs = st.v;
      if (st.act.some((u) => u.includes("heygen"))) hgActive = true;
      if (vs.status === "done" || vs.status === "error") break;
    }
    const log = await ev(`return (await chrome.storage.local.get("fbrLog")).fbrLog.map((e) => formatLogEntry(e)).join("\\n");`);
    fs.writeFileSync(path.join(OUT, `log-bg-${name}.txt`), log + "\n");
    const hg = await ev(`const [t] = await chrome.tabs.query({ url: "https://app.heygen.com/*" }); const r = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => ({ played: +(sessionStorage.getItem("hgPlayed") || 0), pauses: +(sessionStorage.getItem("hgPauses") || 0), atPlay: sessionStorage.getItem("hgText") || "" }) }); return r[0].result;`);
    const folder = (log.match(/Carpeta del lote: (\S+)/) || [])[1];
    const files = await ev(`const out = {}; try { const root = await navigator.storage.getDirectory(); const d = await (await root.getDirectoryHandle("Escritorio")).getDirectoryHandle(${JSON.stringify("__F__")}.replace("__F__", ${JSON.stringify(folder || "x")})); for await (const [n, h] of d.entries()) out[n] = (await h.getFile()).size; } catch (e) {} return out;`);
    console.log(`  (${Math.round((Date.now() - t0) / 1000)} s · log en tests/e2e/.out/log-bg-${name}.txt)`);
    check("la pestaña de HeyGen estaba OCULTA al empezar", vis0 === "hidden", vis0);
    check("nunca se cambió la vista a HeyGen", !hgActive);
    check("play pulsado UNA vez y parado UNA vez", hg.played === 1 && hg.pauses === 1, `play=${hg.played} parar=${hg.pauses}`);
    check("el panel dice «Voz terminada» con el archivo", vs.status === "done" && /audio\.mp3$/.test(vs.file || ""), `${vs.status} · ${vs.msg} · ${vs.file || ""}`);
    check("audio.mp3 guardado y es el del texto", files["audio.mp3"] === 200000 + hg.atPlay.length, JSON.stringify(files));
  } finally {
    chrome.kill();
    await sleep(800);
  }
  return results;
}

(async () => {
  const key = path.join(TMP, "key.pem"), cert = path.join(TMP, "cert.pem");
  if (!fs.existsSync(cert)) execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${key} -out ${cert} -days 30 -subj /CN=flow.google.com 2>/dev/null`);
  const mock = fs.readFileSync(path.join(__dirname, "mock-flow.html"));
  const video = Buffer.alloc(350000, 7);
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const sendRange = (buf, type) => {
      res.setHeader("Content-Type", type);
      res.setHeader("Accept-Ranges", "bytes");
      const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      if (!r) return res.end(buf);
      const start = +r[1], end = r[2] ? Math.min(+r[2], buf.length - 1) : buf.length - 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.length}`);
      return res.end(buf.subarray(start, end + 1));
    };
    const host = req.headers.host || "";
    if (host.startsWith("resource2.heygen.ai")) {
      const m = req.url.match(/^\/v1\/voice\?id=[0-9a-f-]+&chars=(\d+)/);
      if (m) return sendRange(Buffer.alloc(200000 + parseInt(m[1], 10), 9), "audio/mpeg");
      res.statusCode = 404; return res.end();
    }
    if (host.startsWith("app.heygen.com")) {
      if (req.url.startsWith("/ui/")) return sendRange(Buffer.alloc(6000, 3), "video/webm");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(fs.readFileSync(path.join(__dirname, "mock-heygen.html")));
    }
    if (req.url.startsWith("/video.mp4")) {
      // Cada vídeo pesa 350000 + nº de su escena: así se comprueba que cada archivo es el de SU escena.
      const sc = (req.url.match(/[?&]scene=(\d{3})/) || [])[1];
      res.setHeader("Content-Type", "video/mp4");
      return res.end(sc ? Buffer.alloc(350000 + parseInt(sc, 10), 7) : video);
    }
    if (req.url.startsWith("/media/")) {
      // Fuente de un vídeo generado (descarga directa, plan B): mismo tamaño que su descarga.
      const m = req.url.match(/-s(\d{3})\.mp4/);
      if (m) { res.setHeader("Content-Type", "video/mp4"); return res.end(Buffer.alloc(350000 + parseInt(m[1], 10), 7)); }
      res.statusCode = 404; return res.end();
    }
    if (req.url.startsWith("/vendor-prosemirror.js")) { res.setHeader("Content-Type", "text/javascript"); return res.end(fs.readFileSync(path.join(__dirname, "vendor-prosemirror.js"))); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(mock);
  }).listen(8443);
  const all = [];
  try {
    for (const n of (process.env.FBR_BG || "trusted,capture,normal,raf,stall,retry,pm,sendenter,voicebg,voicebgnoarm").split(",")) all.push(...(await (SCEN[n].voice ? runVoiceBg(n, SCEN[n]) : run(n, SCEN[n]))));
  } finally {
    server.close();
  }
  const bad = all.filter((x) => !x).length;
  console.log(`\nTOTAL segundo plano: ${all.length - bad}/${all.length} OK`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
