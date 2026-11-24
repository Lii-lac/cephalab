// Settings / Data: the folder (Open + Copy log), the cached images (and Clear), Reset everything (two clicks: the first arms it for 4 s).
import { $, api, clientLog, fadeText, size } from "./dom";
import { cfg, onCfg } from "./cfg";
import { resetAll } from "../store";
import { DISPLAY_KEY } from "./display";
import { STATIC } from "../local/flag";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

export function mountData() {
  const clear = $<HTMLButtonElement>("#clearImg"), reset = $<HTMLButtonElement>("#reset"), img = $("#imgSize"), label = reset.firstElementChild as HTMLElement;
  const copyLog = $<HTMLButtonElement>("#copyLog"), copyLbl = copyLog.firstElementChild as HTMLElement;
  if (STATIC) for (const row of document.querySelectorAll<HTMLElement>("#settings [data-cat=data] [data-api]")) {   // Folder, Image cache and Reset need the companion
    (row.closest<HTMLElement>(".st-grp") ?? row).style.display = "none";
  }
  onCfg(() => {
    if (!cfg) return;
    $("#dataDir").textContent = cfg.data.folder;
    if (cfg.data.folder) $("#dataDir").dataset.tip = cfg.data.folder; else delete $("#dataDir").dataset.tip;
    img.textContent = size(cfg.data.cacheBytes);
    clear.disabled = cfg.data.cacheBytes === 0;
  });
  let copyT = 0;
  copyLog.addEventListener("click", async () => {
    clearTimeout(copyT);
    copyLog.disabled = true;
    const r = await api("GET", "/api/log");
    const ui = clientLog();
    const parts = [r.ok && r.j?.text ? String(r.j.text) : `Couldn't fetch companion log (${r.j?.error || r.status})`];
    if (ui) parts.push("\n--- Browser log ---\n" + ui);
    const ok = await copyText(parts.join("\n"));
    copyLog.disabled = false;
    fadeText(copyLbl, ok ? "Copied" : "Copy failed");
    copyT = window.setTimeout(() => fadeText(copyLbl, "Copy log"), 2000);
  });
  $("#openDir").addEventListener("click", () => { api("POST", "/api/data/open"); });
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    const r = await api("POST", "/api/cache/clear");
    if (!r.ok) { clear.disabled = false; return; }
    fadeText(clear.firstElementChild as HTMLElement, "Cleared"); fadeText(img, size(r.j.cacheBytes || 0));
    setTimeout(() => fadeText(clear.firstElementChild as HTMLElement, "Clear"), 2000);
  });
  let armT = 0;
  reset.addEventListener("click", async () => {
    if (!reset.classList.contains("arm")) {                  // the first click arms it, in place; it lets go after 4 s
      reset.classList.add("arm"); fadeText(label, "Click again");
      armT = window.setTimeout(() => { reset.classList.remove("arm"); fadeText(label, "Reset everything"); }, 4000);
      return;
    }
    clearTimeout(armT); reset.disabled = true; fadeText(label, "Resetting");
    const r = await api("POST", "/api/reset");
    if (!r.ok) { reset.disabled = false; reset.classList.remove("arm"); fadeText(label, "Reset everything"); return; }
    await resetAll();
    try { localStorage.removeItem(DISPLAY_KEY); } catch { /* nothing to remove */ }
    location.reload();
  });
}
