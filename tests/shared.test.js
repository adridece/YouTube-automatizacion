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
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/"), "u0");
  assert.strictEqual(S.getFlowAccountKey("https://flow.google.com/project/abc"), "u0");
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

// ---------------------------------------------------------------- v2
test("buildVideoFilename: los tres formatos aceptados", () => {
  assert.strictEqual(S.buildVideoFilename("prefijo", "mundofut", 1), "mundofut_001.mp4");
  assert.strictEqual(S.buildVideoFilename("vid", "mundofut", 1), "vid1.mp4");
  assert.strictEqual(S.buildVideoFilename("vid", "x", 12), "vid12.mp4");
  assert.strictEqual(S.buildVideoFilename("num", "x", 7), "007.mp4");
  assert.strictEqual(S.buildVideoFilename(undefined, "", 3), "clip_003.mp4");
  assert.strictEqual(S.buildVideoFilename("prefijo", "a/b:c*", 2, "png"), "abc_002.png");
});

test("sanitizeName: quita caracteres prohibidos en Windows", () => {
  assert.strictEqual(S.sanitizeName('Mundo Fut: "Messi"?'), "Mundo_Fut_Messi");
  assert.strictEqual(S.sanitizeName("   ", "x"), "x");
  assert.strictEqual(S.sanitizeName("fin..."), "fin");
});

test("buildBatchFolderName: carpeta nueva por lote con fecha y hora local", () => {
  assert.strictEqual(S.buildBatchFolderName(new Date(2026, 8, 28, 9, 5), "mundofut"), "2026-09-28_0905_mundofut");
  assert.strictEqual(S.buildBatchFolderName(new Date(2026, 0, 2, 23, 59), ""), "2026-01-02_2359_lote");
});

test("downloadNameMatches: acepta el sufijo (1) de Chrome y rutas de Windows", () => {
  assert.ok(S.downloadNameMatches("C:\\Users\\a\\Downloads\\MundoFutFlow\\x\\mundofut_001.mp4", "mundofut_001.mp4"));
  assert.ok(S.downloadNameMatches("/home/a/MundoFutFlow/mundofut_001 (1).mp4", "mundofut_001.mp4"));
  assert.ok(!S.downloadNameMatches("/home/a/caricature_footballer.mp4", "mundofut_001.mp4"));
  assert.ok(!S.downloadNameMatches("", "mundofut_001.mp4"));
});

test("isFlowDownloadCandidate / urlKind", () => {
  assert.ok(S.isFlowDownloadCandidate({ url: "blob:https://flow.google.com/1234-abcd" }));
  assert.ok(S.isFlowDownloadCandidate({ url: "https://storage.googleapis.com/x/video.mp4" }));
  assert.ok(S.isFlowDownloadCandidate({ url: "https://lh3.googleusercontent.com/abc" }));
  assert.ok(S.isFlowDownloadCandidate({ url: "https://cdn.example.com/v.mp4", referrer: "https://flow.google.com/u/2/project/x" }));
  assert.ok(!S.isFlowDownloadCandidate({ url: "https://example.com/file.zip", referrer: "https://example.com/" }));
  assert.strictEqual(S.urlKind("blob:https://flow.google.com/x"), "blob");
  assert.strictEqual(S.urlKind("https://a/b"), "https");
  assert.strictEqual(S.urlKind("data:video/mp4;base64,AA"), "data");
});

test("parseAssetItemText / findAssetMatches: '001Imagen' exacto, nunca un vídeo ni '0010'", () => {
  assert.deepStrictEqual({ ...S.parseAssetItemText("001Imagen") }, { name: "001", kind: "image" });
  assert.deepStrictEqual({ ...S.parseAssetItemText(" 001 Vídeo ") }, { name: "001", kind: "video" });
  assert.deepStrictEqual({ ...S.parseAssetItemText("raro") }, { name: "raro", kind: null });
  const texts = ["001Vídeo", "0010Imagen", "002Imagen", "001Imagen", "001Imagen"];
  assert.deepStrictEqual(Array.from(S.findAssetMatches(texts, "001")), [3, 4]);
  assert.deepStrictEqual(Array.from(S.findAssetMatches(texts, "003")), []);
});

