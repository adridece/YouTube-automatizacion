/*
 * Cerezium Autopilot (antes "Flow Batch Runner") — content script (corre dentro de flow.google.com)
 * ---------------------------------------------------------------------------
 * Contexto completo: CLAUDE.md y docs/. Todo lo que se supone del DOM de Flow
 * está en docs/FLOW_DOM_FINDINGS.md ([V] verificado · [SUPUESTO] sin verificar).
 *
 * Modo "paired" (el principal), por cuenta:
 *   FASE 1  (Imágenes)  Una instrucción al Agent con todas las imágenes del
 *           rango; las renombra "001", "002"… Las que falten se reintentan
 *           pidiéndole al Agent que reformule. No se descargan.
 *   FASE 2A (Vídeo)     Una escena cada vez: "+" → su imagen → "Añadir a
 *           petición" → prompt (con "6 seconds") → generar → aviso de coste
 *           (≤ 10: "Aprobar" solo esa vez) → esperar al vídeo NUEVO.
 *   FASE 2B (Descarga)  Al terminar todas: una descarga cada vez, esperando a
 *           que Chrome la registre y la termine (background.js), con nombre
 *           <prefijo>_<NNN>.mp4 en una carpeta nueva por lote.
 *
 * Reglas (lecciones caras, ver docs/BUG_HISTORY.md):
 *  - Un fallo en una escena NUNCA para las demás. "Detener" sí se propaga.
 *  - Si el coste de un vídeo ya se APROBÓ, nunca se vuelve a generar solo
 *    (se marca "revisar"): repetirlo podría cobrar dos veces.
 *  - Todo queda en el log persistente (hora, cuenta, escena, fase).
 *  - Las esperas no dependen solo de temporizadores (Chrome los frena en
 *    pestañas ocultas): también despiertan con cambios del DOM y con el
 *    latido que manda background.js.
 */

// Evita doble carga si background.js reinyecta el script en una pestaña.
if (window.__fbrContentLoaded) {
  console.log("[FBR] content script ya cargado en esta pestaña");
} else {
window.__fbrContentLoaded = true;

const CONFIG = {
  // [V] Selectores cortos y semánticos (las rutas largas se rompen al adjuntar).
  agentPanelSelector: "flow-agent-panel",
  promptBoxSelector: 'flow-agent-panel flow-rich-text-editor [contenteditable="true"]',
  generateButtonSelector: "flow-agent-panel flow-generate-icon-button",
  pendingTileTag: "flow-pending-tile",
  imageTileTag: "flow-image-tile",
  videoTileTag: "flow-video-tile",
  tileTitleSelector: ".footer-title",
  overlayContainerSelector: ".cdk-overlay-container",
  menuItemSelector: "flow-menu-item, [role='menuitem']",
  menuItemText: { animate: "animar", download: "descargar" },
  addMenuButtonSelector: "flow-agent-panel flow-add-menu button",
  addMenuOpenSelector: ".cdk-overlay-container flow-add-menu-popover-content",
  assetListItemsSelector: ".cdk-overlay-container flow-add-menu-asset-item",
  assetViewportSelector: ".cdk-overlay-container cdk-virtual-scroll-viewport",
  detailPaneSelector: ".cdk-overlay-container flow-add-menu-detail-pane",
  addToPromptButtonSelector: ".cdk-overlay-container flow-add-menu-detail-pane div.bottom-actions button",

  // Coste: "Aprobar" (exacto), NUNCA "Aprobar siempre".
  costDialogApproveText: "aprobar",
  costDialogRejectText: "rechazar",
  maxAllowedPointsPerVideo: 10,
  maxAllowedPointsImages: 25, // las imágenes no piden confirmación; red de seguridad
  videoSeconds: 6,

  // Esperas (ms)
  startWaitMs: 25000, // a que aparezca el aviso de coste o un tile pendiente
  sentWaitMs: 8 * 60000, // si el mensaje ya se envió/aprobó: la IA piensa o hay cola
  imagesSettleMs: 40000, // el Agent renombra DESPUÉS de terminar (a veces tarda)
  assetListWaitMs: 10000,
  agentSilentMs: 100000,
  agentReplyIdleMs: 180000, // el Agent contestó y lleva 3 min sin hacer nada → se reintenta
  rateLimitMaxRetries: 4,
  minGapBetweenVideosMs: 20000, // margen mínimo entre un vídeo terminado/fallido y el siguiente envío
  videoExtraRounds: 5, // vueltas extra al final para los vídeos que fallaron sin cobrar
  download: { createdTimeoutMs: 90000, completeTimeoutMs: 300000, attempts: 3 },
  maxAttemptsPerScene: 6, // por defecto; se cambia en el panel (Opciones avanzadas)
};

const ACC = getFlowAccountKey(location.href);
const BATCH_KEY = `batch_${ACC}`;

let stopRequested = false;
let running = false;
let extAlive = true;
let batch = null; // estado persistente (createBatchState en shared.js)
let ctxScene = null;
let ctxPhase = null;
const videoElByScene = new Map(); // escena -> <flow-video-tile> (solo esta sesión)

class StopError extends Error { constructor() { super("stopped"); this.name = "StopError"; } }
class NoPointsError extends Error { constructor(m) { super(m); this.name = "NoPointsError"; } }
class CostError extends Error { constructor(m) { super(m); this.name = "CostError"; } }
class TimeoutError extends Error { constructor(m) { super(m); this.name = "TimeoutError"; } }
// Fallo técnico que suele arreglarse recargando Flow: se guarda el lote, se
// hace F5 y la propia pestaña lo reanuda sola (máx. 2 veces por lote).
class ReloadError extends Error { constructor(m) { super(m); this.name = "ReloadError"; } }

// =================================================================== ENVÍO
function send(msg) {
  if (!extAlive) return Promise.resolve(null);
  try {
    return chrome.runtime.sendMessage(msg).catch((e) => { onSendError(e); return null; });
  } catch (e) {
    onSendError(e);
    return Promise.resolve(null);
  }
}
function onSendError(e) {
  if (/context invalidated/i.test(String(e && e.message))) {
    extAlive = false;
    stopRequested = true;
    ui.fatal("La extensión se ha recargado o actualizado. Pulsa F5 en esta pestaña para seguir (el progreso está guardado y se reanudará).");
  }
}
async function storageSet(obj) {
  try { await chrome.storage.local.set(obj); } catch (e) { onSendError(e); }
}

// ===================================================================== LOG
const localLog = [];
function log(level, msg, o) {
  const x = o || {};
  const e = {
    t: Date.now(),
    acc: ACC,
    scene: x.scene !== undefined ? x.scene : ctxScene,
    phase: x.phase || ctxPhase || "run",
    level,
    msg,
  };
  (level === "error" ? console.warn : console.log)("[FBR]", formatLogEntry(e));
  localLog.push(e);
  if (localLog.length > 300) localLog.shift();
  ui.onLog(e);
  send({ type: "LOG", entry: e });
  return e;
}
function saveBatch() {
  if (!batch) return Promise.resolve();
  batch.updatedAt = Date.now();
  ui.setBatch(batch);
  return storageSet({ [BATCH_KEY]: batch });
}
function setStep(n, step, status, extra) {
  setSceneStep(batch, n, step, status, extra);
  return saveBatch();
}

// ============================================================ ESPERAS
// Cada espera se re-evalúa: (1) con su propio temporizador, (2) cuando cambia
// el DOM de Flow (MutationObserver), (3) con el "TICK" de background.js cada
// 2 s. Así no se queda congelada si Chrome frena los temporizadores de la
// pestaña en segundo plano.
const waiters = new Set();
function wakeAll() { for (const w of Array.from(waiters)) w(); }
let lastMutationWake = 0;
new MutationObserver(() => {
  const n = Date.now();
  if (n - lastMutationWake > 250) { lastMutationWake = n; wakeAll(); }
}).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "aria-disabled", "disabled"] });
setInterval(() => { wakeAll(); if (running) document.dispatchEvent(new CustomEvent("fbr-tick")); }, 1000);

// Modo "despierto" de page-hook.js (solo mientras hay un lote en marcha).
function setBackgroundMode(on) { document.dispatchEvent(new CustomEvent(on ? "fbr-bg-on" : "fbr-bg-off")); }

function waitFor(cond, timeoutMs, desc, opts) {
  const stoppable = !(opts && opts.stoppable === false);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timer = null;
    const done = () => { waiters.delete(check); clearTimeout(timer); };
    function check() {
      if (stoppable && stopRequested) { done(); reject(new StopError()); return; }
      let r = null;
      try { r = cond(); } catch (e) { r = null; }
      if (r) { done(); resolve(r); return; }
      if (Date.now() - start >= timeoutMs) { done(); reject(new TimeoutError(`Tiempo agotado esperando ${desc} (${Math.round(timeoutMs / 1000)} s)`)); }
    }
    waiters.add(check);
    timer = setTimeout(check, Math.min(timeoutMs + 20, 2147483000));
    check();
  });
}
function sleep(ms) {
  const end = Date.now() + ms;
  setTimeout(wakeAll, ms);
  return waitFor(() => Date.now() >= end, ms + 60000, "pausa", { stoppable: false }).catch(() => {});
}
function throwIfStopped() { if (stopRequested) throw new StopError(); }
// Devuelve el resultado de la espera, o null si se agotó el tiempo. "Detener" sí se propaga.
async function tryWait(cond, timeoutMs, desc) {
  try { return await waitFor(cond, timeoutMs, desc); } catch (e) { if (e instanceof StopError) throw e; return null; }
}

// ======================================================== DOM: utilidades
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

// [V] flow-generate-icon-button envuelve un <button type="submit">; solo su
// .click() NATIVO envía el formulario (eventos sintéticos no funcionan).
function clickDeep(el) {
  const target = el.tagName === "BUTTON" ? el : el.querySelector("button") || el.closest("button") || el;
  target.click();
}
function isDisabledBtn(el) {
  const b = el.tagName === "BUTTON" ? el : el.querySelector("button");
  return !!(b && (b.disabled || b.getAttribute("aria-disabled") === "true"));
}
function getPromptBox() { return $(CONFIG.promptBoxSelector); }
function promptText() { const b = getPromptBox(); return b ? b.textContent.trim() : ""; }
function agentPanelText() { const p = $(CONFIG.agentPanelSelector); return p ? p.textContent : ""; }

// [V] execCommand es lo que funciona en el editor ProseMirror de Flow.
function setEditableValue(el, text) {
  const editable = el.closest('[contenteditable="true"]') || el;
  editable.focus();
  document.execCommand("selectAll", false, null);
  if (text) document.execCommand("insertText", false, text);
  else document.execCommand("delete", false, null);
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}
// Dos formas de escribir en el editor (ProseMirror) de Flow:
//  - "exec": execCommand insertText ([V] funciona con la pestaña a la vista);
//  - "paste": un evento "pegar" con el texto, que ProseMirror mete en SU modelo
//    por su propio camino (por si sin foco el texto se ve pero Flow no lo "tiene").
// Si con un método Flow no acepta el envío, se prueba el otro (sendWithRateLimit).
let writeMethod = "exec";
const WRITE_METHODS = ["exec", "paste", "typeReal"];
// Clic REAL (depurador de Chrome, en coordenadas de la página) sobre el centro de un elemento.
async function realClick(el) {
  const target = el.tagName === "BUTTON" ? el : el.querySelector("button") || el;
  target.scrollIntoView({ block: "nearest" });
  const r = target.getBoundingClientRect();
  if (!r.width || !r.height) throw new Error("el elemento no tiene tamaño visible");
  const res = await send({ type: "DBG_CLICK", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  if (!res || !res.ok) throw new Error((res && res.error) || "el depurador no respondió");
}
async function typeReal(el, text) {
  const editable = el.closest('[contenteditable="true"]') || el;
  editable.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  const res = await send({ type: "DBG_TYPE", text });
  if (!res || !res.ok) throw new Error((res && res.error) || "el depurador no respondió");
}
function insertViaPaste(el, text) {
  const editable = el.closest('[contenteditable="true"]') || el;
  editable.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}
async function writePrompt(text) {
  const box = getPromptBox();
  if (!box) throw new Error('no encuentro la caja de prompt (selector: flow-agent-panel flow-rich-text-editor [contenteditable="true"])');
  const head = text.replace(/\s+/g, " ").slice(0, 25);
  const landed = () => tryWait(() => promptText().replace(/\s+/g, " ").includes(head), 4000, "que el texto aparezca en la caja");
  const methods = [writeMethod, ...WRITE_METHODS.filter((m) => m !== writeMethod)];
  for (const m of methods) {
    try {
      if (m === "paste") insertViaPaste(box, text);
      else if (m === "typeReal") await typeReal(box, text);
      else setEditableValue(box, text);
    } catch (e) {
      continue;
    }
    if (await landed()) {
      if (m !== writeMethod) { log("info", `Escribo en la caja con el método "${m}" (el otro no dejó el texto).`); writeMethod = m; }
      return;
    }
  }
  throw new Error("escribí el prompt pero no aparece en la caja de Flow");
}

// Busca en el menú flotante MÁS RECIENTE primero: con la pestaña en segundo
// plano, un menú viejo puede tardar en retirarse (sus animaciones no avanzan)
// y no queremos pulsar una opción suya.
function findMenuItemByText(text) {
  const overlay = $(CONFIG.overlayContainerSelector);
  if (!overlay) return null;
  const wanted = text.toLowerCase();
  const panes = $$(".cdk-overlay-pane", overlay);
  const scopes = panes.length ? panes.reverse().concat([overlay]) : [overlay];
  for (const scope of scopes) {
    const hit = $$(CONFIG.menuItemSelector, scope).find((el) => (el.textContent || "").trim().toLowerCase().includes(wanted));
    if (hit) return hit;
  }
  return null;
}
function pressEscape() {
  const opts = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true };
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", opts));
  document.dispatchEvent(new KeyboardEvent("keydown", opts));
}
async function closeOverlays() {
  for (let i = 0; i < 3; i++) {
    const open = $(CONFIG.addMenuOpenSelector) || $$(CONFIG.menuItemSelector, $(CONFIG.overlayContainerSelector) || document.createElement("div")).length;
    if (!open) return;
    pressEscape();
    await sleep(300);
  }
}
function rightClickElement(el) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, view: window, button: 2,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
}
function visibilityNote() {
  return document.visibilityState === "visible" ? "" : " (la pestaña estaba en segundo plano; si este fallo se repite, pásame el log: puede que Flow no pinte esa parte sin estar a la vista)";
}

