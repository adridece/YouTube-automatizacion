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
  raw = extractMusic(extractNarration(raw).rest).rest; // la narración (voz) y la música no son prompts de imagen/vídeo
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
// Si no hay /u/N/ en la URL, es la cuenta principal (= /u/0/).
function getFlowAccountKey(url) {
  const m = (url || "").match(/\/u\/(\d+)(?:\/|$|\?)/);
  // Sin /u/N/ en la URL es la cuenta principal de Google, que equivale a /u/0/.
  return m ? `u${m[1]}` : "u0";
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
  const m = (text || "").match(/(\d+)\s*(?:punt|point|crédit|credit|pont)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ¿Qué opción del aviso de coste es? "approve" (solo esta vez), "always"
// (aprobar siempre: NUNCA se pulsa), "reject" o null. v2.10.5: la cuenta 2
// no aprobaba el aviso; se buscaba el texto EXACTO "Aprobar" (si Flow está en
// otro idioma o la opción se llama un poco distinto, no se encontraba).
function classifyCostOption(label) {
  const t = String(label || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/\b(rechazar|reject|deny|denegar|decline|cancelar|cancel|rifiuta|recusar|ablehnen|refuser)\b/.test(t)) return "reject";
  const approve = /\b(aprobar|approve|allow|permitir|aceptar|accept|approva|aprovar|genehmigen|zulassen|autoriser|approuver)\b/.test(t);
  if (!approve) return null;
  if (/\b(siempre|always|sempre|toujours|immer)\b/.test(t)) return "always";
  return "approve";
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
    if (imageTitleMatches(p.name, label) && p.kind !== "video") out.push(i);
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
  // v2.10.6: también en inglés (la cuenta 2 del usuario podría tener Flow en otro idioma) [SUPUESTO la redacción inglesa]
  rateLimit: /preguntando demasiado r[aá]pido|asking too (fast|quickly)|too many requests/gi, // [V] el español
  policy: /bloquead[ao]s? por nuestras pol[ií]ticas|pol[ií]ticas de (seguridad|contenido|uso)|infring\w*|viola\w* (nuestras |las )?pol[ií]ticas|violat\w* (our |the )?(content |safety |usage )?polic\w*|against our (content |safety |usage )?polic\w*|blocked by our|(safety|content|usage) polic(y|ies)/gi, // [V] el primero
  genError: /no se ha podido generar|couldn.?t (be )?generat\w*|could not (be )?generat\w*|failed to generate|unable to generate/gi, // [V] el primero ("No se te ha cobrado")
  cancelled: /he cancelado la generaci[oó]n|cancell?ed the (video )?generation/gi, // [V] el primero
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

const PHASE_LABELS = { images: "Imágenes", videos: "Vídeo", downloads: "Descarga", setup: "Inicio", plan: "Plan", run: "Lote", voice: "Voz", music: "Música" };
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
// ¿El tile es una tarjeta de ERROR de Flow y no un resultado? [V] "No se ha
// podido generar…"; el resto [SUPUESTO] (prueba real v2.10: errores en el vídeo).
function tileLooksFailed(text) {
  // (v2.10.3: SIN la palabra suelta "error": un tile de vídeo bueno podría llevarla
  // como icono oculto y se daría por fallido un vídeo que sí salió → se pagaría otra vez.)
  // v2.10.6: también el aviso de POLÍTICAS (prueba real, cuenta 2: se tomaba por vídeo generado y no se reintentaba).
  return /no se ha podido generar|no se te ha cobrado|algo (ha )?(ido|salido) mal|se ha producido un error|couldn.?t (be )?generat|could not (be )?generat|something went wrong|generation failed|failed to generate|unable to generate|you (were|have) not been charged|pol[ií]tica|polic(y|ies)|infring|bloquead[ao]|blocked/i.test(String(text || ""));
}
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
  if (attempt <= 4) {
    return `(Intento ${attempt}: ha vuelto a fallar. Suaviza más ${what}: sustituye cualquier elemento que pueda considerarse violento, sexual, peligroso, de marca/logotipo o de una persona real identificable por equivalentes neutros o genéricos. ${keep})`;
  }
  // Intentos avanzados: además, simplificar lo que pasa (sin cambiar el estilo).
  const simplify = kind === "video"
    ? "Si hace falta, simplifica la acción: movimientos más suaves y lentos, sin contacto físico brusco ni caídas, y menos elementos a la vez"
    : "Si hace falta, simplifica la composición: menos elementos y detalles más neutros";
  return `(Intento ${attempt}: sigue fallando. Reescribe ${what} con palabras más neutras y seguras. ${simplify}, pero conserva los mismos personajes, el mismo estilo visual, los mismos colores y el mismo encuadre. ${keep})`;
}

// ¿El nombre de un tile de imagen corresponde a la escena `label` ("006")?
// El Agent a veces no pone "006" exacto: "[006]", "006.png", "Imagen 006",
// "img_006" o "6". (v2.6: la cuenta 2 dio imágenes por perdidas que existían.)
function imageTitleMatches(title, label) {
  const t = String(title || "").trim().toLowerCase()
    .replace(/\.(png|jpe?g|webp)$/, "")
    .replace(/[\[\]()]/g, "")
    .replace(/^(imagen|image|img|escena|scene)[\s_-]*/, "")
    .trim();
  if (t === label) return true;
  if (/^\d{1,3}$/.test(t)) return parseInt(t, 10) === parseInt(label, 10);
  return false;
}

// Texto que se añade al prompt de vídeo para que el Agent respete los 6 s
// (de la duración depende el coste: 6 s = 10 puntos). `strong` en los reenvíos
// tras un aviso de coste > 10.
function buildDurationNote(seconds, strong) {
  const base = `IMPORTANTE: genera UN solo vídeo de EXACTAMENTE ${seconds} segundos (Duration: ${seconds} seconds). No uses otra duración.`;
  return strong ? `${base} El intento anterior salió con una duración mayor y costaba más de 10 puntos: debe durar ${seconds} segundos, ni uno más.` : base;
}

// --- Narración (voz de HeyGen, v2.9) -----------------------------------
// El kit puede traer, además de los prompts, el texto de la narración bajo un
// encabezado ("## 🎙️ NARRACIÓN", "**Guion:**", "VOZ EN OFF", "Narración: …").
// Devuelve { text, rest }: el texto de la narración (sin marcadores [001] ni
// ```) y el kit SIN esa sección (para que no se confunda con los prompts).
const NARRATION_WORD_RE = /(narraci[oó]n|gui[oó]n|voz en off|voice[\s-]?over|locuci[oó]n|texto (?:de|para) (?:la )?voz)/i;
function isHeadingLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 80 || /^```/.test(t) || /^\[\d{1,3}\]/.test(t)) return false;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^\*\*[^*]+\*\*:?$/.test(t)) return true;
  const letters = t.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}
function extractNarration(raw) {
  return extractSection(raw, NARRATION_WORD_RE, false);
}
// Sección del kit bajo un encabezado cuyo texto cumple `wordRe`. Con
// `allowPrompt` false se ignoran encabezados con "prompt" (p. ej. "PROMPTS DE IMAGEN").
function extractSection(raw, wordRe, allowPrompt) {
  const src = String(raw || "");
  const lines = src.split(/\r?\n/);
  let start = -1;
  let inline = "";
  const inlineRe = new RegExp("^\\s*(?:#{1,6}\\s*)?(?:[^\\wÁÉÍÓÚÑáéíóúñ\\[]{0,6}\\s*)?(?:\\*\\*)?[^:\\n]{0,40}?(?:" + wordRe.source + ")[^:\\n]{0,30}?(?:\\*\\*)?\\s*[:：]\\s*(.+)$", "i");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if ((!allowPrompt && /prompt/i.test(l)) || !wordRe.test(l)) continue;
    const m = l.match(inlineRe);
    const tail = m ? m[m.length - 1] : ""; // el último grupo es el texto tras los ":"
    if (m && tail.replace(/\*\*/g, "").trim().length > 0 && l.length > 40) { start = i; inline = tail.replace(/\*\*/g, "").trim(); break; }
    if (isHeadingLine(l)) { start = i; break; }
  }
  if (start < 0) return { text: "", rest: src };
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (isHeadingLine(lines[j])) { end = j; break; }
  }
  const body = [inline, ...lines.slice(start + 1, end)]
    .filter((l) => !/^\s*```/.test(l))
    .map((l) => l.replace(/^\s*\[\d{1,3}\]\s*/, "")
      .replace(/^[—–-]\s*/, "")
      .replace(/^(?:⭐\s*)?(?:hook|gancho|intro|introducci[oó]n|escena\s*\d+|cierre|cta|portada|remate|final)\s*[—–:-]\s*/i, "")
      .trim());
  const text = body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return { text, rest };
}
// Extensión del archivo de voz según su tipo (el usuario lo quiere como audio.mp3).
function audioExtFromMime(mime, url) {
  const m = String(mime || "").toLowerCase();
  if (/mpeg|mp3/.test(m)) return "mp3";
  if (/wav/.test(m)) return "wav";
  if (/mp4|m4a|aac/.test(m)) return "m4a";
  if (/ogg|opus/.test(m)) return "ogg";
  if (/webm/.test(m)) return "webm";
  const u = String(url || "").toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|opus|webm)(\?|$)/);
  return u ? (u[1] === "aac" ? "m4a" : u[1] === "opus" ? "ogg" : u[1]) : "mp3";
}

