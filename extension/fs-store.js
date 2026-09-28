/*
 * Carpeta de destino elegida por el usuario (API File System Access).
 *
 * Por qué existe: con el ajuste de Chrome "Preguntar dónde guardar cada
 * archivo" ACTIVADO, cualquier descarga (también las lanzadas por la
 * extensión con saveAs:false) abre el diálogo "Guardar como" — comprobado en
 * Chromium real (docs/BUG_HISTORY.md #24). La única forma de guardar sin
 * diálogo con ese ajuste activado es escribir el archivo nosotros mismos en
 * una carpeta que el usuario eligió UNA vez (p. ej. el Escritorio).
 *
 * El "handle" de la carpeta se guarda en IndexedDB (origen de la extensión).
 * Lo usan el panel lateral (para elegirla y pedir permiso con un clic) y el
 * documento offscreen (para escribir los vídeos).
 */
const FBR_DB = "fbr-fs";
const FBR_STORE = "handles";
const FBR_KEY = "root";

function fbrOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FBR_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FBR_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fbrGetRootHandle() {
  const db = await fbrOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FBR_STORE, "readonly");
    const req = tx.objectStore(FBR_STORE).get(FBR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function fbrSetRootHandle(handle) {
  const db = await fbrOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FBR_STORE, "readwrite");
    tx.objectStore(FBR_STORE).put(handle, FBR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function fbrRootStatus() {
  const h = await fbrGetRootHandle();
  if (!h) return { has: false, name: null, perm: null };
  let perm = "prompt";
  try { perm = await h.queryPermission({ mode: "readwrite" }); } catch (e) { perm = "error: " + e.message; }
  return { has: true, name: h.name, perm };
}

// Escribe `blob` en <raíz>/<relPath>, creando las subcarpetas. Si el archivo
// ya existe, añade " (1)", " (2)"… (igual que Chrome). Devuelve la ruta final.
async function fbrWriteFile(relPath, blob) {
  const root = await fbrGetRootHandle();
  if (!root) throw new Error("no hay ninguna carpeta de destino elegida (panel de la extensión → Salida → Elegir carpeta)");
  const perm = await root.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    throw new Error(`Chrome no da permiso para escribir en la carpeta "${root.name}" (estado: ${perm}). Abre el panel de la extensión y pulsa "Conceder acceso"`);
  }
  const parts = relPath.split("/").filter(Boolean);
  const fileName = parts.pop();
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let finalName = fileName;
  for (let i = 1; i < 100; i++) {
    try { await dir.getFileHandle(finalName); } catch (e) { break; } // no existe -> libre
    finalName = `${stem} (${i})${ext}`;
  }
  const fh = await dir.getFileHandle(finalName, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return [root.name, ...parts, finalName].join("/");
}
