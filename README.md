# Cerezium Autopilot 🍒

*(antes "Flow Batch Runner")* — Shorts en piloto automático para Google Flow.

Extensión de Chrome para producir Shorts en lote con **Google Flow**: pegas el kit (prompts de imagen + de animación),
y genera las imágenes, anima cada una con su imagen de referencia y descarga los vídeos numerados. Pensada para el canal
MUNDO FUT (sirve igual para The Odd Ledger). **Contexto completo del proyecto: [`CLAUDE.md`](CLAUDE.md) y [`docs/`](docs/).**

## Instalar en Chrome
1. `chrome://extensions` → activa **Modo de desarrollador** → **Cargar descomprimida** → elige la carpeta **`extension/`**.
2. Tras cualquier cambio de código: botón ⟳ de la extensión **y F5 en las pestañas de Flow**.
3. Pulsa el icono de la extensión (la cereza): se abre el **panel lateral** o, si tu navegador no lo tiene, la **ventanita** de
   extensión. Se elige en Opciones avanzadas; el botón ↗ la abre en una ventana flotante pequeña para verla junto a Flow.
4. Al actualizar a la 2.1, Chrome pide aceptar un permiso nuevo ("cambiar la configuración de los sitios"): es para permitir las
   descargas automáticas de flow.google.com, sin eso Chrome retiene el 2.º vídeo y siguientes cuando Flow está en segundo plano.

**Segundo plano**: puedes seguir usando otras pestañas; la extensión nunca te cambia a Flow, impide que Chrome descarte esas
pestañas y que el ordenador se duerma mientras trabaja. Solo no cierres ni recargues las pestañas de Flow.

## Antes de cada lote (lo repite el checklist del panel)
- **Flow** → Ajustes ⚙ → "Configuración del agente": *Confirmar antes de generar* = **Siempre**; vídeo = **Omni 1.1 Flash**; 9:16 y x1.
- Un **proyecto nuevo** en cada cuenta (`/u/2/`, `/u/3/`), con su pestaña abierta (puede estar en segundo plano).
- **Destino "Carpeta elegida"** (recomendado): en el panel → Salida → **Elegir** → el Escritorio (o una carpeta dentro). Funciona
  **aunque tengas activado** "Preguntar dónde guardar cada archivo". Tras reiniciar Chrome, al pulsar "Iniciar lote" Chrome
  puede preguntar una vez si permites el acceso a esa carpeta.
- Destino "Descargas de Chrome": los vídeos van a `Descargas/MundoFutFlow/<lote>/`; con "Preguntar dónde guardar" activado Chrome
  preguntará en cada vídeo.

## Uso
Panel → **Lote**: pega el kit completo → cuentas y rangos (A: `2` · `1-5` · 1080p; B: `3` · `6-8` · 720p) → nombre de archivo →
**Iniciar lote**. La pestaña **Progreso** muestra cada escena (imagen · vídeo · descarga) y **Log** todo lo que pasa, con
**Copiar log**. En la página de Flow hay una píldora plegable abajo a la izquierda (se puede mover de esquina).
Cada vídeo debe costar **10 puntos**; si Flow pide más, la extensión pulsa "Rechazar", deja de generar en esa cuenta y te lo dice.

## Primera prueba de la v2 (en este orden; las dos primeras cuestan 0 puntos)
1. Recarga la extensión (⟳) y pulsa F5 en tus pestañas de Flow. Abre el panel lateral (icono de la extensión).
2. Salida → **Elegir** → Escritorio (o crea `Escritorio/MundoFut`). Debe poner "· con permiso".
3. **Prueba A — descarga (0 puntos)**: en un proyecto con vídeos ya generados. Opciones avanzadas → "PRUEBA de descarga", una sola
   cuenta, rango `1-2`, **Iniciar lote**. Esperado: carpeta nueva `Escritorio/<fecha>_<hora>_mundofut/` con `mundofut_001.mp4` y
   `mundofut_002.mp4`, **sin ningún diálogo** aunque tengas activado "Preguntar dónde guardar".
4. **Prueba B — ensayo (0 puntos)**: en un proyecto con imágenes llamadas `001`, `002`. Opciones avanzadas → "ENSAYO sin gastar",
   rango `1-2`, kit completo pegado. Esperado: adjunta cada imagen con el "+", escribe su prompt, pulsa generar, sale el aviso de
   coste **y la extensión pulsa "Rechazar"**. El log dice "ENSAYO: … 10 puntos … 0 puntos gastados".
5. **Prueba C — real (10 puntos)**: modo normal, proyecto nuevo, kit de 1 escena (o rango `1-1`), una cuenta.
6. Luego el lote completo con las dos cuentas.
7. Si algo falla: pestaña **Log → Copiar log** y pégamelo entero; si es algo de la página, ejecuta `tools/flow-diagnostic.js`
   en la consola de Flow (mejor con el menú "+" abierto) y pégame también el resultado.

## Desarrollo
```bash
npm run verify     # sintaxis de todo + ids del panel + tests (lógica pura)
npm run e2e        # Chromium real + extensión + Flow SIMULADO (tests/e2e/), capturas en tests/e2e/.out/
npm run e2e:bg     # lo mismo con Flow en pestañas de FONDO de verdad (sin Playwright enganchado)
npm run zip        # genera flow-batch-extension.zip con solo extension/
```
Sin dependencias ni paso de build (el e2e usa el Playwright/Chromium preinstalado del entorno de Claude Code).
`tools/flow-diagnostic.js` es un script de solo lectura para pegar en la consola de Flow y compartir el estado del DOM.

## Seguir desarrollando con Claude Code en la nube
1. Crea un repositorio **vacío** (mejor privado) en GitHub.
2. Descomprime este zip: ya trae git con un primer commit. En esa carpeta:
   ```bash
   git remote add origin https://github.com/<tu-usuario>/<tu-repo>.git
   git push -u origin main
   ```
3. Entra en **claude.ai/code**, conecta tu cuenta de GitHub y elige el repo. Cada sesión en la nube clona **lo que hayas subido**
   (no tu carpeta local) en una máquina virtual nueva, y lee `CLAUDE.md` automáticamente.
4. Primer mensaje sugerido:
   > Lee CLAUDE.md y todo docs/. Empieza por TODO P0-2 (registro persistente y legible) y P0-4 (límite de ritmo de Flow).
   > Recuerda que no puedes ver mi navegador: dime exactamente qué probar y qué capturas o salida de tools/flow-diagnostic.js necesitas.
5. Claude subirá los cambios a una rama (puede abrir un pull request). Tú haces `git pull`, recargas la extensión (⟳ + F5), pruebas
   y le pegas lo que pase — con el mismo nivel de detalle que hasta ahora: es lo que más bugs ha destapado.

**Limitación a tener presente:** la sesión en la nube no puede usar tu Chrome ni tu sesión de Flow. Todo lo que dependa de la página de Flow
lo tendrás que confirmar tú (o con `tools/flow-diagnostic.js`); la lógica pura sí se comprueba sola con `npm test`.
