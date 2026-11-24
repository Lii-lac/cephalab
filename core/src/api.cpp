// st_call: the one entry point (core/API.md "One entry point").
// JSON request in, JSON reply out; the reply lives in a thread_local buffer until the next call.
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "json.h"
#include "murmur3.h"
#include "plan.h"
#include "recovery.h"
#include "seedmath.h"

namespace {

using st::json::Doc;
using st::json::kNone;
using st::json::Type;

constexpr uint32_t kMaxRolls = 1000;
constexpr uint32_t kDefaultMaxSteps = 10000;
constexpr uint32_t kMaxSteps = 2500000;
constexpr uint32_t kMaxObserved = 1000;

thread_local std::string g_reply;

// Request reading: each getter sets err and returns false on a missing or bad field.
struct Req {
    const Doc& d;
    uint32_t obj;
    std::string err;

    bool bad(const char* key, const char* what) {
        err = "'";
        err += key;
        err += "' ";
        err += what;
        return false;
    }
    uint32_t field(uint32_t o, const char* key) const { return d.get(o, key); }

    // Integer in [lo, hi]; uses dflt when the key is missing and has_default.
    bool integer(uint32_t o, const char* key, double lo, double hi, uint32_t& out, const char* range,
                 bool has_default = false, uint32_t dflt = 0) {
        uint32_t v = field(o, key);
        if (v == kNone) {
            if (has_default) {
                out = dflt;
                return true;
            }
            return bad(key, "is missing");
        }
        const st::json::Node& n = d.at(v);
        if (n.type != Type::Number || !std::isfinite(n.number) || std::floor(n.number) != n.number ||
            n.number < lo || n.number > hi)
            return bad(key, range);
        out = static_cast<uint32_t>(n.number);
        return true;
    }
    bool u32(uint32_t o, const char* key, uint32_t& out) {
        return integer(o, key, 0, 4294967295.0, out, "must be an integer 0..4294967295");
    }
    bool brand(uint32_t o, int& out) {
        uint32_t v = field(o, "brand");
        if (v == kNone) return bad("brand", "is missing");
        if (d.at(v).type != Type::String) return bad("brand", "must be a brand code (B00..B99)");
        out = st::brand_index(d.str(v));
        if (out < 0) return bad("brand", "must be a brand code (B00..B99)");
        return true;
    }
    // Ability name or null. required = the key must be present.
    bool ability(uint32_t o, const char* key, bool required, int& out) {
        uint32_t v = field(o, key);
        out = st::kNoAbility;
        if (v == kNone) return required ? bad(key, "is missing") : true;
        if (d.at(v).type == Type::Null) return true;
        if (d.at(v).type != Type::String) return bad(key, "must be an ability name or null");
        out = st::ability_index(d.str(v));
        if (out < 0) return bad(key, "is not a known ability");
        return true;
    }
    bool observed(uint32_t o, std::vector<st::Observed>& out) {
        uint32_t v = field(o, "observed");
        if (v == kNone) return bad("observed", "is missing");
        const st::json::Node& arr = d.at(v);
        if (arr.type != Type::Array) return bad("observed", "must be an array");
        if (arr.n == 0) return bad("observed", "is empty");
        if (arr.n > kMaxObserved) return bad("observed", "has more than 1000 rolls");
        out.reserve(arr.n);
        for (uint32_t e = arr.a; e != kNone; e = d.at(e).next) {
            if (d.at(e).type != Type::Object) return bad("observed", "entries must be objects {a, drink}");
            st::Observed ob;
            if (!ability(e, "a", true, ob.ability)) return false;
            if (!ability(e, "drink", false, ob.drink)) return false;
            out.push_back(ob);
        }
        bool any_known = false;
        for (const st::Observed& ob : out) any_known |= ob.ability >= 0;
        if (!any_known) {
            err = "need at least one seen ability";
            return false;
        }
        return true;
    }
};

void error_reply(const std::string& msg) {
    g_reply = "{\"ok\":false,\"error\":";
    st::json::put_string(g_reply, msg);
    g_reply += '}';
}

void candidates_reply(const std::vector<st::Candidate>& cands) {
    std::string& r = g_reply;
    r.clear();
    r.reserve(64 + cands.size() * 44);
    r += "{\"ok\":true,\"candidates\":[";
    for (size_t i = 0; i < cands.size(); ++i) {
        if (i) r += ',';
        r += "{\"skippedSteps\":";
        st::json::put_u32(r, cands[i].skipped_steps);
        r += ",\"seed\":";
        st::json::put_u32(r, cands[i].seed);
        r += '}';
    }
    r += "],\"count\":";
    st::json::put_u64(r, cands.size());
    r += ",\"locked\":";
    r += cands.size() == 1 ? "true" : "false";
    r += '}';
}

void fn_start_seed(Req& q) {
    uint32_t pk = q.field(q.obj, "playerKey");
    if (pk == kNone) return error_reply("'playerKey' is missing");
    if (q.d.at(pk).type != Type::String || q.d.at(pk).n == 0 || q.d.at(pk).n > 256)
        return error_reply("'playerKey' must be a non-empty string");
    uint32_t sl = q.field(q.obj, "slot");
    if (sl == kNone) return error_reply("'slot' is missing");
    st::Slot slot;
    std::string_view sv = q.d.at(sl).type == Type::String ? q.d.str(sl) : std::string_view();
    if (sv == "head")
        slot = st::Slot::Head;
    else if (sv == "clothes")
        slot = st::Slot::Clothes;
    else if (sv == "shoes")
        slot = st::Slot::Shoes;
    else
        return error_reply("'slot' must be head, clothes or shoes");
    uint32_t gear_id;
    if (!q.u32(q.obj, "gearId", gear_id)) return error_reply(q.err);
    uint32_t seed = st::start_seed(q.d.str(pk), slot, gear_id);
    g_reply = "{\"ok\":true,\"seed\":";
    st::json::put_u32(g_reply, seed);
    g_reply += '}';
}

void fn_rolls(Req& q) {
    uint32_t seed, n;
    int brand, drink;
    if (!q.u32(q.obj, "seed", seed) || !q.brand(q.obj, brand) || !q.ability(q.obj, "drink", false, drink) ||
        !q.integer(q.obj, "n", 1, kMaxRolls, n, "must be an integer 1..1000"))
        return error_reply(q.err);
    st::BrandRolls br(brand);
    std::string& r = g_reply;
    r.clear();
    r.reserve(32 + n * 72);
    r += "{\"ok\":true,\"rolls\":[";
    for (uint32_t i = 0; i < n; ++i) {
        st::RollResult x = st::roll(br, seed, drink);
        seed = x.seed;
        if (i) r += ',';
        r += "{\"n\":";
        st::json::put_u32(r, i + 1);
        r += ",\"ability\":\"";
        r += st::ability_name(x.ability);
        r += "\",\"drink_hit\":";
        r += x.drink_hit ? "true" : "false";
        r += ",\"seed\":";
        st::json::put_u32(r, seed);
        r += '}';
    }
    r += "]}";
}

void fn_recover(Req& q) {
    uint32_t start, max_steps;
    int brand;
    std::vector<st::Observed> obs;
    if (!q.u32(q.obj, "start", start) || !q.brand(q.obj, brand) || !q.observed(q.obj, obs) ||
        !q.integer(q.obj, "maxSteps", 0, kMaxSteps, max_steps, "must be an integer 0..2500000", true,
                   kDefaultMaxSteps))
        return error_reply(q.err);
    st::BrandRolls br(brand);
    candidates_reply(st::recover(start, br, obs, max_steps));
}

void fn_refine(Req& q) {
    uint32_t cv = q.field(q.obj, "candidates");
    if (cv == kNone) return error_reply("'candidates' is missing");
    if (q.d.at(cv).type != Type::Array) return error_reply("'candidates' must be an array");
    std::vector<uint32_t> seeds;
    seeds.reserve(q.d.at(cv).n);
    // Each entry: a seed number, or an object with "seed" (a candidate from the last reply).
    for (uint32_t e = q.d.at(cv).a; e != kNone; e = q.d.at(e).next) {
        const st::json::Node& n = q.d.at(e);
        double v;
        if (n.type == Type::Number) {
            v = n.number;
        } else if (n.type == Type::Object) {
            uint32_t s = q.d.get(e, "seed");
            if (s == kNone || q.d.at(s).type != Type::Number)
                return error_reply("'candidates' entries must be seeds or {seed}");
            v = q.d.at(s).number;
        } else {
            return error_reply("'candidates' entries must be seeds or {seed}");
        }
        if (!std::isfinite(v) || std::floor(v) != v || v < 0 || v > 4294967295.0)
            return error_reply("'candidates' seeds must be integers 0..4294967295");
        seeds.push_back(static_cast<uint32_t>(v));
    }
    int brand;
    std::vector<st::Observed> obs;
    if (!q.brand(q.obj, brand) || !q.observed(q.obj, obs)) return error_reply(q.err);
    st::BrandRolls br(brand);
    candidates_reply(st::refine(seeds, br, obs));
}

// Test hook, not part of core/API.md: raw murmur3 over a string's UTF-8 bytes.
void fn_murmur3(Req& q) {
    uint32_t t = q.field(q.obj, "text");
    if (t == kNone || q.d.at(t).type != Type::String) return error_reply("'text' must be a string");
    uint32_t seed;
    if (!q.integer(q.obj, "seed", 0, 4294967295.0, seed, "must be an integer 0..4294967295", true, 0))
        return error_reply(q.err);
    std::string_view s = q.d.str(t);
    g_reply = "{\"ok\":true,\"hash\":";
    st::json::put_u32(g_reply, st::murmur3_x86_32(s.data(), s.size(), seed));
    g_reply += '}';
}

}  // namespace

extern "C" const char* st_call(const char* request) {
    Doc doc;
    std::string err;
    if (!doc.parse(request, err)) {
        error_reply(err);
        return g_reply.c_str();
    }
    if (doc.at(doc.root()).type != Type::Object) {
        error_reply("request must be a JSON object");
        return g_reply.c_str();
    }
    uint32_t fv = doc.get(doc.root(), "fn");
    if (fv == kNone || doc.at(fv).type != Type::String) {
        error_reply("'fn' is missing");
        return g_reply.c_str();
    }
    std::string_view fn = doc.str(fv);
    Req q{doc, doc.root(), {}};
    if (fn == "startSeed")
        fn_start_seed(q);
    else if (fn == "rolls")
        fn_rolls(q);
    else if (fn == "recover")
        fn_recover(q);
    else if (fn == "refine")
        fn_refine(q);
    else if (fn == "plan")
        st::plan_reply(doc, doc.root(), g_reply);
    else if (fn == "_murmur3")
        fn_murmur3(q);
    else
        error_reply("unknown fn");
    return g_reply.c_str();
}
