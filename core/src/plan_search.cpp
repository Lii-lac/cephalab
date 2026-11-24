// One piece's cheapest route: A* over (seed steps advanced, 3 slots, drink run, stock spent), with
// the rolls-to-go bound of plan_model.h on rolls and columns.
#include <algorithm>
#include <cstring>
#include <queue>
#include <unordered_map>

#include "plan_model.h"

namespace st {

namespace {

struct Node {
    Cost cost;
    int32_t parent;
    Act act;
    uint16_t t;
    int8_t slots[3];
    int8_t run_drink;  // drink of the current ticket run, kNoAbility = none
    int8_t run_left;   // drink rolls the current ticket still covers
    uint16_t spent_c[kAbilities];
    uint8_t spent_t[kAbilities];
};

uint64_t group_key(const Node& n) {
    uint64_t k = n.t;
    for (int i = 0; i < 3; ++i) k = (k << 4) | static_cast<uint64_t>(n.slots[i] + 1);
    k = (k << 4) | static_cast<uint64_t>(n.run_drink + 1);
    k = (k << 4) | static_cast<uint64_t>(n.run_left);
    return k;
}

// a spent no more than b on every ability (a leaves at least as much stock).
bool spends_less(const Node& a, const Node& b) {
    for (int i = 0; i < kAbilities; ++i)
        if (a.spent_c[i] > b.spent_c[i] || a.spent_t[i] > b.spent_t[i]) return false;
    return true;
}

int first_empty(const int8_t s[3]) {
    for (int i = 0; i < 3; ++i)
        if (s[i] == kNoAbility) return i;
    return -1;
}

struct QItem {
    Cost cost;
    uint64_t seq;
    int32_t node;
    bool operator>(const QItem& o) const {
        if (!(cost == o.cost)) return o.cost < cost;
        return seq > o.seq;
    }
};

}  // namespace

bool piece_done(const int8_t slots[3], const int8_t goal[3], bool fixed_order) {
    for (int i = 0; i < 3; ++i)
        if (slots[i] == kNoAbility) return false;
    if (fixed_order) {
        for (int i = 0; i < 3; ++i)
            if (goal[i] != kNoAbility && slots[i] != goal[i]) return false;
        return true;
    }
    bool used[3] = {false, false, false};
    for (int g = 0; g < 3; ++g) {
        if (goal[g] == kNoAbility) continue;
        int j = 0;
        while (j < 3 && (used[j] || slots[j] != goal[g])) ++j;
        if (j == 3) return false;
        used[j] = true;
    }
    return true;
}

PieceOut plan_piece(const PieceIn& in, const BrandRolls& br, const PlanOpts& opts, const Stock& stock,
                    bool reach_only) {
    PieceOut out;
    const int H = opts.horizon;
    std::vector<uint32_t> seeds(H + 1);
    seeds[0] = in.seed;
    for (int i = 1; i <= H; ++i) seeds[i] = next_seed(seeds[i - 1]);

    std::vector<Node> nodes;
    nodes.reserve(4096);
    std::unordered_map<uint64_t, std::vector<int32_t>> settled;
    std::priority_queue<QItem, std::vector<QItem>, std::greater<QItem>> q;
    uint64_t seq = 0;
    std::vector<int8_t> letters{kNoAbility};
    for (int d = 0; d < kAbilities && opts.use_drinks; ++d)
        if (stock.tickets[d] > 0) letters.push_back(static_cast<int8_t>(d));
    const PieceModel model(in, opts, stock, letters);
    if (model.h_at(0, in.subs) == kHInf) return out;  // not even with free slaps of what is stocked
    auto f = [&](const Node& n) {
        Cost c = n.cost;
        const uint8_t h = model.h_at(n.t, n.slots);
        c.rolls += h, c.el += h;
        return c;
    };

    Node root{};
    root.parent = -1;
    root.run_drink = kNoAbility;
    std::memcpy(root.slots, in.subs, 3);
    nodes.push_back(root);
    q.push({f(root), seq++, 0});

    auto dominated = [&](const Node& n) {
        auto it = settled.find(group_key(n));
        if (it == settled.end()) return false;
        for (int32_t s : it->second)
            if (spends_less(nodes[s], n)) return true;
        return false;
    };
    auto push = [&](const Node& n) {
        if (dominated(n)) return;
        nodes.push_back(n);
        if (model.h_at(n.t, n.slots) == kHInf) return;
        q.push({f(n), seq++, static_cast<int32_t>(nodes.size() - 1)});
    };

    // Slapping an ability no goal names only fills a slot "anything" may hold: which one is all the
    // same, so only the first stocked one not on the piece is tried (with every ability stocked, as
    // with a real save, trying all of them multiplies the states for nothing).
    bool in_goal[kAbilities] = {};
    for (int i = 0; i < 3; ++i)
        if (in.goal[i] >= 0) in_goal[in.goal[i]] = true;
    for (int a = 0; a < kAbilities; ++a)
        if (opts.goal_mask >> a & 1) in_goal[a] = true;  // another piece's goal: its stock is not interchangeable
    constexpr size_t kRatedNodes = 1500000;  // a chunk rate widens the search: past this, rolls first
    while (!q.empty()) {
        if (g_chunk_rate && nodes.size() > kRatedNodes) {
            const uint32_t rate = g_chunk_rate;
            g_chunk_rate = 0;
            PieceOut o = plan_piece(in, br, opts, stock, reach_only);
            g_chunk_rate = rate;
            return o;
        }
        const int32_t idx = q.top().node;
        q.pop();
        if (dominated(nodes[idx])) continue;
        settled[group_key(nodes[idx])].push_back(idx);
        const Node cur = nodes[idx];  // copy: push() may reallocate
        if (piece_done(cur.slots, in.goal, opts.fixed_order)) {
            out.reachable = true;
            out.cost = cur.cost;
            for (int i = 0; i < kAbilities; ++i) {
                out.used.chunks[i] = cur.spent_c[i];
                out.used.tickets[i] = cur.spent_t[i];
            }
            for (int32_t n = idx; nodes[n].parent >= 0; n = nodes[n].parent) out.acts.push_back(nodes[n].act);
            std::reverse(out.acts.begin(), out.acts.end());
            return out;
        }
        const int fe = first_empty(cur.slots);
        // Plain roll.
        if (fe >= 0 && cur.t + 1 <= H) {
            Node n = cur;
            n.parent = idx;
            RollResult r = roll(br, seeds[cur.t], kNoAbility);
            n.t = static_cast<uint16_t>(cur.t + 1);
            n.slots[fe] = static_cast<int8_t>(r.ability);
            n.run_drink = kNoAbility;
            n.run_left = 0;
            n.cost.rolls++;
            n.cost.el += 1 + (cur.run_drink != kNoAbility ? cur.run_left : 0);  // an open phase runs out first
            n.act = {ActKind::Roll, static_cast<int8_t>(fe), static_cast<int8_t>(r.ability), kNoAbility, 0};
            push(n);
        }
        // Drink rolls.
        if (fe >= 0 && opts.use_drinks && cur.t + 1 <= H) {
            for (int d = 0; d < kAbilities; ++d) {
                const bool covered = cur.run_drink == d && cur.run_left > 0;
                if (reach_only ? stock.tickets[d] <= 0 : !covered && cur.spent_t[d] >= stock.tickets[d]) continue;
                RollResult r = roll(br, seeds[cur.t], d);
                const int steps = r.drink_hit ? 1 : 2;
                if (cur.t + steps > H) continue;
                Node n = cur;
                n.parent = idx;
                n.t = static_cast<uint16_t>(cur.t + steps);
                n.slots[fe] = static_cast<int8_t>(r.ability);
                n.cost.rolls++;
                n.cost.el += 1 + (covered || cur.run_drink == kNoAbility ? 0 : cur.run_left);
                if (reach_only) {
                    // no phases: only whether the goal can be met at all
                } else if (covered) {
                    n.run_left = static_cast<int8_t>(cur.run_left - 1);
                } else {
                    n.spent_t[d]++;
                    n.cost.tickets++;
                    n.run_drink = static_cast<int8_t>(d);
                    n.run_left = kDrinkColumns - 1;
                }
                n.act = {ActKind::Drink, static_cast<int8_t>(fe), static_cast<int8_t>(r.ability),
                         static_cast<int8_t>(d), static_cast<int16_t>(covered ? 0 : 1)};
                push(n);
            }
        }
        // Slaps: onto the first empty slot or over any filled one.
        if (opts.use_chunks) {
            // fillers: per count already on the piece (which sets the price), the one with the most left
            int filler[3] = {-1, -1, -1};
            for (int a = 0; a < kAbilities; ++a) {
                if (in_goal[a]) continue;
                const int k = (cur.slots[0] == a) + (cur.slots[1] == a) + (cur.slots[2] == a);
                const int left = stock.chunks[a] - cur.spent_c[a];
                if (k < 3 && left >= 10 && (filler[k] < 0 || left > stock.chunks[filler[k]] - cur.spent_c[filler[k]])) filler[k] = a;
            }
            for (int s = 0; s < 3; ++s) {
                if ((cur.slots[s] == kNoAbility && s != fe) || cur.slots[s] == kLocked) continue;
                for (int a = 0; a < kAbilities; ++a) {
                    if (cur.slots[s] == a || (!in_goal[a] && a != filler[0] && a != filler[1] && a != filler[2])) continue;
                    int copies = 1;
                    for (int j = 0; j < 3; ++j)
                        if (j != s && cur.slots[j] == a) ++copies;
                    const int c = 10 * copies;
                    if (cur.spent_c[a] + c > stock.chunks[a] || over_cap(in, cur.cost.chunks, c) || over_budget(stock, cur.cost.chunks, c)) continue;
                    Node n = cur;
                    n.parent = idx;
                    n.slots[s] = static_cast<int8_t>(a);
                    n.spent_c[a] = static_cast<uint16_t>(cur.spent_c[a] + c);
                    n.cost.chunks += c;
                    n.cost.wch += static_cast<uint32_t>(c) * chunk_w(in);
                    n.act = {ActKind::Slap, static_cast<int8_t>(s), static_cast<int8_t>(a), kNoAbility,
                             static_cast<int16_t>(c)};
                    push(n);
                }
            }
        }
        // Scrub (only when something is on the piece).
        if (any_sub(cur.slots)) {
            Node n = cur;
            n.parent = idx;
            scrub_slots(n.slots);
            n.cost.scrubs++;
            n.act = {ActKind::Scrub, -1, kNoAbility, kNoAbility, 0};
            push(n);
        }
    }
    return out;
}

}  // namespace st
