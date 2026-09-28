// Tests de la lógica pura de extension/shared.js (sin navegador).
// Ejecutar con: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// shared.js declara funciones globales (no exporta nada): se ejecuta en un
// contexto aislado y se leen las funciones de ahí.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "shared.js"), "utf8"), ctx);
const S = ctx;
const entries = (map) => Array.from(map.entries(), ([k, v]) => [k, v]); // Map de otro "realm": se reconstruye para comparar

test("splitCombinedPrompts: separa imágenes y animaciones por reinicio de numeración", () => {
  const raw = "[001] img uno\n\n[002] img dos\n\n[001] anim uno\n\n[002] anim dos";
  const { images, animations } = S.splitCombinedPrompts(raw);
  assert.deepStrictEqual(entries(images), [[1, "img uno"], [2, "img dos"]]);
  assert.deepStrictEqual(entries(animations), [[1, "anim uno"], [2, "anim dos"]]);
});

test("splitCombinedPrompts: un solo bloque -> todo son imágenes", () => {
  const { images, animations } = S.splitCombinedPrompts("[001] solo uno\n\n[002] solo dos");
  assert.strictEqual(images.size, 2);
  assert.strictEqual(animations.size, 0);
});

test("splitCombinedPrompts: quita la etiqueta '⭐ PORTADA —'", () => {
  const { images } = S.splitCombinedPrompts("[001] ⭐ PORTADA — resto del prompt");
  assert.strictEqual(images.get(1), "resto del prompt");
});

test("splitCombinedPrompts: ignora ``` y encabezados pegados alrededor", () => {
  const raw = "## IMG\n```\n[001] a\n\n[002] b\n```\n\n## ANIM\n```\n[001] c\n\n[002] d\n```\n\n## NOTAS\ntexto final";
  const { images, animations } = S.splitCombinedPrompts(raw);
  assert.strictEqual(images.get(2), "b");
  assert.strictEqual(animations.get(2), "d");
});

test("splitCombinedPrompts: el kit de ejemplo se lee entero y limpio", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "examples", "sample-kit.txt"), "utf8");
  const { images, animations } = S.splitCombinedPrompts(raw);
  assert.strictEqual(images.size, 3);
  assert.strictEqual(animations.size, 3);
  assert.ok(!images.get(3).includes("```"));
  assert.ok(!animations.get(3).includes("NOTAS"));
  assert.ok(animations.get(1).startsWith("Animate this exact reference image"));
});

test("parseRange", () => {
  assert.deepStrictEqual(Array.from(S.parseRange("1-5")), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(Array.from(S.parseRange("6,7,8")), [6, 7, 8]);
  assert.deepStrictEqual(Array.from(S.parseRange("1-3,7")), [1, 2, 3, 7]);
  assert.deepStrictEqual(Array.from(S.parseRange("5-1")), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(Array.from(S.parseRange("")), []);
  assert.deepStrictEqual(Array.from(S.parseRange("hola")), []);
});

test("getFlowAccountKey / autoRunStorageKey", () => {
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/u/2/project/abc"), "u2");
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/u/2/"), "u2");
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/u/2"), "u2");
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/u/12/project/x"), "u12");
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/u/3?x=1"), "u3");
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/"), "default");
  assert.strictEqual(S.autoRunStorageKey("https://flow.google.com/u/3/project/z"), "autoRunConfig_u3");
});

test("pad3 y buildAgentInstruction", () => {
  assert.strictEqual(S.pad3(7), "007");
  const out = S.buildAgentInstruction(new Map([[1, "uno"], [2, "dos"]]), [1, 2]);
  assert.ok(out.includes("[001] uno"));
  assert.ok(out.includes("[002] dos"));
});

test("parseCostFromText: lee el coste del aviso real de Flow", () => {
  assert.strictEqual(S.parseCostFromText("¿Quieres que empiece a generar 1 vídeo, que cuesta 10 puntos?checkAprobar"), 10);
  assert.strictEqual(S.parseCostFromText("¿Quieres que empiece a generar 1 vídeo, que cuesta 15 puntos?"), 15);
  assert.strictEqual(S.parseCostFromText("cuesta 20 créditos"), 20);
  assert.strictEqual(S.parseCostFromText("sin coste visible"), null);
  assert.strictEqual(S.parseCostFromText(""), null);
});

test("ensureVideoDuration: el coste depende de la duración del prompt (6 s = 10 puntos)", () => {
  // ya lleva 6 segundos -> no se toca
  assert.strictEqual(S.ensureVideoDuration("Animate this, 6 seconds, zoom", 6), "Animate this, 6 seconds, zoom");
  assert.strictEqual(S.ensureVideoDuration("Animate this 6-second clip", 6), "Animate this 6-second clip");
  // lleva otra duración -> se sustituye la primera aparición
  assert.strictEqual(S.ensureVideoDuration("Animate this, 5 seconds, zoom", 6), "Animate this, 6 seconds, zoom");
  // no lleva duración -> se añade al final
  assert.strictEqual(S.ensureVideoDuration("slow zoom in", 6), "slow zoom in Duration: 6 seconds.");
  assert.strictEqual(S.ensureVideoDuration("", 6), "Duration: 6 seconds.");
});
