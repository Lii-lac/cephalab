// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "wiring"); behaviour must match v52.
import { ui } from "./state";
import { late } from "./late";
import { BUILDS, WEAPONS, byKey, copyToMine, storeMine, syncSaved } from "./data";
import { SORTS, filters, renderWeapons, shown, stepPick } from "./weapons";
import { renderEditor } from "./editor";
import { renderPath, setChunks } from "./path";
import { MO } from "./motion";
import { beadSquid } from "./beadsquid";
import { mountSettings, refreshSettings } from "./signin";

/* ================= wiring ================= */
export function show(id) { MO.screen(id); }
function showNow(id) {
  const bs = document.getElementById("beadslot"); if (bs) bs.style.display = id === "weapons" ? "" : "none";
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === id));
  document.getElementById("cog")?.classList.toggle("on", id === "settings");
  if (id === "settings") refreshSettings();
  else if (id === "weapons") beadSquid(document.querySelector("#beadslot .bead.on"));   // home from Settings' stickers
  const tab = id === "editor" ? (ui.edFrom === "gear" ? "gear" : ui.edFrom === "path" ? "builds" : "weapons") : id === "weapon" ? "weapons" : id === "path" ? "builds" : id;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.s === tab));
}
document.querySelector(".tabs").addEventListener("click", e => { const b = e.target.closest(".tab"); if (!b) return; show(b.dataset.s === "builds" ? "path" : b.dataset.s); });
document.getElementById("weapons").addEventListener("click", e => {
  const so = e.target.closest("[data-sort]"), f = e.target.closest("[data-f]"), st = e.target.closest("[data-step]"), x = e.target.closest("[data-edit]");
  const sv = e.target.closest("[data-save]");
  if (sv) {                                                    // a card's Save: keep (or drop) this build in your saved list
    const b = BUILDS[byKey(sv.dataset.save)]; if (!b) return;
    if (b.saved) for (let k = BUILDS.length - 1; k >= 0; k--) { if (BUILDS[k].mine && BUILDS[k].src === b.id) BUILDS.splice(k, 1); }
    else copyToMine(b);
    storeMine(); syncSaved(); late.renderGearTab?.();
    sv.classList.toggle("on", b.saved); sv.textContent = b.saved ? "Saved" : "Save";
    sv.animate({ scale: [.85, 1.1, 1], offset: [0, .6, 1] }, { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    return;
  }
  if (so) { ui.sortMode = SORTS[(SORTS.indexOf(ui.sortMode) + 1) % SORTS.length]; const cur = WEAPONS.find(v => v.row === ui.pick); ui.filt = ui.sortMode === "Main" ? cur.cls : ui.sortMode === "Sub" ? cur.sub : cur.sp; MO.changeClass(true); }
  if (f && filters().some(x => x.key === f.dataset.f)) { ui.filt = f.dataset.f; ui.pick = shown()[0].row; MO.changeClass(false); }
  if (st) stepPick(+st.dataset.step);
  if (x) { const k = byKey(x.dataset.edit); if (k < 0) return; ui.edIdx = k; ui.edKey = x.dataset.edit; ui.edFrom = "weapons"; ui.ed = JSON.parse(JSON.stringify(BUILDS[k])); renderEditor(); show("editor"); }
});
document.getElementById("beadslot").addEventListener("click", e => { const f = e.target.closest("[data-f]"); if (f && filters().some(x => x.key === f.dataset.f)) { ui.filt = f.dataset.f; ui.pick = shown()[0].row; MO.changeClass(false); } });
document.getElementById("path").addEventListener("click", e => { const t = e.target.closest("[data-t]"); if (!t) return; if (t.dataset.t === "c") setChunks(!ui.useChunks); else if (t.dataset.t === "o") ui.fixedOrder = !ui.fixedOrder; else ui.useDrinks = !ui.useDrinks; MO.path(t.dataset.t); });
// a pasted sendou link (seek.ts): the build in the editor, new and unsaved, for the link's weapon (the weapons screen moved to it)
document.addEventListener("sendoulink", e => {
  const { row, set } = e.detail, w = WEAPONS.find(x => x.row === row);
  ui.edIdx = -1; ui.edKey = null; ui.edFrom = "weapons"; ui.sel = [0, -1];
  ui.ed = { title: w ? w.name : "From sendou", modes: [], notes: "", set: JSON.parse(JSON.stringify(set)), weapon: row || ui.pick };
  renderEditor(); show("editor");
});
mountSettings(document.getElementById("settings"));
document.getElementById("cog").addEventListener("click", () => show("settings"));
renderWeapons(); renderEditor(); renderPath();
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => renderWeapons(), 120); });
const start = new URLSearchParams(location.hash.slice(1)).get("s"); if (start) showNow(start);

// forward references from earlier modules (they were one shared script scope in v52)
Object.assign(late, { showNow, show });
