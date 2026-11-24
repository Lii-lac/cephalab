const brand_traits = require('../data/BrandTraitsParam.raw.json');
const ability_order = ["MainInk_Save", "SubInk_Save", "InkRecovery_Up", "HumanMove_Up", "SquidMove_Up", "SpecialIncrease_Up", "RespawnSpecialGauge_Save", "SpecialSpec_Up", "RespawnTime_Save", "JumpTime_Save", "SubSpec_Up", "OpInkEffect_Reduction", "SubEffect_Reduction", "Action_Up"];
function next(num) {
    num ^= num << 13
    num ^= num >>> 17
    num ^= num << 5
    return num >>> 0
}

function prev(num) {
    num ^= num << 5
    num ^= num << 10
    num ^= num << 20
    num ^= num >>> 17
    num ^= num << 13
    num ^= num << 26
    return num
}

function getBrandedAbility(roll, brand) {
    for (let elem of ability_order) {
        if (brand_traits.Traits[brand].UnusualGearSkill === elem) {
            roll -= brand_traits.SkillEasilyToGetParam[0]
        } else if (brand_traits.Traits[brand].UsualGearSkill === elem) {
            roll -= brand_traits.SkillEasilyToGetParam[2]
        } else {
            roll -= brand_traits.SkillEasilyToGetParam[1]
        }
        if (roll < 0) return elem
    }
}

function getBrandedAbility_exclude(roll, brand, exclude) {
    for (let elem of ability_order) {
        if (elem === exclude) continue
        if (brand_traits.Traits[brand].UnusualGearSkill === elem) {
            roll -= brand_traits.SkillEasilyToGetParam[0]
        } else if (brand_traits.Traits[brand].UsualGearSkill === elem) {
            roll -= brand_traits.SkillEasilyToGetParam[2]
        } else {
            roll -= brand_traits.SkillEasilyToGetParam[1]
        }
        if (roll < 0) return elem
    }
}

function mod_num(a, n) {
    return ((a % n) + n) % n
}

function get_max_num(brand) {
    let max_num = ability_order.length * brand_traits.SkillEasilyToGetParam[1]
    if (brand_traits.Traits[brand].UnusualGearSkill !== "None") {
        max_num =
            (ability_order.length - 2) * brand_traits.SkillEasilyToGetParam[1] +
            brand_traits.SkillEasilyToGetParam[0] +
            brand_traits.SkillEasilyToGetParam[2]
    }
    return max_num
}

function get_max_num_exclude(brand, exclude) {
    let max_num = ability_order.length * brand_traits.SkillEasilyToGetParam[1]
    if (brand_traits.Traits[brand].UnusualGearSkill !== "None") {
        max_num =
            (ability_order.length - 2) * brand_traits.SkillEasilyToGetParam[1] +
            brand_traits.SkillEasilyToGetParam[0] +
            brand_traits.SkillEasilyToGetParam[2]
    }
    if (brand_traits.Traits[brand].UnusualGearSkill === exclude) {
        max_num -= brand_traits.SkillEasilyToGetParam[0]
    } else if (brand_traits.Traits[brand].UsualGearSkill === exclude) {
        max_num -= brand_traits.SkillEasilyToGetParam[2]
    } else {
        max_num -= brand_traits.SkillEasilyToGetParam[1]
    }
    return max_num
}

function get_roll(seed, brand, drink) {
    let max_num = get_max_num(brand)
    seed = next(seed)
    if (drink !== "None") {
        if (mod_num(seed >>> 0, 0x64) <= 0x1d) {
            return [seed, drink, true]
        } else {
            seed = next(seed)
            max_num = get_max_num_exclude(brand, drink)
            let ability_roll = mod_num(seed >>> 0, max_num)
            return [seed, getBrandedAbility_exclude(ability_roll, brand, drink), false]
        }
    } else {
        let ability_roll = mod_num(seed >>> 0, max_num)
        return [seed, getBrandedAbility(ability_roll, brand), false]
    }
}

const out = [];
const brands = Object.keys(brand_traits.Traits);
const drinks = ["None", ...ability_order];
let s = 0x12345678;
for (let i = 0; i < 3000; i++) {
  s = next(s);
  const b = brands[i % brands.length], d = drinks[i % drinks.length];
  const [ns, ab, hit] = get_roll(s, b, d);
  out.push([s, b, d, ns >>> 0, ab, hit]);
}
console.log(JSON.stringify(out));
