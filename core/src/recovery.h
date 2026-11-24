// Seed recovery: find every start offset whose rolls match what was observed, and narrow a
// candidate set with rolls seen since.
#pragma once
#include <cstdint>
#include <vector>

#include "seedmath.h"

namespace st {

struct Observed {
    int ability;  // kNoAbility = seen but unknown
    int drink;    // kNoAbility = no drink
};

struct Candidate {
    uint32_t skipped_steps;
    uint32_t seed;  // seed after the observed run
};

// Runs the observed rolls from seed; true (and *after = seed after the run) when every known
// ability matches.
inline bool match_run(const BrandRolls& br, const Observed* obs, size_t n, uint32_t seed, uint32_t* after) {
    for (size_t i = 0; i < n; ++i) {
        RollResult r = roll(br, seed, obs[i].drink);
        if (obs[i].ability >= 0 && r.ability != obs[i].ability) return false;
        seed = r.seed;
    }
    *after = seed;
    return true;
}

// Tries k = 0..max_steps seed steps after start (inclusive).
std::vector<Candidate> recover(uint32_t start, const BrandRolls& br, const std::vector<Observed>& obs,
                               uint32_t max_steps);

// Keeps the seeds whose next rolls match obs; returns them advanced past the run, duplicates
// dropped (first occurrence kept), skipped_steps = 0.
std::vector<Candidate> refine(const std::vector<uint32_t>& seeds, const BrandRolls& br,
                              const std::vector<Observed>& obs);

}  // namespace st
