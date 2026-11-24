// One piece over long horizons: the window, the relaxed bound and the last stretch (plan_scan.h).
#include <algorithm>
#include <cstring>
#include <queue>
#include <unordered_map>

#include "plan_scan.h"

namespace st {

Window::Window(const PieceIn& p, const PlanOpts& opts, const Stock& s)
    : in(p), fixed(opts.fixed_order), chunks(opts.use_chunks), H(opts.from + opts.horizon), from(opts.from),
      lo(std::max(0, opts.from - 6)), br(p.brand), open_(open_count(p.subs)) {
    for (int a = 0; a < kAbilities; ++a) {
        stock.chunks[a] = chunks ? s.chunks[a] : 0;
        stock.budget = s.budget;
        stock.tickets[a] = opts.use_drinks ? s.tickets[a] : 0;
        if (stock.tickets[a] > 0) drinks.push_back(static_cast<int8_t>(a)), B += stock.tickets[a];
        any_stk_ |= stk(a);
        while (chunks && max_slaps_[a] < 3 && 5 * (max_slaps_[a] + 1) * (max_slaps_[a] + 2) <= stock.chunks[a]) ++max_slaps_[a];
    }
    if (opts.ticket_cap == 0) {  // no tickets at all: as if drinks were off
        drinks.clear(), B = 0;
        for (int a = 0; a < kAbilities; ++a) stock.tickets[a] = 0;
    } else if (opts.ticket_cap > 0) {
        B = std::min(B, opts.ticket_cap);  // the DP counts tickets in all; each drink keeps its own stock
    }
    seeds.resize(H + 1);
    seeds[0] = p.seed;
    for (int t = 1; t <= H; ++t) seeds[t] = next_seed(seeds[t - 1]);
    m1_.assign(H - lo + 1, 0);
    m2_.assign(H - lo + 1, 0);
    for (int t = lo; t < H; ++t) {
        uint16_t a = static_cast<uint16_t>(1u << roll(br, seeds[t], kNoAbility).ability), b = 0;
        for (int8_t d : drinks) {
            RollResult r = roll(br, seeds[t], d);
            if (r.drink_hit) a |= static_cast<uint16_t>(1u << d);
            else if (t + 2 <= H) b |= static_cast<uint16_t>(1u << r.ability);
        }
        m1_[t - lo] = a, m2_[t - lo] = b;
    }
    for (int g = 0; g < 3 && !fixed; ++g) {
        const int a = p.goal[g];
        if (a == kNoAbility) continue;
        int j = 0;
        while (j < nug_ && ug_[j] != a) ++j;
        if (j == nug_) ug_[nug_++] = static_cast<int8_t>(a);
        need_[j]++;
    }
    for (int j = 0; j < nug_; ++j) need_[j] = static_cast<int8_t>(std::max(0, need_[j] - max_slaps_[ug_[j]]));
}

// Fixed order, slot i on: chunk it to what it needs (skip), or roll what it needs (anything, for
// ""), or roll anything and chunk it over. used[a] = slots that end as a by a slap.
int Window::rf(int i, int t, int8_t used[kAbilities]) const {
    if (i >= open_) return 0;  // the rest are locked (goal "")
    const int g = in.goal[i];
    const bool fix = g == kNoAbility ? any_stk_ : used[g] < max_slaps_[g];
    int best = kRelaxInf;
    if (fix) {
        if (g != kNoAbility) used[g]++;
        best = rf(i + 1, t, used);
        if (g != kNoAbility) used[g]--;
    }
    for (int s = 1; s <= 2; ++s) {
        if (t + s > H) break;
        const uint16_t m = s == 1 ? m1_[t - lo] : m2_[t - lo];
        if (!m) continue;
        if (g == kNoAbility || (m >> g & 1)) {
            best = std::min(best, 1 + rf(i + 1, t + s, used));
        } else if (fix) {
            used[g]++;
            best = std::min(best, 1 + rf(i + 1, t + s, used));
            used[g]--;
        }
    }
    return best;
}

// Order off, slot i on: rem[j] copies of goal ability ug_[j] still to roll (more than slaps can give).
int Window::rr(int i, int t, int rem[3]) const {
    int left = 0;
    for (int j = 0; j < nug_; ++j) left += rem[j];
    if (left > open_ - i) return kRelaxInf;
    if (i >= open_) return 0;
    int best = any_stk_ ? rr(i + 1, t, rem) : kRelaxInf;
    for (int s = 1; s <= 2; ++s) {
        if (t + s > H) break;
        const uint16_t m = s == 1 ? m1_[t - lo] : m2_[t - lo];
        if (!m) continue;
        best = std::min(best, 1 + rr(i + 1, t + s, rem));
        for (int j = 0; j < nug_; ++j) {
            if (!rem[j] || !(m >> ug_[j] & 1)) continue;
            rem[j]--;
            best = std::min(best, 1 + rr(i + 1, t + s, rem));
            rem[j]++;
        }
    }
    return best;
}

int Window::relax(int t, const int8_t s[3]) const {
    int fe = 0;
    while (fe < open_ && s[fe] != kNoAbility) ++fe;  // the locked slots (the last ones) are never rolled
    if (fixed) {
        int8_t used[kAbilities] = {};
        for (int i = 0; i < fe; ++i) {
            const int g = in.goal[i];
            if (g != kNoAbility && s[i] != g && ++used[g] > max_slaps_[g]) return kRelaxInf;
        }
        return rf(fe, t, used);
    }
    int rem[3] = {0, 0, 0};
    for (int j = 0; j < nug_; ++j) {
        rem[j] = need_[j];
        for (int i = 0; i < fe; ++i) rem[j] -= s[i] == ug_[j];
        rem[j] = std::max(rem[j], 0);
    }
    return rr(fe, t, rem);
}

namespace {

struct Node {
    Cost cost;  // the stretch alone
    int32_t parent;
    Act act;
    int32_t t;
    int8_t slots[3];
    int8_t run, left;  // phase drink (kNoAbility none, kFreeDrink not chosen yet), columns left
    int8_t first;      // first roll's drink: -3 no roll yet, kNoAbility plain
    uint16_t spent_c[kAbilities];
    uint8_t spent_t[kAbilities];
};

uint64_t group_key(const Node& n, bool reserve) {
    uint64_t k = static_cast<uint32_t>(n.t);
    for (int i = 0; i < 3; ++i) k = (k << 4) | static_cast<uint64_t>(n.slots[i] + 1);
    k = (k << 5) | static_cast<uint64_t>(n.run + 2);
    k = (k << 4) | static_cast<uint64_t>(n.left);
    if (reserve) k = (k << 5) | static_cast<uint64_t>(n.first + 3);
    return k;
}

bool spends_less(const Node& a, const Node& b) {
    for (int i = 0; i < kAbilities; ++i)
        if (a.spent_c[i] > b.spent_c[i] || a.spent_t[i] > b.spent_t[i]) return false;
    return true;
}

Cost add(const Cost& a, const Cost& b) {
    return {a.rolls + b.rolls, a.el + b.el, a.tickets + b.tickets, a.chunks + b.chunks, a.scrubs + b.scrubs, a.wch + b.wch};
}

struct QItem {
    Cost f;
    uint64_t seq;
    int32_t node;
    bool operator>(const QItem& o) const {
        if (!(f == o.f)) return o.f < f;
        return seq > o.seq;
    }
};

}  // namespace

// A* over the stretch's states in cost order (rolls, columns, tickets, chunks), with relax() as
// the bound; dominance as in plan_search.cpp. The first goal state taken off the queue is optimal.
bool plan_final(const Window& w, const FinalStart& s, const Cost& bound, FinalOut& out) {
    std::vector<Node> nodes;
    std::unordered_map<uint64_t, std::vector<int32_t>> settled;
    std::priority_queue<QItem, std::vector<QItem>, std::greater<QItem>> q;
    uint64_t seq = 0;
    Node root{};
    root.parent = -1;
    root.t = s.t;
    std::memcpy(root.slots, s.slots, 3);
    root.run = s.cont_u > 0 ? kFreeDrink : static_cast<int8_t>(kNoAbility);
    root.left = static_cast<int8_t>(s.cont_u);
    root.first = -3;
    auto fcost = [&](const Node& n, int h) {
        Cost c = add(s.base, n.cost);
        c.rolls += h, c.el += h;
        return c;
    };
    auto dominated = [&](const Node& n) {
        auto it = settled.find(group_key(n, s.reserve));
        if (it == settled.end()) return false;
        for (int32_t x : it->second)
            if (spends_less(nodes[x], n)) return true;
        return false;
    };
    auto push = [&](const Node& n) {
        const int h = w.relax(n.t, n.slots);
        if (h >= kRelaxInf || dominated(n)) return;
        const Cost f = fcost(n, h);
        if (!(f < bound)) return;
        nodes.push_back(n);
        q.push({f, seq++, static_cast<int32_t>(nodes.size() - 1)});
    };
    push(root);
    const int8_t* goal = w.in.goal;
    while (!q.empty()) {
        const int32_t idx = q.top().node;
        q.pop();
        if (dominated(nodes[idx])) continue;
        settled[group_key(nodes[idx], s.reserve)].push_back(idx);
        const Node cur = nodes[idx];
        if (piece_done(cur.slots, goal, w.fixed)) {
            bool ok = w.from == 0 || cur.t > w.from;
            if (ok && s.reserve) {
                ok = false;  // some other drink must still have a ticket for the partial phase
                for (int8_t e : w.drinks)
                    ok |= e != cur.first && w.stock.tickets[e] - cur.spent_t[e] >= 1;
            }
            if (!ok) continue;
            out.cost = add(s.base, cur.cost);
            std::memcpy(out.spent_t, cur.spent_t, sizeof out.spent_t);
            std::memcpy(out.spent_c, cur.spent_c, sizeof out.spent_c);
            out.first = cur.first < 0 ? static_cast<int8_t>(kNoAbility) : cur.first;
            out.cont = kNoAbility;
            out.acts.clear();
            for (int32_t n = idx; nodes[n].parent >= 0; n = nodes[n].parent) out.acts.push_back(nodes[n].act);
            std::reverse(out.acts.begin(), out.acts.end());
            if (s.cont_u > 0)
                for (const Act& a : out.acts)
                    if (a.kind == ActKind::Drink) {
                        out.cont = a.drink;
                        break;
                    }
            return true;
        }
        int fe = 0;
        while (fe < 3 && cur.slots[fe] != kNoAbility) ++fe;
        const bool open = cur.run != kNoAbility && cur.left > 0;
        if (fe < 3 && (cur.run != kFreeDrink || s.gate) && cur.t + 1 <= w.H) {  // plain roll
            Node n = cur;
            n.parent = idx;
            RollResult r = roll(w.br, w.seeds[cur.t], kNoAbility);
            n.t = cur.t + 1;
            n.slots[fe] = static_cast<int8_t>(r.ability);
            n.run = kNoAbility, n.left = 0;
            if (n.first == -3) n.first = kNoAbility;
            n.cost.rolls++;
            n.cost.el += 1 + (open ? cur.left : 0);
            n.act = {ActKind::Roll, static_cast<int8_t>(fe), static_cast<int8_t>(r.ability), kNoAbility, 0};
            push(n);
        }
        for (size_t di = 0; fe < 3 && di < w.drinks.size(); ++di) {  // drink rolls
            const int8_t d = w.drinks[di];
            const bool free_cont = cur.run == kFreeDrink && !s.gate;
            const bool covered = s.gate || (open && (cur.run == d || free_cont));
            if (free_cont && !covered) continue;
            if (!covered && static_cast<int>(cur.cost.tickets) + 1 > s.free_left) continue;
            if ((!covered || free_cont) && cur.spent_t[d] + 1 > w.stock.tickets[d]) continue;
            RollResult r = roll(w.br, w.seeds[cur.t], d);
            const int steps = r.drink_hit ? 1 : 2;
            if (cur.t + steps > w.H) continue;
            Node n = cur;
            n.parent = idx;
            n.t = cur.t + steps;
            n.slots[fe] = static_cast<int8_t>(r.ability);
            if (n.first == -3) n.first = d;
            n.cost.rolls++;
            if (s.gate) {
                n.cost.el += 1;
            } else if (covered) {
                n.cost.el += 1;
                n.left = static_cast<int8_t>(cur.left - 1);
                if (free_cont) n.run = d, n.spent_t[d]++;
            } else {
                n.cost.el += 1 + (open ? cur.left : 0);
                n.cost.tickets++;
                n.spent_t[d]++;
                n.run = d, n.left = kDrinkColumns - 1;
            }
            n.act = {ActKind::Drink, static_cast<int8_t>(fe), static_cast<int8_t>(r.ability), d,
                     static_cast<int16_t>(covered ? 0 : 1)};
            push(n);
        }
        for (int sl = 0; w.chunks && sl < 3; ++sl) {  // slaps: the first empty slot or over a filled one
            if ((cur.slots[sl] == kNoAbility && sl != fe) || cur.slots[sl] == kLocked) continue;
            for (int a = 0; a < kAbilities; ++a) {
                if (cur.slots[sl] == a) continue;
                int copies = 1;
                for (int j = 0; j < 3; ++j)
                    if (j != sl && cur.slots[j] == a) ++copies;
                const int c = 10 * copies;
                if (cur.spent_c[a] + c > w.stock.chunks[a] || over_cap(w.in, static_cast<int>(s.base.chunks + cur.cost.chunks), c) ||
                    over_budget(w.stock, static_cast<int>(s.base.chunks + cur.cost.chunks), c)) continue;
                Node n = cur;
                n.parent = idx;
                n.slots[sl] = static_cast<int8_t>(a);
                n.spent_c[a] = static_cast<uint16_t>(cur.spent_c[a] + c);
                n.cost.chunks += c;
                n.cost.wch += static_cast<uint32_t>(c) * chunk_w(w.in);
                n.act = {ActKind::Slap, static_cast<int8_t>(sl), static_cast<int8_t>(a), kNoAbility,
                         static_cast<int16_t>(c)};
                push(n);
            }
        }
    }
    return false;
}

}  // namespace st