// ============================================================== TILES
function normalizeUrlKey(u) {
  if (!u) return null;
  if (/^https?:/.test(u)) return u.split("?")[0];
  return u;
}
// Clave estable de un tile para reconocerlo después (sin depender de su
// posición en la cuadrícula, que NO es cronológica). [SUPUESTO] qué atributos
// trae: lo muestra tools/flow-diagnostic.js.
function tileKey(tile) {
  for (const a of ["data-id", "data-media-id", "data-asset-id", "data-key", "data-uuid", "id"]) {
    const v = tile.getAttribute(a);
    if (v) return `${a}:${v}`;
  }
  // v2.8: Flow puede SUSTITUIR los tiles (nodos nuevos) al terminar otra
  // generación; la clave tiene que salir del CONTENIDO para seguir valiendo.
  const idEl = tile.querySelector("[data-id],[data-media-id],[data-asset-id],[data-key],[data-uuid]");
  if (idEl) for (const a of ["data-id", "data-media-id", "data-asset-id", "data-key", "data-uuid"]) { const v = idEl.getAttribute(a); if (v) return `in-${a}:${v}`; }
  const v = tile.querySelector("video");
  const vs = v && (v.getAttribute("src") || (v.querySelector("source") || { getAttribute: () => null }).getAttribute("src") || v.getAttribute("poster"));
  if (vs && !vs.startsWith("blob:")) return `src:${normalizeUrlKey(vs)}`;
  const img = tile.querySelector("img[src]");
  if (img && !img.getAttribute("src").startsWith("blob:")) return `img:${normalizeUrlKey(img.getAttribute("src"))}`;
  const a = tile.querySelector("a[href]");
  if (a) return `a:${a.getAttribute("href")}`;
  const bg = [tile, ...$$("*", tile)].map((e) => (e.getAttribute("style") || "").match(/url\(["']?([^"')]+)/)).find(Boolean);
  if (bg && !bg[1].startsWith("blob:")) return `bg:${normalizeUrlKey(bg[1])}`;
  if (vs) return `src:${vs}`; // blob: vale mientras el tile no se sustituya
  if (!tile.__fbrSeq) tile.__fbrSeq = `seq:${Math.random().toString(36).slice(2, 10)}`;
  return tile.__fbrSeq;
}
// ¿Las claves son fiables (salen del contenido) o provisionales (seq/blob)?
function keyIsStable(k) { return !!k && !/^seq:|^src:blob:/.test(k); }
function tileTitle(tile) {
  const t = tile.querySelector(CONFIG.tileTitleSelector);
  return t ? t.textContent.trim() : "";
}
function snapshotTiles() {
  const videos = $$(CONFIG.videoTileTag);
  const images = $$(CONFIG.imageTileTag);
  return {
    pending: $$(CONFIG.pendingTileTag).length,
    videoNodes: new Set(videos),
    videoKeys: videos.map(tileKey),
    imageKeys: images.map(tileKey),
    imageCount: images.length,
    counts: videoCounts(),
  };
}
function newVideoTiles(before) {
  return $$(CONFIG.videoTileTag).filter((t) => !before.videoNodes.has(t) && !before.videoKeys.includes(tileKey(t)));
}
function tileReady(t) { return !tileLooksInProgress(t.textContent); }
// terminado DE VERDAD: sin progreso y con miniatura/vídeo (un tile sin miniatura no es un vídeo)
function tileDone(t) { return tileReady(t) && tileHasMedia(t); }
function videoTilesByTitle(name) { return $$(CONFIG.videoTileTag).filter((t) => tileTitle(t) === name); }

function imageTilesByLabel(label) {
  return $$(CONFIG.imageTileTag).filter((t) => imageTitleMatches(tileTitle(t), label));
}
function findImageTileByLabel(label) { return imageTilesByLabel(label)[0] || null; }

// La cuadrícula puede no tener en el DOM los tiles fuera de pantalla: si no
// aparece, se recorre su contenedor con scroll y se deja como estaba.
function scrollParentOf(el) {
  for (let p = el && el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 10) return p;
  }
  return document.scrollingElement;
}
async function findWithScroll(find, sampleSelector) {
  let found = find();
  if (found) return found;
  const sample = $(sampleSelector);
  if (!sample) return null;
  const sc = scrollParentOf(sample);
  if (!sc) return null;
  const orig = sc.scrollTop;
  sc.scrollTop = 0;
  await sleep(400);
  for (let i = 0; i < 60 && !(found = find()); i++) {
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
    sc.scrollTop += Math.max(200, sc.clientHeight * 0.8);
    await sleep(400);
  }
  if (!found) sc.scrollTop = orig;
  return found;
}

// ======================================================= AVISO DE COSTE
// [V] <flow-permission-message> con filas div.option-row[role=radio][aria-label].
// Los ya contestados llevan .read-only / aria-disabled="true".
const optionLabel = (r) => (r.getAttribute("aria-label") || r.textContent || "").replace(/\s+/g, " ").trim();
const unknownDialogsLogged = new WeakSet();
function findPendingCostDialog() {
  const msgs = $$("flow-permission-message");
  for (let i = msgs.length - 1; i >= 0; i--) {
    const rows = $$(".option-row:not(.read-only):not([aria-disabled='true']), [role=radio]:not(.read-only):not([aria-disabled='true']), button:not([disabled])", msgs[i])
      .filter((r, k, all) => !all.some((o) => o !== r && o.contains(r) && classifyCostOption(optionLabel(o)))); // sin duplicados anidados
    if (!rows.length) continue;
    const approveRow = rows.find((r) => classifyCostOption(optionLabel(r)) === "approve");
    if (!approveRow) {
      // Nunca en silencio: se apunta qué opciones trae el aviso para poder arreglarlo.
      if (!unknownDialogsLogged.has(msgs[i])) {
        unknownDialogsLogged.add(msgs[i]);
        log("error", `Hay un aviso de Flow pendiente pero no reconozco la opción de aprobar. Texto: «${msgs[i].textContent.replace(/\s+/g, " ").trim().slice(0, 160)}» · opciones: ${rows.map((r) => `«${optionLabel(r).slice(0, 40)}»`).join(", ")}. Pásame esta línea.`);
      }
      continue;
    }
    const rejectRow = rows.find((r) => classifyCostOption(optionLabel(r)) === "reject") || null;
    return { message: msgs[i], approveRow, rejectRow, cost: parseCostFromText(msgs[i].textContent) };
  }
  return null;
}
// Rechaza avisos de coste que no corresponden a la petición en curso (p. ej.
// una petición duplicada que Flow muestra tarde). Nunca se aprueban.
const handledStray = new WeakSet();
function rejectStrayCostDialogs(when) {
  let dlg;
  while ((dlg = findPendingCostDialog()) && !handledStray.has(dlg.message)) {
    handledStray.add(dlg.message);
    if (dlg.rejectRow) dlg.rejectRow.click();
    log("warn", `Había un aviso de coste que no es de esta petición (${dlg.cost} puntos, ${when}): lo he RECHAZADO para no pagar de más.`);
  }
}

// Segundo intento si el clic no hizo efecto: teclado sobre el radio y clic
// en su primer hijo. [SUPUESTO] que haga falta; se registra en el log.
function pressRow(row) {
  row.focus && row.focus();
  for (const key of [" ", "Enter"]) {
    row.dispatchEvent(new KeyboardEvent("keydown", { key, code: key === " " ? "Space" : "Enter", bubbles: true, cancelable: true }));
    row.dispatchEvent(new KeyboardEvent("keyup", { key, code: key === " " ? "Space" : "Enter", bubbles: true, cancelable: true }));
  }
  const child = row.firstElementChild;
  if (child) child.click();
}

// ===================================================== ENVIAR Y CONFIRMAR
// Pulsa generar y espera a saber qué ha pasado. Devuelve { type, approved,
// cost, before, textBefore } con type:
//   started          empezó a generar (tile pendiente o resultado nuevo)
//   cost             pedía más puntos del límite o ilegible → rechazado
//   rateLimit        "Estás preguntando demasiado rápido"
//   noPoints         [SUPUESTO] sin puntos
//   policy/genError  Flow dice que no pudo (no se cobra)
//   cancelled        el Agent canceló
//   approvedNoStart  se aprobó el coste pero no apareció nada a tiempo
//   noStart / error  no se llegó a enviar
// Formas de enviar el mensaje, en orden. La que funcione pasa a ser la primera.
let sendOrder = ["clic", "clicReal", "EnterReal", "requestSubmit", "Enter"];
async function submitVia(via, genBtn) {
  const b = genBtn.tagName === "BUTTON" ? genBtn : genBtn.querySelector("button");
  if (via === "clic") return clickDeep(genBtn);
  if (via === "clicReal") return realClick(genBtn);
  if (via === "EnterReal") {
    const box = getPromptBox();
    if (!box) throw new Error("no hay caja");
    box.focus();
    const res = await send({ type: "DBG_ENTER" });
    if (!res || !res.ok) throw new Error((res && res.error) || "el depurador no respondió");
    return;
  }
  if (via === "requestSubmit") {
    const f = b && (b.form || b.closest("form"));
    if (!f || !f.requestSubmit) throw new Error("no hay formulario");
    return f.requestSubmit(b && b.type === "submit" ? b : undefined);
  }
  const box = getPromptBox();
  if (!box) throw new Error("no hay caja");
  box.focus();
  for (const t of ["keydown", "keypress", "keyup"]) box.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
}
function countIn(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}
function sendDiag(genBtn) {
  return ` [foco: ${document.hasFocus() ? "sí" : "no"} · pestaña: ${document.visibilityState} · botón: ${genBtn && isDisabledBtn(genBtn) ? "deshabilitado" : "habilitado"} · escritura: ${writeMethod}]`;
}

async function sendAndConfirm({ maxPoints, onApproved, dryRun, onlySend }) {
  // Prueba real v2.10 (cuenta 2, justo tras las imágenes): el Agent seguía
  // trabajando y el botón de generar no estaba. Se espera a que vuelva.
  // notSent: nada salió, la imagen adjunta sigue en la caja (no re-adjuntarla).
  let genBtn = $(CONFIG.generateButtonSelector);
  if (!genBtn) {
    log("info", "El botón de generar no está (el Agent aún está trabajando): espero a que vuelva, hasta 2 min…");
    genBtn = await tryWait(() => $(CONFIG.generateButtonSelector), 120000, "el botón de generar");
    if (!genBtn) return { type: "error", notSent: true, error: "no encuentro el botón de generar (flow-agent-panel flow-generate-icon-button) tras esperar 2 min" };
  }
  if (isDisabledBtn(genBtn)) {
    const ok = await tryWait(() => !isDisabledBtn(genBtn), 60000, "a que se habilite el botón de generar");
    if (!ok) return { type: "error", notSent: true, error: "el botón de generar sigue deshabilitado tras 60 s (¿Flow sigue ocupado?)" };
  }
  // Un aviso de coste que YA estaba pendiente antes de enviar no es de esta
  // petición (duplicado o viejo): se rechaza para no aprobarlo por error.
  rejectStrayCostDialogs("antes de enviar");
  const textBefore = agentPanelText();
  const before = snapshotTiles();
  const st = { approved: false, approvedMsg: null, approveAt: 0, approveClicks: 0, answeredLogged: false, cost: null, dupRejected: 0 };

  const cond = () => {
    const sig = detectNewSignals(textBefore, agentPanelText());
    if (sig.noPoints) return { type: "noPoints" };
    if (sig.rateLimit) return { type: "rateLimit" };
    const dlg = findPendingCostDialog();
    if (dlg) {
      if (!st.approved) {
        st.cost = dlg.cost;
        if (dryRun) {
          if (dlg.rejectRow) dlg.rejectRow.click();
          return { type: "dryRun", cost: dlg.cost };
        }
        if (dlg.cost === null || dlg.cost > maxPoints) {
          if (dlg.rejectRow) dlg.rejectRow.click();
          return { type: "cost", cost: dlg.cost };
        }
        dlg.approveRow.click();
        st.approved = true;
        st.approvedMsg = dlg.message;
        st.approveAt = Date.now();
        st.approveClicks = 1;
        log("info", `Aviso de coste: ${dlg.cost} puntos (límite ${maxPoints}). He pulsado "Aprobar" (solo esta vez).`);
        if (onApproved) onApproved(dlg.cost);
      } else if (dlg.message !== st.approvedMsg) {
        // Un SEGUNDO aviso de coste después de aprobar el primero = petición
        // duplicada: se rechaza para no pagar dos veces.
        if (dlg.rejectRow) dlg.rejectRow.click();
        st.dupRejected++;
        log("warn", `Apareció un segundo aviso de coste (${dlg.cost} puntos) después de aprobar el primero: lo he RECHAZADO para no pagar dos veces.`);
      } else if (Date.now() - st.approveAt > 6000 && st.approveClicks < 3) {
        st.approveClicks++;
        st.approveAt = Date.now();
        log("warn", `El aviso de coste sigue SIN contestar tras pulsar "Aprobar". Lo pulso otra vez de otra forma (intento ${st.approveClicks}/3).`);
        if (st.approveClicks === 2) pressRow(dlg.approveRow);
        else realClick(dlg.approveRow).catch(() => pressRow(dlg.approveRow));
      }
    } else if (st.approved && !st.answeredLogged) {
      st.answeredLogged = true;
      log("ok", "Flow ha registrado la aprobación (el aviso ya no está pendiente).");
    }
    if (sig.policy) return { type: "policy" };
    if (sig.genError) return { type: "genError" };
    if (sig.cancelled && !st.approved) return { type: "cancelled" };
    const now = snapshotTiles();
    // Sin aprobación, un vídeo nuevo TERMINADO no cuenta como "empezó": puede
    // ser uno de una escena anterior que acaba tarde (se exige un tile nuevo
    // "generándose"). Así no se confunde con «Confirmar antes de generar = Nunca».
    if (now.pending > before.pending || (st.approved && newVideoTiles(before).length) || now.imageCount > before.imageCount) return { type: "started" };
    return null;
  };

  // ¿Se envió? La caja se vacía, o el texto aparece como mensaje en el chat,
  // o ya hay aviso de coste / algo generándose. Así nunca se reenvía un
  // mensaje que sí salió (duplicaría la generación y los puntos).
  const norm = (x) => x.replace(/\s+/g, " ");
  const boxText = norm(promptText());
  const head = boxText.slice(0, 30);
  const tail = boxText.length > 60 ? boxText.slice(-30) : "";
  const headCount0 = countIn(norm(agentPanelText()), head);
  const tailCount0 = countIn(norm(agentPanelText()), tail);
  const wasSent = () => {
    if (promptText().length === 0) return true;
    const all = norm(agentPanelText());
    return countIn(all, head) > headCount0 || (tail && countIn(all, tail) > tailCount0);
  };
  let res = null;
  let sentVia = null;
  const order = sendOrder.slice();
  for (let i = 0; i < order.length; i++) {
    const via = order[i];
    try { await submitVia(via, genBtn); } catch (e) { log("info", `No pude enviar con "${via}": ${e.message}`); continue; }
    if (i === 0) log("info", via === "clic" ? 'He pulsado "generar".' : `He enviado el mensaje (con "${via}").`);
    else log("info", `El mensaje no salió; pruebo a enviarlo con "${via}".`);
    const r = await tryWait(() => cond() || (wasSent() ? { type: "__sent" } : null), 12000, "que el mensaje salga");
    if (r) {
      sentVia = via;
      if (r.type !== "__sent") res = r;
      if (via !== sendOrder[0]) {
        log("ok", `Flow aceptó el envío con "${via}": lo usaré primero a partir de ahora.`);
        sendOrder = [via, ...sendOrder.filter((x) => x !== via)];
      }
      break;
    }
  }
  if (!sentVia && !st.approved) {
    return { type: "noStart", notSent: true, error: `Flow no aceptó el envío (probé ${order.join(", ")})${sendDiag(genBtn)}`, approved: false, cost: st.cost, before, textBefore };
  }
  if (onlySend) return { type: "sent", via: sentVia, approved: st.approved, cost: st.cost, before, textBefore };
  if (!res) res = await tryWait(cond, CONFIG.startWaitMs, "que Flow empiece a generar");
  if (!res) {
    log("info", `${st.approved ? "Coste aprobado" : "Mensaje enviado"}; la IA está pensando o hay cola. Espero hasta ${Math.round(CONFIG.sentWaitMs / 60000)} min SIN volver a enviarlo.`);
    // Si el Agent CONTESTA algo (una pregunta, una duda…) y luego no hace nada
    // durante 3 min, no se espera los 8 min enteros: se apunta lo que dijo y
    // se reintenta (gratis: no ha generado nada).
    const baseLen = norm(textBefore).length;
    let lastLen = -1;
    let stableSince = Date.now();
    const condLong = () => {
      const r = cond();
      if (r || st.approved) return r;
      const now = norm(agentPanelText());
      if (now.length !== lastLen) { lastLen = now.length; stableSince = Date.now(); return null; }
      // (el texto del prompt pasa de la caja al chat: se compensa; lo que crece es la respuesta)
      if (now.length - baseLen > 60 && Date.now() - stableSince > CONFIG.agentReplyIdleMs) {
        const at = tail ? now.lastIndexOf(tail) : -1;
        const reply = (at >= 0 ? now.slice(at + tail.length) : now.slice(-220)).trim().slice(0, 300);
        return { type: "agentReplied", error: `el Agent contestó sin generar nada: «${reply}»` };
      }
      // v2.11 (visto en vivo, 30 sep): el Agent puede contestar VACÍO (sin aviso de coste, sin texto,
      // sin error). No se esperan 8 min: si lleva 100 s sin cambiar nada y sin trabajar, se reintenta.
      if (now.length - baseLen <= 60 && Date.now() - stableSince > CONFIG.agentSilentMs && !agentBusyNow()) {
        return { type: "agentReplied", error: "el Agent no contestó nada (ni aviso de coste ni error) en 100 s" };
      }
      return null;
    };
    res = await tryWait(condLong, CONFIG.sentWaitMs, "que Flow empiece a generar (mensaje ya enviado)");
    if (!res) res = { type: st.approved ? "approvedNoStart" : "noStart", error: "Flow no empezó a generar nada a tiempo" };
  }
  return { ...res, approved: st.approved, cost: st.cost, before, textBefore };
}

// Envía reintentando si Flow dice "Estás preguntando demasiado rápido" (no
// cuenta como fallo). `prepare` vuelve a dejar la caja lista (texto/imagen).
async function sendWithRateLimit(prepare, opts) {
  let switchedWrite = 0;
  let rewriteOnly = false;
  for (let n = 0; ; n++) {
    throwIfStopped();
    await prepare(n, { rewriteOnly });
    rewriteOnly = false;
    const res = await sendAndConfirm(opts);
    if (res.type === "noStart" && res.notSent && switchedWrite < WRITE_METHODS.length - 1) {
      // El texto está en la caja pero Flow no lo envía: se reescribe con el
      // siguiente método de escritura y se vuelve a intentar.
      switchedWrite++;
      writeMethod = WRITE_METHODS[(WRITE_METHODS.indexOf(writeMethod) + 1) % WRITE_METHODS.length];
      log("warn", `Flow no aceptó el envío${sendDiag($(CONFIG.generateButtonSelector))}. Reescribo el texto con el método "${writeMethod}" y lo intento otra vez.`);
      n--;
      rewriteOnly = true; // la imagen adjunta sigue en la caja: NO volver a adjuntarla
      continue;
    }
    if (res.type === "noPoints") throw new NoPointsError("Flow indica que no quedan puntos/créditos en esta cuenta");
    if (res.type !== "rateLimit") return res;
    if (res.approved) return { ...res, type: "approvedNoStart", error: 'Flow dijo "demasiado rápido" después de aprobar el coste' };
    if (n + 1 > CONFIG.rateLimitMaxRetries) return { ...res, type: "error", error: `Flow sigue diciendo "Estás preguntando demasiado rápido" tras ${CONFIG.rateLimitMaxRetries} esperas` };
    const ms = backoffDelayMs(n + 1);
    log("warn", `Flow dice "Estás preguntando demasiado rápido". Espero ${Math.round(ms / 1000)} s y lo vuelvo a enviar (espera ${n + 1}/${CONFIG.rateLimitMaxRetries}; no cuenta como fallo).`);
    ui.setStatus(`Esperando ${Math.round(ms / 1000)} s por límite de ritmo de Flow…`, "warn");
    await sleep(ms);
    throwIfStopped();
  }
}

// ========================================================== FASE 1: IMÁGENES
async function phaseImages(cfg, isResume) {
  ctxPhase = "images";
  ctxScene = null;
  batch.phase = "images";
  const imagesMap = new Map(Object.entries(cfg.images || {}).map(([k, v]) => [parseInt(k, 10), v]));
  let todo = batch.order.filter((n) => batch.scenes[n].image !== "done");
  if (!todo.length) { log("info", "Las imágenes ya estaban hechas: paso a los vídeos."); return; }

  for (const n of todo.filter((n) => !imagesMap.has(n))) {
    await setStep(n, "image", "failed", { error: "el kit no trae prompt de imagen para esta escena" });
    log("error", "No hay prompt de imagen para esta escena en el kit: no se puede generar.", { scene: n });
  }
  todo = todo.filter((n) => imagesMap.has(n));
  if (!todo.length) return;

  // Imágenes que ya existen con ese nombre (reanudación o proyecto reutilizado).
  const countBefore = new Map(todo.map((n) => [n, imageTilesByLabel(pad3(n)).length]));
  if (isResume) {
    for (const n of todo) if (countBefore.get(n) > 0) await setStep(n, "image", "done");
    todo = todo.filter((n) => countBefore.get(n) === 0);
    if (!todo.length) { log("info", "Reanudación: todas las imágenes ya existen en el proyecto."); return; }
  } else {
    const dup = todo.filter((n) => countBefore.get(n) > 0);
    if (dup.length) log("warn", `Este proyecto YA tiene imágenes llamadas ${dup.map(pad3).join(", ")}. Se generarán otras con el mismo nombre y usaré la más reciente. Para evitar líos, usa un proyecto NUEVO por cada Short.`);
  }

  for (const n of todo) await setStep(n, "image", "running");
  log("info", `Fase 1: pido al Agent ${todo.length} imagen(es): ${todo.map(pad3).join(", ")}.`);
  const instruction = buildAgentInstruction(imagesMap, todo);
  let res = null;
  for (let launch = 1; launch <= 3; launch++) {
    res = await sendWithRateLimit(() => writePrompt(instruction), { maxPoints: CONFIG.maxAllowedPointsImages });
    // Solo se reintenta si es SEGURO que el mensaje no salió (no duplicar imágenes).
    if (!(res.notSent || res.type === "error" || res.type === "agentReplied") || launch === 3) break;
    log("warn", `No se pudo lanzar la generación de imágenes (${res.error || res.type}). Reintento en 20 s (${launch + 1}/3).`);
    await sleep(20000);
    throwIfStopped();
  }
  if (res.type === "cost") throw new CostError(`las imágenes pedían ${res.cost} puntos (límite de seguridad ${CONFIG.maxAllowedPointsImages}); lo rechacé`);
  if (res.type !== "started") {
    const why = res.error || `Flow respondió "${res.type}"`;
    if ((res.notSent || res.type === "error") && (batch.autoReloads || 0) < 2) {
      for (const n of todo) batch.scenes[n].image = "pending";
      throw new ReloadError(`no se pudo lanzar la generación de imágenes (${why})`);
    }
    for (const n of todo) await setStep(n, "image", "failed", { error: `no se pudo lanzar la generación de imágenes: ${why}` });
    log("error", `No se pudo lanzar la generación de imágenes: ${why}.`);
    return;
  }

  const waitMs = Math.max(cfg.maxWaitMs || 0, 180000 + todo.length * 90000);
  log("info", `Generando ${todo.length} imagen(es)… (espero hasta ${Math.round(waitMs / 60000)} min)`);
  // [V] "terminó" = no queda ningún flow-pending-tile. Se exige que siga a 0
  // durante 5 s por si el Agent las lanza de una en una.
  let zeroSince = 0;
  const finished = await tryWait(() => {
    if ($$(CONFIG.pendingTileTag).length > 0) { zeroSince = 0; return false; }
    if (!zeroSince) zeroSince = Date.now();
    return Date.now() - zeroSince >= 5000;
  }, waitMs, "que terminen las imágenes");
  if (!finished) log("warn", "Las imágenes no terminaron en el tiempo previsto; compruebo cuáles hay.");

  const present = (n) => imageTilesByLabel(pad3(n)).length > countBefore.get(n);
  log("info", "Compruebo que el Agent las haya renombrado (lo hace unos segundos después)…");
  await tryWait(() => todo.every(present), CONFIG.imagesSettleMs, "el renombrado de las imágenes");
  // Antes de dar una imagen por perdida, se busca también desplazando la cuadrícula
  // (puede no estar pintada si hay muchas).
  for (const n of todo.filter((n) => !present(n))) await findWithScroll(() => (present(n) ? true : null), CONFIG.imageTileTag);
  let missing = todo.filter((n) => !present(n));
  for (const n of todo.filter(present)) await setStep(n, "image", "done");
  if (missing.length) {
    const seen = $$(CONFIG.imageTileTag).map(tileTitle).filter(Boolean).slice(0, 20).join(", ");
    log("info", `Nombres de imagen que veo en el proyecto: ${seen || "ninguno"}.`);
  }

  const maxRounds = Math.max(1, (cfg.maxRetries || 6) - 1);
  for (let round = 1; round <= maxRounds && missing.length; round++) {
    throwIfStopped();
    const labels = missing.map(pad3);
    log("warn", `Faltan (o fueron bloqueadas) las imágenes ${labels.join(", ")}. Pido al Agent que las reformule suavizándolas y las repita (ronda ${round}/${maxRounds}).`);
    const retryText =
      `Las imágenes con identificador ${labels.map((l) => `[${l}]`).join(", ")} no se generaron ` +
      `(fallaron o fueron bloqueadas por las políticas de contenido). Reformula cada uno de esos ` +
      `prompts para que sea más seguro y aceptable, manteniendo la idea general de la escena, y ` +
      `vuelve a generarlos (exactamente UNA imagen por prompt). Renombra cada imagen resultante con su mismo identificador ` +
      `exacto (por ejemplo, la reformulación de [${labels[0]}] debe llamarse ${labels[0]}).` +
      (round >= 2 ? ` ${buildSoftenNote("image", round + 1)}` : "");
    const r = await sendWithRateLimit(() => writePrompt(retryText), { maxPoints: CONFIG.maxAllowedPointsImages });
    if (r.type === "started") {
      await tryWait(() => $$(CONFIG.pendingTileTag).length === 0, waitMs, "que terminen las imágenes reintentadas");
      await tryWait(() => missing.every(present), CONFIG.imagesSettleMs, "el renombrado de las imágenes reintentadas");
    } else {
      log("error", `El reintento de imágenes no arrancó (${r.error || r.type}).`);
    }
    for (const n of missing.filter(present)) { await setStep(n, "image", "done"); log("ok", "Imagen generada tras reformular.", { scene: n }); }
    missing = missing.filter((n) => !present(n));
  }
  for (const n of missing) {
    await setStep(n, "image", "failed", { error: `la imagen no se generó ni tras ${maxRounds} reformulaciones (bloqueo de contenido): hazla a mano en Flow y llámala ${pad3(n)}` });
    log("error", `La imagen ${pad3(n)} no se generó tras ${maxRounds} reformulaciones. El resto del lote sigue.`, { scene: n });
  }
  if (!missing.length) log("ok", "Fase 1 terminada: todas las imágenes generadas y renombradas.");
}

// ================================================= ADJUNTAR IMAGEN ("+")
function assetItems() { return $$(CONFIG.assetListItemsSelector); }
function findAssetItem(label) {
  const items = assetItems();
  const idx = findAssetMatches(items.map((i) => i.textContent || ""), label);
  return idx.length ? { el: items[idx[0]], count: idx.length } : null;
}
async function findAssetItemWithScroll(label) {
  let hit = findAssetItem(label);
  if (hit) return hit;
  const vp = $(CONFIG.assetViewportSelector);
  if (!vp) return null;
  for (let i = 0; i < 40 && !hit; i++) {
    if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2) break;
    vp.scrollTop += Math.max(150, vp.clientHeight * 0.8);
    vp.dispatchEvent(new Event("scroll"));
    hit = await tryWait(() => findAssetItem(label), 700, "la imagen en la lista");
  }
  return hit;
}

async function attachViaPlusMenu(label) {
  await closeOverlays();
  const addBtn = $(CONFIG.addMenuButtonSelector);
  if (!addBtn) throw new Error('no encuentro el botón "+" (flow-agent-panel flow-add-menu button)');
  clickDeep(addBtn);
  // [V] "+" abre directamente la lista de assets (sin clics extra).
  const listed = await tryWait(() => assetItems().length > 0, CONFIG.assetListWaitMs, 'la lista de imágenes del "+"');
  if (!listed) throw new Error(`el menú "+" no mostró ninguna imagen en ${CONFIG.assetListWaitMs / 1000} s${visibilityNote()}`);
  const hit = await findAssetItemWithScroll(label);
  if (!hit) {
    const seen = assetItems().slice(0, 12).map((i) => (i.textContent || "").trim()).join(", ");
    throw new Error(`no encuentro la imagen "${label}" en la lista del "+" (veo: ${seen || "nada"})`);
  }
  if (hit.count > 1) log("warn", `Hay ${hit.count} imágenes llamadas "${label}"; uso la más reciente (la primera de la lista).`);
  hit.el.scrollIntoView({ block: "center" });
  clickDeep(hit.el);
  // La vista previa puede llevar el nombre en el texto o solo en atributos
  // (aria-label, alt, title): en el Flow real el texto es solo "Añadir a petición".
  const paneText = (p) => [p.textContent, ...$$("[aria-label],[alt],[title]", p).map((e) => `${e.getAttribute("aria-label") || ""} ${e.getAttribute("alt") || ""} ${e.getAttribute("title") || ""}`)].join(" ");
  const pane = await tryWait(() => $(CONFIG.detailPaneSelector), 6000, "la vista previa");
  if (!pane) throw new Error("no apareció la vista previa de la imagen");
  await sleep(400);
  const txt = paneText($(CONFIG.detailPaneSelector) || pane);
  if (!txt.includes(label)) {
    const other = (txt.match(/\b\d{3}\b/g) || []).filter((x) => x !== label);
    if (other.length) throw new Error(`la vista previa es de "${other[0]}", no de "${label}"`);
    log("info", `La vista previa no muestra el nombre; confío en el elemento pulsado ("${(hit.el.textContent || "").trim()}").`);
  }
  const addToPrompt = await tryWait(() => $(CONFIG.addToPromptButtonSelector), 5000, 'el botón "Añadir a petición"');
  if (!addToPrompt) throw new Error('no encuentro el botón "Añadir a petición"');
  clickDeep(addToPrompt);
  const closed = await tryWait(() => !$(CONFIG.addMenuOpenSelector), 5000, 'que se cierre el menú "+"');
  if (!closed) {
    await closeOverlays();
    if ($(CONFIG.addMenuOpenSelector)) throw new Error('el menú "+" no se cerró tras "Añadir a petición"');
  }
}

// La "caja" completa del Agent: el editor + los adjuntos + el botón generar.
// Al adjuntar una imagen aparece ahí su miniatura [V]; se comprueba que la
// caja haya cambiado (sin contar el texto) para no enviar NUNCA un prompt de
// vídeo sin su imagen (el Agent podría generar y cobrar un vídeo sin ella).
function composerEl() {
  const box = getPromptBox();
  if (!box) return null;
  const btn = $(CONFIG.generateButtonSelector);
  for (let p = box.parentElement; p; p = p.parentElement) {
    if ((btn && p.contains(btn)) || p.tagName === "FLOW-AGENT-PANEL") return p;
  }
  return null;
}
// Se mide ANTES de escribir el texto (la caja está vacía), así que se cuenta
// todo, también el editor, por si Flow metiera la miniatura dentro de él.
function signatureOf(c) {
  if (!c) return null;
  const els = $$("*", c);
  return { count: els.length, imgs: els.filter((e) => /^(IMG|VIDEO|CANVAS)$/.test(e.tagName)).length, html: els.reduce((a, e) => a + (e.children.length ? 0 : e.outerHTML.length), 0) };
}
function grew(before, now) {
  if (!before || !now) return true; // sin referencia: no se puede comprobar
  return now.count > before.count || now.imgs > before.imgs || now.html > before.html + 80;
}
function composerSignature() {
  return { composer: signatureOf(composerEl()), panel: signatureOf($(CONFIG.agentPanelSelector)) };
}
// Se exige que la caja cambie; si no, que al menos cambie el panel del Agent
// (por si Flow pinta la miniatura en otra parte del panel). Si no cambia
// NADA, la imagen no se adjuntó y no se envía.
async function verifyAttached(before, how) {
  const ok = await tryWait(() => grew(before.composer, signatureOf(composerEl())), 6000, "la miniatura adjunta en la caja");
  if (ok) return;
  if (grew(before.panel, signatureOf($(CONFIG.agentPanelSelector)))) {
    log("info", `Tras ${how} la caja no cambió, pero sí el panel del Agent: doy la imagen por adjuntada.`);
    return;
  }
  throw new Error(`pulsé ${how} pero la imagen no aparece adjunta en el panel del Agent`);
}

async function attachReferenceImage(n) {
  const label = pad3(n);
  await sleep(300); // que el editor termine de vaciarse antes de medir
  const before = composerSignature();
  try {
    await attachViaPlusMenu(label);
    await verifyAttached(before, '"Añadir a petición"');
    log("ok", `Imagen ${label} adjuntada con el menú "+".`);
    return;
  } catch (e) {
    if (e instanceof StopError) throw e;
    log("warn", `El menú "+" falló (${e.message}). Pruebo el plan B: clic derecho sobre la imagen ${label} → "Animar".`);
  }
  await closeOverlays();
  const tile = await findWithScroll(() => findImageTileByLabel(label), CONFIG.imageTileTag);
  if (!tile) throw new Error(`tampoco encuentro la imagen "${label}" en la cuadrícula para el plan B`);
  tile.scrollIntoView({ block: "center" });
  rightClickElement(tile);
  const item = await tryWait(() => findMenuItemByText(CONFIG.menuItemText.animate), 5000, 'la opción "Animar"');
  if (!item) { await closeOverlays(); throw new Error('no encuentro "Animar" en el menú contextual de la imagen'); }
  clickDeep(item);
  await verifyAttached(before, '"Animar"');
  log("ok", `Imagen ${label} adjuntada con "Animar" (plan B).`);
}

// ============================================ PROYECTO NUEVO Y AJUSTES DEL AGENTE (v2.12)
// DOM REAL medido el 30 sep 2026: en un proyecto NUEVO el agente trae imagen 16:9 x2 y vídeo 16:9 x1;
// los ajustes (panel «Ajustes» ⚙ del Agent → Guardar) son POR PROYECTO y se guardan al pulsar Guardar.
// Estructura: 2 radios «Siempre/Nunca» (confirmar antes de generar), 4 mat-button-toggle-group
// [imagen: formato, imagen: cantidad, vídeo: formato, vídeo: cantidad] y 2 menús de modelo.
function clickNewProject() {
  const btn = $$("button").find((b) => /nuevo proyecto|new project/i.test(`${b.textContent} ${b.getAttribute("aria-label") || ""}`));
  if (!btn) return false;
  btn.click();
  return true;
}
function agentSettingsButton() {
  const panel = $(CONFIG.agentPanelSelector);
  if (!panel) return null;
  const bs = $$("button", panel);
  return bs.find((b) => /^(ajustes|settings)$/i.test((b.getAttribute("aria-label") || "").trim())) || bs.find((b) => (b.textContent || "").trim() === "tune") || null;
}
function settingsGroups() {
  const panel = $(CONFIG.agentPanelSelector);
  const groups = panel ? $$("mat-button-toggle-group", panel) : [];
  const btnsOf = (g) => $$("button[role=radio], button", g);
  const txt = (b) => (b.textContent || "").replace(/\s+/g, "");
  const aspect = groups.filter((g) => btnsOf(g).some((b) => /\d+:\d+$/.test(txt(b))));
  const count = groups.filter((g) => btnsOf(g).some((b) => /^x\d$/.test(txt(b))));
  return { panel, imgAspect: aspect[0], vidAspect: aspect[1], imgCount: count[0], vidCount: count[1], btnsOf, txt };
}
const isChecked = (b) => b.getAttribute("aria-checked") === "true" || b.getAttribute("aria-pressed") === "true" || b.classList.contains("mat-button-toggle-checked") || (b.closest("mat-button-toggle") || b).classList.contains("mat-button-toggle-checked");
async function ensureAgentSettings() {
  ctxPhase = "setup";
  ctxScene = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    throwIfStopped();
    try {
      const opener = await tryWait(() => agentSettingsButton(), 30000, 'el botón «Ajustes» del Agent');
      if (!opener) throw new Error('no encuentro el botón «Ajustes» del Agent');
      opener.click();
      const g = await tryWait(() => { const x = settingsGroups(); return x.imgAspect && x.imgCount && x.vidAspect && x.vidCount ? x : null; }, 15000, "el panel de ajustes del Agent");
      if (!g) throw new Error("no se abre el panel de ajustes del Agent (no veo los selectores de formato y cantidad)");
      const done = [];
      const pick = async (group, re, label) => {
        const b = g.btnsOf(group).find((x) => re.test(g.txt(x)));
        if (!b) throw new Error(`no encuentro la opción ${label}`);
        if (!isChecked(b)) { b.click(); await sleep(250); if (!isChecked(b)) { clickDeep(b); await sleep(250); } }
        if (!isChecked(b)) throw new Error(`no pude marcar ${label}`);
        done.push(label);
      };
      await pick(g.imgAspect, /9:16$/, "imagen 9:16");
      await pick(g.imgCount, /^x1$/, "imagen x1");
      await pick(g.vidAspect, /9:16$/, "vídeo 9:16");
      await pick(g.vidCount, /^x1$/, "vídeo x1");
      // «Confirmar antes de generar» = Siempre (para poder comprobar el coste de cada vídeo)
      const always = $$("mat-radio-button", g.panel).find((r) => /^(siempre|always)/i.test((r.textContent || "").trim()));
      if (always) {
        const inp = $("input", always);
        if (inp && !inp.checked) { inp.click(); await sleep(250); }
        if (inp && !inp.checked) throw new Error("no pude poner «Confirmar antes de generar» en «Siempre»");
        done.push("confirmar = Siempre");
      }
      // Modelo de vídeo = Omni 1.1 Flash (el de 10 puntos por 6 s)
      const modelBtns = $$("button", g.panel).filter((b) => /arrow_drop_down/.test(b.textContent || ""));
      const vidModel = modelBtns[1] || modelBtns[modelBtns.length - 1];
      if (vidModel) {
        if (!/omni 1\.1 flash/i.test(vidModel.textContent || "")) {
          vidModel.click();
          const item = await tryWait(() => findMenuItemByText("Omni 1.1 Flash"), 6000, "«Omni 1.1 Flash» en el menú de modelos");
          if (!item) { await closeOverlays(); throw new Error("no encuentro «Omni 1.1 Flash» en el menú del modelo de vídeo"); }
          (item.querySelector("button") || item).click();
          await sleep(500);
        }
        if (!/omni 1\.1 flash/i.test(vidModel.textContent || "")) throw new Error("no pude elegir el modelo «Omni 1.1 Flash»");
        done.push("vídeo Omni 1.1 Flash");
      }
      const save = $$("button", g.panel).find((b) => /^(guardar|save)$/i.test((b.textContent || "").trim()));
      if (!save) throw new Error("no encuentro el botón «Guardar» de los ajustes");
      save.click();
      await tryWait(() => !settingsGroups().imgAspect, 8000, "que se cierre el panel de ajustes");
      log("ok", `Ajustes del proyecto nuevo: ${done.join(" · ")} (guardados).`);
      return true;
    } catch (e) {
      if (e instanceof StopError) throw e;
      log("warn", `Ajustes del agente: ${e.message}${attempt < 3 ? ` (intento ${attempt}/3)` : ""}.`);
      await closeOverlays();
      await sleep(1500);
    }
  }
  log("error", "No pude fijar los ajustes del agente (imagen/vídeo 9:16, x1, Omni 1.1 Flash). Sigo con los que tenga el proyecto: revísalos a mano en ⚙ Ajustes del Agent.");
  return false;
}

// ============================================================ FASE 2A: VÍDEOS
// v2.7 (prueba real v2.6: el Agent NO renombra bien los vídeos aunque se le
// pida, y al final no se sabía cuál era cuál). Ahora:
//  - el vídeo de una escena es el tile NUEVO que aparece después de aprobar
//    ESE vídeo (diferencia de tiles antes/después; nada de nombres);
//  - se DESCARGA EN ESE MISMO MOMENTO con su nombre <prefijo>_<NNN>.mp4,
//    antes de pedir el siguiente: nunca hay que buscarlo luego entre todos.
// PRUEBA REAL v2.7: el vídeo se daba por "generado" a los 3 s y la descarga
// fallaba ("no aparece Descargar" y luego "no encuentro el tile"): mientras
// Flow genera, aparece en la cuadrícula un tile PROVISIONAL (sin "%") que al
// terminar se sustituye por el definitivo. Ahora un vídeo solo cuenta como
// terminado cuando:
//   1) ya no queda el flow-pending-tile de esta petición ([V] "terminó" =
//      no queda ningún pending, igual que en las imágenes),
//   2) el tile nuevo no está dentro de un pending ni muestra progreso,
//   3) sigue siendo el mismo tile durante 5 s (20 s si aún no tiene fuente
//      de vídeo, por si es el provisional).
function videoSrcOf(tile) {
  const v = tile && tile.querySelector("video");
  if (!v) return null;
  const list = [v.currentSrc, v.src, ...$$("source", v).map((x) => x.src)].filter(Boolean);
  return list.find((u) => /^(https:|blob:)/.test(u)) || null;
}
// v2.11 (DOM REAL medido el 30 sep 2026): un vídeo TERMINADO no lleva <video>: lleva
// <img class="thumbnail" alt="Miniatura de vídeo generada" src="https://…">. Mientras
// se genera (y si falla) el flow-video-tile NO tiene ninguna imagen. Por eso "tiene
// vídeo" = miniatura con src (o <video> con fuente, por si Flow cambia).
function tileHasMedia(t) {
  if (!t) return false;
  if (videoSrcOf(t)) return true;
  return $$("img[src]", t).some((i) => /^(https?:|blob:|data:)/.test(i.src || ""));
}
// Un tile con vídeo reproducible NUNCA es un error.
function isErrorTile(t) { return tileLooksFailed(t.textContent || "") && !tileHasMedia(t); }
// Avisos de error de Flow que viven en el chat del Agent: <flow-error-tile> ("Error — Se ha
// producido un error. Inténtalo de nuevo."). Es independiente del idioma.
const errorCardCount = () => $$("flow-error-tile").length;
// v2.10.3 (prueba real: el mismo vídeo generado 4 veces): en Flow real los tiles
// de vídeo no traen identificador estable y al redibujarse la cuadrícula los
// tiles VIEJOS parecen nuevos (p. ej. el aviso de error de un fallo anterior).
// Por eso "salió" / "falló" se decide CONTANDO (un redibujado no cambia la cuenta).
// good   = vídeos con miniatura (terminados de verdad)
// err    = avisos de error (tiles de error + tarjetas <flow-error-tile> del chat)
// stalled= tiles SIN miniatura y sin progreso: con Flow ya sin generar nada, es un fallo silencioso
function videoCounts() {
  const tiles = $$(CONFIG.videoTileTag).filter((t) => !t.closest(CONFIG.pendingTileTag));
  return {
    good: tiles.filter((t) => tileReady(t) && tileHasMedia(t) && !isErrorTile(t)).length,
    err: tiles.filter(isErrorTile).length + errorCardCount(),
    stalled: tiles.filter((t) => tileReady(t) && !tileHasMedia(t) && !isErrorTile(t)).length,
  };
}
// Pasa el ratón (sintético) por encima del tile: Flow puede cargar el <video> al hacerlo.
function hoverTile(t) {
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
    try { t.dispatchEvent(new MouseEvent(type, { bubbles: type !== "mouseenter" && type !== "pointerenter", cancelable: true, view: window })); } catch (e) {}
  }
}
const tileText = (t) => String((t && t.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 120);
function freshVideoTiles(beforeKeys, excludeKeys) {
  const before = new Set(beforeKeys || []);
  const ex = new Set(excludeKeys || []);
  return $$(CONFIG.videoTileTag).filter((t) => !t.closest(CONFIG.pendingTileTag) && !before.has(tileKey(t)) && !ex.has(tileKey(t)));
}
async function waitForSceneVideo(sendRes, maxWaitMs) {
  const assigned = () => batch.order.map((m) => batch.scenes[m].videoKey).filter(Boolean);
  const basePending = Math.max(sendRes.before.pending, ignoredPending);
  const base = sendRes.before.counts || videoCounts();
  let lastInProgressNote = 0;
  let readyKey = null;
  let readySince = 0;
  let lastHover = 0;
  let noSrcLogged = false;
  let failSince = 0;
  let idleSince = 0;
  const cond = () => {
    rejectStrayCostDialogs("mientras se generaba el vídeo");
    const sig = detectNewSignals(sendRes.textBefore, agentPanelText());
    const fresh = freshVideoTiles(sendRes.before.videoKeys, assigned());
    const generating = $$(CONFIG.pendingTileTag).length > basePending || fresh.some((t) => !tileReady(t) && !isErrorTile(t));
    if (generating) {
      readyKey = null;
      failSince = 0;
      idleSince = 0;
      if (Date.now() - lastInProgressNote > 60000) {
        lastInProgressNote = Date.now();
        const pct = fresh.map((t) => (t.textContent || "").match(/\d{1,3}\s?%/)).find(Boolean);
        log("info", `El vídeo se está generando en Flow${pct ? ` (${pct[0]})` : ""}…`);
      }
      return null;
    }
    const c = videoCounts();
    // ¿Hay un vídeo bueno (CON MINIATURA) MÁS que antes de enviar? → salió.
    // v2.11 (DOM real): un tile sin miniatura NUNCA es un vídeo (es el provisional o un fallo).
    const agentSaysFail = sig.policy || sig.genError;
    const readyNew = fresh.filter((t) => tileReady(t) && tileHasMedia(t) && !isErrorTile(t));
    const trustNew = !agentSaysFail || readyNew.length > 0;
    if (c.good > base.good && trustNew && readyNew.length) {
      failSince = 0;
      idleSince = 0;
      const pick = pickNewVideoKey(readyNew.map(tileKey), []);
      const el = readyNew.find((t) => tileKey(t) === pick.key);
      if (!el) return null;
      if (pick.key !== readyKey) { readyKey = pick.key; readySince = Date.now(); return null; }
      // la miniatura aparece unos segundos ANTES de que Flow dé el vídeo por terminado: margen corto
      if (Date.now() - readySince < 4000) return null;
      return { key: pick.key, el, ambiguous: pick.ambiguous, count: readyNew.length };
    }
    readyKey = null;
    // Sin vídeo nuevo: ¿hay señal de fallo NUEVA? Se CONFIRMA unos segundos antes de darlo por
    // fallido (por si el vídeo aparece): nunca se repite un vídeo que sí salió.
    //  - policy: el Agent dice que lo bloqueó la política
    //  - card: <flow-error-tile> nuevo en el chat, o tile de error nuevo
    //  - stalled: Flow ya no genera nada y quedó un tile SIN miniatura (fallo silencioso)
    //  - agent: el Agent dice que no pudo
    //  - silent: Flow lleva 90 s sin generar nada y sin aviso alguno
    const baseStalled = base.stalled || 0;
    const hint = sig.policy ? "policy" : c.err > base.err ? "card" : c.stalled > baseStalled ? "stalled" : sig.genError ? "genError" : null;
    let kind = hint;
    if (!kind) {
      failSince = 0;
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince < 90000) return null;
      kind = "silent";
    }
    const confirmMs = kind === "policy" ? 12000 : kind === "card" || kind === "stalled" ? 20000 : kind === "silent" ? 0 : 30000;
    if (!failSince) {
      failSince = Date.now();
      const why = { policy: "bloqueo por políticas", card: "aviso de error de Flow", stalled: "el vídeo quedó sin miniatura", genError: "el Agent dice que no se pudo generar", silent: "Flow lleva 90 s sin generar nada ni avisar" }[kind];
      log("info", `Parece que Flow no pudo generar el vídeo (${why}). Lo compruebo durante ${Math.round(confirmMs / 1000)} s antes de reintentar, por si el vídeo aparece.`);
    }
    if (Date.now() - failSince < confirmMs) return null;
    return { error: kind === "policy" ? "policy" : "genError" };
  };
  let r = await tryWait(cond, maxWaitMs, "el vídeo nuevo");
  // Si se acaba la espera pero Flow sigue visiblemente generando (cola), se
  // espera más en vez de dar el vídeo por perdido.
  for (let ext = 1; !r && ext <= 2; ext++) {
    const busy = $$(CONFIG.pendingTileTag).length > basePending || freshVideoTiles(sendRes.before.videoKeys, assigned()).some((t) => !tileReady(t));
    if (!busy) break;
    log("info", `Han pasado ${Math.round((maxWaitMs * ext) / 60000)} min y Flow sigue generando el vídeo (cola): espero ${Math.round(maxWaitMs / 60000)} min más (${ext}/2).`);
    r = await tryWait(cond, maxWaitMs, "el vídeo nuevo (espera ampliada)");
  }
  return r || { error: "timeout" };
}

