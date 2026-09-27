/**
 * Avelora — Persistent per-character game state (inventory, hotbar, collected
 * pickups, equipment)
 *
 * Deliberately SEPARATE from the position save (save.js, `avelora_save_<id>`,
 * written every 20 s): that format stays untouched so existing players' saves
 * keep working. This one lives under its own key:
 *
 *   avelora_state_<characterId> = {
 *     version: 1, characterId,
 *     inventory: Array(32) of {item, count} | null,
 *     hotbar:    Array(10) of {type: 'skill'|'item', id} | null,
 *     pickupsTaken: { <locationId>: { <pickupId>: takenCount } },
 *     equipped:  { right: itemId | null },
 *     // --- optional since the combat/harvest milestone (still version 1: a
 *     // --- state without them loads as "nothing dropped/killed/felled, 0 s") ---
 *     ground:   { <locationId>: [{ uid, item, count, x, z, r }] },  // dynamic piles
 *     killed:   { <locationId>: { <creatureSpawnId>: playTimeAtDeath } },
 *     felled:   { <locationId>: { <treeObjectId>: playTimeAtFell } },
 *     playTime: seconds of PLAYED (unpaused, in-world) time — respawn/regrow clock
 *   }
 *
 * WRITE-ON-CHANGE: the state is written immediately whenever something in it
 * changes (pickup, bag/hotbar rearrange, equip) — it's tiny, so this is cheap —
 * plus once on beforeunload as a safety net. There is no periodic timer.
 *
 * Loading never crashes: missing / corrupt / unknown-version state -> a fresh
 * empty state; known state is sanitized (unknown items/skills dropped, counts
 * clamped to stackMax, skills the character doesn't have removed from the bar).
 * A player with an old position save and no state key simply starts with an
 * empty bag and sees all pickups in the world.
 */
