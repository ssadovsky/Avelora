/**
 * Avelora — World objects: item pickups (piles) and static props
 *
 * Reads two optional arrays of a location (world_data.js, see world_data_help.txt):
 *
 *   pickups: [{ id, item, count, x, z, y?, r?, rotation? }]
 *     A pile of `count` items lying on the ground. Displayed amount is
 *     count − (already taken by THIS character, game_state.js pickupsTaken);
 *     at 0 nothing is built. Clicking a pile walks the character there
 *     (existing pathfinder) and picks it up automatically within PICKUP_RANGE.
 *   props:   [{ id, prop, x, z, r?, s?, variant? }]
 *     Static decoration from content/props/<prop>/ (model + `obstacle` radius,
 *     registered in the nav grid and as a projectile blocker). prop.json
 *     `foliage: true` = alpha-cutout plant (bush): double-sided, alpha-tested,
 *     casts no shadow (same reasoning as instanced foliage, CLAUDE.md §7).
 *
 * DYNAMIC piles (ground drops) — same visuals/interaction as `pickups`, but
 * they live in the character's state (game_state.js `ground[locationId]`),
 * not in world_data.js: stacks dropped from the bag (ui_hotbar.js drag out of
 * the panels) and resources from felled trees (harvest.js). Their pile id is
 * `ground:<uid>`; a drop of the same item within DROP_MERGE_RADIUS merges
 * into the existing pile (wider when a location already has many piles).
 * Dynamic props (stumps of felled trees) come via addProp()/removeProp().
 *
 * Visuals: every pile shows up to MAX_PILE_VISUAL of the item's model variants
 * arranged by `ground.pile` from item.json — 'heap' (stones: clustered, some
 * resting on others), 'stack' (logs: parallel rows, like a small woodpile) or
 * 'single'. Arrangements are seeded by the pickup id (same heap every load).
 * Missing model.glb -> a small neutral fallback mesh (AveloraItems.makeFallback).
 *
 * Everything lives under game.locationRoot and is disposed by teardownLocation()
 * with the rest of the location (this class only drops its references).
 */
