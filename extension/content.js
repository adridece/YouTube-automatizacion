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
  imagesSettleMs: 15000, // el Agent renombra DESPUÉS de terminar
  assetListWaitMs: 10000,
  rateLimitMaxRetries: 4,
  download: { createdTimeoutMs: 180000, completeTimeoutMs: 300000, attempts: 3 },
  maxAttemptsPerScene: 2,
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
setInterval(wakeAll, 1000);

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
async function writePrompt(text) {
  const box = getPromptBox();
  if (!box) throw new Error('no encuentro la caja de prompt (selector: flow-agent-panel flow-rich-text-editor [contenteditable="true"])');
  setEditableValue(box, text);
  const head = text.replace(/\s+/g, " ").slice(0, 25);
  const ok = await tryWait(() => promptText().replace(/\s+/g, " ").includes(head), 4000, "que el texto aparezca en la caja");
  if (!ok) throw new Error("escribí el prompt pero no aparece en la caja de Flow");
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
  for (const a of ["data-id", "data-media-id", "data-asset-id", "data-key", "id"]) {
    const v = tile.getAttribute(a);
    if (v) return `${a}:${v}`;
  }
  const v = tile.querySelector("video");
  const vs = v && (v.getAttribute("src") || (v.querySelector("source") || {}).src || v.getAttribute("poster"));
  if (vs) return `src:${normalizeUrlKey(vs)}`;
  const img = tile.querySelector("img");
  if (img && img.getAttribute("src")) return `img:${normalizeUrlKey(img.getAttribute("src"))}`;
  const a = tile.querySelector("a[href]");
  if (a) return `a:${a.getAttribute("href")}`;
  if (!tile.__fbrSeq) tile.__fbrSeq = `seq:${Math.random().toString(36).slice(2, 10)}`;
  return tile.__fbrSeq;
}
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
  };
}
function newVideoTiles(before) {
  return $$(CONFIG.videoTileTag).filter((t) => !before.videoNodes.has(t) && !before.videoKeys.includes(tileKey(t)));
}
function imageTilesByLabel(label) {
  return $$(CONFIG.imageTileTag).filter((t) => tileTitle(t) === label);
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
function findPendingCostDialog() {
  const msgs = $$("flow-permission-message");
  for (let i = msgs.length - 1; i >= 0; i--) {
    const rows = $$(".option-row:not(.read-only):not([aria-disabled='true'])", msgs[i]);
    if (!rows.length) continue;
    const byLabel = (l) => rows.find((r) => (r.getAttribute("aria-label") || "").trim().toLowerCase() === l);
    const approveRow = byLabel(CONFIG.costDialogApproveText);
    if (!approveRow) continue;
    return { message: msgs[i], approveRow, rejectRow: byLabel(CONFIG.costDialogRejectText) || null, cost: parseCostFromText(msgs[i].textContent) };
  }
  return null;
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
async function sendAndConfirm({ maxPoints, onApproved, dryRun }) {
  const genBtn = $(CONFIG.generateButtonSelector);
  if (!genBtn) return { type: "error", error: "no encuentro el botón de generar (flow-agent-panel flow-generate-icon-button)" };
  if (isDisabledBtn(genBtn)) {
    const ok = await tryWait(() => !isDisabledBtn(genBtn), 15000, "a que se habilite el botón de generar");
    if (!ok) return { type: "error", error: "el botón de generar sigue deshabilitado tras 15 s (¿Flow sigue ocupado?)" };
  }
  const textBefore = agentPanelText();
  const before = snapshotTiles();
  const hadText = promptText().length > 0;
  const st = { approved: false, approveAt: 0, approveClicks: 0, answeredLogged: false, cost: null };

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
        st.approveAt = Date.now();
        st.approveClicks = 1;
        log("info", `Aviso de coste: ${dlg.cost} puntos (límite ${maxPoints}). He pulsado "Aprobar" (solo esta vez).`);
        if (onApproved) onApproved(dlg.cost);
      } else if (Date.now() - st.approveAt > 6000 && st.approveClicks < 3) {
        st.approveClicks++;
        st.approveAt = Date.now();
        log("warn", `El aviso de coste sigue SIN contestar tras pulsar "Aprobar". Lo pulso otra vez de otra forma (intento ${st.approveClicks}/3).`);
        pressRow(dlg.approveRow);
      }
    } else if (st.approved && !st.answeredLogged) {
      st.answeredLogged = true;
      log("ok", "Flow ha registrado la aprobación (el aviso ya no está pendiente).");
    }
    if (sig.policy) return { type: "policy" };
    if (sig.genError) return { type: "genError" };
    if (sig.cancelled && !st.approved) return { type: "cancelled" };
    const now = snapshotTiles();
    if (now.pending > before.pending || newVideoTiles(before).length || now.imageCount > before.imageCount) return { type: "started" };
    return null;
  };

  clickDeep(genBtn);
  log("info", 'He pulsado "generar".');
  let res = await tryWait(cond, CONFIG.startWaitMs, "que Flow empiece a generar");
  if (!res) {
    let sent = hadText && promptText().length === 0;
    if (!sent && !st.approved) {
      log("warn", `El clic en "generar" no parece haber enviado nada (el texto sigue en la caja)${visibilityNote()}. Lo pulso otra vez (solo una).`);
      clickDeep(genBtn);
      res = await tryWait(cond, CONFIG.startWaitMs, "que Flow empiece a generar (2º clic)");
      sent = promptText().length === 0;
    }
    if (!res && (sent || st.approved)) {
      log("info", `${st.approved ? "Coste aprobado" : "Mensaje enviado"}; la IA está pensando o hay cola. Espero hasta ${Math.round(CONFIG.sentWaitMs / 60000)} min SIN volver a pulsar "generar".`);
      res = await tryWait(cond, CONFIG.sentWaitMs, "que Flow empiece a generar (mensaje ya enviado)");
      if (!res) res = { type: st.approved ? "approvedNoStart" : "noStart", error: "Flow no empezó a generar nada a tiempo" };
    }
    if (!res) res = { type: "noStart", error: `el botón de generar no envió el mensaje ni al segundo clic${visibilityNote()}` };
  }
  return { ...res, approved: st.approved, cost: st.cost, before, textBefore };
}

