/*
 * Cerezium Autopilot — pestaña de HeyGen (v2.9): genera la VOZ del Short.
 *
 * Lo manda background.js (runVoice) al empezar un lote con narración:
 *   HG_WRITE {text}  → borra lo que haya en el guion y escribe la narración
 *                      (NO pulsa play).
 *   HG_PLAY_ONCE {text} → pulsa reproducir UNA vez (clic REAL vía depurador),
 *                      solo si el guion es exactamente la narración: HeyGen
 *                      permite 3 previsualizaciones al día.
 *   HG_MEDIA {since} → audios/vídeos que la página ha cargado desde `since`
 *                      (lo mismo que se ve en DevTools → Network → Media).
 *   HG_FETCH {url}   → lee ese audio desde la propia página y lo devuelve en
 *                      base64 (para guardarlo en la carpeta del lote).
 *
 * Selectores: los que dio el usuario (28-29 sep 2026) SIN las clases
 * "css-xxxx" (cambian con cada versión de HeyGen) y, de reserva, búsquedas
 * por atributos. [SUPUESTO] hasta verlo funcionar en su cuenta.
 */
if (window.__cerHeygenLoaded) {
  console.log("[Cerezium] heygen.js ya cargado");
} else {
window.__cerHeygenLoaded = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, r) => { try { return Array.from((r || document).querySelectorAll(s)); } catch (e) { return []; } };
const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------ GUION (texto)
const EDITOR_SELECTORS = [
  '.te-scriptpanel-redesign [contenteditable="true"]',
  ".te-scriptpanel-redesign > div:nth-child(2) > div > div",
  ".te-scriptpanel-redesign textarea",
  '[class*="scriptpanel"] [contenteditable="true"]',
];
function editableIn(el) {
  if (!el) return null;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return el.closest('[contenteditable="true"]') || el;
  return el.querySelector('[contenteditable="true"], textarea');
}
function findEditor() {
  for (const s of EDITOR_SELECTORS) {
    for (const el of $$(s)) {
      const ed = editableIn(el);
      if (ed && visible(ed)) return ed;
    }
  }
  // Reserva: el editable visible más grande de la página.
  const all = $$('[contenteditable="true"], textarea').filter(visible);
  all.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
  return all[0] || null;
}
function editorText(ed) { return norm(ed.tagName === "TEXTAREA" ? ed.value : ed.innerText || ed.textContent); }

