/**
 * Avelora — Item registry & Inventory model
 *
 * Item definitions come from `window.GAME_CONTENT.items` (content_data.js, built
 * by temp_work/build_assets.py from content/items/<id>/item.json). Nothing here
 * touches the DOM or the scene graph except createModelScene()/createVariants(),
 * which turn an item's (optional) model.glb into THREE objects — with a small
 * neutral fallback mesh when the model hasn't been made yet, so a missing asset
 * never breaks the game.
 *
 * Inventory is a plain fixed-size array of cells: `{ item: id, count } | null`.
 * Stacking follows each def's `stackMax`. Every mutating method returns what it
 * actually did and calls `onChange()` so the owner (game_state.js) can persist
 * immediately and the UI can redraw.
 */
(function () {
    'use strict';

    const INVENTORY_SIZE = 32;

    // Fists: what everyone fights with when the right hand holds no weapon.
    const BARE_HANDS = Object.freeze({ id: null, name: 'Кулаки', damage: [1, 3], range: 1.2, cooldown: 0.9, chop: 0 });

    function content() {
        return (window.GAME_CONTENT && window.GAME_CONTENT.items) || {};
    }

    const AveloraItems = {
        INVENTORY_SIZE,
        BARE_HANDS,

        get(id) {
            const defs = content();
            return (id && Object.prototype.hasOwnProperty.call(defs, id)) ? defs[id] : null;
        },

        all() {
            return Object.values(content());
        },

        stackMax(id) {
            const def = this.get(id);
            return def ? Math.max(1, def.stackMax | 0 || 1) : 1;
        },

        /**
         * Hotbar rule: the bar is for ACTIONS. An item may be bound only if its
         * def has a non-null `use` (tools you equip, future consumables).
         * Materials (stone, log) have `use: null` and are rejected.
         */
        canHotbar(id) {
            const def = this.get(id);
            return !!(def && def.use && def.use.type);
        },

        isEquippable(id) {
            const def = this.get(id);
            return !!(def && def.use && def.use.type === 'equip');
        },

        /**
         * Melee stats of an item (item.json `weapon`: {damage:[min,max], range (m),
         * cooldown (s), chop?}) or BARE_HANDS when the item has none / no item.
         * Always returns a complete, sane object.
         */
        weaponOf(id) {
            const def = this.get(id);
            const w = def && def.weapon;
            if (!w) return BARE_HANDS;
            const dmg = Array.isArray(w.damage) ? w.damage : [BARE_HANDS.damage[0], BARE_HANDS.damage[1]];
            const lo = Math.max(0, Number(dmg[0]) || 0), hi = Math.max(lo, Number(dmg[1]) || lo);
            return {
                id: def.id, name: def.name,
                damage: [lo, hi],
                range: Math.max(0.6, Number(w.range) || BARE_HANDS.range),
                cooldown: Math.max(0.3, Number(w.cooldown) || BARE_HANDS.cooldown),
                chop: Number(w.chop) || 0
            };
        },

        // -----------------------------------------------------------
        // 3D models (shared by world piles and hand-held equipment)
        // -----------------------------------------------------------
        /**
         * Parses the item's/prop's model.glb (by `modelKey` into GAME_ASSETS.models).
         * Calls back with `gltf.scene` or `null` (missing/broken model). The caller
         * owns the returned scene (and its geometries/materials).
         */
        parseModel(modelKey, callback) {
            const buffer = (modelKey && window.LakesideEnvironment)
                ? window.LakesideEnvironment.getModelBuffer(modelKey) // decoded-buffer cache shared with environment.js
                : null;
            if (!buffer) { callback(null); return; }
            try {
                new THREE.GLTFLoader().parse(buffer, '', (gltf) => callback(gltf.scene), (err) => {
                    console.warn(`[Avelora] model "${modelKey}" failed to parse — using fallback`, err);
                    callback(null);
                });
            } catch (err) {
                console.warn(`[Avelora] model "${modelKey}" failed to parse — using fallback`, err);
                callback(null);
            }
        },

        /**
         * Splits a parsed model into its variants: top-level children named
         * `variant_0..N` (asset convention), sorted by index. A model without
         * that naming is treated as a single variant (the whole scene).
         */
        splitVariants(scene) {
            if (!scene) return [];
            const named = scene.children.filter(c => /^variant_\d+$/.test(c.name));
            if (!named.length) return [scene];
            named.sort((a, b) => parseInt(a.name.slice(8), 10) - parseInt(b.name.slice(8), 10));
            // Detach from the gltf root: each variant becomes an independent template
            named.forEach(v => { scene.remove(v); v.position.set(0, 0, 0); });
            return named;
        },

        /**
         * Fallback mesh used while a model does not exist yet: a small neutral
         * block (ground items), a short cylinder (stump-like props) or a thin
         * shaft along +Y (hand-held). Origin follows the same conventions as
         * real models: bottom-center for ground objects, grip point for held ones.
         */
        makeFallback(kind, id) {
            const mat = new THREE.MeshStandardMaterial({ color: 0x8a7f70, roughness: 0.9, metalness: 0.0 });
            let geo;
            if (kind === 'held') {
                geo = new THREE.CylinderGeometry(0.02, 0.025, 0.8, 8);
                geo.translate(0, 0.3, 0);
            } else if (kind === 'prop' && String(id).indexOf('npc_') === 0) {
                // NPC without a model yet: a carved stone pillar (0.5 x 1.9 x 0.5 m, origin at the bottom centre)
                geo = new THREE.BoxGeometry(0.5, 1.9, 0.5);
                geo.translate(0, 0.95, 0);
                mat.color.setHex(0x6f6c63);
            } else if (kind === 'prop' && id === 'chest') {
                // Chest without a model yet: a wooden box (0.9 x 0.6 x 0.6 m, origin at the bottom centre)
                geo = new THREE.BoxGeometry(0.9, 0.6, 0.6);
                geo.translate(0, 0.3, 0);
                mat.color.setHex(0x7a5230);
            } else if (kind === 'prop') {
                geo = new THREE.CylinderGeometry(0.34, 0.4, 0.45, 12);
                geo.translate(0, 0.225, 0);
            } else if (kind === 'foliage') {
                // Foliage prop (bush) without a model yet: a squat dark-green mound
                geo = new THREE.IcosahedronGeometry(0.6, 1);
                geo.scale(1.1, 0.75, 1.1);
                geo.translate(0, 0.42, 0);
                mat.color.setHex(0x3f5a2c);
            } else if (id === 'branch') {
                geo = new THREE.CylinderGeometry(0.018, 0.03, 0.9, 6);
                geo.rotateZ(Math.PI / 2); // lies along X like logs
                geo.translate(0, 0.03, 0);
                mat.color.setHex(0x6b5238);
            } else if (id === 'log') {
                geo = new THREE.CylinderGeometry(0.1, 0.1, 1.2, 10);
                geo.rotateZ(Math.PI / 2); // logs lie along X
                geo.translate(0, 0.1, 0);
            } else if (id === 'fern') {
                geo = new THREE.IcosahedronGeometry(0.18, 1);
                geo.scale(1.2, 0.45, 1.2);
                geo.translate(0, 0.08, 0);
                mat.color.setHex(0x2e7d32);
            } else if (id === 'potion_health_small') {
                geo = new THREE.CylinderGeometry(0.04, 0.045, 0.22, 8);
                geo.translate(0, 0.11, 0);
                mat.color.setHex(0xc62828);
                mat.roughness = 0.2;
                mat.metalness = 0.1;
            } else if (id === 'potion_health_large') {
                geo = new THREE.CylinderGeometry(0.06, 0.11, 0.26, 8);
                geo.translate(0, 0.13, 0);
                mat.color.setHex(0xb71c1c);
                mat.roughness = 0.2;
                mat.metalness = 0.1;
            } else {
                geo = new THREE.BoxGeometry(0.22, 0.16, 0.2);
                geo.translate(0, 0.08, 0);
            }
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = 'fallback';
            return mesh;
        },

        /** Enables shadows on every mesh of an object tree. */
        setShadows(obj, cast, receive) {
            obj.traverse(o => {
                if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; }
            });
        }
    };

    // ---------------------------------------------------------------
    // Inventory
    // ---------------------------------------------------------------
    class Inventory {
        constructor(cells, onChange) {
            this.cells = new Array(INVENTORY_SIZE).fill(null);
            if (Array.isArray(cells)) {
                for (let i = 0; i < INVENTORY_SIZE && i < cells.length; i++) this.cells[i] = cells[i] || null;
            }
            this.onChange = onChange || null;
        }

        changed() { if (this.onChange) this.onChange(); }

        isEmpty() { return this.cells.every(c => !c); }

        /** Total count of an item across all stacks. */
        count(itemId) {
            let n = 0;
            for (const c of this.cells) if (c && c.item === itemId) n += c.count;
            return n;
        }

        /** How many of this item still fit (existing stacks + empty cells). */
        spaceFor(itemId) {
            const max = AveloraItems.stackMax(itemId);
            let n = 0;
            for (const c of this.cells) {
                if (!c) n += max;
                else if (c.item === itemId) n += Math.max(0, max - c.count);
            }
            return n;
        }

        /** Adds up to `count`; tops up existing stacks first, then empty cells. Returns the amount added. */
        add(itemId, count) {
            if (!AveloraItems.get(itemId) || !(count > 0)) return 0;
            const max = AveloraItems.stackMax(itemId);
            let left = count;
            for (const c of this.cells) {
                if (left <= 0) break;
                if (c && c.item === itemId && c.count < max) {
                    const k = Math.min(left, max - c.count);
                    c.count += k; left -= k;
                }
            }
            for (let i = 0; i < this.cells.length && left > 0; i++) {
                if (!this.cells[i]) {
                    const k = Math.min(left, max);
                    this.cells[i] = { item: itemId, count: k };
                    left -= k;
                }
            }
            const added = count - left;
            if (added > 0) this.changed();
            return added;
        }

        /** Removes up to `count` (from the last stacks first). Returns the amount removed. */
        remove(itemId, count) {
            let left = count;
            for (let i = this.cells.length - 1; i >= 0 && left > 0; i--) {
                const c = this.cells[i];
                if (c && c.item === itemId) {
                    const k = Math.min(left, c.count);
                    c.count -= k; left -= k;
                    if (c.count <= 0) this.cells[i] = null;
                }
            }
            const removed = count - left;
            if (removed > 0) this.changed();
            return removed;
        }

        /**
         * Drag-rearrange inside the bag: same item -> merge into the target
         * stack (up to stackMax, the rest stays in the source), otherwise swap.
         */
        move(from, to) {
            if (from === to || from < 0 || to < 0 || from >= this.cells.length || to >= this.cells.length) return false;
            const a = this.cells[from], b = this.cells[to];
            if (!a) return false;
            if (b && b.item === a.item) {
                const max = AveloraItems.stackMax(a.item);
                const k = Math.min(a.count, max - b.count);
                if (k <= 0) { // target full: plain swap keeps behaviour predictable
                    this.cells[from] = b; this.cells[to] = a;
                } else {
                    b.count += k; a.count -= k;
                    if (a.count <= 0) this.cells[from] = null;
                }
            } else {
                this.cells[from] = b; this.cells[to] = a;
            }
            this.changed();
            return true;
        }

        /** Empties one cell and returns what was in it ({item, count} | null). */
        removeAt(index) {
            const c = this.cells[index];
            if (!c) return null;
            this.cells[index] = null;
            this.changed();
            return { item: c.item, count: c.count };
        }

        /**
         * Removes up to `count` items from a specific cell.
         * Returns { item, count } or null if empty/invalid.
         */
        removeCountAt(index, count) {
            const c = this.cells[index];
            if (!c || count <= 0) return null;
            const take = Math.min(c.count, count);
            c.count -= take;
            const item = c.item;
            if (c.count <= 0) this.cells[index] = null;
            this.changed();
            return { item, count: take };
        }

        /**
         * Splits a stack: moves `count` items from cell `from` into cell `to`.
         * If `to` is omitted or < 0, finds the first empty cell in the bag.
         */
        split(from, to, count) {
            if (from === to || from < 0 || from >= this.cells.length) return false;
            const a = this.cells[from];
            if (!a || count <= 0 || a.count <= count) return false;
            if (to === undefined || to === null || to < 0 || to >= this.cells.length) {
                to = this.firstEmpty();
                if (to < 0) return false; // Bag full
            }
            const b = this.cells[to];
            if (b) {
                if (b.item !== a.item) return false;
                const max = AveloraItems.stackMax(a.item);
                const canAdd = max - b.count;
                if (canAdd <= 0) return false;
                const actual = Math.min(count, canAdd, a.count - 1);
                if (actual <= 0) return false;
                b.count += actual;
                a.count -= actual;
            } else {
                const actual = Math.min(count, a.count - 1);
                if (actual <= 0) return false;
                this.cells[to] = { item: a.item, count: actual };
                a.count -= actual;
            }
            this.changed();
            return true;
        }

        firstEmpty() {
            return this.cells.findIndex(c => !c);
        }

        toJSON() {
            return this.cells.map(c => (c ? { item: c.item, count: c.count } : null));
        }
    }

    AveloraItems.Inventory = Inventory;
    window.AveloraItems = AveloraItems;
})();
