// A small JSON reader (flat node array, strings decoded into one arena) and writer helpers.
// No exceptions: parse() reports errors through its return value.
#pragma once
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace st::json {

enum class Type : uint8_t { Null, Bool, Number, String, Array, Object };

constexpr uint32_t kNone = 0xFFFFFFFFu;

struct Node {
    Type type = Type::Null;
    bool boolean = false;
    uint32_t a = 0;         // String: arena offset. Array/Object: first child (kNone if empty).
    uint32_t n = 0;         // String: byte length. Array/Object: element / member count.
    uint32_t next = kNone;  // next sibling
    double number = 0;
};

// Object members are stored as key (String node) then value, as consecutive siblings.
class Doc {
public:
    bool parse(const char* text, std::string& error);

    const Node& at(uint32_t i) const { return nodes_[i]; }
    std::string_view str(uint32_t i) const { return {arena_.data() + nodes_[i].a, nodes_[i].n}; }
    uint32_t root() const { return 0; }
    // Value of key in an object node, or kNone.
    uint32_t get(uint32_t object, std::string_view key) const;

private:
    uint32_t value(int depth);
    bool string_into_arena(uint32_t& off, uint32_t& len);
    bool number(double& out);
    void skip_ws();
    bool fail(const char* msg);
    uint32_t add(Type t);

    const char* p_ = nullptr;
    const char* begin_ = nullptr;
    const char* err_ = nullptr;
    size_t err_at_ = 0;
    std::vector<Node> nodes_;
    std::string arena_;
};

// Writer helpers: append to an output string.
void put_string(std::string& out, std::string_view s);  // quoted, escaped
void put_u32(std::string& out, uint32_t v);
void put_u64(std::string& out, uint64_t v);

}  // namespace st::json
