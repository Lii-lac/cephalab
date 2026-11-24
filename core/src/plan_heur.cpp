// The rolls-to-go bound of one piece (plan_model.h): slots seen as classes, relaxed slaps.
#include <algorithm>

#include "plan_model.h"

namespace st {

int PieceModel::cls(int slot, int a) const {
    if (a == kNoAbility) return 0;
    if (fixed_) return in_.goal[slot] == kNoAbility || a == in_.goal[slot] ? 1 : 2;
    for (int j = 0; j < ngoal_; ++j)
        if (goal_ab_[j] == a) return 1 + j;
    return ngoal_ + 1;
}

int PieceModel::code(const int8_t slots[3]) const {
    return cls(0, slots[0]) + base_ * (cls(1, slots[1]) + base_ * cls(2, slots[2]));
}

uint8_t PieceModel::h_at(int t, const int8_t slots[3]) const { return h_[t * ncodes_ + code(slots)]; }

// Backward over t; within a seed step, the relaxed slaps and the scrub (free) to a fixpoint.
void PieceModel::build_h() {
    const int nc = ncodes_, b = base_;
    h_.assign(static_cast<size_t>(H_ + 1) * nc, kHInf);
    int8_t sc[3] = {in_.subs[0], in_.subs[1], in_.subs[2]};
    scrub_slots(sc);
    scr_ = code(sc);
    for (int s = 0; s < 3; ++s)
        if (in_.subs[s] == kLocked) locked_ = static_cast<uint8_t>(locked_ | 1u << s);
    bool any_stock = false;
    for (int a = 0; a < kAbilities; ++a) any_stock |= chunks_ && stock_.chunks[a] >= 10;
    auto ok = [&](int a) { return chunks_ && stock_.chunks[a] >= 10; };
    auto dec = [&](int code, int c[3]) { c[0] = code % b, c[1] = code / b % b, c[2] = code / (b * b); };
    auto enc = [&](const int c[3]) { return c[0] + b * (c[1] + b * c[2]); };
    auto adone = [&](const int c[3]) {
        if (fixed_) return c[0] == 1 && c[1] == 1 && c[2] == 1;
        int n[3] = {0, 0, 0};
        for (int j = 0; j < 3; ++j) {
            if (c[j] == 0) return false;
            if (c[j] <= ngoal_) ++n[c[j] - 1];
        }
        for (int j = 0; j < ngoal_; ++j)
            if (n[j] < need_[j]) return false;
        return true;
    };
    for (int t = H_; t >= 0; --t) {
        uint8_t* row = &h_[static_cast<size_t>(t) * nc];
        for (int k = 0; k < nc; ++k) {
            int c[3];
            dec(k, c);
            if (adone(c)) {
                row[k] = 0;
                continue;
            }
            int fe = 0;
            while (fe < 3 && c[fe] != 0) ++fe;
            if (fe == 3 || t >= H_) continue;
            for (int li = 0; li < nl_; ++li) {
                const int s = st_[t * nl_ + li];
                if (!s) continue;
                int c2[3] = {c[0], c[1], c[2]};
                c2[fe] = cls(fe, ab_[t * nl_ + li]);
                const uint8_t v = h_[static_cast<size_t>(t + s) * nc + enc(c2)];
                if (v < kHInf - 1 && v + 1 < row[k]) row[k] = static_cast<uint8_t>(v + 1);
            }
        }
        for (bool changed = true; changed;) {
            changed = false;
            for (int k = 0; k < nc; ++k) {
                int c[3];
                dec(k, c);
                uint8_t v = row[k];
                if (k != scr_) v = std::min(v, row[scr_]);
                int fe = 0;
                while (fe < 3 && c[fe] != 0) ++fe;
                for (int j = 0; j < 3; ++j) {
                    if ((c[j] == 0 && j != fe) || (locked_ >> j & 1)) continue;
                    int c2[3] = {c[0], c[1], c[2]};
                    if (fixed_) {
                        if (c[j] == 1) continue;
                        if (in_.goal[j] != kNoAbility ? !ok(in_.goal[j]) : !(c[j] == 0 && any_stock)) continue;
                        c2[j] = 1;
                        v = std::min(v, row[enc(c2)]);
                        continue;
                    }
                    for (int g = 0; g < ngoal_; ++g) {
                        if (!ok(goal_ab_[g])) continue;
                        c2[j] = 1 + g;
                        v = std::min(v, row[enc(c2)]);
                    }
                    if (c[j] == 0 && any_stock) {
                        c2[j] = ngoal_ + 1;
                        v = std::min(v, row[enc(c2)]);
                    }
                }
                if (v < row[k]) row[k] = v, changed = true;
            }
        }
    }
}

}  // namespace st
