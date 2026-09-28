# Pendientes (por prioridad) — actualizado 28 sep 2026 (v2.6.0)

## P0 — bloquea el uso real
0000. **v2.7 en real** (lote completo): (a) cada vídeo se guarda justo después de generarse ("Guardado: …mundofut_00N.mp4") y es
      el de su escena; (b) si algo falla, "Segunda vuelta automática" / "recarga automática" en el log; (c) que NUNCA salga
      "la imagen no aparece adjunta en el panel del Agent" cuando sí se adjuntó (sería un falso negativo de la comprobación nueva).
000. **v2.6 en real**: (a) el icono abre la ventanita (no el panel lateral) y la página de Flow no cambia de tamaño; (b) si un vídeo
     pide 12 puntos, el log dice "lo he RECHAZADO… reenvío 1/3" y el reenvío sale a 10; (c) **log de la cuenta 2** cuando diga que
     faltan imágenes: la línea "Nombres de imagen que veo en el proyecto: …" dirá cómo las llamó el Agent.
00. **v2.4 en real**: "PRUEBA de envío (0 puntos)" en cada cuenta mirando OTRA pestaña → el log dice qué método funcionó
    (o por qué no). Si ninguno funciona sin foco, siguiente opción: mandar la entrada como usuario real con chrome.debugger
    (Input.insertText / Input.dispatchMouseEvent), que muestra una barra "Cerezium está depurando este navegador".
0. **v2.3 en real**: pulsar la cereza en cada pestaña de Flow → ¿aparece "lista · 2.º plano" y el icono de compartir?, ¿funciona el
   navegador del usuario con `chrome.tabCapture` (no tiene panel lateral: podría faltar también)? Luego lote mirando otra pestaña.
0b. **v2.2 en real**: (a) con el usuario en otra pestaña, ¿terminan los vídeos? (page-hook "despierto"); (b) ¿renombra el Agent
   cada vídeo como `<prefijo>_<NNN>_<HHMM>`? (el log dice "y renombrado" o "El Agent no renombró"); (c) ¿arranca la cuenta
   cuya pestaña nunca se vio?; (d) reintentos suavizados ante bloqueos.
1. **Prueba real de extremo a extremo** con la v2 (rango `1-1` en una cuenta, luego `1-2`, luego el lote). Nunca se ha completado
   una en Flow real. Pasos exactos y qué traer: README → "Primera prueba de la v2".
2. **Carpeta elegida en Chrome real**: comprobar que (a) el selector de carpetas deja elegir el Escritorio, (b) el documento
   offscreen puede escribir con el permiso concedido desde el panel, (c) qué pasa tras reiniciar Chrome (debería bastar
   un clic en "Iniciar lote" → "Permitir"). Si (b) falla, la extensión cae sola a Descargas y lo dice en el log.
3. **Cómo entrega Flow la descarga** (URL `blob:` o `https:`) y cuánto tarda 1080p: lo dice ahora el log
   ("Chrome ha registrado la descarga #N (URL tipo …, a los X s)").
4. **Identidad del tile de vídeo en Flow real** (`tileKey`): `tools/flow-diagnostic.js` → `cuadricula.primerosVideos` muestra qué
   atributos/`src` tiene. Si el `src` cambia al recargar, tras un F5 la descarga de vídeos ya generados no encontrará su tile
   (lo marca como fallo con mensaje claro).
5. **Texto real de "sin puntos"** (hoy `FLOW_SIGNALS.noPoints` es [SUPUESTO]). Cuando pase, copiar el mensaje exacto de Flow.
6. **Segundo plano de verdad**: más de 5 min con la pestaña oculta (Chrome aplica el frenado "intensivo") y si Flow pinta la lista
   del "+" en una pestaña oculta. Recomendación actual: cada cuenta en su propia ventana, visible.

## P1 — mejora importante
7. Si tras un F5 queda una escena en "revisar" y su vídeo sí apareció, ofrecer "asignar este vídeo" desde el panel.
8. Opción de pedir al Agent que renombre cada vídeo (`V001`…) para encontrarlo por nombre como las imágenes (no probado: cuesta puntos probarlo).
9. Reintento de vídeo: la nota "reformula…" añadida al prompt en el 2.º intento no está verificada en real.
10. 1080p en la cuenta no-Pro: la extensión cae sola a 720p si no existe la opción (SIN VERIFICAR en real).
11. Verificar el segundo intento de clic en "Aprobar" (`pressRow`) — solo se usa si el primero no tiene efecto.

## P2 — limpieza / calidad
12. Escenario e2e para el turno por cuenta (`CLAIM`) y para "Detener" a mitad.
13. Resumen del modo "solo imágenes" (cuenta las escenas como incompletas porque no hay vídeo).
14. `labs.google` en el manifest: comprobar si sigue haciendo falta.
