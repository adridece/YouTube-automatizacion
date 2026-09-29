/*
 * Cerezium Autopilot — pestaña de HeyGen (v2.9): genera la VOZ del Short.
 *
 * Lo manda background.js (runVoice) al empezar un lote con narración:
 *   HG_SPEAK {text}  → borra lo que haya en el guion, escribe la narración y
 *                      pulsa el botón de reproducir (clic REAL vía depurador,
 *                      para que el navegador deje reproducir el audio).
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

async function writeScript(text) {
  let ed = null;
  for (let i = 0; i < 40 && !(ed = findEditor()); i++) await sleep(500);
  if (!ed) throw new Error("no encuentro el cuadro del guion de HeyGen (¿está abierto el panel de voz/guion?)");
  const want = norm(text);
  const landed = () => { const e = findEditor() || ed; const t = editorText(e); return t === want || (t.includes(want.slice(0, 40)) && t.includes(want.slice(-30)) && t.length <= want.length + 5); };
  const methods = [
    async () => {
      ed.focus();
      if (ed.tagName === "TEXTAREA") {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(ed, text);
        ed.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, text);
    },
    async () => {
      // Teclado REAL (depurador): Ctrl+A, Supr y texto.
      ed.focus();
      document.execCommand("selectAll", false, null);
      const r = await chrome.runtime.sendMessage({ type: "DBG_SELECT_ALL_DELETE" }).catch(() => null);
      if (!r || !r.ok) throw new Error((r && r.error) || "sin depurador");
      const t = await chrome.runtime.sendMessage({ type: "DBG_TYPE", text }).catch(() => null);
      if (!t || !t.ok) throw new Error((t && t.error) || "sin depurador");
    },
    async () => {
      ed.focus();
      document.execCommand("selectAll", false, null);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
  ];
  const errors = [];
  for (let i = 0; i < methods.length; i++) {
    try { await methods[i](); } catch (e) { errors.push(e.message); continue; }
    for (let k = 0; k < 10 && !landed(); k++) await sleep(300);
    if (landed()) return { ok: true, method: i + 1, before: null };
  }
  const now = editorText(findEditor() || ed);
  throw new Error(`escribí la narración pero el guion no la muestra (tiene ${now.length} caracteres${errors.length ? "; " + errors.join("; ") : ""})`);
}

// -------------------------------------------------------- BOTÓN REPRODUCIR
const PLAY_SELECTORS = [
  // El del usuario, sin las clases css-xxxx.
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
async function clickPlay() {
  let hit = null;
  for (let i = 0; i < 20 && !(hit = findPlayButton()); i++) await sleep(500);
  if (!hit) throw new Error("no encuentro el botón de reproducir de la voz en HeyGen");
  hit.el.scrollIntoView({ block: "center" });
  await sleep(300);
  const r = hit.el.getBoundingClientRect();
  // Clic REAL (depurador): da "gesto de usuario" y el navegador deja sonar el audio.
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false;
  if (msg.type === "HG_PING") { sendResponse({ ok: true, url: location.href, hasEditor: !!findEditor(), hasPlay: !!findPlayButton() }); return false; }
  if (msg.type === "HG_SPEAK") {
    (async () => {
      const w = await writeScript(msg.text);
      await sleep(1500); // HeyGen guarda el guion con un pequeño retraso
      const at = Date.now();
      const p = await clickPlay();
      return { ok: true, writeMethod: w.method, playHow: p.how, realClick: p.real, clickedAt: at };
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
