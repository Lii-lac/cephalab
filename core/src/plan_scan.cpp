// One piece over long horizons (plan_scan.h): the burn prefix and the scan over seed offsets.
//
// Burn rolls only move the seed: a plain roll 1 step, a drink roll 1 or 2 (whatever the drink),
// so the prefix is a path of plain rolls and drink phases whose drinks are picked afterwards.
// WLOG (rolls, columns, tickets no worse) a phase that ends early is followed by a plain roll,
// except just before the last stretch. States at offset t with N tickets used:
//   C  closed (start, after a plain roll or a full phase): plain, or a phase of 1..8 rolls;
//   P  just after a phase of 1..7 rolls (its unused columns paid): plain only;
//   O2 C + an open phase of j rolls that the stretch continues (u = 8 - j columns left);
//   O3 P + the same (the partial phase before needs another drink).
// Every state is tried as the start of the last stretch (C, P from empty; O2, O3 continuing).
#include <algorithm>
#include <climits>

#include "plan_scan.h"

namespace st {

namespace {

constexpr int kRing = 2 * kDrinkColumns + 1;  // a phase moves at most 16 steps
constexpr uint32_t kInf = UINT32_MAX;

struct PC {
    uint32_t rb = kInf, el = kInf;
    int32_t src = -1;
    bool less(uint32_t r, uint32_t e) const { return r < rb || (r == rb && e < el); }
};

enum Src : uint8_t { kA, kC, kP, kO2, kO3 };

struct Best {
    Cost cost;
    FinalOut fin;
    Src src = kA;
    int t = 0, u = 0, n = 0, from_t = -1;
};

}  // namespace

PieceOut plan_scan(const PieceIn& in, const PlanOpts& opts, const Stock& stock) {
    PieceOut out;
    const Window w(in, opts, stock);
    const int H = w.H, B = w.B, NB = B + 1;
    int k0 = 0;
    while (k0 < 3 && real_sub(in.subs[k0])) ++k0;
    const int O = open_count(in.subs), first = O - k0;  // open slots; burn rolls until the piece is full
    auto scrubs = [&](uint32_t rb) { return 1u + (rb > static_cast<uint32_t>(first) ? (rb - first + O - 1) / O : 0u); };
    int8_t empty[3] = {in.subs[0], in.subs[1], in.subs[2]};  // the piece scrubbed
    scrub_slots(empty);

    Best best;
    best.cost = {kInf / 2, kInf / 2, kInf / 2, kInf / 2, kInf / 2, kInf / 2};
    if (opts.max_rolls >= 0) best.cost = {static_cast<uint32_t>(opts.max_rolls) + 1, 0, 0, 0, 0};  // below it: at most max_rolls
    bool found = false;
    FinalOut fo;
    if (w.lo == 0) {  // no scrub at all
        FinalStart s;
        s.t = 0;
        std::copy(in.subs, in.subs + 3, s.slots);
        s.free_left = B;
        if (plan_final(w, s, best.cost, fo)) best.cost = fo.cost, best.fin = fo, best.src = kA, found = true;
    }

    // Prefix DP rings (exact ticket counts) and the choices that rebuild it.
    std::vector<PC> C(kRing * NB), P(kRing * NB), O2(kRing * 7 * NB), O3(kRing * 7 * NB);
    std::vector<uint16_t> chC, chP;
    if (B > 0) chC.assign(static_cast<size_t>(H + 1) * NB, 0), chP.assign(static_cast<size_t>(H + 1) * NB, 0);
    C[0] = {0, 0, -1};
    auto relaxC = [&](int t, int n, uint32_t rb, uint32_t el, uint16_t ch) {
        PC& x = C[(t % kRing) * NB + n];
        if (x.less(rb, el)) x = {rb, el, -1}, chC[static_cast<size_t>(t) * NB + n] = ch;
    };
    auto relaxP = [&](int t, int n, uint32_t rb, uint32_t el, uint16_t ch) {
        PC& x = P[(t % kRing) * NB + n];
        if (x.less(rb, el)) x = {rb, el, -1}, chP[static_cast<size_t>(t) * NB + n] = ch;
    };
    auto relaxO = [&](std::vector<PC>& O, int t, int u, int n, uint32_t rb, uint32_t el, int src) {
        PC& x = O[((t % kRing) * 7 + (u - 1)) * NB + n];
        if (x.less(rb, el)) x = {rb, el, src};
    };

    for (int t = 0; t <= H; ++t) {
        // Stop once no prefix reaching t or later can have as few rolls as the best.
        if (found || opts.max_rolls >= 0) {
            const uint32_t lb = static_cast<uint32_t>(std::max((t + 1) / 2, t - kDrinkColumns * B));
            if (rolls_past(lb, best.cost)) break;
        }
        const int r = t % kRing;
        const int h = t >= w.lo ? w.relax(t, empty) : kRelaxInf;
        Cost gate;  // the stretch from empty at t with drinks free of tickets: a bound for every start at t
        bool open = false;
        if (h < kRelaxInf) {
            FinalStart g;
            g.t = t;
            std::copy(empty, empty + 3, g.slots);
            g.gate = true;
            const Cost inf{kInf / 2, kInf / 2, kInf / 2, kInf / 2, kInf / 2, kInf / 2};
            if (plan_final(w, g, inf, fo)) gate = fo.cost, open = true;
        }
        if (open) {
            // Each source: the cheapest entry per ticket class (tickets the stretch may still start: 3+, 2, 1, 0).
            auto try_src = [&](const PC* row, Src src, int u, int nmin) {
                for (int c = 3; c >= 0; --c) {
                    const int hi = c == 3 ? B - 3 : B - c, lo = c == 3 ? 0 : B - c;
                    int bn = -1;
                    for (int n = std::max(lo, nmin); n <= hi; ++n)
                        if (row[n].rb != kInf && (bn < 0 || row[bn].less(row[n].rb, row[n].el))) bn = n;
                    if (bn < 0) continue;
                    const PC& e = row[bn];
                    if (src == kC && e.rb == 0 && k0 == 0) continue;  // nothing to scrub
                    FinalStart s;
                    s.t = t;
                    std::copy(empty, empty + 3, s.slots);
                    s.cont_u = u;
                    s.reserve = src == kP || src == kO3;
                    s.free_left = B - bn;
                    s.base = {e.rb, e.el, static_cast<uint32_t>(bn), 0, scrubs(e.rb)};
                    const Cost lbc{s.base.rolls + gate.rolls, s.base.el + gate.el, s.base.tickets, gate.chunks, s.base.scrubs, gate.wch};
                    if (!(lbc < best.cost)) continue;
                    if (!plan_final(w, s, best.cost, fo)) continue;
                    best.cost = fo.cost, best.fin = fo, best.src = src;
                    best.t = t, best.u = u, best.n = bn, best.from_t = e.src;
                    found = true;
                }
            };
            try_src(&C[r * NB], kC, 0, 0);
            if (B > 0) {
                try_src(&P[r * NB], kP, 0, 1);
                for (int u = 7; u >= 1; --u) try_src(&O2[(r * 7 + u - 1) * NB], kO2, u, 1);
                for (int u = 7; u >= 1; --u) try_src(&O3[(r * 7 + u - 1) * NB], kO3, u, 2);
            }
        }
        if (B == 0) {  // plain burns only: C at t+1 costs t+1
            if (t + 1 <= H) C[((t + 1) % kRing) * NB] = {static_cast<uint32_t>(t + 1), static_cast<uint32_t>(t + 1), -1};
            C[r * NB] = PC{};
            continue;
        }
        for (int n = 0; n <= B; ++n) {
            const PC c = C[r * NB + n], p = P[r * NB + n];
            if (t + 1 <= H) {
                if (c.rb != kInf) relaxC(t + 1, n, c.rb + 1, c.el + 1, 1);
                if (p.rb != kInf) relaxC(t + 1, n, p.rb + 1, p.el + 1, 2);
            }
            if (n == B) continue;
            for (int k = 1, pos = t; k <= kDrinkColumns; ++k) {
                if (pos + 1 > H) break;
                pos += w.hit(pos) ? 1 : 2;
                if (pos > H) break;
                const uint16_t back = static_cast<uint16_t>(pos - t);
                if (c.rb != kInf) {
                    if (k == kDrinkColumns) relaxC(pos, n + 1, c.rb + k, c.el + k, static_cast<uint16_t>(16 + back));
                    else relaxP(pos, n + 1, c.rb + k, c.el + kDrinkColumns, static_cast<uint16_t>(k * 32 + back));
                    if (k < kDrinkColumns) relaxO(O2, pos, kDrinkColumns - k, n + 1, c.rb + k, c.el + k, t);
                }
                if (p.rb != kInf && k < kDrinkColumns) relaxO(O3, pos, kDrinkColumns - k, n + 1, p.rb + k, p.el + k, t);
            }
        }
        for (int n = 0; n <= B; ++n) C[r * NB + n] = PC{}, P[r * NB + n] = PC{};
        for (int i = 0; i < 7 * NB; ++i) O2[r * 7 * NB + i] = PC{}, O3[r * 7 * NB + i] = PC{};
    }
    if (!found) return out;

    // Rebuild the burn prefix: segments (start offset, rolls, phase?) in time order.
    struct Seg {
        int t, k;
        bool phase;
        int8_t drink = kNoAbility;
        bool reserve = false;  // the partial phase just before the stretch's first drink or the open phase
        bool cont = false;     // the open phase the stretch continues
    };
    std::vector<Seg> segs;
    const FinalOut& fin = best.fin;
    if (best.src != kA) {
        int t = best.t, n = best.n;
        bool inP = best.src == kP;
        if (best.src == kO2 || best.src == kO3) {
            segs.push_back({best.from_t, kDrinkColumns - best.u, true, fin.cont, false, true});
            t = best.from_t, n -= 1, inP = best.src == kO3;
        }
        bool first_p = inP;
        while (t > 0 || n > 0) {
            if (B == 0) {
                segs.push_back({t - 1, 1, false});
                --t;
                continue;
            }
            const uint16_t ch = (inP ? chP : chC)[static_cast<size_t>(t) * NB + n];
            if (inP) {
                const int k = ch / 32, back = ch % 32;
                segs.push_back({t - back, k, true, kNoAbility, first_p});
                t -= back, n -= 1, inP = false;
            } else if (ch == 1 || ch == 2) {
                segs.push_back({t - 1, 1, false});
                t -= 1, inP = ch == 2;
            } else {
                const int back = ch - 16;
                segs.push_back({t - back, kDrinkColumns, true});
                t -= back, n -= 1;
            }
            first_p = false;
        }
        std::reverse(segs.begin(), segs.end());
    }
    // Drinks for the burn phases: what the stretch needs first, then the reserve, then the rest.
    int rem[kAbilities];
    for (int a = 0; a < kAbilities; ++a) rem[a] = w.stock.tickets[a] - fin.spent_t[a];
    const int8_t x = best.src == kO3 ? fin.cont : fin.first;
    for (Seg& s : segs) {
        if (!s.phase || s.cont || !s.reserve) continue;
        for (int8_t e : w.drinks)
            if (e != x && rem[e] > 0) {
                s.drink = e, rem[e]--;
                break;
            }
    }
    for (Seg& s : segs) {
        if (!s.phase || s.cont || s.drink != kNoAbility) continue;
        for (int8_t e : w.drinks)
            if (rem[e] > 0) {
                s.drink = e, rem[e]--;
                break;
            }
    }
    // Acts: burn rolls (a scrub whenever the piece is full), the last scrub, the stretch.
    int filled = k0;
    for (const Seg& s : segs) {
        for (int i = 0, pos = s.t; i < s.k; ++i) {
            if (filled == O) out.acts.push_back({ActKind::Scrub, -1, kNoAbility, kNoAbility, 0}), filled = 0;
            const int8_t d = s.phase ? s.drink : static_cast<int8_t>(kNoAbility);
            RollResult rr = roll(w.br, w.seeds[pos], d);
            pos += d == kNoAbility || rr.drink_hit ? 1 : 2;
            out.acts.push_back({s.phase ? ActKind::Drink : ActKind::Roll, static_cast<int8_t>(filled),
                                static_cast<int8_t>(rr.ability), d, static_cast<int16_t>(s.phase && i == 0 ? 1 : 0)});
            ++filled;
        }
    }
    if (best.src != kA) out.acts.push_back({ActKind::Scrub, -1, kNoAbility, kNoAbility, 0});
    out.acts.insert(out.acts.end(), fin.acts.begin(), fin.acts.end());
    out.reachable = true;
    out.cost = best.cost;
    for (int a = 0; a < kAbilities; ++a) {
        out.used.chunks[a] = fin.spent_c[a];
        out.used.tickets[a] = w.stock.tickets[a] - rem[a];
    }
    return out;
}

void plan_write_one(const PlanReq& req, std::string& r) {
    const PieceIn& p = req.pieces[0];
    JointPlan jp;
    jp.acts.resize(1);
    jp.at.resize(1);
    std::vector<int> unreachable;
    if (!piece_done(p.subs, p.goal, req.opts.fixed_order)) {
        PieceOut o = plan_scan(p, req.opts, req.stock);
        if (!o.reachable) unreachable.push_back(0);
        for (const Act& a : o.acts) {
            jp.acts[0].push_back(a);
            const bool roll = a.kind == ActKind::Roll || a.kind == ActKind::Drink;
            jp.at[0].push_back(roll ? static_cast<int>(jp.word.size()) : -1);
            if (roll) jp.word.push_back(a.kind == ActKind::Drink ? a.drink : static_cast<int8_t>(kNoAbility));
        }
    }
    plan_write_reply(req, jp, unreachable, req.opts.from + req.opts.horizon, true, r);
}

}  // namespace st
