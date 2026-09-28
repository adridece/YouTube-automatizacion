/*
 * MUNDO FUT / Flow Batch Runner — content script (corre dentro de flow.google.com)
 * ---------------------------------------------------------------------------
 * Contexto completo del proyecto: ver CLAUDE.md y docs/ en la raíz del repo.
 * Todo lo que dice este archivo sobre el DOM de Flow está verificado en vivo
 * y documentado en docs/FLOW_DOM_FINDINGS.md.
 *
 * Flujo del modo "paired" (el principal):
 *   FASE 1  Una sola instrucción al Agent con TODAS las imágenes del rango
 *           ("[001] ..."); el Agent genera 1 imagen por prompt y las renombra
 *           "001", "002"... (se lee en .footer-title). Las que falten se
 *           reintentan pidiéndole al propio Agent que reformule el prompt.
 *           Las imágenes NO se descargan (solo sirven de referencia).
 *   FASE 2A Una animación cada vez: menú "+" -> clic en la imagen por su
 *           nombre -> "Añadir a petición" -> escribir el prompt de animación
 *           -> generar -> (aviso de coste: se lee y se aprueba solo si <= 10
 *           puntos) -> esperar (puede tardar minutos por la cola de Flow).
 *           Se guarda la referencia al tile de vídeo de cada escena.
 *   FASE 2B Al terminar TODAS, se descargan los vídeos (clic derecho ->
 *           Descargar -> resolución) con nombre <prefijo>_<NNN>.mp4.
 *
 * COSTE: depende del MODELO elegido en "Configuración del agente" de Flow
 * (Omni 1.1 Flash = 10 puntos/vídeo), no de la resolución de descarga. Esta
 * extensión nunca toca ese desplegable. "Confirmar antes de generar" debe
 * estar en "Siempre" para poder leer el coste antes de aprobar; se pulsa
 * "Aprobar" (solo esa vez), NUNCA "Aprobar siempre" (ese botón cambia el
 * ajuste a "Nunca" y se pierde la comprobación de coste en los siguientes).
 */

const CONFIG = {
  // PROBADO EN VIVO: la ruta larga y exacta que usábamos antes deja de
  // existir en cuanto se adjunta una imagen a la petición (Angular
  // reestructura esa zona para mostrar la miniatura adjunta). Esta versión
  // busca el editor por su atributo contenteditable, dentro del panel del
  // Agent — funciona igual haya algo adjunto o no.
  promptBoxSelector: 'flow-agent-panel flow-rich-text-editor [contenteditable="true"]',

  // Botón de generar (la flecha de enviar) — simplificado por la misma razón.
  generateButtonSelector: 'flow-agent-panel flow-generate-icon-button',

  // Tags reales confirmados en el DOM de Flow.
  pendingTileTag: "flow-pending-tile", // existe SOLO mientras se está generando
  imageTileTag: "flow-image-tile", // contenedor final y estable de una imagen
  videoTileTag: "flow-video-tile", // contenedor final y estable de un vídeo
  tileTitleSelector: ".footer-title", // nombre visible del tile (aquí aparece "001", "002"...)

  // Menú contextual (clic derecho sobre un tile) — vive en esta clase fija
  // de Angular CDK, así que no depende del id numerado que cambia cada vez.
  overlayContainerSelector: ".cdk-overlay-container",
  menuItemSelector: "flow-menu-item, [role='menuitem']",
  // Textos EXACTOS confirmados en tu cuenta (en español).
  menuItemText: {
    animate: "animar",
    addToRequest: "añadir a la petición",
    download: "descargar",
  },
  // Dentro del submenú de "Descargar", el texto de cada opción de resolución.
  downloadResolutionText: { image: "1K", video1080: "1080p", video720: "720p" },

  // --- Adjuntar una imagen de referencia al prompt (menú "+") ---
  // Botón "+" de la caja de prompt.
  // Ruta corta: las rutas largas y exactas se rompen cuando Angular reestructura el panel.
  addMenuButtonSelector: 'flow-agent-panel flow-add-menu button',
  // Lista de imágenes ya generadas para elegir cuál adjuntar (sin
  // ":nth-child(N)" fijo — buscamos la que coincide con el número de escena).
  assetListItemsSelector: ".cdk-overlay-container flow-add-menu-asset-item",
  // Botón final "añadir a la petición".
  addToPromptButtonSelector: ".cdk-overlay-container flow-add-menu-detail-pane div.bottom-actions button",

  // Diálogo de coste que puede aparecer antes de generar un vídeo.
  // Se pulsa "Aprobar" (exacto), NO "Aprobar siempre": este último cambia el
  // ajuste "Confirmar antes de generar" a "Nunca" para siempre y ya no se
  // podría comprobar el coste de los vídeos siguientes.
  costDialogApproveText: "aprobar",
  // Nunca se aprueba automáticamente una generación que pida más puntos que
  // esto — con el modelo "Omni 1.1 Flash" cada vídeo cuesta 10, confirmado.
  maxAllowedPointsPerVideo: 10,
  // Las imágenes NO piden confirmación (verificado: generan directamente aun
  // con "Confirmar antes de generar" en "Siempre"); este límite es solo una
  // red de seguridad por si algún día la piden.
  maxAllowedPointsImages: 25,
  // Duración de cada clip. Va SIEMPRE en el prompt (ver ensureVideoDuration en
  // shared.js) porque de ella depende el coste: 6 s = 10 puntos.
  videoSeconds: 6,

  pollIntervalMs: 1500,
};

