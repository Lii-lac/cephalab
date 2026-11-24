// Settings / Data / Updates: check GitHub Releases on start or on demand, and install (frozen .exe) or open the release page.
import { $, api, fadeText, seg } from "./dom";
import { cfg, onCfg, saveCfg } from "./cfg";
import { live, subscribe, type UpdateStatus } from "../live";

let cur: UpdateStatus | null = null;

function paint(st: UpdateStatus | null) {
  cur = st;
  const row = $("#updRow"), ver = $("#updVer"), btn = $<HTMLButtonElement>("#updBtn"), lbl = btn.firstElementChild as HTMLElement;
  if (!st) {
    ver.textContent = ""; ver.classList.remove("go"); delete ver.dataset.tip;
    btn.disabled = false; btn.classList.remove("go"); fadeText(lbl, "Check");
    row.classList.remove("busy");
    return;
  }
  const busy = st.state === "checking" || st.state === "installing" || st.state === "restarting";
  const avail = st.state === "available";
  row.classList.toggle("busy", busy);
  btn.disabled = busy;
  btn.classList.toggle("go", avail);
  ver.classList.toggle("go", avail);

  const text =
    st.state === "checking" ? `v${st.current}` :
    st.state === "available" ? `v${st.latest} ready` :
    st.state === "up-to-date" ? `v${st.current} · latest` :
    st.state === "installing" ? "Downloading" :
    st.state === "restarting" ? "Restarting" :
    st.state === "error" ? (st.error || "Check failed") :
    `v${st.current}`;
  fadeText(ver, text);
  if (st.state === "available") ver.dataset.tip = `Current: v${st.current} -> v${st.latest}`;
  else if (st.state === "error" && st.error) ver.dataset.tip = st.error;
  else delete ver.dataset.tip;

  const btnText =
    st.state === "checking" ? "Checking" :
    st.state === "installing" ? "Updating" :
    st.state === "restarting" ? "Restarting" :
    avail ? "Update" : "Check";
  fadeText(lbl, btnText);
}

export function mountUpdates() {
  const btn = $<HTMLButtonElement>("#updBtn");
  const setAuto = seg($("[data-key=updates]"), async v => { await saveCfg({ updates: { auto: v === "auto" } }); });
  onCfg(() => { if (cfg) setAuto(cfg.updates?.auto === false ? "manual" : "auto"); });

  btn.addEventListener("click", async () => {
    if (cur?.state === "available") {
      if (!cur.canInstall) {
        const w = window.open(cur.url, "_blank", "noopener,noreferrer");
        if (w) w.opener = null;
        return;
      }
      paint({ ...cur, state: "installing" });
      const r = await api("POST", "/api/update/install");
      if (r.ok && r.j?.ok) paint(r.j.status || { ...cur, state: "restarting" });
      else paint({ ...cur, state: "error", error: r.j?.error || "Update failed" });
      return;
    }
    paint({ ...(cur || { current: "0.1.0", latest: "", url: "", canInstall: false, error: "" }), state: "checking" });
    const r = await api("POST", "/api/update/check");
    if (r.ok && r.j?.state) paint(r.j);
    else paint({ ...(cur || { current: "0.1.0", latest: "", url: "", canInstall: false, error: "" }), state: "error", error: r.j?.error || "Check failed" });
  });

  subscribe(ev => { if (ev === "update") paint(live.update); });
  if (live.update) paint(live.update);
}

export async function refreshUpdates() {
  const r = await api("GET", "/api/update");
  if (r.ok && r.j?.state) paint(r.j);
}
