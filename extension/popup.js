// Nota: pad3, stripMarker, splitCombinedPrompts, parseRange y
// buildAgentInstruction vienen de shared.js (cargado antes que este archivo).

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function updateMaxWaitLabel() {
  const mode = document.getElementById("genMode").value;
  const label = document.getElementById("maxWaitLabel");
  label.textContent =
    mode === "imagesOnly"
      ? "Espera máxima para que el Agent termine TODO el lote (segundos) — con varias imágenes, prueba con 600-900"
      : "Espera máxima por generación individual — imagen o vídeo (segundos)";
}
document.getElementById("genMode").addEventListener("change", () => { updateMaxWaitLabel(); updatePreview(); });
updateMaxWaitLabel();

function updatePreview() {
  const raw = document.getElementById("prompts").value;
  const rangeStr = document.getElementById("sceneRange").value;
  const { images, animations } = splitCombinedPrompts(raw);
  const range = parseRange(rangeStr);

  if (images.size === 0 && animations.size === 0) {
    document.getElementById("preview").textContent = "";
    return;
  }

  const inRangeImgs = range.filter((n) => images.has(n));
  const inRangeAnims = range.filter((n) => animations.has(n));

  let text = `Detectado: ${images.size} prompt(s) de imagen`;
  if (animations.size) text += ` + ${animations.size} de animación`;
  text += `.\nEste perfil procesará las escenas: ${range.join(", ") || "(ninguna — revisa el rango)"}`;
  text += ` → ${inRangeImgs.length} imagen(es)`;
  if (animations.size) text += `, ${inRangeAnims.length} animación(es) emparejada(s)`;
  if (range.some((n) => !images.has(n))) {
    text += `\n⚠️ Algunas escenas del rango no tienen prompt de imagen — revisa los números.`;
  }
  document.getElementById("preview").textContent = text;
}
document.getElementById("prompts").addEventListener("input", updatePreview);
document.getElementById("sceneRange").addEventListener("input", updatePreview);

async function getActiveFlowTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const isFlow = tab && tab.url && (tab.url.includes("flow.google.com") || tab.url.includes("labs.google/fx/tools/flow"));
  if (!isFlow) {
    throw new Error(
      "La pestaña activa no parece ser Google Flow. Abre flow.google.com, colócate ahí y vuelve a pulsar Iniciar."
    );
  }
  return tab;
}

function readFormAsConfig() {
  return {
    genMode: document.getElementById("genMode").value,
    resolution: document.getElementById("resolution").value,
    promptsRaw: document.getElementById("prompts").value,
    prefix: document.getElementById("prefix").value.trim() || "clip",
    sceneRange: document.getElementById("sceneRange").value.trim() || "1-8",
    maxWaitMs: (parseInt(document.getElementById("maxWait").value, 10) || 240) * 1000,
  };
}

function buildRunMessage(cfg) {
  const { images, animations } = splitCombinedPrompts(cfg.promptsRaw);
  const sceneNumbers = parseRange(cfg.sceneRange);

  return {
    type: "START_RUN",
    genMode: cfg.genMode,
    images: Object.fromEntries(images),
    animations: Object.fromEntries(animations),
    sceneNumbers,
    prefix: cfg.prefix,
    resolution: cfg.resolution,
    maxWaitMs: cfg.maxWaitMs,
  };
}

document.getElementById("start").addEventListener("click", async () => {
  const cfg = readFormAsConfig();
  const msg = buildRunMessage(cfg);

  if (msg.sceneNumbers.length === 0) {
    setStatus('No he podido interpretar el rango de escenas (ej. "1-5").');
    return;
  }
  if (Object.keys(msg.images).length === 0) {
    setStatus("No he encontrado ningún prompt de imagen en el texto pegado.");
    return;
  }

  try {
    const tab = await getActiveFlowTab();
    setStatus(`Enviando ${msg.sceneNumbers.length} escena(s) (${msg.genMode}) a la pestaña de Flow...`);
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    if (String(e.message || e).includes("Receiving end does not exist")) {
      setStatus(
        "No he podido comunicar con la pestaña de Flow. Esto casi siempre significa que la extensión " +
          "necesita recargarse: ve a chrome://extensions, pulsa el icono ⟳ de esta extensión, y luego " +
          "RECARGA también la pestaña de Flow (F5) antes de volver a pulsar Iniciar."
      );
    } else {
      setStatus(String(e.message || e));
    }
  }
});

document.getElementById("stop").addEventListener("click", async () => {
  try {
    const tab = await getActiveFlowTab();
    await chrome.tabs.sendMessage(tab.id, { type: "STOP_QUEUE" });
    setStatus("Deteniendo tras la generación en curso...");
  } catch (e) {
    if (String(e.message || e).includes("Receiving end does not exist")) {
      setStatus("No hay ninguna ejecución en curso en esa pestaña (o la extensión necesita recargarse).");
    } else {
      setStatus(String(e.message || e));
    }
  }
});