// Motivo de fallo: "content" (Flow lo bloqueó o no pudo; no cobra), "cost"
// (pedía > 10 y se rechazó; gratis), "tech" (no se pudo adjuntar/enviar…).
// Todos son GRATIS: por eso se pueden reintentar solos.
function sceneRetryable(n, cfg) {
  const s = batch.scenes[n];
  return s.video === "failed" && !s.videoApproved && s.image === "done" && !!(cfg.animations || {})[n] && s.failKind !== "noprompt";
}

// ¿Hay un vídeo bueno de más desde el último envío de esta escena (descontando
// los de otras escenas terminadas después)? Solo si Flow no está generando nada.
function lateVideoForScene(n) {
  const s = batch.scenes[n];
  if (s.lastSendGood == null || !Array.isArray(s.lastSendKeys)) return null;
  if ($$(CONFIG.pendingTileTag).length > ignoredPending) return null;
  const othersDone = batch.order.filter((m) => m !== n && batch.scenes[m].doneAt && batch.scenes[m].doneAt > s.lastSendAt).length;
  if (videoCounts().good <= s.lastSendGood + othersDone) return null;
  const others = batch.order.filter((m) => m !== n).map((m) => batch.scenes[m].videoKey).filter(Boolean);
  return freshVideoTiles(s.lastSendKeys, others).filter((t) => tileDone(t) && !isErrorTile(t))[0] || null;
}

