// fn "plan": request parsing and validation (core/API.md "plan"); planning and output in plan_out.cpp.
#include <algorithm>
#include <cmath>

#include "plan.h"

namespace st {

namespace {

using json::Doc;
using json::kNone;
using json::Type;

constexpr double kMaxChunkStock = 60000;
constexpr double kMaxTicketStock = 200;

struct P {
    const Doc& d;
    std::string err;

    bool bad(std::string msg) {
        err = std::move(msg);
        return false;
    }
    bool integer(uint32_t v, double lo, double hi, double& out) const {
        const json::Node& n = d.at(v);
        if (n.type != Type::Number || !std::isfinite(n.number) || std::floor(n.number) != n.number ||
            n.number < lo || n.number > hi)
            return false;
        out = n.number;
        return true;
    }
    bool boolean(uint32_t obj, const char* key, bool& out) {
        uint32_t v = d.get(obj, key);
        if (v == kNone) return bad(std::string("'") + key + "' is missing");
        if (d.at(v).type != Type::Bool) return bad(std::string("'") + key + "' must be true or false");
        out = d.at(v).boolean;
        return true;
    }
    // Three ability names or "" (what = "subs" / "goal").
    bool three(uint32_t piece, const char* key, int8_t out[3]) {
        uint32_t v = d.get(piece, key);
        const std::string k = std::string("'") + key + "'";
        if (v == kNone) return bad(k + " is missing");
        if (d.at(v).type != Type::Array || d.at(v).n != 3) return bad(k + " must be 3 ability names or \"\"");
        int i = 0;
        for (uint32_t e = d.at(v).a; e != kNone; e = d.at(e).next, ++i) {
            if (d.at(e).type != Type::String) return bad(k + " must be 3 ability names or \"\"");
            std::string_view s = d.str(e);
            if (s.empty()) {
                out[i] = kNoAbility;
                continue;
            }
            int a = ability_index(s);
            if (a < 0) return bad(k + " has an unknown ability");
            out[i] = static_cast<int8_t>(a);
        }
        return true;
    }
    // {ability: count} (optional, default empty).
    bool stock(uint32_t obj, const char* key, double max, int32_t out[kAbilities]) {
        uint32_t v = d.get(obj, key);
        if (v == kNone) return true;
        const std::string k = std::string("'") + key + "'";
        if (d.at(v).type != Type::Object) return bad(k + " must be an object {ability: count}");
        for (uint32_t e = d.at(v).a; e != kNone; e = d.at(d.at(e).next).next) {
            int a = ability_index(d.str(e));
            if (a < 0) return bad(k + " has an unknown ability");
            double n;
            if (!integer(d.at(e).next, 0, max, n))
                return bad(k + " counts must be integers 0.." + std::to_string(static_cast<int>(max)));
            out[a] = static_cast<int32_t>(n);
        }
        return true;
    }
    bool piece(uint32_t e, PlanReq& req) {
        if (d.at(e).type != Type::Object) return bad("'pieces' entries must be objects");
        uint32_t row = d.get(e, "row");
        if (row == kNone || d.at(row).type != Type::String || d.at(row).n == 0 || d.at(row).n > 64)
            return bad("'row' must be a gear row id");
        PieceIn p;
        uint32_t b = d.get(e, "brand");
        if (b == kNone || d.at(b).type != Type::String) return bad("'brand' must be a brand code (B00..B99)");
        p.brand = brand_index(d.str(b));
        if (p.brand < 0) return bad("'brand' must be a brand code (B00..B99)");
        uint32_t sv = d.get(e, "seed");
        double seed;
        if (sv == kNone || !integer(sv, 0, 4294967295.0, seed)) return bad("'seed' must be an integer 0..4294967295");
        p.seed = static_cast<uint32_t>(seed);
        if (!three(e, "subs", p.subs) || !three(e, "goal", p.goal)) return false;
        uint32_t mc = d.get(e, "maxChunks");
        double cap;
        if (mc != kNone) {
            if (!integer(mc, 0, 1000, cap)) return bad("'maxChunks' must be an integer 0..1000");
            p.max_chunks = static_cast<int>(cap);
        }
        uint32_t lv = d.get(e, "chunkLean");
        double lean;
        if (lv != kNone) {
            if (!integer(lv, 0, 2, lean)) return bad("'chunkLean' must be 0, 1 or 2");
            p.lean = static_cast<int8_t>(lean);
        }
        // Subs fill left to right: no filled slot after an empty one.
        for (int i = 1; i < 3; ++i)
            if (p.subs[i] != kNoAbility && p.subs[i - 1] == kNoAbility)
                return bad("'subs' must fill left to right");
        uint32_t ov = d.get(e, "openSlots");
        double open;
        if (ov != kNone) {
            if (!integer(ov, 1, 3, open)) return bad("'openSlots' must be 1, 2 or 3");
            p.open = static_cast<int8_t>(open);
        }
        for (int i = 0; i < 3; ++i)  // a sub sits in an open slot (stale stars): it is open
            if (p.subs[i] != kNoAbility && p.open < i + 1) p.open = static_cast<int8_t>(i + 1);
        req.rows.emplace_back(d.str(row));
        req.pieces.push_back(p);
        return true;
    }
    bool request(uint32_t obj, PlanReq& req) {
        uint32_t pv = d.get(obj, "pieces");
        if (pv == kNone) return bad("'pieces' is missing");
        if (d.at(pv).type != Type::Array || d.at(pv).n < 1 || d.at(pv).n > 3)
            return bad("'pieces' must be an array of 1 to 3 pieces");
        for (uint32_t e = d.at(pv).a; e != kNone; e = d.at(e).next)
            if (!piece(e, req)) return false;
        if (!stock(obj, "chunks", kMaxChunkStock, req.stock.chunks) ||
            !stock(obj, "drinks", kMaxTicketStock, req.stock.tickets))
            return false;
        if (!boolean(obj, "fixedOrder", req.opts.fixed_order) || !boolean(obj, "useChunks", req.opts.use_chunks) ||
            !boolean(obj, "useDrinks", req.opts.use_drinks))
            return false;
        // Locked slots: the plan opens (first, at Murch) the ones a goal ability needs; the rest stay
        // locked and a goal "" there is met. Fixed order: up to the last goal ability's slot; off: as
        // many slots as goal abilities.
        for (PieceIn& p : req.pieces) {
            int need = 0;
            for (int i = 0; i < 3; ++i)
                if (p.goal[i] != kNoAbility) need = req.opts.fixed_order ? i + 1 : need + 1;
            const int open = std::max<int>(p.open, need);
            p.unlocks = static_cast<int8_t>(open - p.open);
            for (int i = open; i < 3; ++i) p.subs[i] = kLocked;
        }
        uint32_t hv = d.get(obj, "horizon");
        double h;
        if (hv == kNone) return bad("'horizon' is missing");
        if (!integer(hv, 0, kMaxHorizon, h)) return bad("'horizon' must be an integer 0..20000");
        req.opts.horizon = static_cast<int>(h);
        uint32_t fv = d.get(obj, "from");
        double from = 0;
        if (fv != kNone && !integer(fv, 0, kMaxFrom, from)) return bad("'from' must be an integer 0..1000000");
        req.opts.from = static_cast<int>(from);
        uint32_t bv = d.get(obj, "chunkBudget");
        double budget = -1;
        if (bv != kNone && !integer(bv, 0, 100000, budget)) return bad("'chunkBudget' must be an integer 0..100000");
        req.stock.budget = static_cast<int32_t>(budget);
        uint32_t rv = d.get(obj, "chunkRate");
        double rate = 0;
        if (rv != kNone && !integer(rv, 0, 1000, rate)) return bad("'chunkRate' must be an integer 0..1000");
        req.opts.chunk_rate = static_cast<int>(rate);
        for (const PieceIn& p : req.pieces)
            for (int i = 0; i < 3; ++i)
                if (p.goal[i] >= 0) req.opts.goal_mask = static_cast<uint16_t>(req.opts.goal_mask | 1u << p.goal[i]);
        long long tickets = 0;
        for (int a = 0; a < kAbilities && req.opts.use_drinks; ++a) tickets += req.stock.tickets[a];
        if (tickets > 0 && (static_cast<long long>(req.opts.from + req.opts.horizon) + 1) * (tickets + 1) > kMaxScanCells)
            return bad("'from' + 'horizon' is too far for that many tickets: (from + horizon + 1) * (tickets + 1) must be at most " +
                       std::to_string(kMaxScanCells));
        return true;
    }
};

}  // namespace

void plan_reply(const json::Doc& d, uint32_t obj, std::string& out) {
    P p{d, {}};
    PlanReq req;
    if (!p.request(obj, req)) {
        out = "{\"ok\":false,\"error\":";
        json::put_string(out, p.err);
        out += '}';
        return;
    }
    g_chunk_rate = req.opts.use_chunks ? static_cast<uint32_t>(req.opts.chunk_rate) : 0;
    plan_write(req, out);
    g_chunk_rate = 0;
}

}  // namespace st
