/*
 * MUNDO FUT / Flow Batch Runner — service worker
 * ---------------------------------------------------------------------------
 * Hace de "centro" de la extensión:
 *  1. LOG persistente (chrome.storage.local "fbrLog"): todo lo que pasa, con
 *     hora, cuenta, escena y fase. Lo leen el panel lateral y el panel de la
 *     página. Nunca se pierde un error por un mensaje efímero.
 *  2. NOTIFICACIONES del sistema al terminar / fallar (las de fallo no se
 *     cierran solas: requireInteraction).
 *  3. LATIDO: mientras una pestaña de Flow está trabajando le manda un "TICK"
 *     cada 2 s. Chrome frena los temporizadores de las pestañas en segundo
 *     plano (hasta 1 vez por minuto); los mensajes de la extensión NO se
 *     frenan, así que el content script avanza aunque la pestaña esté oculta.
 *  4. PLAN de dos cuentas (en paralelo o una detrás de otra).
 *  5. DESCARGAS: una cada vez, asociando cada descarga de Chrome a su escena
 *     (onCreated/onChanged) y guardándola con su nombre, bien en la carpeta
 *     elegida por el usuario (sin diálogo aunque "Preguntar dónde guardar"
 *     esté activado) o en la carpeta de descargas de Chrome.
 * Nunca llama a chrome.windows.update: no se roba el foco al usuario.
 */
importScripts("shared.js");

const VERSION = chrome.runtime.getManifest().version;
const LOG_KEY = "fbrLog";
const LOG_MAX = 3000;

// ------------------------------------------------------------------ LOG
let logQueue = [];
let logChain = Promise.resolve();

function pushLog(entries) {
  logQueue.push(...entries);
  logChain = logChain
    .then(async () => {
      if (!logQueue.length) return;
      const batch = logQueue;
      logQueue = [];
      const d = await chrome.storage.local.get(LOG_KEY);
      await chrome.storage.local.set({ [LOG_KEY]: appendCapped(d[LOG_KEY] || [], batch, LOG_MAX) });
    })
    .catch((e) => console.error("[FBR] no pude guardar el log:", e));
  return logChain;
}

function blog(level, msg, extra) {
  const x = extra || {};
  const e = { t: Date.now(), acc: x.acc || null, scene: x.scene == null ? null : x.scene, phase: x.phase || "plan", level, msg };
  console.log("[FBR]", formatLogEntry(e));
  pushLog([e]);
  return e;
}