async function processSceneVideo(n, cfg, maxWaitMs, pass) {
  throwIfStopped();
  ctxScene = n;
  const s = batch.scenes[n];
  if (["done", "review", "failed", "skipped", "nopoints"].includes(s.video)) return;
  if (s.image !== "done") {
    await setStep(n, "video", "skipped", { error: s.error || "no hay imagen de referencia" });
    await setStep(n, "download", "skipped");
    log("warn", "Sin imagen de referencia: salto el vídeo de esta escena.");
    return;
  }
  const raw = (cfg.animations || {})[n];
  if (!raw) {
    await setStep(n, "video", "failed", { error: "el kit no trae prompt de animación para esta escena", failKind: "noprompt" });
    await setStep(n, "download", "skipped");
    log("error", "No hay prompt de animación para esta escena en el kit.");
    return;
  }
  // Nunca dos vídeos generándose a la vez: si uno anterior (ya aprobado) sigue
  // en marcha, se espera a que termine y se le asigna a SU escena. Así el
  // vídeo nuevo que aparezca después es seguro de esta escena.
  if (!cfg.dryRun) await settleBeforeSend(cfg, maxWaitMs);
  // Lo más importante del coste: la DURACIÓN (6 s = 10 puntos). Se remarca al
  // principio y al final, además del "6 seconds" dentro del propio prompt.
  // (Ya NO se pide al Agent que renombre el vídeo: lo hacía mal y además
  // mete ruido en el prompt.)
  const buildPrompt = (strong) =>
    `${buildDurationNote(CONFIG.videoSeconds, strong)}\n\n${ensureVideoDuration(raw, CONFIG.videoSeconds)}\n\n` +
    `(Duración: ${CONFIG.videoSeconds} segundos exactos. Un solo vídeo.)`;
  if (pass === 1 && ensureVideoDuration(raw, CONFIG.videoSeconds) !== raw) log("info", `Ajusto la duración del prompt a ${CONFIG.videoSeconds} s (de ella depende el coste: 6 s = 10 puntos).`);

  let lastError = null;
  let failKind = "tech";
  let outcome = null;
  let costRetries = 0;
  let strongDuration = pass > 1;
  let haltAfterScene = null;
  let imageStillAttached = false; // el intento anterior no llegó a salir: su imagen sigue en la caja
  const maxAttempts = Math.max(1, cfg.maxRetries || CONFIG.maxAttemptsPerScene);
  for (let attempt = 1; attempt <= maxAttempts && !outcome && !haltAfterScene; attempt++) {
    // Antes de VOLVER a pedirlo: ¿el envío anterior sí dio vídeo? (llegó tarde o
    // se creyó fallido). Entonces se usa ese y NO se paga otro.
    const late = lateVideoForScene(n);
    if (late) {
      videoElByScene.set(n, late);
      await setStep(n, "video", "done", { videoKey: tileKey(late), error: null, failKind: null, doneAt: Date.now() });
      log("ok", "El vídeo de esta escena SÍ se generó (apareció después): lo uso y NO lo vuelvo a pedir.");
      outcome = "done";
      break;
    }
    ui.setStatus(`Escena ${pad3(n)}: vídeo (intento ${attempt}/${maxAttempts}${pass > 1 ? ", 2.ª vuelta" : ""})`, "info");
    await setStep(n, "video", "running", { videoApproved: false, error: null });
    const base = buildPrompt(strongDuration);
    const softenLevel = attempt + (pass - 1) * 2; // cada vuelta, un poco más suave
    const text = softenLevel === 1 ? base : `${base}\n\n${buildSoftenNote("video", softenLevel)}`;
    if (attempt > 1) {
      if (!cfg.dryRun) await waitAgentIdle();
      // (tras la espera, el vídeo del intento anterior pudo aparecer)
      const late2 = lateVideoForScene(n);
      if (late2) {
        videoElByScene.set(n, late2);
        await setStep(n, "video", "done", { videoKey: tileKey(late2), error: null, failKind: null, doneAt: Date.now() });
        log("ok", "El vídeo de esta escena SÍ se generó (apareció después): lo uso y NO lo vuelvo a pedir.");
        outcome = "done";
        break;
      }
      log("info", `Reintento ${attempt}/${maxAttempts}: pido al Agent el mismo vídeo con el prompt suavizado.`);
    }
    let res;
    let inBox = false; // hay una imagen adjunta en la caja que aún no ha salido
    try {
      const t0 = Date.now();
      res = await sendWithRateLimit(async (k, o) => {
        const box = getPromptBox();
        if (box && promptText()) setEditableValue(box, "");
        if (o && o.rewriteOnly) {
          // la imagen sigue en la caja: solo se reescribe el texto
        } else if (k === 0 && imageStillAttached) {
          log("info", "La imagen sigue adjunta del intento anterior (no llegó a salir): solo reescribo el texto.");
        } else {
          // (k > 0 = tras "demasiado rápido": el mensaje salió y la caja quedó vacía)
          inBox = false;
          await attachReferenceImage(n);
        }
        inBox = true;
        await writePrompt(text);
      }, { maxPoints: CONFIG.maxAllowedPointsPerVideo, dryRun: !!cfg.dryRun, onApproved: () => { s.videoApproved = true; saveBatch(); } });
      // Si el mensaje salió, Flow vacía la caja (adjuntos incluidos).
      imageStillAttached = !!(res && res.notSent);
      inBox = false;

      if (res.type === "dryRun") {
        const okCost = res.cost !== null && res.cost <= CONFIG.maxAllowedPointsPerVideo;
        log(okCost ? "ok" : "warn", `ENSAYO: todo llegó hasta el aviso de coste (${res.cost === null ? "coste ilegible" : res.cost + " puntos"}${okCost ? ", se habría aprobado" : ", NO se habría aprobado"}). He pulsado "Rechazar": 0 puntos gastados.`);
        await setStep(n, "video", "skipped", { error: `ensayo: aviso de coste de ${res.cost} puntos rechazado a propósito` });
        await setStep(n, "download", "skipped");
        outcome = "dry";
        break;
      }
      if (res.type === "cost") {
        // Pedía más de 10 (p. ej. 12: la IA entendió otra duración). Se ha
        // pulsado "Rechazar" (gratis) y se vuelve a pedir remarcando los 6 s.
        const why = res.cost === null ? "no pude leer el coste" : `pedía ${res.cost} puntos (máximo ${CONFIG.maxAllowedPointsPerVideo})`;
        costRetries++;
        if (costRetries <= 3) {
          log("warn", `El vídeo ${why}: lo he RECHAZADO (no cuesta nada) y lo vuelvo a pedir remarcando que dure ${CONFIG.videoSeconds} segundos (reenvío ${costRetries}/3).`);
          strongDuration = true;
          attempt--; // no cuenta como intento de "bloqueo por contenido"
          await sleep(3000);
          continue;
        }
        lastError = `${why} también tras 3 reenvíos remarcando la duración; no lo apruebo. Comprueba que el modelo de vídeo sigue en "Omni 1.1 Flash"`;
        failKind = "cost";
        log("error", `El vídeo ${lastError}.`);
        break;
      }
      if (res.type === "started" && !res.approved && !cfg.dryRun) {
        // Empezó a generar SIN aviso de coste: "Confirmar antes de generar"
        // está en "Nunca" y no se puede comprobar que cueste 10. Se deja
        // terminar ESTE vídeo y se para de generar en la cuenta.
        haltAfterScene = 'Flow empezó a generar el vídeo SIN pedir confirmación de coste: el ajuste «Confirmar antes de generar» parece estar en «Nunca». Ponlo en «Siempre» (Ajustes ⚙ → Configuración del agente): así la extensión aprueba solo si cuesta 10 puntos';
        log("error", haltAfterScene + ".");
      }
      if (res.type === "started") {
        // "Ventana" de esta escena: los vídeos que ya había al enviarla. Con
        // ella se puede volver a encontrar SU vídeo aunque Flow redibuje el tile.
        s.beforeVideoKeys = res.before.videoKeys;
        s.sentAt = Date.now();
        // Para reconocer después un vídeo de ESTE envío que llegue tarde.
        s.lastSendGood = (res.before.counts || videoCounts()).good;
        s.lastSendKeys = res.before.videoKeys;
        s.lastSendAt = s.sentAt;
        await saveBatch();
        log("info", `Generando el vídeo… (espero hasta ${Math.round(maxWaitMs / 60000)} min, más si Flow sigue en cola)`);
        const v = await waitForSceneVideo(res, maxWaitMs);
        markVideoEvent();
        if (v.key) {
          if (v.ambiguous) log("warn", `Aparecieron ${v.count} vídeos nuevos terminados a la vez; asigno a esta escena el más reciente. Revisa que sea el correcto.`);
          videoElByScene.set(n, v.el);
          await setStep(n, "video", "done", { videoKey: v.key, error: null, failKind: null, doneAt: Date.now() });
          log("ok", `Vídeo generado en ${Math.round((Date.now() - t0) / 1000)} s.`);
          if (!keyIsStable(v.key)) log("info", `Aviso técnico: el tile de este vídeo no trae un identificador estable (${v.key.split(":")[0]}); lo descargo ya para no perderlo.`);
          outcome = "done";
        } else if (v.error === "timeout") {
          lastError = `el coste se aprobó pero el vídeo no apareció en ${Math.round((Date.now() - t0) / 60000)} min`;
          outcome = res.approved ? "review" : null;
          failKind = "tech";
        } else {
          lastError = v.error === "policy" ? "Flow lo bloqueó por su política de contenido" : "Flow dice que no se ha podido generar (no se cobra)";
          failKind = "content";
          // Sin confirmación de coste no se reintenta: se generaría sin poder comprobar los puntos.
          if (haltAfterScene) break;
          log("warn", `${lastError}.${attempt < maxAttempts ? " Reintento suavizando el prompt." : ""}`);
        }
      } else if (res.type === "approvedNoStart") {
        lastError = res.error || "el coste se aprobó pero no empezó ninguna generación";
        outcome = "review";
      } else {
        lastError = res.error || ({ policy: "bloqueado por la política de contenido", genError: "Flow no pudo generarlo", cancelled: "el Agent canceló la generación", noStart: "no se llegó a enviar" }[res.type] || res.type);
        failKind = ["policy", "genError", "cancelled", "agentReplied"].includes(res.type) ? "content" : "tech";
        log("warn", `No salió: ${lastError}.${attempt < maxAttempts ? " Reintento." : ""}`);
      }
    } catch (e) {
      if (e instanceof StopError || e instanceof NoPointsError || e instanceof CostError) throw e;
      imageStillAttached = inBox;
      lastError = e.message;
      failKind = "tech";
      log("warn", `Fallo en el intento ${attempt}: ${e.message}${visibilityNote()}`);
      await closeOverlays();
      if (s.videoApproved) outcome = "review";
    }
    if (!outcome && failKind === "tech" && attempt < maxAttempts) await sleep(5000); // que Flow se asiente
  }
  if (outcome === "dry") { await sleep(1500); return; }
  if (outcome === "review") {
    await setStep(n, "video", "review", { error: `${lastError}. No lo repito solo para no gastar puntos dos veces; al final del lote vuelvo a mirar si apareció`, reviewSince: Date.now() });
    log("error", `Vídeo a REVISAR: ${lastError}. No lo repito para no cobrar dos veces; al final vuelvo a comprobar si apareció.`);
  } else if (outcome !== "done") {
    // Si Flow dijo que falló (o se rechazó por coste), no se cobró nada aunque se
    // hubiera pulsado "Aprobar": la escena se puede volver a intentar.
    await setStep(n, "video", "failed", { error: lastError || "no se pudo generar", failKind, ...(["content", "cost"].includes(failKind) ? { videoApproved: false } : {}) });
    await setStep(n, "download", "skipped");
    log("error", `No se pudo generar el vídeo de la escena ${pad3(n)}: ${lastError}.${pass <= CONFIG.videoExtraRounds ? " Sigo con la siguiente y lo reintento solo al final, suavizando más el prompt (no cuesta puntos)." : ""}`);
  } else if (!["dryRun", "imagesOnly"].includes(cfg.genMode)) {
    // DESCARGA INMEDIATA: ahora sabemos seguro cuál es su vídeo.
    await downloadScene(n, "video", cfg);
  }
  if (haltAfterScene) throw new CostError(haltAfterScene);
  await sleep(1500);
}

