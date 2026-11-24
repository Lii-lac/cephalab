// Roll math: xorshift32, brand weights, one sub-slot roll with or without a drink.
// Same results as s3seed/seedmath.py (the reference).
#pragma once
#include <cstdint>
#include <string_view>

#include "gen/tables.h"

namespace st {

constexpr int kAbilities = gen::kAbilityCount;
constexpr int kNoAbility = -1;

inline uint32_t next_seed(uint32_t s) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

// Ability index for an internal name, or kNoAbility.
int ability_index(std::string_view name);
const char* ability_name(int index);

// Brand row for a code: a table key, or a well-formed unknown code (B00..B99) -> the None row.
// Returns -1 when the string isn't a brand code at all.
int brand_index(std::string_view code);

// Weighted pick tables for one brand: roll value -> ability, with no exclusion and with each
// ability excluded (the drink-miss roll). Built per call, on the stack or heap of the caller.
struct Lut {
    uint32_t total = 0;
    int8_t pick[gen::kMaxTotal] = {};
};

struct BrandRolls {
    Lut plain;
    Lut excl[kAbilities];
    explicit BrandRolls(int brand);
};

struct RollResult {
    uint32_t seed;
    int ability;
    bool drink_hit;
};

// One roll. drink = ability index or kNoAbility.
inline RollResult roll(const BrandRolls& br, uint32_t seed, int drink) {
    seed = next_seed(seed);
    if (drink >= 0) {
        if (seed % 100 <= 0x1D) return {seed, drink, true};
        seed = next_seed(seed);
        const Lut& t = br.excl[drink];
        return {seed, t.pick[seed % t.total], false};
    }
    return {seed, br.plain.pick[seed % br.plain.total], false};
}

}  // namespace st
