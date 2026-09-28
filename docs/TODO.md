# Pendientes (por prioridad)

## P0 — bloquea el uso real
1. **Prueba real de extremo a extremo** de la Fase 2 con la extensión (rango `1-2`, luego el lote). Nunca se ha completado una.
   Resultado esperado: 2 vídeos `<prefijo>_001.mp4` y `_002.mp4`, ningún diálogo, sin imágenes descargadas.
2. **Registro persistente y legible.** Hoy los mensajes salen en una cajita que se sobrescribe y el usuario no llega a leer
   los errores. Guardar un log (últimas N líneas con hora y nº de escena) en `chrome.storage`, mostrarlo en un panel
   desplazable en la página y en el popup, con botón "Copiar log" para pegárselo a Claude Code. Notificación del sistema al terminar/fallar.
3. **Verificar el renombrado de descargas** con "Preguntar dónde guardar" desactivado (nombre final, carpeta `MundoFutFlow/`).
   Decidir el formato del nombre (hoy `<prefijo>_<NNN>.mp4`; el usuario mencionó algo tipo `vid1`) y evitar choque
   imagen/vídeo (`.png` vs `.mp4` ya no chocan, pero conviene un sufijo claro).
4. **Límite de ritmo de Flow**: "Estás preguntando demasiado rápido…" (+ botón "Reintentar", que devuelve el mensaje a la caja).
   Detectarlo, esperar con espera creciente y reenviar; nunca contarlo como fallo de escena.
5. **Segundo plano**: comprobar que todo funciona con la pestaña no activa / ventana sin foco (Chrome limita temporizadores
   y la lista virtualizada puede no pintar en pestañas ocultas). Recomendar una ventana propia para las dos pestañas de Flow.
6. **Puntos diarios**: parar limpiamente cuando se acaben (≈5 vídeos/cuenta/día) con un mensaje claro y qué escenas quedaron sin hacer.
   Investigar cómo se muestra el saldo/agotamiento en Flow.

## P1 — mejora importante
7. **Cuentas en paralelo** (hoy A y luego B): lanzar las dos pestañas a la vez para ahorrar la mitad del tiempo (ojo con el throttling).
8. **Duplicados de nombre** (`001` dos veces tras reintentos): elegir el más reciente y verificarlo en la vista previa.
9. Reintento de vídeo: la nota "reformula…" añadida al prompt en el 2º intento no está verificada.
10. Comprobar que la resolución 1080p existe en la cuenta no-Pro (si no, caer a 720p y avisar).
11. Reanudar tras recargar la página (estado del lote persistente) — hoy un F5 pierde el progreso.

## P2 — limpieza
12. Quitar `DOWNLOAD_URL` de `background.js`; opción "max" de resolución sin uso; unificar textos del popup.
13. Tests de integración de `content.js` con DOM simulado (jsdom) — requiere separar más lógica pura de la que toca el DOM.
14. Dejar de duplicar el algoritmo de espera en tres sitios (`waitUntil` + timeouts) en una utilidad única.
