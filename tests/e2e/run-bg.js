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
  normal: { desc: "Flow en pestañas de fondo; el usuario en otra pestaña", u2: "", u3: "", range: ["1-2", "3"], expectPlanB: false },
  raf: { desc: 'Fondo + la lista del "+" solo se pinta con fotogramas (rAF): el modo "despierto" la hace pintarse', u2: "rafList=1", u3: "rafList=1", range: ["1-2", "3"], expectPlusMenu: true },
  stall: { desc: 'Problemas reales del usuario: vídeo atascado al "100%" y caja de prompt sin pintar mientras la pestaña está oculta', u2: "hiddenStall=1&lazyPanel=1", u3: "hiddenStall=1&lazyPanel=1", range: ["1-2", "3"], expectPlanB: false, expectNamed: true },
  retry: { desc: "La imagen 002 se bloquea 3 veces y los 2 primeros vídeos también: se reintenta suavizando hasta que salen", u2: "policyImage=2&policyImageTimes=3&policyVideo=2", u3: "", range: ["1-2", "3"], expectPlanB: false, expectRetries: true },
  lazy: { desc: "Solo caja de prompt sin pintar estando oculta", u2: "lazyPanel=1", u3: "lazyPanel=1", range: ["1-2", "3"] },
  stallonly: { desc: 'Solo vídeo atascado al "100%" estando oculta', u2: "hiddenStall=1", u3: "hiddenStall=1", range: ["1-2", "3"], expectNamed: true },
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
    "--remote-debugging-port=9336", "--host-resolver-rules=MAP flow.google.com 127.0.0.1:8443", "--ignore-certificate-errors",
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
    const kit = fs.readFileSync(path.join(ROOT, "examples", "sample-kit.txt"), "utf8");
    await ev(`
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      set("prompts", ${JSON.stringify(kit)}); set("accA_num", "2"); set("accA_range", "${sc.range[0]}"); set("accB_num", "3"); set("accB_range", "${sc.range[1]}");
      document.querySelector('input[name=dest][value=folder]').checked = true;
      const gm = document.getElementById("genMode"); gm.value = "paired"; gm.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      document.getElementById("start").click();`);
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
    check("las pestañas de Flow estuvieron OCULTAS todo el tiempo", /EMPIEZA el lote en u2.*pestaña OCULTA/.test(log) && /EMPIEZA el lote en u3.*pestaña OCULTA/.test(log));
    check("nunca se cambió la vista a Flow", !flowActive);
    const names = [...wantScenes, 3].map((n) => `mundofut_${String(n).padStart(3, "0")}.mp4`);
    check(`vídeos guardados: ${names.join(", ")}`, names.every((n) => files[n] === 350000) && Object.keys(files).length === names.length, JSON.stringify(files));
    if (sc.expectPlanB) check('plan B "Animar" usado al no pintarse la lista', /adjuntada con "Animar"/.test(log));
    if (sc.expectPlusMenu) check('la lista del "+" se pintó con la pestaña oculta (sin plan B)', (log.match(/adjuntada con el menú "\+"/g) || []).length === 3 && !/plan B/.test(log));
    if (sc.expectNamed) check("cada vídeo encontrado por el nombre que puso el Agent", (log.match(/y renombrado "mundofut_00\d_\d{4}"/g) || []).length === 3 && !/Aparecieron \d+ vídeos/.test(log), `${(log.match(/y renombrado/g) || []).length} renombrados`);
    if (sc.expectRetries) check("se reintentó suavizando (imagen 3 rondas, vídeo 2 reintentos) hasta conseguirlo", /ronda 3\/5/.test(log) && (log.match(/Reintento \d\/6: pido al Agent el mismo vídeo/g) || []).length >= 2);
    void want;
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
    if (req.url.startsWith("/video.mp4")) { res.setHeader("Content-Type", "video/mp4"); return res.end(video); }
    if (req.url.startsWith("/media/")) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(mock);
  }).listen(8443);
  const all = [];
  try {
    for (const n of (process.env.FBR_BG || "normal,raf,stall,retry").split(",")) all.push(...(await run(n, SCEN[n])));
  } finally {
    server.close();
  }
  const bad = all.filter((x) => !x).length;
  console.log(`\nTOTAL segundo plano: ${all.length - bad}/${all.length} OK`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
