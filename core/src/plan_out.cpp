// fn "plan": the reply for a joint plan (lanes, steps keyed by column, totals).
#include <algorithm>
#include <cstdio>

#include "plan.h"

namespace st {

namespace {

void put_name(std::string& r, int a) { json::put_string(r, a == kNoAbility || a == kLocked ? "" : ability_name(a)); }

void put_key(std::string& r, double k) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.2f", k);
    std::string s = buf;
    while (s.back() == '0') s.pop_back();
    if (s.back() == '.') s.pop_back();
    r += s;
}

// have / goal flags as pathLanes() draws them: which subs the goal can use where they are (a slot
// that stays locked is "" and meets a goal "").
void have_goal(const PieceIn& p, bool fixed, std::string& r) {
    bool used[3] = {false, false, false}, met[3] = {false, false, false};
    for (int pass = 0; pass < 2; ++pass) {
        for (int g = 0; g < 3; ++g) {
            const bool any = p.goal[g] == kNoAbility;
            if (any != (pass == 1)) continue;
            int j = -1;
            if (fixed) {
                if (p.subs[g] != kNoAbility && (any || p.subs[g] == p.goal[g])) j = g;
            } else {
                for (int x = 0; x < 3 && j < 0; ++x)
                    if (!used[x] && p.subs[x] != kNoAbility && (any || p.subs[x] == p.goal[g])) j = x;
            }
            if (j >= 0) used[j] = met[g] = true;
        }
    }
    r += "\"have\":[";
    for (int i = 0; i < 3; ++i) {
        if (i) r += ',';
        r += '[';
        put_name(r, p.subs[i]);
        r += real_sub(p.subs[i]) && !used[i] ? ",\"wrong\"]" : ",\"\"]";
    }
    r += "],\"goal\":[";
    for (int i = 0; i < 3; ++i) {
        if (i) r += ',';
        r += '[';
        put_name(r, p.goal[i]);
        r += met[i] ? ",\"met\"]" : ",\"\"]";
    }
    r += ']';
}

bool is_roll(const Act& a) { return a.kind == ActKind::Roll || a.kind == ActKind::Drink; }

}  // namespace

