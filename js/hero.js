/**
 * Avelora — Hero progression: level / experience / stats / mana (balance numbers: progression_config.js)
 *
 *  - Only EXPERIENCE is saved (state.xp); the level is computed from it, so tuning the curve in the
 *    config never breaks a save. Level 1 = 0 xp, `maxLevel` is the cap.
 *  - Stats (Сила / Ловкость / Интеллект) grow automatically with the level per class
 *    (config `classes[id].perLevel`), plus bonuses from equipped items (item.json `stats`).
 *  - Derived values: max health (combat.js asks `maxHp()`), mana pool + regeneration, damage
 *    multipliers (`meleeMult(weapon)` for weapons, `skillMult(skillDef)` for spells/arrows).
 *  - Mana: skills may cost `mana` (skill.json); the cooldown stays on top of it. HUD: #mana-bar / #xp-bar.
 *  - XP sources: creatures (creature.json `xp`, `level`) via 'game:creatureKilled', quests
 *    (quest.json `reward.xp`) via dialog.js. A creature far below the hero gives less.
 * Everything advances in update(delta) (game time) -> frozen on pause.
 */
(function () {
    'use strict';

    const CFG = () => window.AVELORA_PROGRESSION;
    const STATS = ['str', 'dex', 'int'];

    /** XP needed to go from `level` to `level + 1`. */
    function xpStep(level) {
        const c = CFG().xp;
        return Math.max(1, Math.round(c.base * Math.pow(c.growth, level - 1)));
    }
    /** Total XP at which `level` is reached (level 1 = 0). */
    function xpForLevel(level) {
        let sum = 0;
        for (let l = 1; l < level; l++) sum += xpStep(l);
        return sum;
    }
    function levelForXp(xp) {
        const max = CFG().maxLevel;
        let level = 1, need = xpStep(1), left = Math.max(0, xp);
        while (level < max && left >= need) { left -= need; level++; need = xpStep(level); }
        return level;
    }

    class AveloraHero {
        constructor(game) {
            this.game = game;
            this.state = null;
            this.charId = null;
            this.level = 1;
            this.mana = 0;
            this.maxMana = 0;
            this.manaRegen = 0;
            this._manaShown = -1;
            this._xpShown = '';
            this.manaBar = document.getElementById('mana-bar');
            this.manaFill = document.getElementById('mana-fill');
            this.manaText = document.getElementById('mana-text');
            this.xpBar = document.getElementById('xp-bar');
            this.xpFill = document.getElementById('xp-fill');
            this.xpText = document.getElementById('xp-text');
            window.addEventListener('game:creatureKilled', (e) => this.onKilled(e.detail));
        }

        // -----------------------------------------------------------
        // Binding / level / stats
        // -----------------------------------------------------------
        /** New character in play (main.js). Full mana, health is set by combat.bindCharacter. */
        bind(state, charConfig) {
            this.state = state;
            this.charId = charConfig ? charConfig.id : null;
            this.baseHp = (charConfig && charConfig.maxHp) || 100;
            this.refresh(false);
            this.mana = this.maxMana;
            this._manaShown = -1; this._xpShown = '';
            this.renderBars(true);
        }

        classCfg() {
            const cl = CFG().classes;
            return cl[this.charId] || cl.warrior;
        }

        get xp() { return this.state ? this.state.xp : 0; }
        get maxLevel() { return CFG().maxLevel; }

        /** Recomputes level + derived values from the saved XP (and gear). `heal`: top up health/mana to the new maximums. */
        refresh(heal) {
            const prev = this.level;
            this.level = levelForXp(this.xp);
            const cls = this.classCfg(), M = CFG().multipliers, D = CFG().derived;
            const st = this.stats();
            this.maxMana = Math.round(cls.baseMana + Math.max(0, st.int - cls.start.int) * D.manaPerInt * M.mana);
            this.manaRegen = (cls.manaRegen + Math.max(0, st.int - cls.start.int) * D.manaRegenPerInt) * M.regen;
            if (this.mana > this.maxMana || heal) this.mana = this.maxMana;
            const cb = this.game.combat;
            if (cb) {
                const hp = this.maxHp();
                if (cb.maxHp !== hp) {
                    const full = heal || cb.hp >= cb.maxHp;
                    cb.maxHp = hp;
                    cb.hp = full ? hp : Math.min(cb.hp, hp);
                    cb.renderHp(true);
                }
            }
            return this.level !== prev;
        }

        /** Stat bonuses of equipped items: { str, dex, int } (item.json `stats`). */
        gearStats() {
            const out = { str: 0, dex: 0, int: 0 };
            const eq = this.state && this.state.equipped;
            if (!eq) return out;
            Object.keys(eq).forEach(slot => {
                const def = eq[slot] ? window.AveloraItems.get(eq[slot]) : null;
                if (def && def.stats) STATS.forEach(k => { out[k] += Number(def.stats[k]) || 0; });
            });
            return out;
        }

        /** Armor rating from worn items (item.json `armor`). */
        armor() {
            const eq = this.state && this.state.equipped, M = CFG().multipliers;
            let a = 0;
            if (eq) Object.keys(eq).forEach(slot => { const d = eq[slot] ? window.AveloraItems.get(eq[slot]) : null; if (d && d.armor) a += Number(d.armor) || 0; });
            return a * (M.armor || 1);
        }

        /** Share of incoming damage absorbed by armor, 0..1. */
        mitigation() {
            const a = this.armor();
            return a > 0 ? a / (a + CFG().derived.armorK) : 0;
        }

        /** Chance (0..cap) to dodge an attack completely, from Ловкость. */
        dodge() {
            const D = CFG().derived;
            return Math.max(0, Math.min(D.dodgeCap, this.stats().dex * D.dodgePerDex));
        }

        /** Base stats from class + level (no gear). */
        baseStats() {
            const cls = this.classCfg(), g = CFG().multipliers.statGrowth, out = {};
            STATS.forEach(k => { out[k] = cls.start[k] + cls.perLevel[k] * (this.level - 1) * g; });
            return out;
        }

        /** Total stats (class + level + gear). */
        stats() {
            const b = this.baseStats(), g = this.gearStats(), out = {};
            STATS.forEach(k => { out[k] = b[k] + g[k]; });
            return out;
        }

        /** Points above the class's starting value (what the multipliers act on). */
        gain(stat) { return Math.max(0, this.stats()[stat] - this.classCfg().start[stat]); }

        maxHp() {
            return Math.max(1, Math.round(this.baseHp + this.gain('str') * CFG().derived.hpPerStr * CFG().multipliers.health));
        }

        /** Damage multiplier of a weapon (item.json weapon.stat, default 'str'). */
        meleeMult(weapon) {
            const stat = (weapon && weapon.stat) || 'str';
            return 1 + this.gain(stat) * CFG().derived.damagePerStat * CFG().multipliers.damage;
        }

        /** Damage multiplier of a skill (by its damage type, or skill.json `stat`). */
        skillMult(def) {
            const map = CFG().damageStat;
            const stat = (def && def.stat) || map[(def && def.damage && def.damage.type) || 'default'] || map.default;
            return 1 + this.gain(stat) * CFG().derived.damagePerStat * CFG().multipliers.damage;
        }

        // -----------------------------------------------------------
        // Experience
        // -----------------------------------------------------------
        /** XP progress inside the current level: { have, need, frac, max }. */
        progress() {
            if (this.level >= this.maxLevel) return { have: 0, need: 0, frac: 1, max: true };
            const have = this.xp - xpForLevel(this.level), need = xpStep(this.level);
            return { have, need, frac: Math.max(0, Math.min(1, have / need)), max: false };
        }

        /** Adds XP (the xpGain multiplier is applied here). Returns the amount given. */
        addXp(raw) {
            if (!this.state || !(raw > 0) || this.level >= this.maxLevel) return 0;
            const amount = Math.max(1, Math.round(raw * CFG().multipliers.xpGain));
            const cap = xpForLevel(this.maxLevel);
            const old = this.level;
            this.state.addXp(amount, cap);
            const ui = this.game.ui;
            if (ui && ui.floatText) ui.floatText(`+${amount} опыта`, 'info', 0.25);
            if (this.refresh(false) && this.level > old) this.onLevelUp(old, this.level);
            this.renderBars(true);
            if (ui && ui.refreshHero) ui.refreshHero();
            return amount;
        }

        onLevelUp(oldLevel, newLevel) {
            this.refresh(true);
            const cb = this.game.combat;
            if (cb && cb.hp < cb.maxHp) { cb.hp = cb.maxHp; cb.renderHp(true); }
            const ui = this.game.ui;
            if (ui && ui.floatText) ui.floatText(`Уровень ${newLevel}!`, 'good', 0.55);
            this.playLevelUpFx();
            window.dispatchEvent(new CustomEvent('game:levelUp', { detail: { from: oldLevel, to: newLevel } }));
        }

        /** Quick golden rune burst under the hero (recall_fx.js, mode 'levelup'); never blocks input. */
        playLevelUpFx() {
            try {
                const g = this.game, c = g.character, sk = g.skills;
                const fxSys = sk && sk.getRecallFx && sk.getRecallFx();
                if (!c || !c.position || !fxSys) return;
                fxSys.start(c.position.x, c.position.z, { mode: 'levelup', duration: 1.1, radius: 1.35, follow: true, color: '#ffd24d', core: '#fff6cf' });
            } catch (e) { console.warn('level-up fx', e); }
        }

        onKilled(d) {
            if (!d || !this.state) return;
            const def = (window.GAME_CONTENT && window.GAME_CONTENT.creatures && window.GAME_CONTENT.creatures[d.type]) || null;
            if (!def) return;
            const base = Number.isFinite(def.xp) ? def.xp : Math.max(1, Math.round((def.hp || 10) / 4));
            const lvl = Number.isFinite(def.level) ? def.level : 1;
            const c = CFG();
            const k = Math.max(c.minXpFactor, Math.min(c.maxXpFactor, 1 + (lvl - this.level) * c.levelXpSwing));
            this.addXp(base * k);
        }

        // -----------------------------------------------------------
        // Mana
        // -----------------------------------------------------------
        /** Pays `cost` mana; false (nothing spent) if there is not enough. */
        spend(cost) {
            if (!(cost > 0)) return true;
            if (this.mana + 1e-6 < cost) return false;
            this.mana -= cost;
            this.renderBars();
            return true;
        }

        update(delta) {
            if (!this.state) return;
            if (this.mana < this.maxMana && this.manaRegen > 0) {
                this.mana = Math.min(this.maxMana, this.mana + this.manaRegen * delta);
                this.renderBars();
            }
        }

        renderBars(force) {
            const shown = Math.floor(this.mana);
            if (force || shown !== this._manaShown) {
                this._manaShown = shown;
                if (this.manaBar) this.manaBar.style.display = this.maxMana > 0 ? '' : 'none';
                if (this.manaFill) this.manaFill.style.width = (this.maxMana > 0 ? Math.max(0, Math.min(1, this.mana / this.maxMana)) * 100 : 0).toFixed(1) + '%';
                if (this.manaText) this.manaText.textContent = `${shown} / ${this.maxMana}`;
                if (this.manaBar) this.manaBar.title = `Мана: ${shown} / ${this.maxMana}`;
            }
            const p = this.progress();
            const key = `${this.level}|${p.have}|${p.need}`;
            if (force || key !== this._xpShown) {
                this._xpShown = key;
                if (this.xpFill) this.xpFill.style.width = (p.frac * 100).toFixed(1) + '%';
                const label = p.max ? `Ур. ${this.level} · макс.` : `Ур. ${this.level} · ${p.have} / ${p.need}`;
                if (this.xpText) this.xpText.textContent = label;
                if (this.xpBar) this.xpBar.title = `Опыт: ${label}`;
                const portraitWrap = document.getElementById('player-portrait-btn');
                if (portraitWrap) {
                    const deg = Math.max(0, Math.min(360, p.frac * 360)).toFixed(1);
                    portraitWrap.style.setProperty('--xp-deg', `${deg}deg`);
                    portraitWrap.title = `Персонаж (C)\n${label}`;
                }
            }
            const lvlBadge = document.getElementById('player-level-badge');
            if (lvlBadge && lvlBadge.textContent !== String(this.level)) {
                lvlBadge.textContent = this.level;
            }
        }
    }

    window.AveloraHero = AveloraHero;
    window.AveloraProgress = { xpStep, xpForLevel, levelForXp };
})();
