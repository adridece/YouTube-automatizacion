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
- **[V]** Items: `.cdk-overlay-container flow-add-menu-asset-item`, `textContent` = etiqueta + tipo (`"001Imagen"`) — por eso la
  comparación exacta con "001" nunca coincidía en la v1; la v2 separa nombre y tipo (`parseAssetItemText`). Lista virtualizada
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
- **[V por el usuario, 28-sep, v2.5.0]** Aun con `Duration: 6 seconds` en el prompt, la IA a veces pide **12 puntos** (entendió otra
  duración). Según el usuario, **al reenviar el prompt suele salir a 10**. Por eso v2.6 remarca los 6 s al principio y al final y,
  si pide > 10, "Rechazar" + reenvío (hasta 3). Texto exacto del aviso de 12: [SUPUESTO] igual que el de 10 con otro número.
- **[SUPUESTO, v2.6]** El Agent puede nombrar las imágenes de otra forma que `006` (la cuenta 2 dijo "faltan" aunque existían). El
  log de v2.6 imprime los nombres que ve; cuando llegue, anotar aquí el formato real.

## Límites y errores del servicio
- **[V]** "Estás preguntando demasiado rápido. Ve más despacio e inténtalo de nuevo." + botón "Reintentar" (devuelve el mensaje a la
  caja; hay que volver a enviar). La v2 **no** pulsa "Reintentar" (podría ser uno viejo del historial): espera 30/60/120/240 s y
  vuelve a adjuntar + escribir + enviar.
- **[SUPUESTO]** Qué pasa al agotar los ~50 puntos diarios (mensaje/estado desconocido).

## Descargas
- **[V-indirecto]** Descargar = clic derecho → Descargar → resolución. Es una descarga **nativa** de la página (no da URL).
- **[V]** Con el ajuste de Chrome "Preguntar dónde guardar cada archivo" activado, sale un diálogo con el nombre por
  defecto de Flow (p. ej. "caricature…").
- **[SUPUESTO]** Si la descarga llega como `blob:` o como `https:` y cuánto tarda Flow en preparar 1080p. La v2 lo escribe en el
  log ("Chrome ha registrado la descarga #N (URL tipo …, a los X s)") → pasarlo aquí en cuanto se vea.
- **[SUPUESTO]** Atributos estables de `flow-video-tile` (la v2 usa `data-id`/`id` si existen, si no el `src` del `<video>`).
  `tools/flow-diagnostic.js` → `cuadricula.primerosVideos` lo muestra.

## Visto en la prueba real del 28 sep 2026 (log del usuario, v2.1.0)
- **[V]** Con la pestaña de Flow oculta, el vídeo se queda "al 100%" y no termina hasta que el usuario entra en la pestaña.
  Al terminar, Flow **redibuja** el tile (sale como tile nuevo).
- **[V]** Una pestaña de Flow que nunca se ha visto puede no pintar la caja de prompt en 30 s.
- **[V]** La vista previa del "+" (`flow-add-menu-detail-pane`) tiene como texto solo "Añadir a petición": el nombre no está en el texto.
- **[V]** "Animar" (clic derecho en la imagen) adjunta bien la imagen (usado en las 5 escenas).
- **[V]** El aviso de coste y "Aprobar" funcionan: "Flow ha registrado la aprobación" en las 5 escenas; 10 puntos.
- **[V]** La descarga 1080p pedida por la extensión llegó como `blob:` a los 45 s (11,6 MB); una descarga manual del usuario llegó como `https:`.
- **[V]** El navegador del usuario no tiene panel lateral para extensiones ("SidePanel API not available").
- **[V por el usuario, prueba v2.6]** El Agent **NO renombra bien los VÍDEOS** aunque se le pida (sí lo hace con las imágenes). Por eso v2.7
  ya no se lo pide: identifica cada vídeo por diferencia de tiles y lo descarga al momento.
- **[SUPUESTO, v2.7]** Al adjuntar una imagen, la "caja" del Agent (el antecesor común del editor y del botón generar) cambia
  (aparece la miniatura). La extensión lo usa para comprobar que la imagen quedó adjunta.

## Visto en la prueba real v2.7 (28 sep 2026, log del usuario)
- **[V-indirecto]** Mientras se genera un vídeo, en la cuadrícula hay un `flow-pending-tile` **y** un `flow-video-tile` provisional sin
  "%" cuyo menú contextual no tiene "Descargar". Al terminar, Flow pone el tile definitivo en un nodo nuevo.
