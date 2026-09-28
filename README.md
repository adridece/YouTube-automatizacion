# Flow Batch Runner

Extensión de Chrome para producir Shorts en lote con **Google Flow**: pegas el kit (prompts de imagen + de animación),
y genera las imágenes, anima cada una con su imagen de referencia y descarga los vídeos numerados. Pensada para el canal
MUNDO FUT (sirve igual para The Odd Ledger). **Contexto completo del proyecto: [`CLAUDE.md`](CLAUDE.md) y [`docs/`](docs/).**

## Instalar en Chrome
1. `chrome://extensions` → activa **Modo de desarrollador** → **Cargar descomprimida** → elige la carpeta **`extension/`**.
2. Tras cualquier cambio de código: botón ⟳ de la extensión **y F5 en las pestañas de Flow**.

## Antes de cada lote (10 segundos)
- **Flow** → Ajustes ⚙ → "Configuración del agente": *Confirmar antes de generar* = **Siempre**; vídeo = **Omni 1.1 Flash**; 9:16 y x1.
- **Chrome** → `chrome://settings/downloads`: **desactiva "Preguntar dónde guardar cada archivo"**. Si quieres los vídeos en el Escritorio,
  pon ahí el Escritorio como carpeta de descargas (los archivos caen en `MundoFutFlow/`).
- Deja abiertas las dos pestañas de Flow (`/u/2/` y `/u/3/`), cada una con su cuenta, preferiblemente en una **ventana propia**.

## Uso
Popup de la extensión → pega el kit completo → rango de escenas de cada cuenta → **Plan multi-cuenta → Ejecutar**.
Cada vídeo debe costar **10 puntos**; si Flow pide más, la extensión lo rechaza y te lo dice.

## Desarrollo
```bash
npm run verify     # node --check de todo + tests (lógica pura)
npm run zip        # genera flow-batch-extension.zip con solo extension/
```
Sin dependencias ni paso de build. `tools/flow-diagnostic.js` es un script de solo lectura para pegar en la consola de Flow y
compartir el estado del DOM cuando algo falle.

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
