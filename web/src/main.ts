// Start-up: open the saved data (IndexedDB, migrating v52's localStorage on first run), then run the screens.
import { store, exportJSON, importJSON } from "./store";

await store.init();
await (await import("./builds-backup")).restoreBuilds();   // before data.ts reads your builds
// export / import of everything saved, from the console until the UI has a button for it
(window as any).cephalab = (window as any).seedtracker = { exportJSON, importJSON, flush: () => store.flush() };
await import("./app");
