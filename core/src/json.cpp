#include "json.h"

#include <charconv>
#include <cstdlib>
#include <cstring>

namespace st::json {

namespace {
constexpr int kMaxDepth = 64;

int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

void put_utf8(std::string& s, uint32_t cp) {
    if (cp < 0x80) {
        s += char(cp);
    } else if (cp < 0x800) {
        s += char(0xC0 | (cp >> 6));
        s += char(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        s += char(0xE0 | (cp >> 12));
        s += char(0x80 | ((cp >> 6) & 0x3F));
        s += char(0x80 | (cp & 0x3F));
    } else {
        s += char(0xF0 | (cp >> 18));
        s += char(0x80 | ((cp >> 12) & 0x3F));
        s += char(0x80 | ((cp >> 6) & 0x3F));
        s += char(0x80 | (cp & 0x3F));
    }
}
}  // namespace

bool Doc::fail(const char* msg) {
    if (!err_) {
        err_ = msg;
        err_at_ = static_cast<size_t>(p_ - begin_);
    }
    return false;
}

uint32_t Doc::add(Type t) {
    nodes_.emplace_back();
    nodes_.back().type = t;
    return static_cast<uint32_t>(nodes_.size() - 1);
}

void Doc::skip_ws() {
    while (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r') ++p_;
}

bool Doc::string_into_arena(uint32_t& off, uint32_t& len) {
    // p_ is at the opening quote.
    ++p_;
    off = static_cast<uint32_t>(arena_.size());
    for (;;) {
        const char* run = p_;
        while (*p_ != '"' && *p_ != '\\' && static_cast<unsigned char>(*p_) >= 0x20) ++p_;
        arena_.append(run, p_);
        char c = *p_;
        if (c == '"') {
            ++p_;
            break;
        }
        if (c == '\0') return fail("unterminated string");
        if (c != '\\') return fail("control character in string");
        ++p_;
        char e = *p_++;
        switch (e) {
            case '"': arena_ += '"'; break;
            case '\\': arena_ += '\\'; break;
            case '/': arena_ += '/'; break;
            case 'b': arena_ += '\b'; break;
            case 'f': arena_ += '\f'; break;
            case 'n': arena_ += '\n'; break;
            case 'r': arena_ += '\r'; break;
            case 't': arena_ += '\t'; break;
            case 'u': {
                auto read4 = [&](uint32_t& v) {
                    v = 0;
                    for (int i = 0; i < 4; ++i) {
                        int h = hex(p_[i]);
                        if (h < 0) return false;
                        v = v * 16 + uint32_t(h);
                    }
                    p_ += 4;
                    return true;
                };
                uint32_t cp;
                if (!read4(cp)) return fail("bad \\u escape");
                if (cp >= 0xDC00 && cp <= 0xDFFF) return fail("lone low surrogate");
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    uint32_t lo;
                    if (p_[0] != '\\' || p_[1] != 'u') return fail("lone high surrogate");
                    p_ += 2;
                    if (!read4(lo) || lo < 0xDC00 || lo > 0xDFFF) return fail("bad surrogate pair");
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                }
                put_utf8(arena_, cp);
                break;
            }
            default:
                --p_;
                return fail("bad escape");
        }
    }
    len = static_cast<uint32_t>(arena_.size() - off);
    return true;
}

bool Doc::number(double& out) {
    const char* s = p_;
    bool neg = false;
    if (*p_ == '-') {
        neg = true;
        ++p_;
    }
    if (*p_ == '0') {
        ++p_;
    } else if (*p_ >= '1' && *p_ <= '9') {
        while (*p_ >= '0' && *p_ <= '9') ++p_;
    } else {
        return fail("bad number");
    }
    bool integer = true;
    if (*p_ == '.') {
        integer = false;
        ++p_;
        if (!(*p_ >= '0' && *p_ <= '9')) return fail("bad number");
        while (*p_ >= '0' && *p_ <= '9') ++p_;
    }
    if (*p_ == 'e' || *p_ == 'E') {
        integer = false;
        ++p_;
        if (*p_ == '+' || *p_ == '-') ++p_;
        if (!(*p_ >= '0' && *p_ <= '9')) return fail("bad number");
        while (*p_ >= '0' && *p_ <= '9') ++p_;
    }
    size_t len = static_cast<size_t>(p_ - s);
    size_t digits = len - (neg ? 1 : 0);
    if (integer && digits <= 15) {
        uint64_t v = 0;
        for (const char* q = s + (neg ? 1 : 0); q < p_; ++q) v = v * 10 + uint64_t(*q - '0');
        out = neg ? -double(v) : double(v);
        return true;
    }
    // Grammar already checked, so strtod sees exactly the JSON number.
    std::string buf(s, len);
    out = std::strtod(buf.c_str(), nullptr);
    return true;
}

uint32_t Doc::value(int depth) {
    if (depth > kMaxDepth) {
        fail("nested too deep");
        return kNone;
    }
    skip_ws();
    char c = *p_;
    if (c == '{' || c == '[') {
        const bool obj = c == '{';
        const char close = obj ? '}' : ']';
        uint32_t idx = add(obj ? Type::Object : Type::Array);
        nodes_[idx].a = kNone;
        ++p_;
        skip_ws();
        if (*p_ == close) {
            ++p_;
            return idx;
        }
        uint32_t last = kNone;
        auto link = [&](uint32_t child) {
            if (last == kNone)
                nodes_[idx].a = child;
            else
                nodes_[last].next = child;
            last = child;
        };
        for (;;) {
            if (obj) {
                skip_ws();
                if (*p_ != '"') {
                    fail("expected a key");
                    return kNone;
                }
                uint32_t off, len;
                if (!string_into_arena(off, len)) return kNone;
                uint32_t k = add(Type::String);
                nodes_[k].a = off;
                nodes_[k].n = len;
                link(k);
                skip_ws();
                if (*p_ != ':') {
                    fail("expected ':'");
                    return kNone;
                }
                ++p_;
            }
            uint32_t v = value(depth + 1);
            if (v == kNone) return kNone;
            link(v);
            nodes_[idx].n++;
            skip_ws();
            if (*p_ == ',') {
                ++p_;
                continue;
            }
            if (*p_ == close) {
                ++p_;
                return idx;
            }
            fail(obj ? "expected ',' or '}'" : "expected ',' or ']'");
            return kNone;
        }
    }
    if (c == '"') {
        uint32_t off, len;
        if (!string_into_arena(off, len)) return kNone;
        uint32_t idx = add(Type::String);
        nodes_[idx].a = off;
        nodes_[idx].n = len;
        return idx;
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        double d;
        if (!number(d)) return kNone;
        uint32_t idx = add(Type::Number);
        nodes_[idx].number = d;
        return idx;
    }
    auto word = [&](const char* w, Type t, bool b) {
        size_t n = std::strlen(w);
        if (std::strncmp(p_, w, n) != 0) {
            fail("unexpected character");
            return kNone;
        }
        p_ += n;
        uint32_t idx = add(t);
        nodes_[idx].boolean = b;
        return idx;
    };
    if (c == 't') return word("true", Type::Bool, true);
    if (c == 'f') return word("false", Type::Bool, false);
    if (c == 'n') return word("null", Type::Null, false);
    fail(c == '\0' ? "unexpected end of input" : "unexpected character");
    return kNone;
}

bool Doc::parse(const char* text, std::string& error) {
    nodes_.clear();
    arena_.clear();
    err_ = nullptr;
    if (!text) {
        error = "no input";
        return false;
    }
    begin_ = p_ = text;
    uint32_t root = value(0);
    if (root != kNone) {
        skip_ws();
        if (*p_ != '\0') fail("trailing characters");
    }
    if (err_) {
        error = "bad JSON: ";
        error += err_;
        error += " at byte ";
        put_u64(error, err_at_);
        return false;
    }
    return true;
}

uint32_t Doc::get(uint32_t object, std::string_view key) const {
    if (object >= nodes_.size() || nodes_[object].type != Type::Object) return kNone;
    for (uint32_t k = nodes_[object].a; k != kNone;) {
        uint32_t v = nodes_[k].next;
        if (str(k) == key) return v;
        k = nodes_[v].next;
    }
    return kNone;
}

void put_string(std::string& out, std::string_view s) {
    static const char* kHex = "0123456789abcdef";
    out += '"';
    for (char ch : s) {
        unsigned char c = static_cast<unsigned char>(ch);
        if (c == '"' || c == '\\') {
            out += '\\';
            out += ch;
        } else if (c < 0x20) {
            out += "\\u00";
            out += kHex[c >> 4];
            out += kHex[c & 15];
        } else {
            out += ch;
        }
    }
    out += '"';
}

void put_u64(std::string& out, uint64_t v) {
    char buf[24];
    auto r = std::to_chars(buf, buf + sizeof buf, v);
    out.append(buf, r.ptr);
}

void put_u32(std::string& out, uint32_t v) { put_u64(out, v); }

}  // namespace st::json