async function phaseVideos(cfg) {
  ctxPhase = "videos";
  batch.phase = "videos";
  await saveBatch();
  const maxWaitMs = Math.max(cfg.maxWaitMs || 0, 10 * 60000);
  for (const n of batch.order) await processSceneVideo(n, cfg, maxWaitMs, 1);

  // VUELTAS automáticas (v2.10.2, el usuario: "que se generen siempre, como
  // las imágenes"): las escenas que fallaron sin cobrar (Flow no pudo, bloqueo,
  // no se pudo adjuntar/enviar) se vuelven a intentar hasta CONFIG.videoExtraRounds
  // vueltas, cada una suavizando un poco más el prompt pero con la misma escena,
  // estilo y duración. Un coste > 10 solo se reintenta en la 2.ª vuelta (si
  // sigue pidiendo más, el problema es el modelo de vídeo, no el prompt).
  if (!cfg.dryRun) {
    for (let pass = 2; pass <= CONFIG.videoExtraRounds + 1; pass++) {
      const again = batch.order.filter((n) => sceneRetryable(n, cfg) && (pass === 2 || batch.scenes[n].failKind !== "cost"));
      if (!again.length) break;
      ctxScene = null;
      const waitS = pass === 2 ? 30 : 60;
      log("warn", `${pass === 2 ? "Segunda vuelta automática" : `Vuelta automática ${pass}/${CONFIG.videoExtraRounds + 1}`} para las escenas que fallaron (no costaron puntos): ${again.map(pad3).join(", ")}. Suavizo un poco más el prompt (misma escena y estilo). Empiezo en ${waitS} s.`);
      await sleep(waitS * 1000);
      for (const n of again) {
        throwIfStopped();
        await setStep(n, "video", "pending", { error: null });
        await setStep(n, "download", "pending");
        await processSceneVideo(n, cfg, maxWaitMs, pass);
      }
      // Fallos TÉCNICOS (no se pudo adjuntar/enviar) tras la 2.ª vuelta: F5 ya
      // (suele desatascar Flow), sin esperar a las demás vueltas. Máx. 2.
      const techNow = batch.order.filter((n) => sceneRetryable(n, cfg) && batch.scenes[n].failKind === "tech");
      if (techNow.length && (batch.autoReloads || 0) < 2) {
        for (const n of techNow) { batch.scenes[n].video = "pending"; batch.scenes[n].download = "pending"; }
        throw new ReloadError(`las escenas ${techNow.map(pad3).join(", ")} fallaron por un problema técnico (adjuntar/enviar)`);
      }
    }
    // Si aún quedan fallos TÉCNICOS (no se pudo adjuntar/enviar), se recarga
    // la página (F5) y se reanuda solo: suele desatascar Flow. Máx. 2 veces.
    const tech = batch.order.filter((n) => sceneRetryable(n, cfg) && batch.scenes[n].failKind === "tech");
    if (tech.length && (batch.autoReloads || 0) < 2) {
      for (const n of tech) { batch.scenes[n].video = "pending"; batch.scenes[n].download = "pending"; }
      throw new ReloadError(`las escenas ${tech.map(pad3).join(", ")} fallaron por un problema técnico (adjuntar/enviar)`);
    }
  }
  ctxScene = null;
}

let ignoredPending = 0; // tiles "generándose" que no terminan nunca: tras esperarlos una vez, no se vuelven a esperar
async function settleBeforeSend(cfg, maxWaitMs) {
  const n = ctxScene;
  const pending = () => $$(CONFIG.pendingTileTag).length;
  if (pending() > ignoredPending) {
    log("info", "Flow aún está generando un vídeo anterior: espero a que termine antes de pedir este (así no se cruzan).");
    const ok = await tryWait(() => pending() <= ignoredPending, maxWaitMs, "que termine el vídeo anterior");
    if (!ok) {
      ignoredPending = pending();
      log("warn", `Hay ${ignoredPending} generación(es) que no terminan tras ${Math.round(maxWaitMs / 60000)} min; sigo sin esperarlas más.`);
    }
    await sleep(3000);
  }
  if (batch.order.some((m) => batch.scenes[m].video === "review")) await resolveReviewScenes(cfg);
  ctxScene = n;
  ctxPhase = "videos";
  await waitAgentIdle();
}

