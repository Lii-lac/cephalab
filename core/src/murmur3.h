// MurmurHash3 x86_32 (Austin Appleby's algorithm, public domain), and the gear start seed.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace st {

uint32_t murmur3_x86_32(const void* data, size_t len, uint32_t seed);

enum class Slot { Head, Clothes, Shoes };

// murmur3("{playerKey}_{map}_{gearId}", 0); clothes 26000 appends "_JUEA-00006".
uint32_t start_seed(std::string_view player_key, Slot slot, uint32_t gear_id);

}  // namespace st