// ------------------------------------------------------- NOTIFICACIONES
function notify(title, message, sticky) {
  chrome.notifications.create(
    `fbr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: title || "Flow Batch Runner",
      message: String(message || "").slice(0, 400),
      priority: sticky ? 2 : 0,
      requireInteraction: !!sticky,
    },
    () => {
      if (chrome.runtime.lastError) blog("warn", `No se pudo mostrar la notificación del sistema: ${chrome.runtime.lastError.message}`);
    }
  );
}

// ---------------------------------------------------------- PANEL LATERAL
function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
setupSidePanel();
chrome.runtime.onInstalled.addListener((d) => {
  setupSidePanel();
  blog("info", `Extensión ${d.reason === "install" ? "instalada" : "actualizada/recargada"} (v${VERSION}). Si tenías pestañas de Flow abiertas, pulsa F5 en ellas.`);
});

// ------------------------------------------------------------- LATIDO
const HB_KEY = "fbrRunningTabs"; // storage.session: { tabId: accountKey }
let hbTimer = null;

async function getRunningTabs() {
  const d = await chrome.storage.session.get(HB_KEY);
  return d[HB_KEY] || {};
}

async function setRunningTab(tabId, acc, on) {
  const tabs = await getRunningTabs();
  if (on) tabs[tabId] = acc;
  else delete tabs[tabId];
  await chrome.storage.session.set({ [HB_KEY]: tabs });
  ensureHeartbeat();
}

function ensureHeartbeat() {
  if (hbTimer) return;
  hbTimer = setInterval(async () => {
    const tabs = await getRunningTabs();
    const ids = Object.keys(tabs);
    if (!ids.length) {
      clearInterval(hbTimer);
      hbTimer = null;
      return;
    }
    for (const id of ids) chrome.tabs.sendMessage(Number(id), { type: "TICK" }).catch(() => {});
  }, 2000);
}

chrome.alarms.create("fbr-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "fbr-keepalive") return;
  const tabs = await getRunningTabs();
  if (Object.keys(tabs).length) ensureHeartbeat();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await getRunningTabs();
  if (!tabs[tabId]) return;
  const acc = tabs[tabId];
  await setRunningTab(tabId, acc, false);
  blog("error", `Se ha cerrado la pestaña de Flow de la cuenta ${acc} con el lote en marcha. El progreso está guardado: vuelve a abrir Flow en esa cuenta (mismo proyecto) y se reanudará solo.`, { acc, phase: "run" });
  notify(`Pestaña cerrada (${acc})`, "Se cerró la pestaña de Flow con el lote en marcha. Vuelve a abrirla (mismo proyecto) y se reanudará.", true);
});

// ----------------------------------------------------------- PESTAÑAS
async function findTabForAccount(accountKey) {
  const tabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/tools/flow/*"] });
  return tabs.find((t) => getFlowAccountKey(t.url) === accountKey) || null;
}

// Si la pestaña no tiene content script (extensión recargada sin F5), se le
// inyecta ahora en vez de pedirle al usuario que recargue.
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(e && e.message))) throw e;
    blog("warn", "La pestaña de Flow no tenía cargado el código de la extensión (¿se recargó la extensión sin F5?). Lo inyecto ahora.");
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page-hook.js"], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] });
    await new Promise((r) => setTimeout(r, 800));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// --------------------------------------------------------------- PLAN
const PLAN_KEY = "fbrPlan"; // storage.session

async function getPlan() {
  return (await chrome.storage.session.get(PLAN_KEY))[PLAN_KEY] || null;
}
async function setPlan(p) {
  if (p) await chrome.storage.session.set({ [PLAN_KEY]: p });
  else await chrome.storage.session.remove(PLAN_KEY);
}

async function launchStep(step) {
  const tab = await findTabForAccount(step.accountKey);
  if (!tab) {
    blog("error", `No encuentro ninguna pestaña abierta de Flow para la cuenta ${step.accountKey} (busco una URL con /${step.accountKey.replace("u", "u/")}/). Esa cuenta no se ejecuta; la otra sigue.`, { acc: step.accountKey });
    notify("Falta una pestaña de Flow", `No hay pestaña abierta para la cuenta ${step.accountKey}.`, true);
    return false;
  }
  if (!/\/project\//.test(tab.url)) {
    blog("warn", `La pestaña de ${step.accountKey} no está dentro de un proyecto de Flow (${tab.url}). Abre un proyecto (mejor uno nuevo y vacío) antes de lanzar.`, { acc: step.accountKey });
  }
  if (step.bringToFront) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  try {
    const r = await sendToTab(tab.id, { type: "START_RUN", ...step.run });
    if (r && r.ok === false) {
      blog("error", `La pestaña de ${step.accountKey} rechazó el lote: ${r.error}`, { acc: step.accountKey });
      return false;
    }
    blog("info", `Lote enviado a la pestaña de ${step.accountKey} (escenas ${step.run.sceneNumbers.join(", ")}).`, { acc: step.accountKey });
    return true;
  } catch (e) {
    blog("error", `No pude comunicarme con la pestaña de ${step.accountKey}: ${e.message}. Pulsa F5 en esa pestaña y vuelve a lanzar.`, { acc: step.accountKey });
    return false;
  }
}

async function runPlan(plan) {
  blog("info", `Plan recibido: ${plan.steps.map((s) => `${s.accountKey} → escenas ${s.run.sceneNumbers.join(",")}`).join(" · ")} (${plan.parallel ? "en paralelo" : "una cuenta detrás de otra"}). Carpeta del lote: ${plan.steps[0] ? plan.steps[0].run.batchFolder : "?"}`);
  plan.pending = plan.steps.map((s) => s.accountKey);
  plan.results = {};
  await setPlan(plan);
  if (plan.parallel) {
    for (const s of plan.steps) {
      const ok = await launchStep(s);
      if (!ok) await markStepDone(s.accountKey, { failedToStart: true });
    }
  } else {
    await launchNextSequential();
  }
}

async function launchNextSequential() {
  const plan = await getPlan();
  if (!plan) return;
  const next = plan.steps.find((s) => plan.pending.includes(s.accountKey) && !plan.launched?.includes(s.accountKey));
  if (!next) return;
  plan.launched = (plan.launched || []).concat(next.accountKey);
  await setPlan(plan);
  const ok = await launchStep(next);
  if (!ok) await markStepDone(next.accountKey, { failedToStart: true });
}

async function markStepDone(acc, summary) {
  const plan = await getPlan();
  if (!plan || !plan.pending.includes(acc)) return;
  plan.pending = plan.pending.filter((a) => a !== acc);
  plan.results[acc] = summary || {};
  await setPlan(plan);
  if (plan.pending.length === 0) {
    await setPlan(null);
    const parts = Object.entries(plan.results).map(([a, r]) =>
      r.failedToStart ? `${a}: no arrancó` : `${a}: ${r.doneCount || 0}/${r.total || 0} vídeos${r.problemScenes && r.problemScenes.length ? ` (revisar ${r.problemScenes.map(pad3).join(", ")})` : ""}`
    );
    const anyBad = Object.values(plan.results).some((r) => r.failedToStart || (r.problemScenes && r.problemScenes.length));
    blog(anyBad ? "warn" : "ok", `Plan completo. ${parts.join(" · ")}`);
    notify(anyBad ? "Plan terminado con avisos" : "Plan terminado ✅", parts.join("\n"), anyBad);
  } else if (!plan.parallel) {
    await launchNextSequential();
  }
}

// ---------------------------------------------------------- DESCARGAS
// Un solo trabajo de descarga a la vez para TODA la extensión: Chrome no dice
// desde qué pestaña sale una descarga, así que con dos cuentas en paralelo la
// única forma fiable de asociar cada descarga a su escena es no solaparlas.
const JOB_KEY = "fbrDlJob"; // storage.session
let job = null;
const ownDownloads = new Map(); // id -> relPath (descargas lanzadas por la extensión)
const ownUrls = new Set();
const ready = chrome.storage.session.get(JOB_KEY).then((d) => {
  job = d[JOB_KEY] || null;
});

function saveJob() {
  return job ? chrome.storage.session.set({ [JOB_KEY]: job }) : chrome.storage.session.remove(JOB_KEY);
}
function jlog(level, msg) {
  if (job) blog(level, msg, { acc: job.acc, scene: job.scene, phase: "downloads" });
}
function finishJob(result) {
  if (!job) return;
  job.status = result.ok ? "done" : "failed";
  job.result = result;
  saveJob();
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Guardar los vídeos generados en la carpeta que eligió el usuario.",
  });
}

async function offscreenCall(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

// Descarga "propia" (con chrome.downloads) a la carpeta de descargas de Chrome.
async function ownDownload(url, relPath) {
  ownUrls.add(url);
  const id = await chrome.downloads.download({ url, filename: `MundoFutFlow/${relPath}`, saveAs: false, conflictAction: "uniquify" });
  ownDownloads.set(id, `MundoFutFlow/${relPath}`);
  return id;
}

async function saveToFolder(item) {
  const kind = urlKind(item.url);
  job.status = "saving";
  saveJob();
  let res;
  try {
    if (kind === "blob") {
      await ensureOffscreen();
      res = await chrome.tabs.sendMessage(job.tabId, { type: "FETCH_BLOB_TO_OFFSCREEN", url: item.url, jobId: job.id, relPath: job.relPath, mime: item.mime });
    } else if (kind === "https" || kind === "data") {
      res = await offscreenCall({ type: "FS_SAVE_URL", url: item.url, relPath: job.relPath });
    } else {
      res = { ok: false, error: `tipo de URL no soportado (${kind})` };
    }
  } catch (e) {
    res = { ok: false, error: String(e.message || e) };
  }
  if (!job) return;
  if (res && res.ok) {
    jlog("info", `Archivo escrito en la carpeta elegida (${(res.bytes / 1048576).toFixed(1)} MB).`);
    finishJob({ ok: true, path: res.path, nameOk: true, where: "folder" });
    return;
  }
  const why = (res && res.error) || "sin respuesta";
  if (kind === "https") {
    jlog("warn", `No pude escribir en la carpeta elegida (${why}). Plan B: descargo con Chrome a Descargas/MundoFutFlow/${job.relPath}.`);
    job.mode = "downloads";
    job.status = "created";
    job.createdAt = Date.now();
    job.downloadId = await ownDownload(item.url, job.relPath);
    saveJob();
  } else {
    jlog("error", `No pude guardar el vídeo en la carpeta elegida: ${why}.`);
    finishJob({ ok: false, error: why });
  }
}

chrome.downloads.onCreated.addListener(async (item) => {
  await ready;
  if (ownUrls.has(item.url)) {
    ownUrls.delete(item.url);
    return;
  }
  if (!job || job.status !== "armed") {
    if (isFlowDownloadCandidate(item)) blog("info", `Descarga de Flow no esperada por la extensión (#${item.id}, ${urlKind(item.url)}); no la toco.`, { phase: "downloads" });
    return;
  }
  if (!isFlowDownloadCandidate(item)) {
    blog("info", `Descarga ajena a Flow ignorada (#${item.id}).`, { phase: "downloads" });
    return;
  }
  job.downloadId = item.id;
  job.status = "created";
  job.createdAt = Date.now();
  job.urlKind = urlKind(item.url);
  saveJob();
  jlog("info", `Chrome ha registrado la descarga #${item.id} (URL tipo ${job.urlKind}, a los ${Math.round((job.createdAt - job.armedAt) / 1000)} s de pedirla).`);
  if (job.mode === "folder") {
    // Se cancela la descarga nativa (con "Preguntar dónde guardar" activado
    // abriría el diálogo) y se guardan los bytes nosotros mismos.
    job.nativeCancelledId = item.id;
    job.status = "saving";
    saveJob();
    try { await chrome.downloads.cancel(item.id); } catch (e) {}
    try { await chrome.downloads.erase({ id: item.id }); } catch (e) {}
    await saveToFolder(item);
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    await ready;
    if (ownDownloads.has(item.id)) {
      // OJO (comprobado en Chromium): si existe este listener, Chrome ignora el
      // "filename" de chrome.downloads.download salvo que se repita aquí.
      suggest({ filename: ownDownloads.get(item.id), conflictAction: "uniquify" });
      return;
    }
    if (job && job.mode === "downloads" && (job.downloadId === item.id || (job.status === "armed" && isFlowDownloadCandidate(item)))) {
      if (job.downloadId !== item.id) {
        job.downloadId = item.id;
        job.status = "created";
        job.createdAt = Date.now();
      }
      const target = `MundoFutFlow/${job.relPath}`;
      jlog("info", `Nombre asignado a la descarga #${item.id}: ${target} (Flow proponía "${item.filename}").`);
      saveJob();
      suggest({ filename: target, conflictAction: "uniquify" });
      return;
    }
    suggest();
  })();
  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  if (!job || delta.id !== job.downloadId) return;
  if (delta.state && delta.state.current === "complete") {
    const [it] = await chrome.downloads.search({ id: delta.id });
    const finalPath = it ? it.filename : "";
    const nameOk = downloadNameMatches(finalPath, job.fileName);
    if (nameOk) jlog("ok", `Descarga completa: ${finalPath}`);
    else jlog("error", `La descarga terminó pero con OTRO nombre: "${finalPath}" (esperaba "${job.fileName}"). ¿Hay otra extensión que renombra descargas?`);
    finishJob({ ok: true, path: finalPath, nameOk, where: "downloads" });
  } else if (delta.state && delta.state.current === "interrupted") {
    if (job.nativeCancelledId === delta.id) return; // la cancelamos nosotros a propósito
    const err = (delta.error && delta.error.current) || "interrumpida";
    jlog("error", `Chrome interrumpió la descarga #${delta.id}: ${err}${err === "USER_CANCELED" ? " (¿se canceló el diálogo 'Guardar como'?)" : ""}.`);
    finishJob({ ok: false, error: `descarga interrumpida (${err})` });
  }
});

