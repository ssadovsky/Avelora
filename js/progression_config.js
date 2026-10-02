/**
 * Avelora — прокачка героя: ВСЕ цифры баланса в одном месте.
 *
 * Меняйте только то, что нужно; игра пересчитывает уровни и характеристики сама
 * (сохраняется лишь накопленный опыт, уровень считается из него).
 *
 *  multipliers  — «главные ручки»: 1 = как задумано, 3 = в три раза больше.
 *      xpGain       опыт за убийства и задания
 *      statGrowth   прирост характеристик за уровень
 *      health       прирост здоровья от Силы
 *      mana         запас маны и её прирост от Интеллекта
 *      damage       прирост урона от характеристик
 *      regen        скорость восстановления маны
 *  xp           — опыт до следующего уровня: round(base * growth^(уровень-1))
 *  maxLevel     — потолок уровня
 *  levelXpSwing — за каждый уровень, на который зверь выше/ниже героя: ±этот шаг опыта
 *                 (границы minXpFactor..maxXpFactor), чтобы нельзя было фармить крыс
 *  classes      — по id персонажа (characters.js): стартовые характеристики (start),
 *                 прирост за уровень (perLevel, автоматически), запас маны и её реген
 *  derived      — во что превращаются характеристики (за каждое очко ВЫШЕ стартового)
 *  damageStat   — какая характеристика усиливает урон: оружие (weapon.stat в item.json,
 *                 по умолчанию 'str') и навыки (по типу урона)
 */
window.AVELORA_PROGRESSION = {
    maxLevel: 20,

    multipliers: { xpGain: 5, statGrowth: 1, health: 1, mana: 1, damage: 1, regen: 1 },

    xp: { base: 100, growth: 1.35 },
    levelXpSwing: 0.1,
    minXpFactor: 0.1,
    maxXpFactor: 1.5,

    classes: {
        warrior: {
            start:    { str: 14, dex: 8,  int: 4 },
            perLevel: { str: 2.5, dex: 1.0, int: 0.5 },
            baseMana: 30, manaRegen: 0.8
        },
        archer: {
            start:    { str: 7,  dex: 15, int: 6 },
            perLevel: { str: 1.0, dex: 2.5, int: 0.5 },
            baseMana: 45, manaRegen: 1.0
        },
        mage: {
            start:    { str: 5,  dex: 7,  int: 15 },
            perLevel: { str: 0.5, dex: 1.0, int: 2.5 },
            baseMana: 60, manaRegen: 1.5
        }
    },

    derived: {
        hpPerStr: 5,            // +здоровья за очко Силы
        manaPerInt: 6,          // +маны за очко Интеллекта
        manaRegenPerInt: 0.05,  // +маны/с за очко Интеллекта
        damagePerStat: 0.03,    // +30% урона за каждые 10 очков профильной характеристики
        dodgePerDex: 0.004,     // шанс уклонения за очко Ловкости
        dodgeCap: 0.35,         // потолок уклонения
        armorK: 40              // смягчение урона = броня / (броня + armorK): 10 брони ≈ 20%, 40 ≈ 50%
    },

    // Какая характеристика усиливает урон по типу урона навыка
    damageStat: { physical: 'dex', fire: 'int', lightning: 'int', default: 'int' },

    statNames: { str: 'Сила', dex: 'Ловкость', int: 'Интеллект' }
};
