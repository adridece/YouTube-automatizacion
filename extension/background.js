importScripts("shared.js"); // trae getFlowAccountKey()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "DOWNLOAD_URL") {
    chrome.downloads.download(
      {
        url: msg.url,
        filename: `MundoFutFlow/${msg.filename}`,
        conflictAction: "uniquify",
      },
      () => sendResponse({ ok: true })
    );
    return true; // keep the message channel open for the async sendResponse
  }
});

// Cuando el content script dispara una descarga NATIVA de Flow (clic derecho
// -> Descargar, que no nos da una URL a la que llamar directamente), primero
// guarda en storage el nombre que quiere para el siguiente archivo. Chrome
// avisa justo antes de guardar cualquier descarga (onDeterminingFilename) y
// ahí le decimos que la guarde con ese nombre en vez del que puso Flow.
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  chrome.storage.local.get("pendingRenameFilename", (data) => {
    const pending = data.pendingRenameFilename;
    if (pending) {
      chrome.storage.local.remove("pendingRenameFilename");
      suggest({ filename: `MundoFutFlow/${pending}`, conflictAction: "uniquify" });
    } else {
      suggest();
    }
  });
  return true; // respuesta asíncrona
});

// ------------------------------------------------------------------
// PLAN MULTI-CUENTA: ejecuta varias tandas seguidas, cada una en la pestaña
// de Flow que corresponda a su cuenta (/u/2/, /u/3/...), cambiando de
// pestaña sola cuando una tanda termina. Esto SÍ es automatizable: no es un
// cambio de sesión de Google, es solo activar otra pestaña ya abierta y
// logueada dentro del mismo perfil de Chrome.
// ------------------------------------------------------------------
let currentPlan = null; // { steps: [...], index: 0 }
let planNotificationId = "flow-batch-plan";

function findTabForAccount(accountKey) {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "*://flow.google.com/*" }, (tabs) => {
      const found = tabs.find((t) => getFlowAccountKey(t.url) === accountKey);
      resolve(found || null);
    });
  });
}

// Muestra el estado del plan de dos formas a la vez, para que no se pierda
// aunque el popup se cierre (pasa siempre que cambiamos de pestaña/ventana):
// 1) una notificación del sistema (fuera del navegador, siempre visible)
// 2) si conocemos la pestaña relevante, también la cajita flotante en la página
function notifyPlanStatus(text, tabId) {
  chrome.runtime.sendMessage({ type: "PLAN_STATUS", text }).catch(() => {});
  chrome.notifications.create(planNotificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title: "MUNDO FUT / Flow Batch Runner",
    message: text,
    priority: 1,
  }, () => {
    if (chrome.runtime.lastError) {
      // Sin icono válido la notificación puede fallar en algunas versiones de
      // Chrome; lo registramos pero no interrumpimos el plan por esto.
      console.warn("No se pudo mostrar la notificación:", chrome.runtime.lastError.message);
    }
  });
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: "SHOW_OVERLAY", text }).catch(() => {});
  }
}

async function runPlanStep() {
  if (!currentPlan || currentPlan.index >= currentPlan.steps.length) {
    if (currentPlan) notifyPlanStatus("✅ Plan completo: todas las cuentas terminadas.");
    currentPlan = null;
    return;
  }

  const step = currentPlan.steps[currentPlan.index];
  const tab = await findTabForAccount(step.accountKey);
  if (!tab) {
    notifyPlanStatus(
      `ERROR: no encuentro ninguna pestaña abierta de Flow para la cuenta "${step.accountKey}" (busco una URL con /${step.accountKey}/). ` +
        `Abre esa pestaña y vuelve a lanzar el plan. Deteniendo el plan aquí.`
    );
    currentPlan = null;
    return;
  }

  notifyPlanStatus(
    `Paso ${currentPlan.index + 1}/${currentPlan.steps.length}: activando la pestaña de la cuenta "${step.accountKey}" (escenas ${step.runMessage.sceneNumbers.join(", ")})...`,
    tab.id
  );
  // Activamos la pestaña dentro de SU ventana, pero NO enfocamos la ventana:
  // así el usuario puede seguir trabajando en otras ventanas mientras el
  // plan corre. Recomendado: tener las pestañas de Flow en una ventana propia.
  await chrome.tabs.update(tab.id, { active: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "START_RUN", ...step.runMessage });
  } catch (e) {
    notifyPlanStatus(
      `ERROR: encontré la pestaña de la cuenta "${step.accountKey}" pero no pude comunicarme con ella. ` +
        `Recarga la extensión en chrome://extensions y recarga esa pestaña de Flow (F5). Deteniendo el plan.`,
      tab.id
    );
    currentPlan = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "RUN_COMPLETE") {
    // Solo avanza el plan si la tanda que ha terminado es la que el plan
    // estaba esperando (evita que una ejecución manual suelta en otra
    // pestaña adelante el plan por error).
    if (currentPlan && currentPlan.steps[currentPlan.index] && currentPlan.steps[currentPlan.index].accountKey === msg.accountKey) {
      currentPlan.index++;
      runPlanStep();
    }
  } else if (msg.type === "RUN_PLAN") {
    currentPlan = { steps: msg.steps, index: 0 };
    notifyPlanStatus(`Plan recibido: ${msg.steps.length} cuenta(s) en cola. Buscando la primera pestaña...`);
    runPlanStep();
  } else if (msg.type === "STOP_PLAN") {
    currentPlan = null;
    notifyPlanStatus("Plan detenido por el usuario.");
  }
});
