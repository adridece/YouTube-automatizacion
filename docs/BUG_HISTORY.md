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

## Decisiones de diseño (no las reviertas sin hablar con el usuario)
- El Agent hace las imágenes de golpe con una sola instrucción (rápido y las renombra); los vídeos van de uno en uno.
- Los reintentos de imágenes se piden **al propio Agent** en la misma conversación (no adivinamos qué palabra bloqueó).
- El plan multi-cuenta cambia de *pestaña*, no de sesión: las dos sesiones deben estar abiertas de antemano.
