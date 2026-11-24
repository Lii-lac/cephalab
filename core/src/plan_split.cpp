// 2-3 pieces over long horizons (plan_long.h): the tickets split between lanes, so that the first
// lane in order can't eat every ticket while the others burn thousands of plain rolls.
#include <algorithm>
#include <map>
#include <string>

#include "plan_long.h"

namespace st {

namespace {

constexpr int kBudgets = 16;  // ticket budgets per lane below its alone usage (spread evenly past that)
constexpr int kMerges = 32;   // splits merged at most
constexpr int kRescans = 12;  // routes scanned again on what the earlier lanes left

int tickets(const Stock& s) {
    int n = 0;
    for (int a = 0; a < kAbilities; ++a) n += s.tickets[a];
    return n;
}

bool fits(const Stock& used, const Stock& left) { return fits_in(used, left); }

// A route's drink runs (plan_scan.cpp's acts): the burn runs before its last scrub, and what its
// last stretch needs as it is.
struct Burns {
    int scrub = -1;          // the last scrub's act index
    int8_t x = kNoAbility;   // the stretch's first drink
    int need[kAbilities] = {};  // tickets by drink of the stretch (with the burn run it goes on with)
    std::vector<int> start;  // act index of each other burn run's first roll
};

Burns burns_of(const PieceOut& r) {
    Burns b;
    for (size_t j = 0; j < r.acts.size(); ++j)
        if (r.acts[j].kind == ActKind::Scrub) b.scrub = static_cast<int>(j);
    bool cont = false;  // the stretch's first drink goes on with the last burn run
    for (size_t j = b.scrub + 1; j < r.acts.size(); ++j) {
        const Act& a = r.acts[j];
        if (a.kind != ActKind::Drink) continue;
        if (b.x == kNoAbility) b.x = a.drink, cont = a.cost == 0;
        b.need[a.drink] += a.cost;
    }
    for (int j = 0; j < b.scrub; ++j)
        if (r.acts[j].kind == ActKind::Drink && r.acts[j].cost == 1) b.start.push_back(j);
    if (cont && !b.start.empty()) b.need[r.acts[b.start.back()].drink]++, b.start.pop_back();
    return b;
}

// The route's burn runs (but one the last stretch goes on with) moved onto drinks of left: a burn
// drink roll only moves the seed (a miss takes 2 steps whatever the drink) and its result is
// scrubbed, so the route keeps its cost. The run just before the stretch keeps clear of the
// stretch's first drink when it was (a phase of its own). False when the stretch's own tickets
// or the runs don't fit in left (r is then unchanged).
bool redrink(const PieceIn& in, const Stock& left, PieceOut& r) {
    const Burns bu = burns_of(r);
    const int scrub = bu.scrub;
    const int8_t x = bu.x;
    const std::vector<int>& start = bu.start;
    int rem[kAbilities];
    for (int a = 0; a < kAbilities; ++a) rem[a] = left.tickets[a] - bu.need[a];
    std::vector<int8_t> drink(start.size());
    for (size_t p = 0; p < start.size(); ++p) {
        const int8_t old = r.acts[start[p]].drink;
        const bool clear = p + 1 == start.size() && old != x;  // keep a phase of its own
        int8_t d = rem[old] > 0 ? old : kNoAbility;
        for (int e = 0; e < kAbilities && d == kNoAbility; ++e)
            if (rem[e] > 0 && !(clear && e == x)) d = static_cast<int8_t>(e);
        if (d == kNoAbility || (clear && d == x)) return false;
        drink[p] = d, rem[d]--;
    }
    for (int a = 0; a < kAbilities; ++a)
        if (rem[a] < 0) return false;
    const BrandRolls br(in.brand);
    uint32_t seed = in.seed;
    for (int j = 0, p = -1; j < scrub; ++j) {
        Act& a = r.acts[j];
        if (a.kind == ActKind::Roll) seed = roll(br, seed, kNoAbility).seed;
        if (a.kind != ActKind::Drink) continue;
        if (a.cost == 1) ++p;
        if (p >= 0 && p < static_cast<int>(drink.size())) a.drink = drink[p];
        const RollResult rr = roll(br, seed, a.drink);
        a.ability = static_cast<int8_t>(rr.ability), seed = rr.seed;
    }
    for (int a = 0; a < kAbilities; ++a) r.used.tickets[a] = left.tickets[a] - rem[a];
    return true;
}

}  // namespace

void long_split(const std::vector<PieceIn>& pieces, const PlanOpts& o, const Stock& stock, const std::vector<int>& live,
                const std::vector<PieceOut>& alone, LongSeq& best) {
    const size_t L = live.size();
    const int T = tickets(stock);
    if (L < 2 || !o.use_drinks || T == 0) return;
    bool short_of = false;  // the lanes alone want more tickets of some drink than stocked
    for (int a = 0; a < kAbilities; ++a) {
        int want = 0;
        for (int i : live) want += alone[i].used.tickets[a];
        short_of |= want > stock.tickets[a];
    }
    if (!short_of) return;
    // Each lane's cheapest route on all the stock for each budget of tickets in all, 0 .. its
    // alone usage (a budget whose route uses fewer costs the same as a smaller one: skipped).
    // Unreachable on a budget = dropped, no tickets. A route of more rolls than the best plan so
    // far is of no use to a split that plans as many lanes.
    PlanOpts ob = o;
    if (best.dropped.empty() && !g_chunk_rate) ob.max_rolls = static_cast<int>(best.cost.rolls);  // a rate: fewer chunks may pay for more rolls
    std::vector<std::vector<int>> cap(L);
    std::vector<std::vector<PieceOut>> route(L);
    std::vector<std::vector<std::vector<int>>> need(L);  // tickets by drink each route's stretch needs
    for (size_t k = 0; k < L; ++k) {
        const int i = live[k], u = tickets(alone[i].used);
        for (int s = 0; s <= kBudgets && s <= u; ++s) {
            const int b = s == kBudgets ? u : u <= kBudgets ? s : s * u / kBudgets;
            PlanOpts oc = ob;
            oc.ticket_cap = b;
            PieceOut r = b == u ? alone[i] : plan_scan(pieces[i], oc, stock);
            if (r.reachable ? tickets(r.used) == b : b == 0) {
                cap[k].push_back(r.reachable ? b : 0);
                const Burns bu = r.reachable ? burns_of(r) : Burns{};
                need[k].emplace_back(bu.need, bu.need + kAbilities);
                route[k].push_back(std::move(r));
            }
            if (b == u) break;
        }
    }
    // Every split within the tickets, by (lanes dropped, most rolls of one lane, rolls in all):
    // no merged plan has fewer rolls than one of its lanes.
    struct Split {
        size_t dropped;
        uint32_t rolls, sum;
        int idx[3];
    };
    std::vector<Split> all;
    int idx[3] = {};
    for (;;) {
        Split sp{0, 0, 0, {idx[0], idx[1], idx[2]}};
        int used = 0;
        for (size_t k = 0; k < L; ++k) {
            const PieceOut& r = route[k][idx[k]];
            used += cap[k][idx[k]];
            if (!r.reachable) sp.dropped++;
            else sp.rolls = std::max(sp.rolls, r.cost.rolls), sp.sum += r.cost.rolls;
        }
        if (used <= T) all.push_back(sp);
        size_t k = 0;
        while (k < L && ++idx[k] == static_cast<int>(route[k].size())) idx[k++] = 0;
        if (k == L) break;
    }
    std::stable_sort(all.begin(), all.end(), [](const Split& a, const Split& b) {
        if (a.dropped != b.dropped) return a.dropped < b.dropped;
        return a.rolls != b.rolls ? a.rolls < b.rolls : a.sum < b.sum;
    });
    // Lanes in index order, each its budget's route on what the earlier ones left: as it is, its
    // burn phases on other drinks, or scanned again there within its budget; then merged.
    std::map<std::string, PieceOut> rescans;
    int merges = 0;
    for (const Split& sp : all) {
        if (merges == kMerges || sp.dropped > best.dropped.size() ||
            (sp.dropped == best.dropped.size() && rolls_past(sp.rolls, best.cost)))
            break;
        LongSeq s;
        s.outs.assign(pieces.size(), PieceOut{});
        Stock left = stock;
        bool skip = false;
        // Lane k scanned again within its budget on at (cached; false once kRescans are spent).
        auto rescan = [&](size_t k, const Stock& at, PieceOut& out) {
            std::string key(reinterpret_cast<const char*>(&at), sizeof at);
            key += static_cast<char>(k), key += std::to_string(cap[k][sp.idx[k]]);
            auto it = rescans.find(key);
            if (it == rescans.end()) {
                if (static_cast<int>(rescans.size()) == kRescans) return false;
                PlanOpts oc = ob;
                oc.ticket_cap = cap[k][sp.idx[k]];
                it = rescans.emplace(key, plan_scan(pieces[live[k]], oc, at)).first;
            }
            out = it->second;
            return true;
        };
        for (size_t k = 0; k < L && !skip; ++k) {
            const int i = live[k];
            const PieceOut& r = route[k][sp.idx[k]];
            // First on what is left less the tickets the later lanes' stretches need as they are
            // (scanned again there when that costs the split no more rolls), then on what is left.
            Stock spare = left;
            bool tight = false;
            for (size_t j = k + 1; j < L; ++j)
                for (int a = 0; a < kAbilities; ++a) tight |= (spare.tickets[a] -= need[j][sp.idx[j]][a]) < 0;
            s.outs[i] = r;
            bool ok = !r.reachable;
            for (int pass = tight ? 1 : 0; pass < 2 && !ok; ++pass) {
                const Stock& at = pass == 0 ? spare : left;
                s.outs[i] = r;
                Stock chunks = r.used;
                std::fill(chunks.tickets, chunks.tickets + kAbilities, 0);
                ok = fits(r.used, at) || (fits(chunks, at) && redrink(pieces[i], at, s.outs[i]));
                PieceOut x;
                if (!ok && pass == 0 && rescan(k, at, x) && x.reachable && x.cost.rolls <= sp.rolls)
                    s.outs[i] = std::move(x), ok = true;
            }
            if (!ok && !rescan(k, left, s.outs[i])) {
                skip = true;
                break;
            }
            if (!s.outs[i].reachable) {
                s.dropped.push_back(i);
                continue;
            }
            s.kept.push_back(i);
            take(left, s.outs[i].used);
        }
        if (skip) continue;
        ++merges;
        long_merge(s, pieces, stock);
        if (long_better(s, best)) best = std::move(s);
    }
}

}  // namespace st
