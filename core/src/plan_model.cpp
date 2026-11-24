// One piece for the joint search: rolls per seed step and letter, slaps, frontiers (the
// rolls-to-go bound is in plan_heur.cpp).
#include <algorithm>
#include <cstring>

#include "plan_model.h"

namespace st {

namespace {

constexpr int kFillChoices = 4;  // "" slots: chunk fills tried from at most this many abilities

int first_empty(const int8_t s[3]) {
    for (int i = 0; i < 3; ++i)
        if (s[i] == kNoAbility) return i;
    return -1;
}

uint32_t total(const uint16_t* s) {
    uint32_t x = 0;
    for (int i = 0; i < kAbilities; ++i) x += s[i];
    return x;
}

bool le(const uint16_t* a, const uint16_t* b) {
    for (int i = 0; i < kAbilities; ++i)
        if (a[i] > b[i]) return false;
    return true;
}

}  // namespace

PieceModel::PieceModel(const PieceIn& in, const PlanOpts& opts, const Stock& stock, const std::vector<int8_t>& letters)
    : in_(in), fixed_(opts.fixed_order), chunks_(opts.use_chunks), H_(opts.horizon),
      nl_(static_cast<int>(letters.size())), letters_(letters), stock_(stock) {
    BrandRolls br(in.brand);
    ab_.assign(static_cast<size_t>(H_) * nl_, kNoAbility);
    st_.assign(static_cast<size_t>(H_) * nl_, 0);
    uint32_t seed = in.seed;
    for (int t = 0; t < H_; ++t, seed = next_seed(seed)) {
        for (int li = 0; li < nl_; ++li) {
            RollResult r = roll(br, seed, letters[li]);
            const int steps = letters[li] < 0 || r.drink_hit ? 1 : 2;
            if (t + steps > H_) continue;
            ab_[t * nl_ + li] = static_cast<int8_t>(r.ability);
            st_[t * nl_ + li] = static_cast<uint8_t>(steps);
        }
    }
    // Slaps: the value a slot ends with (fixed: goal[s]; free: a goal ability); "" = any stocked.
    std::vector<int8_t> stocked;
    for (int a = 0; a < kAbilities; ++a)
        if (chunks_ && stock.chunks[a] >= 10) stocked.push_back(static_cast<int8_t>(a));
    std::stable_sort(stocked.begin(), stocked.end(),
                     [&](int8_t a, int8_t b) { return stock.chunks[a] > stock.chunks[b]; });
    if (stocked.size() > kFillChoices) stocked.resize(kFillChoices);
    auto ok = [&](int a) { return chunks_ && stock.chunks[a] >= 10; };
    bool any_goal = false;
    for (int g = 0; g < 3; ++g) {
        const int a = in.goal[g];
        if (a == kNoAbility) {
            any_goal = true;
            continue;
        }
        int j = 0;
        while (j < ngoal_ && goal_ab_[j] != a) ++j;
        if (j == ngoal_) goal_ab_[ngoal_++] = static_cast<int8_t>(a);
        need_[j]++;
    }
    for (int s = 0; s < 3; ++s) {
        if (fixed_) {
            if (in.goal[s] == kNoAbility) {
                fill_[s] = stocked;
            } else if (ok(in.goal[s])) {
                fill_[s] = over_[s] = {in.goal[s]};
            }
            continue;
        }
        for (int j = 0; j < ngoal_; ++j)
            if (ok(goal_ab_[j])) fill_[s].push_back(goal_ab_[j]), over_[s].push_back(goal_ab_[j]);
        if (any_goal)
            for (int8_t a : stocked)
                if (std::find(fill_[s].begin(), fill_[s].end(), a) == fill_[s].end()) fill_[s].push_back(a);
    }
    if (!fixed_) base_ = ngoal_ + 2;
    ncodes_ = base_ * base_ * base_;
    build_h();
}

// Adds s and what slaps (each slot at most once) and one scrub (only before any slap: a slap
// thrown away by a scrub is never worth it) make of it; done ones go to done.
void PieceModel::close(const PState& s, std::vector<PState>& out, std::vector<Outcome>& done, int rem,
                       std::vector<Trace>* tr) const {
    struct Item {
        PState s;
        uint8_t mask;
        bool no_scrub;
    };
    std::vector<Item> stack{{s, 0, false}};
    auto trace = [&](PState& y, int32_t prev, const Act& a) {
        if (!tr) return;
        tr->push_back({prev, -1, a});
        y.trace = static_cast<int32_t>(tr->size() - 1);
    };
    while (!stack.empty()) {
        const Item it = stack.back();
        stack.pop_back();
        ++work;
        const PState& x = it.s;
        if (piece_done(x.slots, in_.goal, fixed_)) {
            Outcome o{};
            std::memcpy(o.spent, x.spent, sizeof o.spent);
            o.trace = x.trace;
            o.scrubs = x.scrubs;
            done.push_back(o);
            continue;
        }
        if (h(x) > rem) continue;
        out.push_back(x);
        if (!it.no_scrub && any_sub(x.slots) && x.scrubs < 250) {
            PState y = x;
            scrub_slots(y.slots);
            y.scrubs++;
            trace(y, x.trace, {ActKind::Scrub, -1, kNoAbility, kNoAbility, 0});
            stack.push_back({y, 0, true});
        }
        if (!chunks_) continue;
        const int fe = first_empty(x.slots);
        for (int j = 0; j < 3; ++j) {
            const bool empty = x.slots[j] == kNoAbility;
            if ((it.mask >> j & 1) || (empty && j != fe) || x.slots[j] == kLocked) continue;
            for (int8_t a : empty ? fill_[j] : over_[j]) {
                if (x.slots[j] == a) continue;
                int copies = 1;
                for (int k = 0; k < 3; ++k)
                    if (k != j && x.slots[k] == a) ++copies;
                const int c = 10 * copies;
                if (x.spent[a] + c > stock_.chunks[a]) continue;
                if (in_.max_chunks >= 0 || stock_.budget >= 0) {
                    int tot = 0;
                    for (int k = 0; k < kAbilities; ++k) tot += x.spent[k];
                    if (over_cap(in_, tot, c) || over_budget(stock_, tot, c)) continue;
                }
                PState y = x;
                y.slots[j] = a;
                y.spent[a] = static_cast<uint16_t>(y.spent[a] + c);
                trace(y, x.trace, {ActKind::Slap, static_cast<int8_t>(j), a, kNoAbility, static_cast<int16_t>(c)});
                stack.push_back({y, static_cast<uint8_t>(it.mask | 1 << j), true});
            }
        }
    }
}

void PieceModel::root(std::vector<PState>& f, std::vector<Outcome>& done, int rem, std::vector<Trace>* tr) const {
    f.clear();
    done.clear();
    PState s{};
    s.trace = -1;
    std::memcpy(s.slots, in_.subs, 3);
    close(s, f, done, rem, tr);
    normalize(f, done);
}

bool PieceModel::step(std::vector<PState>& f, std::vector<Outcome>& done, int li, int pos, int rem,
                      std::vector<Trace>* tr) const {
    std::vector<PState> next, kept;
    std::vector<Outcome> nd = done;
    for (const PState& s : f) {
        if (s.t >= H_) continue;
        const int fe = first_empty(s.slots);
        const int k = s.t * nl_ + li;
        if (fe < 0 || !st_[k]) continue;
        PState n = s;
        n.t = static_cast<uint8_t>(s.t + st_[k]);
        n.slots[fe] = ab_[k];
        if (tr) {
            tr->push_back({s.trace, pos, {li ? ActKind::Drink : ActKind::Roll, static_cast<int8_t>(fe), ab_[k], letters_[li], 0}});
            n.trace = static_cast<int32_t>(tr->size() - 1);
        }
        close(n, next, nd, rem, tr);
    }
    for (const PState& s : f)
        if (h(s) <= rem) kept.push_back(s);
    if (next.empty() && nd.size() == done.size()) {
        f.swap(kept);
        return false;
    }
    next.insert(next.end(), kept.begin(), kept.end());
    normalize(next, nd);
    const bool same = next.size() == kept.size() && nd.size() == done.size() &&
                      std::memcmp(next.data(), kept.data(), next.size() * sizeof(PState)) == 0 &&
                      std::memcmp(nd.data(), done.data(), nd.size() * sizeof(Outcome)) == 0;
    f.swap(next);
    done.swap(nd);
    return !same;
}

void normalize(std::vector<PState>& f, std::vector<Outcome>& done) {
    std::sort(done.begin(), done.end(), [](const Outcome& a, const Outcome& b) {
        const uint32_t ta = total(a.spent), tb = total(b.spent);
        if (ta != tb) return ta < tb;
        if (a.scrubs != b.scrubs) return a.scrubs < b.scrubs;
        return std::memcmp(a.spent, b.spent, sizeof a.spent) < 0;
    });
    size_t k = 0;
    for (size_t i = 0; i < done.size(); ++i) {
        bool dom = false;
        for (size_t j = 0; j < k && !dom; ++j) dom = done[j].scrubs <= done[i].scrubs && le(done[j].spent, done[i].spent);
        if (!dom) done[k++] = done[i];
    }
    done.resize(k);
    f.erase(std::remove_if(f.begin(), f.end(),
                           [&](const PState& s) {
                               for (const Outcome& o : done)
                                   if (o.scrubs <= s.scrubs && le(o.spent, s.spent)) return true;
                               return false;
                           }),
            f.end());
    auto group = [](const PState& a, const PState& b) {
        if (a.t != b.t) return a.t < b.t ? -1 : 1;
        return std::memcmp(a.slots, b.slots, 3);
    };
    std::sort(f.begin(), f.end(), [&](const PState& a, const PState& b) {
        if (int g = group(a, b)) return g < 0;
        const uint32_t ta = total(a.spent), tb = total(b.spent);
        if (ta != tb) return ta < tb;
        if (a.scrubs != b.scrubs) return a.scrubs < b.scrubs;
        return std::memcmp(a.spent, b.spent, sizeof a.spent) < 0;
    });
    k = 0;
    size_t start = 0;
    for (size_t i = 0; i < f.size(); ++i) {
        if (k == 0 || group(f[k - 1], f[i]) != 0) start = k;
        bool dom = false;
        for (size_t j = start; j < k && !dom; ++j) dom = f[j].scrubs <= f[i].scrubs && le(f[j].spent, f[i].spent);
        if (!dom) f[k++] = f[i];
    }
    f.resize(k);
}

}  // namespace st