document.getElementById("saveAuto").addEventListener("click", async () => {
  const cfg = readFormAsConfig();
  const { images } = splitCombinedPrompts(cfg.promptsRaw);
  if (images.size === 0) {
    setStatus("No hay prompts que guardar — pega tu kit completo primero.");
    return;
  }
  let storageKey;
  try {
    const tab = await getActiveFlowTab();
    storageKey = autoRunStorageKey(tab.url);
  } catch (e) {
    setStatus(String(e.message || e));
    return;
  }
  await chrome.storage.local.set({
    [storageKey]: {
      enabled: document.getElementById("autoRun").checked,
      ...cfg,
      lastRunAt: null,
    },
  });
  setStatus(
    document.getElementById("autoRun").checked
      ? `Guardado para la cuenta "${storageKey}". Ejecutará las escenas "${cfg.sceneRange}" automáticamente la próxima vez que abras Flow en ESA pestaña/cuenta, sin tocar nada más.`
      : `Guardado para "${storageKey}", pero el auto-inicio está desmarcado — se comportará como el botón Iniciar normal.`
  );
});

document.getElementById("resetAuto").addEventListener("click", async () => {
  let storageKey;
  try {
    const tab = await getActiveFlowTab();
    storageKey = autoRunStorageKey(tab.url);
  } catch (e) {
    setStatus(String(e.message || e));
    return;
  }
  const data = await chrome.storage.local.get(storageKey);
  if (!data[storageKey]) {
    setStatus(`No hay ninguna configuración de auto-inicio guardada para "${storageKey}" todavía.`);
    return;
  }
  data[storageKey].lastRunAt = null;
  await chrome.storage.local.set({ [storageKey]: data[storageKey] });
  setStatus(`Listo — la próxima vez que abras Flow en la cuenta "${storageKey}", se volverá a ejecutar el lote guardado.`);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "QUEUE_PROGRESS") setStatus(msg.text);
  if (msg.type === "PLAN_STATUS") setStatus("[PLAN] " + msg.text);
});

function buildPlanStep(accountNum, rangeStr, resolution, baseCfg) {
  const { images, animations } = splitCombinedPrompts(baseCfg.promptsRaw);
  const sceneNumbers = parseRange(rangeStr);
  return {
    accountKey: `u${accountNum}`,
    runMessage: {
      genMode: baseCfg.genMode,
      images: Object.fromEntries(images),
      animations: Object.fromEntries(animations),
      sceneNumbers,
      prefix: baseCfg.prefix,
      resolution,
      maxWaitMs: baseCfg.maxWaitMs,
    },
  };
}

document.getElementById("runPlan").addEventListener("click", () => {
  const baseCfg = readFormAsConfig();
  const accountA = document.getElementById("planAccountA").value.trim();
  const accountB = document.getElementById("planAccountB").value.trim();
  const rangeA = document.getElementById("planRangeA").value.trim();
  const rangeB = document.getElementById("planRangeB").value.trim();
  const resA = document.getElementById("planResA").value;
  const resB = document.getElementById("planResB").value;

  if (!accountA || !accountB) {
    setStatus("Indica el número de cuenta de ambas pestañas (lo que va después de /u/ en la URL).");
    return;
  }

  const stepA = buildPlanStep(accountA, rangeA, resA, baseCfg);
  const stepB = buildPlanStep(accountB, rangeB, resB, baseCfg);

  if (stepA.runMessage.sceneNumbers.length === 0 && stepB.runMessage.sceneNumbers.length === 0) {
    setStatus("Ninguno de los dos rangos tiene escenas válidas — revisa los rangos.");
    return;
  }

  setStatus(`Lanzando plan: cuenta u${accountA} (${rangeA}) → cuenta u${accountB} (${rangeB})...`);
  chrome.runtime.sendMessage({ type: "RUN_PLAN", steps: [stepA, stepB] });
});

document.getElementById("stopPlan").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_PLAN" });
  setStatus("Deteniendo el plan...");
});

// Pre-rellena el formulario con lo último guardado para la cuenta de la
// pestaña activa (u2, u3...), no un único valor compartido para todo el perfil.
(async () => {
  let storageKey;
  try {
    const tab = await getActiveFlowTab();
    storageKey = autoRunStorageKey(tab.url);
  } catch (e) {
    return; // la pestaña activa no es Flow; no hay nada que precargar
  }
  const data = await chrome.storage.local.get(storageKey);
  const c = data[storageKey];
  if (!c) return;
  document.getElementById("genMode").value = c.genMode || "paired";
  document.getElementById("resolution").value = c.resolution || "1080p";
  document.getElementById("prompts").value = c.promptsRaw || "";
  document.getElementById("prefix").value = c.prefix || "mundofut";
  document.getElementById("sceneRange").value = c.sceneRange || "1-8";
  document.getElementById("maxWait").value = Math.round((c.maxWaitMs || 240000) / 1000);
  document.getElementById("autoRun").checked = !!c.enabled;
  updateMaxWaitLabel();
  updatePreview();
})();
