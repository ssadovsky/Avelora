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
 *     returnTo: locationId the player teleported home ("Возвращение домой") from, or null
 *     returnPos: { x, z, r } exact spot in that location (or null)
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

    // Skills EVERY character has, regardless of content/characters/<id>/skills.json.
    // They are always appended LAST: combat skills are added to a character's skills.json
    // and therefore always come before these.
    const UNIVERSAL_SKILLS = ['home_recall'];

    // Skills that every save made before skills had to be learned already owns
    const LEGACY_SKILLS = ['spark'];

    /** Every skill this character CAN learn (content/characters/<id>/skills.json, without the universal ones). */
    function skillCatalog(characterId) {
        const chars = (window.GAME_CONTENT && window.GAME_CONTENT.characters) || {};
        const skills = (window.GAME_CONTENT && window.GAME_CONTENT.skills) || {};
        const cfg = chars[characterId];
        return (cfg && Array.isArray(cfg.skills)) ? cfg.skills.filter(id => Object.prototype.hasOwnProperty.call(skills, id) && !UNIVERSAL_SKILLS.includes(id)) : [];
    }

    /**
     * Skill ids this character may use now: the catalog skills it has LEARNED (all of them when `learned`
     * is omitted) + UNIVERSAL_SKILLS last.
     */
    function characterSkills(characterId, learned) {
        const chars = (window.GAME_CONTENT && window.GAME_CONTENT.characters) || {};
        const skills = (window.GAME_CONTENT && window.GAME_CONTENT.skills) || {};
        const has = id => Object.prototype.hasOwnProperty.call(skills, id);
        const cfg = chars[characterId];
        let own = (cfg && Array.isArray(cfg.skills)) ? cfg.skills.filter(id => has(id) && !UNIVERSAL_SKILLS.includes(id)) : [];
        if (Array.isArray(learned)) own = own.filter(id => learned.includes(id));
        return own.concat(UNIVERSAL_SKILLS.filter(has));
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

    /** Chest contents: { "<locationId>/<propId>": [ {item,count} | null, ... ] } (length = the chest's slots). */
    function sanitizeChests(raw) {
        const Items = window.AveloraItems;
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(key => {
            const arr = raw[key];
            if (!Array.isArray(arr)) return;
            const cells = new Array(Math.min(arr.length, 96)).fill(null);
            for (let i = 0; i < cells.length; i++) {
                const c = arr[i];
                if (!c || typeof c !== 'object' || !Items.get(c.item)) continue;
                const n = Math.floor(Number(c.count));
                if (n >= 1) cells[i] = { item: c.item, count: Math.min(n, Items.stackMax(c.item)) };
            }
            out[key] = cells;
        });
        return out;
    }

    function sanitizeHotbar(raw, characterId, learned) {
        const out = new Array(HOTBAR_SIZE).fill(null);
        if (!Array.isArray(raw)) return out;
        const skills = characterSkills(characterId, learned);
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
                const born = Number(g.born);
                clean.push({ uid, item: g.item, count: Math.min(n, 9999), x, z, r: Number.isFinite(r) ? r : 0, born: Number.isFinite(born) ? born : null });
            });
            if (clean.length) out[locId] = clean;
        });
        return out;
    }

    /** {loc: {id: number}} with finite, non-negative numbers only (killed / felled). */
    function sanitizeCounts(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(id => { const n = Math.floor(Number(raw[id])); if (n > 0) out[id] = Math.min(n, 9999); });
        return out;
    }

    function sanitizeSlain(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(loc => {
            if (!raw[loc] || typeof raw[loc] !== 'object') return;
            const ids = Object.keys(raw[loc]).filter(id => raw[loc][id] === true);
            if (ids.length) { out[loc] = {}; ids.forEach(id => { out[loc][id] = true; }); }
        });
        return out;
    }

    function sanitizeQuests(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(id => { if (raw[id] === 'active' || raw[id] === 'done') out[id] = raw[id]; });
        return out;
    }

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
            // Learned skills (bought from NPCs, dialog.js). A new character knows none; an older save keeps what it had.
            const cat = skillCatalog(characterId);
            if (Array.isArray(data.learnedSkills)) this.learnedSkills = data.learnedSkills.filter(id => cat.includes(id));
            else this.learnedSkills = data.version ? LEGACY_SKILLS.filter(id => cat.includes(id)) : [];
            this.hotbar = sanitizeHotbar(data.hotbar, characterId, this.learnedSkills);
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
            // Location the player teleported home FROM (skills.js home_recall uses it to go back)
            this.returnTo = (typeof data.returnTo === 'string' && window.LOCATIONS && window.LOCATIONS[data.returnTo]) ? data.returnTo : null;
            const rp = data.returnPos;
            this.returnPos = (this.returnTo && rp && Number.isFinite(rp.x) && Number.isFinite(rp.z)) ? { x: rp.x, z: rp.z, r: Number.isFinite(rp.r) ? rp.r : 0 } : null;
            // Gold coins (a counter, not a bag item): dropped by creatures, spent at NPC shops (dialog.js)
            const gd = Math.floor(Number(data.gold));
            this.gold = Number.isFinite(gd) && gd > 0 ? Math.min(gd, 999999999) : 0;
            // Storage chests (world_objects.js props with a `container` block), saved per chest
            this.chestData = sanitizeChests(data.chests);
            // Quests: { questId: 'active' | 'done' } (content/quests, taken from NPCs in dialog.js)
            this.quests = sanitizeQuests(data.quests);
            this.questKills = sanitizeCounts(data.questKills);   // kills counted while a kill quest is active
            this.slain = sanitizeSlain(data.slain);               // creatures killed for good by a quest (never respawn)
            this.chestInvs = {};
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
                best.born = this.playTime;
                this.save();
                return best;
            }
            const entry = { uid: newUid(), item: itemId, count, x, z, r: r || 0, born: this.playTime };
            list.push(entry);
            this.save();
            return entry;
        }

        /**
         * Removes ground piles of items with `despawnMinutes` (monster loot) that lay longer than that
         * (PLAYED time). Returns the removed uids so world_objects can drop their meshes.
         */
        expireGround(locationId) {
            const list = this.ground[locationId];
            if (!list || !list.length) return [];
            const gone = [];
            for (let i = list.length - 1; i >= 0; i--) {
                const g = list[i];
                const def = window.AveloraItems.get(g.item);
                const m = def && Number(def.despawnMinutes);
                if (!(m > 0)) continue;
                if (g.born === null || g.born === undefined) { g.born = this.playTime; continue; }
                if (this.playTime - g.born >= m * 60) { gone.push(g.uid); list.splice(i, 1); }
            }
            if (gone.length) { if (!list.length) delete this.ground[locationId]; this.save(); }
            return gone;
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

        /**
         * Inventory of one chest (same API as the bag: add/remove/move/...), created on first use.
         * key = "<locationId>/<propId>". Changes save the whole character state.
         */
        chestInventory(key, slots) {
            let inv = this.chestInvs[key];
            if (inv && inv.cells.length >= slots) return inv;
            const stored = inv ? inv.toJSON() : (this.chestData[key] || []);
            const n = Math.max(slots, stored.length);
            const cells = new Array(n).fill(null);
            for (let i = 0; i < stored.length; i++) cells[i] = stored[i] || null;
            inv = new window.AveloraItems.Inventory(null, () => this.save());
            inv.cells = cells;
            this.chestInvs[key] = inv;
            return inv;
        }

        addQuestKill(id) { this.questKills[id] = (this.questKills[id] || 0) + 1; this.save(); }
        isSlain(locationId, id) { return !!(this.slain[locationId] && this.slain[locationId][id]); }
        slay(locationId, id) { (this.slain[locationId] || (this.slain[locationId] = {}))[id] = true; this.save(); }

        questStatus(id) { return this.quests[id] || null; }
        startQuest(id) { if (this.quests[id]) return false; this.quests[id] = 'active'; this.save(); return true; }
        completeQuest(id) { if (this.quests[id] !== 'active') return false; this.quests[id] = 'done'; this.save(); return true; }

        knowsSkill(id) { return this.learnedSkills.includes(id); }

        learnSkill(id) {
            if (!skillCatalog(this.characterId).includes(id) || this.knowsSkill(id)) return false;
            this.learnedSkills.push(id);
            this.save();
            return true;
        }

        addGold(n) {
            n = Math.floor(n);
            if (!(n > 0)) return;
            this.gold = Math.min(this.gold + n, 999999999);
            this.save();
        }

        /** Takes `n` gold if the character has it. Returns true on success. */
        spendGold(n) {
            n = Math.floor(n);
            if (!(n >= 0) || this.gold < n) return false;
            this.gold -= n;
            this.save();
            return true;
        }

        /** Remember where "Возвращение домой" should bring the player back to (null = forget). */
        setReturnTo(locationId, pos) {
            this.returnTo = locationId || null;
            this.returnPos = (locationId && pos) ? { x: pos.x, z: pos.z, r: pos.r || 0 } : null;
            this.save();
        }

        chestsJSON() {
            const out = {};
            Object.keys(this.chestData).forEach(k => { out[k] = this.chestData[k]; });
            Object.keys(this.chestInvs).forEach(k => { out[k] = this.chestInvs[k].toJSON(); });
            Object.keys(out).forEach(k => { if (!out[k].some(c => c)) delete out[k]; });
            return out;
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
                returnTo: this.returnTo || null,
                returnPos: this.returnPos || null,
                chests: this.chestsJSON(),
                gold: this.gold,
                learnedSkills: this.learnedSkills.slice(),
                quests: Object.assign({}, this.quests),
                questKills: Object.assign({}, this.questKills),
                slain: JSON.parse(JSON.stringify(this.slain)),
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

    window.AveloraState = { STATE_VERSION, HOTBAR_SIZE, load, deleteState, characterSkills, skillCatalog, CharacterState };
})();
