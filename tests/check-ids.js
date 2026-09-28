// Comprueba que cada $("id") de sidepanel.js existe en sidepanel.html (bug #2
// del historial: se perdió un id al editar el HTML y el popup dejó de funcionar).
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "extension");
const html = fs.readFileSync(path.join(dir, "sidepanel.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "sidepanel.js"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = [...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
const dyn = [...js.matchAll(/\$\(`([^`]+)`\)/g)].map((m) => m[1]);
const missing = [...new Set(used)].filter((id) => !ids.has(id));
for (const tpl of dyn) {
  // plantillas tipo `tab-${t}` / `acc${k}_state`: se prueban con los valores reales
  const vals = { t: ["lote", "progreso", "log"], k: ["A", "B"] };
  const m = tpl.match(/\$\{(\w+)\}/);
  if (m && vals[m[1]]) for (const v of vals[m[1]]) { const id = tpl.replace(m[0], v); if (!ids.has(id)) missing.push(id); }
}
if (missing.length) { console.error("Faltan en sidepanel.html los ids:", missing.join(", ")); process.exit(1); }
console.log(`ids OK (${new Set(used).size} usados)`);