(function () {
    'use strict';

    const CONTAINER_REACH = 1.7;  // meters from the chest's edge at which it can be opened
    const PICKUP_RANGE = 1.6;     // meters (2D) — auto pickup distance
    const MAX_PILE_VISUAL = 8;    // never draw more than this many models per pile
    const MIN_NAV_OBSTACLE = 0.55; // nav cells are 0.75 m — smaller radii might block no cell at all
    const DROP_MERGE_RADIUS = 0.8;   // same-item drops closer than this merge into one pile
    const CROWDED_PILES = 40;        // beyond this many dynamic piles in a location, merge within...
    const CROWDED_MERGE_RADIUS = 3.0; // ...this radius instead

    function hashString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function rngFor(id) {
        return window.aveloraSeededRandom ? window.aveloraSeededRandom(hashString(String(id))) : Math.random;
    }

    const NPC_TMP_Q = new THREE.Quaternion();
    const NPC_TMP_E = new THREE.Euler();

    class AveloraWorldObjects {
        constructor(game, location) {
            this.game = game;
            this.root = game.locationRoot;
            this.terrain = game.terrain;
            this.pathfinder = game.pathfinder;
            this.location = location;

            this.piles = new Map();   // pickupId -> pile record
            this.props = [];          // { id, x, z, r, h, group }
            this.fires = [];          // AveloraFire instances (props with a `fire` block in prop.json)
            this.proxies = [];        // invisible hit-cylinders for hover/click (one per visible pile)
            this.templates = {};      // 'items/<id>' | 'props/<id>' -> Promise<[variant Object3D]> (templates are never added to the scene)
            this.allTemplates = [];   // resolved templates, for disposal (a fully collected pile's GPU buffers are no longer under locationRoot)
            this.pendingPileId = null;
            this.containerProxies = []; // invisible hit-boxes of props with a `container` block (chests)
            this.pendingContainerId = null;
            this.openContainer = null;  // record of the chest whose panel is open
            this.disposed = false;
            this.npcMixers = [];
            this.version = 0;         // bumped whenever props change (skills.js blocker cache)

            const jobs = [];
            this.buildBridges();
            (location.props || []).forEach(p => jobs.push(this.buildProp(p)));
            // `only: '<characterId>'` pickups exist for that character alone (the mage's staff)
            const who = this.state && this.state.characterId;
            (location.pickups || []).filter(p => !p.only || p.only === who).forEach(p => jobs.push(this.addPickup(p)));
            // Dynamic piles persisted for this character (dropped items, tree drops)
            if (this.state) this.state.expireGround(location.id);
            if (this.state) this.state.groundOf(location.id).forEach(g => jobs.push(this.addGroundPile(g)));
            this.ready = Promise.all(jobs).then(() => undefined);
        }

        get state() { return this.game.gameState; }

        // -----------------------------------------------------------
        // Model templates
        // -----------------------------------------------------------
        /** Resolves to an array of variant templates (real model or fallback). Parsed once per location. */
        loadTemplates(category, id, def) {
            const key = `${category}/${id}`;
            if (!this.templates[key]) {
                this.templates[key] = new Promise(resolve => {
                    window.AveloraItems.parseModel(def && def.modelKey, (scene) => {
                        let variants = window.AveloraItems.splitVariants(scene);
                        const foliage = !!(def && def.foliage);
                        if (!variants.length) {
                            variants = [window.AveloraItems.makeFallback(category === 'props' ? (foliage ? 'foliage' : 'prop') : 'ground', id)];
                        }
                        const box = new THREE.Box3();
                        variants.forEach(v => {
                            v.updateMatrixWorld(true);
                            box.setFromObject(v);
                            v.userData.size = box.getSize(new THREE.Vector3());
                            v.userData.minY = box.min.y;
                            window.AveloraItems.setShadows(v, !foliage, true);
                            if (foliage) AveloraWorldObjects.prepareFoliage(v);
                            this.allTemplates.push(v);
                        });
                        resolve(variants);
                    });
                });
            }
            return this.templates[key];
        }

        // -----------------------------------------------------------
        // Bridges (location.terrain.bridges): walkable deck height comes from terrain.getHeightAt,
        // this only draws the planks, beams and rails as ONE merged mesh (no assets needed).
        // -----------------------------------------------------------
        buildBridges() {
            const list = (this.location.terrain && this.location.terrain.bridges) || [];
            list.forEach((b, bi) => {
                const boxes = [];
                const W = b.width, L = b.length, Y = b.deckY;
                const add = (cx, cy, cz, sx, sy, sz, col) => boxes.push({ cx, cy, cz, sx, sy, sz, col });
                const rnd = rngFor(`bridge${bi}`);
                // planks
                const step = 0.31;
                const n = Math.floor(L / step);
                for (let i = 0; i < n; i++) {
                    const z = -L / 2 + step * (i + 0.5);
                    const k = 0.86 + rnd() * 0.22;
                    add(0, Y - 0.06, z, W, 0.12, step - 0.035, [0.52 * k, 0.37 * k, 0.22 * k]);
                }
                // stringers under the deck and end piers into the river bed
                const sx = W / 2 - 0.22;
                [-1, 1].forEach(side => {
                    add(side * sx, Y - 0.27, 0, 0.2, 0.22, L, [0.36, 0.25, 0.15]);
                    for (let j = 0; j <= 4; j++) {
                        const z = -L / 2 + 1.0 + (L - 2.0) * j / 4;
                        add(side * sx, (Y - 0.3 - 1.4) / 2 - 0.0, z, 0.22, Y + 1.1, 0.22, [0.3, 0.21, 0.12]);
                    }
                    // rails: posts every ~1.6 m, two horizontal rails
                    const posts = Math.max(2, Math.round(L / 1.6));
                    for (let j = 0; j <= posts; j++) {
                        const z = -L / 2 + 0.15 + (L - 0.3) * j / posts;
                        add(side * (W / 2 - 0.08), Y + 0.5, z, 0.14, 1.0, 0.14, [0.34, 0.24, 0.14]);
                    }
                    add(side * (W / 2 - 0.08), Y + 0.95, 0, 0.11, 0.11, L, [0.45, 0.32, 0.19]);
                    add(side * (W / 2 - 0.08), Y + 0.5, 0, 0.09, 0.09, L, [0.4, 0.28, 0.17]);
                });
                const pos = [], nor = [], col = [];
                boxes.forEach(bx => {
                    const g = new THREE.BoxGeometry(bx.sx, bx.sy, bx.sz).toNonIndexed();
                    const pa = g.attributes.position, na = g.attributes.normal;
                    for (let i = 0; i < pa.count; i++) {
                        pos.push(pa.getX(i) + bx.cx, pa.getY(i) + bx.cy, pa.getZ(i) + bx.cz);
                        nor.push(na.getX(i), na.getY(i), na.getZ(i));
                        col.push(bx.col[0], bx.col[1], bx.col[2]);
                    }
                    g.dispose();
                });
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
                geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
                geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
                const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(b.x, 0, b.z);
                mesh.castShadow = true; mesh.receiveShadow = true;
                mesh.name = `bridge${bi}`;
                this.root.add(mesh);
            });
        }

        // -----------------------------------------------------------
        // Props
        // -----------------------------------------------------------
        buildProp(p) {
            const defs = (window.GAME_CONTENT && window.GAME_CONTENT.props) || {};
            const def = defs[p.prop];
            if (!def) {
                console.warn(`[Avelora] location "${this.location.id}": unknown prop "${p.prop}"`);
                return Promise.resolve();
            }
            const s = p.s || 1.0;
            const obstacle = (def.obstacle || 0) * s;
            if (obstacle > 0 && this.pathfinder && !p.noObstacle) {
                this.pathfinder.addObstacle(p.x, p.z, Math.max(obstacle, MIN_NAV_OBSTACLE));
            }
            return this.loadTemplates('props', p.prop, def).then(variants => {
                if (this.disposed) return null;
                const v = variants[(p.variant || 0) % variants.length];
                const obj = v.clone();
                obj.position.set(p.x, this.terrain.getHeightAt(p.x, p.z) - 0.02, p.z);
                obj.rotation.y = p.r || 0;
                obj.scale.setScalar(s);
                obj.name = `prop:${p.id || p.prop}`;
                this.root.add(obj);
                const size = v.userData.size;
                const rec = {
                    id: p.id || p.prop, x: p.x, z: p.z,
                    r: obstacle || Math.max(size.x, size.z) * 0.5 * s,
                    h: size.y * s, object: obj,
                    // foliage (bush) never stops a projectile — it would read as a bug
                    blocks: !def.foliage
                };
                this.props.push(rec);
                this.version++;
                if (def.container || def.npc) {
                    if (def.container) rec.container = { slots: Math.max(1, Math.min(64, def.container.slots || 12)), title: def.container.title || def.name };
                    if (def.npc) rec.npc = window.GAME_CONTENT && window.GAME_CONTENT.npcs ? window.GAME_CONTENT.npcs[def.npc] || null : null;
                    rec.def = def;
                    const rr = Math.max(0.6, rec.r);
                    const pg = new THREE.CylinderGeometry(rr, rr, Math.max(0.9, rec.h), 10, 1);
                    pg.translate(0, Math.max(0.9, rec.h) / 2, 0);
                    const proxy = new THREE.Mesh(pg, AveloraWorldObjects.proxyMaterial());
                    proxy.position.set(p.x, obj.position.y, p.z);
                    proxy.userData.containerId = rec.id;
                    this.root.add(proxy);
                    this.containerProxies.push(proxy);
                    rec.proxy = proxy;
                    if (rec.npc && rec.npc.modelKey) this.attachNpcModel(rec, p);
                }
                if (def.fire && window.AveloraFire) {
                    let seed = 7;
                    for (let i = 0; i < rec.id.length; i++) seed = (seed * 31 + rec.id.charCodeAt(i)) >>> 0;
                    this.fires.push(new window.AveloraFire(this.root, {
                        x: p.x, z: p.z, y: obj.position.y + 0.02 + (def.fire.y || 0) * s,
                        size: (def.fire.size || 1) * s, seed
                    }));
                }
                return rec;
            });
        }

        /**
         * Replaces the placeholder prop of an NPC with its rigged model
         * (content/npcs/<id>/model.glb, animations 'Idle' and 'Talk').
         */
        attachNpcModel(rec, p) {
            const buffer = window.LakesideEnvironment && window.LakesideEnvironment.getModelBuffer(rec.npc.modelKey);
            if (!buffer) return;
            const done = new Promise(resolve => {
                new THREE.GLTFLoader().parse(buffer, '', gltf => {
                    if (this.disposed) { resolve(); return; }
                    const model = gltf.scene;
                    const box = new THREE.Box3().setFromObject(model);
                    const height = Math.max(0.01, box.max.y - box.min.y);
                    const target = rec.npc.height || 1.75;
                    const k = target / height;
                    const holder = new THREE.Group();
                    model.scale.setScalar(k);
                    model.position.y = -box.min.y * k;
                    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
                    holder.add(model);
                    holder.position.set(p.x, this.terrain.getHeightAt(p.x, p.z), p.z);
                    holder.rotation.y = p.r || 0;
                    holder.name = `npc:${rec.id}`;
                    this.root.add(holder);
                    if (rec.object) rec.object.visible = false;
                    rec.model = holder;
                    rec.h = target;
                    const mixer = new THREE.AnimationMixer(model);
                    const actions = {};
                    (gltf.animations || []).forEach(c => { actions[c.name] = mixer.clipAction(c); });
                    // Idle = the relaxed first pose of 'Talk' (the stock Idle clip is a stiff A-pose),
                    // brought to life with a breathing sway in updateNpcs().
                    rec.bones = {};
                    model.traverse(o => { if (o.isBone) rec.bones[o.name] = o; });
                    rec.mixer = mixer; rec.actions = actions; rec.baseYaw = p.r || 0;
                    this.npcMixers.push(rec);
                    this.setNpcAnim(rec, 'Idle');
                    resolve();
                }, err => { console.warn('[Avelora] npc model failed', err); resolve(); });
            });
            this.pending && this.pending.push && this.pending.push(done);
        }

        setNpcAnim(rec, name) {
            // One looping clip ('Talk'): Idle = frozen on its relaxed first pose,
            // Talk = playing; when the talk ends it plays on (faster) to the loop
            // point first, so the arms never snap. No cross-fades (they twisted the rig).
            const act = rec.actions && rec.actions.Talk;
            if (!act) return;
            if (!rec.playing) { act.reset().play(); act.time = 0; act.timeScale = 0; rec.playing = true; }
            name = 'Idle'; // the talk gesture clip bends the rig badly in-game: she just stands (breathing sway only)
            rec.want = name;
            if (name === 'Talk' && rec.phase !== 'talk') { act.timeScale = 1; rec.phase = 'talk'; }
            rec.anim = name === 'Talk' ? 'Talk' : (rec.phase === 'talk' ? 'Talk' : 'Idle');
        }

        updateNpcs(delta) {
            const c = this.game.character;
            const talking = this.game.ui && this.game.ui.isDialogOpen && this.game.ui.isDialogOpen();
            for (const rec of this.npcMixers) {
                const act = rec.actions && rec.actions.Talk;
                if (act && rec.phase === 'talk' && rec.want === 'Idle') {
                    act.timeScale = 2.5;
                    const dur = act.getClip().duration;
                    if (act.time >= dur - 0.25 || act.time < 0.05) { act.time = 0; act.timeScale = 0; rec.phase = 'idle'; rec.anim = 'Idle'; }
                }
                rec.mixer.update(delta || 0);
                rec.t = (rec.t || 0) + (delta || 0);
                // Breathing sway: ABSOLUTE offsets on the frozen pose (never accumulate on the bones —
                // a frozen action stops writing them, so `+=` made her bend further every frame).
                const b = rec.bones || {};
                if (!rec.baseQ) { rec.baseQ = {}; Object.keys(b).forEach(k => { rec.baseQ[k] = b[k].quaternion.clone(); }); }
                const sway = (name, ex, ey, ez) => {
                    const bone = b[name];
                    if (!bone || !rec.baseQ[name]) return;
                    bone.quaternion.copy(rec.baseQ[name]).multiply(NPC_TMP_Q.setFromEuler(NPC_TMP_E.set(ex, ey, ez)));
                };
                sway('mixamorigSpine1', Math.sin(rec.t * 1.5) * 0.012, 0, 0);
                sway('mixamorigSpine2', Math.sin(rec.t * 1.5 + 0.4) * 0.01, 0, 0);
                sway('mixamorigHead', Math.sin(rec.t * 0.9) * 0.01, Math.sin(rec.t * 0.5) * 0.05, 0);
                if (!c || !rec.model) continue;
                const dx = c.position.x - rec.x, dz = c.position.z - rec.z;
                const near = dx * dx + dz * dz < 36;
                const isTalkTarget = talking && this.game.ui.dialog && this.game.ui.dialog.npc === rec.npc;
                this.setNpcAnim(rec, isTalkTarget ? 'Talk' : 'Idle');
                if (near || isTalkTarget) {
                    const want = Math.atan2(dx, dz);
                    let d = want - rec.model.rotation.y;
                    d = Math.atan2(Math.sin(d), Math.cos(d));
                    rec.model.rotation.y += d * Math.min(1, (delta || 0) * 4);
                } else {
                    let d = rec.baseYaw - rec.model.rotation.y;
                    d = Math.atan2(Math.sin(d), Math.cos(d));
                    rec.model.rotation.y += d * Math.min(1, (delta || 0) * 2);
                }
            }
        }

        /**
         * Adds a prop at runtime (e.g. the stump of a felled tree — harvest.js).
         * No nav obstacle is registered (the grid has no removal; the felled
         * tree's own obstacle is still there anyway). Resolves to the record.
         */
        addProp(p) {
            return this.buildProp(Object.assign({ noObstacle: true }, p));
        }

        /** Removes a prop added by addProp() (or any prop) by id. */
        removeProp(id) {
            const i = this.props.findIndex(r => r.id === id);
            if (i < 0) return false;
            const rec = this.props[i];
            this.props.splice(i, 1);
            if (rec.object && rec.object.parent) rec.object.parent.remove(rec.object);
            this.version++;
            return true;
        }

        getProp(id) { return this.props.find(r => r.id === id) || null; }

        // -----------------------------------------------------------
        // Pickups (piles)
        // -----------------------------------------------------------
        addPickup(p) {
            const def = window.AveloraItems.get(p.item);
            if (!def || !p.id) {
                console.warn(`[Avelora] location "${this.location.id}": bad pickup`, p);
                return Promise.resolve();
            }
            const pile = { data: p, id: p.id, def, dynamic: false, group: null, proxy: null, remaining: 0 };
            this.piles.set(p.id, pile);
            return this.loadTemplates('items', def.id, def).then(variants => {
                pile.variants = variants;
                if (!this.disposed) this.rebuildPile(pile);
            });
        }

        /** A dynamic (state-owned) pile: `g` is the live state entry {uid,item,count,x,z,r}. */
        addGroundPile(g) {
            const def = window.AveloraItems.get(g.item);
            if (!def) return Promise.resolve();
            const id = 'ground:' + g.uid;
            const pile = { data: g, id, def, dynamic: true, group: null, proxy: null, remaining: 0 };
            this.piles.set(id, pile);
            return this.loadTemplates('items', def.id, def).then(variants => {
                pile.variants = variants;
                if (!this.disposed && this.piles.get(id) === pile) this.rebuildPile(pile);
            });
        }

        pileIdOf(pile) { return pile.dynamic ? pile.id : pile.data.id; }

        remainingOf(pile) {
            if (pile.dynamic) return Math.max(0, pile.data.count | 0);
            const taken = this.state ? this.state.getTaken(this.location.id, pile.data.id) : 0;
            return Math.max(0, (pile.data.count || 1) - taken);
        }

        /** (Re)creates a pile's meshes for its current remaining count. Old meshes are only detached (their geometry/materials are shared templates, freed with the location). */
        rebuildPile(pile) {
            if (pile.group) { this.root.remove(pile.group); pile.group = null; }
            if (pile.proxy) {
                this.root.remove(pile.proxy);
                this.proxies.splice(this.proxies.indexOf(pile.proxy), 1);
                pile.proxy.geometry.dispose();
                pile.proxy = null;
            }
            pile.remaining = this.remainingOf(pile);
            if (pile.remaining <= 0 || !pile.variants) return;

            const p = pile.data;
            const group = new THREE.Group();
            group.name = `pickup:${pile.id}`;
            group.position.set(p.x, 0, p.z);

            const n = Math.min(pile.remaining, MAX_PILE_VISUAL);
            const style = (pile.def.ground && pile.def.ground.pile) || (n === 1 ? 'single' : 'heap');
            const layout = n === 1 || style === 'single' ? this.layoutSingle(pile)
                : style === 'stack' ? this.layoutStack(pile, n)
                : this.layoutHeap(pile, n);

            const scale = (pile.def.ground && pile.def.ground.scale) || 1.0;
            let footprint = 0.3;
            layout.forEach(l => {
                const obj = pile.variants[l.v % pile.variants.length].clone();
                obj.position.set(l.x, l.y, l.z);
                obj.rotation.set(l.rx || 0, l.ry || 0, l.rz || 0, l.order || 'XYZ');
                obj.scale.setScalar(scale);
                group.add(obj);
                footprint = Math.max(footprint, Math.hypot(l.x, l.z) + 0.25);
            });
            this.root.add(group);
            pile.group = group;

            // Generous invisible hit target: small piles are hard to hover/tap on a phone
            const r = Math.max(0.55, Math.min(1.2, footprint));
            const proxyGeo = new THREE.CylinderGeometry(r, r, 0.9, 10, 1);
            proxyGeo.translate(0, 0.45, 0);
            const proxy = new THREE.Mesh(proxyGeo, AveloraWorldObjects.proxyMaterial());
            proxy.position.set(p.x, this.terrain.getHeightAt(p.x, p.z) + (p.y || 0) * 0.5 - 0.1, p.z);
            proxy.userData.pickupId = pile.id;
            this.root.add(proxy);
            pile.proxy = proxy;
            this.proxies.push(proxy);
        }

        /**
         * glTF alphaMode MASK leaves (bush): GLTFLoader already maps it to
         * alphaTest, but make sure cut-out leaves are double-sided, alpha-tested
         * and depth-writing (no sorting artefacts), for any alpha-mapped material.
         */
        static prepareFoliage(root) {
            root.traverse(o => {
                if (!o.isMesh || !o.material) return;
                (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
                    if (m.alphaTest > 0 || m.transparent || (m.map && m.map.format === THREE.RGBAFormat)) {
                        m.alphaTest = Math.max(m.alphaTest || 0, 0.4);
                        m.transparent = false;
                        m.depthWrite = true;
                        m.side = THREE.DoubleSide;
                        m.needsUpdate = true;
                    }
                });
            });
        }

        static proxyMaterial() {
            // Shared across locations and never in the render list — teardown may
            // dispose() it; a disposed MeshBasicMaterial is still valid to reuse.
            if (!AveloraWorldObjects._proxyMat) AveloraWorldObjects._proxyMat = new THREE.MeshBasicMaterial({ visible: false });
            return AveloraWorldObjects._proxyMat;
        }

        groundY(x, z) { return this.terrain.getHeightAt(x, z); }

        /** One model at the pile point; `y` (height above ground) and `rotation` [x,y,z] may override. */
        layoutSingle(pile) {
            const p = pile.data;
            const rng = rngFor(pile.id);
            const gConf = (pile.def && pile.def.ground) || {};
            const isEquip = pile.def && pile.def.use && pile.def.use.type === 'equip';
            const offsetY = gConf.offsetY !== undefined ? gConf.offsetY : (isEquip ? 0.03 : 0);
            const baseY = this.groundY(p.x, p.z) + (p.y || 0) + offsetY - 0.01;

            if (Array.isArray(p.rotation)) {
                return [{ v: 0, x: 0, y: baseY, z: 0, rx: p.rotation[0] || 0, ry: p.rotation[1] || 0, rz: p.rotation[2] || 0 }];
            }

            const yaw = p.r !== undefined ? p.r : rng() * Math.PI * 2;
            if (Array.isArray(gConf.rotation)) {
                return [{ v: 0, x: 0, y: baseY, z: 0, rx: gConf.rotation[0] || 0, ry: yaw, rz: gConf.rotation[2] || 0, order: 'YXZ' }];
            }
            if (isEquip) {
                // Hand-held tools and weapons modeled along +Y lie flat horizontally on the terrain
                return [{ v: 0, x: 0, y: baseY, z: 0, rx: Math.PI / 2, ry: yaw, rz: 0, order: 'YXZ' }];
            }
            return [{ v: 0, x: 0, y: baseY, z: 0, ry: yaw }];
        }

        /** Natural heap: most items on the ground in a loose cluster, the rest resting in the gaps on top. */
        layoutHeap(pile, n) {
            const p = pile.data;
            const rng = rngFor(pile.id);
            const vs = pile.variants;
            let avgR = 0, avgH = 0;
            vs.forEach(v => { avgR += Math.max(v.userData.size.x, v.userData.size.z) * 0.5; avgH += v.userData.size.y; });
            avgR /= vs.length; avgH /= vs.length;

            const groundN = n <= 2 ? n : n <= 4 ? n - 1 : Math.ceil(n * 0.62);
            const yaw = p.r !== undefined ? p.r : rng() * Math.PI * 2;
            const vStart = Math.floor(rng() * vs.length);
            const out = [];
            const ground = [];
            for (let i = 0; i < groundN; i++) {
                const ang = yaw + i * 2.39996 + (rng() - 0.5) * 0.6; // golden angle -> even, organic spread
                const dist = i === 0 ? avgR * 0.3 * rng() : avgR * (1.35 + 0.25 * rng()) * Math.sqrt(i);
                const lx = Math.cos(ang) * dist, lz = Math.sin(ang) * dist;
                const v = (vStart + i) % vs.length;
                const e = {
                    v, x: lx, z: lz,
                    y: this.groundY(p.x + lx, p.z + lz) - vs[v].userData.minY - 0.015,
                    rx: (rng() - 0.5) * 0.3, ry: rng() * Math.PI * 2, rz: (rng() - 0.5) * 0.3
                };
                ground.push(e);
                out.push(e);
            }
            // Upper layer: nestle into the gap between two (or three) neighbours
            for (let i = groundN; i < n; i++) {
                const k = (i - groundN) % ground.length;
                const a = ground[k], b = ground[(k + 1) % ground.length], c = ground[0];
                const lx = (a.x + b.x + c.x) / 3 + (rng() - 0.5) * avgR * 0.3;
                const lz = (a.z + b.z + c.z) / 3 + (rng() - 0.5) * avgR * 0.3;
                const baseY = Math.max(a.y, b.y, c.y);
                const v = (vStart + i) % vs.length;
                out.push({
                    v, x: lx, z: lz,
                    y: baseY + avgH * 0.55 - vs[v].userData.minY * 0.5,
                    rx: (rng() - 0.5) * 0.6, ry: rng() * Math.PI * 2, rz: (rng() - 0.5) * 0.6
                });
            }
            return out;
        }

        /** Woodpile: rows of parallel logs (along local X), each row one shorter and nestled in the grooves below. */
        layoutStack(pile, n) {
            const p = pile.data;
            const rng = rngFor(pile.id);
            const vs = pile.variants;
            let d = 0;
            vs.forEach(v => { d += Math.max(v.userData.size.y, v.userData.size.z); });
            d /= vs.length;

            let bottom = 1;
            while (bottom * (bottom + 1) / 2 < n) bottom++;
            const yaw = p.r !== undefined ? p.r : rng() * Math.PI * 2;
            const cos = Math.cos(yaw), sin = Math.sin(yaw);

            // Rest the stack on the lowest ground under it, so no end floats on a slope
            let base = Infinity;
            for (let i = 0; i < 5; i++) {
                const ox = [0, 0.6, -0.6, 0, 0][i], oz = [0, 0, 0, 0.3, -0.3][i];
                base = Math.min(base, this.groundY(p.x + ox * cos + oz * sin, p.z - ox * sin + oz * cos));
            }

            const out = [];
            let placed = 0, row = 0;
            const vStart = Math.floor(rng() * vs.length);
            for (let m = bottom; m >= 1 && placed < n; m--, row++) {
                for (let j = 0; j < m && placed < n; j++, placed++) {
                    const lz0 = (j - (m - 1) / 2) * d * 1.04;
                    const lx0 = (rng() - 0.5) * 0.16;
                    const v = (vStart + placed) % vs.length;
                    out.push({
                        v,
                        x: lx0 * cos + lz0 * sin,
                        z: -lx0 * sin + lz0 * cos,
                        y: base + row * d * 0.84 - vs[v].userData.minY - 0.02,
                        rx: 0,
                        ry: yaw + (rng() - 0.5) * 0.08,
                        rz: 0
                    });
                }
            }
            return out;
        }

        // -----------------------------------------------------------
        // Interaction
        // -----------------------------------------------------------
        /** Pile under the (already set up) raycaster, or null. */
        pickAt(raycaster) {
            if (!this.proxies.length) return null;
            const hit = raycaster.intersectObjects(this.proxies, false)[0];
            return hit ? this.piles.get(hit.object.userData.pickupId) || null : null;
        }

        // -----------------------------------------------------------
        // Containers (chests): click -> walk up -> open bag + chest panels (ui_hotbar.js openChest)
        // -----------------------------------------------------------
        pickContainerAt(raycaster) {
            if (!this.containerProxies.length) return null;
            const hit = raycaster.intersectObjects(this.containerProxies, false)[0];
            return hit ? this.props.find(r => r.id === hit.object.userData.containerId) || null : null;
        }

        containerDistance(rec) {
            const c = this.game.character;
            return c ? Math.hypot(c.position.x - rec.x, c.position.z - rec.z) : Infinity;
        }

        containerReach(rec) { return Math.max(rec.r, 0.5) + CONTAINER_REACH; }

        requestOpenContainer(rec) {
            const c = this.game.character;
            if (!c || !rec || !(rec.container || rec.npc)) return;
            if (this.containerDistance(rec) <= this.containerReach(rec)) {
                this.pendingContainerId = null;
                c.stopMovement();
                this.activate(rec);
                return;
            }
            const path = this.pathfinder ? this.pathfinder.findPath(c.position, new THREE.Vector3(rec.x, 0, rec.z)) : [];
            if (path && path.length) {
                c.setPath(path);
                this.pendingContainerId = rec.id;
            }
        }

        /** Chest -> bag + chest panels, NPC -> dialog window. */
        activate(rec) {
            if (rec.npc) {
                if (!this.game.ui || !this.game.ui.openDialog) return;
                this.openContainer = rec;
                this.game.ui.openDialog(rec.npc);
            } else this.openChest(rec);
        }

        openChest(rec) {
            const st = this.state;
            if (!st || !this.game.ui || !this.game.ui.openChest) return;
            const inv = st.chestInventory(`${this.location.id}/${rec.id}`, rec.container.slots);
            this.openContainer = rec;
            this.game.ui.openChest(rec.container.title, inv);
        }

        closeChest() {
            if (!this.openContainer) return;
            this.openContainer = null;
            if (this.game.ui) {
                if (this.game.ui.closeChest) this.game.ui.closeChest();
                if (this.game.ui.closeDialog) this.game.ui.closeDialog();
            }
        }

        labelOfContainer(rec) { return rec.npc ? rec.npc.name : rec.container.title; }

        labelOf(pile) {
            return pile.remaining > 1 ? `${pile.def.name} ×${pile.remaining}` : pile.def.name;
        }

        distanceTo(pile) {
            const c = this.game.character;
            if (!c) return Infinity;
            return Math.hypot(c.position.x - pile.data.x, c.position.z - pile.data.z);
        }

        /** Click on a pile: pick up now if close enough, otherwise walk there and pick up on arrival. */
        requestPickup(pile) {
            const c = this.game.character;
            if (!c || !pile || pile.remaining <= 0) return;
            if (this.distanceTo(pile) <= PICKUP_RANGE) {
                this.pendingPileId = null;
                c.stopMovement();
                this.collect(pile);
                return;
            }
            const target = new THREE.Vector3(pile.data.x, 0, pile.data.z);
            const path = this.pathfinder ? this.pathfinder.findPath(c.position, target) : [];
            if (path && path.length) {
                c.setPath(path);
                this.pendingPileId = pile.id;
            }
        }

        cancelPending() { this.pendingPileId = null; this.pendingContainerId = null; }

        update(delta) {
            for (let i = 0; i < this.fires.length; i++) this.fires[i].update(delta || 0);
            if (this.npcMixers.length) this.updateNpcs(delta);
            // monster loot lying on the ground disappears after its despawnMinutes
            this.expireT = (this.expireT || 0) + (delta || 0);
            if (this.expireT >= 4 && this.state) {
                this.expireT = 0;
                this.state.expireGround(this.location.id).forEach(uid => {
                    const pile = this.piles.get('ground:' + uid);
                    if (!pile) return;
                    pile.data.count = 0;
                    this.rebuildPile(pile);
                    this.piles.delete(pile.id);
                });
            }
            // chest: open on arrival; close when the player walks away
            const c0 = this.game.character;
            if (this.pendingContainerId && c0) {
                const rec = this.props.find(r => r.id === this.pendingContainerId);
                if (!rec) this.pendingContainerId = null;
                else if (this.containerDistance(rec) <= this.containerReach(rec)) {
                    this.pendingContainerId = null;
                    c0.stopMovement();
                    this.activate(rec);
                } else if (!c0.isMoving) this.pendingContainerId = null;
            }
            if (this.openContainer && c0 && this.containerDistance(this.openContainer) > this.containerReach(this.openContainer) + 1.5) this.closeChest();
            if (!this.pendingPileId) return;
            const pile = this.piles.get(this.pendingPileId);
            const c = this.game.character;
            if (!pile || !c || pile.remaining <= 0) { this.pendingPileId = null; return; }
            if (this.distanceTo(pile) <= PICKUP_RANGE) {
                this.pendingPileId = null;
                c.stopMovement();
                this.collect(pile);
            } else if (!c.isMoving) {
                this.pendingPileId = null; // path ended short of the pile (unreachable) — give up quietly
            }
        }

        /** Moves as much of the pile as fits into the bag; persists immediately. */
        collect(pile) {
            const state = this.state;
            if (!state) return;
            const itemId = pile.def.id;
            const want = this.remainingOf(pile);
            const n = Math.min(want, state.inventory.spaceFor(itemId));
            const ui = this.game.ui;
            if (n <= 0) {
                if (ui) ui.floatText('Сумка полна', 'warn');
                return;
            }
            // Record the taken count first so the single write triggered by
            // inventory.add() (onChange -> state.save()) already contains both.
            if (pile.dynamic) state.takeGround(this.location.id, pile.data.uid, n);
            else state.addTaken(this.location.id, pile.data.id, n);
            state.inventory.add(itemId, n);
            this.rebuildPile(pile);
            if (pile.dynamic && pile.remaining <= 0) this.piles.delete(pile.id);
            if (ui) {
                ui.floatText(`+${n} ${pile.def.name}`, 'gain');
                if (n < want) ui.floatText('Сумка полна', 'warn', 0.45);
                ui.pulseInventory();
            }
            if (this.game.hideObjectTooltip) this.game.hideObjectTooltip();
            window.dispatchEvent(new CustomEvent('game:pickup', {
                detail: { locationId: this.location.id, pickupId: pile.id, item: itemId, count: n, dynamic: !!pile.dynamic }
            }));
        }

        /** State for a different character was loaded (or reset): rebuild every pile from it. */
        refreshAll() {
            this.pendingPileId = null;
            this.closeChest();
            this.piles.forEach(pile => this.rebuildPile(pile));
        }


        // -----------------------------------------------------------
        // Ground drops
        // -----------------------------------------------------------
        /** Number of dynamic piles in this location (tests / crowding). */
        dynamicCount() {
            let n = 0;
            this.piles.forEach(p => { if (p.dynamic) n++; });
            return n;
        }

        /**
         * Puts `count` of an item on the ground at (x, z) as a dynamic pile,
         * persisted in the character state; merges with a same-item pile nearby.
         * Resolves to the pile.
         */
        addDrop(itemId, count, x, z, r) {
            const st = this.state;
            if (!st || !window.AveloraItems.get(itemId) || !(count > 0)) return Promise.resolve(null);
            const crowded = this.dynamicCount() >= CROWDED_PILES;
            const entry = st.addGround(this.location.id, itemId, count, x, z, r || 0,
                crowded ? CROWDED_MERGE_RADIUS : DROP_MERGE_RADIUS);
            if (!entry) return Promise.resolve(null);
            const id = 'ground:' + entry.uid;
            const existing = this.piles.get(id);
            if (existing) {
                if (existing.variants) this.rebuildPile(existing);
                return Promise.resolve(existing);
            }
            return this.addGroundPile(entry).then(() => this.piles.get(id) || null);
        }

        /** Walkable ground (nav grid, not water) at a point? */
        isWalkableAt(x, z) {
            const pf = this.pathfinder;
            if (!pf) return true;
            const g = pf.worldToGrid(x, z);
            return pf.isWalkable(g.x, g.z) && this.terrain.getHeightAt(x, z) > -0.2;
        }

        /**
         * Nearest walkable point to (x, z): tries the point itself, then rings
         * of candidates around it. Falls back to (fx, fz) (e.g. the character's
         * own position, which is walkable by definition).
         */
        findDropSpot(x, z, fx, fz) {
            if (this.isWalkableAt(x, z)) return { x, z };
            for (let ring = 1; ring <= 4; ring++) {
                const rad = ring * 0.5;
                for (let k = 0; k < 8; k++) {
                    const a = (k / 8) * Math.PI * 2 + ring * 0.4;
                    const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
                    if (this.isWalkableAt(px, pz)) return { x: px, z: pz };
                }
            }
            return { x: fx !== undefined ? fx : x, z: fz !== undefined ? fz : z };
        }

        /**
         * Drops the WHOLE stack of a bag cell at the character's feet (slightly
         * in front, on walkable ground). Dropping the equipped item unequips it
         * (the hotbar binding stays — it just greys out).
        /**
         * Drops a stack (or a specified count of items) from a bag cell at the
         * character's feet. If count is omitted or >= stack count, drops the whole cell.
         */
        dropFromInventory(cellIndex, count = null) {
            const st = this.state;
            const c = this.game.character;
            if (!st || !c) return false;
            const cell = st.inventory.cells[cellIndex];
            if (!cell) return false;
            const def = window.AveloraItems.get(cell.item);
            // In front of the character (character.js heading: rotation = atan2(dx,dz)+PI)
            const rot = c.currentRotation;
            const fx = -Math.sin(rot), fz = -Math.cos(rot);
            const spot = this.findDropSpot(c.position.x + fx * 0.85, c.position.z + fz * 0.85, c.position.x, c.position.z);
            const taken = (count && count > 0 && count < cell.count)
                ? st.inventory.removeCountAt(cellIndex, count)
                : st.inventory.removeAt(cellIndex); // saves
            if (!taken) return false;
            if (st.equipped.right === taken.item && st.inventory.count(taken.item) <= 0) {
                st.setEquipped('right', null);
                if (this.game.ui) this.game.ui.applyEquipment();
            }
            this.addDrop(taken.item, taken.count, spot.x, spot.z, rot + Math.PI / 2);
            const ui = this.game.ui;
            if (ui) ui.floatText(`−${taken.count} ${def ? def.name : taken.item}`, 'info');
            window.dispatchEvent(new CustomEvent('game:drop', {
                detail: { locationId: this.location.id, item: taken.item, count: taken.count, x: spot.x, z: spot.z }
            }));
            return true;
        }

        /** Obstacles for projectiles (skills.js): props only (not foliage); trees/rocks come from the environment. */
        getBlockers() { return this.props.filter(p => p.blocks !== false); }

        dispose() {
            // Meshes/geometries/materials live under locationRoot and are freed by
            // teardownLocation(); here we only drop references and stop pending work.
            this.disposed = true;
            this.pendingPileId = null;
            this.pendingContainerId = null;
            this.closeChest();
            this.containerProxies.length = 0;
            this.piles.clear();
            this.proxies.length = 0;
            this.props.length = 0;
            this.fires.forEach(f => f.dispose());
            this.fires.length = 0;
            const geos = new Set(), mats = new Set();
            this.allTemplates.forEach(t => t.traverse(o => {
                if (o.geometry) geos.add(o.geometry);
                if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
            }));
            mats.forEach(m => {
                Object.keys(m).forEach(k => { if (m[k] && m[k].isTexture) m[k].dispose(); });
                m.dispose();
            });
            geos.forEach(g => g.dispose());
            this.allTemplates.length = 0;
            this.templates = {};
        }
    }

    AveloraWorldObjects.PICKUP_RANGE = PICKUP_RANGE;
    window.AveloraWorldObjects = AveloraWorldObjects;
})();