async function jobStatus(jobId) {
  if (!job || job.id !== jobId) return { status: "gone" };
  // Con "Preguntar dónde guardar" activado la descarga se queda en curso con
  // nombre vacío mientras el diálogo espera: lo detectamos para avisar.
  if (job.mode === "downloads" && job.status === "created" && job.downloadId != null && Date.now() - job.createdAt > 10000 && !job.promptWarned) {
    const [it] = await chrome.downloads.search({ id: job.downloadId });
    if (it && it.state === "in_progress" && !it.filename) {
      job.promptWarned = true;
      saveJob();
      jlog("warn", 'Chrome parece estar mostrando el diálogo "Guardar como" (tienes activado "Preguntar dónde guardar cada archivo"). Con el destino "Carpeta elegida" no pasaría.');
    }
  }
  return { status: job.status, result: job.result || null, urlKind: job.urlKind || null, downloadId: job.downloadId, promptWarned: !!job.promptWarned };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false;
  const tabId = sender.tab ? sender.tab.id : null;
  const handle = async () => {
    await ready;
    switch (msg.type) {
      case "LOG":
        await pushLog(Array.isArray(msg.entries) ? msg.entries : [msg.entry]);
        return { ok: true };
      case "NOTIFY":
        notify(msg.title, msg.message, msg.sticky);
        return { ok: true };
      case "HEARTBEAT":
        if (tabId != null) await setRunningTab(tabId, msg.acc, !!msg.on);
        return { ok: true };
      case "RUN_COMPLETE":
        if (tabId != null) await setRunningTab(tabId, msg.acc, false);
        await markStepDone(msg.acc, msg.summary);
        return { ok: true };
      case "RUN_PLAN":
        await runPlan(msg.plan);
        return { ok: true };
      case "STOP_ALL": {
        await setPlan(null);
        const tabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/tools/flow/*"] });
        for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "STOP_QUEUE" }).catch(() => {});
        blog("warn", "Detener pulsado: se para cada cuenta en cuanto termine el paso en curso (no se cancela una generación ya aprobada).");
        return { ok: true };
      }
      case "DL_ARM": {
        const stale = job && Date.now() - job.armedAt > 8 * 60 * 1000;
        if (job && !stale && job.status !== "done" && job.status !== "failed" && job.tabId !== tabId) return { ok: false, busy: true };
        job = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          tabId,
          acc: msg.acc,
          scene: msg.scene,
          relPath: msg.relPath,
          fileName: msg.relPath.split("/").pop(),
          mode: msg.mode === "folder" ? "folder" : "downloads",
          armedAt: Date.now(),
          status: "armed",
          downloadId: null,
        };
        await saveJob();
        return { ok: true, jobId: job.id };
      }
      case "DL_STATUS":
        return await jobStatus(msg.jobId);
      case "DL_DISARM":
        if (job && job.id === msg.jobId) {
          if (job.downloadId != null && job.status !== "done") chrome.downloads.cancel(job.downloadId).catch(() => {});
          job = null;
          await saveJob();
        }
        return { ok: true };
      case "FS_STATUS":
        return await offscreenCall({ type: "FS_STATUS" });
      default:
        return undefined;
    }
  };
  handle()
    .then((r) => { if (r !== undefined) sendResponse(r); })
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));