// --- Qué petición "media" es la VOZ (v2.9.4) -----------------------------
// Captura real del usuario (29 sep 2026): tras pulsar reproducir, la red de
// HeyGen muestra appear_v1.webm y disappear_v1.webm (animaciones de la
// interfaz, desde caché) y la voz: una URL con "id=<uuid>", 206, ~90 kB.
function isHeygenUiMedia(url) {
  return /\/(appear|disappear)_v\d+\.webm(\?|$)/i.test(String(url || "")) || /\.(webm|mp4)(\?|$)/i.test(String(url || "").split("#")[0]) && !/[?&]id=/.test(String(url || ""));
}
// Puntuación de una petición media como candidata a ser la voz (0 = no vale).
function voiceMediaScore(m) {
  const url = String((m && m.url) || "");
  const mime = String((m && m.mime) || "").toLowerCase();
  if (!url || /^data:/.test(url) || isHeygenUiMedia(url)) return 0;
  if (m.fromCache) return 0;
  let score = 1;
  if (/[?&]id=[0-9a-f-]{8,}/i.test(url)) score += 4;
  if (/^audio\//.test(mime)) score += 3;
  if (/\.(mp3|wav|m4a|aac|ogg|opus)(\?|$)/i.test(url)) score += 2;
  if (/^video\//.test(mime)) score -= 1;
  return Math.max(score, 0);
}
function pickVoiceMedia(items) {
  let best = null;
  let bestScore = 0;
  for (const m of items || []) {
    const s = voiceMediaScore(m);
    if (s > bestScore) { best = m; bestScore = s; }
  }
  return best;
}
// ¿Una respuesta 206 trae el archivo ENTERO? "bytes 0-90399/90400" con 90400 bytes → sí.
function contentRangeIsFull(header, len) {
  if (!header) return true;
  const m = String(header).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!m) return true;
  const start = +m[1], end = +m[2], total = m[3] === "*" ? null : +m[3];
  if (start !== 0) return false;
  if (total != null && end + 1 !== total) return false;
  return len == null || len === end + 1;
}

// --- Música (Mureka, v2.10) ----------------------------------------------
// Prompt de música del kit: encabezado "## 🎵 MÚSICA", "PROMPT DE MÚSICA",
// "Música: …", "MUSIC PROMPT"… (aquí SÍ se admite la palabra "prompt").
const MUSIC_WORD_RE = /(m[uú]sica|music|canci[oó]n|\bsong\b|mureka|banda sonora|soundtrack)/i;
function extractMusic(raw) {
  return extractSection(raw, MUSIC_WORD_RE, true);
}
// ¿Qué petición "media" es la canción de Mureka? El usuario: al darle al play
// en Library aparece en Network → Media un archivo que empieza por "music…".
function musicMediaScore(m) {
  const url = String((m && m.url) || "");
  const mime = String((m && m.mime) || "").toLowerCase();
  if (!url || /^data:/.test(url) || isHeygenUiMedia(url)) return 0;
  if (m.fromCache) return 0;
  const last = url.split("?")[0].split("/").pop() || "";
  let score = 1;
  if (/^music/i.test(last)) score += 5;
  else if (/music/i.test(url)) score += 2;
  if (/^audio\//.test(mime)) score += 3;
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url)) score += 2;
  if (/^video\//.test(mime)) score -= 1;
  return Math.max(score, 0);
}
function pickMusicMedia(items) {
  let best = null;
  let bestScore = 0;
  for (const m of items || []) {
    const s = musicMediaScore(m);
    if (s > bestScore) { best = m; bestScore = s; }
  }
  return best;
}
