// Joint plan over the shared timeline. The word (one letter per column holding a roll) is built
// one column at a time; each node keeps, per piece, its frontier (plan_model.h): every state it
// can be in after rolling in any subset of the columns so far. For a column count R (tried from
// the largest single-piece optimum up), a best-first search in (columns elapsed + columns left,
// tickets) finds every cheapest word reaching all goals; chunks and scrubs pick among them.
#include <algorithm>
#include <cstring>
#include <queue>

#include "plan_joint.h"

namespace st {

namespace {

struct QItem {
    uint32_t a, b;
    int32_t len;
    uint64_t seq;
    int32_t node;
    bool operator>(const QItem& o) const {
        if (a != o.a) return a > o.a;
        if (b != o.b) return b > o.b;
        if (len != o.len) return len < o.len;  // deeper first
        return seq > o.seq;
    }
};

}  // namespace

JointStatus Joint::search(int R, long cap, JointPlan& out) {
    nodes_.clear();
    fp_ = {};
    steps_.clear();
    dp_ = {};
    std::unordered_map<std::string, int32_t> seen;
    std::priority_queue<QItem, std::vector<QItem>, std::greater<QItem>> q;
    uint64_t seq = 0;
    JNode root{};
    root.parent = -1;
    root.run = -1;
    for (int i = 0; i < n_; ++i) {
        std::vector<PState> f;
        std::vector<Outcome> d;
        models_[i]->root(f, d, R, nullptr);
        if (f.empty() && d.empty()) return JointStatus::None;
        root.f[i] = fp_.put(f);
        root.d[i] = dp_.put(d);
    }
    nodes_.push_back(root);
    seen[key(root)] = 0;
    q.push({static_cast<uint32_t>(R), 0, 0, seq++, 0});
    bool have = false;
    uint32_t lv_a = 0, lv_b = 0, best_wc = 0, best_ch = 0, best_sc = 0;
    int32_t best = -1;
    int best_pick[3] = {0, 0, 0};
    while (!q.empty()) {
        const QItem top = q.top();
        q.pop();
        // Rolls first: the first (columns, tickets) level with a goal is the answer. With a chunk rate
        // every word of R letters costs R * rate, so all of them compete on chunks: search on.
        if (have && !g_chunk_rate && (top.a > lv_a || (top.a == lv_a && top.b > lv_b))) break;
        const JNode cur = nodes_[top.node];
        if (seen[key(cur)] != top.node) continue;  // a cheaper copy came later
        bool all = true;
        for (int i = 0; i < n_; ++i) all &= !dp_.items[cur.d[i]].empty();
        uint32_t wc = 0, ch = 0, sc = 0;
        int pick[3];
        if (all && combo(cur, wc, ch, sc, pick)) {
            // A rate: weighted chunks (rolls are R), then columns, tickets, chunks, scrubs.
            const bool better = !have || (g_chunk_rate ? (wc != best_wc ? wc < best_wc : top.a != lv_a ? top.a < lv_a : top.b != lv_b ? top.b < lv_b
                                                          : ch != best_ch ? ch < best_ch : sc < best_sc)
                                                       : (ch < best_ch || (ch == best_ch && sc < best_sc)));
            if (better) {
                best = top.node, best_wc = wc, best_ch = ch, best_sc = sc;
                std::memcpy(best_pick, pick, sizeof pick);
            }
            if (better || !g_chunk_rate) lv_a = top.a, lv_b = top.b;
            have = true;
            if (!g_chunk_rate) continue;  // a rate: more letters may trade the chunks for a scrub or a roll
        }
        if (cur.len >= R) continue;
        for (int li = 0; li < static_cast<int>(letters_.size()); ++li) {
            JNode c = cur;
            c.parent = top.node;
            c.li = static_cast<int8_t>(li);
            c.len = static_cast<uint16_t>(cur.len + 1);
            int pad = 0;
            const bool open = cur.run >= 0 && cur.u < kDrinkColumns;
            if (li > 0 && open && cur.run == li) {
                c.u = static_cast<uint8_t>(cur.u + 1);
            } else {
                if (open) pad = kDrinkColumns - cur.u;
                if (li == 0) {
                    c.run = -1, c.u = 0;
                } else {
                    if (cur.tickets[li] >= stock_.tickets[letters_[li]]) continue;
                    c.tickets[li]++, c.tk++;
                    c.run = static_cast<int8_t>(li), c.u = 1;
                }
            }
            c.el = static_cast<uint16_t>(cur.el + pad + 1);
            const int rem = R - c.len;
            bool took = false, dead = false;
            for (int i = 0; i < n_ && !dead; ++i) {
                // A piece's step depends only on its frontier, the letter and the columns left.
                const uint64_t sk = (static_cast<uint64_t>(cur.f[i]) << 32 | static_cast<uint32_t>(cur.d[i])) * 31 +
                                    static_cast<uint64_t>((i * kMaxLetters + li) * 1024 + rem);
                auto hit = steps_.find(sk);
                if (hit == steps_.end() || hit->second.from[0] != cur.f[i] || hit->second.from[1] != cur.d[i] ||
                    hit->second.key != (i * kMaxLetters + li) * 1024 + rem) {
                    std::vector<PState> f = fp_.items[cur.f[i]];
                    std::vector<Outcome> d = dp_.items[cur.d[i]];
                    Step st{};
                    st.took = models_[i]->step(f, d, li, cur.len, rem, nullptr);
                    st.dead = f.empty() && d.empty();
                    st.from[0] = cur.f[i], st.from[1] = cur.d[i];
                    st.key = (i * kMaxLetters + li) * 1024 + rem;
                    st.to[0] = fp_.put(f), st.to[1] = dp_.put(d);
                    hit = steps_.insert_or_assign(sk, st).first;
                }
                took |= hit->second.took;
                dead = hit->second.dead;
                c.f[i] = hit->second.to[0];
                c.d[i] = hit->second.to[1];
            }
            if (dead || !took) continue;
            const std::string k = key(c);
            auto it = seen.find(k);
            if (it != seen.end() && nodes_[it->second].el <= c.el) continue;
            nodes_.push_back(c);
            const int32_t id = static_cast<int32_t>(nodes_.size() - 1);
            seen[k] = id;
            q.push({static_cast<uint32_t>(c.el + rem), c.tk, c.len, seq++, id});
        }
        if (work() > cap) {
            if (!have || !g_chunk_rate) return JointStatus::Cap;
            break;  // a rate: keep the cheapest found so far
        }
    }
    if (!have) return JointStatus::None;
    rebuild(R, best, best_pick, out);
    return JointStatus::Found;
}

}  // namespace st
