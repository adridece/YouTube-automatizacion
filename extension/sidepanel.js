/*
 * Panel lateral de Chrome (sustituye al popup, que se cerraba solo al perder
 * el foco). Lee el estado de cada lote (chrome.storage "batch_uN") y el log
 * ("fbrLog") y se actualiza en vivo con storage.onChanged.
 * Funciones puras (parseo del kit, nombres, resúmenes…) en shared.js.
 */
const $ = (id) => document.getElementById(id);
// Dónde estamos: panel lateral, ventanita del icono (?modo=popup) o ventana flotante (?modo=ventana).
const MODO = new URLSearchParams(location.search).get("modo") || "panel";
document.documentElement.classList.add(`modo-${MODO}`);
function openFloating() {
  chrome.runtime.sendMessage({ type: "OPEN_PANEL" });
  if (MODO === "popup") window.close();
}

// ------------------------------------------------------------- ICONOS
const ICONS = {
  spark: '<path d="M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7z" fill="currentColor"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" fill="currentColor"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v9.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0014.5 4h-9A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M4 16l5-5 4 4 3-3 4 4"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  popout: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
};
function icon(name, size) {
  const s = size || 16;
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
function hydrateIcons(root) {
  (root || document).querySelectorAll("[data-icon]").forEach((el) => {
    if (!el.dataset.done) { el.innerHTML = icon(el.dataset.icon, el.classList.contains("logo") ? 20 : 16); el.dataset.done = "1"; }
  });
}
const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3500);
}

// ------------------------------------------------------------ PESTAÑAS
const TABS = ["lote", "progreso", "log"];
function showTab(name, focus) {
  for (const t of TABS) {
    const b = $(`tab-${t}`);
    const on = t === name;
    b.setAttribute("aria-selected", on);
    b.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (on && focus) b.focus();
  }
  try { localStorage.setItem("fbrTab", name); } catch (e) {}
}
TABS.forEach((t, i) => {
  const b = $(`tab-${t}`);
  b.addEventListener("click", () => showTab(t));
  b.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      showTab(n, true);
      e.preventDefault();
    }
  });
});

// ------------------------------------------------------------ FORMULARIO
const FORM_KEY = "fbrForm";
const FIELDS = ["prompts", "accA_on", "accA_num", "accA_range", "accA_res", "accB_on", "accB_num", "accB_range", "accB_res", "nameFormat", "prefix", "genMode", "maxWait", "maxRetries", "autoRun"];
function radio(name) { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? r.value : null; }
function setRadio(name, v) { const r = document.querySelector(`input[name="${name}"][value="${v}"]`); if (r) r.checked = true; }

function readForm() {
  const f = {};
  for (const id of FIELDS) { const el = $(id); f[id] = el.type === "checkbox" ? el.checked : el.value; }
  f.runMode = radio("runMode");
  f.dest = radio("dest");
  return f;
}
async function saveForm() { await chrome.storage.local.set({ [FORM_KEY]: readForm() }); }
async function loadForm() {
  const f = (await chrome.storage.local.get(FORM_KEY))[FORM_KEY];
  if (!f) return;
  for (const id of FIELDS) {
    const el = $(id);
    if (f[id] === undefined) continue;
    if (el.type === "checkbox") el.checked = !!f[id];
    else el.value = f[id];
  }
  if (f.runMode) setRadio("runMode", f.runMode);
  if (f.dest) setRadio("dest", f.dest);
}
let saveT = null;
document.addEventListener("input", () => { clearTimeout(saveT); saveT = setTimeout(saveForm, 400); refreshDerived(); });
document.addEventListener("change", () => { saveForm(); refreshDerived(); });

// "2", "u2", "/u/2/" -> "u2"
function accKey(v) { return `u${String(v || "").replace(/\D/g, "")}`; }
function accounts(f) {
  const out = [];
  for (const k of ["A", "B"]) {
    if (!f[`acc${k}_on`]) continue;
    out.push({ label: k, accountKey: accKey(f[`acc${k}_num`]), range: f[`acc${k}_range`], sceneNumbers: parseRange(f[`acc${k}_range`]), resolution: f[`acc${k}_res`] });
  }
  return out;
}

