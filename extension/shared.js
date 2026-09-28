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
