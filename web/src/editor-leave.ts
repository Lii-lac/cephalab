// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "leave"); behaviour must match v52.
import { ui } from "./state";
import { late } from "./late";
import { BUILDS, byKey, newBuildId, storeMine, syncSaved } from "./data";
import { setPathBuild } from "./path";
import { show } from "./wiring";

/* Leaving the build editor.
   Save build: your own build is updated in place (including weapon); a sendou build or a new one becomes a build of yours.
   You land in the Gear tab (your builds) with that card popping, or back on Path if started from Path.
   Delete (hold ~700 ms): if editing one of your own saved builds, removes it and stores; otherwise removes nothing.
   Either way returns straight to the Gear tab (your builds) with no "Deleted" label. */
let leaving = false;
function syncWeaponCards() {
  document.querySelectorAll("#below [data-save]").forEach(b => {
    const x = BUILDS[byKey(b.dataset.save)]; if (!x) return;
    b.classList.toggle("on", !!x.saved); b.textContent = x.saved ? "Saved" : "Save";
  });
}
function leaveEditor(save) {
  if (leaving) return;
  const at = ui.edIdx >= 0 && ui.edKey ? byKey(ui.edKey) : ui.edIdx, src = at >= 0 ? BUILDS[at] : null, btn = document.querySelector("#editor #save");
  let target = null;
  if (save) {
    leaving = true;
    ui.ed.title = (document.querySelector("#editor .tin")?.value || "").trim() || ui.ed.title || "New build";
    ui.ed.notes = document.querySelector("#editor .bdesc")?.value ?? ui.ed.notes ?? "";
    const weapon = ui.ed.weapon || ui.pick;
    const data = JSON.parse(JSON.stringify({ title: ui.ed.title, modes: ui.ed.modes || [], set: ui.ed.set, notes: ui.ed.notes, weapon }));
    if (src && src.mine) target = Object.assign(src, data);
    else { target = { ...data, id: newBuildId(), mine: true, src: src ? src.id : null }; BUILDS.push(target); }
    storeMine(); syncSaved();
    syncWeaponCards();
    if (btn) { btn.classList.add("done"); btn.animate({ scale: [.9, 1.08, 1], offset: [0, .6, 1] }, { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" }); }
  }
  setTimeout(() => {
    leaving = false;
    if (save && ui.edFrom === "path") { setPathBuild(target.id); show("path"); }   // a build started from the path screen gets its path
    else if (save) { late.renderGearTab(); show("gear"); setTimeout(() => late.popGearCard(target.id), 260); }
    else show(ui.edFrom || "weapons");
  }, save ? 520 : 0);
}
function deleteEditorBuild() {
  if (leaving) return;
  if (ui.edKey) {
    const at = byKey(ui.edKey);
    if (at >= 0 && BUILDS[at]?.mine) {
      BUILDS.splice(at, 1);
      storeMine(); syncSaved();
      syncWeaponCards();
    }
  }
  late.renderGearTab?.();
  show("gear");
}

// forward references from earlier modules (they were one shared script scope in v52)
Object.assign(late, { leaveEditor, deleteEditorBuild });
