/*
 * Funciones compartidas por popup.js y content.js.
 * Se incluye como <script> normal en el popup y como content script (listado
 * antes que content.js en manifest.json) en la pestaña de Flow, así que debe
 * evitar `export`/`import` y limitarse a declarar funciones globales.
 */

function pad3(n) {
  return String(n).padStart(3, "0");
}

// Quita el "[00X]" y una etiqueta opcional tipo "⭐ PORTADA —" del principio
// de un bloque de prompt.
function stripMarker(text) {
  return text.replace(/^\[\d+\]\s*(⭐?\s*[^\n—-]{0,40}[—-]\s*)?/u, "").trim();
}

// Corta el texto en la primera línea que parezca "fin de bloque de código"
// (```) o un encabezado markdown (#, ##...) — esto pasa cuando el usuario
// copia el kit completo tal cual se lo doy en el chat, con los ``` y los
// títulos de sección incluidos, y ese sobrante se quedaba pegado al final
// del ÚLTIMO prompt de cada bloque (imagen o animación).
function trimTrailingJunk(text) {
  const lines = text.split("\n");
  const cutIndex = lines.findIndex((line) => /^\s*```/.test(line) || /^\s*#{1,6}\s/.test(line));
  if (cutIndex === -1) return text.trim();
  return lines.slice(0, cutIndex).join("\n").trim();
}

/**
 * Separa un bloque de texto que contiene, en este orden, los prompts de
 * imagen (numerados [001]..[00N]) y luego los prompts de animación
 * (numerados otra vez [001]..[00N]) — el formato exacto que usamos en los
 * kits de MUNDO FUT / The Odd Ledger.
 *
 * Detecta el límite entre los dos bloques buscando el punto en el que la
 * numeración "vuelve a bajar" (p. ej. pasa de [008] a [001]), en vez de
 * depender de que haya un título de sección con una redacción concreta.
 *
 * Devuelve { images: Map<num, texto>, animations: Map<num, texto> }.
 * Si solo hay un bloque de numeración en todo el texto, `animations` queda
 * vacío y todo se coloca en `images`.
 */
function splitCombinedPrompts(raw) {
  const markerRe = /\[(\d{1,3})\]/g;
  const markers = [];
  let m;
  while ((m = markerRe.exec(raw)) !== null) {
    markers.push({ num: parseInt(m[1], 10), index: m.index });
  }
  if (markers.length === 0) return { images: new Map(), animations: new Map() };

  let boundary = markers.length;
  for (let i = 1; i < markers.length; i++) {
    if (markers[i].num <= markers[i - 1].num) {
      boundary = i;
      break;
    }
  }

  function extract(subset) {
    const map = new Map();
    subset.forEach((mk) => {
      const globalIdx = markers.indexOf(mk);
      const next = markers[globalIdx + 1];
      const end = next ? next.index : raw.length;
      const text = trimTrailingJunk(stripMarker(raw.slice(mk.index, end)));
      if (text) map.set(mk.num, text);
    });
    return map;
  }

  const images = extract(markers.slice(0, boundary));
  const animations = boundary < markers.length ? extract(markers.slice(boundary)) : new Map();
  return { images, animations };
}

/**
 * Convierte una cadena tipo "1-5", "6,7,8" o "1-3,7" en un array ordenado
 * de números de escena.
 */
function parseRange(str) {
  const set = new Set();
  (str || "").split(",").forEach((part) => {
    part = part.trim();
    if (!part) return;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) set.add(n);
    } else if (/^\d+$/.test(part)) {
      set.add(parseInt(part, 10));
    }
  });
  return Array.from(set).sort((a, b) => a - b);
}

// Detecta el número de cuenta de Google de una URL de Flow
// (https://flow.google.com/u/2/project/... -> "2"). Varias cuentas pueden
// convivir como pestañas del MISMO perfil de Chrome bajo /u/0/, /u/1/,
// /u/2/... — cada una necesita su propia configuración guardada, porque el
// almacenamiento de la extensión se comparte por perfil, no por pestaña.
// Si no encuentra el patrón (perfil de Chrome distinto, sin /u/N/ en la URL),
// devuelve "default" para que siga funcionando igual que antes.
function getFlowAccountKey(url) {
  const m = (url || "").match(/\/u\/(\d+)(?:\/|$|\?)/);
  return m ? `u${m[1]}` : "default";
}

function autoRunStorageKey(url) {
  return `autoRunConfig_${getFlowAccountKey(url)}`;
}

// Construye la única instrucción combinada que se pega en el chat del Flow
// Agent para generar de golpe todas las imágenes de `sceneNumbers`.
function buildAgentInstruction(imagesMap, sceneNumbers) {
  const intro =
    "Crea todas las imágenes según los prompts que te indico a continuación. " +
    "Cada prompt está ubicado después de su identificador [00X], donde X es el número " +
    "de identificador correspondiente. Genera una imagen por cada prompt, respetando " +
    "el orden exacto en el que aparecen. Cuando termines, renombra automáticamente cada " +
    "imagen generada usando su identificador [00X] correspondiente (por ejemplo, la imagen " +
    "del prompt [001] debe llamarse 001).";

  const body = sceneNumbers
    .filter((n) => imagesMap.has(n))
    .map((n) => `[${pad3(n)}] ${imagesMap.get(n)}`)
    .join("\n\n");

  return `${intro}\n\n${body}`;
}


// Lee el coste en puntos de un texto tipo "¿Quieres que empiece a generar 1
// vídeo, que cuesta 10 puntos?". Devuelve un entero, o null si no lo encuentra
// (en ese caso NUNCA se aprueba solo: mejor parar que gastar a ciegas).
function parseCostFromText(text) {
  const m = (text || "").match(/(\d+)\s*(?:punt|crédit|credit)/i);
  return m ? parseInt(m[1], 10) : null;
}

// OBSERVADO EN VIVO: el coste de un vídeo lo fija la duración que aparezca en
// el prompt — con "6 seconds" el aviso pide 10 puntos; sin ninguna duración
// pidió 15. Esta función garantiza que el prompt lleve siempre la duración
// deseada: si ya menciona `seconds` segundos no toca nada; si menciona otra
// duración, sustituye la PRIMERA aparición (en nuestras plantillas es siempre
// la duración del clip); si no menciona ninguna, la añade al final.
function ensureVideoDuration(prompt, seconds) {
  const text = prompt || "";
  const wanted = new RegExp("\\b" + seconds + "\\s*-?\\s*seconds?\\b", "i");
  if (wanted.test(text)) return text;
  const anyDuration = /\b\d+(?:\.\d+)?\s*-?\s*(?:seconds?|secs?)\b/i;
  if (anyDuration.test(text)) return text.replace(anyDuration, seconds + " seconds");
  return (text.trim() ? text.trim() + " " : "") + "Duration: " + seconds + " seconds.";
}

// ======================================================================
// v2 — Lógica pura añadida en la ronda de septiembre 2026 (testeada en
// tests/shared.test.js). Nada de aquí toca el DOM ni chrome.*.
// ======================================================================

// --- Nombres de archivo y carpetas ------------------------------------

// Formatos de nombre que el usuario aceptó (los tres le valen):
//   "prefijo" -> mundofut_001.mp4   (por defecto)
//   "vid"     -> vid1.mp4
//   "num"     -> 001.mp4
const NAME_FORMATS = {
  prefijo: { label: "<prefijo>_001.mp4" },
  vid: { label: "vid1.mp4" },
  num: { label: "001.mp4" },
};

// Deja un nombre apto para Windows/macOS: sin \ / : * ? " < > | ni controles,
// espacios -> "_", sin puntos/espacios al final, máx. 60 caracteres.
function sanitizeName(s, fallback) {
  const clean = String(s || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 60);
  return clean || fallback || "clip";
}

function buildVideoFilename(format, prefix, num, ext) {
  const e = ext || "mp4";
  if (format === "vid") return `vid${parseInt(num, 10)}.${e}`;
  if (format === "num") return `${pad3(num)}.${e}`;
  return `${sanitizeName(prefix, "clip")}_${pad3(num)}.${e}`;
}

// Carpeta NUEVA por lote: "2026-09-28_1530_mundofut". Se usa la hora local.
function buildBatchFolderName(date, prefix) {
  const d = date instanceof Date ? date : new Date(date);
  const two = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}`;
  return `${stamp}_${sanitizeName(prefix, "lote")}`;
}

// ¿El nombre final que dio Chrome corresponde al que pedimos? Chrome puede
// añadir " (1)" si ya existía (conflictAction "uniquify") y usa "\" en Windows.
function downloadNameMatches(finalPath, wantedName) {
  if (!finalPath || !wantedName) return false;
  const base = String(finalPath).split(/[\\/]/).pop();
  const dot = wantedName.lastIndexOf(".");
  const stem = dot > 0 ? wantedName.slice(0, dot) : wantedName;
  const ext = dot > 0 ? wantedName.slice(dot) : "";
  if (base === wantedName) return true;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc(stem)} \\(\\d+\\)${esc(ext)}$`).test(base);
}

// ¿Esta descarga que acaba de registrar Chrome puede ser la de Flow?
// (blob:/data: creados por la página de Flow, o https con Flow de referente,
// o dominios de Google donde Flow guarda los ficheros).
function isFlowDownloadCandidate(item) {
  if (!item) return false;
  const url = String(item.finalUrl || item.url || "");
  const ref = String(item.referrer || "");
  if (/^blob:https:\/\/(flow\.google\.com|labs\.google)\//.test(url)) return true;
  if (/^data:(video|image|application\/octet-stream)/.test(url)) return true;
  if (/^https:\/\/(flow\.google\.com|labs\.google)\//.test(ref)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)*(googleusercontent\.com|googleapis\.com|google\.com|labs\.google)\//.test(url)) return true;
  return false;
}

function urlKind(url) {
  const u = String(url || "");
  if (u.startsWith("blob:")) return "blob";
  if (u.startsWith("data:")) return "data";
  if (/^https?:/.test(u)) return "https";
  return "otro";
}

// --- Menú "+" (lista de assets) ----------------------------------------

// El textContent real de un item es "001Imagen" / "001Vídeo" (verificado).
// Devuelve { name, kind } con kind "image" | "video" | null.
function parseAssetItemText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.*?)\s*(Imagen|Image|V[ií]deo|Video)$/i);
  if (!m) return { name: t, kind: null };
  return { name: m[1].trim(), kind: /^im/i.test(m[2]) ? "image" : "video" };
}

// Índices de los items que son EXACTAMENTE la imagen `label` (no un vídeo
// que se llame igual, ni "0010"). Orden = orden de la lista (Recientes).
function findAssetMatches(texts, label) {
  const out = [];
  texts.forEach((txt, i) => {
    const p = parseAssetItemText(txt);
    if (p.name === label && p.kind !== "video") out.push(i);
  });
  return out;
}

// --- Tiles --------------------------------------------------------------

// Claves que están en `after` y no en `before` (tiles nuevos), en orden.
function diffNewKeys(before, after) {
  const seen = new Set(before || []);
  return (after || []).filter((k) => k && !seen.has(k));
}

// Elige el vídeo de una escena entre los tiles nuevos que no estén ya
// asignados a otra escena. Devuelve { key, ambiguous }.
function pickNewVideoKey(newKeys, assignedKeys) {
  const assigned = new Set(assignedKeys || []);
  const free = (newKeys || []).filter((k) => !assigned.has(k));
  if (free.length === 0) return { key: null, ambiguous: false };
  return { key: free[0], ambiguous: free.length > 1 };
}

// --- Mensajes del Agent (detectados por texto, no por selector) --------

// [V] = visto en vivo · [SUPUESTO] = redacción no confirmada todavía.
const FLOW_SIGNALS = {
  rateLimit: /preguntando demasiado r[aá]pido/gi, // [V]
  policy: /bloquead[ao]s? por nuestras pol[ií]ticas|pol[ií]ticas de seguridad/gi, // [V]
  genError: /no se ha podido generar/gi, // [V] tarjeta de error ("No se te ha cobrado")
  cancelled: /he cancelado la generaci[oó]n/gi, // [V] tras "Rechazar"
  noPoints: /(no tienes (suficientes )?(puntos|cr[eé]ditos))|(puntos|cr[eé]ditos) insuficientes|sin (puntos|cr[eé]ditos)|has (alcanzado|agotado)[^.]{0,40}(l[ií]mite|puntos|cr[eé]ditos)|l[ií]mite diario/gi, // [SUPUESTO]
};

function countMatches(text, re) {
  const m = String(text || "").match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  return m ? m.length : 0;
}

// Compara el texto del panel del Agent antes y después de enviar: cuenta
// cuántas apariciones NUEVAS hay de cada señal (las viejas del historial del
// chat no cuentan).
function detectNewSignals(beforeText, afterText) {
  const out = {};
  for (const [k, re] of Object.entries(FLOW_SIGNALS)) {
    out[k] = Math.max(0, countMatches(afterText, re) - countMatches(beforeText, re));
  }
  return out;
}

// Espera creciente para "Estás preguntando demasiado rápido": 30 s, 60 s,
// 120 s, 240 s… con tope.
function backoffDelayMs(attempt, baseMs, maxMs) {
  const base = baseMs || 30000;
  const max = maxMs || 300000;
  return Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
}

// --- Estado del lote (persistente en chrome.storage) --------------------

// Estados por paso: pending · running · done · failed · review (hay que
// mirarlo a mano: p. ej. se aprobó el coste pero no apareció el vídeo; NO se
// reintenta solo para no gastar puntos dos veces) · skipped · nopoints.
const STEP_STATUSES = ["pending", "running", "done", "failed", "review", "skipped", "nopoints"];

function createBatchState({ batchId, accountKey, sceneNumbers, config, now }) {
  const scenes = {};
  for (const n of sceneNumbers) {
    scenes[n] = { image: "pending", video: "pending", download: "pending", error: null, videoKey: null, file: null };
  }
  return {
    v: 2,
    batchId,
    accountKey,
    createdAt: now || Date.now(),
    updatedAt: now || Date.now(),
    status: "running", // running · done · stopped · error · nopoints
    phase: "images", // images · videos · downloads · done
    order: sceneNumbers.slice(),
    config: config || {},
    scenes,
  };
}

function setSceneStep(state, num, step, status, extra) {
  const s = state.scenes[num];
  if (!s) return state;
  s[step] = status;
  if (extra) Object.assign(s, extra);
  state.updatedAt = Date.now();
  return state;
}

// Resumen para la barra de progreso y el informe final. Cada escena aporta
// 3 pasos (imagen, vídeo, descarga) en modo "paired".
function summarizeBatch(state) {
  const steps = ["image", "video", "download"];
  let total = 0;
  let finished = 0;
  const failed = [];
  const review = [];
  const nopoints = [];
  const done = [];
  for (const n of state.order) {
    const s = state.scenes[n];
    let sceneOk = true;
    for (const st of steps) {
      total++;
      if (["done", "failed", "review", "skipped", "nopoints"].includes(s[st])) finished++;
      if (s[st] !== "done") sceneOk = false;
    }
    if (steps.some((st) => s[st] === "failed")) failed.push(n);
    else if (steps.some((st) => s[st] === "review")) review.push(n);
    else if (steps.some((st) => s[st] === "nopoints")) nopoints.push(n);
    if (sceneOk) done.push(n);
  }
  return {
    total,
    finished,
    percent: total ? Math.round((finished / total) * 100) : 0,
    done,
    failed,
    review,
    nopoints,
  };
}

// Al reanudar tras un F5 / cierre de pestaña: lo que estaba "en curso" no se
// puede saber si llegó a enviarse. Para imagen y descarga (no cuestan puntos,
// o no cuestan de nuevo) se vuelve a "pending"; para el VÍDEO se marca
// "review" si ya se había aprobado el coste (podría estar generándose o
// cobrado), y "pending" si no.
function prepareResume(state) {
  for (const n of state.order) {
    const s = state.scenes[n];
    if (s.image === "running") s.image = "pending";
    if (s.download === "running") s.download = "pending";
    if (s.video === "running") {
      if (s.videoApproved) {
        s.video = "review";
        s.error = "La página se recargó mientras se generaba este vídeo (el coste ya estaba aprobado). Revisa en Flow si se generó; no lo repito para no gastar puntos dos veces.";
      } else {
        s.video = "pending";
      }
    }
  }
  state.status = "running";
  state.updatedAt = Date.now();
  return state;
}

// --- Log ----------------------------------------------------------------

const PHASE_LABELS = { images: "Imágenes", videos: "Vídeo", downloads: "Descarga", setup: "Inicio", plan: "Plan", run: "Lote" };
const LEVEL_LABELS = { info: "INFO", ok: "OK", warn: "AVISO", error: "ERROR" };

function formatLogTime(t) {
  const d = new Date(t);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// "08:43:55 [u2] [E003] [Vídeo] ERROR: texto"
function formatLogEntry(e) {
  const parts = [formatLogTime(e.t)];
  if (e.acc) parts.push(`[${e.acc}]`);
  if (e.scene != null) parts.push(`[E${pad3(e.scene)}]`);
  if (e.phase) parts.push(`[${PHASE_LABELS[e.phase] || e.phase}]`);
  return `${parts.join(" ")} ${LEVEL_LABELS[e.level] || "INFO"}: ${e.msg}`;
}

function logToText(entries, header) {
  const lines = (entries || []).map(formatLogEntry);
  return (header ? header + "\n" : "") + lines.join("\n");
}

// Añade entradas manteniendo solo las últimas `max`.
function appendCapped(list, items, max) {
  const out = (list || []).concat(items || []);
  return out.length > max ? out.slice(out.length - max) : out;
}

// Mapa de resolución elegida -> texto del submenú "Descargar" de Flow.
// Si la elegida no existe en la cuenta, se cae a la siguiente de la lista.
function resolutionFallbacks(resolution, kind) {
  if (kind === "image") return ["1K", "2K"];
  if (resolution === "720p") return ["720p", "1080p"];
  return ["1080p", "720p"];
}

// Nombre que se pide al Agent para cada VÍDEO (v2.2): único por lote para no
// confundirlo con vídeos de lotes anteriores en el mismo proyecto.
// ("mundofifa", 1, "2026-09-28_1259_mundofifa") -> "mundofifa_001_1259"
function buildVideoTileName(prefix, num, batchFolder) {
  const m = String(batchFolder || "").match(/^\d{4}-\d{2}-\d{2}_(\d{4})_/);
  return `${sanitizeName(prefix, "clip")}_${pad3(num)}${m ? "_" + m[1] : ""}`;
}

// ¿Un tile de vídeo sigue procesándose? (muestra "57%", "100%", "Generando"…)
function tileLooksInProgress(text) {
  return /\b\d{1,3}\s?%|generando|en cola|procesando|preparando/i.test(String(text || ""));
}

// Nota que se añade al reintentar una imagen o un vídeo bloqueado (v2.2): cada
// intento pide suavizar un poco más, SIN cambiar la escena (composición,
// encuadre, estilo, acción y, en vídeo, movimiento y duración).
function buildSoftenNote(kind, attempt) {
  if (attempt <= 1) return "";
  const what = kind === "video" ? "esta descripción de movimiento" : "este prompt";
  const keep = kind === "video"
    ? "Mantén exactamente la misma escena, el mismo movimiento de cámara, el mismo estilo y la duración de 6 seconds."
    : "Mantén exactamente la misma escena, composición, encuadre y estilo.";
  if (attempt === 2) {
    return `(El intento anterior falló o fue bloqueado por las políticas de contenido. Reformula ${what} de forma un poco más suave y segura, sin cambiar la idea. ${keep})`;
  }
  return `(Intento ${attempt}: ha vuelto a bloquearse. Suaviza más ${what}: sustituye cualquier elemento que pueda considerarse violento, sexual, peligroso, de marca/logotipo o de una persona real identificable por equivalentes neutros o genéricos. ${keep})`;
}
