# Requisitos — el proceso tal como lo quiere el usuario

Todo lo de aquí lo dijo el usuario explícitamente durante el desarrollo. Si un cambio contradice algo de esta
lista, para y pregúntale.

## Objetivo
Pasarle a la herramienta el kit de un Short y recibir **todos los vídeos numerados en orden**, listos para
montarlos él en CapCut, **sin tocar nada** y **sin tener que mirar la pantalla** (mientras tanto usa el navegador
para otras cosas). El audio/voz queda fuera del alcance de la extensión (se genera aparte).

## Entrada
- Un único bloque de texto pegado: primero los prompts de imagen `[001]…[00N]`, luego los de animación
  `[001]…[00N]` (mismo número = misma escena). Formato exacto y tolerancias en `PROMPT_KIT_FORMAT.md`.
- Por cuenta: rango de escenas (`1-5`), resolución de descarga y prefijo de archivo.
- Cada clip dura **6 segundos** (antes eran 5). Un Short típico = 8 escenas.

## Cuentas
- Dos cuentas de Google en **dos pestañas del mismo perfil de Chrome**: `flow.google.com/u/2/…` (cuenta Pro,
  descarga a **1080p**) y `flow.google.com/u/3/…` (la otra, **720p** o lo máximo que permita).
- Cada cuenta tiene ~50 puntos de vídeo al día → 5 vídeos de 10 puntos. Reparto típico: escenas 1-5 en una, 6-8 en otra.
- Cambiar de una pestaña a otra debe ser automático (cambiar de pestaña sí es posible; cambiar de sesión de
  Google no, por eso las dos sesiones ya deben estar abiertas).

## Proceso por cuenta
1. **Imágenes (Fase 1)**: una sola instrucción al Agent de Flow con todas las imágenes del rango; el Agent genera
   **exactamente una imagen por prompt** y las renombra con su identificador (`001`, `002`…).
   **No se descargan las imágenes** — solo sirven de referencia para animar.
2. **Animaciones (Fase 2A)**, **una a una y en orden**: adjuntar al chat de Flow la imagen correspondiente
   (botón "+", elegir la imagen por su nombre, "Añadir a petición" — sin descargarla), escribir el prompt de animación
   de esa escena, generar, esperar a que termine (la IA tarda; a veces hay cola por demanda) y pasar a la siguiente.
3. **Descarga**: los vídeos **de uno en uno** (esperando a que cada uno termine), **bien nombrados**, sin diálogos de "guardar
   como", en la resolución de esa cuenta. **Desde v2.7 (petición del usuario tras la prueba v2.6)**: cada vídeo se descarga
   **nada más generarse**, con su nombre puesto por la extensión, porque el Agent no renombra bien los vídeos y al final no se
   sabía cuál era cuál. La "Fase 2B" final solo recoge lo que no se pudo descargar en su momento.
4. **Autosuficiente (v2.7)**: el usuario no quiere resolver fallos a mano. Todo fallo que no cuesta puntos se reintenta solo
   (segunda vuelta al final; F5 automático si es técnico); lo único que no se repite solo es un vídeo con el coste ya aprobado.
   - Nombre: le valen `mundofut_001.mp4`, `vid1.mp4` o `001.mp4` (elegible en el panel; por defecto el primero).
   - Todos los vídeos de un lote en una **carpeta NUEVA** `<fecha>_<hora>_<prefijo>/`, la misma para las dos cuentas.
   - Los quiere en el **Escritorio** y quiere **mantener activado** "Preguntar dónde guardar" de Chrome (28 sep 2026). Solución:
     destino "Carpeta elegida" (elige el Escritorio una vez).

## Coste (importante, lo repitió varias veces)
- Cada vídeo debe costar **como máximo 10 puntos**. Si Flow pide más, **no se aprueba**: se rechaza y se avisa.
- Se consigue con el modelo "Omni 1.1 Flash" + duración de 6 s en el prompt (ver `FLOW_DOM_FINDINGS.md`).

## Fallos
- Si una imagen o un vídeo falla (p. ej. política de contenido) debe **reintentarse adaptando el prompt**, y el
  sistema debe **saber y contar qué número de escena falló**. Al final, resumen con los números que siguen
  fallando para que él los arregle a mano.
- Un fallo puntual **no debe parar** el resto de escenas ni la otra cuenta.

## Ejecución
- Todo automático. Corre en segundo plano; el usuario no quiere vigilarlo. Los errores/avances deben poder leerse
  después (no mensajes que desaparecen) y debe avisar al terminar o al fallar.
- Log legible con hora, cuenta, nº de escena y fase; botón "Copiar log" para pegárselo a Claude.
- Las dos cuentas pueden ir **a la vez** (por defecto) o una tras otra.
- Interfaz oscura y actual, en español, usable con teclado, que no se cierre sola (panel lateral) y que en la página de Flow
  no tape nada (panel plegable).
- Puede haber esperas largas (la IA "piensa", los vídeos se ponen en cola): esperar sin volver a pulsar "generar".

## Cosas que el usuario NO quiere
- Descargar las imágenes (en el modo principal).
- Que se le pida elegir un nombre de archivo al descargar.
- Que la extensión le robe el foco del navegador mientras trabaja en otra cosa.
- Tener que recortar/preparar a mano una lista distinta para cada cuenta (pega el kit completo en todas).
