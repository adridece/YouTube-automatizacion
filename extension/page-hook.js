/*
 * Se ejecuta en el MUNDO DE LA PÁGINA de Flow (manifest: "world": "MAIN"),
 * antes que el código de Flow (document_start).
 *
 * 1) Descargas: muchas webs crean un blob, lo enlazan a un <a download>, hacen
 *    clic y lo liberan al instante con URL.revokeObjectURL. Se retrasa 3 min
 *    esa liberación para que la extensión pueda leer el archivo.
 *
 * 2) SEGUNDO PLANO (v2.2, problema real del usuario: "los vídeos se quedan al
 *    100% y no se acaban de procesar hasta que entro en la pestaña"). Con la
 *    pestaña oculta, Chrome no ejecuta requestAnimationFrame, no avanza las
 *    animaciones/transiciones y la página sabe que está oculta
 *    (document.hidden), con lo que muchas apps paran de refrescar. SOLO
 *    mientras la extensión tiene un lote en marcha en esta pestaña (eventos
 *    "fbr-bg-on"/"fbr-bg-off" que manda content.js):
 *      - la página ve la pestaña como visible y con foco;
 *      - los requestAnimationFrame pendientes se ejecutan igualmente (cada
 *        ~16 ms si Chrome lo permite, y en cada "fbr-tick" que llega con el
 *        latido de la extensión cada 2 s);
 *      - las animaciones/transiciones finitas que están en marcha se dan por
 *        terminadas para que Flow siga con lo que hace después de ellas.
 *    Con la pestaña a la vista no se toca nada.
 */
(() => {
  if (window.__fbrHooked) return;
  window.__fbrHooked = true;

  // ------------------------------------------------------------ descargas
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) {
    try {
      if (typeof url === "string" && url.startsWith("blob:")) {
        setTimeout(() => origRevoke(url), 180000);
        return;
      }
    } catch (e) {}
    return origRevoke(url);
  };

  // --------------------------------------------------------- segundo plano
  let active = false;
  const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  const visDesc = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  const realHidden = () => (hiddenDesc && hiddenDesc.get ? hiddenDesc.get.call(document) : false);
  const spoof = () => active && realHidden();

  try {
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get() { return spoof() ? false : hiddenDesc.get.call(this); } });
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get() { return spoof() ? "visible" : visDesc.get.call(this); } });
    const origHasFocus = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function () { return spoof() ? true : origHasFocus.call(this); };
  } catch (e) {}
  // Que Flow no se entere de que la pestaña se ha ocultado mientras trabajamos.
  for (const [target, type] of [[document, "visibilitychange"], [window, "blur"], [window, "pagehide"]]) {
    target.addEventListener(type, (ev) => { if (active && type !== "pagehide") ev.stopImmediatePropagation(); }, true);
  }

  // requestAnimationFrame con la pestaña oculta: se encolan y se ejecutan nosotros.
  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  const queue = new Map();
  let nextId = 1e9;
  let scheduled = false;
  function flushRAF() {
    scheduled = false;
    if (!queue.size) return;
    const cbs = Array.from(queue.values());
    queue.clear();
    const t = performance.now();
    for (const cb of cbs) {
      try { cb(t); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }
  window.requestAnimationFrame = function (cb) {
    if (!spoof()) return origRAF(cb);
    const id = ++nextId;
    queue.set(id, cb);
    if (!scheduled) { scheduled = true; setTimeout(flushRAF, 16); }
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (queue.has(id)) queue.delete(id);
    else origCAF(id);
  };

  // Animaciones y transiciones finitas en marcha → se terminan (dispara sus
  // "finish"/"transitionend", de los que suele depender el siguiente paso).
  function finishAnimations() {
    if (!spoof() || !document.getAnimations) return;
    for (const a of document.getAnimations()) {
      try {
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
        if (a.playState === "running" && Number.isFinite(end)) a.finish();
      } catch (e) {}
    }
  }

  function tick() {
    if (!spoof()) return;
    flushRAF();
    finishAnimations();
  }
  document.addEventListener("fbr-tick", tick);
  document.addEventListener("fbr-bg-on", () => { active = true; tick(); });
  document.addEventListener("fbr-bg-off", () => { active = false; flushRAF(); });
})();
