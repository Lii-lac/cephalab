// 2-3 pieces over long horizons (plan_long.h): fixed routes onto one timeline, the exact merge
// (plan_lanes.cpp) for short routes, else a greedy merge that shares plain burns and phases.
#include <algorithm>

#include "plan_long.h"

namespace st {

namespace {

constexpr long kExactStates = 20000;  // plan_merge_routes only while prod (route rolls + 1) is at most this

// Column by column: a lane in the middle of a drink run keeps its phase going (so no lane's run
// is cut and the word needs no more tickets than the routes did alone); else an open phase that
// some lane can use goes on; else the drink most lanes want next (drink runs are short, the plain
// lanes wait for them), first lane first on a tie; else plain. Every lane whose next roll has the
// column's letter rolls in it. A kAnyDrink roll (plan_route_word) rolls in any drink column and
// wants the drink the next kept drink roll of any lane needs soonest, else its own (orig, the
// route's word), else any, whichever still has a ticket.
std::vector<int8_t> greedy(const std::vector<std::vector<int8_t>>& words, const std::vector<std::vector<int8_t>>& orig,
                           const Stock& stock) {
    const size_t n = words.size();
    std::vector<size_t> pos(n, 0);
    std::vector<char> rolled(n, 0);
    std::vector<int8_t> W;
    int8_t run = kNoAbility;
    int u = 0, used[kAbilities] = {};
    std::vector<std::vector<size_t>> kept(n);  // kept[k][i]: lane k's first drink roll that isn't kAnyDrink at or after i
    for (size_t k = 0; k < n; ++k) {
        kept[k].assign(words[k].size() + 1, words[k].size());
        for (size_t i = words[k].size(); i-- > 0;) kept[k][i] = words[k][i] >= 0 ? i : kept[k][i + 1];
    }
    auto next = [&](size_t k) { return pos[k] < words[k].size() ? words[k][pos[k]] : static_cast<int8_t>(kNoAbility - 1); };
    auto fits = [](int8_t l, int8_t x) { return l == x || (l == kAnyDrink && x >= 0); };
    auto has = [&](int d) { return (d == run && u < kDrinkColumns) || used[d] < stock.tickets[d]; };
    auto pick = [&](size_t k) {
        size_t soon = SIZE_MAX;
        int8_t d = kNoAbility;
        for (size_t j = 0; j < n; ++j) {
            const size_t i = kept[j][pos[j]];
            if (i < words[j].size() && i - pos[j] < soon) soon = i - pos[j], d = words[j][i];
        }
        if (d >= 0 && has(d)) return d;
        if (has(orig[k][pos[k]])) return orig[k][pos[k]];
        for (int e = 0; e < kAbilities; ++e)
            if (has(e)) return static_cast<int8_t>(e);
        return orig[k][pos[k]];
    };
    for (;;) {
        bool left = false, chosen = false;
        int8_t x = kNoAbility;
        for (size_t k = 0; k < n; ++k) left |= pos[k] < words[k].size();
        if (!left) break;
        if (!W.empty() && W.back() != kNoAbility)
            for (size_t k = 0; k < n && !chosen; ++k)
                if (rolled[k] && next(k) == W.back()) x = W.back(), chosen = true;
        if (!chosen && run != kNoAbility && u < kDrinkColumns)
            for (size_t k = 0; k < n && !chosen; ++k)
                if (fits(next(k), run)) x = run, chosen = true;
        if (!chosen) {
            int best = 0;
            for (size_t k = 0; k < n; ++k) {
                const int8_t d = next(k) == kAnyDrink ? pick(k) : next(k);
                if (d < 0) continue;
                int c = 0;
                for (size_t j = 0; j < n; ++j) c += fits(next(j), d);
                if (c > best) best = c, x = d;
            }
        }
        if (x != kNoAbility && run != kNoAbility && u < kDrinkColumns && x == run) {
            ++u;
        } else {
            run = x;
            u = x == kNoAbility ? 0 : 1;
            if (x != kNoAbility) ++used[x];
        }
        for (size_t k = 0; k < n; ++k) {
            rolled[k] = fits(next(k), x);
            if (rolled[k]) ++pos[k];
        }
        W.push_back(x);
    }
    return W;
}

// The word's (rolls, columns elapsed, tickets); false when it needs more tickets of a drink than stocked.
bool word_cost(const std::vector<int8_t>& w, const Stock& stock, uint32_t c[3]) {
    std::vector<int> col;
    c[0] = static_cast<uint32_t>(w.size());
    c[2] = static_cast<uint32_t>(word_columns(w, col));
    c[1] = w.empty() ? 0 : static_cast<uint32_t>(col.back());
    int used[kAbilities] = {}, run = kNoAbility, u = 0;
    for (int8_t x : w) {
        if (x != kNoAbility && x == run && u < kDrinkColumns) {
            ++u;
            continue;
        }
        run = x, u = 1;
        if (x != kNoAbility && ++used[x] > stock.tickets[x]) return false;
    }
    return true;
}

}  // namespace

Cost long_cost(const JointPlan& jp, const std::vector<PieceIn>& pieces, const std::vector<int>& lanes) {
    Cost c;
    std::vector<int> col;
    c.rolls = static_cast<uint32_t>(jp.word.size());
    c.tickets = static_cast<uint32_t>(word_columns(jp.word, col));
    c.el = col.empty() ? 0 : static_cast<uint32_t>(col.back());
    for (size_t k = 0; k < jp.acts.size(); ++k)
        for (const Act& a : jp.acts[k]) {
            if (a.kind == ActKind::Slap) c.chunks += a.cost, c.wch += a.cost * chunk_w(pieces[lanes[k]]);
            if (a.kind == ActKind::Scrub) c.scrubs++;
        }
    return c;
}

void long_merge(LongSeq& s, const std::vector<PieceIn>& pieces, const Stock& stock, bool exact) {
    std::vector<std::vector<int8_t>> words, wild;
    long states = 1;
    bool any = false;
    uint32_t own = 0;  // the routes' tickets alone
    for (int i : s.kept) {
        words.push_back(plan_route_word(s.outs[i], false));
        wild.push_back(plan_route_word(s.outs[i], true));
        any |= wild.back() != words.back();
        std::vector<int> col;
        own += static_cast<uint32_t>(word_columns(words.back(), col));
        states = std::min(kExactStates + 1, states * static_cast<long>(words.back().size() + 1));
    }
    if (s.kept.size() >= 2 && (exact || states <= kExactStates) && plan_merge_routes(s.outs, s.kept, stock, s.jp)) {
        s.cost = long_cost(s.jp, pieces, s.kept);
        return;
    }
    plan_concat(s.outs, s.kept, s.jp);
    if (s.kept.size() >= 2) {
        uint32_t a[3], b[3];
        word_cost(s.jp.word, stock, b);
        const std::vector<int8_t> W = greedy(words, words, stock);
        if (word_cost(W, stock, a) && std::lexicographical_compare(a, a + 3, b, b + 3)) {
            plan_assign(s.outs, s.kept, W, s.jp);
            std::copy(a, a + 3, b);
        }
        // Burn drink rolls under any drink: kept when cheaper, within the stock and the routes' own tickets.
        if (any) {
            const std::vector<int8_t> V = greedy(wild, words, stock);
            if (word_cost(V, stock, a) && a[2] <= own && std::lexicographical_compare(a, a + 3, b, b + 3))
                plan_assign(s.outs, s.kept, V, s.jp, true);
        }
    }
    s.cost = long_cost(s.jp, pieces, s.kept);
}

}  // namespace st
