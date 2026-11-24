// Planner internals for 2-3 pieces over long horizons (core/API.md "plan"): plan_long.cpp picks the
// lanes and their routes (lane orders, the joint search over kNearHorizon steps); plan_merge.cpp
// merges routes onto one timeline; plan_split.cpp splits the tickets between lanes.
#pragma once
#include <vector>

#include "plan.h"

namespace st {

// Some lanes' routes (outs by lane index) and their merged timeline.
struct LongSeq {
    std::vector<PieceOut> outs;
    std::vector<int> kept, dropped;  // sorted lane indexes
    JointPlan jp;
    Cost cost;
};

// Fewer lanes dropped, then the cheaper merged plan.
inline bool long_better(const LongSeq& a, const LongSeq& b) {
    return a.dropped.size() < b.dropped.size() || (a.dropped.size() == b.dropped.size() && a.cost < b.cost);
}

// The plan's (rolls, columns elapsed, tickets, chunks, scrubs, weighted chunks); jp.acts[k] is
// lane lanes[k]'s, a piece of pieces.
Cost long_cost(const JointPlan& jp, const std::vector<PieceIn>& pieces, const std::vector<int>& lanes);

// s.outs[s.kept] onto one timeline (the exact merge for short routes, else the better of a greedy
// merge and one lane after another; exact: the exact merge whatever the length): sets s.jp, s.cost.
void long_merge(LongSeq& s, const std::vector<PieceIn>& pieces, const Stock& stock, bool exact = false);

// The tickets split between the live lanes (when the lanes alone want more of some drink than
// stocked): each lane's route for every budget of tickets in all (plan_scan with ticket_cap), the
// splits within the stock tried in order of their lower bound (the most rolls of one lane): lanes
// in order, burn phases moved onto drinks the later lanes' last stretches don't need (or scanned
// again on what is left), merged; best is replaced when a split beats it.
void long_split(const std::vector<PieceIn>& pieces, const PlanOpts& o, const Stock& stock, const std::vector<int>& live,
                const std::vector<PieceOut>& alone, LongSeq& best);

}  // namespace st
