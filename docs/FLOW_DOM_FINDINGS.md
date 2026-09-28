# Hallazgos verificados sobre Google Flow (DOM y comportamiento)

Verificado **en vivo** sobre una cuenta real (Pro), interfaz en **español**, 26–27 sep 2026, en
`flow.google.com/u/2/project/<uuid>`. Etiquetas: **[V]** visto directamente · **[V-indirecto]** deducido de un
resultado real que contó el usuario · **[SUPUESTO]** no verificado. Flow es una app Angular que cambia; si algo
deja de funcionar, lo primero es re-comprobar esta lista con `tools/flow-diagnostic.js`.

## Dominio y cuentas
- **[V]** El dominio real es `flow.google.com`; `labs.google/fx/tools/flow` redirige ahí.
- **[V]** Varias cuentas conviven en el mismo perfil de Chrome como `/u/0/`, `/u/1/`, `/u/2/`… Proyecto: `/u/N/project/<uuid>`.
- **[V]** Hay una pantalla de "debes tener 18 años" si la pestaña no tiene sesión iniciada.

## Panel del Agent (derecha) y caja de prompt
- **[V]** Caja de prompt: editor ProseMirror → selector robusto `flow-agent-panel flow-rich-text-editor [contenteditable="true"]`.
  La ruta larga `#main-content > … > div.prompt-top-row > flow-rich-text-editor > div > div > p` **deja de existir al
  adjuntar una imagen** (bug real que paró todo el lote).
- **[V]** Insertar texto: `el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, texto);`
  + evento `input` → el texto se envía correctamente.
- **[V]** Botón generar: `flow-agent-panel flow-generate-icon-button` envuelve `<button type="submit" aria-label="Iniciar generación">`.
  Funciona llamar a `.click()` **nativo** sobre el `<button>` interno. Una secuencia de `PointerEvent/MouseEvent`
  sintéticos sobre el envoltorio **no** dispara nada.
- **[V]** Ajustes del Agent (icono de sliders junto a la caja → "Configuración del agente"): "Confirmar antes de
  generar" (Siempre/Nunca); imágenes: aspect ratio, x1–x4, modelo (Nano Banana 2); vídeo: aspect ratio, x1–x4,
  modelo (**Omni 1.1 Flash**, Veo 3.1 Lite / Fast / Quality). Con x2 y sin instrucción explícita el Agent genera 2
  imágenes por prompt; con "genera exactamente UNA imagen por prompt" respeta una.

## Tiles (resultados en la cuadrícula)
- **[V]** `flow-image-tile`, `flow-video-tile`, `flow-pending-tile`. El nombre visible está en `.footer-title`.
- **[V]** `flow-pending-tile` existe **solo mientras se genera**; "terminó" = no queda ninguno (`pending == 0`).
- **[V]** El orden de los tiles en el DOM **no es el orden numérico** (las regeneradas cambian de sitio): buscar siempre por nombre.
- **[V]** El Agent, si se lo pides ("renombra cada imagen con su identificador [00X]"), las llama literalmente `001`, `002`…
  El renombrado ocurre **después** de que termine la generación (con retraso) → esperar hasta ~15 s antes de dar una
  escena por perdida. Puede haber **nombres duplicados** (p. ej. tras reintentos).
- **[V]** Fallo de imagen: tarjeta "Error — No se ha podido generar esta imagen. No se te ha cobrado por esta generación."
  (con botones reintentar/deshacer/borrar). Si es política de contenido, el Agent lo dice en el chat:
  "[002]: Esta generación fue bloqueada por nuestras políticas de seguridad…".
- **[V]** Vídeo: ~45–60 s en una prueba; el Agent avisa "Debido a la alta demanda, la generación se encuentra en cola".
  Puede tardar más.

## Menú contextual (clic derecho sobre un tile)
- **[V-indirecto]** Abrirlo con un `MouseEvent('contextmenu')` sintético funciona (las descargas de la extensión se dispararon).
- **[V]** Vive en `.cdk-overlay-container`; items `flow-menu-item` (el texto incluye el nombre del icono, p. ej. "downloadDescargar").
  **Ids dinámicos** (`#mat-menu-panel-N`, `#cdk-overlay-N`) cambian en cada sesión: nunca usarlos.