let stopRequested = false;

function sendProgress(text) {
  console.log("[FlowBatchRunner]", text);
  chrome.runtime.sendMessage({ type: "QUEUE_PROGRESS", text }).catch(() => {});
  showOverlay(text);
}

function showOverlay(text) {
  let box = document.getElementById("flow-batch-runner-overlay");
  if (!box) {
    box = document.createElement("div");
    box.id = "flow-batch-runner-overlay";
    box.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      background: rgba(20,20,22,0.92); color: #9be29b; font: 12px monospace;
      padding: 10px 14px; border-radius: 8px; max-width: 380px;
      white-space: pre-wrap; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(box);
  }
  box.textContent = text;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function countsNow() {
  return {
    pending: document.querySelectorAll(CONFIG.pendingTileTag).length,
    image: document.querySelectorAll(CONFIG.imageTileTag).length,
    video: document.querySelectorAll(CONFIG.videoTileTag).length,
  };
}

function waitForNewTile(before, timeoutMs) {
  return waitUntil(() => {
    const now = countsNow();
    return now.pending > before.pending || now.image > before.image || now.video > before.video;
  }, timeoutMs, "que empiece a generar algo");
}

// Pulsa el botón de generar y comprueba que de verdad ha empezado algo (una
// tile pendiente o un resultado nuevo). Mientras espera, en CADA vuelta de
// sondeo también vigila el aviso de coste de Flow ("¿Quieres que empiece a
// generar 1 vídeo, que cuesta N puntos?"): ese aviso puede tardar en aparecer
// mientras la IA "piensa", y hasta que se aprueba no empieza nada.
//  - Si N <= maxPoints: pulsa "Aprobar" (solo esa vez, NUNCA "Aprobar siempre",
//    que cambia el ajuste a "Nunca" y desactivaría esta comprobación).
//  - Si N > maxPoints o no se puede leer N: pulsa "Rechazar" (no cuesta nada,
//    y evita dejar el aviso colgado) y lanza un error explicando por qué.
async function clickGenerateAndVerify(genBtn, { maxPoints = CONFIG.maxAllowedPointsPerVideo } = {}) {
  const before = countsNow();
  const box = document.querySelector(CONFIG.promptBoxSelector);
  const editableBefore = box ? box.closest('[contenteditable="true"]') || box : null;
  const hadTextBefore = editableBefore ? editableBefore.textContent.trim().length > 0 : false;

  const state = { approved: false, violation: null };
  const tick = () => {
    if (!state.approved && !state.violation) {
      const dlg = findPendingCostDialog();
      if (dlg) {
        if (dlg.cost === null || dlg.cost > maxPoints) {
          state.violation = { cost: dlg.cost };
          if (dlg.rejectRow) dlg.rejectRow.click();
          return true;
        }
        dlg.approveRow.click();
        state.approved = true;
        sendProgress(`Aviso de coste: ${dlg.cost} puntos (límite ${maxPoints}) — aprobado solo esta vez.`);
      }
    }
    const now = countsNow();
    return now.pending > before.pending || now.image > before.image || now.video > before.video;
  };
  const failIfCostViolation = () => {
    if (!state.violation) return;
    const c = state.violation.cost;
    const msg =
      c === null
        ? "no pude leer cuántos puntos pide esta generación — la rechacé por seguridad"
        : `esta generación pide ${c} puntos (máximo permitido ${maxPoints}) — la rechacé. ` +
          'Comprueba que el modelo de vídeo sigue en "Omni 1.1 Flash" y que el prompt lleva la duración de 6 segundos';
    sendProgress(`⛔ ${msg}.`);
    throw new Error(msg);
  };

  clickDeep(genBtn);

  let started = false;
  try {
    // Margen largo: la IA puede tardar en "pensar" antes de que aparezca el
    // aviso de coste o cualquier tile (4 s daba falsos fallos).
    await waitUntil(tick, 25000, "que empiece a generar algo");
    started = true;
  } catch (e) {
    if (e.message === "stopped") throw e;
  }
  failIfCostViolation();

  if (!started) {
    // Antes de reintentar el clic, comprobamos si el mensaje se envió de
    // verdad (la caja de prompt se vació). Si es así, NO se vuelve a pulsar
    // generar (podría duplicar la petición): solo sigue pensando o en cola.
    const editableNow = document.querySelector(CONFIG.promptBoxSelector);
    const editableNowRoot = editableNow ? editableNow.closest('[contenteditable="true"]') || editableNow : null;
    const isEmptyNow = editableNowRoot ? editableNowRoot.textContent.trim().length === 0 : false;
    const messageWasSent = hadTextBefore && isEmptyNow;

    if (messageWasSent) {
      sendProgress("El mensaje se envió pero la IA está tardando en responder — esperando más tiempo sin volver a pulsar generar...");
      try {
        await waitUntil(tick, 40000, "que empiece a generar algo (mensaje ya enviado)");
        started = true;
      } catch (e) {
        if (e.message === "stopped") throw e;
      }
    } else {
      sendProgress('El clic en "generar" no parece haber enviado nada — reintentando una vez más...');
      clickDeep(genBtn);
      try {
        await waitUntil(tick, 25000, "que empiece a generar algo (2º intento)");
        started = true;
      } catch (e) {
        if (e.message === "stopped") throw e;
      }
    }
    failIfCostViolation();
  }

  if (!started) {
    throw new Error(
      'el botón de generar no ha disparado nada tras esperar y reintentar — revisa que generateButtonSelector siga siendo correcto, o que el botón no estuviera deshabilitado'
    );
  }
}

// PROBADO EN VIVO: el botón de generar (y otros similares) son elementos
// personalizados de Angular (p. ej. <flow-generate-icon-button>) que
// envuelven por dentro un <button type="submit"> de verdad. Disparar una
// secuencia de eventos de puntero sobre el envoltorio NO funciona — lo que
// sí funciona es encontrar el <button> real (dentro, el propio elemento, o
// fuera) y llamar a su método NATIVO .click(), que es el único que dispara
// correctamente el envío del formulario (un dispatchEvent sintético de
// "click" no activa ese comportamiento por defecto en todos los casos).
function clickDeep(el) {
  const target =
    el.tagName === "BUTTON" ? el : el.querySelector("button") || el.closest("button") || el;
  target.click();
}

// Escribe texto en la caja de prompt (contenteditable). execCommand sigue
// siendo, hoy por hoy, la forma más fiable de insertar texto en un editor
// enriquecido de Angular sin simular cada tecla una a una.
function setEditableValue(el, text) {
  const editable = el.closest('[contenteditable="true"]') || el;
  editable.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

function findMenuItemByText(text) {
  const overlay = document.querySelector(CONFIG.overlayContainerSelector);
  if (!overlay) return null;
  const candidates = overlay.querySelectorAll(CONFIG.menuItemSelector);
  const wanted = text.toLowerCase();
  for (const el of candidates) {
    if ((el.textContent || "").trim().toLowerCase().includes(wanted)) return el;
  }
  return null;
}

function waitUntil(conditionFn, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let result;
      try { result = conditionFn(); } catch (e) { result = null; }
      if (result) { clearInterval(timer); resolve(result); return; }
      if (stopRequested) { clearInterval(timer); reject(new Error("stopped")); return; }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout esperando: ${description} (${timeoutMs / 1000}s)`));
      }
    }, CONFIG.pollIntervalMs);
  });
}

// Espera a que YA NO quede ningún tile "pendiente" en la página — es decir,
// a que Flow haya terminado de generar todo lo que estuviera en curso.
function waitForGenerationToFinish(maxWaitMs) {
  return waitUntil(
    () => document.querySelectorAll(CONFIG.pendingTileTag).length === 0,
    maxWaitMs,
    "que termine la generación (pending tiles a 0)"
  );
}

// Encuentra el tile de imagen cuyo nombre visible coincide con `label`
// (p. ej. "003").
function findImageTileByLabel(label) {
  const tiles = document.querySelectorAll(CONFIG.imageTileTag);
  for (const t of tiles) {
    const title = t.querySelector(CONFIG.tileTitleSelector);
    if (title && title.textContent.trim() === label) return t;
  }
  return null;
}

// En vez de comprobar una sola vez (lo que puede pillar el instante exacto
// en que el renombrado todavía no ha terminado), sondea varias veces durante
// `maxWaitMs` y solo da algo por "faltante" si sigue faltando al final del
// margen de espera.
async function waitForImagesToSettle(sceneNumbers, maxWaitMs) {
  const start = Date.now();
  let missing = sceneNumbers.filter((n) => !findImageTileByLabel(pad3(n)));
  while (missing.length > 0 && Date.now() - start < maxWaitMs) {
    if (stopRequested) return missing;
    await sleep(1500);
    missing = sceneNumbers.filter((n) => !findImageTileByLabel(pad3(n)));
  }
  return missing;
}

// Busca el aviso de coste PENDIENTE (el más reciente sin contestar).
// VERIFICADO EN VIVO: vive en el propio chat como <flow-permission-message>,
// con filas <div class="option-row" role="radio" aria-label="Aprobar" |
// "Aprobar siempre" | "Rechazar">. Los avisos ya contestados siguen en el HTML
// pero con la clase "read-only" y aria-disabled="true" — por eso se filtran
// (si no, se podría actuar sobre un aviso viejo). El texto del aviso, con el
// coste, está dentro del propio <flow-permission-message>.
function findPendingCostDialog() {
  const msgs = Array.from(document.querySelectorAll("flow-permission-message"));
  for (let i = msgs.length - 1; i >= 0; i--) {
    const rows = Array.from(msgs[i].querySelectorAll(".option-row:not(.read-only):not([aria-disabled='true'])"));
    if (rows.length === 0) continue;
    const byLabel = (label) => rows.find((r) => (r.getAttribute("aria-label") || "").trim().toLowerCase() === label);
    const approveRow = byLabel(CONFIG.costDialogApproveText);
    if (!approveRow) continue;
    return {
      message: msgs[i],
      approveRow,
      rejectRow: byLabel("rechazar") || null,
      cost: parseCostFromText(msgs[i].textContent),
    };
  }
  return null;
}

async function rightClickElement(el) {
  const rect = el.getBoundingClientRect();
  const evt = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, view: window, button: 2,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  });
  el.dispatchEvent(evt);
  await sleep(500);
}

// Clic derecho sobre `downloadEl` -> Descargar -> la opción de resolución
// cuyo texto contiene `resolutionText`.
async function downloadTile(tileEl, resolutionText, prefix, num, kind) {
  const ext = kind === "video" ? "mp4" : "png";
  const filename = `${prefix}_${pad3(num)}.${ext}`;

  // Avisamos al background script del nombre que debe llevar la PRÓXIMA
  // descarga que se dispare, antes de disparar nada — si no se hace esto,
  // el archivo se guarda con el nombre por defecto de Flow, sin numerar.
  await chrome.storage.local.set({ pendingRenameFilename: filename });

  await rightClickElement(tileEl);
  const downloadItem = findMenuItemByText(CONFIG.menuItemText.download);
  if (!downloadItem) {
    await chrome.storage.local.remove("pendingRenameFilename");
    throw new Error('no encuentro "Descargar" en el menú contextual');
  }
  clickDeep(downloadItem);
  await sleep(500);
  const resOption = findMenuItemByText(resolutionText);
  if (!resOption) {
    await chrome.storage.local.remove("pendingRenameFilename");
    throw new Error(`no encuentro la opción de resolución "${resolutionText}"`);
  }
  clickDeep(resOption);
  await sleep(1200); // deja tiempo a que la descarga nativa se dispare de verdad
}

// ------------------------------------------------------------------
// FASE 1: instrucción combinada al Agent con todas las imágenes del rango.
// Devuelve { ok, missing } — ok=false solo si algo hizo fallar TODO el
// intento (no encontrar la caja de prompt, timeout general...); missing es
// la lista de números de escena que, tras generar (y reintentar), siguen
// sin tener imagen — normalmente porque la política de contenido las bloqueó
// y la reformulación automática tampoco lo consiguió arreglar.
// ------------------------------------------------------------------
async function runPhase1Images({ images, sceneNumbers, maxWaitMs }) {
  const imagesMap = new Map(Object.entries(images).map(([k, v]) => [parseInt(k, 10), v]));
  const instruction = buildAgentInstruction(imagesMap, sceneNumbers);

  const box = document.querySelector(CONFIG.promptBoxSelector);
  if (!box) { sendProgress("ERROR: no encuentro la caja de prompt."); return { ok: false, missing: sceneNumbers }; }
  setEditableValue(box, instruction);
  await sleep(500);

  const genBtn = document.querySelector(CONFIG.generateButtonSelector);
  if (!genBtn) { sendProgress("ERROR: no encuentro el botón de generar."); return { ok: false, missing: sceneNumbers }; }
  sendProgress(`Fase 1: pulsando generar para ${sceneNumbers.length} imagen(es)...`);
  try {
    await clickGenerateAndVerify(genBtn, { maxPoints: CONFIG.maxAllowedPointsImages });
  } catch (e) {
    if (e.message === "stopped") { sendProgress("Detenido por el usuario."); return { ok: false, missing: sceneNumbers }; }
    sendProgress(`ERROR: ${e.message}`);
    return { ok: false, missing: sceneNumbers };
  }
  sendProgress(`Fase 1: generando ${sceneNumbers.length} imagen(es) de golpe...`);

  try {
    await waitForGenerationToFinish(maxWaitMs);
  } catch (e) {
    if (e.message === "stopped") { sendProgress("Detenido por el usuario."); return { ok: false, missing: sceneNumbers }; }
    sendProgress(`ERROR: el lote de imágenes no terminó a tiempo (${e.message}).`);
    return { ok: false, missing: sceneNumbers };
  }

  // Margen de espera: el Agent renombra las imágenes en un paso posterior a
  // que termine de "generarlas" (pendingTileTag llega a 0 ANTES de que el
  // renombrado se complete). Sin este margen, se detectaban como "fallidas"
  // escenas que en realidad sí se habían generado bien, solo que su nombre
  // todavía no se había actualizado en el DOM en el instante exacto de mirar.
  sendProgress("Comprobando que todas las imágenes hayan quedado bien renombradas...");
  let missing = await waitForImagesToSettle(sceneNumbers, 15000);
  if (missing.length === 0) {
    sendProgress("✅ Fase 1 terminada: todas las imágenes generadas y renombradas correctamente.");
    return { ok: true, missing: [] };
  }

  sendProgress(`⚠️ No se generaron (o fueron bloqueadas) las escenas: ${missing.map(pad3).join(", ")}. Pidiendo al Agent que reformule y reintente...`);
  missing = await retryMissingImages(missing, maxWaitMs);

  if (missing.length > 0) {
    sendProgress(
      `⚠️ Tras reintentarlo, SIGUEN sin imagen las escenas: ${missing.map(pad3).join(", ")}. ` +
        `Habrá que revisarlas y regenerarlas a mano — el resto del lote continúa normalmente.`
    );
  } else {
    sendProgress("✅ Fase 1 terminada: todas las imágenes generadas (algunas necesitaron reformularse).");
  }
  return { ok: true, missing };
}

// Pide al propio Agent, en la misma conversación, que reformule y regenere
// las escenas de la lista `missing` — usa su capacidad conversacional en vez
// de que nosotros adivinemos qué palabra exacta disparó el bloqueo.
// Hasta 2 rondas de reintento; entre ronda y ronda solo quedan las que aún
// falten.
async function retryMissingImages(missing, maxWaitMs) {
  let remaining = [...missing];
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts && remaining.length > 0; attempt++) {
    const labels = remaining.map(pad3);
    sendProgress(`Reintento ${attempt}/${maxAttempts} para las escenas: ${labels.join(", ")}...`);

    const retryText =
      `Las imágenes con identificador ${labels.map((l) => `[${l}]`).join(", ")} no se generaron ` +
      `(fallaron o fueron bloqueadas por las políticas de contenido). Reformula cada uno de esos ` +
      `prompts para que sea más seguro y aceptable, manteniendo la idea general de la escena, y ` +
      `vuelve a generarlos. Renombra cada imagen resultante con su mismo identificador numérico ` +
      `exacto (por ejemplo, la reformulación de [${labels[0]}] debe llamarse igualmente ${labels[0]}).`;

    const box = document.querySelector(CONFIG.promptBoxSelector);
    if (!box) { sendProgress("ERROR: no encuentro la caja de prompt para el reintento."); break; }
    setEditableValue(box, retryText);
    await sleep(500);

    const genBtn = document.querySelector(CONFIG.generateButtonSelector);
    if (!genBtn) { sendProgress("ERROR: no encuentro el botón de generar para el reintento."); break; }

    try {
      await clickGenerateAndVerify(genBtn, { maxPoints: CONFIG.maxAllowedPointsImages });
    } catch (e) {
      if (e.message === "stopped") throw e;
      sendProgress(`ERROR en el reintento: ${e.message}`);
      break;
    }

    try {
      await waitForGenerationToFinish(maxWaitMs);
    } catch (e) {
      if (e.message === "stopped") throw e;
      sendProgress(`ERROR: el reintento no terminó a tiempo (${e.message}).`);
      break;
    }

    remaining = remaining.filter((n) => !findImageTileByLabel(pad3(n)));
  }

  return remaining;
}

// Descarga, para cada escena del rango, la imagen ya generada en Fase 1.
async function downloadPhase1Images({ sceneNumbers, prefix }) {
  let ok = 0;
  for (const num of sceneNumbers) {
    if (stopRequested) break;
    const label = pad3(num);
    const tile = findImageTileByLabel(label);
    if (!tile) { sendProgress(`Aviso: no encuentro el tile de la imagen "${label}" para descargarla.`); continue; }
    try {
      await downloadTile(tile, CONFIG.downloadResolutionText.image, prefix, num, "image");
      sendProgress(`Imagen ${label} descargada.`);
      ok++;
    } catch (e) {
      sendProgress(`ERROR descargando la imagen ${label}: ${e.message}`);
    }
    await sleep(600);
  }
  sendProgress(`✅ Descarga de imágenes terminada: ${ok}/${sceneNumbers.length}.`);
}

// Adjunta la imagen de referencia cuyo nombre coincide con `label` (p. ej.
// "003") a la caja de prompt, usando el menú "+" → [opción de imágenes] →
// seleccionar por nombre → "añadir a la petición". Si cualquier paso de ese
// menú falla, cae de respaldo al atajo "Animar" (clic derecho sobre el
// propio tile de imagen), que adjunta esa misma imagen en un solo paso.
async function attachReferenceImage(imageTile, label) {
  try {
    const addBtn = document.querySelector(CONFIG.addMenuButtonSelector);
    if (!addBtn) throw new Error('no encuentro el botón "+" (addMenuButtonSelector)');
    clickDeep(addBtn);
    await sleep(800);

    // PROBADO EN VIVO: al pulsar "+" el panel va DIRECTO a la lista de
    // assets (con "Todo" ya seleccionado) — no hace falta clicar ningún
    // elemento del menú lateral antes. Ese paso extra se quitó porque
    // además era la causa confirmada de que se adjuntara la imagen
    // equivocada.

    function findAssetItem() {
      const items = document.querySelectorAll(CONFIG.assetListItemsSelector);
      for (const it of items) {
        if (it.textContent && it.textContent.trim() === label) return it;
      }
      for (const it of items) {
        if (it.textContent && it.textContent.trim().includes(label)) return it;
      }
      return null;
    }

    // La lista puede tardar en pintarse (visto en vivo cuando Flow está
    // ocupado generando): se sondea hasta 6 s en vez de mirar una sola vez.
    let target;
    try {
      target = await waitUntil(() => findAssetItem(), 6000, `la imagen "${label}" en la lista de assets`);
    } catch (e) {
      if (e.message === "stopped") throw e;
      throw new Error(`no encuentro la imagen "${label}" en la lista de assets (esperé 6 s)`);
    }
    target.scrollIntoView({ block: "center" });
    await sleep(300);
    target = findAssetItem();
    if (!target) throw new Error(`la imagen "${label}" desapareció de la lista tras el scroll`);
    clickDeep(target);
    await sleep(700);

    const detailPane = document.querySelector(`${CONFIG.overlayContainerSelector} flow-add-menu-detail-pane`);
    if (detailPane && !detailPane.textContent.includes(label)) {
      throw new Error(`se seleccionó una imagen distinta a "${label}" (la vista previa no coincide)`);
    }

    const addToPromptBtn = document.querySelector(CONFIG.addToPromptButtonSelector);
    if (!addToPromptBtn) throw new Error('no encuentro el botón "añadir a la petición"');
    clickDeep(addToPromptBtn);
    await sleep(700);

    const overlayStillOpen = () => !!document.querySelector(`${CONFIG.overlayContainerSelector} flow-add-menu-popover-content`);
    if (overlayStillOpen()) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(500);
    }
    if (overlayStillOpen()) {
      document.body.click();
      await sleep(500);
    }
    if (overlayStillOpen()) {
      throw new Error("el menú de adjuntar imagen no se cerró tras confirmarla");
    }

    return true;
  } catch (e) {
    sendProgress(`Menú "+" falló para la escena ${label} (${e.message}) — probando el atajo "Animar" de respaldo...`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(400);
    try {
      await rightClickElement(imageTile);
      const animateItem = findMenuItemByText(CONFIG.menuItemText.animate);
      if (!animateItem) throw new Error('tampoco encuentro "Animar"');
      clickDeep(animateItem);
      await sleep(600);
      return true;
    } catch (e2) {
      sendProgress(`ERROR: no se pudo adjuntar la imagen "${label}" por ningún método (${e2.message}).`);
      return false;
    }
  }
}
// la imagen correspondiente antes de escribir el prompt de movimiento.
// Cada escena tiene hasta 2 intentos: si el primero no produce ningún vídeo
// nuevo (bloqueo de contenido u otro fallo), el segundo intento añade una
// nota pidiendo una reformulación más segura del mismo prompt de movimiento.
// Devuelve la lista de números de escena que, tras los reintentos, siguen
// sin vídeo.
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// FASE 2A: genera las animaciones una a una, adjuntando primero la imagen
// correspondiente (menú "+", con "Animar" como respaldo). NO descarga nada
// todavía — solo genera y va guardando qué tile de vídeo corresponde a cada
// número de escena, para descargarlos todos juntos al final (Fase 2B).
// ------------------------------------------------------------------
async function generateAllAnimations({ animations, sceneNumbers, maxWaitMs }) {
  const failedScenes = [];
  const videoTileByScene = new Map(); // num -> elemento <flow-video-tile>
  const maxAttemptsPerScene = 2;

  for (const num of sceneNumbers) {
    if (stopRequested) { sendProgress(`Detenido por el usuario en la escena ${pad3(num)}.`); return { failedScenes, videoTileByScene }; }

    const label = pad3(num);
    const rawPrompt = animations[num];
    if (!rawPrompt) { sendProgress(`Escena ${label}: sin prompt de animación, la salto.`); continue; }
    // El coste depende de la duración del prompt (6 s = 10 puntos): se garantiza siempre.
    const prompt = ensureVideoDuration(rawPrompt, CONFIG.videoSeconds);

    const imageTile = findImageTileByLabel(label);
    if (!imageTile) {
      sendProgress(`ERROR: no encuentro la imagen "${label}" para animarla. La salto.`);
      failedScenes.push(num);
      continue;
    }

    let success = false;
    for (let attempt = 1; attempt <= maxAttemptsPerScene && !success; attempt++) {
      sendProgress(`Escena ${label}: adjuntando su imagen de referencia (intento ${attempt}/${maxAttemptsPerScene})...`);
      const attached = await attachReferenceImage(imageTile, label);
      if (!attached) break;

      const box = document.querySelector(CONFIG.promptBoxSelector);
      if (!box) { sendProgress(`ERROR: no encuentro la caja de prompt para la escena ${label}.`); break; }
      const textToUse =
        attempt === 1
          ? prompt
          : `${prompt}\n\n(El intento anterior de esta animación falló o fue bloqueado por contenido. Reformula esta descripción de movimiento de forma más segura, manteniendo la misma idea general, y genera igualmente.)`;
      setEditableValue(box, textToUse);
      await sleep(400);

      const genBtn = document.querySelector(CONFIG.generateButtonSelector);
      if (!genBtn) { sendProgress(`ERROR: no encuentro el botón de generar para la escena ${label}.`); break; }

      const videoCountBefore = document.querySelectorAll(CONFIG.videoTileTag).length;
      sendProgress(`Escena ${label}: pulsando generar (intento ${attempt}/${maxAttemptsPerScene})...`);
      try {
        await clickGenerateAndVerify(genBtn, { maxPoints: CONFIG.maxAllowedPointsPerVideo });
      } catch (e) {
        if (e.message === "stopped") { sendProgress("Detenido por el usuario."); return { failedScenes, videoTileByScene }; }
        sendProgress(`ERROR en la animación ${label} (intento ${attempt}): ${e.message}`);
        continue;
      }
      sendProgress(`Escena ${label}: generando animación (intento ${attempt})...`);

      try {
        await waitForGenerationToFinish(maxWaitMs);
      } catch (e) {
        if (e.message === "stopped") { sendProgress("Detenido por el usuario."); return { failedScenes, videoTileByScene }; }
        sendProgress(`ERROR en la animación ${label} (intento ${attempt}): ${e.message}.`);
        continue;
      }

      // Comprobación real de éxito: ¿ha aparecido de verdad un vídeo nuevo?
      const videoTilesNow = document.querySelectorAll(CONFIG.videoTileTag);
      if (videoTilesNow.length > videoCountBefore) {
        success = true;
        videoTileByScene.set(num, videoTilesNow[videoTilesNow.length - 1]);
      } else {
        sendProgress(
          `⚠️ Escena ${label}: no se generó ningún vídeo nuevo (posible bloqueo de contenido).` +
            (attempt < maxAttemptsPerScene ? " Reintentando con el prompt reformulado..." : "")
        );
      }
    }

    if (!success) {
      sendProgress(`❌ Escena ${label}: no se pudo generar el vídeo tras ${maxAttemptsPerScene} intentos — requiere revisión manual.`);
      failedScenes.push(num);
    }

    await sleep(1000);
  }

  return { failedScenes, videoTileByScene };
}

// ------------------------------------------------------------------
// FASE 2B: descarga, uno a uno, cada vídeo ya generado en la Fase 2A —
// usando la referencia guardada al tile, no una búsqueda por nombre (los
// vídeos no se renombran automáticamente como sí hacen las imágenes).
// ------------------------------------------------------------------
async function downloadAllVideos({ videoTileByScene, prefix, resolution }) {
  const videoResText = resolution === "720p" ? CONFIG.downloadResolutionText.video720 : CONFIG.downloadResolutionText.video1080;
  let ok = 0;
  for (const [num, tile] of videoTileByScene.entries()) {
    if (stopRequested) break;
    const label = pad3(num);
    try {
      await downloadTile(tile, videoResText, prefix, num, "video");
      sendProgress(`Vídeo ${label} descargado (${resolution}). ✅`);
      ok++;
    } catch (e) {
      sendProgress(`ERROR descargando el vídeo ${label}: ${e.message}`);
    }
    await sleep(600);
  }
  sendProgress(`✅ Descarga de vídeos terminada: ${ok}/${videoTileByScene.size}.`);
}

async function runPhase2Animations({ animations, sceneNumbers, prefix, resolution, maxWaitMs }) {
  sendProgress(`Fase 2A: generando ${sceneNumbers.length} animación(es), una a una...`);
  const { failedScenes, videoTileByScene } = await generateAllAnimations({ animations, sceneNumbers, maxWaitMs });

  if (stopRequested) return failedScenes;

  if (videoTileByScene.size > 0) {
    sendProgress(`Fase 2B: descargando ${videoTileByScene.size} vídeo(s) generado(s)...`);
    await downloadAllVideos({ videoTileByScene, prefix, resolution });
  } else {
    sendProgress("Fase 2B: no hay ningún vídeo generado que descargar.");
  }

  if (failedScenes.length > 0) {
    sendProgress(`⚠️ Fase 2 terminada con fallos en las escenas: ${failedScenes.map(pad3).join(", ")}.`);
  } else {
    sendProgress(`✅ Fase 2 terminada sin fallos.`);
  }
  return failedScenes;
}

async function runPaired({ images, animations, sceneNumbers, prefix, resolution, maxWaitMs }) {
  stopRequested = false;
  const result = await runPhase1Images({ images, sceneNumbers, maxWaitMs });
  if (!result.ok || stopRequested) return;

  const workableScenes = sceneNumbers.filter((n) => !result.missing.includes(n));
  // No se descargan las imágenes en este modo — solo sirven de referencia
  // para animarlas; lo único que se descarga al final son los vídeos.

  const videoFailures = await runPhase2Animations({ animations, sceneNumbers: workableScenes, prefix, resolution, maxWaitMs });

  const allFailed = [...new Set([...result.missing, ...(videoFailures || [])])].sort((a, b) => a - b);
  if (allFailed.length > 0) {
    sendProgress(
      `📋 Resumen final: las siguientes escenas necesitan revisión manual (no se pudieron generar tras los reintentos): ${allFailed.map(pad3).join(", ")}.`
    );
  }
}

async function runImagesOnly({ images, sceneNumbers, prefix, maxWaitMs }) {
  stopRequested = false;
  const result = await runPhase1Images({ images, sceneNumbers, maxWaitMs });
  if (result.ok) {
    const workableScenes = sceneNumbers.filter((n) => !result.missing.includes(n));
    await downloadPhase1Images({ sceneNumbers: workableScenes, prefix });
  }
}

async function runAnimationsOnly({ animations, sceneNumbers, prefix, resolution, maxWaitMs }) {
  stopRequested = false;
  await runPhase2Animations({ animations, sceneNumbers, prefix, resolution, maxWaitMs });
}

async function dispatchRun(msg) {
  const { genMode } = msg;
  if (genMode === "paired") await runPaired(msg);
  else if (genMode === "imagesOnly") await runImagesOnly(msg);
  else if (genMode === "animationsOnly") await runAnimationsOnly(msg);
  else { sendProgress(`ERROR: modo desconocido "${genMode}".`); return; }

  // Avisa a quien esté orquestando (el popup, o el plan multi-cuenta en
  // background.js) de que esta tanda ha terminado, para que pueda pasar a
  // la siguiente pestaña/cuenta si corresponde.
  chrome.runtime.sendMessage({ type: "RUN_COMPLETE", accountKey: getFlowAccountKey(window.location.href) }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "START_RUN") {
    dispatchRun(msg);
  } else if (msg.type === "STOP_QUEUE") {
    stopRequested = true;
  } else if (msg.type === "SHOW_OVERLAY") {
    showOverlay(msg.text);
  }
});

// ------------------------------------------------------------------
// AUTO-INICIO: si ESTA CUENTA (detectada por el /u/N/ de la URL) tiene una
// configuración guardada con enabled:true y no se ha ejecutado todavía, se
// lanza sola al cargar Flow. Cada cuenta (u2, u3...) guarda la suya propia,
// aunque compartan el mismo perfil de Chrome y por tanto el mismo
// almacenamiento de la extensión.
// ------------------------------------------------------------------
async function maybeAutoRun() {
  const storageKey = autoRunStorageKey(window.location.href);
  const data = await chrome.storage.local.get(storageKey);
  const cfg = data[storageKey];
  if (!cfg || !cfg.enabled) return;
  if (cfg.lastRunAt) {
    sendProgress(
      `Auto-inicio (${storageKey}): este lote ya se ejecutó el ${new Date(cfg.lastRunAt).toLocaleString()}. ` +
        `Abre el popup y pulsa "Permitir que se vuelva a ejecutar" para relanzarlo.`
    );
    return;
  }
  await sleep(3000);

  const { images, animations } = splitCombinedPrompts(cfg.promptsRaw || "");
  const sceneNumbers = parseRange(cfg.sceneRange || "");
  if (sceneNumbers.length === 0 || images.size === 0) return;

  sendProgress(`Auto-inicio activado para ${storageKey}: ${sceneNumbers.length} escena(s), modo "${cfg.genMode}"...`);

  await dispatchRun({
    genMode: cfg.genMode,
    images: Object.fromEntries(images),
    animations: Object.fromEntries(animations),
    sceneNumbers,
    prefix: cfg.prefix,
    resolution: cfg.resolution,
    maxWaitMs: cfg.maxWaitMs,
  });

  cfg.lastRunAt = Date.now();
  await chrome.storage.local.set({ [storageKey]: cfg });
}

maybeAutoRun();

/*
 * ============================================================
 * ANTES DE LANZAR UN LOTE — comprobación manual de 10 segundos
 * ============================================================
 * En Flow, abre Ajustes (icono de sliders junto a la caja de prompt) y
 * comprueba en "Configuración del agente":
 *  - "Confirmar antes de generar" -> SIEMPRE (así se puede leer el coste
 *    antes de aprobar; la extensión aprueba sola si son 10 puntos o menos).
 *  - Vídeo: modelo "Omni 1.1 Flash" (10 puntos). No usar Veo 3.1.
 *  - Aspect ratio de imagen y vídeo: 9:16 para Shorts; cantidad x1.
 * En Chrome (chrome://settings/downloads): desactiva "Preguntar dónde
 * guardar cada archivo antes de descargarlo".
 *
 * Si algún texto de menú no coincide (interfaz en otro idioma), ajusta
 * CONFIG.menuItemText / CONFIG.costDialogApproveText /
 * CONFIG.downloadResolutionText al texto exacto que se vea en pantalla.
 * ============================================================
 */
