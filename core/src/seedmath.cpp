#include "seedmath.h"

namespace st {

int ability_index(std::string_view name) {
    for (int i = 0; i < kAbilities; ++i)
        if (name == gen::kAbilityNames[i]) return i;
    return kNoAbility;
}

const char* ability_name(int index) {
    return (index >= 0 && index < kAbilities) ? gen::kAbilityNames[index] : "";
}

int brand_index(std::string_view code) {
    for (int i = 0; i < gen::kBrandCount; ++i)
        if (code == gen::kBrands[i].code) return i;
    bool well_formed = code.size() == 3 && code[0] == 'B' && code[1] >= '0' && code[1] <= '9' &&
                       code[2] >= '0' && code[2] <= '9';
    return well_formed ? gen::kNoneBrand : -1;
}

static uint32_t weight(const gen::BrandRow& row, int a) {
    if (row.unusual == a) return gen::kWeightUnusual;
    if (row.usual == a) return gen::kWeightUsual;
    return gen::kWeightNormal;
}

static void build(Lut& t, const gen::BrandRow& row, int exclude) {
    t.total = 0;
    for (int a = 0; a < kAbilities; ++a) {
        if (a == exclude) continue;
        for (uint32_t w = weight(row, a); w > 0; --w) t.pick[t.total++] = static_cast<int8_t>(a);
    }
}

BrandRolls::BrandRolls(int brand) {
    const gen::BrandRow& row = gen::kBrands[(brand >= 0 && brand < gen::kBrandCount) ? brand : gen::kNoneBrand];
    build(plain, row, kNoAbility);
    for (int d = 0; d < kAbilities; ++d) build(excl[d], row, d);
}

}  // namespace st
