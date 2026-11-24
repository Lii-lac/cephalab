// Live data from the companion: GET /api/state once, then /api/events (server-sent events) for every change.
// Keeps the latest snapshot and status per source (botbase, s3s, file); other modules subscribe(). The header's
// Switch pill shows the botbase source's status. With the visual harness's mock flag none of this runs.
import { MOCK } from "./data";
import { late } from "./late";
import { STATIC } from "./local/flag";
import { loadFileSnapshot, saveFileSnapshot, snapshotFromExport } from "./local/file-snap";

export type Status = { state: string; message?: string; at?: number; [k: string]: unknown };
export type UpdateStatus = { current: string; state: string; latest: string; url: string; canInstall: boolean; error: string; checkedAt?: number };
export type LiveEvent = "state" | "snapshot" | "status" | "source-error" | "login-needed" | "reachable" | "update";
export const live = {
  snapshots: {} as Record<string, any>,
  status: {} as Record<string, Status>,
  reachable: null as null | boolean,          // null until the first answer (or the first failure)
  lastError: {} as Record<string, string>,    // source-error messages, per source
  loginNeeded: {} as Record<string, string>,  // login-needed messages, per source
  update: null as UpdateStatus | null,
};

type Fn = (ev: LiveEvent, data: any) => void;
const subs = new Set<Fn>();
export function subscribe(fn: Fn) { subs.add(fn); return () => { subs.delete(fn); }; }
function tell(ev: LiveEvent, data: any) { for (const fn of subs) { try { fn(ev, data); } catch (e) { console.error(e); } } }

function setState(d: any) {
  live.snapshots = { ...(d?.snapshots || {}) };
  live.status = { ...(d?.status || {}) };
  tell("state", d);
}
function setReachable(v: boolean) {
  if (live.reachable === v) return;
  live.reachable = v;
  if (!v) restoreFile();
  tell("reachable", v);
}

/* No companion: the s3s file snapshot is made and kept here (localStorage), so a reload keeps it. */
function restoreFile() {
  if (live.snapshots.file) return;
  const s = loadFileSnapshot();
  if (s) { live.snapshots = { ...live.snapshots, file: s }; tell("state", { snapshots: live.snapshots, status: live.status }); }
}
/** Read an s3s --getseed export in the browser (throws an Error with a plain message). */
export function importLocal(doc: unknown) {
  const snap = snapshotFromExport(doc);
  live.snapshots = { ...live.snapshots, file: snap };
  saveFileSnapshot(snap);
  tell("snapshot", snap);
  return snap.pieces.length;
}

let es: EventSource | null = null, retry = 0, timer = 0;
function connect() {
  clearTimeout(timer);
  es?.close();
  es = new EventSource("/api/events");
  const on = (ev: LiveEvent, fn: (d: any) => void) => es!.addEventListener(ev, (m: MessageEvent) => {
    let d: any; try { d = JSON.parse(m.data); } catch { return; }
    retry = 0; setReachable(true); fn(d); if (ev !== "state") tell(ev, d);
  });
  on("state", setState);
  on("snapshot", d => { if (d?.source) live.snapshots[d.source] = d; });
  on("status", d => { if (d?.source) { const { source, ...st } = d; live.status[source] = st; if (st.state !== "login-needed") delete live.loginNeeded[source]; } });
  on("source-error", d => { if (d?.source) live.lastError[d.source] = d.message || ""; });
  on("login-needed", d => { if (d?.source) live.loginNeeded[d.source] = d.message || ""; });
  on("update", d => { if (d?.state) live.update = d; });
  es.onerror = () => {                         // the companion went away (or never was): back off and try again
    es?.close(); es = null;
    setReachable(false);
    const wait = Math.min(30000, 1000 * 2 ** retry++);
    timer = window.setTimeout(start, wait);
  };
}
async function start() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    setState(await r.json());
    setReachable(true);
    fetch("/api/update", { cache: "no-store" }).then(u => u.ok ? u.json() : null).then(d => {
      if (d?.state) { live.update = d; tell("update", d); }
    }).catch(() => {});
  } catch {
    setReachable(false);
  }
  connect();                                   // the stream's own "state" event brings it up to date either way
}

