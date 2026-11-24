// Planner internals: one piece as the joint search (plan_joint.cpp) sees it (plan_model.cpp).
// A frontier = every state the piece can be in after taking any subsequence of the columns so
// far (it may sit out any column), with the slaps and the scrub it may do between its rolls.
#pragma once
#include <cstdint>
#include <vector>

#include "plan.h"

namespace st {

constexpr uint8_t kHInf = 255;

// No implicit padding: frontiers are compared and hashed as bytes.
struct PState {
    uint16_t spent[kAbilities];  // chunks spent by ability
    int32_t trace;               // reconstruction only: index into the trace list, -1 = none
    uint8_t t, scrubs;           // seed steps advanced, scrubs done
    int8_t slots[3];
    uint8_t pad[3];
};

// One way the piece meets its goal: what it spent.
struct Outcome {
    uint16_t spent[kAbilities];
    int32_t trace;
    uint8_t scrubs;
    uint8_t pad[3];
};

struct Trace {
    int32_t prev;
    int32_t pos;  // word index of a roll, -1 for slaps and scrubs
    Act act;
};

class PieceModel {
public:
    // letters[0] = kNoAbility (plain), then the drinks the plan may use.
    PieceModel(const PieceIn& in, const PlanOpts& opts, const Stock& stock, const std::vector<int8_t>& letters);
    // The frontier before any column: the start and what slaps and a scrub make of it.
    void root(std::vector<PState>& f, std::vector<Outcome>& done, int rem, std::vector<Trace>* tr) const;
    // Adds what rolling in column pos (letter li) makes of every state; keeps the states that can
    // still finish within rem more columns. False when nothing new came of it.
    bool step(std::vector<PState>& f, std::vector<Outcome>& done, int li, int pos, int rem,
              std::vector<Trace>* tr) const;
    // Lower bound on the rolls still needed (relaxed: any letter, slaps of stocked abilities free).
    uint8_t h(const PState& s) const { return h_at(s.t, s.slots); }
    uint8_t h_at(int t, const int8_t slots[3]) const;
    mutable long work = 0;

private:
    void close(const PState& s, std::vector<PState>& out, std::vector<Outcome>& done, int rem,
               std::vector<Trace>* tr) const;
    int cls(int slot, int a) const;  // heuristic class of ability a (kNoAbility = 0) in slot
    int code(const int8_t slots[3]) const;
    void build_h();

    PieceIn in_;
    bool fixed_, chunks_;
    int H_, nl_;
    std::vector<int8_t> letters_;
    Stock stock_;
    std::vector<int8_t> ab_;   // [t * nl + li]: what lands
    std::vector<uint8_t> st_;  // seed steps it takes, 0 = past the horizon
    std::vector<int8_t> fill_[3], over_[3];  // abilities a slap may put on slot s, empty / filled
    // Heuristic: slots seen as classes (fixed: empty/good/bad; free: empty/goal ability/other).
    int base_ = 3, ncodes_ = 27, ngoal_ = 0;
    int8_t goal_ab_[3] = {}, need_[3] = {};
    int scr_ = 0;          // code of the piece just scrubbed (its locked slots stay)
    uint8_t locked_ = 0;   // bit s: slot s is locked (kLocked)
    std::vector<uint8_t> h_;  // [t * ncodes + code]
};

// Canonical order, Pareto-minimal: done outcomes, and frontier states not beaten by a done outcome
// or by a state with the same (t, slots) that spent no more and scrubbed no more.
void normalize(std::vector<PState>& f, std::vector<Outcome>& done);

}  // namespace st
