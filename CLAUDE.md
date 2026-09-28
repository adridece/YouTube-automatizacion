# CLAUDE.md — Flow Batch Runner (MUNDO FUT / The Odd Ledger)

Lee este archivo entero antes de tocar nada. El detalle está en `docs/`.

## Qué es
Extensión de Chrome (Manifest V3, JavaScript puro, sin dependencias ni build) que automatiza
**Google Flow** (`flow.google.com`) para producir Shorts de YouTube en lote: genera las imágenes de
todas las escenas, anima cada una con su prompt de animación, y descarga **solo los vídeos** con
nombre numerado. Es una herramienta personal del dueño del repo, para su canal de fútbol **MUNDO FUT**
(el mismo flujo sirve para su canal de curiosidades "The Odd Ledger").

## Con quién trabajas y cómo
- El usuario habla **español**: responde en español; comentarios de código y textos de la interfaz en español.
- Quiere que **todo funcione en automático, sin tocar nada y sin tener que mirarlo**. Mientras corre,
  quiere seguir usando el navegador para otras cosas.
- Le frustran: (1) fallos **silenciosos**, (2) mensajes de error que desaparecen antes de poder leerlos,
  (3) que se le diga "ya funciona" sin haberlo probado. Sé honesto y concreto sobre qué está verificado.
- Suele probar la extensión y te cuenta lo que pasa con detalle (capturas + mensajes). Ese feedback real
  ha sido la fuente de casi todos los bugs encontrados: pídele el mismo nivel de detalle.

## LÍMITE IMPORTANTE de este entorno (Claude Code en la nube)
**No ves su navegador ni su sesión de Flow, y no puedes iniciar sesión en Google por él.** Por tanto:
1. Todo lo que dependa del DOM de Flow: usa `docs/FLOW_DOM_FINDINGS.md` como fuente de verdad (está
   verificado en vivo). No inventes selectores ni comportamientos.
2. Si necesitas datos nuevos del DOM, pídele que ejecute `tools/flow-diagnostic.js` (solo lectura, no gasta
   puntos) en la consola de Flow y te pegue el resultado, o que te pase capturas/HTML.
3. Todo cambio que dependa del DOM se marca **"SIN VERIFICAR EN VIVO"** en `docs/BUG_HISTORY.md` hasta que el
   usuario confirme que funciona. La lógica pura sí se prueba: `npm run verify`.
4. Si en algún momento sí tienes acceso a un navegador con su sesión de Flow, puedes verificar en vivo — pero
   **no gastes puntos de Flow en pruebas** (rechaza los avisos de coste: "Rechazar" no cuesta nada) y limpia
   lo que generes (los proyectos de prueba ensucian su cuenta).

## El proceso que quiere (resumen; completo en `docs/REQUIREMENTS.md`)
1. Pega el kit completo (prompts de imagen `[001]…[00N]` y luego prompts de animación `[001]…[00N]`), una sola vez.
2. Dos cuentas de Google en dos pestañas del mismo perfil de Chrome (`/u/2/` y `/u/3/`); a cada una le toca un
   rango de escenas (típico: 1-5 y 6-8) porque cada cuenta tiene ~50 puntos diarios = 5 vídeos.
3. **Fase 1**: una sola instrucción al Agent de Flow genera todas las imágenes y las renombra `001`, `002`…
   (las que falten se reintentan). **No se descargan imágenes.**
4. **Fase 2A**: una a una, para cada escena: adjuntar SU imagen (botón "+") → escribir su prompt de animación →
   generar → comprobar coste (≤ 10 puntos) → esperar (puede tardar minutos por cola) → siguiente.
5. **Fase 2B**: cuando terminan TODAS, descargar los vídeos, bien nombrados (`<prefijo>_<NNN>.mp4`), sin diálogos.
6. Si una generación falla (política de contenido, etc.): reintentar reformulando, y **siempre informar del número
   de escena** que falló. Nunca dejar que un fallo pare las demás escenas ni la otra cuenta.

## Estado actual (27 sep 2026)
Verificado en vivo por partes (imágenes con Agent, renombrado, adjuntar imagen, generar, aviso de coste,
menús de descarga). **Aún no se ha completado NUNCA una ejecución real de principio a fin de la Fase 2 con la
extensión** (el último intento falló en el cuadro de prompt; se corrigió y se comprobó a mano en consola).
Lo primero que hay que hacer con el usuario es una prueba real con un rango pequeño (`1-2`). Ver `docs/TODO.md`.