test("diffNewKeys / pickNewVideoKey: el vídeo nuevo se elige por diferencia, no por posición", () => {
  assert.deepStrictEqual(Array.from(S.diffNewKeys(["a", "b"], ["c", "a", "b"])), ["c"]);
  assert.deepStrictEqual({ ...S.pickNewVideoKey(["c"], []) }, { key: "c", ambiguous: false });
  assert.deepStrictEqual({ ...S.pickNewVideoKey(["c", "d"], ["c"]) }, { key: "d", ambiguous: false });
  assert.deepStrictEqual({ ...S.pickNewVideoKey(["c", "d"], []) }, { key: "c", ambiguous: true });
  assert.deepStrictEqual({ ...S.pickNewVideoKey([], []) }, { key: null, ambiguous: false });
});

test("detectNewSignals: solo cuentan los mensajes NUEVOS del Agent", () => {
  const before = "Hola. Estás preguntando demasiado rápido. Ve más despacio e inténtalo de nuevo.";
  const after1 = before + " ¿Quieres que empiece a generar 1 vídeo, que cuesta 10 puntos?";
  assert.strictEqual(S.detectNewSignals(before, after1).rateLimit, 0);
  const after2 = before + " Estás preguntando demasiado rápido. Ve más despacio.";
  assert.strictEqual(S.detectNewSignals(before, after2).rateLimit, 1);
  const pol = "[002]: Esta generación fue bloqueada por nuestras políticas de seguridad";
  assert.strictEqual(S.detectNewSignals("", pol).policy, 1);
  assert.strictEqual(S.detectNewSignals("", "Error No se ha podido generar esta imagen. No se te ha cobrado").genError, 1);
  assert.strictEqual(S.detectNewSignals("", "He cancelado la generación del vídeo").cancelled, 1);
  assert.strictEqual(S.detectNewSignals("", "No tienes suficientes créditos para continuar").noPoints, 1);
  assert.strictEqual(S.detectNewSignals("", "cuesta 10 puntos").noPoints, 0);
});

test("backoffDelayMs: 30 s, 60 s, 120 s… con tope", () => {
  assert.strictEqual(S.backoffDelayMs(1), 30000);
  assert.strictEqual(S.backoffDelayMs(2), 60000);
  assert.strictEqual(S.backoffDelayMs(3), 120000);
  assert.strictEqual(S.backoffDelayMs(10), 300000);
  assert.strictEqual(S.backoffDelayMs(2, 1000, 5000), 2000);
});

test("estado del lote: crear, avanzar, resumir", () => {
  const st = S.createBatchState({ batchId: "b1", accountKey: "u2", sceneNumbers: [1, 2], config: {}, now: 1 });
  assert.strictEqual(st.scenes[1].video, "pending");
  S.setSceneStep(st, 1, "image", "done");
  S.setSceneStep(st, 1, "video", "done", { videoKey: "k1" });
  S.setSceneStep(st, 1, "download", "done", { file: "x/mundofut_001.mp4" });
  S.setSceneStep(st, 2, "image", "done");
  S.setSceneStep(st, 2, "video", "failed", { error: "bloqueado" });
  S.setSceneStep(st, 2, "download", "skipped");
  const sum = S.summarizeBatch(st);
  assert.strictEqual(sum.total, 6);
  assert.strictEqual(sum.finished, 6);
  assert.strictEqual(sum.percent, 100);
  assert.deepStrictEqual(Array.from(sum.done), [1]);
  assert.deepStrictEqual(Array.from(sum.failed), [2]);
  assert.strictEqual(st.scenes[1].videoKey, "k1");
});