- **[V por el usuario]** Menú contextual del vídeo: `#mat-menu-panel-N > div > flow-video-context-menu-items > flow-media-context-menu-items
  > flow-menu-item` (el 7.º es "Descargar", con `button > span > span` dentro) → submenú 720p / 1080p. La extensión busca por texto.
- **[SUPUESTO]** Qué atributos estables tiene `flow-video-tile` (id, `src`, miniatura…). La v2.8 avisa en el log si no encuentra ninguno.

## Comportamiento de Chrome medido (Chromium 141, no depende de Flow)
- **[V]** Pestaña oculta: `requestAnimationFrame` no se ejecuta (contador congelado). Al capturarla con `chrome.tabCapture` (o
  `getDisplayMedia`), Chrome la marca `visibilityState = "visible"` y la pinta a ~60 fps aunque el usuario esté en otra pestaña.
- **[V]** `chrome.tabCapture.getMediaStreamId({targetTabId})` falla con "Extension has not been invoked for the current page"
  si el usuario no ha pulsado la extensión en esa pestaña. Tras pulsarla, funciona desde el service worker y la captura se
  sostiene en el documento offscreen. La captura sobrevive a un F5 de la pestaña.
- **[V]** Log real: en la pestaña oculta de u3 la página mostraba "Cargando…" durante 90 s (Flow no arranca sin estar visible).
- **[V]** Con "Preguntar dónde guardar" **activado**, `chrome.downloads.download({saveAs:false})` **también** abre el diálogo: la
  descarga se queda `in_progress` con `filename` vacío. No hay forma por código de saltárselo con la API de descargas.
- **[V]** Cancelar la descarga en `chrome.downloads.onCreated` la deja `interrupted/USER_CANCELED` en milisegundos, antes del diálogo.
  Así funciona el destino "Carpeta elegida": se cancela la nativa y el archivo se escribe con File System Access.
- **[V]** Si hay un listener `onDeterminingFilename`, el `filename` pasado a `chrome.downloads.download` se ignora salvo que el
  listener lo repita.
- **[V]** `DownloadItem.byExtensionId` viene vacío en `onCreated` (sí aparece en `onDeterminingFilename`).
- **[V]** Un content script puede leer con `fetch` una URL `blob:` creada por la página.
- **[V]** Sin permiso de "descargas automáticas", la 2.ª y 3.ª descarga disparadas por la página (sin gesto del usuario) **no** se bloquearon.

## Entorno de herramientas
- Claude in Chrome no puede navegar a `chrome://extensions` (permiso denegado) y no puede escribir contraseñas por el usuario.

## HeyGen (voz, v2.9) — lo que dio el usuario el 29 sep 2026 [SIN VERIFICAR por la extensión]
- Proyecto: `https://app.heygen.com/create-v4/<id>?vt=l&panel=scene&subPanel=voice`.
- Guion (puede traer texto previo: hay que borrarlo): `… div.css-ltmzi1.te-scriptpanel-redesign.tw-relative > div:nth-child(2) > div > div`.
  La extensión usa `.te-scriptpanel-redesign [contenteditable="true"]` y la ruta sin las clases `css-xxxx` (cambian con cada versión).
- Botón reproducir: `… div.tw-h-[168px] > div.tw-flex.tw-w-full.tw-flex-row.tw-items-center.tw-justify-between.tw-border-b.tw-border-line.tw-pb-2
  > div.tw-relative.tw-flex.tw-flex-row.tw-items-center.tw-gap-3 > div:nth-child(1) > div`.
- Al reproducir aparece una petición nueva de tipo **Media** en la red: ese es el audio que se guarda (audio.mp3).
- **[V por el usuario, 29 sep, captura de Network]** Tras pulsar play: `appear_v1.webm` y `disappear_v1.webm` (206, media, desde caché de disco: animaciones de la interfaz) y la VOZ `id=98f62577-89f0-49…` (206, media, ~88 kB). Si no aparece, **al recargar la página sí aparece** la voz.
- **[V por el usuario, 29 sep, v2.9.4]** La voz aparece en Network → Media al **parar** la reproducción: play → ~10 s → pulsar otra vez el mismo botón.
- **[V por el usuario, 29 sep]** HeyGen solo deja **previsualizar la voz 3 veces al día**; sin previsualización no hay audio en la red.
- **[V por el usuario, 29 sep]** El botón exacto es el `<button>` dentro de ese div (`… > div:nth-child(1) > div > button`).
- **[V-indirecto, log v2.9.1]** Tras pegar, el guion muestra la narración con otro formato (no idéntico carácter a carácter).
