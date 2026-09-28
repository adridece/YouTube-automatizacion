# Arquitectura

## Componentes
- **`extension/shared.js`** — funciones puras, cargadas en el popup, el content script y el service worker (`importScripts`).
  `splitCombinedPrompts`, `parseRange`, `buildAgentInstruction`, `getFlowAccountKey`, `autoRunStorageKey`,
  `parseCostFromText`, `ensureVideoDuration`, `pad3`. Es lo único con tests automáticos.
- **`extension/content.js`** — se inyecta en `https://flow.google.com/*`. Contiene `CONFIG` (selectores y textos), las
  utilidades (`clickDeep`, `setEditableValue`, `waitUntil`, `findMenuItemByText`…) y las fases.
- **`extension/background.js`** (service worker) — (1) renombrado de descargas, (2) orquestación del plan de dos cuentas,
  (3) notificaciones del sistema. `DOWNLOAD_URL` ya no se usa (queda por limpiar).
- **`extension/popup.html/js`** — formulario (kit pegado, rango, resolución, prefijo, modo, auto-inicio) y sección "Plan
  multi-cuenta". El popup **se cierra solo** al perder el foco: nada importante debe depender de que siga abierto.

## Mensajes (chrome.runtime / chrome.tabs)
| Mensaje | De → a | Uso |
|---|---|---|
| `START_RUN` `{genMode, images, animations, sceneNumbers, prefix, resolution, maxWaitMs}` | popup/background → content | lanza una tanda en esa pestaña |
| `STOP_QUEUE` | popup → content | activa `stopRequested` |
| `QUEUE_PROGRESS {text}` | content → popup | progreso (el popup puede no estar abierto) |
| `RUN_COMPLETE {accountKey}` | content → background | una tanda terminó; avanza el plan |
| `RUN_PLAN {steps}` / `STOP_PLAN` | popup → background | plan multi-cuenta (A → B) |
| `PLAN_STATUS {text}` / `SHOW_OVERLAY {text}` | background → popup / content | estado del plan |

## Modos (`genMode`)
- `paired` (principal): Fase 1 (imágenes con el Agent) → Fase 2A (animar una a una) → Fase 2B (descargar vídeos).
- `imagesOnly`: Fase 1 + descarga de imágenes. `animationsOnly`: solo Fase 2 (las imágenes ya existen).

## Flujo de `paired` (content.js)
`runPaired` → `runPhase1Images` (`buildAgentInstruction` → caja → `clickGenerateAndVerify` → `waitForGenerationToFinish` →
`waitForImagesToSettle` 15 s → `retryMissingImages` ×2) → `runPhase2Animations` = `generateAllAnimations`
(por escena, ≤2 intentos: `attachReferenceImage` → prompt con `ensureVideoDuration` → `clickGenerateAndVerify` →
`waitForGenerationToFinish` → comprobar que hay un `flow-video-tile` nuevo → guardar su referencia) + `downloadAllVideos`
(`downloadTile`: fija `pendingRenameFilename`, clic derecho, "Descargar", resolución).

`clickGenerateAndVerify(genBtn, {maxPoints})`: pulsa generar; en **cada sondeo** vigila el aviso de coste
(`findPendingCostDialog`): si coste ≤ `maxPoints` pulsa "Aprobar" (solo esa vez); si es mayor o ilegible pulsa "Rechazar" y
lanza error. Esperas: 25 s; si el mensaje ya se envió (caja vacía) otros 40 s **sin volver a pulsar**; si no se envió,
un segundo clic.

## Plan multi-cuenta (background.js)
`RUN_PLAN` → por cada paso busca la pestaña `flow.google.com/u/N/…` (`findTabForAccount`), la activa **sin enfocar la ventana**,
le manda `START_RUN` y espera su `RUN_COMPLETE` para pasar al siguiente. Hoy es **secuencial** (A y luego B).

## Almacenamiento (`chrome.storage.local`)
- `autoRunConfig_u2`, `autoRunConfig_u3`…: config guardada por cuenta para el auto-inicio (`enabled`, kit, rango, `lastRunAt`…).
- `pendingRenameFilename`: nombre para la próxima descarga (lo consume `onDeterminingFilename`).

## Tiempos por defecto
Sondeo 1,5 s · generar: 25 s (+40 s si ya se envió) · espera máxima por generación: campo del popup (240 s por defecto) ·
renombrado de imágenes: 15 s · lista de assets del "+": 6 s.