test("prepareResume: nunca repite un vídeo cuyo coste ya se aprobó", () => {
  const st = S.createBatchState({ batchId: "b", accountKey: "u3", sceneNumbers: [1, 2, 3], config: {} });
  S.setSceneStep(st, 1, "video", "running", { videoApproved: true });
  S.setSceneStep(st, 2, "video", "running", { videoApproved: false });
  S.setSceneStep(st, 3, "download", "running");
  st.status = "stopped";
  S.prepareResume(st);
  assert.strictEqual(st.scenes[1].video, "review");
  assert.ok(st.scenes[1].error.includes("no lo repito"));
  assert.strictEqual(st.scenes[2].video, "pending");
  assert.strictEqual(st.scenes[3].download, "pending");
  assert.strictEqual(st.status, "running");
});

test("formatLogEntry / logToText / appendCapped", () => {
  const t = new Date(2026, 8, 28, 8, 43, 55).getTime();
  const line = S.formatLogEntry({ t, acc: "u2", scene: 3, phase: "videos", level: "error", msg: "falló" });
  assert.strictEqual(line, "08:43:55 [u2] [E003] [Vídeo] ERROR: falló");
  assert.strictEqual(S.formatLogEntry({ t, level: "info", msg: "hola" }), "08:43:55 INFO: hola");
  assert.ok(S.logToText([{ t, level: "ok", msg: "a" }], "CAB").startsWith("CAB\n08:43:55 OK: a"));
  assert.deepStrictEqual(Array.from(S.appendCapped([1, 2, 3], [4, 5], 3)), [3, 4, 5]);
});

test("resolutionFallbacks", () => {
  assert.deepStrictEqual(Array.from(S.resolutionFallbacks("1080p", "video")), ["1080p", "720p"]);
  assert.deepStrictEqual(Array.from(S.resolutionFallbacks("720p", "video")), ["720p", "1080p"]);
  assert.deepStrictEqual(Array.from(S.resolutionFallbacks("1080p", "image")), ["1K", "2K"]);
});

test("buildVideoTileName / tileLooksInProgress (v2.2)", () => {
  assert.strictEqual(S.buildVideoTileName("mundofifa", 1, "2026-09-28_1259_mundofifa"), "mundofifa_001_1259");
  assert.strictEqual(S.buildVideoTileName("x y", 12, ""), "x_y_012");
  assert.ok(S.tileLooksInProgress("100%"));
  assert.ok(S.tileLooksInProgress("Generando… 57 %"));
  assert.ok(!S.tileLooksInProgress("mundofifa_001_1259"));
  assert.ok(!S.tileLooksInProgress(""));
});

test("buildSoftenNote: cada intento suaviza más sin cambiar la escena", () => {
  assert.strictEqual(S.buildSoftenNote("video", 1), "");
  assert.ok(S.buildSoftenNote("video", 2).includes("un poco más suave"));
  assert.ok(S.buildSoftenNote("video", 2).includes("6 seconds"));
  const n4 = S.buildSoftenNote("image", 4);
  assert.ok(n4.startsWith("(Intento 4"));
  assert.ok(n4.includes("misma escena"));
});

test("imageTitleMatches: variantes del nombre que pone el Agent", () => {
  for (const t of ["006", "[006]", "006.png", "Imagen 006", "img_006", "6", " 006 "]) assert.ok(S.imageTitleMatches(t, "006"), t);
  for (const t of ["0060", "016", "007", "caricature footballer", "", "Imagen 007"]) assert.ok(!S.imageTitleMatches(t, "006"), t);
});

test("buildDurationNote: remarca los 6 segundos", () => {
  assert.ok(S.buildDurationNote(6).includes("EXACTAMENTE 6 segundos"));
  assert.ok(S.buildDurationNote(6).includes("Duration: 6 seconds"));
  assert.ok(S.buildDurationNote(6, true).includes("ni uno más"));
});