/* ---------- the header's Switch pill ---------- */
const pill = document.querySelector<HTMLElement>("header .switch, .switch");
function pillView(): [string, string, string] {    // [class, words, tooltip]
  const [cls, words, tip] = pillBase(), s3s = live.status.s3s;
  return [cls, words, needsSignIn() ? (tip ? tip + "\n" : "") + "SplatNet needs a sign-in" : tip];
}
// SplatNet needs a sign-in: s3s says so (a status or a login-needed event), unless the Settings screen has just told us the real answer.
let signedHere: boolean | null = null;
function needsSignIn(): boolean {
  const s3s = live.status.s3s;
  if (s3s?.state === "off") return false;
  const says = signedHere !== null ? signedHere : s3s?.state === "login-needed" || (!!live.loginNeeded.s3s && s3s?.state !== "ok");
  return says && live.reachable !== false;
}
const cog = document.getElementById("cog");
function paintCog() {
  const hasUpd = live.update?.state === "available" && live.reachable !== false;
  cog?.classList.toggle("needs", needsSignIn() || hasUpd);
  if (cog) {
    if (hasUpd && live.update?.latest) cog.dataset.tip = `Update v${live.update.latest} ready`;
    else delete cog.dataset.tip;
  }
}
window.addEventListener("splatnet-login", e => { signedHere = (e as CustomEvent).detail?.needs ?? null; paintPill(); });
function pillBase(): [string, string, string] {
  if (live.reachable === false) return ["offline", "Switch · offline", STATIC ? "" : "The companion isn't running"];
  const st = live.status.botbase, s3s = live.status.s3s;
  const player = (live.snapshots.botbase?.player as string) || (live.snapshots.s3s?.player as string) || "";
  if (st?.state === "ok") return ["ok", player || "Switch", st.host ? `Connected to ${st.host}` : "Connected"];
  if (s3s?.state === "ok") return ["ok", player || "SplatNet", "Connected via SplatNet"];
  if (!st) return ["wait", "Switch", ""];
  const msg = st.message || "";
  switch (st.state) {
    case "connecting": return ["wait", "Switch · connecting", msg];
    case "waiting": return ["wait", "Switch · waiting", msg];
    case "error": return ["error", "Switch · error", msg];
    case "off": return ["off", "Switch · off", msg];
    default: return ["wait", "Switch", msg];
  }
}
if (pill) {                                        // a click opens Settings, where the SplatNet sign-in lives
  pill.style.cursor = "pointer"; pill.tabIndex = 0; pill.setAttribute("role", "button");
  pill.addEventListener("click", () => late.show?.("settings"));
  pill.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); late.show?.("settings"); } });
}
let shownWords = "";
function paintPill() {
  if (!pill) return;
  paintCog();
  const [cls, words, tip] = pillView();
  pill.dataset.live = cls;
  if (tip) pill.dataset.tip = tip; else delete pill.dataset.tip;
  const label = pill.querySelector("span") || pill.appendChild(document.createElement("span"));
  if (words === shownWords) return;
  shownWords = words;
  const from = label.offsetWidth;
  label.textContent = words;
  label.animate({ opacity: [0.25, 1] }, { duration: 240, easing: "ease-out" });   // new words fade in
  const to = label.offsetWidth;                    // and the pill grows or shrinks to them instead of jumping
  if (from && to && from !== to) label.animate({ width: [from + "px", to + "px"] }, { duration: 240, easing: "ease-out" });
}

if (!MOCK) {
  subscribe(paintPill);
  paintPill();
  if (STATIC) setReachable(false);               // the static site has no companion: show offline, never ask
  else start();
}
