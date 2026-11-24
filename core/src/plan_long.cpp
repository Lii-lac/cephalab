// fn "plan", 2-3 pieces with from + horizon > kMaxJointHorizon (core/API.md "plan"; plan_long.h).
// When every lane can finish within kNearHorizon seed steps, first the plan of that horizon as
// plan_lanes.cpp makes it: the lanes in order on the shared stock, merged, and the joint search
// (plan_joint.cpp) over kNearHorizon steps; a joint plan of at most kNearHorizon / 2 columns is the
// cheapest of all (a route past kNearHorizon steps takes more rolls) and is the reply. Else each
// lane's one-piece scan (plan_scan.cpp) over 0..from + horizon, lanes in order on what the earlier
// ones left (every order when one gives way, then every split of the tickets: plan_split.cpp),
// merged onto one timeline; the near plans are kept when they are cheaper.
#include <algorithm>

#include "plan_long.h"

namespace st {

namespace {

constexpr int kNearHorizon = 60;     // the joint search's horizon here
constexpr long kNearCap = 2000000;   // its work cap when the lanes in order all fit (plan_lanes.cpp's kWorkCap)
constexpr long kNearProbe = 600000;  // and when they don't (plan_lanes.cpp's kProbeCap)

// Lanes in one order, each on what the earlier ones left (its alone route when that still fits),
// merged onto one timeline. conflict: some lane's alone route didn't fit.
void sequence(const std::vector<PieceIn>& pieces, const PlanOpts& o, const Stock& stock, const std::vector<int>& order,
              const std::vector<PieceOut>& alone, LongSeq& s, bool& conflict) {
    Stock left = stock;
    s.outs.assign(pieces.size(), PieceOut{});
    for (int i : order) {
        const bool fits = fits_in(alone[i].used, left);
        conflict |= !fits;
        s.outs[i] = fits ? alone[i] : plan_scan(pieces[i], o, left);
        if (!s.outs[i].reachable) {
            s.dropped.push_back(i);
            continue;
        }
        s.kept.push_back(i);
        take(left, s.outs[i].used);
    }
    std::sort(s.kept.begin(), s.kept.end());
    std::sort(s.dropped.begin(), s.dropped.end());
    long_merge(s, pieces, stock);
}

// The plans over kNearHorizon steps: the lanes in order (seq) and the joint search (found: joint).
// False when some lane can't finish within kNearHorizon steps.
struct Near {
    LongSeq seq;
    JointPlan joint;
    bool found = false;
};

bool near_plans(const PlanReq& req, const PlanOpts& o, const std::vector<int>& live, Near& n) {
    PlanOpts on = o;
    on.horizon = kNearHorizon;
    std::vector<PieceOut> solo(req.pieces.size());
    std::vector<PieceIn> ps;
    int lo = 0;
    for (int i : live) {
        solo[i] = plan_scan(req.pieces[i], on, req.stock);
        if (!solo[i].reachable) return false;
        ps.push_back(req.pieces[i]);
        lo = std::max(lo, static_cast<int>(solo[i].cost.rolls));
    }
    // The lanes in order, each on what the earlier ones left, as plan_lanes.cpp plans them (its
    // routes, plan_search.cpp, and the exact merge): ties between routes merge differently.
    Stock left = req.stock;
    n.seq.outs.assign(req.pieces.size(), PieceOut{});
    for (int i : live) {
        const PieceOut& r = n.seq.outs[i] = plan_piece(req.pieces[i], BrandRolls(req.pieces[i].brand), on, left);
        if (!r.reachable) {
            n.seq.dropped.push_back(i);
            continue;
        }
        n.seq.kept.push_back(i);
        take(left, r.used);
    }
    long_merge(n.seq, req.pieces, req.stock, true);
    // When the lanes in order plan all, no plan needs more columns than theirs; else every lane
    // rolls at most kNearHorizon times.
    const bool all = n.seq.dropped.empty();
    const int hi = all ? static_cast<int>(n.seq.jp.word.size()) : kNearHorizon * static_cast<int>(live.size());
    n.found = lo <= hi && plan_joint(ps, on, req.stock, lo, hi, all ? kNearCap : kNearProbe, n.joint) == JointStatus::Found;
    return true;
}

void reply(const PlanReq& req, const JointPlan& jp, const std::vector<int>& kept, std::vector<int> unreachable,
           int searched_to, bool optimal, std::string& r) {
    std::sort(unreachable.begin(), unreachable.end());
    JointPlan all;
    all.word = jp.word;
    all.acts.resize(req.pieces.size());
    all.at.resize(req.pieces.size());
    for (size_t k = 0; k < kept.size(); ++k) {
        all.acts[kept[k]] = jp.acts[k];
        all.at[kept[k]] = jp.at[k];
    }
    plan_write_reply(req, all, unreachable, searched_to, true, r, optimal);
}

}  // namespace

void plan_write_long(const PlanReq& req, std::string& r) {
    const int L = static_cast<int>(req.pieces.size());
    PlanOpts o = req.opts;
    o.horizon += o.from, o.from = 0;  // lanes found within from keep their routes: one timeline
    std::vector<int> todo;
    for (int i = 0; i < L; ++i)
        if (!piece_done(req.pieces[i].subs, req.pieces[i].goal, o.fixed_order)) todo.push_back(i);
    Near nr;
    const bool near = todo.size() >= 2 && near_plans(req, o, todo, nr);
    if (near && nr.found && nr.joint.word.size() <= kNearHorizon / 2) return reply(req, nr.joint, todo, {}, o.horizon, true, r);

    // Each lane alone on all the stock (a lane that can't is unreachable), then in lane order on
    // what the earlier ones left; when that order makes a lane give way, every other order and
    // every split of the tickets too: the fewest lanes dropped, then the cheapest merged plan, wins.
    std::vector<PieceOut> alone(L);
    std::vector<int> live, unreachable;
    for (int i : todo) {
        alone[i] = plan_scan(req.pieces[i], o, req.stock);
        if (alone[i].reachable) live.push_back(i);
        else unreachable.push_back(i);
    }
    LongSeq best;
    bool conflict = false;
    sequence(req.pieces, o, req.stock, live, alone, best, conflict);
    for (std::vector<int> order = live; conflict && std::next_permutation(order.begin(), order.end());) {
        LongSeq s;
        sequence(req.pieces, o, req.stock, order, alone, s, conflict);
        if (long_better(s, best)) best = std::move(s);
    }
    if (conflict) long_split(req.pieces, o, req.stock, live, alone, best);
    bool optimal = best.kept.size() <= 1;  // for the lanes it plans
    if (near && long_better(nr.seq, best)) best = std::move(nr.seq), optimal = false;
    JointPlan jp = std::move(best.jp);
    std::vector<int> kept = best.kept;
    if (near && nr.found && (!best.dropped.empty() || long_cost(nr.joint, req.pieces, todo) < best.cost))
        jp = std::move(nr.joint), kept = live, best.dropped.clear(), optimal = false;
    unreachable.insert(unreachable.end(), best.dropped.begin(), best.dropped.end());
    reply(req, jp, kept, unreachable, o.horizon, optimal, r);
}

}  // namespace st