// Envía reintentando si Flow dice "Estás preguntando demasiado rápido" (no
// cuenta como fallo). `prepare` vuelve a dejar la caja lista (texto/imagen).
async function sendWithRateLimit(prepare, opts) {
  for (let n = 0; ; n++) {
    throwIfStopped();
    await prepare(n);
    const res = await sendAndConfirm(opts);
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
  const res = await sendWithRateLimit(() => writePrompt(instruction), { maxPoints: CONFIG.maxAllowedPointsImages });
  if (res.type === "cost") throw new CostError(`las imágenes pedían ${res.cost} puntos (límite de seguridad ${CONFIG.maxAllowedPointsImages}); lo rechacé`);
  if (res.type !== "started") {
    const why = res.error || `Flow respondió "${res.type}"`;
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
  let missing = todo.filter((n) => !present(n));
  for (const n of todo.filter(present)) await setStep(n, "image", "done");

  for (let round = 1; round <= 2 && missing.length; round++) {
    const labels = missing.map(pad3);
    log("warn", `Faltan (o fueron bloqueadas) las imágenes ${labels.join(", ")}. Pido al Agent que las reformule y las repita (ronda ${round}/2).`);
    const retryText =
      `Las imágenes con identificador ${labels.map((l) => `[${l}]`).join(", ")} no se generaron ` +
      `(fallaron o fueron bloqueadas por las políticas de contenido). Reformula cada uno de esos ` +
      `prompts para que sea más seguro y aceptable, manteniendo la idea general de la escena, y ` +
      `vuelve a generarlos (exactamente UNA imagen por prompt). Renombra cada imagen resultante con su mismo identificador ` +
      `exacto (por ejemplo, la reformulación de [${labels[0]}] debe llamarse ${labels[0]}).`;
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
    await setStep(n, "image", "failed", { error: "la imagen no se generó ni reformulando (probable bloqueo de contenido): hazla a mano en Flow y llámala " + pad3(n) });
    log("error", `La imagen ${pad3(n)} no se generó tras 2 reformulaciones. El resto del lote sigue.`, { scene: n });
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
  const pane = await tryWait(() => { const p = $(CONFIG.detailPaneSelector); return p && p.textContent.includes(label) ? p : null; }, 6000, `la vista previa de "${label}"`);
  if (!pane) {
    const p = $(CONFIG.detailPaneSelector);
    throw new Error(p ? `la vista previa no es de "${label}" (dice: "${p.textContent.trim().slice(0, 40)}")` : "no apareció la vista previa de la imagen");
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

async function attachReferenceImage(n) {
  const label = pad3(n);
  try {
    await attachViaPlusMenu(label);
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
  await sleep(800);
  log("ok", `Imagen ${label} adjuntada con "Animar" (plan B).`);
}

// ============================================================ FASE 2A: VÍDEOS
async function waitForSceneVideo(sendRes, maxWaitMs) {
  const assigned = batch.order.map((m) => batch.scenes[m].videoKey).filter(Boolean);
  const r = await tryWait(() => {
    const sig = detectNewSignals(sendRes.textBefore, agentPanelText());
    if (sig.policy) return { error: "policy" };
    const fresh = newVideoTiles(sendRes.before).filter((t) => !assigned.includes(tileKey(t)));
    const bad = fresh.find((t) => /no se ha podido generar/i.test(t.textContent || ""));
    if (bad) return { error: "genError" };
    if (sig.genError && !fresh.length) return { error: "genError" };
    if (fresh.length && $$(CONFIG.pendingTileTag).length <= sendRes.before.pending) {
      const pick = pickNewVideoKey(fresh.map(tileKey), assigned);
      const el = fresh.find((t) => tileKey(t) === pick.key);
      return { key: pick.key, el, ambiguous: pick.ambiguous, count: fresh.length };
    }
    return null;
  }, maxWaitMs, "el vídeo nuevo");
  return r || { error: "timeout" };
}

async function phaseVideos(cfg) {
  ctxPhase = "videos";
  batch.phase = "videos";
  await saveBatch();
  const maxWaitMs = Math.max(cfg.maxWaitMs || 0, 10 * 60000);
  for (const n of batch.order) {
    throwIfStopped();
    ctxScene = n;
    const s = batch.scenes[n];
    if (["done", "review", "failed", "skipped", "nopoints"].includes(s.video)) continue;
    if (s.image !== "done") {
      await setStep(n, "video", "skipped", { error: s.error || "no hay imagen de referencia" });
      await setStep(n, "download", "skipped");
      log("warn", "Sin imagen de referencia: salto el vídeo de esta escena.");
      continue;
    }
    const raw = (cfg.animations || {})[n];
    if (!raw) {
      await setStep(n, "video", "failed", { error: "el kit no trae prompt de animación para esta escena" });
      await setStep(n, "download", "skipped");
      log("error", "No hay prompt de animación para esta escena en el kit.");
      continue;
    }
    const prompt = ensureVideoDuration(raw, CONFIG.videoSeconds);
    if (prompt !== raw) log("info", `Ajusto la duración del prompt a ${CONFIG.videoSeconds} s (de ella depende el coste: 6 s = 10 puntos).`);

    let lastError = null;
    let outcome = null;
    for (let attempt = 1; attempt <= CONFIG.maxAttemptsPerScene && !outcome; attempt++) {
      ui.setStatus(`Escena ${pad3(n)}: vídeo (intento ${attempt}/${CONFIG.maxAttemptsPerScene})`, "info");
      await setStep(n, "video", "running", { videoApproved: false, error: null });
      const text = attempt === 1 ? prompt
        : `${prompt}\n\n(El intento anterior de esta animación falló o fue bloqueado por contenido. Reformula esta descripción de movimiento de forma más segura, manteniendo la misma idea general, y genera igualmente.)`;
      let res;
      try {
        const t0 = Date.now();
        res = await sendWithRateLimit(async () => {
          const box = getPromptBox();
          if (box && promptText()) setEditableValue(box, "");
          await attachReferenceImage(n);
          await writePrompt(text);
        }, { maxPoints: CONFIG.maxAllowedPointsPerVideo, dryRun: !!cfg.dryRun, onApproved: () => { s.videoApproved = true; saveBatch(); } });

        if (res.type === "dryRun") {
          const okCost = res.cost !== null && res.cost <= CONFIG.maxAllowedPointsPerVideo;
          log(okCost ? "ok" : "warn", `ENSAYO: todo llegó hasta el aviso de coste (${res.cost === null ? "coste ilegible" : res.cost + " puntos"}${okCost ? ", se habría aprobado" : ", NO se habría aprobado"}). He pulsado "Rechazar": 0 puntos gastados.`);
          await setStep(n, "video", "skipped", { error: `ensayo: aviso de coste de ${res.cost} puntos rechazado a propósito` });
          await setStep(n, "download", "skipped");
          outcome = "dry";
          break;
        }
        if (res.type === "cost") {
          throw new CostError(res.cost === null
            ? "no pude leer cuántos puntos pide el vídeo; lo rechacé por seguridad"
            : `el vídeo pedía ${res.cost} puntos (máximo ${CONFIG.maxAllowedPointsPerVideo}); lo rechacé. Comprueba que el modelo de vídeo sigue en "Omni 1.1 Flash"`);
        }
        if (res.type === "started") {
          log("info", `Generando el vídeo… (espero hasta ${Math.round(maxWaitMs / 60000)} min; con cola puede tardar)`);
          const v = await waitForSceneVideo(res, maxWaitMs);
          if (v.key) {
            if (v.ambiguous) log("warn", `Aparecieron ${v.count} vídeos nuevos a la vez; asigno el primero a esta escena. Revisa que sea el correcto.`);
            videoElByScene.set(n, v.el);
            await setStep(n, "video", "done", { videoKey: v.key, error: null });
            log("ok", `Vídeo generado en ${Math.round((Date.now() - t0) / 1000)} s.`);
            outcome = "done";
          } else if (v.error === "timeout") {
            lastError = `el coste se aprobó pero el vídeo no apareció en ${Math.round(maxWaitMs / 60000)} min`;
            outcome = "review";
          } else {
            lastError = v.error === "policy" ? "Flow lo bloqueó por su política de contenido" : "Flow dice que no se ha podido generar (no se cobra)";
            log("warn", `${lastError}.${attempt < CONFIG.maxAttemptsPerScene ? " Reintento pidiendo que reformule." : ""}`);
          }
        } else if (res.type === "approvedNoStart") {
          lastError = res.error || "el coste se aprobó pero no empezó ninguna generación";
          outcome = "review";
        } else {
          lastError = res.error || ({ policy: "bloqueado por la política de contenido", genError: "Flow no pudo generarlo", cancelled: "el Agent canceló la generación", noStart: "no se llegó a enviar" }[res.type] || res.type);
          log("warn", `No salió: ${lastError}.${attempt < CONFIG.maxAttemptsPerScene ? " Reintento." : ""}`);
        }
      } catch (e) {
        if (e instanceof StopError || e instanceof NoPointsError || e instanceof CostError) throw e;
        lastError = e.message;
        log("warn", `Fallo en el intento ${attempt}: ${e.message}${visibilityNote()}`);
        await closeOverlays();
        if (s.videoApproved) outcome = "review";
      }
    }
    if (outcome === "dry") { await sleep(1500); continue; }
    if (outcome === "review") {
      await setStep(n, "video", "review", { error: `${lastError}. No lo repito solo para no gastar puntos dos veces: mira en Flow si se generó.` });
      log("error", `Vídeo a REVISAR: ${lastError}. No lo repito para no cobrar dos veces.`);
    } else if (outcome !== "done") {
      await setStep(n, "video", "failed", { error: lastError || "no se pudo generar" });
      await setStep(n, "download", "skipped");
      log("error", `No se pudo generar el vídeo tras ${CONFIG.maxAttemptsPerScene} intentos: ${lastError}. Sigo con la siguiente escena.`);
    }
    await sleep(1500);
  }
  ctxScene = null;
}

// ======================================================= FASE 2B: DESCARGAS
async function findVideoTileForScene(n) {
  const el = videoElByScene.get(n);
  if (el && el.isConnected) return el;
  const key = batch.scenes[n].videoKey;
  if (!key) return null;
  return findWithScroll(() => $$(CONFIG.videoTileTag).find((t) => tileKey(t) === key) || null, CONFIG.videoTileTag);
}

async function openDownloadMenu(tile, kind, resolution) {
  await closeOverlays();
  tile.scrollIntoView({ block: "center" });
  await sleep(300);
  rightClickElement(tile);
  const dl = await tryWait(() => findMenuItemByText(CONFIG.menuItemText.download), 5000, 'la opción "Descargar"');
  if (!dl) { await closeOverlays(); throw new Error(`no aparece "Descargar" en el menú contextual${visibilityNote()}`); }
  clickDeep(dl);
  const options = resolutionFallbacks(resolution, kind);
  for (let i = 0; i < options.length; i++) {
    const opt = await tryWait(() => findMenuItemByText(options[i]), i === 0 ? 5000 : 1500, `la opción ${options[i]}`);
    if (opt) {
      if (i > 0) log("warn", `No existe la opción ${options[0]} en esta cuenta; uso ${options[i]}.`);
      clickDeep(opt);
      return options[i];
    }
  }
  await closeOverlays();
  throw new Error(`no encuentro ninguna resolución (${options.join(", ")}) en el submenú "Descargar"`);
}

async function downloadOne(n, tile, kind, cfg, mode) {
  const ext = kind === "video" ? "mp4" : "png";
  const relPath = `${cfg.batchFolder}/${buildVideoFilename(cfg.nameFormat, cfg.prefix, n, ext)}`;
  let arm;
  const tq = Date.now();
  for (let waitedLogged = false; ; ) {
    throwIfStopped();
    arm = await send({ type: "DL_ARM", acc: ACC, scene: n, relPath, mode });
    if (arm && arm.ok) break;
    if (arm && arm.busy) {
      if (!waitedLogged) { log("info", "La otra cuenta está descargando; espero mi turno (las descargas van de una en una)."); waitedLogged = true; }
      if (Date.now() - tq > 15 * 60000) throw new Error("llevo 15 min esperando turno para descargar");
      await sleep(2000);
      continue;
    }
    throw new Error("el service worker de la extensión no responde (recarga la extensión y pulsa F5)");
  }
  let finished = false;
  try {
    const res = await openDownloadMenu(tile, kind, cfg.resolution);
    log("info", `He pedido la descarga (${res}). Espero a que Chrome la registre (Flow prepara el archivo; 1080p puede tardar)…`);
    const t0 = Date.now();
    let createdAt = null;
    let lastNote = t0;
    let promptNoted = 0;
    for (;;) {
      throwIfStopped();
      const st = await send({ type: "DL_STATUS", jobId: arm.jobId });
      if (!st || st.status === "gone") throw new Error("el gestor de descargas perdió la pista de esta descarga");
      if (st.status === "done") {
        finished = true;
        return st.result;
      }
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
        throw new Error(`Chrome no registró ninguna descarga en ${CONFIG.download.createdTimeoutMs / 1000} s. Causas posibles: (1) Flow no terminó de preparar el archivo; (2) el clic en la resolución no hizo efecto; (3) Chrome retiene la descarga con un aviso de "descargar varios archivos" (permítelo en chrome://settings/content/automaticDownloads)${visibilityNote()}`);
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

async function phaseDownloads(cfg) {
  ctxPhase = "downloads";
  ctxScene = null;
  batch.phase = "downloads";
  await saveBatch();
  const kind = cfg.genMode === "imagesOnly" ? "image" : "video";
  const stepOf = (s) => (kind === "video" ? s.video : s.image);
  for (const n of batch.order) {
    const s = batch.scenes[n];
    if (stepOf(s) !== "done" && s.download === "pending") await setStep(n, "download", "skipped");
  }
  const list = batch.order.filter((n) => stepOf(batch.scenes[n]) === "done" && batch.scenes[n].download !== "done");
  if (!list.length) { log("info", "No hay nada que descargar."); return; }

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

  log("info", `Fase 2B: descargo ${list.length} ${kind === "video" ? "vídeo(s)" : "imagen(es)"} de uno en uno.`);
  for (const n of list) {
    throwIfStopped();
    ctxScene = n;
    ui.setStatus(`Escena ${pad3(n)}: descargando`, "info");
    await setStep(n, "download", "running");
    let lastErr = null;
    for (let attempt = 1; attempt <= CONFIG.download.attempts; attempt++) {
      try {
        const tile = kind === "video" ? await findVideoTileForScene(n) : await findWithScroll(() => findImageTileByLabel(pad3(n)), CONFIG.imageTileTag);
        if (!tile) throw new Error(kind === "video" ? "no encuentro el tile del vídeo de esta escena (¿se recargó la página?). Descárgalo a mano" : "no encuentro la imagen");
        const r = await downloadOne(n, tile, kind, cfg, mode);
        if (!r.nameOk) {
          await setStep(n, "download", "review", { file: r.path, error: `se guardó con otro nombre: ${r.path}` });
          log("error", `Guardado pero con otro nombre: ${r.path}.`);
        } else {
          await setStep(n, "download", "done", { file: r.path });
          log("ok", `Guardado: ${r.path}`);
        }
        lastErr = null;
        break;
      } catch (e) {
        if (e instanceof StopError) throw e;
        lastErr = e.message;
        await closeOverlays();
        if (mode === "folder" && /permiso|carpeta de destino|no hay ninguna carpeta/i.test(e.message)) {
          mode = "downloads";
          log("error", `No puedo escribir en la carpeta elegida (${e.message}). Paso a guardar en Descargas/MundoFutFlow/${cfg.batchFolder}/ (si tienes "Preguntar dónde guardar" activado, Chrome preguntará).`);
          send({ type: "NOTIFY", title: "Sin permiso en la carpeta elegida", message: "Guardo en Descargas/MundoFutFlow. Abre el panel de la extensión y pulsa «Conceder acceso» para la próxima vez.", sticky: true });
        }
        log("warn", `Descarga fallida (intento ${attempt}/${CONFIG.download.attempts}): ${e.message}`);
        if (e.noRetry) break;
        if (attempt < CONFIG.download.attempts) await sleep(3000);
      }
    }
    if (lastErr) {
      await setStep(n, "download", "failed", { error: `no se pudo descargar: ${lastErr}` });
      log("error", `No se pudo descargar tras ${CONFIG.download.attempts} intentos: ${lastErr}`);
    }
  }
  ctxScene = null;
}

// ============================================================ ORQUESTACIÓN
function reasonOf(s) {
  return s.error || (s.video === "review" ? "revisar el vídeo en Flow" : "fallo sin detalle");
}

async function finishRun(label) {
  const sum = summarizeBatch(batch);
  const problems = [...sum.failed, ...sum.review, ...sum.nopoints];
  const total = batch.order.length;
  const where = batch.config.destMode === "folder" ? `carpeta elegida/${batch.config.batchFolder}` : `Descargas/MundoFutFlow/${batch.config.batchFolder}`;
  ctxScene = null;
  ctxPhase = "run";
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
  const isResume = !!resumeState;
  batch = resumeState ? prepareResume(resumeState) : createBatchState({ batchId: cfg.batchId || String(Date.now()), accountKey: ACC, sceneNumbers: cfg.sceneNumbers, config: cfg });
  if (cfg.genMode === "dryRun") cfg.dryRun = true;
  if (["animationsOnly", "dryRun", "downloadTest"].includes(cfg.genMode) && !isResume) for (const n of batch.order) batch.scenes[n].image = "done";
  if (cfg.genMode === "imagesOnly" && !isResume) for (const n of batch.order) batch.scenes[n].video = "skipped";
  await saveBatch();
  send({ type: "HEARTBEAT", acc: ACC, on: true });
  ctxPhase = "setup";
  log("info", `${isResume ? "REANUDO" : "EMPIEZA"} el lote en ${ACC}: escenas ${batch.order.map(pad3).join(", ")} · modo ${cfg.genMode} · ${cfg.resolution} · nombres ${buildVideoFilename(cfg.nameFormat, cfg.prefix, batch.order[0] || 1)} · carpeta ${cfg.batchFolder} · pestaña ${document.visibilityState === "visible" ? "visible" : "OCULTA"}.`);
  if (document.visibilityState !== "visible") log("info", "La pestaña de Flow está en segundo plano: sigo trabajando igual (la extensión la mantiene despierta). Puedes seguir usando otras pestañas.");
  let label = "completo";
  try {
    const box = await tryWait(() => getPromptBox(), 30000, "la caja de prompt de Flow");
    if (!box) throw new Error("no encuentro la caja de prompt de Flow: ¿estás dentro de un proyecto?");
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
    }
    await phaseDownloads(cfg);
    batch.status = halt ? (halt instanceof NoPointsError ? "nopoints" : "error") : "done";
    batch.phase = "done";
    if (halt) label = halt instanceof NoPointsError ? "sin puntos" : "coste no permitido";
  } catch (e) {
    if (e instanceof StopError) {
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
    running = false;
    await closeOverlays().catch(() => {});
    for (const n of batch.order) for (const step of ["image", "video", "download"]) if (batch.scenes[n][step] === "running") batch.scenes[n][step] = step === "video" && batch.scenes[n].videoApproved ? "review" : "pending";
    await saveBatch();
    send({ type: "HEARTBEAT", acc: ACC, on: false });
    await finishRun(label);
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
  if (msg.type === "TICK") { wakeAll(); return false; }
  if (msg.type === "START_RUN") {
    if (running) { sendResponse({ ok: false, error: "ya hay un lote en marcha en esta pestaña" }); return false; }
    runBatch(msg, null);
    sendResponse({ ok: true });
    return false;
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
    const go = await ui.countdown(15, "Hay un lote a medias en esta cuenta. Lo reanudo en {s} s…");
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
      .pill{display:flex;align-items:center;gap:8px;max-width:330px;padding:7px 12px 7px 9px;border-radius:999px;border:1px solid #3a3f4b;background:rgba(24,26,32,.94);color:#e8eaed;font-size:12px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);backdrop-filter:blur(6px);transition:transform .15s,border-color .15s}
      .pill:hover{transform:translateY(-1px);border-color:#5b6272}
      .pill:focus-visible,button:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}
      .dot{width:9px;height:9px;border-radius:50%;background:#8ab4f8;flex:none}
      .dot.run{animation:pulse 1.4s infinite}
      .ok .dot{background:#81c995}.warn .dot{background:#fdd663}.error .dot{background:#f28b82}
      .error.pill{border-color:#f28b82}
      @keyframes pulse{50%{opacity:.35}}
      @media (prefers-reduced-motion:reduce){.dot.run{animation:none}.pill{transition:none}}
      .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .card{width:340px;margin-bottom:8px;padding:12px;border-radius:14px;border:1px solid #3a3f4b;background:rgba(24,26,32,.97);color:#e8eaed;font-size:12px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
      .row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      h2{margin:0;font-size:13px;font-weight:600}
      .brand{display:flex;align-items:center;gap:6px}
      .bar{height:6px;border-radius:99px;background:#2d313b;overflow:hidden;margin:10px 0}
      .bar>i{display:block;height:100%;background:linear-gradient(90deg,#8ab4f8,#c58af9);transition:width .4s}
      .scenes{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .sc{display:flex;align-items:center;gap:3px;padding:3px 6px;border-radius:8px;background:#23262e;border:1px solid #30343e;font-variant-numeric:tabular-nums}
      .sc b{font-weight:600;margin-right:2px}
      .s-pending{color:#6f7480}.s-running{color:#8ab4f8}.s-done{color:#81c995}.s-failed,.s-nopoints{color:#f28b82}.s-review{color:#fdd663}.s-skipped{color:#6f7480;opacity:.5}
      .log{color-scheme:dark;max-height:150px;overflow:auto;font:11px/1.45 ui-monospace,Consolas,monospace;background:#15171c;border-radius:8px;padding:6px 8px;color:#bdc1c6}
      .log .error{color:#f28b82}.log .warn{color:#fdd663}.log .ok{color:#81c995}
      .btns{display:flex;gap:6px;margin-top:8px}
      button{font:inherit;font-size:12px;color:#e8eaed;background:#2d313b;border:1px solid #3a3f4b;border-radius:8px;padding:5px 10px;cursor:pointer}
      button:hover{background:#363b47}
      button.danger{background:#5c2b29;border-color:#8c3a36}
      .fatal{margin-bottom:8px;padding:8px;border-radius:8px;background:#5c2b29;color:#fce8e6}
      .cd{display:flex;gap:6px;align-items:center;margin-bottom:8px;padding:8px 10px;border-radius:10px;background:#2b2f3a;color:#e8eaed;font-size:12px;border:1px solid #8ab4f8}
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
        <div class="row"><h2 class="brand"><svg viewBox="0 0 128 128" width="18" height="18" aria-hidden="true"><path d="M67 27C62 44 52 58 45 72M67 27C71 45 78 57 86 67" fill="none" stroke="#8fd9a8" stroke-width="7" stroke-linecap="round"/><path d="M67 27C74 15 90 12 101 19C93 31 78 34 67 27Z" fill="#43c07f"/><circle cx="44" cy="86" r="21" fill="#f0284f"/><circle cx="87" cy="81" r="21" fill="#f0284f"/></svg>Cerezium · ${esc(ACC)}</h2><span>${pct}%</span></div>
        <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
        <div class="scenes">${scenes || '<span style="color:#9aa0a6">Sin lote en esta cuenta.</span>'}</div>
        <div class="log" id="log" aria-live="polite">${lines || '<div style="color:#6f7480">El log aparecerá aquí.</div>'}</div>
        <div class="btns">
          ${runningNow ? '<button class="danger" id="stop">Detener</button>' : ""}
          <button id="panel">Panel de control</button><button id="copy">Copiar log</button><button id="move" title="Mover a otra esquina">Mover</button><button id="min">Plegar</button>
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
