/*
 * Prueba de extremo a extremo con Chromium REAL + la extensión cargada +
 * una imitación de Flow (tests/e2e/mock-flow.html) servida como
 * https://flow.google.com (DNS redirigido a localhost, certificado propio).
 *
 *   npm run e2e                      (todos los escenarios)
 *   FBR_E2E=folder npm run e2e       (uno: folder | downloads | resume | cost | noautodl)
 *
 * Qué demuestra: la lógica de la extensión de principio a fin en un Chrome de
 * verdad (dos cuentas en paralelo, límite de ritmo, bloqueo de una imagen,
 * aviso de coste, F5 a mitad, descargas de una en una con su nombre en una
 * carpeta nueva por lote, con "Preguntar dónde guardar" ACTIVADO).
 * Qué NO demuestra: que Flow real se comporte como la imitación.
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

function loadPlaywright() {
  for (const p of ["playwright", "/opt/node22/lib/node_modules/playwright"]) { try { return require(p); } catch (e) {} }
  throw new Error("No encuentro playwright (npm i -g playwright)");
}
const { chromium } = loadPlaywright();
const CHROME = process.env.CHROME_BIN || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const TMP = path.join(__dirname, ".tmp");
const OUT = path.join(__dirname, ".out");
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = ["mundofut_001.mp4", "mundofut_002.mp4", "mundofut_003.mp4"];

// ---------------------------------------------------------- ESCENARIOS
const SCENARIOS = {
  folder: {
    desc: 'Carpeta elegida con "Preguntar dónde guardar" ACTIVADO; límite de ritmo en u2; imagen 002 bloqueada 1 vez',
    askWhereToSave: true, dest: "folder",
    u2: "policyImage=2&rateLimitVideo=1&prepMs=4000", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES },
  },
  downloads: {
    desc: 'Descargas de Chrome con "Preguntar dónde guardar" DESACTIVADO',
    askWhereToSave: false, dest: "downloads",
    u2: "prepMs=4000", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES },
  },
  resume: {
    desc: "F5 en u2 con el vídeo 001 ya aprobado y generándose: se reanuda, NO se vuelve a pagar y el vídeo que llega tarde se asigna a la 001",
    askWhereToSave: true, dest: "folder",
    u2: "videoMs=9000", u3: "",
    reloadU2WhenApproved: true,
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 3: "ddd", 2: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES },
  },
  cost: {
    desc: "u3 pide SIEMPRE 15 puntos: Rechazar + 3 reenvíos remarcando 6 s, y otra vez en la 2.ª vuelta (8 rechazos, 0 puntos); la escena falla y u2 sigue",
    askWhereToSave: true, dest: "folder",
    u2: "", u3: "cost=15",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "dfs" }, approvals: { u2: 2, u3: 0 }, files: ["mundofut_001.mp4", "mundofut_002.mp4"], rejected: { u3: 8 } },
  },
  cost12: {
    desc: 'u2: el 1.er vídeo sale a 12 puntos → Rechazar y reenviar remarcando 6 s → 10 → Aprobar. u3: el Agent llama a las imágenes "Imagen 003"',
    askWhereToSave: true, dest: "folder",
    u2: "costSeq=12,10", u3: "imgName=Imagen {n}",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, rejected: { u2: 1, u3: 0 }, chatHas: { u2: "ni uno más" } },
  },
  noconfirm: {
    desc: "u2 con «Confirmar antes de generar = Nunca»: el vídeo empieza sin aviso → se termina ESE y se para de generar en u2 (sin reintentar)",
    askWhereToSave: true, dest: "folder",
    u2: "noConfirm=1", u3: "",
    expect: { u2: "error", u3: "done", scenes: { 1: "ddd", 3: "ddd" }, approvals: { u2: 0, u3: 1 }, files: ["mundofut_001.mp4", "mundofut_003.mp4"], started: { u2: 1 } },
  },
  sequential: {
    desc: 'Modo "una tras otra": u3 no empieza hasta que termina u2',
    askWhereToSave: true, dest: "folder", runMode: "sequential",
    u2: "", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, sequential: true },
  },
  dryrun: {
    desc: "ENSAYO sin gastar: imágenes ya existentes, llega al aviso de coste y pulsa Rechazar (0 puntos)",
    askWhereToSave: true, dest: "folder", genMode: "dryRun",
    u2: "seed=img:1-2", u3: "seed=img:3-3",
    expect: { u2: "done", u3: "done", scenes: { 1: "dss", 2: "dss", 3: "dss" }, approvals: { u2: 0, u3: 0 }, files: [], rejected: { u2: 2, u3: 1 } },
  },
  dltest: {
    desc: "PRUEBA de descarga con vídeos que ya existen (0 puntos)",
    askWhereToSave: true, dest: "folder", genMode: "downloadTest",
    u2: "seed=vid:2&prepMs=3000", u3: "seed=vid:1",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 0, u3: 0 }, files: FILES },
  },
  dupcost: {
    desc: "Tras aprobar, aparece un SEGUNDO aviso de coste (petición duplicada): debe rechazarse (no pagar dos veces)",
    askWhereToSave: true, dest: "folder",
    u2: "dupCost=1", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, rejected: { u2: 2, u3: 0 } },
  },
  misname: {
    desc: "Prueba real v2.6: el Agent pone nombres EQUIVOCADOS a los vídeos y Flow los coloca en cualquier sitio: cada vídeo se descarga al generarse con su nombre y es el de SU escena",
    askWhereToSave: true, dest: "folder",
    u2: "wrongRename=1&shuffle=1", u3: "wrongRename=1&shuffle=1",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, immediate: true },
  },
  selfheal: {
    desc: 'Fallo técnico persistente en u2 (el "+" y "Animar" no responden): 2.ª vuelta automática y, si sigue, F5 automático y reanudación sin intervención',
    askWhereToSave: true, dest: "folder", maxRetries: 2, timeoutMin: 9,
    u2: "brokenUntilReload=1", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, logHas: ["Segunda vuelta automática", "recarga automática 1/2", "Página recargada para recuperarme"] },
  },
  placeholder: {
    desc: "PRUEBA REAL v2.7: mientras se genera hay un tile PROVISIONAL (sin % ni Descargar) y al terminar Flow redibuja la cuadrícula: debe esperar al definitivo, reencontrarlo y guardar el vídeo correcto",
    askWhereToSave: true, dest: "folder",
    u2: "placeholderTile=1&videoMs=8000&wrongRename=1", u3: "placeholderTile=1&videoMs=8000",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, immediate: true },
  },
  sourcedl: {
    desc: 'El menú de los vídeos no tiene "Descargar": plan B, guardar directamente la fuente del vídeo (sin fallar ninguna)',
    askWhereToSave: true, dest: "folder",
    u2: "noMenuDownload=1&placeholderTile=1", u3: "noMenuDownload=1",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, immediate: true, logHas: ["Plan B: guardo directamente la fuente del vídeo"] },
  },
  voice: {
    desc: "VOZ (HeyGen): el kit trae narración; en la pestaña de HeyGen se borra el guion viejo, se escribe la narración, se pulsa reproducir y el audio nuevo se guarda como audio.mp3 en la carpeta del lote",
    askWhereToSave: true, dest: "folder", heygen: true,
    narration: "\"¿Quién era ese chico?\" En 1998 un chico de barrio soñaba con jugar en el estadio. Nadie creía en él. Y entonces llegó su noche.",
    u2: "", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: [...FILES, "audio.mp3"], logHas: ["Voz guardada"] },
  },
  voiceonly: {
    desc: "SOLO VOZ: el kit trae únicamente la narración → no se toca Flow, solo HeyGen → audio.mp3 (antes el panel lo bloqueaba)",
    askWhereToSave: true, dest: "folder", heygen: true, noFlow: true, kit: "none",
    narration: "Esto es solo la voz del short, sin imágenes ni animaciones.",
    u2: "", u3: "",
    expect: { scenes: {}, approvals: { u2: 0, u3: 0 }, files: ["audio.mp3"], logHas: ["Voz guardada"], mode: "voiceOnly" },
  },
  voicebadtext: {
    desc: "VOZ con el guion que no acepta el texto: la extensión NO pulsa reproducir (HeyGen solo deja 3 previsualizaciones al día) y el panel dice por qué",
    askWhereToSave: true, dest: "folder", heygen: true, noFlow: true, kit: "none", hg: "writeBroken=1",
    narration: "Esta narración no se va a poder escribir en el guion.",
    u2: "", u3: "",
    expect: { scenes: {}, approvals: { u2: 0, u3: 0 }, files: [], noPlay: true, mode: "voiceOnly" },
  },
  imgonly: {
    desc: "SOLO IMÁGENES: el kit trae solo los prompts de imagen → se hacen las imágenes sin pedir vídeos (antes el panel lo bloqueaba)",
    askWhereToSave: true, dest: "folder", kit: "imagesOnly",
    u2: "", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "dsd", 2: "dsd", 3: "dsd" }, approvals: { u2: 0, u3: 0 }, files: ["mundofut_001.png", "mundofut_002.png", "mundofut_003.png"], mode: "imagesOnly" },
  },
  agentreply: {
    desc: "El Agent contesta con una pregunta en vez de generar: a los 3 min sin actividad se apunta su respuesta y se reintenta solo",
    askWhereToSave: true, dest: "folder", timeoutMin: 9,
    u2: "agentQuestion=1", u3: "",
    expect: { u2: "done", u3: "done", scenes: { 1: "ddd", 2: "ddd", 3: "ddd" }, approvals: { u2: 2, u3: 1 }, files: FILES, logHas: ["el Agent contestó sin generar nada"] },
  },
  noautodl: {
    desc: "Chrome SIN permiso de descargas automáticas para flow.google.com (exploración de la causa de tus descargas)",
    askWhereToSave: true, dest: "folder", noAutoDownloads: true,
    u2: "", u3: "",
    expect: null, // exploratorio: se informa de lo que pasa
  },
  noautodl2: {
    desc: "Igual, pero con destino Descargas de Chrome y sin preguntar (exploración)",
    askWhereToSave: false, dest: "downloads", noAutoDownloads: true,
    u2: "", u3: "",
    expect: null,
  },
};

async function runScenario(name, sc, server) {
  const results = [];
  const check = (label, ok, detail) => { results.push({ label, ok }); console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); };
  console.log(`\n=== Escenario "${name}": ${sc.desc}`);
  const prof = path.join(TMP, `profile-${name}`);
  const dl = path.join(TMP, `downloads-${name}`);
  fs.rmSync(prof, { recursive: true, force: true });
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(path.join(prof, "Default"), { recursive: true });
  fs.mkdirSync(dl, { recursive: true });
  const prefs = { download: { prompt_for_download: sc.askWhereToSave, default_directory: dl, directory_upgrade: true }, savefile: { default_directory: dl } };
  if (!sc.noAutoDownloads) prefs.profile = { content_settings: { exceptions: { automatic_downloads: { "https://flow.google.com:443,*": { setting: 1 } } } } };
  fs.writeFileSync(path.join(prof, "Default", "Preferences"), JSON.stringify(prefs));

  const chrome = spawn(CHROME, [
    `--user-data-dir=${prof}`, "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--remote-debugging-port=9333", "--host-resolver-rules=MAP flow.google.com 127.0.0.1:8443, MAP app.heygen.com 127.0.0.1:8443", "--ignore-certificate-errors",
    "--no-proxy-server", "--window-size=1400,900", "about:blank",
  ], { stdio: "ignore" });
  let browser;
  try {
    for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch (e) { await sleep(250); } }
    // Playwright desvía las descargas a su carpeta temporal: se devuelve a Chrome su comportamiento normal.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const ctx = browser.contexts()[0];
    // Chrome deriva el id de una extensión descomprimida del SHA-256 de su ruta.
    const extId = [...require("crypto").createHash("sha256").update(EXT).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

    // El usuario está en OTRA pestaña (la del panel); las de Flow se abren como
    // pestañas de fondo de la MISMA ventana (Playwright, con newPage, abriría
    // ventanas nuevas y visibles: eso no probaría el segundo plano).
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 400, height: 1000 });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    // v2.6: el icono abre la ventanita típica (el panel lateral estrechaba Flow).
    const popup = await panel.evaluate(async () => { for (let i = 0; i < 20; i++) { const p = await chrome.action.getPopup({}); if (p) return p; await new Promise((r) => setTimeout(r, 200)); } return ""; });
    check("el icono abre la ventanita de extensión (no el panel lateral)", /sidepanel\.html\?modo=popup$/.test(popup), popup);
    const openBg = async (url) => {
      const wait = ctx.waitForEvent("page", (p) => p.url().startsWith(url.split("?")[0]) || p.url() === "about:blank");
      await panel.evaluate((u) => chrome.tabs.create({ url: u, active: false }), url);
      const pg = await wait;
      await pg.waitForLoadState("domcontentloaded");
      return pg;
    };
    const u2 = await openBg(`https://flow.google.com/u/2/project/aaa?${sc.u2}`);
    const u3 = await openBg(`https://flow.google.com/u/3/project/bbb?${sc.u3}`);
    const hg = sc.heygen ? await openBg(`https://app.heygen.com/create-v4/4585a5a3482e49fea0fef3496df511e4?vt=l&panel=scene&subPanel=voice${sc.hg ? "&" + sc.hg : ""}`) : null;
    await sleep(1500);
    const vis = [await u2.evaluate(() => document.visibilityState), await u3.evaluate(() => document.visibilityState)];
    console.log("  visibilidad de las pestañas de Flow al empezar:", vis.join(", "));
    if (sc.dest === "folder") {
      // No se puede automatizar el selector de carpetas del sistema: se usa una
      // carpeta del almacenamiento privado del navegador (OPFS), misma API.
      await panel.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        await fbrSetRootHandle(await root.getDirectoryHandle("Escritorio", { create: true }));
      });
      await panel.reload();
    }
    await panel.bringToFront();
    const sample = fs.readFileSync(path.join(ROOT, "examples", "sample-kit.txt"), "utf8");
    const kitBody = sc.kit === "none" ? "" : sc.kit === "imagesOnly" ? sample.slice(0, sample.indexOf("## 🎬")) : sample;
    await panel.fill("#prompts", (sc.narration ? `## 🎙️ NARRACIÓN\n\`\`\`\n${sc.narration}\n\`\`\`\n\n` : "") + kitBody);
    await panel.fill("#accA_num", "2");
    await panel.fill("#accA_range", "1-2");
    await panel.selectOption("#accA_res", "1080p");
    await panel.fill("#accB_num", "3");
    await panel.fill("#accB_range", "3");
    await panel.check(`input[name=dest][value=${sc.dest}]`, { force: true });
    await panel.check(`input[name=runMode][value=${sc.runMode || "parallel"}]`, { force: true });
    await panel.evaluate((m) => { const el = document.getElementById("genMode"); el.value = m; el.dispatchEvent(new Event("change", { bubbles: true })); }, sc.genMode || "paired");
    if (sc.maxRetries) await panel.evaluate((v) => { const el = document.getElementById("maxRetries"); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, sc.maxRetries);
    await sleep(500);
    await panel.screenshot({ path: path.join(OUT, `panel-lote-${name}.png`), fullPage: true });
    await panel.click("#start");
    await sleep(400);
    if (await panel.isVisible("#startMsg")) await panel.click("#start"); // "Iniciar de todas formas" (pestañas sin preparar)

    const t0 = Date.now();
    let batches = {};
    let shotMid = false;
    let reloaded = false;
    let flowWentActive = false;
    let discardableWhileRunning = null;
    while (Date.now() - t0 < (sc.timeoutMin || 6) * 60000) {
      batches = await panel.evaluate(() => chrome.storage.local.get(["batch_u2", "batch_u3"]));
      const b2 = batches.batch_u2, b3 = batches.batch_u3;
      if (!shotMid) {
        // El usuario "está" en otra pestaña: la extensión nunca debe cambiarle la vista.
        const act = await panel.evaluate(() => chrome.tabs.query({ active: true }).then((t) => t.map((x) => x.url)));
        if (act.some((u) => u.includes("flow.google.com"))) flowWentActive = true;
        // Solo cuentan las pestañas cuyo lote está EN MARCHA (en modo secuencial la 2.ª aún no ha empezado).
        if (discardableWhileRunning === null && b2 && b2.status === "running" && b2.phase === "videos") {
          const running = [["/u/2/", b2], ["/u/3/", b3]].filter(([, b]) => b && b.status === "running").map(([u]) => u);
          discardableWhileRunning = await panel.evaluate((running) => chrome.tabs.query({ url: "https://flow.google.com/*" }).then((t) => t.filter((x) => running.some((u) => x.url.includes(u))).map((x) => x.autoDiscardable)), running);
        }
      }
      if (sc.reloadU2WhenApproved && !reloaded && b2 && b2.scenes[1].videoApproved && b2.scenes[1].video === "running") {
        reloaded = true;
        console.log("  … F5 en la pestaña de u2 con el vídeo 001 aprobado y generándose");
        await u2.reload();
      }
      if (!shotMid && b2 && b2.phase === "videos" && name === "folder") {
        shotMid = true;
        await panel.screenshot({ path: path.join(OUT, `panel-progreso-${name}.png`), fullPage: true });
        await u2.bringToFront();
        await u2.evaluate(() => document.getElementById("fbr-host").shadowRoot.getElementById("pill").click()).catch(() => {});
        await sleep(400);
        await u2.screenshot({ path: path.join(OUT, `flow-panel-pagina-${name}.png`) });
      }
      let voiceDone = true;
      if (sc.heygen) { const lg = (await panel.evaluate(() => chrome.storage.local.get("fbrLog"))).fbrLog || []; voiceDone = lg.some((e) => /Voz guardada/.test(e.msg) || (e.phase === "voice" && e.level === "error")); }
      if ((sc.noFlow || (b2 && b3 && b2.status !== "running" && b3.status !== "running")) && (!sc.reloadU2WhenApproved || reloaded) && voiceDone) break;
      await sleep(1500);
    }
    const { fbrLog } = await panel.evaluate(() => chrome.storage.local.get("fbrLog"));
    const logTxt = fbrLog.map((e) => `${new Date(e.t).toISOString().slice(11, 19)} [${e.acc || "-"}] [${e.scene ?? "-"}] [${e.phase}] ${e.level.toUpperCase()}: ${e.msg}`).join("\n") + "\n";
    fs.writeFileSync(path.join(OUT, `log-${name}.txt`), logTxt);
    console.log(`  (${Math.round((Date.now() - t0) / 1000)} s · log en tests/e2e/.out/log-${name}.txt)`);
    await panel.bringToFront();
    await panel.click("#tab-progreso");
    await sleep(300);
    await panel.screenshot({ path: path.join(OUT, `panel-final-${name}.png`), fullPage: true });
    await panel.click("#tab-log");
    await sleep(300);
    await panel.screenshot({ path: path.join(OUT, `panel-log-${name}.png`) });

    const b2 = batches.batch_u2, b3 = batches.batch_u3;
    const counts = async (p) => p.evaluate(() => ({ a: +(sessionStorage.getItem("mockApproved") || 0), always: +(sessionStorage.getItem("mockApprovedAlways") || 0), started: +(sessionStorage.getItem("mockStarted") || 0), multi: +(sessionStorage.getItem("mockMultiAttach") || 0), noimg: +(sessionStorage.getItem("mockVideoNoImage") || 0), rejected: (document.getElementById("chat").textContent.match(/He cancelado la generación/g) || []).length, chat: document.getElementById("chat").textContent }));
    const c2 = await counts(u2), c3 = await counts(u3);
    const folder = (b2 && b2.config.batchFolder) || ((fbrLog.map((e) => e.msg).join("\n").match(/Carpeta del lote: (\S+)/) || [])[1]);
    let files = {};
    if (sc.dest === "folder") {
      files = await panel.evaluate(async (folder) => {
        const out = {};
        try {
          const root = await navigator.storage.getDirectory();
          const d = await (await root.getDirectoryHandle("Escritorio")).getDirectoryHandle(folder);
          for await (const [n, h] of d.entries()) out[n] = (await h.getFile()).size;
        } catch (e) {}
        return out;
      }, folder);
    } else {
      const base = path.join(dl, "MundoFutFlow", folder || "x");
      if (fs.existsSync(base)) for (const f of fs.readdirSync(base)) files[f] = fs.statSync(path.join(base, f)).size;
    }
    const downloads = await panel.evaluate(() => chrome.downloads.search({}));
    const stuck = downloads.filter((d) => d.state === "in_progress");

    if (!sc.expect) {
      console.log("  Resultado:", JSON.stringify({ u2: b2 && b2.status, u3: b3 && b3.status, files, descargasVistas: downloads.length, atascadas: stuck.length }));
      console.log("  Líneas relevantes del log:\n" + logTxt.split("\n").filter((l) => /downloads/.test(l)).map((l) => "    " + l).join("\n"));
      return { name, results, exploratory: true };
    }
    const E = sc.expect;
    if (sc.noFlow) check("solo voz: no se lanzó nada en Flow (0 imágenes, 0 vídeos)", !b2 && !b3 && c2.started + c3.started === 0 && !/Fase 1/.test(logTxt), `u2=${b2 && b2.status} u3=${b3 && b3.status}`);
    else check("estado final de las cuentas", b2 && b3 && b2.status === E.u2 && b3.status === E.u3, `u2=${b2 && b2.status} u3=${b3 && b3.status}`);
    const code = { d: "done", f: "failed", r: "review", s: "skipped", p: "pending" };
    for (const [n, want] of Object.entries(E.scenes)) {
      const b = +n === 3 ? b3 : b2;
      const s = b && b.scenes[n];
      const exp = want.split("").map((c) => code[c]);
      check(`escena ${n}: imagen/vídeo/descarga = ${exp.join("/")}`, s && s.image === exp[0] && s.video === exp[1] && s.download === exp[2], s ? `${s.image}/${s.video}/${s.download}${s.error ? " · " + s.error.slice(0, 110) : ""}` : "sin estado");
    }
    check('"Aprobar" pulsado una vez por vídeo, nunca "Aprobar siempre"', c2.a === E.approvals.u2 && c3.a === E.approvals.u3 && c2.always + c3.always === 0, `u2=${c2.a} u3=${c3.a} siempre=${c2.always + c3.always}`);
    if (E.rejected) check('"Rechazar" pulsado las veces esperadas', c3.rejected === (E.rejected.u3 || 0) && c2.rejected === (E.rejected.u2 || 0), `u2 rechazos=${c2.rejected} u3 rechazos=${c3.rejected}`);
    check("ningún vídeo pedido sin su imagen ni con dos imágenes adjuntas", c2.multi + c3.multi + c2.noimg + c3.noimg === 0, `sin imagen=${c2.noimg + c3.noimg} dobles=${c2.multi + c3.multi}`);
    if (E.immediate) check("cada vídeo se descargó nada más generarse (sin pasada final de descargas)", !/Fase 2B: descargo/.test(logTxt) && (logTxt.match(/Guardado: /g) || []).length === 3);
    if (E.logHas) for (const t of E.logHas) check(`el log dice "${t}"`, logTxt.includes(t));
    if (E.started) check("vídeos que Flow empezó a generar", c2.started === (E.started.u2 || 0), `u2=${c2.started}`);
    if (E.chatHas) check(`el reenvío remarca la duración ("${E.chatHas.u2}")`, c2.chat.includes(E.chatHas.u2));
    if (!sc.noFlow) check("las dos cuentas usan la MISMA carpeta nueva del lote", folder && b3 && b3.config.batchFolder === folder, folder);
    const names = Object.keys(files).sort();
    check(`archivos en ${sc.dest === "folder" ? "la carpeta elegida" : "Descargas/MundoFutFlow/<lote>"}: ${E.files.join(", ")}`, JSON.stringify(names) === JSON.stringify([...E.files].sort()), JSON.stringify(files));
    // Cada vídeo simulado pesa 350000 + nº de SU escena (los que ya existían, 350000).
    const vids = names.filter((f) => /_\d{3}\.mp4$/.test(f));
    const sizeOk = (f) => files[f] === (sc.genMode === "downloadTest" ? 350000 : 350000 + parseInt(f.match(/_(\d{3})\./)[1], 10));
    if (E.mode) check(`el panel eligió solo el modo "${E.mode}"`, logTxt.includes(`modo ${E.mode}`) || (E.mode === "voiceOnly" && /solo la voz/.test(logTxt)));
    if (vids.length) check("cada archivo es el vídeo de SU escena (no cruzados)", vids.every(sizeOk), vids.map((f) => `${f}=${files[f]}`).join(" "));
    if (sc.heygen) {
      const hgState = await hg.evaluate(() => ({ text: document.getElementById("script").innerText.replace(/\s+/g, " ").trim(), played: +(sessionStorage.getItem("hgPlayed") || 0), atPlay: sessionStorage.getItem("hgText") || "" }));
      const core = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ]/g, "");
      const want = sc.narration.replace(/\s+/g, " ").trim();
      if (!E.noPlay) check("HeyGen: guion reemplazado por la narración del kit (sin el texto viejo ni repetido)", core(hgState.text) === core(want), JSON.stringify(hgState.text.slice(0, 80)));
      if (E.noPlay) {
        check("HeyGen: con el texto mal, NO se pulsa reproducir (no se gasta ninguna previsualización)", hgState.played === 0, `${hgState.played}`);
        const vs = (await panel.evaluate(() => chrome.storage.local.get("fbrVoice"))).fbrVoice || {};
        check("el panel muestra la voz con error y el motivo", vs.status === "error" && /no he pulsado reproducir/i.test(vs.msg || ""), JSON.stringify(vs.msg || "").slice(0, 120));
      } else {
      check("HeyGen: reproducir pulsado UNA sola vez", hgState.played === 1, `${hgState.played}`);
      const vs = (await panel.evaluate(() => chrome.storage.local.get("fbrVoice"))).fbrVoice || {};
      check("el panel muestra «Voz terminada» con el archivo", vs.status === "done" && /audio\.mp3$/.test(vs.file || ""), `${vs.status} · ${vs.file}`);
      check("audio.mp3 en la carpeta del lote y es el del texto nuevo", core(hgState.atPlay) === core(want) && files["audio.mp3"] === 200000 + hgState.atPlay.length, `audio.mp3=${files["audio.mp3"]} (esperado ${200000 + hgState.atPlay.length})`);
      }
    }
    check('ningún diálogo "Guardar como" pendiente', stuck.length === 0, `${downloads.length} descargas vistas, ${stuck.length} atascadas`);
    if (name === "folder" || name === "resume") check("sin ERRORes falsos en el log", !/ERROR: Chrome interrumpió/.test(logTxt));
    check("nunca se cambió la vista a una pestaña de Flow", !flowWentActive);
    // (El segundo plano REAL se prueba en run-bg.js: Playwright hace que Chrome trate todas las pestañas como visibles.)
    if (discardableWhileRunning) check("Chrome no puede descartar las pestañas de Flow mientras trabajan", discardableWhileRunning.every((d) => d === false), JSON.stringify(discardableWhileRunning));

    if (E.sequential) {
      const endU2 = fbrLog.find((e) => e.acc === "u2" && /RESUMEN/.test(e.msg));
      const startU3 = fbrLog.find((e) => e.acc === "u3" && /EMPIEZA/.test(e.msg));
      check("u3 empezó DESPUÉS de terminar u2", endU2 && startU3 && startU3.t >= endU2.t, `fin u2 ${endU2 && new Date(endU2.t).toISOString().slice(11, 19)} · inicio u3 ${startU3 && new Date(startU3.t).toISOString().slice(11, 19)}`);
    }
    return { name, results };
  } finally {
    if (browser) await browser.close().catch(() => {});
    chrome.kill();
    await sleep(800);
  }
}

async function main() {
  const key = path.join(TMP, "key.pem"), cert = path.join(TMP, "cert.pem");
  if (!fs.existsSync(cert)) execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${key} -out ${cert} -days 30 -subj /CN=flow.google.com 2>/dev/null`);
  const video = Buffer.alloc(350000, 7);
  const mock = fs.readFileSync(path.join(__dirname, "mock-flow.html"));
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
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
    if ((req.headers.host || "").startsWith("app.heygen.com")) {
      const m = req.url.match(/^\/tts\/[^?]+\.mp3\?chars=(\d+)/);
      if (m) { res.setHeader("Content-Type", "audio/mpeg"); return res.end(Buffer.alloc(200000 + parseInt(m[1], 10), 9)); }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(fs.readFileSync(path.join(__dirname, "mock-heygen.html")));
    }
    if (req.url.startsWith("/vendor-prosemirror.js")) { res.setHeader("Content-Type", "text/javascript"); return res.end(fs.readFileSync(path.join(__dirname, "vendor-prosemirror.js"))); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(mock);
  }).listen(8443);
  const wanted = process.env.FBR_E2E ? process.env.FBR_E2E.split(",") : ["folder", "downloads", "resume", "misname", "placeholder", "sourcedl", "voice", "voiceonly", "voicebadtext", "imgonly", "selfheal", "agentreply", "cost", "cost12", "noconfirm", "sequential", "dryrun", "dltest", "dupcost"];
  const all = [];
  try {
    for (const n of wanted) all.push(await runScenario(n, SCENARIOS[n], server));
  } finally {
    server.close();
  }
  const flat = all.flatMap((r) => r.results);
  const bad = flat.filter((r) => !r.ok);
  console.log(`\nTOTAL: ${flat.length - bad.length}/${flat.length} comprobaciones OK en ${all.length} escenario(s)`);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