- **Imagen**: Marcar como favorito · Reutilizar petición · **Animar** · Añadir a la petición · **Descargar ▸** (1K Tamaño original,
  2K Resolución mejorada, 4K [Actualizar]) · Copiar · Cambiar nombre · Compartir · Definir portada del proyecto · Denunciar · Papelera.
- **Vídeo**: … Añadir a la escena ▸ · Añadir a la petición · **Descargar ▸** (**270p GIF animado, 720p Tamaño original,
  1080p Resolución mejorada, 4K [Actualizar]**) · Copiar · Cambiar nombre · Compartir · Publicar en YouTube …
- **[V]** "Animar" adjunta esa imagen a la caja en un paso (atajo; hoy solo es plan B).

## Botón "+" (adjuntar referencia)
- **[V]** `flow-agent-panel flow-add-menu button` abre directamente el explorador de assets ("Todo" seleccionado). **No hace falta**
  pulsar ninguna opción del menú lateral (Todo/Imágenes/Vídeos/Voces/Caracteres/Subidas): ese clic extra era un bug.
- **[V]** Items: `.cdk-overlay-container flow-add-menu-asset-item`, `textContent` = etiqueta + tipo (`"001Imagen"`). Lista virtualizada
  (`cdk-virtual-scroll-viewport`), orden "Recientes", **mezcla imágenes y vídeos**, y a veces tarda >1 s en pintarse (sondear).
- **[V]** Al clicar un item aparece la vista previa ("Vista previa de 001") y el botón "Añadir a petición":
  `.cdk-overlay-container flow-add-menu-detail-pane div.bottom-actions button`. Al pulsarlo el menú **se cierra solo** y aparece la
  miniatura adjunta en la caja. `Escape` cierra el menú.

## Aviso de coste (vídeo)
- **[V]** Con "Confirmar antes de generar = Siempre", generar un vídeo muestra en el chat un `flow-permission-message`:
  "¿Quieres que empiece a generar 1 vídeo, que cuesta N puntos?" con filas `div.option-row[role=radio][aria-label]` =
  `Aprobar` · `Aprobar siempre` · `Rechazar`. No son `<button>` ni están en el overlay.
- **[V]** Los avisos **ya contestados** siguen en el HTML pero con clase `read-only`, `aria-disabled="true"` y `pointer-events:none`.
  El pendiente no tiene `read-only`. Filtrar siempre por eso (`.option-row:not(.read-only):not([aria-disabled='true'])`).
- **[V]** **"Aprobar siempre" cambia el ajuste a "Nunca"** de forma permanente → se pierde la comprobación de coste.
- **[V]** "Rechazar" no cuesta nada; el Agent responde "He cancelado la generación del vídeo…".
- **[V]** Las **imágenes no piden confirmación** (generan directamente aun con "Siempre").
- **[V] Coste según el prompt** (Omni 1.1 Flash, vídeo 9:16): con `6 seconds` en el prompt → **10 puntos**; con
  `… Duration: 6 seconds.` añadido al final → **10**; sin ninguna duración → **15**. Por eso `ensureVideoDuration`.
- **[SUPUESTO]** Qué coste tienen otras duraciones (5, 8 s) y cómo escala con el modelo Veo.

## Límites y errores del servicio
- **[V]** "Estás preguntando demasiado rápido. Ve más despacio e inténtalo de nuevo." + botón "Reintentar" (devuelve el mensaje a la
  caja; hay que volver a enviar). **Aún no se gestiona** (TODO P0).
- **[SUPUESTO]** Qué pasa al agotar los ~50 puntos diarios (mensaje/estado desconocido).

## Descargas
- **[V-indirecto]** Descargar = clic derecho → Descargar → resolución. Es una descarga **nativa** de la página (no da URL).
  La extensión guarda el nombre deseado en `chrome.storage.local.pendingRenameFilename` y `background.js` lo aplica en
  `chrome.downloads.onDeterminingFilename` (ruta `MundoFutFlow/<nombre>`).
- **[V]** Con el ajuste de Chrome "Preguntar dónde guardar cada archivo" activado, sale un diálogo con el nombre por
  defecto de Flow (p. ej. "caricature…") → hay que desactivarlo.
- **[SUPUESTO]** Que el renombrado funciona de extremo a extremo con ese ajuste desactivado (nunca se ha probado así).

## Entorno de herramientas
- Claude in Chrome no puede navegar a `chrome://extensions` (permiso denegado) y no puede escribir contraseñas por el usuario.
