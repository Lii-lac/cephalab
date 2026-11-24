// Blank page for tests/web/worker.mjs: exposes the bridge (web/src/core/bridge.ts) as window.bridge.
import * as bridge from "../../../web/src/core/bridge";
(window as any).bridge = bridge;
