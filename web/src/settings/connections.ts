// Connections / Switch: the sys-botbase status (from live.ts, or the last Test connection), Address + port, Read every.
import { $, api, fadeText, say, seg } from "./dom";
import { cfg, onCfg, saveCfg } from "./cfg";
import { live, subscribe } from "../live";

const IP = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
type S = "ok" | "err" | "off" | "wait";

function paint(s: S, ver = "") {
  const el = $("#swStat"), test = $<HTMLButtonElement>("#test"), ip = $<HTMLInputElement>("#ip");
  const text = { ok: "Connected", err: "Can't reach", off: "Not set", wait: "Checking" }[s];
  el.dataset.s = s;
  fadeText(el.querySelector<HTMLElement>(".st-fade")!, text);
  let v = el.querySelector<HTMLElement>(".st-ver");
  if (ver && !v) { v = document.createElement("span"); v.className = "st-ver"; el.append(v); }
  if (v) v.textContent = ver;
  test.disabled = !ip.value.trim() || s === "wait";
  ip.closest(".st-slab")?.classList.toggle("busy", s === "wait");
  if (s !== "wait") {
    const dis = s !== "ok", row = $("#readRow");
    row.classList.toggle("dis", dis);   // "Read every" waits for a Switch to read
    row.querySelector<HTMLElement>(".st-ctl")?.toggleAttribute("inert", dis);
  }
}
function fromLive() {
  const st = live.status.botbase, snap = live.snapshots.botbase as any;
  if (live.reachable === false || !st) return paint("off");
  if (st.state === "ok") return paint("ok");
  if (st.state === "error") return paint("err");
  if (st.state === "connecting" || st.state === "waiting") return paint("wait");
  paint("off");
}

export function mountSwitch() {
  const ip = $<HTMLInputElement>("#ip"), port = $<HTMLInputElement>("#port"), msg = $("#swMsg"), test = $<HTMLButtonElement>("#test");
  const read = seg($("[data-key=read]"), async v => { const e = await saveCfg({ switch: { every: +v } }); say(msg, e || "Saved", !!e); });
  const discord = seg($("[data-key=discord]"), async v => { await saveCfg({ discord: { level: v } }); });
  const check = (): { host: string; port: number } | null => {
    const host = ip.value.trim(), p = port.value.trim();
    const badIp = !!host && !IP.test(host), badPort = !/^\d{1,5}$/.test(p) || +p < 1 || +p > 65535;
    ip.classList.toggle("bad", badIp); port.classList.toggle("bad", badPort);
    ip.setAttribute("aria-invalid", String(badIp)); port.setAttribute("aria-invalid", String(badPort));
    if (badIp) { say(msg, "Not an IP address", true); return null; }
    if (badPort) { say(msg, "Port is 1 to 65535", true); return null; }
    say(msg, "");
    return { host, port: +p };
  };
  const save = async () => {
    const v = check();
    if (!v || (cfg && v.host === cfg.switch.host && v.port === cfg.switch.port)) return;
    const e = await saveCfg({ switch: v });
    say(msg, e || "Saved", !!e);
  };
  for (const f of [ip, port]) {
    f.addEventListener("change", save);
    f.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    f.addEventListener("input", () => { test.disabled = !ip.value.trim(); f.classList.remove("bad"); });
  }
  test.addEventListener("click", async () => {
    const v = check();
    if (!v || !v.host) return;
    paint("wait");
    const r = await api("POST", "/api/switch/test", v);
    if (r.ok && r.j.ok) paint("ok");
    else { paint("err"); say(msg, r.j.error || "Can't reach the Switch", true); }
  });
  onCfg(() => {
    if (!cfg) return;
    ip.value = cfg.switch.host || ""; port.value = String(cfg.switch.port || 6000);
    read(String(cfg.switch.every));
    discord(cfg.discord?.level || "basic");
    fromLive();
  });
  subscribe(() => { if (cfg) fromLive(); });
  paint("off");
}
