// fn "plan": which lanes the joint plan covers, and the fallback when its search gives up.
// unreachable = lanes that can't meet their goal even alone with all the stock; if the others
// can't all be planned together on the shared stock, the lanes the old rule (each alone on what
// the earlier ones left) can't plan are dropped too.
#include <algorithm>
#include <queue>
#include <string>
#include <unordered_map>

#include "plan.h"

namespace st {

namespace {

// Bounds the joint search (frontier states visited); typical 3-piece plans need far less.
constexpr long kWorkCap = 2000000;
constexpr long kProbeCap = 600000;  // the try with lanes the old rule drops

}  // namespace

// Each lane's own route in turn, on its own columns: always valid, rarely the cheapest.
void plan_concat(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, JointPlan& jp) {
    jp = {};
    jp.acts.resize(lanes.size());
    jp.at.resize(lanes.size());
    for (size_t k = 0; k < lanes.size(); ++k) {
        for (const Act& a : outs[lanes[k]].acts) {
            jp.acts[k].push_back(a);
            const bool roll = a.kind == ActKind::Roll || a.kind == ActKind::Drink;
            jp.at[k].push_back(roll ? static_cast<int>(jp.word.size()) : -1);
            if (roll) jp.word.push_back(a.kind == ActKind::Drink ? a.drink : static_cast<int8_t>(kNoAbility));
        }
    }
}

std::vector<char> plan_wild(const std::vector<Act>& acts) {
    std::vector<char> w(acts.size(), 0);
    bool scrubbed = false;  // a scrub comes later, no slap before it
    for (size_t j = acts.size(); j-- > 0;) {
        if (acts[j].kind == ActKind::Scrub) scrubbed = true;
        else if (acts[j].kind == ActKind::Slap) scrubbed = false;
        else if (acts[j].kind == ActKind::Drink) w[j] = scrubbed;
    }
    return w;
}

std::vector<int8_t> plan_route_word(const PieceOut& o, bool wild) {
    const std::vector<char> w = wild ? plan_wild(o.acts) : std::vector<char>(o.acts.size(), 0);
    std::vector<int8_t> word;
    for (size_t j = 0; j < o.acts.size(); ++j) {
        const Act& a = o.acts[j];
        if (a.kind == ActKind::Roll) word.push_back(kNoAbility);
        else if (a.kind == ActKind::Drink) word.push_back(w[j] ? kAnyDrink : a.drink);
    }
    return word;
}

void plan_assign(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, const std::vector<int8_t>& word,
                 JointPlan& jp, bool wild) {
    const size_t n = lanes.size();
    plan_concat(outs, lanes, jp);  // the acts; columns redone below
    jp.word = word;
    std::vector<size_t> roll(n, 0);
    std::vector<int8_t> next(n);
    std::vector<std::vector<char>> any(n);
    for (size_t k = 0; k < n; ++k) any[k] = wild ? plan_wild(jp.acts[k]) : std::vector<char>(jp.acts[k].size(), 0);
    auto want = [&](size_t k) {  // lane k's next roll letter, or kNoAbility - 1 when done
        while (roll[k] < jp.at[k].size() && jp.at[k][roll[k]] < 0) ++roll[k];
        if (roll[k] == jp.at[k].size()) return static_cast<int8_t>(kNoAbility - 1);
        const Act& a = jp.acts[k][roll[k]];
        if (any[k][roll[k]]) return kAnyDrink;
        return a.kind == ActKind::Drink ? a.drink : static_cast<int8_t>(kNoAbility);
    };
    for (size_t k = 0; k < n; ++k) next[k] = want(k);
    for (size_t c = 0; c < word.size(); ++c)
        for (size_t k = 0; k < n; ++k)
            if (next[k] == word[c] || (next[k] == kAnyDrink && word[c] != kNoAbility)) {
                if (next[k] == kAnyDrink) jp.acts[k][roll[k]].drink = word[c];
                jp.at[k][roll[k]++] = static_cast<int>(c);
                next[k] = want(k);
            }
}

namespace {

constexpr size_t kWildStates = 10000;  // the merge with kAnyDrink rolls gives up past this many states

// The exact merge below. wild: kAnyDrink rolls (plan_route_word) also take the open phase's drink,
// any lane's next kept drink or a kAnyDrink roll's own, at most cap tickets in all.
bool merge_exact(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, const Stock& stock, bool wild,
                 uint32_t cap, JointPlan& jp) {
    const size_t n = lanes.size();
    std::vector<std::vector<int8_t>> words(n), orig(n);
    std::vector<std::vector<uint8_t>> kept(n);  // kept[k][i]: lane k's first drink roll that isn't kAnyDrink at or after i
    for (size_t k = 0; k < n; ++k) {
        words[k] = plan_route_word(outs[lanes[k]], wild);
        if (!wild) continue;
        if (words[k].size() > 255) return false;  // S::pos is a byte
        orig[k] = plan_route_word(outs[lanes[k]], false);
        kept[k].assign(words[k].size() + 1, static_cast<uint8_t>(words[k].size()));
        for (size_t i = words[k].size(); i-- > 0;) kept[k][i] = words[k][i] >= 0 ? static_cast<uint8_t>(i) : kept[k][i + 1];
    }
    struct S {
        uint8_t pos[3], u, tk[kAbilities];
        int8_t run, letter;
        int32_t parent;
        uint32_t rolls, el, tks;
    };
    auto key = [](const S& s) {
        std::string k(reinterpret_cast<const char*>(s.pos), 3 + 1 + kAbilities);
        return k + static_cast<char>(s.run);
    };
    auto worse = [](const S& a, const S& b) {  // a after b
        if (a.rolls != b.rolls) return a.rolls > b.rolls;
        if (a.el != b.el) return a.el > b.el;
        return a.tks > b.tks;
    };
    std::vector<S> all;
    std::unordered_map<std::string, int32_t> best;
    auto cmp = [&](int32_t a, int32_t b) { return worse(all[a], all[b]) || (!worse(all[b], all[a]) && a > b); };
    std::priority_queue<int32_t, std::vector<int32_t>, decltype(cmp)> q(cmp);
    S root{};
    root.run = kNoAbility, root.letter = kNoAbility, root.parent = -1;
    all.push_back(root);
    q.push(0);
    while (!q.empty()) {
        const int32_t id = q.top();
        q.pop();
        const S cur = all[id];
        if (best.count(key(cur)) && best[key(cur)] != id) continue;
        bool end = true;
        for (size_t k = 0; k < n; ++k) end &= cur.pos[k] == words[k].size();
        if (end) {
            std::vector<int8_t> word;
            for (int32_t x = id; all[x].parent >= 0; x = all[x].parent) word.push_back(all[x].letter);
            std::reverse(word.begin(), word.end());
            plan_assign(outs, lanes, word, jp, wild);
            return true;
        }
        if (wild && all.size() > kWildStates) return false;
        // The letters to try: each lane's next (each letter once), and with a kAnyDrink roll next
        // the open phase's drink, every lane's next kept drink and the kAnyDrink rolls' own.
        std::vector<int8_t> letters;
        auto add = [&](int8_t x) {
            if (std::find(letters.begin(), letters.end(), x) == letters.end()) letters.push_back(x);
        };
        bool any = false;
        for (size_t k = 0; k < n; ++k) {
            if (cur.pos[k] == words[k].size()) continue;
            const int8_t x = words[k][cur.pos[k]];
            if (x == kAnyDrink) any = true;
            else add(x);
        }
        if (any) {
            if (cur.run != kNoAbility && cur.u < kDrinkColumns) add(cur.run);
            for (size_t k = 0; k < n; ++k) {
                if (kept[k][cur.pos[k]] < words[k].size()) add(words[k][kept[k][cur.pos[k]]]);
                if (cur.pos[k] < words[k].size() && words[k][cur.pos[k]] == kAnyDrink) add(orig[k][cur.pos[k]]);
            }
        }
        for (const int8_t x : letters) {
            S s = cur;
            s.parent = id, s.letter = x, s.rolls++;
            const bool open = cur.run != kNoAbility && cur.u < kDrinkColumns;
            uint32_t pad = 0;
            if (x != kNoAbility && open && x == cur.run) {
                s.u++;
            } else {
                if (open) pad = kDrinkColumns - cur.u;
                s.run = x, s.u = x == kNoAbility ? 0 : 1;
                if (x != kNoAbility) {
                    if (cur.tk[x] >= stock.tickets[x] || cur.tks >= cap) continue;
                    s.tk[x]++, s.tks++;
                }
            }
            s.el += pad + 1;
            for (size_t j = 0; j < n; ++j) {
                if (cur.pos[j] == words[j].size()) continue;
                const int8_t l = words[j][cur.pos[j]];
                if (l == x || (l == kAnyDrink && x != kNoAbility)) s.pos[j]++;
            }
            const std::string kk = key(s);
            auto it = best.find(kk);
            if (it != best.end() && !worse(all[it->second], s)) continue;
            all.push_back(s);
            best[kk] = static_cast<int32_t>(all.size() - 1);
            q.push(static_cast<int32_t>(all.size() - 1));
        }
    }
    return false;
}

// (columns with a roll, columns elapsed, tickets) of a word.
void word_key(const std::vector<int8_t>& w, uint32_t c[3]) {
    std::vector<int> col;
    c[2] = static_cast<uint32_t>(word_columns(w, col));
    c[0] = static_cast<uint32_t>(w.size());
    c[1] = w.empty() ? 0 : static_cast<uint32_t>(col.back());
}

}  // namespace

// The cheapest timeline for fixed routes (one per lane): in each column every lane whose next roll
// has the column's letter rolls (for a fixed route, rolling as early as possible never costs).
// Dijkstra over (next roll of each lane, open phase, tickets used) in (columns with a roll,
// columns elapsed, tickets). Then again with the burn drink rolls under any drink (kAnyDrink), at
// most the routes' own tickets in all: kept when cheaper. False when no timeline fits the ticket stock.
bool plan_merge_routes(const std::vector<PieceOut>& outs, const std::vector<int>& lanes, const Stock& stock,
                       JointPlan& jp) {
    const bool ok = merge_exact(outs, lanes, stock, false, UINT32_MAX, jp);
    bool any = false;
    uint32_t own = 0;
    for (int i : lanes) {
        const std::vector<int8_t> w = plan_route_word(outs[i], true);
        any |= std::find(w.begin(), w.end(), kAnyDrink) != w.end();
        std::vector<int> col;
        own += static_cast<uint32_t>(word_columns(plan_route_word(outs[i], false), col));
    }
    JointPlan wj;
    if (!any || !merge_exact(outs, lanes, stock, true, own, wj)) return ok;
    uint32_t a[3], b[3];
    word_key(wj.word, a);
    word_key(jp.word, b);
    if (!ok || std::lexicographical_compare(a, a + 3, b, b + 3)) jp = std::move(wj);
    return true;
}

void plan_write(const PlanReq& in, std::string& r) {
    if (in.pieces.size() == 1) return plan_write_one(in, r);
    if (in.opts.from + in.opts.horizon > kMaxJointHorizon) return plan_write_long(in, r);
    PlanReq req = in;  // a slice within the joint search's reach: one search from 0
    req.opts.horizon += req.opts.from, req.opts.from = 0;
    const int L = static_cast<int>(req.pieces.size());
    std::vector<int> unreachable, active, solo(L, 0);
    std::vector<PieceOut> alone(L);
    for (int i = 0; i < L; ++i) {
        const PieceIn& p = req.pieces[i];
        if (piece_done(p.subs, p.goal, req.opts.fixed_order)) continue;
        BrandRolls br(p.brand);
        // Unreachable even with unlimited tickets is the slow case for the full search: test it first.
        if (!plan_piece(p, br, req.opts, req.stock, true).reachable) {
            unreachable.push_back(i);
            continue;
        }
        PieceOut& o = alone[i] = plan_piece(p, br, req.opts, req.stock);
        if (!o.reachable) {
            unreachable.push_back(i);
            continue;
        }
        active.push_back(i);
        solo[i] = static_cast<int>(o.cost.rolls);
        if (g_chunk_rate) {  // a rate may trade rolls for chunks: the fewest rolls bound R from below
            const uint32_t rate = g_chunk_rate;
            g_chunk_rate = 0;
            solo[i] = static_cast<int>(plan_piece(p, br, req.opts, req.stock).cost.rolls);
            g_chunk_rate = rate;
        }
    }
    // The old rule: lanes in order, each alone on what the earlier ones left.
    Stock left = req.stock;
    std::vector<PieceOut> seq(L);
    std::vector<int> kept, dropped;
    int seq_rolls = 0;
    for (int i : active) {
        BrandRolls br(req.pieces[i].brand);
        seq[i] = plan_piece(req.pieces[i], br, req.opts, left);
        if (!seq[i].reachable) {
            dropped.push_back(i);
            continue;
        }
        kept.push_back(i);
        seq_rolls += static_cast<int>(seq[i].cost.rolls);
        take(left, seq[i].used);
    }
    // One lane alone: its own optimum is the plan.
    auto joint = [&](const std::vector<int>& lanes, int hi, long cap, JointPlan& jp) {
        if (lanes.size() == 1) {
            plan_concat(alone, lanes, jp);
            return JointStatus::Found;
        }
        std::vector<PieceIn> ps;
        int lo = 0;
        for (int i : lanes) ps.push_back(req.pieces[i]), lo = std::max(lo, solo[i]);
        return plan_joint(ps, req.opts, req.stock, lo, hi, cap, jp);
    };
    // The old rule's routes on their best shared timeline: the fallback, and a bound on columns.
    JointPlan jp, merged;
    const bool have_merged = plan_merge_routes(seq, kept, req.stock, merged);
    int hi = have_merged ? static_cast<int>(merged.word.size()) : seq_rolls;
    if (g_chunk_rate) {  // a plan of more rolls but fewer chunks still beats the old rule's while R * rate is below its cost
        uint64_t ch = 0;
        for (int i : kept) ch += static_cast<uint64_t>(seq[i].cost.wch);
        hi = std::max<int>(hi, static_cast<int>(std::min<uint64_t>(rate_key(static_cast<uint64_t>(hi), ch) / (2ull * g_chunk_rate), L * req.opts.horizon)));
    }
    std::vector<int> lanes = active;
    JointStatus s;
    if (dropped.empty()) {
        s = joint(active, hi, kWorkCap, jp);
    } else {
        // The lanes the old rule drops may still fit when phases are shared: a shorter try (every
        // lane takes at most horizon rolls, so lanes * horizon columns bound any plan).
        s = joint(active, L * req.opts.horizon, kProbeCap, jp);
        if (s != JointStatus::Found) {
            unreachable.insert(unreachable.end(), dropped.begin(), dropped.end());
            std::sort(unreachable.begin(), unreachable.end());
            lanes = kept;
            s = joint(kept, hi, kWorkCap, jp);
        }
    }
    if (s != JointStatus::Found) {
        if (have_merged) jp = merged;
        else plan_concat(seq, lanes, jp);
    }

    JointPlan all;
    all.word = jp.word;
    all.acts.resize(L);
    all.at.resize(L);
    for (size_t k = 0; k < lanes.size(); ++k) {
        all.acts[lanes[k]] = jp.acts[k];
        all.at[lanes[k]] = jp.at[k];
    }
    plan_write_reply(in, all, unreachable, req.opts.horizon, false, r, s == JointStatus::Found);
}

}  // namespace st
