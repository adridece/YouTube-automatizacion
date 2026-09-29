/*
 * Cerezium Autopilot (antes "Flow Batch Runner") — service worker
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
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: title || "Cerezium Autopilot",
      message: String(message || "").slice(0, 400),
      priority: sticky ? 2 : 0,
      requireInteraction: !!sticky,
    },
    () => {
      if (chrome.runtime.lastError) blog("warn", `No se pudo mostrar la notificación del sistema: ${chrome.runtime.lastError.message}`);
    }
  );
}

// ------------------------------------------------ CÓMO SE ABRE LA INTERFAZ
// Dos modos (panel de la extensión → Opciones avanzadas):
//  - "popup" (POR DEFECTO desde v2.6): la ventanita típica de extensión bajo
//    el icono (se cierra al hacer clic fuera; no pasa nada: todo el estado
//    está guardado). No toca el tamaño de la página de Flow.
//  - "sidepanel": panel lateral de Chrome. PRUEBA REAL v2.5: al abrirse
//    ESTRECHA la página de Flow, Flow recoloca sus elementos y la
//    automatización falla. Solo si el usuario lo elige.
// Si el panel lateral no funciona en el navegador del usuario (v2.0.1: se le
// abría como página completa), se pasa solo a "popup".
const UI_KEY = "fbrUiMode";
const POPUP_PAGE = "sidepanel.html?modo=popup";
const UI_MIGRATED_KEY = "fbrUiMode26"; // una sola vez: todos a "popup" al pasar a v2.6

function sidePanelSupported() {
  return !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior && chrome.sidePanel.open);
}

async function applyUiMode() {
  const st = await chrome.storage.local.get([UI_KEY, UI_MIGRATED_KEY]);
  if (!st[UI_MIGRATED_KEY]) {
    // v2.6: quien venía del panel lateral pasa a la ventanita (el panel
    // redimensionaba Flow). Después se respeta lo que elija en Opciones.
    await chrome.storage.local.set({ [UI_KEY]: "popup", [UI_MIGRATED_KEY]: true });
    st[UI_KEY] = "popup";
  }
  const mode = st[UI_KEY] || "popup";
  if (mode === "popup" || !sidePanelSupported()) {
    await chrome.action.setPopup({ popup: POPUP_PAGE });
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  } else {
    try {
      // En algunos navegadores basados en Chromium la API existe pero falla
      // ("SidePanel API not available", visto en el del usuario): ventanita.
      // El clic en la cereza lo recibe la extensión (action.onClicked), que abre
      // el panel ella misma: así cada clic también PREPARA la pestaña en la que
      // se pulsa (Chrome solo da permiso de captura en ese momento).
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: "" });
    } catch (e) {
      blog("info", `Este navegador no tiene panel lateral para extensiones (${e.message}): al pulsar el icono se abrirá la ventanita.`);
      await chrome.storage.local.set({ [UI_KEY]: "popup" });
      await chrome.action.setPopup({ popup: POPUP_PAGE });
      return "popup";
    }
  }
  return mode;
}
applyUiMode().catch(() => {});
chrome.runtime.onStartup.addListener(() => applyUiMode().catch(() => {}));

// Clic en la cereza (o Alt+Shift+C) en modo panel lateral: (1) abre el panel
// y (2) si la pestaña es de Flow, la PREPARA para segundo plano. Si el panel
// no se puede abrir, se pasa al modo ventanita para las siguientes veces.
chrome.action.onClicked.addListener(async (tab) => {
  // Se llama a open() sin esperar a nada antes: Chrome exige que sea
  // inmediato tras el clic.
  const opening = sidePanelSupported() ? chrome.sidePanel.open({ windowId: tab.windowId }) : Promise.reject(new Error("este navegador no tiene panel lateral para extensiones"));
  if (/^https:\/\/(flow\.google\.com|labs\.google|app\.heygen\.com)\//.test(tab.url || "")) {
    armTab(tab.id).then((r) => {
      if (!r.ok) blog("warn", `No pude preparar la pestaña de ${r.acc || "Flow"} para segundo plano: ${r.error}`, { acc: r.acc || null, phase: "setup" });
      chrome.runtime.sendMessage({ type: "ARMED_EVENT", ok: r.ok, already: !!r.already, acc: r.acc, error: r.error || null }).catch(() => {});
    });
  }
  try {
    await opening;
  } catch (e) {
    blog("warn", `Tu navegador no deja abrir el panel lateral (${e.message}). A partir de ahora la extensión se abre en la ventanita de siempre al pulsar el icono.`);
    await chrome.storage.local.set({ [UI_KEY]: "popup" });
    await applyUiMode();
    try { await chrome.action.openPopup({ windowId: tab.windowId }); } catch (e2) { await openFloatingWindow(); }
  }
});

// Ventana pequeña flotante con la interfaz (para verla junto a Flow cuando no
// hay panel lateral). Solo se abre cuando el usuario lo pide.
const WIN_KEY = "fbrFloatWin";
async function openFloatingWindow() {
  const id = (await chrome.storage.session.get(WIN_KEY))[WIN_KEY];
  if (id) {
    const ok = await chrome.windows.update(id, { focused: true }).then(() => true, () => false);
    if (ok) return "window";
  }
  const w = await chrome.windows.create({ url: chrome.runtime.getURL("sidepanel.html?modo=ventana"), type: "popup", width: 440, height: 860 });
  await chrome.storage.session.set({ [WIN_KEY]: w.id });
  return "window";
}

// COMPROBADO (tests/e2e/run-bg.js): con la pestaña de Flow en segundo plano,
// Chrome deja pasar la 1.ª descarga y RETIENE la 2.ª y siguientes con un aviso
// de "descargar varios archivos" que nadie ve. La extensión da ese permiso a
// flow.google.com (lo mismo que chrome://settings/content/automaticDownloads).
async function allowFlowAutomaticDownloads() {
  if (!chrome.contentSettings || !chrome.contentSettings.automaticDownloads) {
    blog("warn", 'Este navegador no deja a la extensión permitir las "descargas automáticas" de flow.google.com: permítelas tú en chrome://settings/content/automaticDownloads o la 2.ª descarga se quedará retenida.');
    return false;
  }
  try {
    for (const host of ["https://flow.google.com/*", "https://labs.google/*"]) {
      await chrome.contentSettings.automaticDownloads.set({ primaryPattern: host, setting: "allow" });
    }
    return true;
  } catch (e) {
    blog("warn", `No pude permitir las descargas automáticas de flow.google.com (${e.message}). Permítelas en chrome://settings/content/automaticDownloads.`);
    return false;
  }
}
allowFlowAutomaticDownloads();

chrome.runtime.onInstalled.addListener((d) => {
  applyUiMode().catch(() => {});
  blog("info", `Extensión ${d.reason === "install" ? "instalada" : "actualizada/recargada"} (v${VERSION}). Si tenías pestañas de Flow abiertas, pulsa F5 en ellas.`);
});

// ------------------------------------------------------------- LATIDO
const HB_KEY = "fbrRunningTabs"; // storage.session: { tabId: accountKey }
let hbTimer = null;

async function getRunningTabs() {
  const d = await chrome.storage.session.get(HB_KEY);
  return d[HB_KEY] || {};
}

// Mientras una pestaña de Flow trabaja: (1) Chrome no puede descartarla por
// "Ahorro de memoria" aunque esté en segundo plano, y (2) el ordenador no se
// duerme (la pantalla sí puede apagarse). Se deshace al terminar.
async function setRunningTab(tabId, acc, on) {
  const tabs = await getRunningTabs();
  if (on) tabs[tabId] = acc;
  else delete tabs[tabId];
  await chrome.storage.session.set({ [HB_KEY]: tabs });
  chrome.tabs.update(Number(tabId), { autoDiscardable: !on }).catch(() => {});
  if (chrome.power) {
    if (Object.keys(tabs).length) chrome.power.requestKeepAwake("system");
    else chrome.power.releaseKeepAwake();
  }
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
  const a = await getArmed();
  if (a[tabId]) { await setArmed(tabId, null); offscreenCall({ type: "CAPTURE_STOP", tabId }).catch(() => {}); }
  dbgTabs.delete(tabId);
  const tabs = await getRunningTabs();
  if (!tabs[tabId]) return;
  const acc = tabs[tabId];
  await setRunningTab(tabId, acc, false);
  blog("error", `Se ha cerrado la pestaña de Flow de la cuenta ${acc} con el lote en marcha. El progreso está guardado: vuelve a abrir Flow en esa cuenta (mismo proyecto) y se reanudará solo.`, { acc, phase: "run" });
  notify(`Pestaña cerrada (${acc})`, "Se cerró la pestaña de Flow con el lote en marcha. Vuelve a abrirla (mismo proyecto) y se reanudará.", true);
});

// ------------------------------------------ SEGUNDO PLANO DE VERDAD (captura)
// COMPROBADO en Chromium (v2.3): una pestaña capturada con tabCapture pasa a
// "visible" para Chrome y sigue pintándose y procesándose aunque el usuario
// mire otra (sin captura, sus fotogramas se congelan y Flow se queda
// "Cargando…" o con el vídeo "al 100%"). Chrome solo deja capturar una
// pestaña en la que el usuario ha pulsado la extensión (icono o Alt+Shift+C):
// por eso cada pestaña de Flow se "prepara" una vez al abrir la ventanita en ella.
const ARM_KEY = "fbrArmedTabs"; // storage.session: { tabId: accountKey }

async function getArmed() {
  return (await chrome.storage.session.get(ARM_KEY))[ARM_KEY] || {};
}
async function setArmed(tabId, acc) {
  const a = await getArmed();
  if (acc) a[tabId] = acc;
  else delete a[tabId];
  await chrome.storage.session.set({ [ARM_KEY]: a });
}
async function isArmed(tabId) {
  const a = await getArmed();
  if (!a[tabId]) return false;
  const r = await offscreenCall({ type: "CAPTURE_ALIVE", tabId }).catch(() => null);
  if (r && r.alive) return true;
  await setArmed(tabId, null);
  return false;
}
async function armTab(tabId, quiet) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const isHeygen = !!(tab && /^https:\/\/app\.heygen\.com\//.test(tab.url || ""));
  if (!tab || (!isHeygen && !/^https:\/\/(flow\.google\.com|labs\.google)\//.test(tab.url || ""))) return { ok: false, error: "no es una pestaña de Flow ni de HeyGen" };
  const acc = isHeygen ? "heygen" : getFlowAccountKey(tab.url);
  if (await isArmed(tabId)) return { ok: true, acc, already: true };
  if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) return { ok: false, acc, error: "este navegador no permite a las extensiones capturar pestañas" };
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    return { ok: false, acc, needsClick: true, error: e.message };
  }
  const r = await offscreenCall({ type: "CAPTURE_START", tabId, streamId }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) return { ok: false, acc, error: (r && r.error) || "el documento de captura no respondió" };
  await setArmed(tabId, acc);
  if (!quiet) blog("ok", `Pestaña de ${acc} preparada para segundo plano: Chrome la seguirá procesando aunque mires otra pestaña. Verás en ella el icono de "compartiendo": es la extensión manteniéndola activa (no se graba ni se envía nada).`, { acc, phase: "setup" });
  return { ok: true, acc };
}

// ------------------------------------------- FOCO Y PULSACIONES REALES (depurador)
// PRUEBA REAL v2.4.0: con la pestaña preparada pero SIN foco (usuario en otra
// pestaña), Flow no acepta el envío: ni clic, ni Enter, ni ninguna forma de
// escribir (log "foco: no"). Con chrome.debugger (autorizado por el usuario):
//  - Emulation.setFocusEmulationEnabled: la pestaña cree que tiene el foco;
//  - Input.*: clic, texto y teclas REALES (isTrusted), de reserva.
// SOLO en las pestañas de Flow y SOLO mientras hay un lote en marcha: al
// terminar se suelta. Chrome muestra mientras tanto la barra "Cerezium ha
// empezado a depurar este navegador".
const dbgTabs = new Set();
async function dbgEnsure(tabId) {
  if (!chrome.debugger) throw new Error("este navegador no permite chrome.debugger");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https:\/\/(flow\.google\.com|labs\.google|app\.heygen\.com)\//.test(tab.url || "")) throw new Error("solo se usa en pestañas de Flow y de HeyGen");
  if (!dbgTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(String(e && e.message))) throw e;
    }
    dbgTabs.add(tabId);
  }
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
}
async function dbgDetach(tabId) {
  if (!dbgTabs.has(tabId)) return;
  dbgTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
if (chrome.debugger) {
  chrome.debugger.onDetach.addListener(async (src, reason) => {
    if (src.tabId == null || !dbgTabs.has(src.tabId)) return;
    dbgTabs.delete(src.tabId);
    const running = await getRunningTabs();
    if (reason === "canceled_by_user" && running[src.tabId]) {
      blog("warn", `Se cerró la barra "Cerezium ha empezado a depurar este navegador" con un lote en marcha (${running[src.tabId]}). Sin ella Flow no acepta los envíos sin mirarlo; la reactivo en el próximo envío.`, { acc: running[src.tabId] });
    }
  });
}
async function dbgCmd(tabId, method, params) {
  await dbgEnsure(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}
async function dbgClick(tabId, x, y) {
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
async function dbgSelectAllDelete(tabId) {
  const a = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...a, modifiers: 2, commands: ["selectAll"] });
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...a, modifiers: 2 });
  const b = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...b });
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...b });
}
async function dbgEnter(tabId) {
  const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...k, text: "\r", unmodifiedText: "\r" });
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
}

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
  // Nunca se activa la pestaña de Flow: el usuario sigue usando el navegador.
  // Si Chrome la tiene "dormida" (descartada o sin cargar, p. ej. abierta en
  // segundo plano al arrancar), se recarga y se espera a que cargue.
  if (tab.discarded || tab.status === "unloaded") {
    blog("warn", `La pestaña de ${step.accountKey} estaba dormida (Chrome la había descartado). La recargo antes de empezar.`, { acc: step.accountKey });
    await chrome.tabs.reload(tab.id).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (t && t.status === "complete" && !t.discarded) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  let armed = await isArmed(tab.id);
  if (!armed) armed = (await armTab(tab.id)).ok; // funciona si ya se pulsó la cereza en esa pestaña
  if (!armed) {
    blog("warn", `La pestaña de ${step.accountKey} NO está preparada para segundo plano. Si no la miras, Flow puede quedarse parado. Para prepararla: entra en esa pestaña y pulsa la cereza (o Alt+Shift+C) una vez; el lote sigue y en cuanto la prepares funcionará sin mirarla.`, { acc: step.accountKey });
    notify(`Prepara la pestaña de ${step.accountKey}`, "Entra en esa pestaña de Flow y pulsa la cereza una vez para que siga trabajando aunque no la mires.", true);
  }
  try {
    const r = await sendToTab(tab.id, { type: "START_RUN", ...step.run, armed });
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
  if (!plan.steps.length) {
    // Solo la voz (v2.9.1): no hay nada que hacer en Flow.
    blog("info", `Plan recibido: solo la voz (HeyGen). Carpeta del lote: ${plan.voice ? plan.voice.batchFolder : "?"}`);
    if (plan.voice && plan.voice.text) runVoice(plan.voice).catch((e) => vlog("error", `Error inesperado generando la voz: ${e.message}`));
    return;
  }
  await allowFlowAutomaticDownloads();
  blog("info", `Plan recibido: ${plan.steps.map((s) => `${s.accountKey} → escenas ${s.run.sceneNumbers.join(",")}`).join(" · ")} (${plan.parallel ? "en paralelo" : "una cuenta detrás de otra"}). Carpeta del lote: ${plan.steps[0] ? plan.steps[0].run.batchFolder : "?"}`);
  plan.pending = plan.steps.map((s) => s.accountKey);
  plan.results = {};
  await setPlan(plan);
  // La voz (HeyGen) va a la vez que Flow, en su propia pestaña.
  if (plan.voice && plan.voice.text) runVoice(plan.voice).catch((e) => vlog("error", `Error inesperado generando la voz: ${e.message}`));
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

let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({ url: "offscreen.html", reasons: ["BLOBS", "USER_MEDIA"], justification: "Guardar los vídeos en la carpeta elegida y mantener activas (capturadas) las pestañas de Flow en segundo plano." })
      .catch((e) => { if (!/single offscreen/i.test(String(e && e.message))) throw e; })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

// El documento offscreen puede tardar un instante en tener su listener tras
// crearse (visto con dos cuentas a la vez): se reintenta antes de rendirse.
async function offscreenCall(msg) {
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    await ensureOffscreen();
    try {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
      if (r !== undefined) return r;
      lastErr = new Error("el escritor de archivos no respondió");
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw lastErr;
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
      jlog("warn", 'Chrome está mostrando el diálogo "Guardar como" (tienes activado "Preguntar dónde guardar cada archivo"). Contéstalo; con el destino "Carpeta elegida" no pasaría.');
      notify(`Chrome pide "Guardar como" (${job.acc}, escena ${pad3(job.scene)})`, `Contesta el diálogo de Chrome para ${job.fileName}. Espero 2 minutos.`, true);
    }
  }
  if (job.status === "done" || job.status === "failed") {
    job.collected = true;
    saveJob();
  }
  return { status: job.status, result: job.result || null, urlKind: job.urlKind || null, downloadId: job.downloadId, promptWarned: !!job.promptWarned };
}

// ============================================================ VOZ (HeyGen, v2.9)
// Petición del usuario (29 sep 2026): con la narración del kit, en la pestaña
// de HeyGen que tiene abierta con su voz: borrar el guion, escribir la
// narración, pulsar reproducir, y guardar el NUEVO "media" que aparece en
// DevTools → Network → Media como audio.mp3 en la carpeta del lote.
// Aquí se hace lo mismo que DevTools: el depurador (Network) de ESA pestaña.
function vlog(level, msg) { blog(level, msg, { phase: "voice" }); }

async function findHeygenTab() {
  const tabs = await chrome.tabs.query({ url: "https://app.heygen.com/*" });
  return tabs.find((t) => /\/create/.test(t.url || "")) || tabs[0] || null;
}
async function sendToHeygen(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(e && e.message))) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["heygen.js"] });
    await new Promise((r) => setTimeout(r, 500));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// Peticiones de audio/vídeo vistas por el depurador en cada pestaña.
const netMedia = new Map(); // tabId -> Map(requestId -> {url, type, mime, status, t, finished, fromCache, body, contentRange})
const hdr = (headers, name) => {
  if (!headers) return null;
  if (Array.isArray(headers)) { const h = headers.find((x) => String(x.name).toLowerCase() === name); return h ? h.value : null; }
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
  return k ? headers[k] : null;
};
if (chrome.debugger) {
  chrome.debugger.onEvent.addListener((src, method, params) => {
    const list = netMedia.get(src.tabId);
    if (!list) {
      // Nunca dejar una petición parada (la página se quedaría esperando).
      if (method === "Fetch.requestPaused") chrome.debugger.sendCommand({ tabId: src.tabId }, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const r = params.request || {};
      if (params.type === "Media" || /\.(mp3|wav|m4a|aac|ogg|opus)(\?|$)/i.test(r.url || "")) {
        list.set(params.requestId, { ...(list.get(params.requestId) || {}), url: r.url, type: params.type, mime: "", status: 0, t: Date.now(), finished: false });
      }
    } else if (method === "Network.responseReceived") {
      const r = params.response || {};
      const known = list.get(params.requestId);
      if (known || params.type === "Media" || /^audio\//i.test(r.mimeType || "")) {
        list.set(params.requestId, { ...(known || { t: Date.now(), finished: false }), url: r.url, type: params.type, mime: r.mimeType || "", status: r.status || 0, fromCache: !!(r.fromDiskCache || r.fromMemoryCache), contentRange: hdr(r.headers, "content-range") });
      }
    } else if (method === "Network.loadingFinished") {
      const known = list.get(params.requestId);
      if (known) known.finished = true;
    } else if (method === "Fetch.requestPaused") {
      // Respuesta de un "media" interceptada ANTES de llegar a la página: se
      // guarda una copia de su contenido (así da igual que sea 206 o que
      // Chrome no conserve el cuerpo de los media) y se deja continuar.
      (async () => {
        const tabId = src.tabId;
        const url = (params.request && params.request.url) || "";
        const mime = (hdr(params.responseHeaders, "content-type") || "").split(";")[0];
        const rec = { url, type: params.resourceType, mime, status: params.responseStatusCode || 0, t: Date.now(), finished: true, contentRange: hdr(params.responseHeaders, "content-range"), via: "interceptado" };
        try {
          if (voiceMediaScore(rec) > 0) {
            const body = await chrome.debugger.sendCommand({ tabId }, "Fetch.getResponseBody", { requestId: params.requestId });
            rec.body = body.base64Encoded ? body.body : btoa(unescape(encodeURIComponent(body.body)));
          }
        } catch (e) {
          rec.bodyError = e.message;
        } finally {
          await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
        }
        list.set(`fetch-${params.requestId}`, rec);
      })();
    }
  });
}

function b64Chunks(b64, size) {
  const out = [];
  const step = size - (size % 4);
  for (let i = 0; i < b64.length; i += step) out.push(b64.slice(i, i + step));
  return out.length ? out : [""];
}
// Guarda bytes (base64) en la carpeta elegida o en Descargas/MundoFutFlow.
async function saveVoiceBytes(b64, mime, relPath, destMode) {
  if (destMode === "folder") {
    const jobId = `voz-${Date.now()}`;
    const parts = b64Chunks(b64, 4 * 1024 * 1024);
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      last = await offscreenCall({ type: "FS_CHUNK", jobId, index: i, last: i === parts.length - 1, relPath, mime, data: parts[i] });
      if (!last || !last.ok) throw new Error((last && last.error) || "el escritor de archivos no respondió");
    }
    return last.path || relPath;
  }
  await ownDownload(`data:${mime || "audio/mpeg"};base64,${b64}`, relPath);
  return `Descargas/MundoFutFlow/${relPath}`;
}

// Estado de la voz para el panel (Progreso): { status, msg, file, t, previews }.
const VOICE_KEY = "fbrVoice";
async function setVoiceState(patch) {
  const cur = (await chrome.storage.local.get(VOICE_KEY))[VOICE_KEY] || {};
  await chrome.storage.local.set({ [VOICE_KEY]: { ...cur, ...patch, t: Date.now() } });
}
let voiceRunning = false;
async function runVoice(v) {
  if (voiceRunning) { vlog("warn", "Ya se está generando una voz: no lanzo otra (cada previsualización cuenta)."); return; }
  voiceRunning = true;
  try {
    await setVoiceState({ status: "running", msg: "Preparando HeyGen…", file: null, batchFolder: v.batchFolder, startedAt: Date.now() });
    const r = await runVoiceInner(v);
    if (r.ok) {
      vlog("ok", `Voz guardada: ${r.file}`);
      await setVoiceState({ status: "done", msg: "Voz guardada", file: r.file });
      notify("Voz terminada ✅", `audio guardado: ${r.file}`, false);
    } else {
      vlog("error", `Voz: ${r.error}`);
      await setVoiceState({ status: "error", msg: r.error });
      notify("Voz: no se pudo guardar", String(r.error || "").slice(0, 200), true);
    }
  } finally {
    voiceRunning = false;
  }
}

async function runVoiceInner(v) {
  const tab = await findHeygenTab();
  if (!tab) return { ok: false, error: "no hay ninguna pestaña de HeyGen abierta. Abre tu proyecto de HeyGen (app.heygen.com/create-v4/…, panel de voz) y vuelve a lanzar." };
  const tabId = tab.id;
  if (tab.discarded || tab.status !== "complete") {
    // Chrome la había "dormido" (ahorro de memoria) o aún carga: se recarga y se espera.
    if (tab.discarded) await chrome.tabs.reload(tabId).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t && t.status === "complete" && !t.discarded) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  vlog("info", `Voz: uso la pestaña de HeyGen (${(tab.url || "").split("?")[0]}). Escribo la narración (${v.text.split(/\s+/).length} palabras).`);
  // Segundo plano, igual que Flow: pestaña capturada (Chrome la trata como
  // visible), foco simulado (depurador) y página "despierta" (page-hook).
  let armed = await isArmed(tabId);
  if (!armed) armed = (await armTab(tabId, true)).ok;
  if (!armed) vlog("warn", "La pestaña de HeyGen NO está preparada para segundo plano: si no la miras, puede que no reproduzca la voz. Entra en ella y pulsa la cereza (o Alt+Shift+C) una vez, como en Flow.");
  else vlog("info", "Pestaña de HeyGen preparada para segundo plano ✓ (funciona aunque mires otra pestaña).");
  await dbgEnsure(tabId).catch(() => {});
  await sendToHeygen(tabId, { type: "HG_AWAKE", on: true }).catch(() => {});

  // 1) ESCRIBIR (se puede repetir: no gasta nada).
  await setVoiceState({ msg: "Escribiendo la narración en el guion…" });
  let written = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !written; attempt++) {
    const w = await sendToHeygen(tabId, { type: "HG_WRITE", text: v.text }).catch((e) => ({ ok: false, error: e.message }));
    if (w && w.ok && w.state === "ok") written = w;
    else {
      lastErr = (w && w.error) || `el guion no quedó igual que la narración (${w && w.state}, ${w && w.chars} caracteres)`;
      vlog("warn", `Voz: escribir el guion, intento ${attempt}/3: ${lastErr}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!written) return { ok: false, error: `no pude dejar la narración bien escrita en el guion (${lastErr}). NO he pulsado reproducir: no se ha gastado ninguna previsualización.` };
  vlog("ok", "Narración escrita en el guion y comprobada.");

  // 2) Escuchar la red de la pestaña (lo mismo que DevTools → Network → Media).
  let list = null;
  const listen = async () => {
    await dbgEnsure(tabId);
    list = list || new Map();
    netMedia.set(tabId, list);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
    // Que el audio no salga de la caché: así la petición aparece seguro.
    await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", { patterns: [{ resourceType: "Media", requestStage: "Response" }] }).catch(() => {});
  };
  try {
    await listen();
  } catch (e) {
    vlog("warn", `No pude escuchar la red de HeyGen con el depurador (${e.message}); busco el audio en la propia página.`);
  }
  const cleanup = async () => {
    await sendToHeygen(tabId, { type: "HG_AWAKE", on: false }).catch(() => {});
    if (netMedia.has(tabId)) {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.disable", {}).catch(() => {});
      netMedia.delete(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    }
    const running = await getRunningTabs();
    if (!running[tabId]) await dbgDetach(tabId);
  };
  // Todas las peticiones media vistas desde `since` (para el log y para elegir).
  const seen = (since) => (list ? [...list.values()].filter((m) => m.t >= since - 500 && m.url) : []);
  const describe = (arr) => arr.map((m) => `${m.url.split("?")[0].split("/").pop() || m.url.slice(0, 40)}${/[?&]id=/.test(m.url) ? "?id=…" : ""} (${m.status || "?"}${m.mime ? ", " + m.mime : ""}${m.fromCache ? ", caché" : ""})`).join(" · ");
  // Espera la VOZ (nunca las animaciones appear/disappear_v1.webm).
  const waitVoice = async (since, maxS, label) => {
    for (let i = 0; i < maxS; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const best = pickVoiceMedia(seen(since));
      if (best) {
        // Si la vio el depurador de red, dar unos segundos a que llegue también la copia interceptada.
        for (let k = 0; k < 10 && !seen(since).some((m) => m.body && m.url === best.url); k++) await new Promise((res) => setTimeout(res, 500));
        return pickVoiceMedia(seen(since).filter((m) => m.url === best.url && m.body)) || best;
      }
      if (i % 3 === 2) {
        const hm = await sendToHeygen(tabId, { type: "HG_MEDIA", since }).catch(() => null);
        const it = pickVoiceMedia(((hm && hm.items) || []).map((x) => ({ url: x.url, mime: "" })));
        if (it) return { ...it, via: "página" };
      }
      if (i > 0 && i % 60 === 0) vlog("info", `${label}: sigo esperando el audio (${i / 60} min). Visto en la red hasta ahora: ${describe(seen(since)) || "nada"}.`);
    }
    return null;
  };
  // Lee los bytes COMPLETOS de la voz por todas las vías posibles.
  const readVoice = async (m) => {
    const tries = [];
    if (m.body) {
      const len = Math.floor((m.body.length * 3) / 4);
      if (contentRangeIsFull(m.contentRange, null) && len > 1000) return { b64: m.body, mime: m.mime, how: "copia interceptada" };
      tries.push(`copia interceptada parcial (${m.contentRange})`);
    }
    // Desde la propia página (con sus cookies), pidiendo el archivo entero.
    try {
      const expr = `(async () => { const r = await fetch(${JSON.stringify(m.url)}, { credentials: "include" }); const b = await r.blob(); const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(String(f.result).split(",")[1] || ""); f.readAsDataURL(b); }); return JSON.stringify({ s: r.status, t: b.type, n: b.size, d }); })()`;
      const ev = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      const o = JSON.parse((ev && ev.result && ev.result.value) || "{}");
      if (o.d && o.n > 1000 && o.s < 300) return { b64: o.d, mime: o.t || m.mime, how: "descargado desde la página" };
      tries.push(`página: HTTP ${o.s}, ${o.n} bytes`);
    } catch (e) { tries.push(`página: ${e.message}`); }
    const f = await sendToHeygen(tabId, { type: "HG_FETCH", url: m.url }).catch((e) => ({ ok: false, error: e.message }));
    if (f && f.ok && f.size > 1000) return { b64: f.data, mime: f.mime || m.mime, how: "descargado (extensión en la página)" };
    tries.push(`extensión en la página: ${(f && f.error) || "sin datos"}`);
    if (/^https:/.test(m.url)) return { url: m.url, how: "por URL", tries };
    return { error: tries.join("; ") };
  };
  const saveVoice = async (m) => {
    const got = await readVoice(m);
    const ext = audioExtFromMime(got.mime || m.mime, m.url);
    const relPath = `${v.batchFolder}/audio.${ext}`;
    if (ext !== "mp3") vlog("warn", `El audio de HeyGen es ${ext.toUpperCase()}, no MP3: lo guardo como audio.${ext} (sin convertirlo).`);
    if (got.b64) {
      vlog("info", `Audio leído (${got.how}, ${Math.round((got.b64.length * 3) / 4 / 1024)} KB).`);
      return saveVoiceBytes(got.b64, got.mime || "audio/mpeg", relPath, v.destMode);
    }
    if (got.url) {
      if (v.destMode === "folder") {
        const res = await offscreenCall({ type: "FS_SAVE_URL", url: got.url, relPath });
        if (!res || !res.ok) throw new Error(`no pude leer el audio (${[...(got.tries || []), `por URL: ${(res && res.error) || "sin respuesta"}`].join("; ")})`);
        return res.path || relPath;
      }
      await ownDownload(got.url, relPath);
      return `Descargas/MundoFutFlow/${relPath}`;
    }
    throw new Error(`no pude leer el audio (${got.error})`);
  };

  try {
    // 3) Pulsar reproducir UNA sola vez (gasta una previsualización).
    await setVoiceState({ msg: "Pulsando reproducir (1 previsualización)…" });
    const since = Date.now();
    const p = await sendToHeygen(tabId, { type: "HG_PLAY_ONCE", text: v.text }).catch((e) => ({ ok: false, error: e.message }));
    if (!p || !p.ok) return { ok: false, error: `${(p && p.error) || "la pestaña de HeyGen no respondió"}. No se ha gastado ninguna previsualización.` };
    // Se pulsa play UNA sola vez por lote (cada pulsación es una previsualización
    // de HeyGen); ya no hay tope diario propio (lo pidió el usuario, v2.9.6).
    vlog("info", `Botón de reproducir pulsado UNA vez (${p.real ? "clic real" : "clic normal"}). Espero el audio (id=…) sin volver a pulsar…`);
    await setVoiceState({ msg: "Generando la voz en HeyGen…" });

    // 4) Receta del usuario (29 sep 2026): dejarlo sonar ~10 s y volver a
    //    pulsar el MISMO botón para PARARLO; entonces la voz aparece en
    //    Network → Media ("id=…"). Parar no gasta previsualización; nunca se
    //    vuelve a pulsar play para generar otra vez, y no hace falta recargar.
    // Se deja sonar 10 s (con la red escuchando desde ANTES de pulsar play,
    // como DevTools abierto) y SIEMPRE se para con el mismo botón.
    let everPlayed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const pl = await sendToHeygen(tabId, { type: "HG_PLAYING" }).catch(() => null);
      if (pl && pl.playing > 0) everPlayed = true;
    }
    const stopAt = Date.now();
    const t = await sendToHeygen(tabId, { type: "HG_TOGGLE", everPlayed }).catch((e) => ({ ok: false, error: e.message }));
    if (!t || !t.ok) vlog("warn", `No pude pulsar para parar la reproducción (${(t && t.error) || "sin respuesta"}).`);
    else if (t.skipped) vlog("info", "A los 10 s la previsualización ya había terminado de sonar: no pulso (volvería a reproducirla).");
    else vlog(t.stillPlaying ? "warn" : "info", `10 s sonando → pulso el botón para PARAR (${(t.tries || []).join(" → ")}). ${t.after === -1 ? "No puedo comprobar si sonaba." : t.stillPlaying ? "¡Sigue sonando! No insisto más para no reproducir otra vez." : `Parado ✓ (sonaba: ${t.before === -1 ? "?" : t.before > 0 ? "sí" : "no"}).`}`);
    await setVoiceState({ msg: "Parada la reproducción: recogiendo el audio…" });
    // La voz aparece al PARAR: primero se busca lo que llega después de parar;
    // si no llega nada nuevo, lo visto mientras sonaba.
    let found = await waitVoice(stopAt, 60, "Tras parar la reproducción");
    if (!found) found = pickVoiceMedia(seen(since));
    if (!found) return { ok: false, error: `pulsé reproducir, esperé 10 s y la paré, pero no apareció el audio (id=…) en la red (vi: ${describe(seen(since)) || "nada"}). No vuelvo a pulsar para no gastar otra previsualización. Pásame el log.` };
    vlog("info", `Voz detectada (${found.via || "red"}): ${found.url.slice(0, 100)}${found.url.length > 100 ? "…" : ""} · ${found.status || "?"}${found.mime ? " · " + found.mime : ""}`);
    await setVoiceState({ msg: "Guardando el audio…" });

    // 5) Guardar (se puede reintentar: no gasta previsualizaciones).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return { ok: true, file: await saveVoice(found) };
      } catch (e) {
        lastErr = e.message;
        vlog("warn", `Voz: guardar el audio, intento ${attempt}/3: ${e.message}`);
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    return { ok: false, error: `el audio se generó pero no pude guardarlo: ${lastErr}` };
  } finally {
    await cleanup();
  }
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
      case "CLAIM": {
        // Evita que la MISMA cuenta corra en dos pestañas a la vez (p. ej. dos
        // pestañas /u/2/ que reanudan el mismo lote): generaría dos veces.
        const tabs = await getRunningTabs();
        for (const [id, acc] of Object.entries(tabs)) {
          if (acc !== msg.acc || Number(id) === tabId) continue;
          const alive = await chrome.tabs.get(Number(id)).then(() => true, () => false);
          if (alive) return { ok: false, error: `la cuenta ${acc} ya tiene un lote en marcha en otra pestaña` };
        }
        if (tabId != null) await setRunningTab(tabId, msg.acc, true);
        return { ok: true };
      }
      case "HEARTBEAT":
        if (tabId != null) await setRunningTab(tabId, msg.acc, !!msg.on);
        return { ok: true };
      case "RUN_COMPLETE":
        if (tabId != null) { await setRunningTab(tabId, msg.acc, false); await dbgDetach(tabId); }
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
        // El turno solo se libera cuando la pestaña dueña ha RECOGIDO el resultado
        // (si no, otra cuenta podía quitárselo justo al terminar y la primera lo
        // repetía → archivo duplicado "(1)", visto en la prueba e2e).
        const stale = job && Date.now() - job.armedAt > 10 * 60 * 1000;
        if (job && !stale && !job.collected && job.tabId !== tabId) {
          const alive = await chrome.tabs.get(job.tabId).then(() => true, () => false);
          if (alive) return { ok: false, busy: true };
        }
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
      case "DL_DIRECT": {
        // Plan B de descarga (v2.8): guardar directamente la fuente del vídeo
        // (<video src>) sin el menú de Flow. Usa el turno ya armado.
        if (!job || job.id !== msg.jobId) return { ok: false, error: "no hay turno de descarga activo" };
        const kind = urlKind(msg.url);
        job.urlKind = kind;
        job.createdAt = Date.now();
        jlog("info", `Descarga directa de la fuente del vídeo (URL tipo ${kind}).`);
        if (job.mode === "folder") {
          saveToFolder({ url: msg.url, mime: msg.mime || "video/mp4" }); // termina el trabajo él solo (done/failed)
          return { ok: true };
        }
        if (kind !== "https" && kind !== "data") return { ok: false, error: `con destino "Descargas de Chrome" no puedo guardar una URL ${kind}` };
        job.status = "created";
        job.downloadId = await ownDownload(msg.url, job.relPath);
        await saveJob();
        return { ok: true };
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
      case "ARM_TAB":
        return await armTab(msg.tabId);
      case "GET_ARMED": {
        const a = await getArmed();
        const out = {};
        for (const id of Object.keys(a)) if (await isArmed(Number(id))) out[id] = a[id];
        return { ok: true, armed: out };
      }
      case "CAPTURE_ENDED": {
        const a = await getArmed();
        const acc = a[msg.tabId];
        await setArmed(msg.tabId, null);
        if (acc) {
          blog("warn", `La pestaña de ${acc} ha dejado de estar preparada para segundo plano (se cerró o se paró el "compartir"). Si hay un lote en marcha, vuelve a pulsar la cereza en esa pestaña.`, { acc });
          const running = await getRunningTabs();
          if (running[msg.tabId]) notify(`Pestaña de ${acc} sin preparar`, "Vuelve a pulsar la cereza en esa pestaña de Flow para que siga trabajando sin mirarla.", true);
        }
        return { ok: true };
      }
      case "DBG_ON":
        try { await dbgEnsure(tabId); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      case "DBG_CLICK":
        try { await dbgClick(tabId, msg.x, msg.y); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      case "DBG_TYPE":
        try { await dbgCmd(tabId, "Input.insertText", { text: msg.text }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      case "DBG_SELECT_ALL_DELETE":
        try { await dbgSelectAllDelete(tabId); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      case "DBG_ENTER":
        try { await dbgEnter(tabId); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      case "OPEN_PANEL":
        return { ok: true, how: await openFloatingWindow() };
      case "SET_UI_MODE":
        await chrome.storage.local.set({ [UI_KEY]: msg.mode === "popup" ? "popup" : "sidepanel" });
        return { ok: true, mode: await applyUiMode() };
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
