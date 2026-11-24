// Settings / Builds: export all your builds, import a file of them (Add to mine / Replace mine), and the s3s gear file.
import { $, api, fadeText, reveal, say, seg } from "./dom";
import { exportBuilds, mergeBuilds, myBuilds, parseBuilds, type SavedBuild } from "./builds-io";
import { BUILDS as B, syncSaved } from "../data";
const BUILDS: any[] = B;
import { late } from "../late";
import { importLocal } from "../live";
import { STATIC } from "../local/flag";

let incoming: SavedBuild[] = [];

/** After a merge: the screens' in-memory list follows what is saved. */
function resync() {
  for (let k = BUILDS.length - 1; k >= 0; k--) if (BUILDS[k].mine) BUILDS.splice(k, 1);
  for (const m of myBuilds()) BUILDS.push({ ...m, mine: true });
  syncSaved();
  late.renderPath?.(); late.renderGearTab?.();
}
export const countMine = () => myBuilds().length;
export function paintCount() { fadeText($("#nBuilds"), String(countMine())); }

export function mountBuilds() {
  const msg = $("#buildsMsg"), inc = $("#incoming"), fileB = $<HTMLInputElement>("#fileB"), fileG = $<HTMLInputElement>("#fileG");
  let mode: "add" | "replace" = "add";
  seg($("[data-key=merge]"), v => { mode = v as typeof mode; });
  $("#nBuilds").textContent = String(countMine());

  $("#export").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([exportBuilds()], { type: "application/json" }));
    a.download = "cephalab-builds.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("#importB").addEventListener("click", () => fileB.click());
  fileB.addEventListener("change", async () => {
    const f = fileB.files?.[0]; fileB.value = "";
    if (!f) return;
    try { incoming = parseBuilds(await f.text()); } catch (e) { reveal(inc, false); return say(msg, (e as Error).message, true); }
    say(msg, "");
    $("#nIn").textContent = String(incoming.length); reveal(inc, true);
  });
  $("#doImport").addEventListener("click", () => {
    const r = mergeBuilds(incoming, mode);
    resync(); incoming = []; reveal(inc, false); paintCount();
    say(msg, mode === "replace" ? `Replaced with ${r.added}` : r.added ? `${r.added} added` : "Nothing new");
  });
  $("#cancelImport").addEventListener("click", () => { incoming = []; reveal(inc, false); });

  $("#importG").addEventListener("click", () => fileG.click());
  fileG.addEventListener("change", async () => {
    const f = fileG.files?.[0]; fileG.value = "";
    if (!f) return;
    let data: unknown;
    try { data = JSON.parse(await f.text()); } catch { return say(msg, "Not a JSON file", true); }
    const done = (n: number) => say(msg, `${n} ${n === 1 ? "piece" : "pieces"} imported`);
    const local = () => { try { done(importLocal(data)); } catch (e) { say(msg, (e as Error).message, true); } };
    if (STATIC) return local();                                  // the static site: this browser reads the file
    const r = await api("POST", "/api/import", data);            // the companion keeps it (and logs it) when it's there
    if (r.ok) return done(r.j.pieces);
    if (r.status === 0 || (r.status >= 500 && !r.j?.error)) return local();   // no companion behind the page: read it here
    say(msg, r.j.error || "Import failed", true);
  });
}
