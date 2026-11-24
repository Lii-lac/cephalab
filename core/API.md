# Core API (the contract between core/, web/ and companion/)

Contract between `core/`, `web/`, and `companion/`. Change it only together with every side that uses it.

## Names
- Ability: the game's internal name, as in `s3seed/seedmath.py` `ABILITY_ORDER` (`MainInk_Save` ... `Action_Up`); `""` = empty slot. Image: `/img/skill/<name>.png`.
- Brand: code `B00`..`B99` as keys of `data/BrandTraitsParam.raw.json` `Traits`; unknown -> the `None` row.
- Gear: Leanny row id (`__RowId` in `data/GearInfoHead|Clothes|Shoes.json`, e.g. `Hed_AMB000`); image `/img/gear/<row>.png`. `gearId` = the same entry's integer `Id` (what sys-botbase and SplatNet report). Slot: `head | clothes | shoes`.
- `playerKey`: string, the SplatNet player id exactly as s3s derives it before obfuscating (`u-` + 20 characters; s3s.py `export_seed_json` ~line 1749, the `r` variable).
- Seeds: unsigned 32-bit integers (JSON numbers 0..4294967295).

## One entry point
`const char* st_call(const char* json)`: UTF-8 JSON request `{"fn": ..., ...}` in, UTF-8 JSON reply out (`{"ok":true,...}` or `{"ok":false,"error":"..."}`), never a crash on bad input.
- Memory: the caller owns the input (wasm: `bridge.ts` uses Emscripten `stringToNewUTF8` and `_free` after the call). The core owns the reply; it stays valid until the next `st_call` on the same thread, so the caller copies it (`UTF8ToString`) right away.
- Threading: the reply buffer is `thread_local`; no other mutable globals (data tables are static const). In the browser every call runs in one Web Worker, serialized; a long `recover` is cancelled by terminating the Worker.
- No exceptions (build with `-fno-exceptions`).

| fn | in | out |
|---|---|---|
| `startSeed` | `playerKey`, `slot`, `gearId` | `seed` = murmur3_x86_32(`{playerKey}_{map}_{gearId}`, seed 0), map = `HaveGearHeadMap / HaveGearClothesMap / HaveGearShoesMap`; clothes 26000 appends `_JUEA-00006` |
| `rolls` | `seed`, `brand`, `drink` (ability or null), `n` (1..1000) | `rolls[]`: `{n, ability, drink_hit, seed}` per roll (seed after it), exactly `seedmath.predict` |
| `recover` | `start`, `brand`, `observed[]`, `maxSteps` (default 10000, cap 2500000) | `candidates[]`: `{skippedSteps, seed}`; `count`; `locked` (count == 1) |
| `refine` | `candidates[]` (seeds from the last reply), `brand`, `observed[]` (rolls since, no gap) | same shape as `recover`, `skippedSteps` = 0 |
| `plan` | see below | see below |

- `observed[]`: `{a: ability or null (seen but unknown), drink: ability or null}` in roll order; slots filled by chunks are left out by the caller. At least one entry must have a known `a` (else `ok:false`, "need at least one seen ability").
- `recover` tries every start offset k = 0..maxSteps seed steps (not rolls, because an unknown drink state makes a roll 1 or 2 steps) and keeps each k where the observed run matches; `seed` is the seed after the run. Candidates are deduplicated by final `seed` (the smallest `skippedSteps` is kept; `count` and `locked` count distinct seeds); every one is listed (no cap): the caller passes them all back to `refine`.

## plan
In:
```json
{"pieces": [{"row": "Hed_AMB000", "brand": "B03", "seed": 123, "subs": ["SquidMove_Up", "", ""],
             "goal": ["SquidMove_Up", "SquidMove_Up", "InkRecovery_Up"]}],
 "chunks": {"SquidMove_Up": 40},
 "drinks": {"SquidMove_Up": 2},
 "fixedOrder": true, "useChunks": true, "chunkRate": 10, "useDrinks": true, "horizon": 60}
```
`goal[i] == ""` means anything there is fine. One to three pieces. `chunks` / `drinks` = what you own, shared by the whole plan. `horizon` caps how many seed steps ahead a piece's route may look: 0..20000.
- `from` (optional, default 0; 0..1000000, else `ok:false`): seed steps already searched. The core then only looks for routes ending past `from` and within `from + horizon` steps, so a caller can search in slices (`from` 0, `horizon` 2000; `from` 2000, `horizon` 2000; ...): when every earlier slice said unreachable, the first slice that finds a route returns exactly the route of one search with `from` 0 and `horizon` = that slice's end. A slice costs time for its `horizon` only when no drinks are used; with tickets the burn search runs from 0 every time, so `(from + horizon + 1) * (tickets owned + 1)` must be at most 8388608 (`ok:false` otherwise; with any number of pieces). With 2-3 pieces a request is planned as one search with `from` 0 and `horizon` = `from + horizon` (a lane found within `from` keeps that route, so the reply stays one timeline; a slice costs time for its whole end): so a lane's first slice that finds it gives the route of one search ending there, and lanes found in earlier slices come back as they were.

