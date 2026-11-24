// The "file" snapshot made in the browser (no companion): built from an s3s export, kept in localStorage so a reload keeps it.
import { decodeExport } from "./outfit";

const KEY = "seedtracker.file-snapshot.v1";

export function snapshotFromExport(doc: unknown) {
  const { key, pieces } = decodeExport(doc);
  return { source: "file", gameVersion: "", playerKey: key, pieces, at: Date.now() / 1000 };
}
export function saveFileSnapshot(snap: unknown) { try { localStorage.setItem(KEY, JSON.stringify(snap)); } catch { /* storage full or off */ } }
export function loadFileSnapshot(): any {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    return s && s.source === "file" && Array.isArray(s.pieces) ? s : null;
  } catch { return null; }
}
export function clearFileSnapshot() { try { localStorage.removeItem(KEY); } catch { /* nothing */ } }