(function () {
    'use strict';

    const STATE_VERSION = 1;
    const KEY_PREFIX = 'avelora_state_';
    const HOTBAR_SIZE = 10;

    function keyFor(characterId) { return KEY_PREFIX + characterId; }

    /** Skill ids this character may use (content/characters/<id>/skills.json). */
    function characterSkills(characterId) {
        const chars = (window.GAME_CONTENT && window.GAME_CONTENT.characters) || {};
        const skills = (window.GAME_CONTENT && window.GAME_CONTENT.skills) || {};
        const cfg = chars[characterId];
        if (!cfg || !Array.isArray(cfg.skills)) return [];
        return cfg.skills.filter(id => Object.prototype.hasOwnProperty.call(skills, id));
    }

    function sanitizeInventory(raw) {
        const Items = window.AveloraItems;
        const out = new Array(Items.INVENTORY_SIZE).fill(null);
        if (!Array.isArray(raw)) return out;
        for (let i = 0; i < out.length && i < raw.length; i++) {
            const c = raw[i];
            if (!c || typeof c !== 'object' || !Items.get(c.item)) continue;
            const n = Math.floor(Number(c.count));
            if (!(n >= 1)) continue;
            out[i] = { item: c.item, count: Math.min(n, Items.stackMax(c.item)) };
        }
        return out;
    }

    function sanitizeHotbar(raw, characterId) {
        const out = new Array(HOTBAR_SIZE).fill(null);
        if (!Array.isArray(raw)) return out;
        const skills = characterSkills(characterId);
        for (let i = 0; i < HOTBAR_SIZE && i < raw.length; i++) {
            const e = raw[i];
            if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue;
            if (e.type === 'skill' && skills.includes(e.id)) out[i] = { type: 'skill', id: e.id };
            else if (e.type === 'item' && window.AveloraItems.canHotbar(e.id)) out[i] = { type: 'item', id: e.id };
        }
        return out;
    }

    /** ground: {loc: [{uid,item,count,x,z,r}]} — unknown items / bad numbers dropped. */
    function sanitizeGround(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(locId => {
            const list = raw[locId];
            if (!Array.isArray(list)) return;
            const clean = [];
            const seen = new Set();
            list.forEach(g => {
                if (!g || typeof g !== 'object' || !window.AveloraItems.get(g.item)) return;
                const n = Math.floor(Number(g.count));
                const x = Number(g.x), z = Number(g.z), r = Number(g.r);
                if (!(n >= 1) || !Number.isFinite(x) || !Number.isFinite(z)) return;
                let uid = typeof g.uid === 'string' && g.uid ? g.uid : newUid();
                while (seen.has(uid)) uid = newUid();
                seen.add(uid);
                clean.push({ uid, item: g.item, count: Math.min(n, 9999), x, z, r: Number.isFinite(r) ? r : 0 });
            });
            if (clean.length) out[locId] = clean;
        });
        return out;
    }

    /** {loc: {id: number}} with finite, non-negative numbers only (killed / felled). */
    function sanitizeTimeMap(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(locId => {
            const m = raw[locId];
            if (!m || typeof m !== 'object') return;
            const clean = {};
            Object.keys(m).forEach(id => {
                const t = Number(m[id]);
                if (Number.isFinite(t) && t >= 0) clean[id] = t;
            });
            if (Object.keys(clean).length) out[locId] = clean;
        });
        return out;
    }

    let uidCounter = 0;
    /** Ground-drop id: unique enough for one character's save (not gameplay timing). */
    function newUid() {
        uidCounter = (uidCounter + 1) % 1296;
        return 'g' + Date.now().toString(36) + uidCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
    }

    function sanitizeTaken(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(locId => {
            const m = raw[locId];
            if (!m || typeof m !== 'object') return;
            const clean = {};
            Object.keys(m).forEach(pid => {
                const n = Math.floor(Number(m[pid]));
                if (n > 0) clean[pid] = n;
            });
            if (Object.keys(clean).length) out[locId] = clean;
        });
        return out;
    }

    class CharacterState {
        constructor(characterId, data) {
            data = data || {};
            this.characterId = characterId;
            this.inventory = new window.AveloraItems.Inventory(sanitizeInventory(data.inventory), () => this.save());
            this.hotbar = sanitizeHotbar(data.hotbar, characterId);
            this.pickupsTaken = sanitizeTaken(data.pickupsTaken);
            const eq = (data.equipped && typeof data.equipped === 'object') ? data.equipped : {};
            this.equipped = { right: null };
            // Only keep an equipped item the character actually still carries
            if (window.AveloraItems.isEquippable(eq.right) && this.inventory.count(eq.right) > 0) {
                this.equipped.right = eq.right;
            }
            this.ground = sanitizeGround(data.ground);
            this.killed = sanitizeTimeMap(data.killed);
            this.felled = sanitizeTimeMap(data.felled);
            const pt = Number(data.playTime);
            // Accumulated PLAYED seconds (main.js adds the unpaused in-world delta
            // every frame; written with every save). Respawn / regrow timers
            // compare against it, so they only advance while actually playing.
            this.playTime = Number.isFinite(pt) && pt >= 0 ? pt : 0;
            this.discarded = false;
            this.listeners = [];
        }

        /** UI/world subscribe here to redraw after any change. */
        onChange(fn) { this.listeners.push(fn); }

        /** Persist now + notify listeners. Call after every mutation. */
        save() {
            if (this.discarded) return;
            try {
                window.localStorage.setItem(keyFor(this.characterId), JSON.stringify(this.toJSON()));
            } catch (e) {
                console.warn('[Avelora] could not write state for "' + this.characterId + '"', e);
            }
            this.listeners.forEach(fn => { try { fn(this); } catch (err) { console.error(err); } });
        }

        /** "Начать заново" for the character that's currently playing: never write this object again. */
        discard() { this.discarded = true; this.listeners = []; }

        getTaken(locationId, pickupId) {
            const m = this.pickupsTaken[locationId];
            return (m && m[pickupId]) || 0;
        }

        addTaken(locationId, pickupId, n) {
            if (!this.pickupsTaken[locationId]) this.pickupsTaken[locationId] = {};
            this.pickupsTaken[locationId][pickupId] = this.getTaken(locationId, pickupId) + n;
        }

        // -----------------------------------------------------------
        // Ground drops (dynamic piles, world_objects.js)
        // -----------------------------------------------------------
        groundOf(locationId) { return this.ground[locationId] || []; }

        /**
         * Adds a dropped stack at (x, z). A same-item drop within `mergeRadius`
         * is merged into (count added, position kept) to keep the number of
         * piles per location sane. Returns the (new or merged) entry. Saves.
         */
        addGround(locationId, itemId, count, x, z, r, mergeRadius) {
            if (!window.AveloraItems.get(itemId) || !(count > 0)) return null;
            const list = this.ground[locationId] || (this.ground[locationId] = []);
            const mr = mergeRadius === undefined ? 0.8 : mergeRadius;
            let best = null, bestD = mr * mr;
            list.forEach(g => {
                if (g.item !== itemId) return;
                const d = (g.x - x) * (g.x - x) + (g.z - z) * (g.z - z);
                if (d <= bestD) { best = g; bestD = d; }
            });
            if (best) {
                best.count += count;
                this.save();
                return best;
            }
            const entry = { uid: newUid(), item: itemId, count, x, z, r: r || 0 };
            list.push(entry);
            this.save();
            return entry;
        }

        /** Takes up to n from a ground entry; removes it at 0. Does NOT save (caller batches with inventory.add). */
        takeGround(locationId, uid, n) {
            const list = this.ground[locationId];
            if (!list) return 0;
            const i = list.findIndex(g => g.uid === uid);
            if (i < 0) return 0;
            const g = list[i];
            const k = Math.min(n, g.count);
            g.count -= k;
            if (g.count <= 0) list.splice(i, 1);
            if (!list.length) delete this.ground[locationId];
            return k;
        }

        // -----------------------------------------------------------
        // Killed creatures / felled trees (respawn & regrow on playTime)
        // -----------------------------------------------------------
        getKilled(locationId, id) {
            const m = this.killed[locationId];
            return m && Object.prototype.hasOwnProperty.call(m, id) ? m[id] : null;
        }
        setKilled(locationId, id, playTime) {
            if (!this.killed[locationId]) this.killed[locationId] = {};
            this.killed[locationId][id] = playTime;
            this.save();
        }
        clearKilled(locationId, id) {
            const m = this.killed[locationId];
            if (!m || !Object.prototype.hasOwnProperty.call(m, id)) return;
            delete m[id];
            if (!Object.keys(m).length) delete this.killed[locationId];
            this.save();
        }
        getFelled(locationId, id) {
            const m = this.felled[locationId];
            return m && Object.prototype.hasOwnProperty.call(m, id) ? m[id] : null;
        }
        setFelled(locationId, id, playTime) {
            if (!this.felled[locationId]) this.felled[locationId] = {};
            this.felled[locationId][id] = playTime;
            this.save();
        }
        clearFelled(locationId, id) {
            const m = this.felled[locationId];
            if (!m || !Object.prototype.hasOwnProperty.call(m, id)) return;
            delete m[id];
            if (!Object.keys(m).length) delete this.felled[locationId];
            this.save();
        }

        setHotbar(index, entry) {
            if (index < 0 || index >= HOTBAR_SIZE) return;
            this.hotbar[index] = entry ? { type: entry.type, id: entry.id } : null;
            this.save();
        }

        swapHotbar(a, b) {
            if (a === b) return;
            const t = this.hotbar[a];
            this.hotbar[a] = this.hotbar[b];
            this.hotbar[b] = t;
            this.save();
        }

        setEquipped(hand, itemId) {
            this.equipped[hand] = itemId || null;
            this.save();
        }

        toJSON() {
            return {
                version: STATE_VERSION,
                characterId: this.characterId,
                inventory: this.inventory.toJSON(),
                hotbar: this.hotbar.map(e => (e ? { type: e.type, id: e.id } : null)),
                pickupsTaken: this.pickupsTaken,
                equipped: { right: this.equipped.right || null },
                ground: this.ground,
                killed: this.killed,
                felled: this.felled,
                playTime: Math.round(this.playTime * 10) / 10
            };
        }
    }

    function load(characterId) {
        let data = null;
        try {
            const raw = window.localStorage.getItem(keyFor(characterId));
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.version === STATE_VERSION && parsed.characterId === characterId) {
                    data = parsed;
                } else {
                    console.warn('[Avelora] state for "' + characterId + '" has an unknown format, starting empty');
                }
            }
        } catch (e) {
            console.warn('[Avelora] state for "' + characterId + '" is unreadable, starting empty', e);
        }
        try {
            return new CharacterState(characterId, data);
        } catch (e) {
            console.warn('[Avelora] state for "' + characterId + '" failed to sanitize, starting empty', e);
            return new CharacterState(characterId, null);
        }
    }

    function deleteState(characterId) {
        try { window.localStorage.removeItem(keyFor(characterId)); } catch (e) { /* ignore */ }
    }

    window.AveloraState = { STATE_VERSION, HOTBAR_SIZE, load, deleteState, characterSkills, CharacterState };
})();
