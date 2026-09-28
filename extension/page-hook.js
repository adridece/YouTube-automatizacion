/*
 * Se ejecuta en el MUNDO DE LA PÁGINA de Flow (manifest: "world": "MAIN").
 *
 * Muchas webs descargan así: crean un blob, lo enlazan a un <a download>,
 * hacen clic y lo liberan al instante con URL.revokeObjectURL. Si Flow lo hace,
 * cuando la extensión intercepta la descarga (para guardarla en la carpeta
 * elegida) el blob ya no existiría. Esto solo RETRASA 3 minutos la liberación
 * de las URLs blob: — no cambia nada más de la página.
 */
(() => {
  if (window.__fbrHooked) return;
  window.__fbrHooked = true;
  const original = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) {
    try {
      if (typeof url === "string" && url.startsWith("blob:")) {
        setTimeout(() => original(url), 180000);
        return;
      }
    } catch (e) {}
    return original(url);
  };
})();
