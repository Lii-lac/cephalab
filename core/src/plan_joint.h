// Planner internals: the joint search over the shared timeline (plan_joint.cpp: search;
// plan_rebuild.cpp: picking the chunks, the plan back out of the goal node, entry points).
#pragma once
#include <memory>
#include <string>
#include <unordered_map>

#include "plan_model.h"

namespace st {

constexpr int kMaxLetters = 1 + kAbilities;

struct JNode {
    int32_t parent;
    int8_t li;   // letter of the last column
    int8_t run;  // letter of the current phase, -1 = none
    uint8_t u;   // columns of that phase used so far
    uint16_t len, el, tk;
    uint8_t tickets[kMaxLetters];
    int32_t f[3], d[3];
};

template <class T>
struct Pool {
    std::vector<std::vector<T>> items;
    std::unordered_map<std::string, int32_t> index;
    int32_t put(std::vector<T>& v) {
        std::string k(reinterpret_cast<const char*>(v.data()), v.size() * sizeof(T));
        auto it = index.find(k);
        if (it != index.end()) return it->second;
        items.push_back(std::move(v));
        const int32_t id = static_cast<int32_t>(items.size() - 1);
        index.emplace(std::move(k), id);
        return id;
    }
};

class Joint {
public:
    Joint(const std::vector<PieceIn>& pieces, const PlanOpts& opts, const Stock& stock) : stock_(stock) {
        letters_.push_back(kNoAbility);
        for (int a = 0; a < kAbilities && opts.use_drinks; ++a)
            if (stock.tickets[a] > 0) letters_.push_back(static_cast<int8_t>(a));
        n_ = static_cast<int>(pieces.size());
        for (int i = 0; i < n_; ++i) w_[i] = g_chunk_rate ? chunk_w(pieces[i]) : 0;
        for (const PieceIn& p : pieces) models_.push_back(std::make_unique<PieceModel>(p, opts, stock, letters_));
    }
    long work() const {
        long w = static_cast<long>(nodes_.size());
        for (const auto& m : models_) w += m->work;
        return w;
    }
    JointStatus search(int R, long cap, JointPlan& out);

private:
    std::string key(const JNode& n) const {
        std::string k(reinterpret_cast<const char*>(&n.run), 2);
        k.append(reinterpret_cast<const char*>(&n.len), 2);
        k.append(reinterpret_cast<const char*>(n.tickets), letters_.size());
        k.append(reinterpret_cast<const char*>(n.f), sizeof n.f);
        k.append(reinterpret_cast<const char*>(n.d), sizeof n.d);
        return k;
    }
    // Cheapest (weighted chunks with a rate, chunks, scrubs) choice of one done outcome per piece
    // within the chunk stock.
    bool combo(const JNode& n, uint32_t& wc, uint32_t& ch, uint32_t& sc, int pick[3]) const;
    void rebuild(int R, int32_t goal, const int pick[3], JointPlan& out) const;

    Stock stock_;
    int n_ = 0;
    uint32_t w_[3] = {0, 0, 0};  // each piece's chunk_w with a rate, else 0
    std::vector<int8_t> letters_;
    std::vector<std::unique_ptr<PieceModel>> models_;
    std::vector<JNode> nodes_;
    Pool<PState> fp_;
    Pool<Outcome> dp_;
    struct Step {
        int32_t from[2], to[2], key;
        bool took, dead;
    };
    std::unordered_map<uint64_t, Step> steps_;  // per search: (piece, frontier, letter, columns left)
};


}  // namespace st
