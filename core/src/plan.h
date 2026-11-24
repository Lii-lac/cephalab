// Planner (core/API.md "plan"): one piece alone (plan_search.cpp: reachability, the sequential
// fallback), the joint plan for 1 to 3 lanes under the shared drink phases (plan_joint.cpp on
// plan_model.cpp), which lanes go into it (plan_lanes.cpp) and the reply (plan_out.cpp).
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "json.h"
#include "seedmath.h"

namespace st {

constexpr int kDrinkColumns = 8;        // one ticket = this many consecutive drink columns
constexpr double kBattlesPerRoll = 2.3;
constexpr int kMaxHorizon = 20000;      // the request's horizon
constexpr int kMaxJointHorizon = 200;  // 2-3 pieces: the joint search (plan_joint.cpp) looks this far at most
constexpr int kMaxFrom = 1000000;      // seed steps already searched
constexpr long long kMaxScanCells = 1LL << 23;  // with tickets: (from + horizon + 1) * (tickets + 1)

// Unlock: one star upgrade at Murch (a Super Sea Snail, or buying the gear again when the shop
// has it) opens the piece's next locked slot; no seed step. Only plan_write_reply makes them.
enum class ActKind : uint8_t { Roll, Drink, Slap, Scrub, Unlock };
constexpr int kSnailsPerUnlock = 1;

// A sub slot the piece's stars haven't opened and the plan leaves shut ("openSlots"): it holds
// this in PieceIn::subs and every planner slot array. It counts as filled (rolls skip it, so a
// piece whose open slots are full doesn't roll), a goal "" there is met, chunks never go on it
// and a scrub leaves it. Locked slots are always the last ones. slots[i] + 1 fits a 4-bit key.
constexpr int8_t kLocked = kAbilities;
static_assert(kLocked + 1 < 16, "slot keys pack slots[i] + 1 in 4 bits");
inline bool real_sub(int8_t a) { return a != kNoAbility && a != kLocked; }
// A scrub: every open sub empty, locked slots stay locked.
inline void scrub_slots(int8_t s[3]) {
    for (int i = 0; i < 3; ++i)
        if (s[i] != kLocked) s[i] = kNoAbility;
}
inline bool any_sub(const int8_t s[3]) { return real_sub(s[0]) || real_sub(s[1]) || real_sub(s[2]); }
inline int open_count(const int8_t s[3]) { return (s[0] != kLocked) + (s[1] != kLocked) + (s[2] != kLocked); }

struct Act {
    ActKind kind;
    int8_t slot;     // 0..2: the slot a roll filled or a slap landed on
    int8_t ability;  // what landed (rolls, slaps)
    int8_t drink;    // Drink: the drink active
    int16_t cost;    // Slap: chunks; Drink: tickets spent by this roll (0 or 1)
};

// Chunks one roll is worth for this request ("chunkRate", the Path's chunk slider): 0 = chunks cost
// nothing next to a roll (rolls first, as below); N > 0 = rolls * N * 2 + weighted chunks is
// compared first, a chunk weighing its piece's chunk_w (all normal: 2 * (rolls * N + chunks)).
inline uint32_t g_chunk_rate = 0;
inline uint64_t rate_key(uint64_t rolls, uint64_t wch) { return rolls * g_chunk_rate * 2 + wch; }

// Lexicographic: (rolls * rate * 2 + wch when a rate is set), rolls, columns elapsed (battles),
// tickets, chunks, scrubs. wch = the chunks, each times its piece's chunk_w.
struct Cost {
    uint32_t rolls = 0, el = 0, tickets = 0, chunks = 0, scrubs = 0, wch = 0;
    bool operator<(const Cost& o) const {
        if (g_chunk_rate) {
            const uint64_t a = rate_key(rolls, wch), b = rate_key(o.rolls, o.wch);
            if (a != b) return a < b;
        }
        if (rolls != o.rolls) return rolls < o.rolls;
        if (el != o.el) return el < o.el;
        if (tickets != o.tickets) return tickets < o.tickets;
        if (chunks != o.chunks) return chunks < o.chunks;
        return scrubs < o.scrubs;
    }
    bool operator==(const Cost& o) const {
        return rolls == o.rolls && el == o.el && tickets == o.tickets && chunks == o.chunks && scrubs == o.scrubs && wch == o.wch;
    }
};

struct PieceIn {
    uint32_t seed = 0;
    int brand = 0;
    int8_t subs[3] = {kNoAbility, kNoAbility, kNoAbility};  // kNoAbility = empty, kLocked = stays locked
    int8_t goal[3] = {kNoAbility, kNoAbility, kNoAbility};  // kNoAbility = anything (but filled, or locked)
    int8_t open = 3;     // "openSlots": slots open in the request (stars + 1, at most 3)
    int8_t unlocks = 0;  // star upgrades the plan makes first: slots open .. open + unlocks - 1 (subs empty there)
    int max_chunks = -1;  // "maxChunks": at most this many chunks spent on this piece in all (-1 = no cap; the Path's per-piece slider)
    int8_t lean = 1;      // "chunkLean": 0 conservative, 1 normal, 2 aggressive (the Path's per-lane lean; with a rate only)
};
// What one chunk slapped on this piece weighs in rate_key: 4 conservative, 2 normal, 1 aggressive.
inline uint32_t chunk_w(const PieceIn& p) { return p.lean == 0 ? 4u : p.lean == 2 ? 1u : 2u; }
// A slap of c chunks on a piece that has spent `spent` would go past its cap.
inline bool over_cap(const PieceIn& p, int spent, int c) { return p.max_chunks >= 0 && spent + c > p.max_chunks; }

struct PlanOpts {
    bool fixed_order = true, use_chunks = false, use_drinks = false;
    int horizon = 0;  // max seed steps a route may advance (past from)
    int from = 0;     // one piece: routes ending within from seed steps are already ruled out
    int ticket_cap = -1;  // plan_scan only: >= 0 = at most this many tickets in all (any drinks stocked)
    int max_rolls = -1;   // plan_scan only: >= 0 = no route of more rolls (unreachable when the cheapest has more)
    uint16_t goal_mask = 0;  // abilities some piece of the request wants (plan_search: not interchangeable fillers)
    int chunk_rate = 0;   // "chunkRate": chunks one roll is worth (0 = chunks before nothing; see g_chunk_rate)
};

// What is left to spend: chunks and tickets by ability.
struct Stock {
    int32_t chunks[kAbilities] = {};
    int32_t tickets[kAbilities] = {};
    int32_t budget = -1;  // "chunkBudget": chunks the whole plan may spend in all, what is left of it (-1 = no budget)
};
inline int chunks_in(const Stock& s) { int t = 0; for (int a = 0; a < kAbilities; ++a) t += s.chunks[a]; return t; }
// A slap of c chunks by a piece that has spent `spent` would go past what is left of the plan's budget.
inline bool over_budget(const Stock& s, int spent, int c) { return s.budget >= 0 && spent + c > s.budget; }
// Takes a route's spending off what is left (its chunks, tickets and the budget).
inline void take(Stock& left, const Stock& used) {
    for (int a = 0; a < kAbilities; ++a) left.chunks[a] -= used.chunks[a], left.tickets[a] -= used.tickets[a];
    if (left.budget >= 0) left.budget -= chunks_in(used);
}
inline bool fits_in(const Stock& used, const Stock& left) {
    for (int a = 0; a < kAbilities; ++a)
        if (used.chunks[a] > left.chunks[a] || used.tickets[a] > left.tickets[a]) return false;
    return left.budget < 0 || chunks_in(used) <= left.budget;
}

struct PieceOut {
    bool reachable = false;
    std::vector<Act> acts;
    Cost cost;
    Stock used;
};

// No cost with at least lb rolls (and any chunks) is below best.
inline bool rolls_past(uint32_t lb, const Cost& best) {
    return g_chunk_rate ? rate_key(lb, 0) > rate_key(best.rolls, best.wch) : lb > best.rolls;
}

// True when slots meet goal (every slot filled; fixed order: slot i == goal[i] unless anything).
bool piece_done(const int8_t slots[3], const int8_t goal[3], bool fixed_order);

// Cheapest route for one piece within opts.horizon seed steps, on the stock given, its drink rolls
// in phases as in a plan of its own (a plain roll after a phase still open waits it out). Optimal
// and deterministic (Dijkstra in cost order, ties in a fixed expansion order).
// reach_only: drinks without tickets running out or phases, a quick test that the goal can be met.
PieceOut plan_piece(const PieceIn& in, const BrandRolls& br, const PlanOpts& opts, const Stock& stock,
                    bool reach_only = false);

// A parsed plan request.
struct PlanReq {
    std::vector<std::string> rows;
    std::vector<PieceIn> pieces;
    PlanOpts opts;
    Stock stock;
};

// A plan over the joint timeline. word = one letter per column holding a roll (kNoAbility =
// plain, else the drink of its phase), in time order; idle drink columns are implied (see
// word_columns). acts[l] = lane l's acts; at[l][i] = the word index of act i when it is a roll,
// else -1.
struct JointPlan {
    std::vector<int8_t> word;
    std::vector<std::vector<Act>> acts;
    std::vector<std::vector<int>> at;
};

// 1-based column of every word letter, idle columns included: a phase is kDrinkColumns columns
// of one drink; a letter that ends a phase early leaves its unused columns idle before it (the
// last phase's unused columns are not counted: the plan is over). Returns the tickets (phases).
int word_columns(const std::vector<int8_t>& word, std::vector<int>& col);

enum class JointStatus { Found, None, Cap };

// Jointly optimal plan for pieces each reachable alone: fewest columns holding a roll, then
// battles, tickets, chunks, scrubs, trying lo..hi columns. Cap = work_cap was hit first.
JointStatus plan_joint(const std::vector<PieceIn>& pieces, const PlanOpts& opts, const Stock& stock, int lo,
                       int hi, long work_cap, JointPlan& out);

// Plans every lane (plan_lanes.cpp) and writes the ok:true reply.
void plan_write(const PlanReq& req, std::string& out);

// One piece alone (plan_scan.cpp, plan_final.cpp): the cheapest route ending within from +
// horizon seed steps (past from, when from > 0), burns of any length included. Optimal in the
// cost order and deterministic.
PieceOut plan_scan(const PieceIn& in, const PlanOpts& opts, const Stock& stock);
void plan_write_one(const PlanReq& req, std::string& out);

// Writes the ok:true reply for a plan of every lane (plan_out.cpp). searched_to goes on the
// unreachable lanes; collapse: consecutive burn rolls become one step with "times"; optimal false
// adds "optimal":false (the plan is not proven cheapest).
void plan_write_reply(const PlanReq& req, const JointPlan& plan, const std::vector<int>& unreachable,
                      int searched_to, bool collapse, std::string& out, bool optimal = true);

// A burn drink roll (scrubbed later, no slap in between) may roll under any drink's phase: its
// result is thrown away and a drink roll moves the seed the same whatever the drink. In a merge
// its letter is kAnyDrink (never a column's letter): it rolls in any drink column, never a plain one.
constexpr int8_t kAnyDrink = kNoAbility - 2;
std::vector<char> plan_wild(const std::vector<Act>& acts);  // [i]: act i is such a roll
// A route's roll letters: kNoAbility = plain, else the drink (wild: kAnyDrink for plan_wild rolls).
std::vector<int8_t> plan_route_word(const PieceOut& o, bool wild);

// Fixed routes (outs[lanes[k]], one per lane) on one timeline (plan_lanes.cpp). concat: each in
// turn; assign: the acts and, for a given word, every lane rolls in each column whose letter is
// its next roll's (wild: a kAnyDrink roll in any drink column, taking its drink; plan_write_reply
// redoes what it lands); merge_routes: the cheapest word (exact, small routes only; burn drink
// rolls take other drinks when that is cheaper and uses no more tickets than the routes alone),
// false if none fits the ticket stock.
void plan_concat(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, JointPlan& jp);
void plan_assign(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, const std::vector<int8_t>& word,
                 JointPlan& jp, bool wild = false);
bool plan_merge_routes(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, const Stock& stock,
                       JointPlan& jp);

// 2-3 pieces with from + horizon > kMaxJointHorizon (plan_long.cpp): each lane's one-piece scan
// over 0..from + horizon in lane order on the shared stock, merged onto one timeline (or the
// joint plan over 60 seed steps when that is cheaper).
void plan_write_long(const PlanReq& req, std::string& out);

// fn "plan": reads the request object, writes the whole reply (ok:true or ok:false) into out.
void plan_reply(const json::Doc& d, uint32_t obj, std::string& out);

}  // namespace st
