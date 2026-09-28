/*
 * DIAGNÓSTICO DE SOLO LECTURA para una página de proyecto de Flow (v2).
 *
 * Para qué sirve: Claude Code en la nube NO puede ver tu navegador ni tu
 * sesión de Flow. Cuando algo falle, pega este script en la consola de
 * DevTools (F12 -> Console) de la pestaña de Flow, y pega el resultado en la
 * conversación con Claude Code. No hace clics, no escribe nada, no gasta puntos.
 * (Chrome puede pedir que escribas "allow pasting" la primera vez.)
 *
 * Mejor aún si lo ejecutas en estos momentos (cada uno da datos distintos):
 *  a) con el proyecto recién abierto;
 *  b) con el menú "+" ABIERTO (la lista de imágenes visible);
 *  c) con un aviso de coste pendiente en el chat (luego pulsa "Rechazar").
 */
(() => {
  const count = (sel) => document.querySelectorAll(sel).length;
  const label = (t) => (t.querySelector(".footer-title")?.textContent || "").trim() || null;
  const kind = (u) => (!u ? null : u.startsWith("blob:") ? "blob" : u.startsWith("data:") ? "data" : /^https?:/.test(u) ? "https:" + new URL(u, location.href).host : "relativa");
  const attrs = (el) => Object.fromEntries(Array.from(el.attributes).filter((a) => !/^_ng|^style$/.test(a.name)).map((a) => [a.name, a.value.slice(0, 60)]));
  const tileInfo = (t) => {
    const v = t.querySelector("video");
    const img = t.querySelector("img");
    return {
      nombre: label(t),
      atributos: attrs(t),
      videoSrc: v ? kind(v.getAttribute("src") || v.currentSrc || v.querySelector("source")?.src) : null,
      imgSrc: img ? kind(img.getAttribute("src")) : null,
      enlace: t.querySelector("a[href]")?.getAttribute("href")?.slice(0, 60) || null,
      textoError: /no se ha podido generar|error/i.test(t.textContent || "") ? (t.textContent || "").trim().slice(0, 80) : null,
    };
  };
  const scrollParent = (el) => { for (let p = el?.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 10) return p; } return null; };
  const firstTile = document.querySelector("flow-image-tile, flow-video-tile");
  const sp = scrollParent(firstTile);
  const dialogs = Array.from(document.querySelectorAll("flow-permission-message")).map((m) => ({
    texto: m.textContent.trim().slice(0, 90),
    pendiente: !!m.querySelector(".option-row:not(.read-only):not([aria-disabled='true'])"),
    filas: Array.from(m.querySelectorAll(".option-row")).map((r) => ({ etiqueta: r.getAttribute("aria-label"), clase: r.className, hijos: r.children.length })),
  }));
  const editor = document.querySelector('flow-agent-panel flow-rich-text-editor [contenteditable="true"]');
  const form = editor?.closest("form") || editor?.closest("flow-agent-panel");
  const panel = document.querySelector("flow-agent-panel");
  const panelText = panel ? panel.textContent : "";
  const report = {
    version: "diag-v2",
    url: location.href,
    cuenta: (location.pathname.match(/\/u\/(\d+)/) || [])[1] ?? null,
    pestanaVisible: document.visibilityState,
    extensionCargada: !!document.getElementById("fbr-host"),
    selectores: {
      cajaDePrompt: count('flow-agent-panel flow-rich-text-editor [contenteditable="true"]'),
      botonGenerar: count("flow-agent-panel flow-generate-icon-button"),
      botonGenerarSubmitInterno: count('flow-agent-panel flow-generate-icon-button button[type="submit"]'),
      botonGenerarDeshabilitado: !!document.querySelector('flow-agent-panel flow-generate-icon-button button[disabled], flow-agent-panel flow-generate-icon-button button[aria-disabled="true"]'),
      botonMas: count("flow-agent-panel flow-add-menu button"),
    },
    textoEnLaCaja: editor ? editor.textContent.trim().slice(0, 80) : null,
    adjuntosEnLaCaja: form ? Array.from(form.querySelectorAll("img")).map((i) => ({ alt: i.alt?.slice(0, 30), src: kind(i.getAttribute("src")), padre: i.parentElement?.tagName.toLowerCase() })) : null,
    menuMas: {
      abierto: !!document.querySelector(".cdk-overlay-container flow-add-menu-popover-content"),
      items: Array.from(document.querySelectorAll(".cdk-overlay-container flow-add-menu-asset-item")).slice(0, 25).map((i) => i.textContent.trim().slice(0, 30)),
      viewportVirtual: !!document.querySelector(".cdk-overlay-container cdk-virtual-scroll-viewport"),
      vistaPrevia: document.querySelector(".cdk-overlay-container flow-add-menu-detail-pane")?.textContent.trim().slice(0, 60) || null,
    },
    cuadricula: {
      tilesImagen: Array.from(document.querySelectorAll("flow-image-tile")).map(label),
      tilesVideo: count("flow-video-tile"),
      tilesPendientes: count("flow-pending-tile"),
      contenedorScroll: sp ? { tag: sp.tagName.toLowerCase(), clase: String(sp.className).slice(0, 60), scrollHeight: sp.scrollHeight, clientHeight: sp.clientHeight } : null,
      // Si hay muchas más alturas que tiles, la cuadrícula es "virtual" (no pinta lo que no se ve).
      primerosVideos: Array.from(document.querySelectorAll("flow-video-tile")).slice(0, 4).map(tileInfo),
      primerasImagenes: Array.from(document.querySelectorAll("flow-image-tile")).slice(0, 2).map(tileInfo),
    },
    avisosDeCoste: dialogs,
    mensajesDelAgent: {
      etiquetasHijas: panel ? [...new Set(Array.from(panel.querySelectorAll("*")).map((e) => e.tagName.toLowerCase()).filter((t) => t.startsWith("flow-")))].slice(0, 40) : [],
      demasiadoRapido: (panelText.match(/demasiado r[aá]pido/gi) || []).length,
      bloqueosPolitica: (panelText.match(/pol[ií]ticas/gi) || []).length,
      mencionesPuntosOCreditos: (panelText.match(/[^.?!]{0,60}(puntos|cr[eé]ditos)[^.?!]{0,40}/gi) || []).slice(-5),
      botonesReintentar: Array.from(panel ? panel.querySelectorAll("button") : []).filter((b) => /reintentar/i.test(b.textContent)).length,
    },
    notas: "tilesImagen va en orden de DOM (NO numérico). Pega TODO este texto a Claude.",
  };
  const txt = JSON.stringify(report, null, 2);
  console.log(txt);
  if (typeof copy === "function") { copy(txt); console.log("(resultado copiado al portapapeles)"); }
  return report;
})();