// v2.10.4 (el usuario: "dale tiempo a la IA; que no le envíes el 2.º nada más
// enviar el 1.º"): antes de CADA envío de vídeo, (1) un margen mínimo desde el
// último vídeo (terminado o fallido) y (2) el Agent libre: botón de generar
// presente y habilitado, y su panel sin cambiar durante 10 s (ya no escribe).
// v2.11 (DOM REAL, 30 sep 2026): el botón «Iniciar generación» está SIEMPRE deshabilitado con la
// caja vacía (justo después de enviar), así que "deshabilitado" NO significa "ocupado" (la v2.10
// esperaba 5 min enteros antes de cada vídeo y de cada reintento por eso). Mientras el Agent
// trabaja, el botón pasa a ser uno de PARAR (■).
function agentBusyNow() {
  if ($$(CONFIG.pendingTileTag).length > ignoredPending) return true;
  const panel = $(CONFIG.agentPanelSelector);
  if (!panel) return false;
  if ($("flow-stop-button", panel)) return true;
  const btn = $(CONFIG.generateButtonSelector);
  if (!btn) return true; // el botón de generar no está: lo ha sustituido el de parar
  const b = btn.tagName === "BUTTON" ? btn : btn.querySelector("button");
  const label = `${(b && b.getAttribute("aria-label")) || ""} ${(b && b.textContent) || ""}`;
  return /stop|square|cancel|pause|detener|parar|cancelar|pausar/i.test(label);
}
let lastVideoEventAt = 0;
function markVideoEvent() { lastVideoEventAt = Date.now(); }
async function waitAgentIdle() {
  const gap = CONFIG.minGapBetweenVideosMs - (Date.now() - lastVideoEventAt);
  if (lastVideoEventAt && gap > 0) {
    log("info", `Dejo ${Math.round(gap / 1000)} s de margen a Flow antes de pedir el siguiente vídeo.`);
    await sleep(gap);
  }
  let lastText = null;
  let stableSince = Date.now();
  let noted = false;
  const t0 = Date.now();
  const ok = await tryWait(() => {
    const txt = agentPanelText();
    if (txt !== lastText) { lastText = txt; stableSince = Date.now(); }
    const busy = agentBusyNow();
    if (busy) stableSince = Date.now();
    if (!noted && Date.now() - t0 > 20000) { noted = true; log("info", "El Agent de Flow sigue trabajando; espero a que termine antes de enviarle nada…"); }
    return !busy && Date.now() - stableSince >= 10000;
  }, 3 * 60000, "que el Agent de Flow esté libre");
  if (!ok) log("warn", "El Agent de Flow no ha quedado libre en 3 min; envío igualmente (no se reenvía nada ya enviado).");
}

// Al final del lote: un vídeo "a revisar" (coste aprobado pero no apareció a
// tiempo) puede haber aparecido después. Si hay tantos vídeos nuevos sin
// dueño como escenas a revisar, se asignan (del más antiguo al más nuevo).
async function resolveReviewScenes(cfg) {
  const review = batch.order.filter((n) => batch.scenes[n].video === "review" && batch.scenes[n].videoApproved);
  if (!review.length || !Array.isArray(batch.startVideoKeys)) return;
  ctxPhase = "videos";
  ctxScene = null;
  if ($$(CONFIG.pendingTileTag).length > ignoredPending) {
    const waitMs = Math.max(cfg.maxWaitMs || 0, 10 * 60000);
    log("info", `Hay vídeos todavía generándose; espero a que terminen (hasta ${Math.round(waitMs / 60000)} min) para asignarlos a las escenas a revisar ${review.map(pad3).join(", ")}.`);
    const ok = await tryWait(() => $$(CONFIG.pendingTileTag).length <= ignoredPending, waitMs, "que terminen los vídeos pendientes");
    if (!ok) ignoredPending = $$(CONFIG.pendingTileTag).length;
    await sleep(3000);
  }
  const taken = new Set(batch.order.map((m) => batch.scenes[m].videoKey).filter(Boolean));
  const orphans = $$(CONFIG.videoTileTag).filter((t) => !t.closest(CONFIG.pendingTileTag) && tileDone(t) && !isErrorTile(t) && !batch.startVideoKeys.includes(tileKey(t)) && !taken.has(tileKey(t)));
  if (orphans.length !== review.length) {
    if (orphans.length) log("warn", `Hay ${orphans.length} vídeo(s) nuevo(s) sin escena y ${review.length} escena(s) a revisar: no los asigno solo para no cruzarlos. Revisa en Flow.`);
    return;
  }
  // Flow pone los más recientes primero: el último de la lista es el más antiguo.
  orphans.reverse();
  for (let i = 0; i < review.length; i++) {
    const n = review[i];
    ctxScene = n;
    videoElByScene.set(n, orphans[i]);
    await setStep(n, "video", "done", { videoKey: tileKey(orphans[i]), error: null });
    log("ok", `El vídeo de la escena ${pad3(n)} apareció más tarde: lo asigno${review.length > 1 ? " (por orden de llegada; revisa que sea el correcto)" : ""} y lo descargo.`);
    if (batch.scenes[n].download !== "done") { await setStep(n, "download", "pending"); await downloadScene(n, "video", cfg); }
  }
  ctxScene = null;
}

// ======================================================= FASE 2B: DESCARGAS
// Busca el tile del vídeo de una escena JUSTO antes de descargarlo (nunca se
// fía de un elemento guardado que Flow haya podido sustituir):
//  1) el elemento guardado, si sigue en la página y terminado;
//  2) un tile con la misma clave;
//  3) por su "ventana": vídeos terminados que NO existían al enviar esta
//     escena, que no son de otra escena y (si ya se envió la siguiente) que
//     SÍ existían al enviar la siguiente.
function sceneVideoCandidates(n) {
  const s = batch.scenes[n];
  const others = batch.order.filter((m) => m !== n).map((m) => batch.scenes[m].videoKey).filter(Boolean);
  let list = freshVideoTiles(s.beforeVideoKeys || batch.startVideoKeys || [], others).filter((t) => tileDone(t) && !isErrorTile(t));
  const next = batch.order.map((m) => batch.scenes[m]).filter((x) => x !== s && x.sentAt && s.sentAt && x.sentAt > s.sentAt && Array.isArray(x.beforeVideoKeys)).sort((x, y) => x.sentAt - y.sentAt)[0];
  // Con claves provisionales (Flow no da ningún identificador estable), un
  // tile sustituido parece "nuevo": entonces solo vale el más reciente (Flow
  // pone los últimos primero) y solo justo después de generarlo.
  if ((s.beforeVideoKeys || []).some((k) => !keyIsStable(k)) || (s.videoKey && !keyIsStable(s.videoKey))) {
    // Si ya se envió otra escena después, "el más reciente" sería el suyo: no se adivina.
    if (next) return [];
    return list.length ? [list[0]] : [];
  }
  if (next) {
    const nb = new Set(next.beforeVideoKeys);
    const inWindow = list.filter((t) => nb.has(tileKey(t)));
    if (inWindow.length) list = inWindow;
  }
  return list;
}
async function findVideoTileForScene(n) {
  const s = batch.scenes[n];
  const el = videoElByScene.get(n);
  if (el && el.isConnected && !el.closest(CONFIG.pendingTileTag) && tileDone(el)) return el;
  const key = s.videoKey;
  if (key) {
    const byKey = $$(CONFIG.videoTileTag).find((t) => tileKey(t) === key && tileDone(t));
    if (byKey) { videoElByScene.set(n, byKey); return byKey; }
  }
  const cands = sceneVideoCandidates(n);
  if (!cands.length) return findWithScroll(() => sceneVideoCandidates(n)[0] || null, CONFIG.videoTileTag);
  if (cands.length > 1) log("warn", `Hay ${cands.length} vídeos posibles para la escena ${pad3(n)}; uso el más reciente.`);
  else log("info", "Flow sustituyó el tile del vídeo; lo he vuelto a encontrar (es el vídeo nuevo de esta escena).");
  videoElByScene.set(n, cands[0]);
  s.videoKey = tileKey(cands[0]);
  await saveBatch();
  return cands[0];
}

// via "right": clic derecho sobre el tile · via "more": botón «Más opciones» (⋮) del propio tile
// (DOM real: lleva aria-label "Más opciones"). Ambos abren el mismo menú con «Descargar».
async function openDownloadMenu(tile, kind, resolution, via) {
  await closeOverlays();
  tile.scrollIntoView({ block: "center" });
  await sleep(300);
  const moreBtn = via === "more" ? $$("button", tile).find((b) => /m[aá]s opciones|more options|more_vert/i.test(`${b.getAttribute("aria-label") || ""} ${b.textContent}`)) : null;
  if (via === "more" && !moreBtn) throw new Error('el tile no tiene botón "Más opciones"');
  if (moreBtn) { hoverTile(tile); clickDeep(moreBtn); } else rightClickElement(tile);
  const dl = await tryWait(() => findMenuItemByText(CONFIG.menuItemText.download), 5000, 'la opción "Descargar"');
  if (!dl) {
    // v2.12.1: qué había de verdad (la cuenta 2 del usuario falló aquí y no se pudo ver por qué)
    const items = $$(CONFIG.menuItemSelector, $(CONFIG.overlayContainerSelector) || document.createElement("div")).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24));
    const diag = `menú con [${[...new Set(items)].join(" | ") || "nada"}] · tile: ${tileHasMedia(tile) ? "con miniatura" : "SIN miniatura"}${tile.isConnected ? "" : " · DESCONECTADO"} · «${tileText(tile).slice(0, 50)}»`;
    await closeOverlays();
    throw new Error(`no aparece "Descargar" en el menú contextual (${diag})${visibilityNote()}`);
  }
  clickDeep(dl);
  const options = resolutionFallbacks(resolution, kind);
  // v2.12.1 (DOM real, cuenta sin PRO): «1080p/4K … Actualizar» están DESHABILITADOS; solo «720p Tamaño original» sirve.
  const disabledItem = (el) => !!el && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || !!$$("button", el).some((b) => b.disabled) || /actualizar|upgrade/i.test(el.textContent || ""));
  for (let i = 0; i < options.length; i++) {
    const opt = await tryWait(() => { const it = findMenuItemByText(options[i]); return it && !disabledItem(it) ? it : null; }, i === 0 ? 5000 : 1500, `la opción ${options[i]} (activa)`);
    if (opt) {
      if (i > 0) log("warn", `No existe la opción ${options[0]} en esta cuenta; uso ${options[i]}.`);
      clickDeep(opt);
      return options[i];
    }
  }
  await closeOverlays();
  throw new Error(`no encuentro ninguna resolución (${options.join(", ")}) en el submenú "Descargar"`);
}

// Turno de descarga (una a la vez en toda la extensión).
async function armDownload(n, relPath, mode) {
  const tq = Date.now();
  for (let waitedLogged = false; ; ) {
    throwIfStopped();
    const arm = await send({ type: "DL_ARM", acc: ACC, scene: n, relPath, mode });
    if (arm && arm.ok) return arm;
    if (arm && arm.busy) {
      if (!waitedLogged) { log("info", "La otra cuenta está descargando; espero mi turno (las descargas van de una en una)."); waitedLogged = true; }
      if (Date.now() - tq > 15 * 60000) throw new Error("llevo 15 min esperando turno para descargar");
      await sleep(2000);
      continue;
    }
    throw new Error("el service worker de la extensión no responde (recarga la extensión y pulsa F5)");
  }
}
function sceneRelPath(n, kind, cfg) {
  return `${cfg.batchFolder}/${buildVideoFilename(cfg.nameFormat, cfg.prefix, n, kind === "video" ? "mp4" : "png")}`;
}
// Espera a que el gestor de descargas (background.js) termine el trabajo.
async function awaitDownloadJob(arm, start) {
  let finished = false;
  try {
    await start();
    const t0 = Date.now();
    let createdAt = null;
    let lastNote = t0;
    let promptNoted = 0;
    for (;;) {
      throwIfStopped();
      const st = await send({ type: "DL_STATUS", jobId: arm.jobId });
      if (!st || st.status === "gone") throw new Error("el gestor de descargas perdió la pista de esta descarga");
      if (st.status === "done") { finished = true; return st.result; }
      if (st.status === "failed") { finished = true; throw new Error(st.result && st.result.error ? st.result.error : "la descarga falló"); }
      if (st.status !== "armed" && !createdAt) createdAt = Date.now();
      if (st.promptWarned && !promptNoted) {
        promptNoted = Date.now();
        ui.setStatus('Chrome está pidiendo "Guardar como": contesta el diálogo o usa el destino "Carpeta elegida"', "warn");
      }
      if (promptNoted && Date.now() - promptNoted > 120000) {
        const err = new Error('Chrome pidió "Guardar como" y nadie lo contestó en 2 min. Usa el destino "Carpeta elegida" o desactiva "Preguntar dónde guardar"');
        err.noRetry = true;
        throw err;
      }
      if (!createdAt && Date.now() - t0 > CONFIG.download.createdTimeoutMs) {
        throw new Error(`Chrome no registró ninguna descarga en ${CONFIG.download.createdTimeoutMs / 1000} s (Flow no entregó el archivo)${visibilityNote()}`);
      }
      if (createdAt && Date.now() - createdAt > CONFIG.download.completeTimeoutMs) throw new Error(`la descarga empezó pero no terminó en ${CONFIG.download.completeTimeoutMs / 1000} s`);
      if (Date.now() - lastNote > 30000) {
        lastNote = Date.now();
        log("info", createdAt ? "La descarga sigue en curso…" : `Sigo esperando a que Flow entregue el archivo (${Math.round((Date.now() - t0) / 1000)} s)…`);
      }
      await sleep(1500);
    }
  } finally {
    if (!finished) send({ type: "DL_DISARM", jobId: arm.jobId });
  }
}
// Método 1 [V en v2.1]: clic derecho → Descargar → resolución.
async function downloadViaMenu(n, tile, kind, cfg, mode, via) {
  const arm = await armDownload(n, sceneRelPath(n, kind, cfg), mode);
  return awaitDownloadJob(arm, async () => {
    const res = await openDownloadMenu(tile, kind, cfg.resolution, via || "right");
    log("info", `He pedido la descarga (${res}). Espero a que Chrome la registre (Flow prepara el archivo; 1080p puede tardar)…`);
  });
}
// Método 2 (plan B): guardar directamente la FUENTE del vídeo que muestra el
// tile (<video src>), sin menú. Es el vídeo en su tamaño original.
async function downloadViaSource(n, tile, cfg, mode) {
  const url = videoSrcOf(tile);
  if (!url) throw new Error("el tile no tiene fuente de vídeo que se pueda guardar directamente");
  const arm = await armDownload(n, sceneRelPath(n, "video", cfg), mode);
  return awaitDownloadJob(arm, async () => {
    log("info", `Plan B: guardo directamente la fuente del vídeo (${url.startsWith("blob:") ? "blob" : "https"}), sin pasar por el menú de Flow.`);
    const r = await send({ type: "DL_DIRECT", jobId: arm.jobId, url, mime: "video/mp4" });
    if (!r || !r.ok) throw new Error((r && r.error) || "el gestor de descargas no aceptó la descarga directa");
  });
}

// Destino de las descargas: se decide una vez por lote (y se cambia solo a
// "Descargas de Chrome" si la carpeta elegida deja de tener permiso).
let destModeCache = null;
async function resolveDestMode(cfg) {
  if (destModeCache) return destModeCache;
  let mode = cfg.destMode === "folder" ? "folder" : "downloads";
  if (mode === "folder") {
    let fs = await send({ type: "FS_STATUS" });
    if (!fs || fs.ok === false) { await sleep(2000); fs = await send({ type: "FS_STATUS" }); }
    if (!fs || fs.ok === false || !fs.has || fs.perm !== "granted") {
      const why = !fs || fs.ok === false ? `no pude consultar la carpeta (${(fs && fs.error) || "sin respuesta"})` : !fs.has ? "no hay carpeta elegida" : `Chrome no da permiso de escritura (${fs.perm})`;
      log("error", `No puedo usar la carpeta elegida (${why}). Descargo a Descargas/MundoFutFlow/${cfg.batchFolder}/ con Chrome: si tienes "Preguntar dónde guardar" activado, saldrá el diálogo. Para evitarlo: panel de la extensión → Salida → "Conceder acceso".`);
      send({ type: "NOTIFY", title: "Carpeta sin permiso", message: 'No pude escribir en la carpeta elegida. Abre el panel de la extensión y pulsa "Conceder acceso".', sticky: true });
      mode = "downloads";
    } else {
      log("info", `Destino: carpeta elegida "${fs.name}" → ${fs.name}/${cfg.batchFolder}/`);
    }
  } else {
    log("info", `Destino: Descargas de Chrome → MundoFutFlow/${cfg.batchFolder}/`);
  }
  destModeCache = mode;
  return mode;
}