Out (what the Path screen draws):
```json
{"ok": true,
 "lanes": [{"row": "Hed_AMB000",
            "have": [["SquidMove_Up", ""], ["", ""], ["", ""]],
            "goal": [["SquidMove_Up", "met"], ["SquidMove_Up", ""], ["InkRecovery_Up", ""]],
            "steps": [{"k": "roll", "a": "RespawnTime_Save", "burn": "b0", "key": 1, "roll": 1},
                      {"k": "scrub", "key": 1.49},
                      {"k": "drink", "d": "SquidMove_Up", "a": "SquidMove_Up", "key": 2, "roll": 2},
                      {"k": "slap", "a": "InkRecovery_Up", "slot": 3, "cost": 30, "sameColumn": false, "key": 2.49}]}],
 "totals": {"rolls": 2, "battles": 5, "tickets": 1, "chunks": 30, "scrubs": 1, "snails": 0},
 "unreachable": []}
```
- `have` = the piece now (the input), `[ability, "wrong" or ""]` (wrong = a sub the goal can't use where it is). `goal` = `[ability, "met" or ""]`, met = already right now (a goal `""` in a slot that stays locked is met).
- Step kinds: `roll` (unlock the next empty slot, no drink; `burn` = a group id when the result is thrown away), `drink` (`d` = the drink active, `a` = what lands), `slap` (chunks onto `slot` 1..3, empty or replacing; `cost`; `sameColumn: true` when it lands on the slot this column's roll just filled), `scrub` (every sub empty, seed unchanged; locked slots stay locked), `unlock` (`slot` 2 or 3: one star upgrade at Murch opens that locked slot, no seed step, `SNAILS_PER_UNLOCK` = 1 Super Sea Snail; a lane's unlocks are its first steps, before its first roll, keyed like other Murch work before it). `roll` on roll/drink steps = that lane's roll count so far.
- Burn groups (one-piece plans, and 2-3 pieces when `from + horizon` > 200): consecutive burn rolls of the same kind (`roll`, or `drink` with the same `d`) in consecutive columns come as one step with `"times": N` (N >= 2) and `"scrubs": S`: N rolls in columns `key` .. `key + N - 1`; before each of them but the first the piece is scrubbed if it is full (S such scrubs, counted in `totals.scrubs`). `a` = what the last of them lands, `roll` = the roll count after the last. The scrub after the group (the last scrub before the kept rolls) is its own step. Example: `{"k": "roll", "a": "Action_Up", "burn": "b0-0", "times": 7836, "scrubs": 2611, "key": 1, "roll": 7836}`. With 2-3 pieces up to `from + horizon` 200 every roll is its own step, as before. With several lanes a lane's group covers only columns where that lane rolls; other lanes may roll in the same columns (one battle), with the same drink state.
- `key`: the column; the same key in different lanes = the same battle. Non-roll steps get fractional keys just before the next roll, as `keyed()` does. A lane with nothing in a column = that piece is taken off for it.
- **Drinks are phases.** A ticket is a player buff for 20 online battles over every worn piece and can't be stopped early. One ticket = `DRINK_COLUMNS` consecutive columns (8 = 20 battles / 2.3 per roll, one constant). Inside a phase every roll is a drink roll of that drink; a piece that mustn't drink-roll is taken off; columns of the phase nobody uses still pass (they count as battles). No plain roll column inside a phase. `tickets` = phases used, limited by `drinks`.
- `unreachable[]`: lane indexes whose goal can't be met within `horizon` with the toggles and stock given; those lanes come back with `steps: []` and `"searchedTo"` = the seed steps now ruled out for them (`from + horizon`), and the rest is planned without them. A lane that can be met alone but not together with the others on the shared stock is listed too: then the lanes that, taken in order each on what the earlier ones left, find nothing are dropped (past 200: in the lane order that drops fewest, unless the joint search below plans them all).
- `totals.snails` = Super Sea Snails for the unlock steps (not in the cost order: the goals fix how many). `totals.rolls` = columns holding a roll; `battles` = ceil(columns elapsed incl. idle drink columns * 2.3) (`BATTLES_PER_ROLL`, one constant), elapsed = the last roll's column (the last phase's unused columns come after the plan and don't count). Idle drink columns show as gaps in the keys.
- One piece (core/src/plan_scan.cpp, plan_final.cpp): exact in the cost order at any horizon. A route is burn rolls up to a last scrub (none if the piece can finish as it is), then at most 3 kept rolls with slaps between; burns may drink too (a miss takes 2 seed steps for 1 roll, so tickets save rolls), so with rolls first a plan can spend tickets on a long burn. ~1-11 ms at horizon 20000 with 6 tickets, ~60 ms with 60, ~170 ms with 180 (Node, wasm).
- 2-3 lanes with `from + horizon` <= 200 are planned jointly (core/src/plan_joint.cpp): optimal in the cost order below unless the search hits its work cap (long burn routes over several lanes, ~0.3 s); then each lane keeps its own route (taken in lane order on the shared stock) on the best shared timeline for those routes, and the reply says `"optimal": false`.
- 2-3 lanes with `from + horizon` > 200 (core/src/plan_long.cpp, plan_merge.cpp, plan_split.cpp): when every lane can finish within 60 seed steps, first the plan a request with horizon 60 gets (the joint search over 60 steps, work cap ~0.3 s, and the horizon-60 lanes in order merged); a joint plan of at most 30 columns is proven cheapest and is the reply (90 of 90 random near 3-piece cases cost no more at horizon 20000 than at 60). Else each lane's one-piece route (as above, over the whole range), lanes in order on what the earlier ones left (when that makes a lane give way, every lane order is tried: fewest dropped, then cheapest), merged onto one timeline: every lane whose next roll matches a column's letter rolls in it, so burns of several lanes share battles; a lane's drink run is never cut, so no more tickets are used than by the routes alone. A burn drink roll (scrubbed later, no slap between) may also roll in a column of any other drink, never a plain one (its result is thrown away and the seed moves the same; its step's `d` is the drink it rolls under), when that merge is cheaper, stays within the stock of each drink and uses no more tickets in all than the routes alone. When the lanes alone want more tickets of a drink than stocked, the tickets are split too: each lane's cheapest route for every budget of tickets in all (0 up to what it used alone; past 16 budgets spread evenly), every split within the stock tried cheapest lower bound first (the most rolls of one lane; up to 32 merged), the lanes in order with their burn phases moved onto drinks the later lanes' last stretches don't need (a burn drink roll moves the seed the same whatever the drink), or scanned again on what is left. The near plans are kept when cheaper. Anything but a proven joint plan comes with `"optimal": false` (top level; absent = proven cheapest for the lanes planned). Chunks are not split between lanes beyond trying every lane order. ~20 ms mean, ~50 ms worst at horizon 20000 for 3 far pieces with 6 tickets; near goals take what horizon 60 takes, up to ~0.35 s when the joint search runs out (Node, wasm).