void plan_write_reply(const PlanReq& req, const JointPlan& plan, const std::vector<int>& unreachable,
                      int searched_to, bool collapse, std::string& r, bool optimal) {
    const size_t L = req.pieces.size();
    std::vector<int> col;
    const int tickets = word_columns(plan.word, col);
    // What each drink roll lands under the drink it has: a merge may have moved a burn drink roll
    // onto another drink's column (plan_assign, kAnyDrink); the seed moves the same.
    std::vector<std::vector<Act>> lane_acts = plan.acts;
    std::vector<std::vector<int>> at = plan.at;
    for (size_t i = 0; i < L; ++i) {
        // Unlocks: the slots the goal needs open, the lane's first work at Murch (before its first roll).
        const PieceIn& p = req.pieces[i];
        if (lane_acts[i].empty() || p.unlocks <= 0) continue;
        for (int u = p.unlocks; u-- > 0;) {
            lane_acts[i].insert(lane_acts[i].begin(), {ActKind::Unlock, static_cast<int8_t>(p.open + u), kNoAbility, kNoAbility, 0});
            at[i].insert(at[i].begin(), -1);
        }
    }
    for (size_t i = 0; i < L; ++i) {
        std::vector<Act>& acts = lane_acts[i];
        if (std::none_of(acts.begin(), acts.end(), [](const Act& a) { return a.kind == ActKind::Drink; })) continue;
        const BrandRolls br(req.pieces[i].brand);
        uint32_t seed = req.pieces[i].seed;
        for (Act& a : acts) {
            if (!is_roll(a)) continue;
            const RollResult rr = roll(br, seed, a.kind == ActKind::Drink ? a.drink : kNoAbility);
            if (a.kind == ActKind::Drink) a.ability = static_cast<int8_t>(rr.ability);
            seed = rr.seed;
        }
    }
    // Keys: a roll sits in its column; other steps just before the lane's next roll, as keyed() does.
    std::vector<std::vector<double>> keys(L);
    Cost total;
    int snails = 0;
    for (size_t i = 0; i < L; ++i) {
        const std::vector<Act>& acts = lane_acts[i];
        keys[i].assign(acts.size(), 0);
        int prev = 0;
        for (size_t s = 0; s < acts.size(); ++s) {
            if (!is_roll(acts[s])) continue;
            prev = col[at[i][s]];
            keys[i][s] = prev;
        }
        double next_key = static_cast<double>(prev + 1), sub = 0;
        for (size_t s = acts.size(); s-- > 0;) {
            if (is_roll(acts[s])) {
                next_key = keys[i][s];
                sub = 0;
            } else {
                sub += 0.01;
                keys[i][s] = next_key - 0.5 - sub;
            }
            if (acts[s].kind == ActKind::Slap) total.chunks += acts[s].cost;
            if (acts[s].kind == ActKind::Scrub) total.scrubs++;
            if (acts[s].kind == ActKind::Unlock) snails += kSnailsPerUnlock;
        }
    }

    r.clear();
    r += "{\"ok\":true,\"lanes\":[";
    for (size_t i = 0; i < L; ++i) {
        const PieceIn& p = req.pieces[i];
        const std::vector<Act>& acts = lane_acts[i];
        // Burns: rolls later scrubbed away or chunked over.
        std::vector<char> burned(acts.size(), 0);
        int in_slot[3] = {-1, -1, -1};
        for (size_t s = 0; s < acts.size(); ++s) {
            const Act& a = acts[s];
            if (is_roll(a)) {
                in_slot[a.slot] = static_cast<int>(s);
            } else if (a.kind == ActKind::Slap) {
                if (in_slot[a.slot] >= 0) burned[in_slot[a.slot]] = 1;
                in_slot[a.slot] = -1;
            } else if (a.kind == ActKind::Scrub) {
                for (int& x : in_slot) {
                    if (x >= 0) burned[x] = 1;
                    x = -1;
                }
            }
        }
        if (i) r += ',';
        r += "{\"row\":";
        json::put_string(r, req.rows[i]);
        r += ',';
        have_goal(p, req.opts.fixed_order, r);
        r += ",\"steps\":[";
        // Filled slots before each act: with collapse, a scrub of a full piece between burn rolls is implied.
        std::vector<int8_t> fill(acts.size(), 0);
        int f = 0;
        while (f < 3 && real_sub(p.subs[f])) ++f;
        const int open = open_count(p.subs);  // full: every open slot filled
        for (size_t s = 0; s < acts.size(); ++s) {
            fill[s] = static_cast<int8_t>(f);
            if (is_roll(acts[s]) || (acts[s].kind == ActKind::Slap && acts[s].slot == f)) ++f;
            else if (acts[s].kind == ActKind::Scrub) f = 0;
        }
        int rolls = 0, groups = 0, last_roll_slot = -1;
        bool in_group = false;
        for (size_t s = 0; s < acts.size(); ++s) {
            const Act& a = acts[s];
            if (s) r += ',';
            if (is_roll(a)) {
                // Burn rolls of one letter in consecutive columns (scrubs of a full piece between) -> one step.
                size_t last = s;
                int times = 1, scrubs = 0;
                while (collapse && burned[s]) {
                    size_t nx = last + 1;
                    const int sc = nx < acts.size() && acts[nx].kind == ActKind::Scrub && fill[nx] == open;
                    nx += sc;
                    if (nx >= acts.size()) break;
                    const Act& b = acts[nx];
                    if (!is_roll(b) || !burned[nx] || b.kind != a.kind || b.drink != a.drink ||
                        keys[i][nx] != keys[i][last] + 1)
                        break;
                    last = nx, ++times, scrubs += sc;
                }
                rolls += times;
                last_roll_slot = acts[last].slot;
                r += a.kind == ActKind::Drink ? "{\"k\":\"drink\",\"d\":" : "{\"k\":\"roll\"";
                if (a.kind == ActKind::Drink) put_name(r, a.drink);
                r += ",\"a\":";
                put_name(r, acts[last].ability);
                if (burned[s]) {
                    if (!in_group) ++groups;
                    in_group = true;
                    r += ",\"burn\":\"b" + std::to_string(i) + "-" + std::to_string(groups - 1) + "\"";
                } else {
                    in_group = false;
                }
                if (times > 1) r += ",\"times\":" + std::to_string(times) + ",\"scrubs\":" + std::to_string(scrubs);
                r += ",\"key\":";
                put_key(r, keys[i][s]);
                r += ",\"roll\":" + std::to_string(rolls) + "}";
                s = last;
                continue;
            }
            in_group = false;
            if (a.kind == ActKind::Slap) {
                r += "{\"k\":\"slap\",\"a\":";
                put_name(r, a.ability);
                r += ",\"slot\":" + std::to_string(a.slot + 1) + ",\"cost\":" + std::to_string(a.cost);
                r += a.slot == last_roll_slot ? ",\"sameColumn\":true" : ",\"sameColumn\":false";
            } else if (a.kind == ActKind::Unlock) {
                r += "{\"k\":\"unlock\",\"slot\":" + std::to_string(a.slot + 1);
            } else {
                r += "{\"k\":\"scrub\"";
                last_roll_slot = -1;
            }
            r += ",\"key\":";
            put_key(r, keys[i][s]);
            r += '}';
        }
        r += ']';
        if (std::find(unreachable.begin(), unreachable.end(), static_cast<int>(i)) != unreachable.end())
            r += ",\"searchedTo\":" + std::to_string(searched_to);
        r += '}';
    }
    const size_t n = plan.word.size(), el = n ? static_cast<size_t>(col.back()) : 0;
    r += "],\"totals\":{\"rolls\":" + std::to_string(n);
    r += ",\"battles\":" + std::to_string((el * 23 + 9) / 10);
    r += ",\"tickets\":" + std::to_string(tickets) + ",\"chunks\":" + std::to_string(total.chunks);
    r += ",\"scrubs\":" + std::to_string(total.scrubs) + ",\"snails\":" + std::to_string(snails) + "},";
    if (!optimal) r += "\"optimal\":false,";
    r += "\"unreachable\":[";
    for (size_t i = 0; i < unreachable.size(); ++i) {
        if (i) r += ',';
        r += std::to_string(unreachable[i]);
    }
    r += "]}";
}

}  // namespace st