// Descarga el vídeo (o imagen) de UNA escena, con reintentos. Nunca lanza
// salvo "Detener": un fallo queda anotado en la escena y se reintenta en la
// pasada final de descargas.
async function downloadScene(n, kind, cfg) {
  const prev = { scene: ctxScene, phase: ctxPhase };
  ctxScene = n;
  ctxPhase = "downloads";
  try {
    await resolveDestMode(cfg);
    ui.setStatus(`Escena ${pad3(n)}: descargando`, "info");
    await setStep(n, "download", "running");
    let lastErr = null;
    // Plan de intentos: menú (resolución elegida) → menú → fuente directa →
    // menú a 720p → fuente directa. Entre intentos se espera cada vez más y
    // el tile se vuelve a buscar desde cero.
    // v2.10.1: si el menú no entrega nada en 90 s, enseguida la fuente directa
    // (no se tiene a la otra cuenta esperando turno 15 min).
    // v2.11: el tile real no trae <video>, así que "source" solo sirve si hay fuente; si no, se usa
    // el botón «Más opciones» del tile ("more") como segunda vía de abrir el mismo menú.
    const plan = kind === "video" ? ["menu", "more", "source", "menu720", "more"] : ["menu", "more", "menu"];
    const waits = [0, 8000, 20000, 45000, 90000]; // v2.12.1: más margen por si Flow aún termina el vídeo
    for (let i = 0; i < plan.length; i++) {
      const how = plan[i];
      try {
        if (waits[i]) await sleep(waits[i]);
        throwIfStopped();
        // Nunca descargar mientras Flow aún genera (el tile podría ser el provisional).
        if (kind === "video" && $$(CONFIG.pendingTileTag).length > ignoredPending) {
          await tryWait(() => $$(CONFIG.pendingTileTag).length <= ignoredPending, 5 * 60000, "que Flow termine de generar antes de descargar");
        }
        const tile = kind === "video" ? await findVideoTileForScene(n) : await findWithScroll(() => findImageTileByLabel(pad3(n)), CONFIG.imageTileTag);
        if (!tile) throw new Error(kind === "video" ? "no encuentro el vídeo de esta escena en la cuadrícula" : "no encuentro la imagen");
        if (kind === "video" && isErrorTile(tile)) { const err = new Error(`el tile de esta escena es un ERROR de Flow, no un vídeo («${tileText(tile)}»)`); err.noRetry = true; throw err; }
        // Un tile de vídeo SIN miniatura no es un vídeo (provisional o fallo): no tiene «Descargar».
        if (kind === "video" && !tileHasMedia(tile)) {
          const okMedia = await tryWait(() => tileHasMedia(tile), 45000, "la miniatura del vídeo");
          if (!okMedia) throw new Error(`el tile de esta escena no tiene vídeo (sin miniatura; dice: «${tileText(tile)}»)`);
        }
        if (kind === "video") { hoverTile(tile); await sleep(800); }
        if (how === "source" && !videoSrcOf(tile)) continue; // sin <video> (lo normal en Flow real) no hay fuente que guardar
        let r;
        if (how === "source") r = await downloadViaSource(n, tile, cfg, destModeCache);
        else {
          const useCfg = how === "menu720" && cfg.resolution !== "720p" ? { ...cfg, resolution: "720p" } : cfg;
          if (useCfg !== cfg) log("warn", "Pido la versión 720p (tamaño original) por si el 1080p es lo que falla.");
          r = await downloadViaMenu(n, tile, kind, useCfg, destModeCache, how === "more" ? "more" : "right");
        }
        if (!r.nameOk) {
          await setStep(n, "download", "review", { file: r.path, error: `se guardó con otro nombre: ${r.path}` });
          log("error", `Guardado pero con otro nombre: ${r.path}.`);
        } else {
          await setStep(n, "download", "done", { file: r.path });
          log("ok", `Guardado: ${r.path}`);
        }
        return true;
      } catch (e) {
        if (e instanceof StopError) throw e;
        lastErr = e.message;
        await closeOverlays();
        if (destModeCache === "folder" && /permiso|carpeta de destino|no hay ninguna carpeta/i.test(e.message)) {
          destModeCache = "downloads";
          log("error", `No puedo escribir en la carpeta elegida (${e.message}). Paso a guardar en Descargas/MundoFutFlow/${cfg.batchFolder}/ (si tienes "Preguntar dónde guardar" activado, Chrome preguntará).`);
          send({ type: "NOTIFY", title: "Sin permiso en la carpeta elegida", message: "Guardo en Descargas/MundoFutFlow. Abre el panel de la extensión y pulsa «Conceder acceso» para la próxima vez.", sticky: true });
        }
        const t0 = kind === "video" ? videoElByScene.get(n) : null;
        log("warn", `Descarga fallida (intento ${i + 1}/${plan.length}, ${how === "source" ? "fuente directa" : how === "more" ? "botón ⋮" : "menú"}): ${e.message}${t0 && t0.isConnected && !tileHasMedia(t0) ? ` · el tile no tiene vídeo (dice: «${tileText(t0)}»)` : ""}`);
        if (e.noRetry) break;
      }
    }
    await setStep(n, "download", "failed", { error: `no se pudo descargar: ${lastErr}` });
    log("error", `No se pudo descargar la escena ${pad3(n)} (${lastErr}). Lo reintento al final del lote.`);
    return false;
  } finally {
    ctxScene = prev.scene;
    ctxPhase = prev.phase;
  }
}

// Pasada final: descarga lo que no se descargó al generarse (modo "solo
// imágenes", PRUEBA de descarga, reanudación tras F5 o un fallo anterior).
async function phaseDownloads(cfg) {
  ctxPhase = "downloads";
  ctxScene = null;
  batch.phase = "downloads";
  await saveBatch();
  const kind = cfg.genMode === "imagesOnly" ? "image" : "video";
  const stepOf = (s) => (kind === "video" ? s.video : s.image);
  for (const n of batch.order) {
    const s = batch.scenes[n];
    if (stepOf(s) !== "done" && ["pending", "failed"].includes(s.download)) await setStep(n, "download", "skipped");
  }
  const list = batch.order.filter((n) => stepOf(batch.scenes[n]) === "done" && !["done", "review"].includes(batch.scenes[n].download));
  const already = batch.order.filter((n) => batch.scenes[n].download === "done").length;
  if (!list.length) { log("info", already ? `Descargas: ${already} ya guardada(s) al generarse; no queda nada pendiente.` : "No hay nada que descargar."); return; }
  log("info", `Fase 2B: descargo ${list.length} ${kind === "video" ? "vídeo(s)" : "imagen(es)"} pendiente(s) de uno en uno.`);
  for (const n of list) {
    throwIfStopped();
    await downloadScene(n, kind, cfg);
  }
  ctxScene = null;
}

// ============================================================ ORQUESTACIÓN
function reasonOf(s) {
  return s.error || (s.video === "review" ? "revisar el vídeo en Flow" : "fallo sin detalle");
}

async function finishRun(label) {
  const sum = summarizeBatch(batch);
  const unfinished = batch.status !== "done" ? batch.order.filter((n) => !sum.done.includes(n) && ![...sum.failed, ...sum.review, ...sum.nopoints].includes(n)) : [];
  for (const n of unfinished) if (!batch.scenes[n].error) batch.scenes[n].error = `sin terminar (${label})`;
  const problems = [...sum.failed, ...sum.review, ...sum.nopoints, ...unfinished];
  const total = batch.order.length;
  const where = batch.config.destMode === "folder" ? `carpeta elegida/${batch.config.batchFolder}` : `Descargas/MundoFutFlow/${batch.config.batchFolder}`;
  ctxScene = null;
  ctxPhase = "run";
  if (batch.config.genMode === "sendTest") {
    for (const n of batch.order) for (const k of ["image", "video", "download"]) batch.scenes[n][k] = "skipped";
    saveBatch();
    send({ type: "RUN_COMPLETE", acc: ACC, summary: { doneCount: 0, total: 0, problemScenes: [] } });
    ui.setStatus("Prueba de envío terminada: mira el log", "ok");
    return;
  }
  if (batch.config.genMode === "dryRun" && label === "completo") {
    const reached = batch.order.filter((n) => /ensayo/.test(batch.scenes[n].error || ""));
    const msg = `ENSAYO terminado en ${ACC}: ${reached.length}/${total} escenas llegaron hasta el aviso de coste y se rechazaron. 0 puntos gastados.${problems.length ? ` Fallaron antes: ${problems.map(pad3).join(", ")}.` : ""}`;
    log(problems.length || reached.length < total ? "warn" : "ok", msg);
    send({ type: "NOTIFY", title: `Ensayo ${ACC} terminado`, message: msg, sticky: problems.length > 0 });
    send({ type: "RUN_COMPLETE", acc: ACC, summary: { doneCount: reached.length, total, problemScenes: problems } });
    ui.setStatus(`Ensayo: ${reached.length}/${total} hasta el aviso de coste`, problems.length ? "warn" : "ok");
    return;
  }
  if (problems.length) {
    log("warn", `RESUMEN ${ACC} (${label}): ${sum.done.length}/${total} escenas completas en ${where}. A revisar: ${problems.map(pad3).join(", ")}.`);
    for (const n of problems) log("error", `Escena ${pad3(n)}: ${reasonOf(batch.scenes[n])}`, { scene: n });
  } else {
    log("ok", `RESUMEN ${ACC} (${label}): ${sum.done.length}/${total} escenas completas en ${where}. Sin fallos.`);
  }
  send({
    type: "NOTIFY",
    title: problems.length ? `Cuenta ${ACC}: terminado con avisos` : `Cuenta ${ACC}: terminado ✅`,
    message: problems.length ? `${sum.done.length}/${total} listos. Revisar: ${problems.map((n) => `${pad3(n)} (${reasonOf(batch.scenes[n]).slice(0, 60)})`).join("; ")}` : `${sum.done.length}/${total} vídeos en ${where}`,
    sticky: problems.length > 0,
  });
  send({ type: "RUN_COMPLETE", acc: ACC, summary: { doneCount: sum.done.length, total, problemScenes: problems } });
  ui.setStatus(problems.length ? `Terminado con avisos (${problems.map(pad3).join(", ")})` : "Terminado ✅", problems.length ? "warn" : "ok");
}

// PRUEBA DE ENVÍO (0 puntos): manda al Agent un mensaje que no genera nada y
// apunta qué forma de escribir/enviar acepta Flow en esta pestaña.
async function runSendTest() {
  ctxPhase = "setup";
  log("info", `PRUEBA DE ENVÍO: escribo un mensaje de prueba (no genera nada, 0 puntos)${sendDiag($(CONFIG.generateButtonSelector))}.`);
  const res = await sendWithRateLimit(() => writePrompt("Responde únicamente con la palabra OK. No generes ninguna imagen ni vídeo."), { maxPoints: 0, dryRun: true, onlySend: true });
  if (res.type === "sent") log("ok", `PRUEBA DE ENVÍO correcta: Flow aceptó el mensaje (escritura "${writeMethod}", envío "${res.via}")${sendDiag($(CONFIG.generateButtonSelector))}.`);
  else log("error", `PRUEBA DE ENVÍO fallida: ${res.error || res.type}. Pásale este log a Claude.`);
}

// PRUEBA DE DESCARGA (0 puntos): asigna a las escenas del rango vídeos que
// YA existen en el proyecto (los primeros de la cuadrícula) para probar la
// Fase 2B de verdad: nombre, carpeta nueva, espera a que termine cada uno.
async function pickExistingVideos() {
  ctxPhase = "downloads";
  const tiles = $$(CONFIG.videoTileTag).filter((t) => !/no se ha podido generar/i.test(t.textContent || ""));
  log("info", `PRUEBA DE DESCARGA: hay ${tiles.length} vídeo(s) en la cuadrícula; uso los ${Math.min(tiles.length, batch.order.length)} primeros (no tienen por qué corresponder a esas escenas).`);
  batch.order.forEach((n, i) => {
    const t = tiles[i];
    if (t) { videoElByScene.set(n, t); setSceneStep(batch, n, "video", "done", { videoKey: tileKey(t) }); }
    else setSceneStep(batch, n, "video", "skipped", { error: "no hay tantos vídeos en el proyecto para la prueba" });
  });
  await saveBatch();
}

// Sin puntos o coste no permitido: lo que faltaba por generar queda marcado
// (con el motivo) y no se intenta; las descargas pendientes se saltan.
function markRemaining(e) {
  const st = e instanceof NoPointsError ? "nopoints" : "failed";
  for (const n of batch.order) {
    const s = batch.scenes[n];
    for (const step of ["image", "video"]) if (s[step] === "pending" || s[step] === "running") { s[step] = st; if (!s.error) s.error = e.message; }
    if ((s.download === "pending" || s.download === "running") && s.video !== "done") s.download = "skipped";
  }
  log("error", `Paro de GENERAR en esta cuenta: ${e.message}. Lo ya generado se descarga igualmente.`);
  saveBatch();
}

async function runBatch(cfg, resumeState) {
  if (running) return { ok: false, error: "ya hay un lote en marcha en esta pestaña" };
  running = true;
  const claim = await send({ type: "CLAIM", acc: ACC });
  if (claim && claim.ok === false) {
    running = false;
    log("error", `No empiezo: ${claim.error}. Cierra la pestaña duplicada.`, { phase: "setup", scene: null });
    return { ok: false, error: claim.error };
  }
  stopRequested = false;
  destModeCache = null;
  ignoredPending = 0;
  const isResume = !!resumeState;
  batch = resumeState ? prepareResume(resumeState) : createBatchState({ batchId: cfg.batchId || String(Date.now()), accountKey: ACC, sceneNumbers: cfg.sceneNumbers, config: cfg });
  if (cfg.genMode === "dryRun") cfg.dryRun = true;
  if (["animationsOnly", "dryRun", "downloadTest", "sendTest"].includes(cfg.genMode) && !isResume) for (const n of batch.order) batch.scenes[n].image = "done";
  if (cfg.genMode === "imagesOnly" && !isResume) for (const n of batch.order) batch.scenes[n].video = "skipped";
  await saveBatch();
  send({ type: "HEARTBEAT", acc: ACC, on: true });
  ctxPhase = "setup";
  log("info", `${isResume ? "REANUDO" : "EMPIEZA"} el lote en ${ACC}: escenas ${batch.order.map(pad3).join(", ")} · modo ${cfg.genMode} · ${cfg.resolution} · nombres ${buildVideoFilename(cfg.nameFormat, cfg.prefix, batch.order[0] || 1)} · carpeta ${cfg.batchFolder} · pestaña ${document.visibilityState === "visible" ? "visible" : "OCULTA"}${cfg.armed ? " · preparada para segundo plano ✓" : " · SIN preparar para segundo plano"}.`);
  if (!cfg.armed && document.visibilityState !== "visible") log("warn", "Esta pestaña está oculta y SIN preparar: Flow puede quedarse parado. Entra en ella y pulsa la cereza una vez (o Alt+Shift+C).");
  let label = "completo";
  let reloading = false;
  setBackgroundMode(true);
  // Foco simulado (depurador): Flow solo acepta envíos si cree tener el foco.
  const dbg = await send({ type: "DBG_ON" });
  if (dbg && dbg.ok) log("info", 'Foco activado para trabajar sin mirar Flow (Chrome muestra la barra "Cerezium ha empezado a depurar este navegador"; no la cierres, se quita sola al terminar).');
  else log("warn", `No pude activar el foco simulado (${(dbg && dbg.error) || "sin respuesta"}). Si no miras esta pestaña, Flow puede no aceptar los envíos.`);
  try {
    const box = await tryWait(() => getPromptBox(), 90000, "la caja de prompt de Flow");
    if (!box) {
      const shown = (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim().slice(0, 140);
      throw new Error(`no encuentro la caja de prompt de Flow tras 90 s (pestaña ${document.visibilityState}; URL ${location.pathname}; la página muestra: "${shown || "nada"}")`);
    }
    if (cfg.applySettings && !isResume && !["sendTest", "downloadTest"].includes(cfg.genMode)) await ensureAgentSettings();
    if (cfg.genMode === "sendTest") {
      await runSendTest();
      batch.status = "done";
      return { ok: true };
    }
    // Vídeos que ya había antes del lote (para reconocer luego los nuevos).
    if (!Array.isArray(batch.startVideoKeys)) { batch.startVideoKeys = $$(CONFIG.videoTileTag).map(tileKey); await saveBatch(); }
    if (["paired", "imagesOnly"].includes(cfg.genMode)) await phaseImages(cfg, isResume);
    if (cfg.genMode === "downloadTest") await pickExistingVideos();
    let halt = null;
    if (["paired", "animationsOnly", "dryRun"].includes(cfg.genMode)) {
      try {
        await phaseVideos(cfg);
      } catch (e) {
        if (!(e instanceof NoPointsError || e instanceof CostError)) throw e;
        // Se deja de GENERAR, pero lo ya generado se descarga igualmente.
        halt = e;
        markRemaining(e);
      }
      if (!cfg.dryRun) await resolveReviewScenes(cfg);
    }
    await phaseDownloads(cfg);
    batch.status = halt ? (halt instanceof NoPointsError ? "nopoints" : "error") : "done";
    batch.phase = "done";
    if (halt) label = halt instanceof NoPointsError ? "sin puntos" : "coste no permitido";
  } catch (e) {
    if (e instanceof ReloadError) {
      reloading = true;
      batch.autoReloads = (batch.autoReloads || 0) + 1;
      batch.status = "running";
      label = null;
      log("warn", `Recupero solo: ${e.message}. Recargo la página de Flow (F5) y sigo desde donde iba (recarga automática ${batch.autoReloads}/2).`);
    } else if (e instanceof StopError) {
      batch.status = "stopped";
      label = "detenido";
      log("warn", "Lote detenido por el usuario.");
    } else if (e instanceof NoPointsError || e instanceof CostError) {
      batch.status = e instanceof NoPointsError ? "nopoints" : "error";
      label = e instanceof NoPointsError ? "sin puntos" : "coste no permitido";
      markRemaining(e);
    } else {
      batch.status = "error";
      label = "error inesperado";
      log("error", `Error inesperado: ${e.message}`);
      console.error(e);
    }
  } finally {
    setBackgroundMode(false);
    running = false;
    await closeOverlays().catch(() => {});
    for (const n of batch.order) for (const step of ["image", "video", "download"]) if (batch.scenes[n][step] === "running") batch.scenes[n][step] = step === "video" && batch.scenes[n].videoApproved ? "review" : "pending";
    await saveBatch();
    if (reloading) {
      // Sin RUN_COMPLETE: el lote sigue "en marcha" y se reanuda al cargar.
      batch.resumeNow = true;
      await saveBatch();
      setTimeout(() => location.reload(), 1500);
    } else {
      send({ type: "HEARTBEAT", acc: ACC, on: false });
      await finishRun(label);
    }
  }
  return { ok: true };
}

// ============================================ BLOB → carpeta (vía offscreen)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function fetchBlobToOffscreen({ url, jobId, relPath, mime }) {
  let blob;
  try {
    blob = await (await fetch(url)).blob();
  } catch (e) {
    return { ok: false, error: `no pude leer el archivo de Flow (${e.message}); puede que Flow ya lo haya liberado` };
  }
  const CH = 4 * 1024 * 1024;
  const total = Math.max(1, Math.ceil(blob.size / CH));
  let last = null;
  for (let i = 0; i < total; i++) {
    const data = await blobToBase64(blob.slice(i * CH, (i + 1) * CH));
    last = await chrome.runtime.sendMessage({ target: "offscreen", type: "FS_CHUNK", jobId, index: i, last: i === total - 1, relPath, mime: blob.type || mime, data });
    if (!last || !last.ok) return last || { ok: false, error: "el escritor de archivos no respondió" };
  }
  return last;
}

