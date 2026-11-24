// The screens, in the order v52 ran its scripts (each module's top-level code runs once, in this order).
import "./beadsquid";        // header: the squid on the bead chain
import "./tip";              // shared themed tooltip for [data-tip]
import "./data";             // weapons, gear, abilities, builds (yours from the store)
import "./weapons";          // weapons screen: wheel, beads, banner, cards
import "./editor";           // build editor
import "./path";             // path screen (lanes from core/bridge.ts)
import "./motion";           // every transition (v48 motion)
import "./wiring";           // header tabs, screen switching, clicks
import "./seek";             // type-to-search tape (weapons)
import "./zoom";             // editor and path scale with the window
import "./editor-leave";     // Save build / Discard
import "./gear";             // Gear tab: your builds
import "./path-picker";      // path screen: build picker, Up next card
import "./live";             // the companion: live status (the Switch tag) and snapshots
