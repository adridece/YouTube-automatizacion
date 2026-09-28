# Arquitectura (v2.0.0)

## Componentes
- **`extension/shared.js`** — funciones **puras** (sin DOM ni `chrome.*`), cargadas en el panel, el content script y el service worker.
  Parseo del kit, rangos, cuenta `/u/N/`, coste, duración, nombres de archivo y carpeta del lote, señales del chat del Agent
  (`detectNewSignals`), estado del lote (`createBatchState`, `setSceneStep`, `summarizeBatch`, `prepareResume`), log
  (`formatLogEntry`). Todo con tests (`tests/shared.test.js`).
- **`extension/content.js`** — dentro de Flow. `CONFIG` (selectores/textos), utilidades DOM, esperas, fases, panel en la página.
- **`extension/page-hook.js`** — en el mundo de la página (MAIN): retrasa 3 min `URL.revokeObjectURL` para poder leer el blob de una descarga.
- **`extension/background.js`** (service worker) — log persistente, notificaciones, latido, plan de cuentas, gestor de descargas.
- **`extension/offscreen.html/js` + `fs-store.js`** — escribe los archivos en la carpeta elegida (File System Access). El handle se guarda en IndexedDB.
- **`extension/sidepanel.html/css/js`** — interfaz (panel lateral de Chrome; sustituye al popup).

## Esperas (por qué no se congelan en segundo plano)
`waitFor(cond, timeout)` re-evalúa la condición con (1) su propio temporizador, (2) un `MutationObserver` sobre el DOM de Flow y
(3) el mensaje `TICK` que `background.js` manda cada 2 s a las pestañas que están trabajando (los mensajes de la extensión no los
frena Chrome; los temporizadores de pestañas ocultas sí, hasta 1/min). Una alarma cada 30 s rearma el latido si el service worker se durmió.

## Mensajes
| Mensaje | De → a | Uso |
|---|---|---|
| `RUN_PLAN {plan:{parallel, steps:[{accountKey, bringToFront, run}]}}` | panel → bg | lanza las cuentas (paralelo o secuencial) |
| `START_RUN {genMode, images, animations, sceneNumbers, prefix, nameFormat, resolution, maxWaitMs, destMode, batchFolder, batchId}` | bg → content | una tanda en esa pestaña |
| `STOP_ALL` / `STOP_QUEUE` | panel → bg → content | detener tras el paso en curso |
| `CLAIM {acc}` | content → bg | turno por cuenta (evita la misma cuenta en dos pestañas) |
| `HEARTBEAT {acc,on}` / `TICK` | content ↔ bg | latido |
| `LOG {entry}` / `NOTIFY {title,message,sticky}` | content → bg | log persistente / notificación |
| `RUN_COMPLETE {acc, summary}` | content → bg | avanza el plan y notifica al final |
| `DL_ARM {acc, scene, relPath, mode}` → `{jobId}` · `DL_STATUS` · `DL_DISARM` | content → bg | gestor de descargas |
| `FETCH_BLOB_TO_OFFSCREEN {url, jobId, relPath}` | bg → content | el content lee el blob y lo manda en trozos |
| `FS_CHUNK` / `FS_SAVE_URL` / `FS_STATUS` (`target:"offscreen"`) | content/bg → offscreen | escribir en la carpeta elegida |

## Flujo de una cuenta (`runBatch` en content.js)
1. `CLAIM` → estado `batch_uN` (nuevo o reanudado con `prepareResume`).
2. **Fase 1** `phaseImages`: instrucción al Agent (`sendWithRateLimit` → `sendAndConfirm`) → espera a que no quede
   `flow-pending-tile` durante 5 s → renombrado (40 s, nombres tolerantes: `imageTitleMatches`) → hasta N-1 rondas de "reformula" para las que falten.
