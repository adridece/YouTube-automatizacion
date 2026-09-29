# CLAUDE.md — Cerezium Autopilot (antes "Flow Batch Runner") · MUNDO FUT / The Odd Ledger

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

## Estado actual (29 sep 2026 — v2.10.4, "Cerezium Autopilot")
v2.10.4 (BUG_HISTORY #81): antes de cada envío de vídeo, 20 s de margen y esperar a que el Agent esté libre (el usuario: "dale tiempo a
la IA"). Pendiente el log de una prueba en que la cuenta 2 no generó ningún vídeo.

v2.10.3 (BUG_HISTORY #80, **prueba real: el mismo vídeo se generaba varias veces**): "salió/falló" se decide CONTANDO vídeos buenos y
avisos de error (los tiles de Flow no tienen id estable y se redibujan); un fallo se confirma 60 s; antes de reintentar se mira si el
vídeo llegó tarde. e2e: `realtiles`.

v2.10.2 (BUG_HISTORY #79): los vídeos que Flow falla se reintentan **siempre** (hasta 5 vueltas extra, suavizando cada vez más con el
mismo estilo); antes un fallo tras "Aprobar" no entraba en la 2.ª vuelta. e2e: `alwaysretry`.

**Prueba real v2.10.0: la música de Mureka funciona** (y la voz de HeyGen funcionó a las 10:08). v2.10.1 (BUG_HISTORY #78): un vídeo
que Flow falla deja un tile SIN vídeo → se reconoce como fallo y se reintenta (antes se daba por bueno y la descarga se colgaba);
si falta el botón de generar tras las imágenes se espera y no se re-adjunta la imagen. e2e: `videoerror`, `busyagent`.

v2.10: **música de Mureka** (`mureka.js` + `runMusic`): prompt → generar UNA vez → Library → play → archivo «music…» de la red →
`musica.mp3` en la carpeta del lote (BUG_HISTORY #77, SIN VERIFICAR en Mureka real). e2e: `music`, `musiconly`; e2e:bg `musicbg`.

v2.9.1: el panel ya no bloquea si el kit no trae todo: hace solo imágenes, solo vídeos o **solo la voz** según lo que haya
(BUG_HISTORY #69).

**Prueba real v2.8: la descarga de vídeos funciona** (probado con 1 vídeo). v2.9 añade la **voz de HeyGen**: narración del kit →
pestaña de HeyGen → guion → reproducir → el audio nuevo (red, tipo Media) se guarda como `audio.mp3` en la carpeta del lote
(`heygen.js` + `runVoice` en background, depurador Network). BUG_HISTORY #68, SIN VERIFICAR en HeyGen real. e2e: `voice`.

### v2.8.0
**Prueba real v2.7: TODO funcionó (imágenes, adjuntar, coste 10, aprobar, vídeos) salvo las descargas** (BUG_HISTORY #67: se tomaba
un tile provisional por el vídeo terminado; Flow lo sustituye al terminar). v2.8: espera a que termine de verdad, re-busca el tile
antes de cada intento, clave por contenido, y plan B de descarga directa de la fuente del vídeo. SIN VERIFICAR en real.

### v2.7.0
v2.7 (tras la prueba real de la v2.6: el Agent renombra mal los vídeos → descargas cruzadas; un fallo en la cuenta 2 no se
resolvió solo): **cada vídeo se descarga nada más generarse** (identificado por diferencia de tiles, nunca por nombre; nunca dos
vídeos generándose a la vez); se verifica que la imagen quedó adjunta antes de enviar; **segunda vuelta automática** de las escenas
fallidas sin coste y **F5 automático** ante fallos técnicos (máx. 2); espera ampliada si Flow sigue en cola; un vídeo que llega
tarde se asigna a su escena. BUG_HISTORY #59–66 (SIN VERIFICAR en real). e2e: `misname`, `selfheal`, `agentreply`.

### v2.6.0
v2.6 (tras la prueba real de la v2.5): el icono abre la **ventanita** (popup) por defecto — el panel lateral estrechaba Flow y
rompía la automatización; imágenes reconocidas aunque el Agent las nombre "Imagen 006"/"006.png"; vídeo a 12 puntos →
"Rechazar" y reenvío remarcando los 6 s (hasta 3), nunca "Aprobar siempre"; si un vídeo empieza sin aviso de coste se para
de generar en esa cuenta. BUG_HISTORY #55–58 (SIN VERIFICAR en real).

Rehecha entera en la ronda del 28 sep (ver `docs/BUG_HISTORY.md` #22–34): log persistente, panel lateral, descargas de una en una
con destino "Carpeta elegida" (sin diálogo aunque "Preguntar dónde guardar" esté activado — el usuario lo quiere activado),
cuentas en paralelo, reanudación tras F5, límite de ritmo. **Todo probado con Chromium real + Flow SIMULADO (`npm run e2e`, 44/44)**,
pero **aún no se ha completado NUNCA una ejecución real en Flow**. v2.1: el navegador del usuario **no tiene panel lateral**
("SidePanel API not available") → ventanita de extensión; trabajo en segundo plano (nunca activar Flow; permiso de descargas
automáticas vía `contentSettings`, sin él Chrome retiene la 2.ª descarga con Flow oculto — `npm run e2e:bg`).
**Primera prueba real (v2.1.0, 28 sep)**: imágenes, aviso de coste y "Aprobar" funcionan; con Flow oculto los vídeos se quedaban
al 100% → v2.2 `page-hook.js` + renombrado de vídeos vía Agent. **Prueba real v2.2**: no bastó (u3 "Cargando…") → **v2.3: captura de
pestaña (`tabCapture`)**, que hace que Chrome trate la pestaña como visible de verdad; requiere que el usuario pulse la cereza una
vez en cada pestaña de Flow (v2.3.1: cada clic la prepara). **Prueba real v2.3.1**: preparación OK, pero Flow no aceptó el envío
sin foco → v2.4: rotación de formas de escribir/enviar. **Prueba real v2.4.0**: nada se envía sin foco → v2.5: permiso `debugger`
(autorizado por el usuario el 28 sep) para foco simulado + clic real, solo en pestañas de Flow y solo durante el lote. Ver BUG_HISTORY #43–54. Regla: para cualquier cosa de segundo plano, prueba con `npm run e2e:bg`. Lo primero con el usuario: la prueba de `README.md` →
"Primera prueba de la v2", y pedirle el log copiado. Ver `docs/TODO.md`.

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
- **Un fallo en una escena nunca aborta las demás**: marca la escena como fallida y sigue. La señal de parada
  (`StopError`, botón Detener) sí debe propagarse siempre; no la tragues en un `catch`.
- **Nunca regenerar solo un vídeo cuyo coste ya se aprobó** (se marca "revisar"): repetirlo puede cobrar dos veces.
- **El vídeo de una escena se identifica por diferencia de tiles** (antes/después), nunca por posición en el DOM ni por el
  nombre (el Agent renombra mal los vídeos). Se descarga **en cuanto aparece**, y nunca hay dos vídeos generándose a la vez.
- **Nunca pagar dos veces un vídeo**: "salió/falló" se decide por CUENTAS (vídeos buenos / avisos de error antes y después), nunca
  por "tile nuevo" (los tiles se redibujan sin id estable). Un fallo se confirma antes de reintentar, y antes de reintentar se
  comprueba si el vídeo anterior llegó tarde. La palabra "error" suelta no es un fallo.
- **Un tile de vídeo SIN fuente de vídeo no es un vídeo terminado** (puede ser el aviso de error de Flow): se espera o se trata como fallo.
- **Nunca enviar un prompt de vídeo sin comprobar que su imagen quedó adjunta** (podría cobrar un vídeo sin referencia).
- **HeyGen: pulsar reproducir UNA sola vez por lote** (máx. 3 previsualizaciones al día): nunca reintentar el clic. A los 10 s se pulsa
  el mismo botón UNA vez para parar (así sale la voz en la red; parar no gasta). Sin recargar. HeyGen se prepara para
  segundo plano igual que Flow (cereza en su pestaña, depurador, page-hook): prueba con `npm run e2e:bg` (`voicebg`).
- **Mureka: pulsar generar UNA sola vez por lote** (gasta créditos): nunca reintentar ese clic. El play en Library sí se puede repetir.
- **Todo fallo que no cuesta puntos se reintenta solo** (segunda vuelta, F5 automático): el usuario no quiere resolver nada a mano.
- **Descargas de una en una** para toda la extensión, asociadas a su escena en `background.js`; se comprueba el nombre final.
- Las esperas usan `waitFor` (despierta con el DOM y con el latido del background): no uses `setInterval`/`sleep` fijos para esperar a Flow.
- **El usuario no ve mensajes efímeros**: cada error debe quedar registrado de forma persistente y legible
  (ver TODO P0-2). No robar el foco de ventana (`background.js` no llama a `windows.update`).
- Mantén `docs/FLOW_DOM_FINDINGS.md` al día cada vez que aprendas algo nuevo del DOM.

## Mapa del repo
```
extension/            <- lo que se carga en Chrome (chrome://extensions -> Cargar descomprimida)
  manifest.json       MV3; content script en flow.google.com; permisos: storage, downloads, tabs, notifications…
  shared.js           lógica PURA (parseo del kit, rangos, cuenta /u/N/, coste, duración). Testeada.
  content.js          la automatización dentro de la página de Flow (fases 1, 2A, 2B, auto-inicio)
  background.js       log persistente, notificaciones, latido, plan de cuentas, gestor de descargas
  sidepanel.html/css/js  interfaz (panel lateral): kit, cuentas, salida, checklist, progreso, log
  offscreen.html/js   escribe los vídeos en la carpeta elegida (con fs-store.js: handle en IndexedDB)
  page-hook.js        (mundo de la página) retrasa URL.revokeObjectURL para poder leer el blob de la descarga
  heygen.js           en app.heygen.com: escribe la narración en el guion y pulsa reproducir (voz → audio.mp3)
  mureka.js           en www.mureka.ai: escribe el prompt de música, genera, Library → play (música → musica.mp3)
docs/                 REQUIREMENTS, FLOW_DOM_FINDINGS, ARCHITECTURE, BUG_HISTORY, TODO, PROMPT_KIT_FORMAT
tests/shared.test.js  tests de la lógica pura (node:test, sin dependencias)
tests/e2e/            Chromium real + extensión + Flow SIMULADO (mock-flow.html); npm run e2e
tools/flow-diagnostic.js  diagnóstico de solo lectura para pegar en la consola de Flow
examples/sample-kit.txt   kit de ejemplo con el formato real (incluye ``` y encabezados)
```

## Comandos
- `npm run verify` → `node --check` de todo + ids del panel + tests (hazlo siempre antes de dar algo por terminado).
- `npm run e2e:bg` → lo mismo con Flow en pestañas de fondo DE VERDAD. Playwright (run-e2e) hace que Chrome trate todas las
  pestañas como visibles: para cualquier cosa de segundo plano usa run-bg.js.
- `npm run e2e` → prueba de extremo a extremo contra Flow simulado (usa el Chromium de Playwright y xvfb-run). Si cambias
  `content.js`/`background.js`, pásala. Recuerda: el simulador solo imita lo verificado; no prueba Flow real.
- `npm run zip` → genera `flow-batch-extension.zip` (solo la carpeta `extension/`).
- Cargar en Chrome: `chrome://extensions` → Modo de desarrollador → "Cargar descomprimida" → carpeta `extension/`.
  Tras cualquier cambio: botón ⟳ de la extensión **y F5 en las pestañas de Flow** (si no, siguen con el código viejo).

## Antes de cada lote (requisitos del entorno del usuario)
- Flow → Ajustes ⚙ → "Configuración del agente": **Confirmar antes de generar = Siempre**; vídeo = **Omni 1.1 Flash**;
  aspect ratio 9:16 y cantidad x1 en imagen y vídeo.
- Destino **"Carpeta elegida"** (panel → Salida → Elegir → Escritorio): no necesita tocar "Preguntar dónde guardar" (el usuario
  lo quiere activado). Con el destino "Descargas de Chrome" sí habría que desactivarlo.
- Cada cuenta en un proyecto nuevo y en su propia ventana visible.

## Al terminar cada tarea
1. `npm run verify`. 2. Actualiza `docs/BUG_HISTORY.md` (qué cambió, cómo se verificó o "SIN VERIFICAR") y `docs/TODO.md`.
3. Dile al usuario exactamente qué debe probar y qué mensaje/captura te debe traer si falla.
