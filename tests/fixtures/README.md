# Fixtures

Used by the visual harness (`tests/web/visual.mjs`) for v52 (localStorage) and the app (the IndexedDB store) alike.

- `builds.json`: five of "your builds" in the saved shape `{id, title, modes, set: [[row, main, [s1, s2, s3]] x3], notes, weapon, src}`, oldest first. Until the core lands the Path screen's route is the mockup's stub, seeded by the build id, so each id was picked for the state it draws (all toggles on):
  - `200002` Zones anchor (newest, so Gear's first card and the Path screen's default): every step kind at once: scrubs, drinks with tickets, burn groups (once and twice), a chunk over a slot, a chunk replacing a roll in the same column, dot placeholders; Up next with three pages (blue dots). A copy of sendou build 48213 (`src`), so that sendou card reads "Saved" on the Weapons screen.
  - `322624` Finished swim kit: every goal already met: Up next "Done", no steps, 0 rolls.
  - `200071` Backline ink saver: one piece still to do: Up next with a single page (no dots), two lanes with only placeholders.
  - `200006` Rainmaker push: two pieces to do, empty goal slots ("anything is fine there"), a drink and a scrub.
  - `200003` Turf special farm: plain rolls and burns only, no drinks or scrubs; one lane is a single chunk step.
- `s3s_gear_export.json`: an s3s --getseed export (key + h + gear) of three pieces matching build 200002 plus one unknown gear id; `tests/web/static.mjs` imports it in the browser and checks the TS reader against companion/server.py decode_export.
- The empty state (no builds at all: Gear shows only New build, Path shows the New build button) is the fixture `[]`, made in the harness.
- Weapons and Editor states use v52's own sample (sendou) builds, which ship with the screens.
