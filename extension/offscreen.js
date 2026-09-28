/*
 * Documento offscreen: escribe los vídeos en la carpeta elegida por el
 * usuario (fs-store.js). Recibe los bytes de dos formas:
 *  - FS_SAVE_URL: una URL https/data que se puede descargar desde aquí.
 *  - FS_CHUNK: trozos en base64 que le manda el content script cuando Flow
 *    entrega el vídeo como blob: (solo la propia página puede leerlo).
 * Solo atiende mensajes con target "offscreen".
 */
const chunkJobs = new Map(); // jobId -> { parts: Uint8Array[], relPath, mime }

// SEGUNDO PLANO DE VERDAD (v2.3): mientras una pestaña está capturada, Chrome
// la trata como VISIBLE y la sigue pintando/procesando aunque el usuario esté
// en otra (comprobado en Chromium: rAF congelado → 60/s al capturar). Se pide
// la imagen mínima (64 px, 1 fps) y no se guarda ni se envía a ningún sitio.
const captures = new Map(); // tabId -> MediaStream

async function startCapture(tabId, streamId) {
  stopCapture(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxWidth: 64, maxHeight: 64, maxFrameRate: 1 } },
  });
  captures.set(tabId, stream);
  const track = stream.getVideoTracks()[0];
  track.onended = () => {
    captures.delete(tabId);
    chrome.runtime.sendMessage({ type: "CAPTURE_ENDED", tabId }).catch(() => {});
  };
  return { ok: true };
}
function stopCapture(tabId) {
  const st = captures.get(tabId);
  if (st) st.getTracks().forEach((t) => t.stop());
  captures.delete(tabId);
}
function captureAlive(tabId) {
  const st = captures.get(tabId);
  return !!(st && st.getVideoTracks().some((t) => t.readyState === "live"));
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function saveBlob(relPath, blob) {
  const path = await fbrWriteFile(relPath, blob);
  return { ok: true, path, bytes: blob.size };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    try {
      if (msg.type === "FS_STATUS") return sendResponse({ ok: true, ...(await fbrRootStatus()) });
      if (msg.type === "CAPTURE_START") return sendResponse(await startCapture(msg.tabId, msg.streamId));
      if (msg.type === "CAPTURE_STOP") { stopCapture(msg.tabId); return sendResponse({ ok: true }); }
      if (msg.type === "CAPTURE_ALIVE") return sendResponse({ ok: true, alive: captureAlive(msg.tabId) });
      if (msg.type === "FS_SAVE_URL") {
        const r = await fetch(msg.url, { credentials: "include" });
        if (!r.ok) throw new Error(`la descarga devolvió HTTP ${r.status}`);
        const blob = await r.blob();
        if (blob.size < 1000) throw new Error(`el archivo recibido es sospechosamente pequeño (${blob.size} bytes)`);
        return sendResponse(await saveBlob(msg.relPath, blob));
      }
      if (msg.type === "FS_CHUNK") {
        let job = chunkJobs.get(msg.jobId);
        if (!job || msg.index === 0) {
          job = { parts: [], relPath: msg.relPath, mime: msg.mime || "video/mp4" };
          chunkJobs.set(msg.jobId, job);
        }
        job.parts[msg.index] = b64ToBytes(msg.data);
        if (!msg.last) return sendResponse({ ok: true, received: msg.index });
        chunkJobs.delete(msg.jobId);
        const blob = new Blob(job.parts, { type: job.mime });
        if (blob.size < 1000) throw new Error(`el archivo recibido es sospechosamente pequeño (${blob.size} bytes)`);
        return sendResponse(await saveBlob(job.relPath, blob));
      }
      sendResponse({ ok: false, error: `mensaje desconocido ${msg.type}` });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});
