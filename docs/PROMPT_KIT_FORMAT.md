# Formato del kit que consume la extensión

El kit lo genera el usuario con su "Prompt maestro" de MUNDO FUT en una conversación de Claude (secciones
7.2 "todos los prompts de imagen juntos" y 7.3 "todos los prompts de animación juntos"). Lo pega tal cual
en el popup, normalmente **con los bloques de código (```) y los encabezados incluidos**.

Reglas que implementa `splitCombinedPrompts` (`extension/shared.js`):
- Cada prompt empieza por un marcador `[001]`, `[002]`… (3 dígitos).
- El primer bloque son las **imágenes**; el segundo, las **animaciones**. El límite se detecta cuando la
  numeración **vuelve a bajar** (p. ej. de `[008]` a `[001]`); no depende de títulos de sección.
- Si solo hay un bloque de numeración, todo se trata como imágenes y no hay animaciones.
- Etiqueta opcional tras el marcador que se elimina: `[001] ⭐ PORTADA — texto…`.
- Se recorta cualquier sobrante pegado tras el último prompt de cada bloque: líneas ``` y encabezados `#`.
- El texto de cada prompt llega hasta el siguiente marcador.
- La escena N une `images[N]` con `animations[N]`.

Los prompts de animación siguen el patrón del maestro: "Animate this exact reference image, …" (describen solo el
movimiento de cámara y de la escena; la imagen va adjunta como referencia). **Se les fuerza siempre `6 seconds`**
(`ensureVideoDuration`) porque de ello depende el coste.

`examples/sample-kit.txt` es un kit de ejemplo con este formato exacto; `tests/shared.test.js` lo usa.
