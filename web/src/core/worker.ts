// The wasm core in a module Web Worker (core/API.md: one entry point, st_call(json) -> json, every call serialized
// here; a long `recover` is cancelled by terminating this worker, see bridge.ts cancel()).
// In:  { id, req }    Out: { id, reply }  (reply = the core's parsed JSON; a load or runtime failure is {ok:false,error}).
// @ts-ignore  core.mjs is Emscripten output (-sMODULARIZE -sEXPORT_ES6), it has no types
import createCore from "../../../core/dist/core.mjs";
// ?url makes Vite serve the wasm in dev and copy it (hashed) into the build, from outside web/.
import wasmUrl from "../../../core/dist/core.wasm?url";

interface CoreModule {
  _st_call(p: number): number;
  _free(p: number): void;
  stringToNewUTF8(s: string): number;
  UTF8ToString(p: number): string;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void };

const ready: Promise<CoreModule> = createCore({
  locateFile: (p: string) => (p.endsWith(".wasm") ? wasmUrl : p),
});
ready.catch(() => {});                                           // reported per call below

function call(M: CoreModule, req: unknown): unknown {
  const text = JSON.stringify(req);
  const p = M.stringToNewUTF8(text);
  try { return JSON.parse(M.UTF8ToString(M._st_call(p))); }      // copy the reply out before the next call
  finally { M._free(p); }
}

// onmessage runs one message at a time, but the module loads asynchronously: chain every call on one promise.
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (e: MessageEvent) => {
  const { id, req } = e.data as { id: number; req: unknown };
  queue = queue.then(async () => {
    let reply: unknown;
    try { reply = call(await ready, req); }
    catch (err) { reply = { ok: false, error: `core: ${err instanceof Error ? err.message : String(err)}` }; }
    ctx.postMessage({ id, reply });
  });
};
