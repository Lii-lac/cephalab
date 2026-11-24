#include "recovery.h"

#include <algorithm>

namespace st {

std::vector<Candidate> dedupe(std::vector<Candidate> out);

std::vector<Candidate> recover(uint32_t start, const BrandRolls& br, const std::vector<Observed>& obs,
                               uint32_t max_steps) {
    std::vector<Candidate> out;
    const Observed* o = obs.data();
    const size_t n = obs.size();
    uint32_t s = start;
    for (uint32_t k = 0;; ++k) {
        uint32_t after;
        if (match_run(br, o, n, s, &after)) out.push_back({k, after});
        if (k == max_steps) break;
        s = next_seed(s);
    }
    return dedupe(std::move(out));
}

std::vector<Candidate> refine(const std::vector<uint32_t>& seeds, const BrandRolls& br,
                              const std::vector<Observed>& obs) {
    std::vector<Candidate> out;
    for (uint32_t s : seeds) {
        uint32_t after;
        if (match_run(br, obs.data(), obs.size(), s, &after)) out.push_back({0, after});
    }
    return dedupe(std::move(out));
}

// Drop repeated final seeds, keeping the first of each (stable; for recover the first is the
// smallest skipped_steps).
std::vector<Candidate> dedupe(std::vector<Candidate> out) {
    if (out.size() < 2) return out;
    std::vector<std::pair<uint32_t, uint32_t>> by_seed;  // (seed, index)
    by_seed.reserve(out.size());
    for (uint32_t i = 0; i < out.size(); ++i) by_seed.push_back({out[i].seed, i});
    std::sort(by_seed.begin(), by_seed.end());
    std::vector<char> keep(out.size(), 0);
    bool dup = false;
    for (size_t i = 0; i < by_seed.size(); ++i) {
        if (i && by_seed[i].first == by_seed[i - 1].first) dup = true;
        else keep[by_seed[i].second] = 1;
    }
    if (!dup) return out;
    std::vector<Candidate> uniq;
    for (size_t i = 0; i < out.size(); ++i)
        if (keep[i]) uniq.push_back(out[i]);
    return uniq;
}

}  // namespace st
