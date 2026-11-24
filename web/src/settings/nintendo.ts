// Connections / Nintendo: the SplatNet sign-in (link, the wordless strip, paste, sign out) and Check SplatNet. Every sign-in
// outcome is announced on window as "splatnet-login" ({ needs: boolean | null }) so the header's cog can show or drop its badge.
import { $, api, fadeText, reveal, say, seg, swap } from "./dom";
import { offline, saveCfg, cfg, onCfg } from "./cfg";
import { fitSoon } from "./display";

type Login = { enabled: false } | { enabled: true; signedIn: boolean; fApi?: string };
let login: Login | null = null, busy = false;

// the cog's badge only asks for a sign-in when SplatNet checking is on: nobody who reads the Switch alone is nagged
const announce = (needs: boolean | null) => window.dispatchEvent(new CustomEvent("splatnet-login",
  { detail: { needs: cfg && cfg.splatnet.every === "off" ? false : needs } }));
onCfg(() => { if (login) announce(login.enabled ? !login.signedIn : null); });
function setBusy(on: boolean, connecting = false) {
  busy = on;
  const was = document.activeElement as HTMLElement | null;
  for (const c of [$("#signin"), $("#signout"), $("#paste")] as HTMLButtonElement[]) c.disabled = on;
  const slab = connecting ? $("#strip .st-slab") : $("#nnIn").closest<HTMLElement>(".st-slab");
  slab?.classList.toggle("busy", on);
  if (on && connecting) {
    const stat = $("#nnStat");
    stat.dataset.s = "wait";
    fadeText(stat.querySelector<HTMLElement>(".st-fade")!, "Connecting");
  }
  if (!on && was && was.isConnected && document.activeElement === document.body) was.focus();
}

function paint(first = false) {
  const l = login, msg = $("#nnMsg");
  const signedIn = !!l && l.enabled && l.signedIn, off = !l || !l.enabled;
  const stat = $("#nnStat"), text = off ? "Not set" : signedIn ? "Signed in" : "Signed out";
  stat.dataset.s = off ? "off" : signedIn ? "ok" : "off";
  fadeText(stat.querySelector<HTMLElement>(".st-fade")!, text);
  const acct = $("#nnIn").closest<HTMLElement>(".st-slab")!;
  acct.classList.toggle("dis", off);
  for (const c of acct.querySelectorAll<HTMLElement>(".st-ctl")) c.toggleAttribute("inert", off);
  $("#nnWhy").textContent = "";
  const chk = $("#checkRow");
  chk.classList.toggle("dis", !signedIn);
  chk.querySelector<HTMLElement>(".st-ctl")?.toggleAttribute("inert", !signedIn);
  reveal($("#strip"), !off && !signedIn);
  fitSoon();
  const inn = $("#nnIn"), out = $("#nnOut");
  if (first) { inn.hidden = !signedIn; out.hidden = signedIn; } else signedIn ? swap(inn, out) : swap(out, inn);
  if (signedIn) say(msg, "");
}
function dropOff() { login = { enabled: false }; paint(); }

export function mountNintendo() {
  const msg = $("#nnMsg"), paste = $<HTMLInputElement>("#paste");
  const setCheck = seg($("[data-key=check]"), async v => { const e = await saveCfg({ splatnet: { every: v } }); say(msg, e || "Saved", !!e); });
  onCfg(() => { if (cfg) setCheck(cfg.splatnet.every); });

  $("#signin").addEventListener("click", async () => {
    setBusy(true);
    const r = await api("POST", "/api/login/link");
    setBusy(false);
    if (r.status === 409) return dropOff();
    if (!r.ok || !r.j.url) return say(msg, r.j.error || "No sign-in page", true);
    say(msg, "");
    const w = window.open(r.j.url, "_blank");
    if (w) w.opener = null; else say(msg, "Pop-up blocked", true);
    reveal($("#strip"), true); paste.focus();
  });
  const submit = async () => {
    const link = paste.value.trim();
    if (!link || busy) return;
    say(msg, "");
    setBusy(true, true);
    const r = await api("POST", "/api/login", { link });
    setBusy(false, true);
    if (r.status === 409) return dropOff();
    if (!r.ok) { paint(); say(msg, r.j.error || "Link not accepted", true); paste.focus(); paste.select(); return; }
    paste.value = "";
    login = { enabled: true, signedIn: true };
    announce(false); paint();
  };
  paste.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  paste.addEventListener("paste", () => setTimeout(submit, 0));
  $("#signout").addEventListener("click", async () => {
    setBusy(true);
    const r = await api("POST", "/api/logout");
    setBusy(false);
    if (r.status === 409) return dropOff();
    if (!r.ok) return say(msg, r.j.error || "Sign-out failed", true);
    login = { enabled: true, signedIn: false, fApi: login && login.enabled ? login.fApi : undefined };
    announce(true); paint();
  });
  paint(true);
}

export async function refreshNintendo() {
  const r = await api("GET", "/api/login");
  login = r.ok && r.j.enabled ? { enabled: true, signedIn: !!r.j.signedIn, fApi: r.j.fApi } : { enabled: false };
  announce(login.enabled ? !login.signedIn : null);
  paint(true);
}