// Comparación "de contenido": solo letras y números, sin tildes ni signos.
// HeyGen muestra el guion con su propio formato (saltos, espacios, comillas…)
// y la prueba real v2.9.1 dio por fallido un texto que SÍ estaba bien pegado.
const core = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ]/g, "");
function selectAllIn(ed) {
  ed.focus();
  if (ed.tagName === "TEXTAREA") { ed.select(); return; }
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(ed);
  sel.removeAllRanges();
  sel.addRange(r);
}
// Deja el guion VACÍO (lo que hubiera antes). Devuelve true si lo consigue.
async function clearEditor(getEd) {
  for (let round = 0; round < 3; round++) {
    const ed = getEd();
    if (!editorText(ed)) return true;
    if (ed.tagName === "TEXTAREA") {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(ed, "");
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (round === 0) {
      selectAllIn(ed);
      document.execCommand("delete", false, null);
    } else {
      // Teclado REAL (depurador): Ctrl+A + Retroceso dentro del guion.
      selectAllIn(ed);
      await chrome.runtime.sendMessage({ type: "DBG_SELECT_ALL_DELETE" }).catch(() => null);
    }
    for (let k = 0; k < 8 && editorText(getEd()); k++) await sleep(250);
  }
  return !editorText(getEd());
}

// ¿El guion tiene EXACTAMENTE la narración? "ok" · "parcial" · "doble" · "no".
function scriptState(text) {
  const ed = findEditor();
  if (!ed) return "no";
  const want = core(text);
  const c = core(editorText(ed));
  if (c === want) return "ok";
  const hasStart = c.includes(want.slice(0, 60));
  const hasEnd = c.includes(want.slice(-40));
  if (hasStart && hasEnd && c.length <= want.length * 1.1 + 20) return "ok";
  if (hasStart && c.length > want.length * 1.1 + 20) return "doble";
  return hasStart ? "parcial" : "no";
}

async function writeScript(text) {
  let ed = null;
  for (let i = 0; i < 40 && !(ed = findEditor()); i++) await sleep(500);
  if (!ed) throw new Error("no encuentro el cuadro del guion de HeyGen (¿está abierto el panel de voz/guion?)");
  const getEd = () => findEditor() || ed;
  const want = core(text);
  const state = () => {
    const c = core(editorText(getEd()));
    if (c === want) return "ok";
    const hasStart = c.includes(want.slice(0, 60));
    const hasEnd = c.includes(want.slice(-40));
    if (hasStart && hasEnd && c.length <= want.length * 1.1 + 20) return "ok";
    if (hasStart && c.length > want.length * 1.1 + 20) return "doble"; // quedó texto viejo o repetido
    return hasStart ? "parcial" : "no";
  };
  // Si ya está exactamente la narración (p. ej. un reintento), no se toca.
  if (state() === "ok") return { ok: true, method: 0 };
  const methods = [
    async (e) => { selectAllIn(e); document.execCommand("insertText", false, text); },
    async (e) => {
      selectAllIn(e);
      const t = await chrome.runtime.sendMessage({ type: "DBG_TYPE", text }).catch(() => null);
      if (!t || !t.ok) throw new Error((t && t.error) || "sin depurador");
    },
    async (e) => {
      selectAllIn(e);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      e.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
  ];
  const errors = [];
  for (let i = 0; i < methods.length; i++) {
    // Antes de cada forma de escribir, el guion se deja vacío: así nunca se
    // acumula texto (antes: 718 → 1398 → 2796 caracteres).
    if (!(await clearEditor(getEd))) errors.push("no pude vaciar el guion");
    try { await methods[i](getEd()); } catch (e) { errors.push(e.message); continue; }
    for (let k = 0; k < 12 && state() !== "ok"; k++) await sleep(250);
    const st = state();
    if (st === "ok") return { ok: true, method: i + 1 };
    if (st === "parcial") {
      // Empieza por la narración pero no se puede confirmar entera: mejor seguir
      // (pulsar play) que fallar; el log lo dice.
      return { ok: true, method: i + 1, partial: true, chars: editorText(getEd()).length };
    }
  }
  throw new Error(`no pude dejar solo la narración en el guion (tiene ${editorText(getEd()).length} caracteres${errors.length ? "; " + errors.join("; ") : ""})`);
}

// -------------------------------------------------------- BOTÓN REPRODUCIR
const PLAY_SELECTORS = [
  // El del usuario (29 sep 2026, v2.9.7): "… > div:nth-child(1) > button" (play y parar), sin clases css-xxxx.
  "div.tw-h-\\[168px\\] > div.tw-border-b.tw-border-line.tw-pb-2 > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) > button",
  "div.tw-border-b.tw-border-line.tw-pb-2 > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) > button",
  // El del usuario (29 sep 2026, v2.9.1: termina en "> button"), sin las clases css-xxxx.
  "div.tw-h-\\[168px\\] > div.tw-border-b.tw-border-line.tw-pb-2 > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) > div > button",
  "div.tw-border-b.tw-border-line.tw-pb-2 > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) > div > button",
  "div.tw-border-b.tw-border-line.tw-pb-2 > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) button",
  "div.tw-border-b.tw-border-line.tw-pb-2 > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) > div",
  "div.tw-h-\\[168px\\] div.tw-border-b > div.tw-gap-3 > div:nth-child(1) > div",
  "div.tw-h-\\[168px\\] div.tw-border-b div.tw-gap-3 > div:nth-child(1)",
];
const PLAY_RE = /\b(play|reproducir|preview|previsualizar|escuchar|listen|reproduce)\b/i;
function findPlayButton() {
  for (const s of PLAY_SELECTORS) {
    const el = $$(s).find(visible);
    if (el) return { el, how: "selector" };
  }
  const cands = $$('button, [role="button"], [aria-label], [data-testid], [title]').filter(visible);
  const byAttr = cands.find((e) => PLAY_RE.test(`${e.getAttribute("aria-label") || ""} ${e.getAttribute("title") || ""} ${e.getAttribute("data-testid") || ""}`));
  if (byAttr) return { el: byAttr.closest('button, [role="button"]') || byAttr, how: "atributo" };
  return null;
}
async function clickPlay(plain) {
  let hit = null;
  for (let i = 0; i < 20 && !(hit = findPlayButton()); i++) await sleep(500);
  if (!hit) throw new Error("no encuentro el botón de reproducir de la voz en HeyGen");
  hit.el.scrollIntoView({ block: "center" });
  await sleep(300);
  const r = hit.el.getBoundingClientRect();
  // Clic REAL (depurador): da "gesto de usuario" y el navegador deja sonar el audio.
  if (plain) { hit.el.click(); return { how: hit.how, real: false }; }
  const real = await chrome.runtime.sendMessage({ type: "DBG_CLICK", x: r.left + r.width / 2, y: r.top + r.height / 2 }).catch(() => null);
  if (!real || !real.ok) hit.el.click();
  return { how: hit.how, real: !!(real && real.ok) };
}

// -------------------------------------------------------- AUDIO CARGADO
// Reserva por si el depurador no ve la petición: lo que la página ha cargado
// (Resource Timing) y los <audio>/<video> de la página.
const MEDIA_EXT = /\.(mp3|wav|m4a|aac|ogg|opus|webm|mp4)(\?|#|$)/i;
function mediaSince(sinceEpoch) {
  const out = [];
  const t0 = performance.timeOrigin;
  for (const e of performance.getEntriesByType("resource")) {
    if (t0 + e.startTime < sinceEpoch) continue;
    if (/^(audio|video)$/.test(e.initiatorType) || MEDIA_EXT.test(e.name)) out.push({ url: e.name, source: "timing" });
  }
  for (const m of $$("audio, video")) {
    const u = m.currentSrc || m.src;
    if (u && (m.__cerSeenAt || 0) >= sinceEpoch) out.push({ url: u, source: "elemento" });
  }
  return out;
}
// Marca cuándo cambia la fuente de cada <audio>/<video> del documento.
new MutationObserver(() => {
  for (const m of $$("audio, video")) {
    const u = m.currentSrc || m.src;
    if (u && m.__cerLastSrc !== u) { m.__cerLastSrc = u; m.__cerSeenAt = Date.now(); }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
document.addEventListener("play", (ev) => { const m = ev.target; if (m && (m.currentSrc || m.src)) { m.__cerLastSrc = m.currentSrc || m.src; m.__cerSeenAt = Date.now(); } }, true);

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ¿Suena algo ahora en la página? (lo publica page-hook.js). -1 = no se sabe.
function playingNow() {
  const v = document.documentElement.getAttribute("data-fbr-playing");
  return v == null ? -1 : parseInt(v, 10) || 0;
}

// SEGUNDO PLANO (igual que en Flow): mientras la extensión trabaja aquí, la
// página "cree" estar visible y sus animaciones/fotogramas avanzan aunque el
// usuario mire otra pestaña (page-hook.js, mundo de la página).
let awakeTimer = null;
function setAwake(on) {
  document.dispatchEvent(new CustomEvent(on ? "fbr-bg-on" : "fbr-bg-off"));
  clearInterval(awakeTimer);
  awakeTimer = on ? setInterval(() => document.dispatchEvent(new CustomEvent("fbr-tick")), 500) : null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false;
  if (msg.type === "HG_AWAKE") { setAwake(!!msg.on); sendResponse({ ok: true, visible: document.visibilityState }); return false; }
  if (msg.type === "HG_PING") { sendResponse({ ok: true, url: location.href, hasEditor: !!findEditor(), hasPlay: !!findPlayButton() }); return false; }
  if (msg.type === "HG_WRITE") {
    // Solo escribe (NO pulsa play): pulsar play gasta una previsualización.
    (async () => {
      const w = await writeScript(msg.text);
      await sleep(1500); // HeyGen guarda el guion con un pequeño retraso
      return { ok: true, writeMethod: w.method, state: scriptState(msg.text), chars: editorText(findEditor() || document.body).length };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "HG_PLAYING") { sendResponse({ ok: true, playing: playingNow() }); return false; }
  if (msg.type === "HG_TOGGLE") {
    // PARAR la reproducción con el mismo botón (receta del usuario: play →
    // ~10 s sonando → volver a pulsar → la voz sale en Network → Media).
    // Se COMPRUEBA que ha dejado de sonar; si sigue sonando, se prueba otra
    // forma de pulsar. Nunca se pulsa si ya no suena (volvería a reproducir).
    (async () => {
      const before = playingNow();
      if (before === 0 && msg.everPlayed) return { ok: true, skipped: true, before, after: 0 };
      const tries = [];
      for (const plain of [false, true, "keys"]) {
        const hit = findPlayButton();
        if (!hit) throw new Error("no encuentro el botón de reproducir para pararlo");
        if (plain === "keys") { hit.el.focus(); hit.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); hit.el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); tries.push("teclado"); }
        else { const p = await clickPlay(plain); tries.push(p.real ? "clic real" : "clic normal"); }
        await sleep(1500);
        const now = playingNow();
        // Sin forma de saber si suena (-1): se confía en el primer clic.
        if (now <= 0) return { ok: true, before, after: now, tries };
      }
      return { ok: true, before, after: playingNow(), tries, stillPlaying: true };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "HG_PLAY_ONCE") {
    // Pulsa reproducir UNA vez, y solo si el guion es exactamente la narración
    // y el botón es el que dio el usuario (HeyGen: máx. 3 previsualizaciones/día).
    (async () => {
      const st = scriptState(msg.text);
      if (st !== "ok") throw new Error(`el guion no coincide con la narración (${st}); no pulso reproducir para no gastar una previsualización`);
      const hit = findPlayButton();
      if (!hit) throw new Error("no encuentro el botón de reproducir de la voz; no pulso nada");
      if (hit.how !== "selector" && !msg.allowFallback) throw new Error("no encuentro el botón de reproducir en su sitio (selector del usuario); no pulso nada para no gastar una previsualización");
      const at = Date.now();
      const p = await clickPlay();
      return { ok: true, ...p, clickedAt: at };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "HG_MEDIA") { sendResponse({ ok: true, items: mediaSince(msg.since || 0) }); return false; }
  if (msg.type === "HG_FETCH") {
    (async () => {
      const r = await fetch(msg.url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      return { ok: true, mime: blob.type || r.headers.get("content-type") || "", size: blob.size, data: await blobToBase64(blob) };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
}