// ============================================================== MENSAJES
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false;
  if (msg.type === "TICK") { wakeAll(); if (running) document.dispatchEvent(new CustomEvent("fbr-tick")); return false; }
  if (msg.type === "START_RUN") {
    if (running) { sendResponse({ ok: false, error: "ya hay un lote en marcha en esta pestaña" }); return false; }
    runBatch(msg, null);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "NEW_PROJECT") {
    // la home de Flow puede tardar en pintar el botón
    tryWait(() => clickNewProject(), 20000, "el botón «Nuevo proyecto»").then((ok) => sendResponse(ok ? { ok: true } : { ok: false, error: "no encuentro el botón «Nuevo proyecto»" }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "STOP_QUEUE") {
    if (running) {
      stopRequested = true;
      wakeAll();
      log("warn", "Detener recibido: paro en cuanto termine el paso en curso.");
    }
    return false;
  }
  if (msg.type === "FETCH_BLOB_TO_OFFSCREEN") {
    fetchBlobToOffscreen(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "PING") { sendResponse({ ok: true, acc: ACC, running, visible: document.visibilityState }); return false; }
  return false;
});

// ================================================ REANUDAR / AUTO-INICIO
async function onPageLoad() {
  ui.init();
  let d;
  try { d = await chrome.storage.local.get([BATCH_KEY, autoRunStorageKey(location.href)]); } catch (e) { return; }
  const b = d[BATCH_KEY];
  if (b) ui.setBatch(b);
  if (b && b.status === "running" && Date.now() - b.updatedAt < 12 * 3600 * 1000 && /\/project\//.test(location.href)) {
    const auto = !!b.resumeNow; // recarga hecha por la propia extensión para recuperarse
    if (auto) {
      b.resumeNow = false;
      await storageSet({ [BATCH_KEY]: b });
      log("info", "Página recargada para recuperarme del fallo; reanudo el lote en 5 s.", { phase: "run", scene: null });
    }
    const go = await ui.countdown(auto ? 5 : 15, auto ? "Página recargada para recuperarme de un fallo. Sigo con el lote en {s} s…" : "Hay un lote a medias en esta cuenta. Lo reanudo en {s} s…");
    if (!go) {
      b.status = "stopped";
      await storageSet({ [BATCH_KEY]: b });
      log("warn", "Reanudación cancelada por el usuario.", { phase: "run", scene: null });
      return;
    }
    await tryWait(() => getPromptBox(), 60000, "que Flow cargue");
    runBatch(b.config, b);
    return;
  }
  // Auto-inicio (config guardada por cuenta desde el panel).
  const key = autoRunStorageKey(location.href);
  const cfg = d[key];
  if (!cfg || !cfg.enabled || cfg.lastRunAt || !/\/project\//.test(location.href) || !cfg.run) return;
  const go = await ui.countdown(10, `Auto-inicio de ${ACC} en {s} s…`);
  if (!go) return;
  await tryWait(() => getPromptBox(), 60000, "que Flow cargue");
  cfg.lastRunAt = Date.now();
  await storageSet({ [key]: cfg });
  const run = { ...cfg.run, batchFolder: buildBatchFolderName(new Date(), cfg.run.prefix), batchId: String(Date.now()) };
  runBatch(run, null);
}

// ======================================================= PANEL EN LA PÁGINA
// Panel minimizable dentro de Flow (Shadow DOM: no hereda ni rompe estilos).
// Plegado es una píldora pequeña en una esquina; desplegado muestra progreso
// por escena y las últimas líneas del log. No tapa la caja del Agent.
const ui = (() => {
  let root = null;
  let host = null;
  const st = { expanded: false, corner: "bl", status: "Listo", level: "info", batch: null, fatal: null, hidden: false };
  const ICON = {
    image: '<path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 16l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 10l5-3v10l-5-3z" fill="none" stroke="currentColor" stroke-width="2"/>',
    download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  const svg = (p, s) => `<svg viewBox="0 0 24 24" width="${s || 14}" height="${s || 14}" aria-hidden="true">${p}</svg>`;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function init() {
    if (host) return;
    host = document.createElement("div");
    host.id = "fbr-host";
    host.style.cssText = "position:fixed;z-index:2147483000;bottom:14px;left:14px;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial}
      *{box-sizing:border-box;font-family:"Google Sans",Roboto,system-ui,sans-serif}
      .pill{display:flex;align-items:center;gap:8px;max-width:330px;padding:7px 12px 7px 9px;border-radius:999px;border:1px solid #34343a;background:rgba(20,20,22,.94);color:#f4f1f2;font-size:12px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);backdrop-filter:blur(6px);transition:transform .15s,border-color .15s}
      .pill:hover{transform:translateY(-1px);border-color:#4a4a52}
      .pill:focus-visible,button:focus-visible{outline:2px solid #ff4d6d;outline-offset:2px}
      .dot{width:9px;height:9px;border-radius:50%;background:#ff4d6d;flex:none}
      .dot.run{animation:pulse 1.4s infinite}
      .ok .dot{background:#f5c2cd}.warn .dot{background:#ffbf5e}.error .dot{background:#ff8a5c}
      .error.pill{border-color:#ff8a5c}
      @keyframes pulse{50%{opacity:.35}}
      @media (prefers-reduced-motion:reduce){.dot.run{animation:none}.pill{transition:none}}
      .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .card{width:340px;margin-bottom:8px;padding:12px;border-radius:14px;border:1px solid #34343a;background:rgba(20,20,22,.97);color:#f4f1f2;font-size:12px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
      .row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      h2{margin:0;font-size:13px;font-weight:600}
      .brand{display:flex;align-items:center;gap:6px}
      .bar{height:6px;border-radius:99px;background:#1b1b1e;overflow:hidden;margin:10px 0}
      .bar>i{display:block;height:100%;background:linear-gradient(90deg,#ff4d6d,#a3142f);transition:width .4s}
      .scenes{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .sc{display:flex;align-items:center;gap:3px;padding:3px 6px;border-radius:8px;background:#1b1b1e;border:1px solid #26262a;font-variant-numeric:tabular-nums}
      .sc b{font-weight:600;margin-right:2px}
      .s-pending{color:#6f696c}.s-running{color:#ff4d6d}.s-done{color:#f5c2cd}.s-failed,.s-nopoints{color:#ff8a5c}.s-review{color:#ffbf5e}.s-skipped{color:#6f696c;opacity:.5}
      .log{color-scheme:dark;max-height:150px;overflow:auto;font:11px/1.45 ui-monospace,Consolas,monospace;background:#09090a;border-radius:8px;padding:6px 8px;color:#cfc8cb}
      .log .error{color:#ff8a5c}.log .warn{color:#ffbf5e}.log .ok{color:#f5c2cd}
      .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .btns button{white-space:nowrap;padding:5px 9px}
      button{font:inherit;font-size:12px;color:#f4f1f2;background:#1b1b1e;border:1px solid #34343a;border-radius:8px;padding:5px 10px;cursor:pointer}
      button:hover{background:#26262a}
      button.danger{background:#4a0e1d;border-color:#a3142f}
      .fatal{margin-bottom:8px;padding:8px;border-radius:8px;background:#4a0e1d;color:#ffd6de}
      .cd{display:flex;gap:6px;align-items:center;margin-bottom:8px;padding:8px 10px;border-radius:10px;background:#1b1b1e;color:#f4f1f2;font-size:12px;border:1px solid #ff4d6d}
    </style><div id="wrap"></div>`;
    (document.body || document.documentElement).appendChild(host);
    chrome.storage.local.get("fbrPagePanel").then((d) => {
      if (d.fbrPagePanel) Object.assign(st, { corner: d.fbrPagePanel.corner || "bl" });
      place();
      render();
    }).catch(() => render());
  }
  function place() {
    if (!host) return;
    const c = st.corner;
    host.style.top = c[0] === "t" ? "14px" : "auto";
    host.style.bottom = c[0] === "b" ? "14px" : "auto";
    host.style.left = c[1] === "l" ? "14px" : "auto";
    host.style.right = c[1] === "r" ? "14px" : "auto";
  }
  function progress() {
    if (!st.batch) return null;
    return summarizeBatch(st.batch);
  }
  function render() {
    if (!root) return;
    const wrap = root.getElementById("wrap");
    const p = progress();
    const lvl = st.fatal ? "error" : st.level;
    const runningNow = running && !st.fatal;
    const pct = p ? p.percent : 0;
    let card = "";
    if (st.expanded) {
      const scenes = st.batch
        ? st.batch.order.map((n) => {
            const s = st.batch.scenes[n];
            return `<span class="sc" title="Escena ${pad3(n)}: imagen ${s.image}, vídeo ${s.video}, descarga ${s.download}${s.error ? " — " + esc(s.error) : ""}"><b>${pad3(n)}</b><span class="s-${s.image}">${svg(ICON.image, 12)}</span><span class="s-${s.video}">${svg(ICON.video, 12)}</span><span class="s-${s.download}">${svg(ICON.download, 12)}</span></span>`;
          }).join("")
        : "";
      const lines = localLog.slice(-40).map((e) => `<div class="${e.level}">${esc(formatLogEntry(e))}</div>`).join("");
      card = `<div class="card" role="region" aria-label="Cerezium Autopilot">
        ${st.fatal ? `<div class="fatal" role="alert">${esc(st.fatal)}</div>` : ""}
        <div class="row"><h2 class="brand"><svg viewBox="0 0 128 128" width="18" height="18" aria-hidden="true"><path d="M67 27C62 44 52 58 45 72M67 27C71 45 78 57 86 67" fill="none" stroke="#e79aab" stroke-width="7" stroke-linecap="round"/><path d="M67 27C74 15 90 12 101 19C93 31 78 34 67 27Z" fill="#a3142f"/><circle cx="44" cy="86" r="21" fill="#f0284f"/><circle cx="87" cy="81" r="21" fill="#f0284f"/></svg>Cerezium · ${esc(ACC)}</h2><span>${pct}%</span></div>
        <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
        <div class="scenes">${scenes || '<span style="color:#a9a2a5">Sin lote en esta cuenta.</span>'}</div>
        <div class="log" id="log" aria-live="polite">${lines || '<div style="color:#6f696c">El log aparecerá aquí.</div>'}</div>
        <div class="btns">
          ${runningNow ? '<button class="danger" id="stop">Detener</button>' : ""}
          <button id="panel" title="Abrir el panel de control de Cerezium">Panel</button><button id="copy">Copiar log</button><button id="move" title="Mover a otra esquina">Mover</button><button id="min">Plegar</button>
        </div></div>`;
    }
    const cd = st.countdown ? `<div class="cd" role="alert"><span>${esc(st.countdown.text.replace("{s}", st.countdown.left))}</span><button id="cdGo">Ya</button><button id="cdNo">Cancelar</button></div>` : "";
    const focusedId = root.activeElement && root.activeElement.id;
    wrap.innerHTML = `${cd}${card}<button class="pill ${lvl}" id="pill" aria-expanded="${st.expanded}" aria-label="Cerezium Autopilot: ${esc(st.fatal || st.status)}"><span class="dot ${runningNow ? "run" : ""}"></span><span class="txt">${esc(st.fatal || st.status)}${p && runningNow ? ` · ${pct}%` : ""}</span></button>`;
    const on = (id, fn) => { const el = root.getElementById(id); if (el) el.addEventListener("click", fn); };
    on("pill", () => { st.expanded = !st.expanded; render(); });
    on("min", () => { st.expanded = false; render(); });
    on("panel", () => { send({ type: "OPEN_PANEL" }); });
    on("stop", () => { stopRequested = true; wakeAll(); log("warn", "Detener pulsado en el panel de la página."); render(); });
    on("copy", async () => {
      try {
        const all = (await chrome.storage.local.get("fbrLog")).fbrLog || localLog;
        await navigator.clipboard.writeText(logToText(all, `Cerezium Autopilot v${chrome.runtime.getManifest().version} — log`));
        setStatus("Log copiado al portapapeles", "ok");
      } catch (e) { setStatus("No pude copiar el log: " + e.message, "error"); }
    });
    on("move", () => {
      const order = ["bl", "br", "tr", "tl"];
      st.corner = order[(order.indexOf(st.corner) + 1) % order.length];
      place();
      storageSet({ fbrPagePanel: { corner: st.corner } });
    });
    on("cdGo", () => st.countdown && st.countdown.resolve(true));
    on("cdNo", () => st.countdown && st.countdown.resolve(false));
    const lg = root.getElementById("log");
    if (lg) lg.scrollTop = lg.scrollHeight;
    if (focusedId && root.getElementById(focusedId)) root.getElementById(focusedId).focus();
  }
  let renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 120);
  }
  function setStatus(text, level) { st.status = text; st.level = level || "info"; queueRender(); }
  function onLog(e) {
    if (e.level === "error" || e.level === "warn" || e.level === "ok") setStatus(`${e.scene != null ? "E" + pad3(e.scene) + ": " : ""}${e.msg}`.slice(0, 140), e.level);
    else if (running) setStatus(`${e.scene != null ? "E" + pad3(e.scene) + " · " : ""}${e.msg}`.slice(0, 140), "info");
    queueRender();
  }
  function setBatch(b) { st.batch = b; queueRender(); }
  function fatal(msg) { st.fatal = msg; st.expanded = true; render(); }
  function countdown(secs, text) {
    return new Promise((resolve) => {
      let left = secs;
      const finish = (v) => { clearInterval(iv); st.countdown = null; render(); resolve(v); };
      st.countdown = { text, left, resolve: finish };
      render();
      const iv = setInterval(() => {
        left--;
        if (!st.countdown) return;
        st.countdown.left = left;
        if (left <= 0) finish(true);
        else render();
      }, 1000);
    });
  }
  return { init, onLog, setStatus, setBatch, fatal, countdown };
})();

onPageLoad();

} // fin de la guarda de doble carga
