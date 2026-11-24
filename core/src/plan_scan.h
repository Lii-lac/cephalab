// One piece over long horizons (core/API.md "plan", one piece). A route is either a last stretch
// from the piece as it is (no scrub), or burn rolls (scrubbed whenever the piece is full) up to a
// last scrub, then a last stretch from empty: at most 3 rolls, slaps between, no scrub.
// plan_scan.cpp: the burn prefix (a DP over seed offsets and tickets) and the scan over offsets;
// plan_final.cpp: the window (what each offset rolls), the relaxed bound and the last stretch.
#pragma once
#include <cstdint>
#include <vector>

#include "plan.h"

namespace st {

constexpr int kRelaxInf = 99;
constexpr int8_t kFreeDrink = -2;  // an open phase whose drink is chosen by the roll that continues it

// What the piece rolls at each seed offset and the relaxed rolls-to-go bound (no scrub).
class Window {
public:
    Window(const PieceIn& in, const PlanOpts& opts, const Stock& stock);
    // Fewest rolls to finish from (t, slots) without a scrub, relaxed: any stocked drink on any
    // roll; an ability can end on m slots by slaps when 10 + 20 + .. + 10m chunks of it are
    // stocked (the k-th last slap of it sees the k-1 before), fill slaps free. kRelaxInf = never.
    int relax(int t, const int8_t slots[3]) const;
    bool hit(int t) const { return seeds[t + 1] % 100 <= 29; }  // a drink roll at t takes 1 step

    PieceIn in;
    bool fixed, chunks;
    int H, from, lo;              // reach = from + horizon; offsets below lo can't end past from
    Stock stock;                  // chunks (only when chunks are on), tickets (only when drinks are on)
    int B = 0;                    // tickets owned in all
    std::vector<int8_t> drinks;   // drinks with tickets
    std::vector<uint32_t> seeds;  // [0..H]
    BrandRolls br;

private:
    bool stk(int a) const { return chunks && stock.chunks[a] >= 10; }
    int rf(int i, int t, int8_t used[kAbilities]) const;
    int rr(int i, int t, int rem[3]) const;
    std::vector<uint16_t> m1_, m2_;  // [t - lo]: abilities a roll at t can land taking 1 / 2 steps
    bool any_stk_ = false;
    int8_t max_slaps_[kAbilities] = {};
    int nug_ = 0;
    int8_t ug_[3] = {}, need_[3] = {};  // order off: goal abilities, copies that must be rolled
    int open_ = 3;                      // slots not locked (kLocked ones are the last)
};

// Where the last stretch starts.
struct FinalStart {
    int t = 0;
    int8_t slots[3] = {kNoAbility, kNoAbility, kNoAbility};
    int cont_u = 0;        // > 0: an open phase (drink free) with this many columns left; the first roll continues it
    bool reserve = false;  // a partial phase sits just before: it needs a drink other than the first roll's
    bool gate = false;     // feasibility only: drinks without tickets or phases (a superset of every start at t)
    int free_left = 0;     // tickets the stretch may still start
    Cost base;             // the prefix's cost (scrubs included)
};

struct FinalOut {
    Cost cost;  // base + the stretch
    std::vector<Act> acts;
    uint8_t spent_t[kAbilities] = {};  // tickets by drink: the stretch's phases + the continued one
    uint16_t spent_c[kAbilities] = {};
    int8_t cont = kNoAbility;   // drink of the continued phase
    int8_t first = kNoAbility;  // drink of the stretch's first roll (kNoAbility: plain or none)
};

// Cheapest last stretch from s whose total cost is below bound; false if none.
bool plan_final(const Window& w, const FinalStart& s, const Cost& bound, FinalOut& out);

}  // namespace st