// ------------------------------------------------- DERIVADOS (en vivo)
let flowTabs = [];
async function refreshTabs() {
  flowTabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/tools/flow/*"] });
  const keys = [...new Set(flowTabs.map((t) => getFlowAccountKey(t.url)))];
  $("tabsFound").textContent = keys.length ? `Abiertas: ${keys.map((k) => k.replace("u", "/u/") + "/").join(" ")}` : "Ninguna pestaña de Flow abierta";
  refreshDerived();
}
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.status === "complete") refreshTabs(); });
chrome.tabs.onRemoved.addListener(refreshTabs);

function refreshDerived() {
  const f = readForm();
  // Kit
  const { images, animations } = splitCombinedPrompts(f.prompts);
  const chips = [];
  if (!images.size && !animations.size) chips.push('<span>Pega el kit para ver qué detecto</span>');
  else {
    chips.push(`<span class="ok">${icon("image", 13)}${images.size} imagen(es)</span>`);
    chips.push(`<span class="${animations.size ? "ok" : "warn"}">${icon("video", 13)}${animations.size} animación(es)</span>`);
    const noAnim = [...images.keys()].filter((n) => !animations.has(n));
    if (animations.size && noAnim.length) chips.push(`<span class="warn">${icon("alert", 13)}sin animación: ${noAnim.map(pad3).join(", ")}</span>`);
  }
  $("kitSummary").innerHTML = chips.join("");

  // Cuentas
  const accs = accounts(f);
  for (const k of ["A", "B"]) {
    const on = f[`acc${k}_on`];
    document.querySelector(`.acc[data-acc="${k}"]`).classList.toggle("off", !on);
    const key = accKey(f[`acc${k}_num`]);
    const tab = flowTabs.find((t) => getFlowAccountKey(t.url) === key);
    const el = $(`acc${k}_state`);
    if (!on) { el.textContent = ""; el.className = "tabstate"; continue; }
    if (!tab) { el.innerHTML = `${icon("alert", 12)}sin pestaña /u/${esc(f[`acc${k}_num`])}/`; el.className = "tabstate bad"; }
    else if (!/\/project\//.test(tab.url)) { el.innerHTML = `${icon("alert", 12)}abre un proyecto`; el.className = "tabstate bad"; }
    else { el.innerHTML = `${icon("check", 12)}pestaña lista`; el.className = "tabstate ok"; }
  }
  const all = accs.flatMap((a) => a.sceneNumbers);
  const overlap = all.filter((n, i) => all.indexOf(n) !== i);
  const missingImg = images.size ? all.filter((n) => !images.has(n)) : [];
  const hint = $("rangeHint");
  if (overlap.length) { hint.textContent = `Las escenas ${[...new Set(overlap)].map(pad3).join(", ")} están en las dos cuentas: se harían dos veces.`; hint.className = "hint bad"; }
  else if (missingImg.length) { hint.textContent = `Las escenas ${missingImg.map(pad3).join(", ")} no tienen prompt de imagen en el kit.`; hint.className = "hint bad"; }
  else { hint.textContent = accs.map((a) => `${a.accountKey}: ${a.sceneNumbers.length} escena(s) ≈ ${a.sceneNumbers.length * 10} puntos`).join(" · "); hint.className = "hint"; }

  // Salida
  const folderLabel = f.dest === "folder" ? (folderState.name || "<carpeta>") : "Descargas/MundoFutFlow";
  $("pathPreview").textContent = `${folderLabel}/${buildBatchFolderName(new Date(), f.prefix)}/${buildVideoFilename(f.nameFormat, f.prefix, 1)}`;
  const opt = $("nameFormat").querySelector('option[value="prefijo"]');
  opt.textContent = `${sanitizeName(f.prefix, "clip")}_001.mp4`;
  renderChecklist();
}

// ---------------------------------------------------- CARPETA ELEGIDA
const folderState = { has: false, name: null, perm: null };
async function refreshFolder() {
  try { Object.assign(folderState, await fbrRootStatus()); } catch (e) { folderState.has = false; }
  const el = $("folderName");
  if (!folderState.has) { el.textContent = "Sin carpeta"; el.className = "folder-name bad"; $("grantFolder").hidden = true; }
  else if (folderState.perm === "granted") { el.innerHTML = `${esc(folderState.name)} · con permiso`; el.className = "folder-name ok"; $("grantFolder").hidden = true; }
  else { el.textContent = `${folderState.name} · falta permiso`; el.className = "folder-name bad"; $("grantFolder").hidden = false; }
  refreshDerived();
}
$("pickFolder").addEventListener("click", async (e) => {
  e.preventDefault();
  if (MODO === "popup") {
    // El selector de carpetas del sistema cierra la ventanita antes de
    // terminar: se hace en la ventana flotante.
    toast("Abro una ventana para elegir la carpeta…");
    setTimeout(openFloating, 600);
    return;
  }
  try {
    const h = await window.showDirectoryPicker({ id: "fbr-dest", mode: "readwrite", startIn: "desktop" });
    await fbrSetRootHandle(h);
    setRadio("dest", "folder");
    await saveForm();
    toast(`Carpeta elegida: ${h.name}`);
  } catch (err) {
    if (err && err.name !== "AbortError") toast(`No se pudo elegir la carpeta: ${err.message}`);
  }
  refreshFolder();
});
async function ensureFolderPermission() {
  const h = await fbrGetRootHandle();
  if (!h) return { ok: false, error: 'Elige primero la carpeta de destino (Salida → "Elegir").' };
  let p = await h.queryPermission({ mode: "readwrite" });
  if (p !== "granted") {
    if (MODO === "popup") return { ok: false, error: `Falta el permiso para escribir en "${h.name}". Pulsa el botón ↗ (arriba) y en esa ventana pulsa «Conceder acceso».` };
    p = await h.requestPermission({ mode: "readwrite" });
  }
  await refreshFolder();
  return p === "granted" ? { ok: true, name: h.name } : { ok: false, error: `Chrome no ha dado permiso para escribir en "${h.name}".` };
}
$("grantFolder").addEventListener("click", async (e) => {
  e.preventDefault();
  const r = await ensureFolderPermission();
  toast(r.ok ? `Permiso concedido para ${r.name}` : r.error);
});

// -------------------------------------------------------- CHECKLIST
const CHECK_KEY = "fbrChecklist";
let checks = {};
function checklistItems() {
  const dest = radio("dest");
  const items = [
    { id: "confirm", t: "Flow: «Confirmar antes de generar» = Siempre", d: "Ajustes ⚙ → Configuración del agente. Así la extensión lee el coste y solo aprueba si es ≤ 10 puntos." },
    { id: "model", t: "Flow: vídeo con «Omni 1.1 Flash», 9:16 y x1", d: "Imagen y vídeo en 9:16 y cantidad x1. La extensión nunca toca el modelo." },
    { id: "project", t: "Un proyecto NUEVO y vacío en cada cuenta", d: "Si ya hay imágenes «001», «002»… se puede confundir de imagen." },
    { id: "windows", t: "Deja abiertas las pestañas de Flow (puedes usar otras)", d: "Flow trabaja en segundo plano: no hace falta mirarlo. La extensión impide que Chrome descarte esas pestañas y que el ordenador se duerma mientras trabaja. No las cierres ni recargues." },
  ];
  if (dest === "downloads") items.push({ id: "askoff", t: "«Preguntar dónde guardar cada archivo» desactivado", d: 'Solo hace falta con este destino. <a href="#" data-open="chrome://settings/downloads">Abrir ajuste</a>' });
  else items.push({ id: "folderok", t: "Carpeta de destino elegida y con permiso", d: "Se comprueba sola al pulsar «Iniciar lote».", auto: folderState.has && folderState.perm === "granted" });
  return items;
}
function renderChecklist() {
  const items = checklistItems();
  $("checklist").innerHTML = items.map((it) => `<li><label><input type="checkbox" data-check="${it.id}" ${it.auto || checks[it.id] ? "checked" : ""} ${it.auto !== undefined ? "disabled" : ""}/><span>${esc(it.t)}<small>${it.d}</small></span></label></li>`).join("");
  const done = items.filter((it) => it.auto || checks[it.id]).length;
  $("checkCount").textContent = `${done}/${items.length}`;
}
$("checklist").addEventListener("change", (e) => {
  const id = e.target.dataset.check;
  if (!id) return;
  checks[id] = e.target.checked;
  chrome.storage.local.set({ [CHECK_KEY]: checks });
  renderChecklist();
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-open]");
  if (a) { e.preventDefault(); chrome.tabs.create({ url: a.dataset.open }); }
});

// ------------------------------------------------------------- INICIAR
function showMsg(text, isErr) {
  const m = $("startMsg");
  m.innerHTML = text;
  m.className = isErr ? "msg err" : "msg";
  m.hidden = !text;
}
$("start").addEventListener("click", async () => {
  showMsg("");
  const f = readForm();
  let folderOk = null;
  if (f.dest === "folder") {
    // Se pide el permiso lo primero: Chrome solo lo permite justo tras un clic.
    folderOk = await ensureFolderPermission();
    if (!folderOk.ok) { showMsg(esc(folderOk.error), true); return; }
  }
  const { images, animations } = splitCombinedPrompts(f.prompts);
  const accs = accounts(f);
  const problems = [];
  const needsImages = ["paired", "imagesOnly"].includes(f.genMode);
  const needsAnims = ["paired", "animationsOnly", "dryRun"].includes(f.genMode);
  if (needsImages && !images.size) problems.push("No encuentro ningún prompt de imagen en el kit.");
  if (!accs.length) problems.push("Activa al menos una cuenta.");
  for (const a of accs) {
    if (!a.sceneNumbers.length) problems.push(`El rango de la cuenta ${a.label} («${esc(a.range)}») no es válido.`);
    if (!flowTabs.find((t) => getFlowAccountKey(t.url) === a.accountKey)) problems.push(`No hay ninguna pestaña de Flow abierta con /${a.accountKey.replace("u", "u/")}/.`);
  }
  if (needsAnims && !animations.size) problems.push("El kit no trae prompts de animación (el 2.º bloque [001]…).");
  if (problems.length) { showMsg(problems.map(esc).join("<br>"), true); return; }

  const unchecked = checklistItems().filter((it) => !it.auto && !checks[it.id]);
  const now = new Date();
  const batchFolder = buildBatchFolderName(now, f.prefix);
  const batchId = String(now.getTime());
  const steps = accs.map((a) => ({
    accountKey: a.accountKey,
    run: {
      genMode: f.genMode,
      images: Object.fromEntries(images),
      animations: Object.fromEntries(animations),
      sceneNumbers: a.sceneNumbers,
      prefix: sanitizeName(f.prefix, "clip"),
      nameFormat: f.nameFormat,
      resolution: a.resolution,
      maxWaitMs: Math.max(3, parseInt(f.maxWait, 10) || 10) * 60000,
      maxRetries: Math.min(15, Math.max(1, parseInt(f.maxRetries, 10) || 6)),
      destMode: f.dest,
      batchFolder,
      batchId,
    },
  }));
  await saveForm();
  await chrome.runtime.sendMessage({ type: "RUN_PLAN", plan: { parallel: f.runMode !== "sequential", steps } });
  if (unchecked.length) toast(`Lanzado. Ojo: ${unchecked.length} punto(s) del checklist sin marcar.`);
  else toast("Lote lanzado");
  showTab("progreso");
});

async function stopAll() {
  await chrome.runtime.sendMessage({ type: "STOP_ALL" });
  toast("Deteniendo… (termina el paso en curso)");
}
$("stop").addEventListener("click", stopAll);
$("stop2").addEventListener("click", stopAll);

// ------------------------------------------------------- AUTO-INICIO
$("saveAuto").addEventListener("click", async () => {
  const f = readForm();
  const { images, animations } = splitCombinedPrompts(f.prompts);
  const accs = accounts(f);
  if (!images.size || !accs.length) { toast("Pega el kit y activa alguna cuenta primero."); return; }
  const obj = {};
  for (const a of accs) {
    obj[`autoRunConfig_${a.accountKey}`] = {
      enabled: f.autoRun,
      lastRunAt: null,
      run: { genMode: f.genMode, images: Object.fromEntries(images), animations: Object.fromEntries(animations), sceneNumbers: a.sceneNumbers, prefix: sanitizeName(f.prefix, "clip"), nameFormat: f.nameFormat, resolution: a.resolution, maxWaitMs: (parseInt(f.maxWait, 10) || 10) * 60000, destMode: f.dest },
    };
  }
  await chrome.storage.local.set(obj);
  toast(f.autoRun ? `Auto-inicio guardado para ${accs.map((a) => a.accountKey).join(" y ")}` : "Guardado, pero el auto-inicio está desmarcado");
});
$("resetAuto").addEventListener("click", async () => {
  const accs = accounts(readForm());
  const keys = accs.map((a) => `autoRunConfig_${a.accountKey}`);
  const d = await chrome.storage.local.get(keys);
  for (const k of keys) if (d[k]) d[k].lastRunAt = null;
  await chrome.storage.local.set(d);
  toast("Listo: el auto-inicio volverá a ejecutarse al abrir Flow.");
});

// -------------------------------------------------------------- PROGRESO
const STEP_LABEL = { image: "Imagen", video: "Vídeo", download: "Descarga" };
const STATUS_LABEL = { pending: "pendiente", running: "en curso", done: "hecho", failed: "fallido", review: "revisar", skipped: "saltado", nopoints: "sin puntos" };
const PHASE_TEXT = { images: "Generando imágenes", videos: "Generando vídeos", downloads: "Descargando", done: "Terminado", setup: "Preparando" };
let batches = {};

function renderProgress() {
  const list = Object.values(batches).sort((a, b) => a.accountKey.localeCompare(b.accountKey));
  const root = $("accountsProgress");
  const anyRunning = list.some((b) => b.status === "running");
  $("stop").hidden = !anyRunning;
  $("stop2").hidden = !anyRunning;
  $("start").hidden = anyRunning;
  const chip = $("globalStatus");
  if (!list.length) { root.innerHTML = '<div class="empty"><img src="icons/cerezium.svg" alt="" /><b>Aún no hay ningún lote</b><span>Configúralo en «Lote» y pulsa «Iniciar lote».</span></div>'; chip.textContent = "Inactivo"; chip.className = "chip"; $("progBadge").hidden = true; return; }

  let totalPct = 0;
  // Resumen global: anillo con el % y contadores de escenas.
  let nDone = 0, nRun = 0, nBad = 0, nAll = 0;
  for (const b of list) {
    const sm = summarizeBatch(b);
    nAll += b.order.length;
    nDone += sm.done.length;
    nBad += sm.failed.length + sm.review.length + sm.nopoints.length;
    nRun += b.order.filter((n) => ["image", "video", "download"].some((k) => b.scenes[n][k] === "running")).length;
  }
  const globalPct = Math.round(list.reduce((a, b) => a + summarizeBatch(b).percent, 0) / list.length);
  const since = Math.min(...list.map((b) => b.createdAt || Date.now()));
  const mins = Math.max(0, Math.round((Date.now() - since) / 60000));
  const hero = `<section class="card hero" aria-label="Resumen">
      <div class="ring" style="--p:${globalPct}"><b>${globalPct}<small>%</small></b></div>
      <div class="stats">
        <div class="stat ok"><b>${nDone}</b><span>listas</span></div>
        <div class="stat run"><b>${nRun}</b><span>en curso</span></div>
        <div class="stat bad"><b>${nBad}</b><span>a revisar</span></div>
      </div>
      <p class="hero-t">${nAll} escena(s) · ${list.length} cuenta(s) · ${mins < 1 ? "empezado ahora" : `hace ${mins} min`}</p>
    </section>`;
  root.innerHTML = hero + list.map((b) => {
    const sum = summarizeBatch(b);
    totalPct += sum.percent;
    const statusTxt = b.status === "running" ? PHASE_TEXT[b.phase] || "En curso" : { done: "Terminado", stopped: "Detenido", error: "Parado por error", nopoints: "Sin puntos" }[b.status] || b.status;
    const scenes = b.order.map((n) => {
      const s = b.scenes[n];
      const steps = ["image", "video", "download"].map((k) => `<span class="step s-${s[k]}" title="${STEP_LABEL[k]}: ${STATUS_LABEL[s[k]] || s[k]}">${icon(k === "image" ? "image" : k === "video" ? "video" : "download", 13)}${STATUS_LABEL[s[k]] || s[k]}</span>`).join("");
      const bad = ["failed", "review", "nopoints"].some((x) => [s.image, s.video, s.download].includes(x));
      const isReview = !["failed", "nopoints"].some((x) => [s.image, s.video, s.download].includes(x));
      return `<div class="scene"><span class="num">${pad3(n)}</span><div class="steps">${steps}</div>${bad && s.error ? `<div class="err ${isReview ? "review" : ""}">${esc(s.error)}</div>` : ""}${s.file ? `<div class="file">${esc(s.file)}</div>` : ""}</div>`;
    }).join("");
    const canResume = b.status !== "running" && b.order.some((n) => b.scenes[n].download === "failed" || b.scenes[n].download === "pending");
    return `<section class="pcard" aria-label="Cuenta ${esc(b.accountKey)}">
      <div class="pcard-h"><h2>Cuenta ${esc(b.accountKey)}</h2><span class="pct">${sum.percent}%</span></div>
      <p class="phase">${esc(statusTxt)} · ${sum.done.length}/${b.order.length} escenas completas · ${esc(b.config.batchFolder || "")}</p>
      <div class="pbar" role="progressbar" aria-label="Progreso ${esc(b.accountKey)}" aria-valuenow="${sum.percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${sum.percent}%"></i></div>
      ${scenes}
      ${canResume ? `<div class="row-btns"><button class="btn sm" data-resume="${esc(b.accountKey)}">${icon("refresh", 14)}Reanudar / reintentar descargas</button></div>` : ""}
    </section>`;
  }).join("");

  const pct = Math.round(totalPct / list.length);
  if (anyRunning) { chip.textContent = `En curso · ${pct}%`; chip.className = "chip running"; }
  else {
    const bad = list.some((b) => { const s = summarizeBatch(b); return s.failed.length || s.review.length || s.nopoints.length || b.status !== "done"; });
    chip.textContent = bad ? "Con avisos" : "Terminado";
    chip.className = bad ? "chip warn" : "chip ok";
  }
  const badge = $("progBadge");
  badge.hidden = !anyRunning;
  badge.textContent = `${pct}%`;
}
$("accountsProgress").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-resume]");
  if (!b) return;
  const acc = b.dataset.resume;
  const tab = flowTabs.find((t) => getFlowAccountKey(t.url) === acc);
  if (!tab) { toast(`No hay pestaña abierta de ${acc}`); return; }
  const st = batches[acc];
  st.status = "running";
  await chrome.storage.local.set({ [`batch_${acc}`]: st });
  try { await chrome.tabs.sendMessage(tab.id, { type: "PING" }); } catch (err) { toast("Esa pestaña no responde: pulsa F5 en ella (se reanudará sola)."); return; }
  toast(`Recargo la pestaña de ${acc}: el lote se reanuda solo (tienes 15 s para cancelarlo en la página).`);
  chrome.tabs.reload(tab.id);
});

// ----------------------------------------------------------------- LOG
let logEntries = [];
function renderLog() {
  const filter = radio("logFilter");
  const items = filter === "problems" ? logEntries.filter((e) => e.level === "warn" || e.level === "error") : logEntries;
  const shown = items.slice(-600);
  const list = $("logList");
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  list.innerHTML = shown.length
    ? shown.map((e) => {
        const meta = [formatLogTime(e.t), e.acc, e.scene != null ? `E${pad3(e.scene)}` : null, e.phase ? PHASE_LABELS[e.phase] || e.phase : null].filter(Boolean).join(" · ");
        return `<li class="${e.level}"><span class="lv">${LEVEL_LABELS[e.level] || "INFO"}</span><span><span class="meta">${esc(meta)}</span><br><span class="m">${esc(e.msg)}</span></span></li>`;
      }).join("")
    : '<li class="info"><span></span><span class="meta">Sin entradas.</span></li>';
  if (atBottom) list.scrollTop = list.scrollHeight;
  const recentErrors = logEntries.filter((e) => e.level === "error" && Date.now() - e.t < 24 * 3600e3).length;
  $("errBadge").hidden = !recentErrors;
  $("errBadge").textContent = recentErrors;
}
document.querySelectorAll('input[name="logFilter"]').forEach((r) => r.addEventListener("change", renderLog));
function logText() {
  return logToText(logEntries, `Cerezium Autopilot v${chrome.runtime.getManifest().version} — log copiado ${new Date().toLocaleString()}`);
}
$("copyLog").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(logText()); toast(`Log copiado (${logEntries.length} líneas). Pégaselo a Claude.`); }
  catch (e) { toast("No pude copiar: " + e.message); }
});
$("saveLog").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([logText()], { type: "text/plain" }));
  a.download = `cerezium-log-${buildBatchFolderName(new Date(), "log")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$("clearLog").addEventListener("click", async () => {
  if (!confirm("¿Vaciar el log? (no se puede deshacer)")) return;
  await chrome.storage.local.set({ fbrLog: [] });
  toast("Log vaciado");
});

// ------------------------------------------------------------ ARRANQUE
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let prog = false;
  for (const [k, v] of Object.entries(changes)) {
    if (k === "fbrLog") { logEntries = v.newValue || []; renderLog(); }
    if (k.startsWith("batch_")) { if (v.newValue) batches[k.slice(6)] = v.newValue; else delete batches[k.slice(6)]; prog = true; }
  }
  if (prog) renderProgress();
});

$("popOut").addEventListener("click", openFloating);
$("popOut").hidden = MODO === "ventana";
$("uiMode").addEventListener("change", async (e) => {
  const r = await chrome.runtime.sendMessage({ type: "SET_UI_MODE", mode: e.target.value });
  toast(r && r.mode === "popup" ? "Hecho: al pulsar el icono se abrirá la ventanita" : "Hecho: al pulsar el icono se abrirá el panel lateral");
});

(async function init() {
  hydrateIcons();
  $("uiMode").value = (await chrome.storage.local.get("fbrUiMode")).fbrUiMode || (chrome.sidePanel ? "sidepanel" : "popup");
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  await loadForm();
  checks = (await chrome.storage.local.get(CHECK_KEY))[CHECK_KEY] || {};
  const all = await chrome.storage.local.get(null);
  logEntries = all.fbrLog || [];
  for (const [k, v] of Object.entries(all)) if (k.startsWith("batch_") && v && v.order) batches[k.slice(6)] = v;
  await refreshFolder();
  await refreshTabs();
  renderProgress();
  renderLog();
  let tab = null;
  try { tab = localStorage.getItem("fbrTab"); } catch (e) {}
  showTab(Object.values(batches).some((b) => b.status === "running") ? "progreso" : tab && TABS.includes(tab) ? tab : "lote");
})();
