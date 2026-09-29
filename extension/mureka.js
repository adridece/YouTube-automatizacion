/*
 * Cerezium Autopilot — pestaña de Mureka (v2.10): genera la MÚSICA del Short.
 *
 * Receta del usuario (29 sep 2026), en www.mureka.ai/create:
 *   1) escribir el prompt en el cuadro del compositor;
 *   2) pulsar generar (UNA vez: cada generación gasta créditos);
 *   3) esperar a que se genere e ir a "Library";
 *   4) darle al play de la ÚLTIMA canción: entonces aparece en Network → Media
 *      un archivo que empieza por "music…", que es el que se guarda.
 * background.js (runMusic) orquesta y escucha la red; aquí solo se toca la página.
 *
 * Selectores: los del usuario SIN las partes largas/dinámicas. [SUPUESTO]
 * hasta verlo funcionar en su cuenta.
 */
if (window.__cerMurekaLoaded) {
  console.log("[Cerezium] mureka.js ya cargado");
} else {
window.__cerMurekaLoaded = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (s, r) => { try { return Array.from((r || document).querySelectorAll(s)); } catch (e) { return []; } };
const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();

const SEL = {
  prompt: [".co-produce-mode__composer form textarea", ".co-produce-mode__composer textarea", ".create-edit-easy textarea"],
  generate: [".co-produce-mode__composer .composer__primary-actions button", ".composer__primary-actions button", "button .composer__submit-icon"],
  libraryNav: [".main-nav .nav-wraper-main > div:nth-child(6) > div", ".main-nav .nav-wraper-main > div:nth-child(6)"],
  firstItem: [".search-result-box .pull-to-load-main-list > div:nth-child(1)", ".pull-to-load-main-list > div:nth-child(1)"],
  playIn: [".audio-item-info-play-box i", ".audio-item-info-play-box"],
};
function first(list, root) {
  for (const s of list) { const el = $$(s, root).find(visible); if (el) return el; }
  return null;
}

// ------------------------------------------------------------ PROMPT
function promptBox() { return first(SEL.prompt); }
async function writePrompt(text) {
  let ta = null;
  for (let i = 0; i < 40 && !(ta = promptBox()); i++) await sleep(500);
  if (!ta) throw new Error("no encuentro el cuadro del prompt de Mureka (¿estás en www.mureka.ai/create?)");
  ta.focus();
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  set.call(ta, "");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  set.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(600);
  let ok = norm((promptBox() || ta).value) === norm(text);
  if (!ok) {
    // Teclado REAL (depurador) de reserva.
    ta.focus();
    ta.select();
    await chrome.runtime.sendMessage({ type: "DBG_SELECT_ALL_DELETE" }).catch(() => null);
    await chrome.runtime.sendMessage({ type: "DBG_TYPE", text }).catch(() => null);
    await sleep(600);
    ok = norm((promptBox() || ta).value) === norm(text);
  }
  if (!ok) throw new Error(`escribí el prompt pero el cuadro de Mureka no lo muestra (tiene ${(promptBox() || ta).value.length} caracteres)`);
  return { ok: true };
}

// Clic REAL (depurador) en el centro del elemento; si no, clic normal.
async function realClick(el) {
  el.scrollIntoView({ block: "center" });
  await sleep(300);
  const r = el.getBoundingClientRect();
  const res = await chrome.runtime.sendMessage({ type: "DBG_CLICK", x: r.left + r.width / 2, y: r.top + r.height / 2 }).catch(() => null);
  if (!res || !res.ok) el.click();
  return !!(res && res.ok);
}

// ------------------------------------------------------------ LIBRARY
function inLibrary() { return !!first(SEL.firstItem) || /\/library/.test(location.pathname); }
function findLibraryNav() {
  const bySel = first(SEL.libraryNav);
  if (bySel) return bySel;
  return $$(".main-nav *").find((e) => visible(e) && /^\s*(library|biblioteca)\s*$/i.test(e.textContent || "")) || null;
}
// "Firma" de la primera canción de la biblioteca (para saber si es la NUEVA).
function firstItemInfo() {
  const it = first(SEL.firstItem);
  if (!it) return { exists: false };
  const text = norm(it.textContent).slice(0, 200);
  const play = first(SEL.playIn, it);
  const busy = /generat|generando|creating|creando|queue|cola|\b\d{1,3}\s?%/i.test(text);
  return { exists: true, sig: text, hasPlay: !!play, busy };
}

// ¿Suena algo? (lo publica page-hook.js en <html data-fbr-playing>). -1 = no se sabe.
function playingNow() {
  const v = document.documentElement.getAttribute("data-fbr-playing");
  return v == null ? -1 : parseInt(v, 10) || 0;
}

// Segundo plano (igual que Flow/HeyGen): la página "cree" estar visible.
let awakeTimer = null;
function setAwake(on) {
  document.dispatchEvent(new CustomEvent(on ? "fbr-bg-on" : "fbr-bg-off"));
  clearInterval(awakeTimer);
  awakeTimer = on ? setInterval(() => document.dispatchEvent(new CustomEvent("fbr-tick")), 500) : null;
}

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
  const reply = (p) => { p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) })); return true; };
  switch (msg.type) {
    case "MU_PING":
      sendResponse({ ok: true, url: location.href, hasPrompt: !!promptBox(), inLibrary: inLibrary() });
      return false;
    case "MU_AWAKE":
      setAwake(!!msg.on);
      sendResponse({ ok: true, visible: document.visibilityState });
      return false;
    case "MU_WRITE":
      return reply(writePrompt(msg.text));
    case "MU_GENERATE":
      // UNA sola vez: gasta créditos de Mureka.
      return reply((async () => {
        if (norm((promptBox() || {}).value) !== norm(msg.text)) throw new Error("el prompt no está bien escrito; no pulso generar");
        const btn = first(SEL.generate);
        if (!btn) throw new Error("no encuentro el botón de generar de Mureka");
        const b = btn.closest("button") || btn;
        if (b.disabled) throw new Error("el botón de generar está desactivado (¿sin créditos o sin sesión?)");
        const real = await realClick(b);
        return { ok: true, real };
      })());
    case "MU_LIBRARY":
      return reply((async () => {
        if (!inLibrary()) {
          const nav = findLibraryNav();
          if (!nav) throw new Error("no encuentro el botón «Library» del menú de Mureka");
          await realClick(nav);
        }
        for (let i = 0; i < 40 && !first(SEL.firstItem); i++) await sleep(500);
        return { ok: true, ...firstItemInfo() };
      })());
    case "MU_FIRST":
      sendResponse({ ok: true, ...firstItemInfo() });
      return false;
    case "MU_PLAY_FIRST":
      return reply((async () => {
        const it = first(SEL.firstItem);
        if (!it) throw new Error("la biblioteca de Mureka está vacía o no se ha cargado");
        const play = first(SEL.playIn, it);
        if (!play) throw new Error("no encuentro el botón de play de la última canción");
        const real = await realClick(play);
        return { ok: true, real, sig: norm(it.textContent).slice(0, 200) };
      })());
    case "MU_PLAYING":
      sendResponse({ ok: true, playing: playingNow() });
      return false;
    case "MU_FETCH":
      return reply((async () => {
        const r = await fetch(msg.url, { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        return { ok: true, mime: blob.type || r.headers.get("content-type") || "", size: blob.size, data: await blobToBase64(blob) };
      })());
    default:
      return false;
  }
});
}
