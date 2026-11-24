#include "murmur3.h"

#include <charconv>
#include <string>

namespace st {

static inline uint32_t rotl(uint32_t x, int r) { return (x << r) | (x >> (32 - r)); }

uint32_t murmur3_x86_32(const void* data, size_t len, uint32_t seed) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    const uint32_t c1 = 0xcc9e2d51u, c2 = 0x1b873593u;
    uint32_t h = seed;
    const size_t nblocks = len / 4;
    for (size_t i = 0; i < nblocks; ++i) {
        const uint8_t* b = p + i * 4;
        uint32_t k = uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 | uint32_t(b[3]) << 24;
        k *= c1;
        k = rotl(k, 15);
        k *= c2;
        h ^= k;
        h = rotl(h, 13);
        h = h * 5 + 0xe6546b64u;
    }
    const uint8_t* tail = p + nblocks * 4;
    uint32_t k = 0;
    switch (len & 3) {
        case 3: k ^= uint32_t(tail[2]) << 16; [[fallthrough]];
        case 2: k ^= uint32_t(tail[1]) << 8; [[fallthrough]];
        case 1:
            k ^= tail[0];
            k *= c1;
            k = rotl(k, 15);
            k *= c2;
            h ^= k;
    }
    h ^= static_cast<uint32_t>(len);
    h ^= h >> 16;
    h *= 0x85ebca6bu;
    h ^= h >> 13;
    h *= 0xc2b2ae35u;
    h ^= h >> 16;
    return h;
}

uint32_t start_seed(std::string_view player_key, Slot slot, uint32_t gear_id) {
    static constexpr const char* kMaps[] = {"HaveGearHeadMap", "HaveGearClothesMap", "HaveGearShoesMap"};
    std::string s;
    s.reserve(player_key.size() + 48);
    s.append(player_key);
    s += '_';
    s += kMaps[static_cast<int>(slot)];
    s += '_';
    char buf[16];
    auto r = std::to_chars(buf, buf + sizeof buf, gear_id);
    s.append(buf, r.ptr);
    if (slot == Slot::Clothes && gear_id == 26000) s += "_JUEA-00006";
    return murmur3_x86_32(s.data(), s.size(), 0);
}

}  // namespace st
