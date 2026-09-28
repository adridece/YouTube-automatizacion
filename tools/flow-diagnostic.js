/*
 * DIAGNÓSTICO DE SOLO LECTURA para una página de proyecto de Flow.
 *
 * Para qué sirve: Claude Code en la nube NO puede ver tu navegador ni tu
 * sesión de Flow. Cuando algo falle, pega este script en la consola de
 * DevTools (F12 -> Console) de la pestaña de Flow, y pega el resultado en la
 * conversación con Claude Code. No hace clics, no escribe nada, no gasta puntos.
 * (Chrome puede pedir que escribas "allow pasting" la primera vez.)
 */
(() => {
  const count = (sel) => document.querySelectorAll(sel).length;
  const label = (t) => (t.querySelector(".footer-title")?.textContent || "").trim() || null;
  const dialogs = Array.from(document.querySelectorAll("flow-permission-message")).map((m) => ({
    texto: m.textContent.trim().slice(0, 90),
    pendiente: !!m.querySelector(".option-row:not(.read-only):not([aria-disabled='true'])"),
  }));
  const editor = document.querySelector('flow-agent-panel flow-rich-text-editor [contenteditable="true"]');
  const report = {
    url: location.href,
    cuenta: (location.pathname.match(/\/u\/(\d+)/) || [])[1] ?? null,
    selectores: {
      cajaDePrompt: count('flow-agent-panel flow-rich-text-editor [contenteditable="true"]'),
      botonGenerar: count("flow-agent-panel flow-generate-icon-button"),
      botonGenerarSubmitInterno: count('flow-agent-panel flow-generate-icon-button button[type="submit"]'),
      botonMas: count("flow-agent-panel flow-add-menu button"),
    },
    textoEnLaCaja: editor ? editor.textContent.trim().slice(0, 80) : null,
    menuMasAbierto: !!document.querySelector(".cdk-overlay-container flow-add-menu-popover-content"),
    tilesImagen: Array.from(document.querySelectorAll("flow-image-tile")).map(label),
    tilesVideo: count("flow-video-tile"),
    tilesPendientes: count("flow-pending-tile"),
    avisosDeCoste: dialogs,
    notas: "tilesImagen muestra el nombre de cada imagen en orden de DOM (NO es orden numérico).",
  };
  const txt = JSON.stringify(report, null, 2);
  console.log(txt);
  if (typeof copy === "function") { copy(txt); console.log("(resultado copiado al portapapeles)"); }
  return report;
})();