3. **Fase 2A** `phaseVideos` → `processSceneVideo`, por escena (hasta N intentos, 6 por defecto):
   - `settleBeforeSend`: si Flow aún genera un vídeo anterior, se espera (nunca dos a la vez) y, si había una escena "a revisar",
     se le asigna el vídeo que llegó tarde (`resolveReviewScenes`, solo si hay 1 vídeo sin dueño por escena a revisar).
   - adjuntar (`attachViaPlusMenu`; plan B "Animar") **verificando** que la caja del Agent cambió (`composerSignature`): nunca se
     envía un prompt de vídeo sin su imagen. Si el intento anterior no llegó a salir, la imagen sigue adjunta y no se repite.
   - prompt = nota de duración (`buildDurationNote`) + `ensureVideoDuration` + recordatorio final (ya NO se pide renombrar).
   - `sendAndConfirm` aprueba solo ≤ 10 puntos; si > 10 → "Rechazar" y reenvío remarcando 6 s (3 veces); si arranca SIN aviso
     de coste → se termina ese y se para de generar (`CostError`).
   - `waitForSceneVideo`: el tile NUEVO por diferencia antes/después, estable 3 s; si se acaba la espera pero Flow sigue
     generando (tile pendiente o con %), se amplía 2 veces.
   - **descarga inmediata** (`downloadScene`) en cuanto se identifica el vídeo: el archivo `<prefijo>_<NNN>.mp4` es seguro el de
     esa escena.
   - **Segunda vuelta** automática para escenas fallidas sin coste (bloqueo, coste > 10, técnico). Si quedan fallos técnicos:
     `ReloadError` → se guarda el lote, F5, y `onPageLoad` lo reanuda solo (`resumeNow`, máx. 2 recargas por lote).
4. **Fase 2B** `phaseDownloads`: solo lo que no se pudo descargar al generarse (o modos sin generación). `downloadScene` hace 3
   intentos; en el último, si Flow no entregó el 1080p, pide 720p.
5. `finishRun`: resumen en el log, notificación, `RUN_COMPLETE`.

Modos (`genMode`): `paired` (normal) · `animationsOnly` (las imágenes ya existen) · `imagesOnly` · `dryRun` (ENSAYO: como
`animationsOnly` pero en el aviso de coste pulsa "Rechazar"; 0 puntos) · `downloadTest` (asigna a las escenas los primeros vídeos
que ya existen y ejecuta solo la Fase 2B; 0 puntos).

`sendAndConfirm` devuelve `started | cost | rateLimit | noPoints | policy | genError | cancelled | agentReplied | approvedNoStart | noStart | error`.
`agentReplied`: el Agent escribió algo (p. ej. una pregunta) y lleva 3 min sin hacer nada → se reintenta (gratis).
Tras pulsar generar espera 25 s; si el mensaje ya se envió o se aprobó el coste, hasta 8 min más **sin volver a pulsar**;
si el texto sigue en la caja, un único segundo clic.

## Gestor de descargas (background.js)
Un solo trabajo (`job`) para toda la extensión (Chrome no dice de qué pestaña sale una descarga; con dos cuentas en paralelo la
otra espera turno). Se guarda en `chrome.storage.session` por si el service worker se reinicia.
- **Destino "folder"**: `onCreated` → se cancela y borra la descarga nativa → si la URL es `blob:`, el content script la lee y la
  manda en trozos de 4 MB al offscreen; si es `https:`, la descarga el offscreen → `fbrWriteFile` (sin sobrescribir: añade " (1)").
  Si falla con `https:`, plan B: `chrome.downloads.download` a Descargas.
- **Destino "downloads"**: `onDeterminingFilename` pone `MundoFutFlow/<lote>/<nombre>`; `onChanged` espera `complete`; se comprueba
  el nombre final (`downloadNameMatches`). Si queda en curso con nombre vacío > 10 s, avisa de que Chrome está pidiendo "Guardar como".

## Almacenamiento
- `chrome.storage.local`: `fbrLog` (log), `batch_uN` (estado del lote por cuenta), `fbrForm` (formulario), `fbrChecklist`,
  `fbrPagePanel` (esquina del panel en la página), `autoRunConfig_uN` (auto-inicio).
- `chrome.storage.session`: `fbrRunningTabs`, `fbrPlan`, `fbrDlJob`.
- IndexedDB (origen de la extensión) `fbr-fs`: handle de la carpeta elegida.

## Tiempos por defecto
Arranque de generación 25 s (+ 8 min si ya se envió) · vídeo 10 min (campo del panel) · imágenes ≥ 3 min + 1,5 min/imagen ·
renombrado 15 s · lista del "+" 10 s · descarga: 3 min a que Chrome la registre + 5 min a que termine · límite de ritmo 30→240 s.

## Pruebas
- `npm run verify`: sintaxis de todo + ids del panel + tests de `shared.js`.
- `npm run e2e`: Chromium real + extensión + Flow simulado (`tests/e2e/`), escenarios `folder`, `downloads`, `resume`, `cost`,
  `sequential`, `dryrun`, `dltest` (y exploratorios `noautodl`, `noautodl2`). Capturas y logs en `tests/e2e/.out/`.