## Game rules the core follows
- 3 sub slots, filled left to right. A piece may carry `"openSlots": 1 | 2 | 3` (optional, default 3; min(3, stars + 1), the Path sends it from botbase's `rarity`; a sub in a slot counts it open): the rest are locked. A locked slot opens with a star upgrade (a Super Sea Snail at Murch, or buying the gear again when the shop has it): the plan opens, first, the ones a goal ability needs (fixed order: up to the last goal ability's slot; off: as many slots as goal abilities); the others stay locked and a goal `""` there counts as met. Rolls fill only open empty slots (a piece whose open slots are full doesn't roll), chunks never go into a locked slot, a scrub leaves it locked. Opening early is never worse (a piece can always sit a column out), so the timing is not searched. Exact against the brute-force reference (random openSlots in every random case).
- Rolling into an empty slot = one roll: no drink 1 seed step; with a drink 1 step and a hit on `seed % 100 <= 29`, else a 2nd step and a roll that excludes the drink. A full piece can't roll.
- Chunks fill an empty slot or replace a filled one, no seed step; a sub costs 10 / 20 / 30 for the 1st / 2nd / 3rd copy of that ability on the piece (counting the one being added).
- `"chunkBudget": N` (optional, integer 0..100000; the Path's snail): the whole plan spends at most N chunks in all, across every piece (0 = none). Exact against the brute-force reference, like the per-piece cap below.
- A piece may carry `"maxChunks": N` (optional, integer 0..1000; the Path's per-piece chunk slider): no route spends more than N chunks on that piece in all (0 = no chunks on it). The stock is still shared; plans stay exact under caps (checked against the brute-force reference).
- Scrub: every sub empty, seed unchanged. Chunks it gives back are NOT credited to the plan's stock (the amount isn't settled), so plans are conservative.
- Fixed order: slot i must end as `goal[i]`; off: the goal's abilities in any slots.
- Cost order: fewest `rolls`, then `battles`, then tickets, then chunks, then scrubs. With `"chunkRate": N` (optional, 0..1000, only with `useChunks`; the Path's chunk slider) `rolls * N + chunks` comes first: a slap is made only when it saves more than its chunks / N rolls (0 = chunks before nothing, as above). One piece and 2-3 pieces within 200 columns stay exact under a rate; a one-piece search past 1.5M states falls back to rolls first.
- A piece may carry `"chunkLean": 0 | 1 | 2` (optional, default 1; the Path's per-lane lean; only weighs with a `chunkRate`): 0 conservative, 1 normal, 2 aggressive. Under a rate the first key is `rolls * N * 2 + the sum over slaps of chunks * w`, w = 4 / 2 / 1 for the slap's piece, so all-normal is exactly the order above, aggressive halves a chunk's price on that piece and conservative doubles it. `chunkBudget` and `maxChunks` still count raw chunks, `totals.chunks` too. Exact against the brute-force reference (random leans in the rated cases).
- Snail rerolls are out of the planner for now (the UI has no step for them).
