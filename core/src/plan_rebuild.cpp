// Joint plan, the second half: the cheapest chunk choice at a goal node, the plan rebuilt from
// it, and the entry points (plan.h).
#include <algorithm>
#include <cstring>

#include "plan_joint.h"

namespace st {

bool Joint::combo(const JNode& n, uint32_t& wc, uint32_t& ch, uint32_t& sc, int pick[3]) const {
    int32_t used[kAbilities] = {};
    int cur[3] = {0, 0, 0};
    bool found = false;
    auto rec = [&](auto&& self, int i, uint32_t w, uint32_t c, uint32_t s) -> void {
        if (found && (w > wc || (w == wc && (c > ch || (c == ch && s >= sc))))) return;
        if (i == n_) {
            found = true, wc = w, ch = c, sc = s;
            for (int j = 0; j < n_; ++j) pick[j] = cur[j];
            return;
        }
        const std::vector<Outcome>& list = dp_.items[n.d[i]];
        for (size_t k = 0; k < list.size(); ++k) {
            const Outcome& o = list[k];
            bool fits = true;
            uint32_t oc = 0;
            for (int a = 0; a < kAbilities; ++a) {
                oc += o.spent[a];
                fits &= used[a] + o.spent[a] <= stock_.chunks[a];
            }
            if (!fits || (stock_.budget >= 0 && c + oc > static_cast<uint32_t>(stock_.budget))) continue;   // the plan's chunk budget
            for (int a = 0; a < kAbilities; ++a) used[a] += o.spent[a];
            cur[i] = static_cast<int>(k);
            self(self, i + 1, w + oc * w_[i], c + oc, s + o.scrubs);
            for (int a = 0; a < kAbilities; ++a) used[a] -= o.spent[a];
        }
    };
    rec(rec, 0, 0, 0, 0);
    return found;
}

// The word from the goal node back to the root, then each piece's acts replayed along it.
void Joint::rebuild(int R, int32_t goal, const int pick[3], JointPlan& out) const {
    std::vector<int> word;
    for (int32_t n = goal; nodes_[n].parent >= 0; n = nodes_[n].parent) word.push_back(nodes_[n].li);
    std::reverse(word.begin(), word.end());
    out.word.clear();
    for (int li : word) out.word.push_back(letters_[li]);
    out.acts.assign(n_, {});
    out.at.assign(n_, {});
    for (int i = 0; i < n_; ++i) {
        const Outcome& want = dp_.items[nodes_[goal].d[i]][pick[i]];
        std::vector<Trace> tr;
        std::vector<PState> f;
        std::vector<Outcome> d;
        models_[i]->root(f, d, R, &tr);
        for (size_t p = 0; p < word.size(); ++p)
            models_[i]->step(f, d, word[p], static_cast<int>(p), R - static_cast<int>(p) - 1, &tr);
        int32_t t = -1;
        for (const Outcome& o : d)
            if (o.scrubs == want.scrubs && std::memcmp(o.spent, want.spent, sizeof o.spent) == 0) t = o.trace;
        for (; t >= 0; t = tr[t].prev) {
            out.acts[i].push_back(tr[t].act);
            out.at[i].push_back(tr[t].pos);
        }
        std::reverse(out.acts[i].begin(), out.acts[i].end());
        std::reverse(out.at[i].begin(), out.at[i].end());
    }
}

int word_columns(const std::vector<int8_t>& word, std::vector<int>& col) {
    col.assign(word.size(), 0);
    int c = 0, tickets = 0, run = kNoAbility, u = 0;
    for (size_t p = 0; p < word.size(); ++p) {
        const int x = word[p];
        const bool open = run != kNoAbility && u < kDrinkColumns;
        if (x != kNoAbility && open && x == run) {
            ++u;
        } else {
            if (open) c += kDrinkColumns - u;
            run = x, u = x == kNoAbility ? 0 : 1;
            if (x != kNoAbility) ++tickets;
        }
        col[p] = ++c;
    }
    return tickets;
}

JointStatus plan_joint(const std::vector<PieceIn>& pieces, const PlanOpts& opts, const Stock& stock, int lo,
                       int hi, long work_cap, JointPlan& out) {
    out = {};
    if (pieces.empty()) return JointStatus::Found;
    Joint j(pieces, opts, stock);
    // With a chunk rate a longer word that slaps fewer chunks can be cheaper: go on while R alone
    // (no chunks) still beats the best (rate_key: rolls * rate * 2 + weighted chunks) so far.
    bool have = false;
    uint64_t best = 0;
    JointPlan cand;
    for (int R = lo; R <= hi; ++R) {
        if (have && rate_key(static_cast<uint64_t>(R), 0) >= best) break;
        JointPlan& p = have ? cand : out;
        const JointStatus s = j.search(R, work_cap, p);
        if (s == JointStatus::Cap) return have ? JointStatus::Found : s;
        if (s == JointStatus::None) continue;
        if (!g_chunk_rate) return s;
        uint64_t ch = 0;
        for (size_t l = 0; l < p.acts.size(); ++l)
            for (const Act& a : p.acts[l])
                if (a.kind == ActKind::Slap) ch += static_cast<uint64_t>(a.cost) * chunk_w(pieces[l]);
        const uint64_t k = rate_key(static_cast<uint64_t>(R), ch);
        if (!have) have = true, best = k;
        else if (k < best) best = k, out = std::move(cand);
    }
    return have ? JointStatus::Found : JointStatus::None;
}

}  // namespace st
