# Historial de bugs y decisiones (para no repetir errores)

Formato: qué pasaba → causa real → arreglo. **Verif.**: ✅ comprobado en vivo o con tests · ⚠️ SIN VERIFICAR EN VIVO.

| # | Síntoma | Causa | Arreglo | Verif. |
|---|---|---|---|---|
| 1 | La extensión no hacía nada | `manifest` apuntaba a `labs.google`; el dominio real es `flow.google.com` | matches/host_permissions de `flow.google.com` | ✅ |
| 2 | Error en `setStatus` | Se perdió `<div id="status">` al editar el HTML | restaurado + comprobación cruzada de ids popup.js/popup.html | ✅ |
| 3 | "Se cierra y no hace nada" | El popup se cierra al cambiar de pestaña y los mensajes se perdían | notificaciones del sistema + cajita en la página | ✅ |
| 4 | Pegaba el texto pero no generaba | Se buscaba un `<button>` *hacia arriba* (`closest`) y el real está *dentro* del envoltorio; los eventos sintéticos no envían el formulario | `clickDeep`: `.click()` nativo del `<button>` interno | ✅ |
| 5 | Escenas bien generadas marcadas como fallidas | El Agent renombra *después* de terminar; se comprobaba al instante | `waitForImagesToSettle` (15 s) | ✅ |
| 6 | Un fallo paraba toda la cuenta | `return` en vez de `continue` ante errores por escena | por escena: marcar fallo y seguir | ✅ |
| 7 | Los vídeos nunca empezaban | El botón "Aprobar…" del aviso de coste no es `<button>` ni está en el overlay | búsqueda propia (hoy `findPendingCostDialog`) | ✅ |
| 8 | Descargas sin nombre numerado | `downloadTile` no fijaba `pendingRenameFilename` (se perdió en una reescritura) | se fija antes de descargar | ⚠️ (con "preguntar dónde guardar" ON no se puede ver) |
| 9 | Error justo tras adjuntar la imagen; saltaba todas las escenas | La ruta larga del cuadro de prompt deja de existir al adjuntar | selector corto `flow-agent-panel flow-rich-text-editor [contenteditable="true"]` | ✅ |
| 10 | Se adjuntaba la imagen equivocada (la 005 en vez de la 001) | Un clic extra en el "menú lateral" que sobraba | se eliminó ese paso; verificar vista previa antes de confirmar | ✅ |
| 11 | Cuenta no detectada en `/u/2` | La regex exigía `/` tras el número | `getFlowAccountKey` admite fin de cadena / `?` | ✅ tests |
| 12 | Basura pegada al último prompt de cada bloque | El usuario copia con ``` y encabezados | `trimTrailingJunk` | ✅ tests |
| 13 | Error "el botón no ha disparado nada" con la IA pensando | Solo se esperaban 4 s y se reintentaba el clic | 25 s + 40 s sin reclicar si ya se envió | ✅ lógica · ⚠️ end-to-end |
| 14 | "Detener" no siempre detenía | Un `catch` se tragaba `"stopped"` | se propaga | ✅ |
| 15 | Diálogo "Guardar como… caricature…" en cada descarga | Ajuste de Chrome "Preguntar dónde guardar" activado | documentado: desactivarlo | ✅ (causa) |
| 16 | "Aprobar siempre" desactiva la comprobación de coste | Ese botón cambia el ajuste a "Nunca" | ahora se pulsa "Aprobar" (solo esa vez) | ✅ (ajuste) · ⚠️ (clic en "Aprobar" real no probado para no gastar puntos; sí se probó `Rechazar` y `Aprobar siempre`) |
| 17 | Podía actuar sobre un aviso de coste **viejo** | Los avisos contestados siguen en el HTML | filtrar `read-only` / `aria-disabled` | ✅ |
| 18 | Un vídeo pedía **15 puntos** en vez de 10 | El coste depende de la duración del prompt | `ensureVideoDuration` (6 s → 10) | ✅ medido en vivo · tests |
| 19 | El aviso de coste podía tardar en aparecer y se esperaba solo 3 s | La IA "piensa" antes de mostrarlo | se vigila en cada sondeo de la espera | ⚠️ |
| 20 | Lista de imágenes del "+" no aparecía a tiempo | Se miraba una sola vez tras una espera fija | sondeo de hasta 6 s | ⚠️ |
| 21 | El plan robaba el foco de la ventana | `windows.update({focused:true})` | eliminado; solo se activa la pestaña | ⚠️ |

### Ronda v2.0.0 (28 sep 2026)
"Sim." = probado con Chromium real + extensión + **Flow simulado** (`npm run e2e`, `tests/e2e/mock-flow.html`). Demuestra la lógica,
**no** que Flow real se comporte igual. Todo lo que depende del DOM de Flow sigue **SIN VERIFICAR EN VIVO** hasta la prueba del usuario.

| # | Síntoma | Causa | Arreglo | Verif. |
|---|---|---|---|---|
| 22 | v1.2.0: el vídeo de la escena 1 no llegó a hacerse, sin saber dónde se quedó | **Causa exacta desconocida** (no había log). Fallos encontrados leyendo el código, cualquiera de ellos pudo ser: (a) la búsqueda exacta de "001" en el "+" nunca coincidía (el texto real es `"001Imagen"`) y el plan B "contiene 001" podía elegir un **vídeo** llamado 001; (b) con la pestaña oculta, Chrome frena los temporizadores y Flow puede no pintar la lista; (c) si el vídeo tardaba más de 240 s en cola se daba por fallido | `findAssetMatches` (nombre exacto + tipo Imagen), plan B "Animar", esperas que despiertan con el DOM y el latido, espera de vídeo 10 min, log de cada paso | ✅ sim. · ⚠️ SIN VERIFICAR EN VIVO |
| 23 | Un vídeo que tardaba podía **generarse y cobrarse dos veces** | Tras el timeout (240 s) se hacía `continue` → 2.º intento: adjuntar + generar otra vez | Si el coste ya se **aprobó**, nunca se repite: la escena queda "revisar" | ✅ sim. (escenario `resume`) |
| 24 | Se podía asignar a una escena el vídeo de otra | Se cogía el **último** `flow-video-tile` del DOM, pero el orden del DOM no es cronológico | Diferencia de tiles antes/después (`diffNewKeys`, `pickNewVideoKey`) | ✅ tests + sim. · ⚠️ clave del tile en Flow real (`tileKey`) |
| 25 | Descargas con el nombre de Flow / nombres cruzados | Un único `pendingRenameFilename` global y se pasaba al siguiente a los 1,2 s: la descarga que llegaba tarde (1080p tarda) cogía otro nombre o ninguno | Una descarga cada vez: `DL_ARM` → Chrome la registra (`onCreated`) → nombre en `onDeterminingFilename` → espera `complete` (hasta 3 + 5 min) → se comprueba el nombre final → 3 intentos | ✅ sim. (`downloads`) · ⚠️ Flow real |
| 26 | Diálogo "Guardar como" en cada vídeo | Ajuste de Chrome "Preguntar dónde guardar" activado. **Medido en Chromium 141**: con ese ajuste, **ni `chrome.downloads.download({saveAs:false})` evita el diálogo** (la descarga se queda en curso con nombre vacío) | Destino nuevo **"Carpeta elegida"** (File System Access): se cancela la descarga nativa en `onCreated` y el archivo se escribe directamente en la carpeta que el usuario eligió una vez (puede ser el Escritorio) | ✅ medido + sim. con el ajuste **activado** · ⚠️ en la prueba se usa una carpeta OPFS en vez del selector real; permiso real SIN VERIFICAR |
| 27 | (Descubierto al medir) el `filename` de `chrome.downloads.download` se ignoraba | Si existe un listener `onDeterminingFilename`, Chrome aplica lo que diga el listener | Se repite el nombre en el listener para las descargas propias | ✅ medido |
| 28 | Sin puntos o coste > 10 → no se descargaban los vídeos ya hechos | El error cortaba el lote antes de la Fase 2B | Se deja de **generar** pero se descarga lo hecho (`markRemaining`) | ✅ sim. (`cost`) |
| 29 | Mensajes que desaparecían antes de poder leerlos | Cajita que se sobrescribía | Log persistente (`fbrLog`, 3000 líneas) con hora/cuenta/escena/fase, "Copiar log", panel lateral y panel en la página; notificaciones que no se cierran solas si hay fallos | ✅ sim. |
| 30 | "Estás preguntando demasiado rápido" contaba como fallo | No se gestionaba | Detección por texto nuevo del chat + espera 30/60/120/240 s y reenvío | ✅ sim. · ⚠️ texto real ya [V], comportamiento real SIN VERIFICAR |
| 31 | F5 / pestaña cerrada perdía el lote | Estado solo en memoria | Estado por cuenta en `chrome.storage` (`batch_uN`) y reanudación con cuenta atrás de 15 s | ✅ sim. (`resume`) |
| 32 | Riesgo de doble ejecución si la misma cuenta está en dos pestañas | Las dos reanudarían el lote | Turno por cuenta en background (`CLAIM`) | ✅ lógica · sin escenario e2e |
| 33 | Hipótesis descartada: "Chrome bloquea las descargas automáticas múltiples" | — | En Chromium 141, sin permiso de "descargas automáticas", la 2.ª y 3.ª descarga **no** se bloquearon (escenarios `noautodl`, `noautodl2`) | ✅ medido (no es la causa) |
| 34 | Popup que se cerraba al perder el foco | Limitación de los popups de Chrome | Panel lateral (`chrome.sidePanel`) | ✅ sim. |
| 36 | (Hallado en e2e) Con dos cuentas a la vez, una caía a "Descargas" diciendo "no hay carpeta elegida" | Las dos consultaban la carpeta mientras se creaba el documento offscreen; una no recibía respuesta y se interpretaba como "sin carpeta" | Reintentos en `offscreenCall`, mensaje con la causa real y segundo intento antes de caer a Descargas | ✅ sim. |
| 37 | (Hallado en e2e) Archivo duplicado `mundofut_001 (1).mp4` | El turno de descargas se liberaba al terminar, antes de que la cuenta dueña recogiera el resultado: la otra se lo quitaba y la primera lo repetía | El turno se libera solo cuando la dueña recoge el resultado (`collected`) | ✅ sim. |
| 38 | (Hallado en e2e) Con "Preguntar dónde guardar" activado y destino Descargas, cada vídeo se quedaba hasta 15 min esperando al diálogo | 3 intentos × 5 min | Notificación fija "Chrome pide Guardar como" + 2 min de margen y sin reintentos | ✅ sim. |
| 39 | v2.0.0 en el Chrome del usuario: pulsar el icono de la extensión no hacía nada | **Causa sin confirmar.** En Chromium limpio `getPanelBehavior()` da `openPanelOnActionClick:true` (✅ medido), así que en su Chrome probablemente el service worker falló o no aplicó el ajuste. El clic en el icono nunca se había probado (el e2e abre el panel como pestaña) | v2.0.1: `action.onClicked` abre el panel a mano (y si no puede, como pestaña) + botón "Panel de control" en la píldora de Flow | ✅ botón probado en Chromium (abre como pestaña) · ⚠️ SIN VERIFICAR en su Chrome |
| 35 | No había forma de probar sin gastar puntos (la extensión aprueba sola) | — | Modos **ENSAYO** (llega al aviso de coste y pulsa "Rechazar") y **PRUEBA de descarga** (descarga vídeos ya existentes) | ✅ sim. (`dryrun`, `dltest`) · ⚠️ en real |

## Decisiones de diseño (no las reviertas sin hablar con el usuario)
- El Agent hace las imágenes de golpe con una sola instrucción (rápido y las renombra); los vídeos van de uno en uno.
- Los reintentos de imágenes se piden **al propio Agent** en la misma conversación (no adivinamos qué palabra bloqueó).
- El plan multi-cuenta cambia de *pestaña*, no de sesión: las dos sesiones deben estar abiertas de antemano.
- (v2) Por defecto las dos cuentas corren **en paralelo** (cada una en su pestaña/ventana); las **descargas** van de una en
  una para toda la extensión, porque Chrome no dice de qué pestaña sale cada descarga.
- (v2) Un vídeo con el coste ya aprobado **nunca** se regenera solo: prima no gastar puntos dos veces.
- (v2) Destino por defecto: **carpeta elegida** (el usuario quiere mantener activado "Preguntar dónde guardar").