## Reglas de código (lecciones costosas — respétalas)
- **Selectores cortos y semánticos**, nunca rutas largas `#main-content > … > p` (se rompen al adjuntar una
  imagen) ni ids dinámicos (`#mat-menu-panel-245`, `#cdk-overlay-13` cambian en cada sesión). Los menús
  flotantes viven en `.cdk-overlay-container`; los elementos se buscan por **texto**, no por posición.
- **Clics**: `flow-generate-icon-button` es un envoltorio de Angular; hay que llamar al método nativo
  `.click()` del `<button type="submit">` de dentro (`clickDeep`). Los eventos de puntero sintéticos NO funcionan.
- **Nunca pulsar "Aprobar siempre"**: cambia el ajuste "Confirmar antes de generar" a "Nunca" y ya no se puede
  comprobar el coste. Se pulsa "Aprobar" (solo esa vez) y solo si el coste es ≤ 10. El ajuste debe estar en "Siempre".
- **El coste lo fija la duración del prompt**: `Duration: 6 seconds` → 10 puntos; sin duración → 15. Todo prompt de
  animación pasa por `ensureVideoDuration`. El modelo de vídeo debe seguir en "Omni 1.1 Flash": la extensión
  nunca lo toca.
- **Espera larga**: la IA "piensa" y la cola de vídeo puede tardar minutos. No reintentar el clic si el mensaje
  ya se envió (duplicaría la petición y gastaría puntos).
- **Un fallo en una escena nunca aborta las demás**: marca la escena como fallida y sigue. La señal `"stopped"`
  (botón Detener) sí debe propagarse siempre; no la tragues en un `catch`.
- **El usuario no ve mensajes efímeros**: cada error debe quedar registrado de forma persistente y legible
  (ver TODO P0-2). No robar el foco de ventana (`background.js` no llama a `windows.update`).
- Mantén `docs/FLOW_DOM_FINDINGS.md` al día cada vez que aprendas algo nuevo del DOM.

## Mapa del repo
```
extension/            <- lo que se carga en Chrome (chrome://extensions -> Cargar descomprimida)
  manifest.json       MV3; content script en flow.google.com; permisos: storage, downloads, tabs, notifications…
  shared.js           lógica PURA (parseo del kit, rangos, cuenta /u/N/, coste, duración). Testeada.
  content.js          la automatización dentro de la página de Flow (fases 1, 2A, 2B, auto-inicio)
  background.js       renombrado de descargas (onDeterminingFilename), plan multi-cuenta, notificaciones
  popup.html/js       interfaz: pegar kit, rango, resolución, plan de dos cuentas
docs/                 REQUIREMENTS, FLOW_DOM_FINDINGS, ARCHITECTURE, BUG_HISTORY, TODO, PROMPT_KIT_FORMAT
tests/shared.test.js  tests de la lógica pura (node:test, sin dependencias)
tools/flow-diagnostic.js  diagnóstico de solo lectura para pegar en la consola de Flow
examples/sample-kit.txt   kit de ejemplo con el formato real (incluye ``` y encabezados)
```

## Comandos
- `npm run verify` → `node --check` de todo + tests (hazlo siempre antes de dar algo por terminado).
- `npm run zip` → genera `flow-batch-extension.zip` (solo la carpeta `extension/`).
- Cargar en Chrome: `chrome://extensions` → Modo de desarrollador → "Cargar descomprimida" → carpeta `extension/`.
  Tras cualquier cambio: botón ⟳ de la extensión **y F5 en las pestañas de Flow** (si no, siguen con el código viejo).

## Antes de cada lote (requisitos del entorno del usuario)
- Flow → Ajustes ⚙ → "Configuración del agente": **Confirmar antes de generar = Siempre**; vídeo = **Omni 1.1 Flash**;
  aspect ratio 9:16 y cantidad x1 en imagen y vídeo.
- Chrome → `chrome://settings/downloads`: **desactivar "Preguntar dónde guardar cada archivo"** (si no, cada descarga
  abre un diálogo). Para que los vídeos caigan en el Escritorio, cambiar ahí la carpeta de descargas al Escritorio
  (la extensión solo puede guardar en una subcarpeta de la carpeta de descargas de Chrome: `MundoFutFlow/`).

## Al terminar cada tarea
1. `npm run verify`. 2. Actualiza `docs/BUG_HISTORY.md` (qué cambió, cómo se verificó o "SIN VERIFICAR") y `docs/TODO.md`.
3. Dile al usuario exactamente qué debe probar y qué mensaje/captura te debe traer si falla.
