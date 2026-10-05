/**
 * Avelora — Harvesting resource nodes (trees): chop, fall, drops, stump, regrow
 *
 * Node definitions: `window.GAME_CONTENT.nodes` (content/nodes/<id>/node.json):
 *   { kind: 'trees',            // which environment.js object kind this applies to
 *     tool: 'chop',             // the right-hand item's weapon must have `chop` (> 0)
 *     hits: 5,                  // swings to fell it
 *     drops: [{ item, min, max }],   // random count per drop (seeded per tree)
 *     regrowMinutes: 10,        // PLAYED minutes until it stands again
 *     stump: 'stump' }          // content/props/<id> left behind (scale = tree s × STUMP_SCALE)
 *
 * Trees are the instanced environment objects (environment.js, ids like
 * "oak_grove.tree3" or "trees_0"). Clicking one with a chop tool engages it
 * through combat.js (walk to ~1.6 m of the trunk, swing loop). Each hit: a burst
 * of wood chips + dust (pooled THREE.Points, 2 draw calls, only while alive), a
 * short damped shake of that one instance (environment.setObjectTransform).
 * After `hits` hits the tree FALLS: the instance is hidden, a temporary
 * one-instance copy of every tree part (InstancedMesh -> same shader programs, no
 * compile hitch) tips ~85° about its base AWAY from the player with an
 * accelerating fall and a small bounce, lies a few seconds, sinks and is freed.
 * On landing the drops appear as ground piles (world_objects.addDrop) along the
 * fallen trunk and a dust puff rises along it. A stump prop appears at the base.
 *
 * Persistence: game_state.js `felled[loc][treeId] = playTime`. On (re)build the
 * felled trees are hidden (+ stump) unless regrowMinutes of played time have
 * passed; live, every REGROW_CHECK s of game time, a due tree grows back
 * (scale-in) and its stump disappears. Hidden trees no longer block Spark
 * (skills.js blocker cache keys on environment.version). The tree's nav
 * obstacle stays (the grid has no removal; the stump stands there anyway).
 * Partial hits are not persisted (a half-chopped tree is whole after reload).
 */
(function () {
    'use strict';

    const TREE_HEIGHT = 3.8;      // m at s = 1 (tree_realistic.glb, 0.01-scaled beech)
    const TRUNK_RADIUS = 0.3;     // m at s = 1 (projectile blocker uses 0.32)
    const CHOP_REACH = 1.6;       // m from the trunk surface
    const STUMP_SCALE = 0.8;
    const FALL_TIME = 1.4, BOUNCE_TIME = 0.45, LIE_TIME = 3.2, SINK_TIME = 1.8;
    const FALL_ANGLE = 85 * Math.PI / 180;
    const SHAKE_TIME = 0.4;
    const REGROW_TIME = 1.6;
    const REGROW_CHECK = 3;       // s (game time) between regrow checks
    const MAX_CHIPS = 96, MAX_DUST = 64;

    function hashString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }

    function canvasTexture(size, draw) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        draw(c.getContext('2d'), size);
        const t = new THREE.CanvasTexture(c);
        t.needsUpdate = true;
        return t;
    }

    /** Pooled soft particles with per-point RGBA + size (normal blending: chips and dust are matte). */
    class FxPoints {
        constructor(capacity, texture) {
            this.cap = capacity;
            this.n = 0;
            const S = capacity;
            this.x = new Float32Array(S); this.y = new Float32Array(S); this.z = new Float32Array(S);
            this.vx = new Float32Array(S); this.vy = new Float32Array(S); this.vz = new Float32Array(S);
            this.age = new Float32Array(S); this.life = new Float32Array(S);
            this.size = new Float32Array(S); this.grow = new Float32Array(S); this.grav = new Float32Array(S);
            this.r = new Float32Array(S); this.g = new Float32Array(S); this.b = new Float32Array(S); this.a = new Float32Array(S);
            this.pos = new Float32Array(S * 3);
            this.col = new Float32Array(S * 4);
            this.sz = new Float32Array(S);
            const geo = new THREE.BufferGeometry();
            this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
            this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
            this.aSize = new THREE.BufferAttribute(this.sz, 1).setUsage(THREE.DynamicDrawUsage);
            geo.setAttribute('position', this.aPos);
            geo.setAttribute('aColor', this.aCol);
            geo.setAttribute('aSize', this.aSize);
            geo.setDrawRange(0, 0);
            this.uniforms = { uMap: { value: texture }, uScale: { value: 800 } };
            const mat = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: `
                    attribute vec4 aColor;
                    attribute float aSize;
                    uniform float uScale;
                    varying vec4 vColor;
                    void main() {
                        vColor = aColor;
                        vec4 mv = modelViewMatrix * vec4(position, 1.0);
                        gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 96.0);
                        gl_Position = projectionMatrix * mv;
                    }`,
                fragmentShader: `
                    uniform sampler2D uMap;
                    varying vec4 vColor;
                    void main() {
                        vec4 t = texture2D(uMap, gl_PointCoord);
                        if (t.a * vColor.a < 0.02) discard;
                        gl_FragColor = vec4(vColor.rgb * t.rgb, t.a * vColor.a);
                    }`,
                transparent: true,
                depthWrite: false
            });
            this.points = new THREE.Points(geo, mat);
            this.points.frustumCulled = false;
            this.points.visible = false;
            this.points.renderOrder = 6;
        }

        add(x, y, z, vx, vy, vz, life, size, grow, grav, r, g, b, a) {
            if (this.n >= this.cap) return;
            const i = this.n++;
            this.x[i] = x; this.y[i] = y; this.z[i] = z;
            this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
            this.age[i] = 0; this.life[i] = life; this.size[i] = size; this.grow[i] = grow; this.grav[i] = grav;
            this.r[i] = r; this.g[i] = g; this.b[i] = b; this.a[i] = a;
        }

        update(dt, terrain, scale) {
            let i = 0;
            const drag = Math.exp(-1.6 * dt);
            while (i < this.n) {
                this.age[i] += dt;
                if (this.age[i] >= this.life[i]) {
                    const j = --this.n;
                    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.z[i] = this.z[j];
                    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
                    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j];
                    this.grow[i] = this.grow[j]; this.grav[i] = this.grav[j];
                    this.r[i] = this.r[j]; this.g[i] = this.g[j]; this.b[i] = this.b[j]; this.a[i] = this.a[j];
                    continue;
                }
                this.vy[i] -= 9.8 * this.grav[i] * dt;
                this.vx[i] *= drag; this.vy[i] *= this.grav[i] > 0 ? 1 : drag; this.vz[i] *= drag;
                this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
                if (terrain && this.grav[i] > 0) {
                    const gy = terrain.getHeightAt(this.x[i], this.z[i]) + 0.02;
                    if (this.y[i] < gy) { this.y[i] = gy; this.vy[i] *= -0.25; this.vx[i] *= 0.4; this.vz[i] *= 0.4; }
                }
                const t = this.age[i] / this.life[i];
                const k = i * 3, c = i * 4;
                this.pos[k] = this.x[i]; this.pos[k + 1] = this.y[i]; this.pos[k + 2] = this.z[i];
                this.col[c] = this.r[i]; this.col[c + 1] = this.g[i]; this.col[c + 2] = this.b[i];
                this.col[c + 3] = this.a[i] * (t > 0.6 ? (1 - t) / 0.4 : 1);
                this.sz[i] = this.size[i] * (1 + this.grow[i] * t);
                i++;
            }
            this.uniforms.uScale.value = scale;
            this.points.visible = this.n > 0;
            this.points.geometry.setDrawRange(0, this.n);
            if (this.n > 0) {
                this.aPos.updateRange.count = this.n * 3; this.aPos.needsUpdate = true;
                this.aCol.updateRange.count = this.n * 4; this.aCol.needsUpdate = true;
                this.aSize.updateRange.count = this.n; this.aSize.needsUpdate = true;
            }
        }
    }

    class AveloraHarvest {
        constructor(game, location) {
            this.game = game;
            this.location = location;
            this.root = game.locationRoot;
            this.env = game.environment;
            this.terrain = game.terrain;
            this.hits = new Map();       // treeId -> hits so far (not persisted)
            this.falling = [];           // fall animations
            this.shakes = new Map();     // treeId -> { t, ax, az }
            this.regrowing = new Map();  // treeId -> { t }
            this.checkTimer = REGROW_CHECK;
            this.fx = null;
            this.disposed = false;
            this._m = new THREE.Matrix4();
            this._m2 = new THREE.Matrix4();
            this._axis = new THREE.Vector3();
            this._bufSize = new THREE.Vector2();
            this.ready = (this.env && this.env.ready ? this.env.ready : Promise.resolve())
                .then(() => (game.worldObjects ? game.worldObjects.ready : null))
                .then(() => { if (!this.disposed) this.applyFelled(); });
        }

        get state() { return this.game.gameState; }
        get playTime() { return this.state ? this.state.playTime : 0; }

        /** node.json for an environment object kind ('trees'), or null. */
        nodeFor(kind) {
            const defs = (window.GAME_CONTENT && window.GAME_CONTENT.nodes) || {};
            const ids = Object.keys(defs);
            for (let i = 0; i < ids.length; i++) if (defs[ids[i]].kind === kind) return defs[ids[i]];
            return null;
        }

        isHarvestable(entry) { return !!(entry && entry.visible !== false && this.nodeFor(entry.kind)); }

        /** Does the right hand hold the tool this node needs? */
        hasTool(node) {
            if (!node) return false;
            if (node.tool === 'gather' || !node.tool) return true;
            const w = this.game.combat ? this.game.combat.weapon() : null;
            if (node.tool === 'chop') return !!(w && w.chop > 0);
            if (node.tool === 'mine') return !!(w && w.mine > 0);
            return false;
        }

        /** An item in the bag that works as a tool (weapon.chop > 0 or weapon.mine > 0), or null. */
        findToolInBag(toolName) {
            const st = this.state;
            if (!st) return null;
            for (const c of st.inventory.cells) {
                if (!c || !window.AveloraItems.isEquippable(c.item)) continue;
                const w = window.AveloraItems.weaponOf(c.item);
                if (w && w[toolName] > 0) return c.item;
            }
            return null;
        }

        /** Legacy helper for chopping */
        findChopToolInBag() { return this.findToolInBag('chop'); }

        /**
         * No tool in hand but one in the bag: take it (the old hand item goes to the bag)
         * and remember what to give back once the task is over (restoreTool).
         */
        autoEquipTool(node) {
            if (!node || (node.tool !== 'chop' && node.tool !== 'mine')) return false;
            const st = this.state, ui = this.game.ui;
            const id = this.findToolInBag(node.tool);
            if (!st || !id) return false;
            const prev = st.equipped.right;
            if (st.equipFromBag(id) !== 'ok') return false;
            if (!this.autoSwap) this.autoSwap = { prev, id };
            else this.autoSwap.id = id;
            this.toolIdle = 0;
            if (ui) { ui.applyEquipment(); if (ui.renderAll) ui.renderAll(); }
            return true;
        }

        /** Gives the hand back what it held before auto-equipping the axe/pickaxe (no-op if the player changed it meanwhile). */
        restoreTool() {
            const sw = this.autoSwap, st = this.state, ui = this.game.ui;
            this.autoSwap = null;
            if (!sw || !st || st.equipped.right !== sw.id) return;
            const res = sw.prev && st.inventory.count(sw.prev) > 0 ? st.equipFromBag(sw.prev) : st.unequipToBag();
            if (res === 'ok' && ui) { ui.applyEquipment(); if (ui.renderAll) ui.renderAll(); }
        }

        /** Hover text for a harvestable object. */
        labelFor(entry) {
            const node = this.nodeFor(entry.kind);
            if (!node) return entry.label;
            if (node.tool === 'gather' || !node.tool) {
                return `${node.name || entry.label} — сорвать`;
            }
            if (node.tool === 'chop') {
                if (!this.hasTool(node)) return this.findToolInBag('chop') ? `${node.name || entry.label} — рубить (возьмёт топор из сумки)` : `${node.name || entry.label} — нужен топор`;
                return `${node.name || entry.label} — рубить`;
            }
            if (node.tool === 'mine') {
                if (!this.hasTool(node)) return this.findToolInBag('mine') ? `${node.name || entry.label} — добывать (возьмёт кирку из сумки)` : `${node.name || entry.label} — нужна кирка`;
                return `${node.name || entry.label} — добывать`;
            }
            return `${node.name || entry.label}`;
        }

        regrowSeconds(node) { return Math.max(10, (Number(node.regrowMinutes) || 10) * 60); }

        baseY(entry) { return this.terrain.getHeightAt(entry.x, entry.z) - 0.15; }

        // -----------------------------------------------------------
        // Interaction
        // -----------------------------------------------------------
        /** Click/tap on a tree or rock: chop/mine it with a tool; herb: gather it; otherwise walk there. */
        request(entry) {
            const g = this.game;
            const c = g.character;
            const node = this.nodeFor(entry.kind);
            if (!c || !node || entry.visible === false) return false;
            if (!this.hasTool(node) && !this.autoEquipTool(node)) {
                if (g.combat) g.combat.cancel();
                const path = g.pathfinder ? g.pathfinder.findPath(c.position, new THREE.Vector3(entry.x, 0, entry.z)) : [];
                if (path && path.length) c.setPath(path);
                const warnText = node.tool === 'mine' ? 'Нужна кирка (в сумке или в руке)' : 'Нужен топор (в сумке или в руке)';
                if (g.ui) g.ui.floatText(warnText, 'warn');
                return true;
            }

            if (node.tool === 'gather') {
                const s = entry.s || 1;
                const r = 0.35 * s;
                const reach = Math.max(1.3, 0.45 * s + 0.6);
                g.combat.engage({
                    kind: 'gather', id: entry.id, label: node.name,
                    isValid: () => entry.visible !== false && this.game.harvest === this && !this.disposed,
                    x: () => entry.x, z: () => entry.z,
                    radius: r,
                    range: () => reach,
                    onHit: () => this.gather(entry, node)
                });
                return true;
            }

            const s = entry.s || 1;
            const isOre = entry.kind === 'ores';
            const r = isOre ? 0.6 * s : TRUNK_RADIUS * s;
            const reach = isOre ? Math.max(1.3, 0.6 * s + 0.9) : Math.max(CHOP_REACH, 0.8 * s + 0.95 - r);
            g.combat.engage({
                kind: entry.kind, id: entry.id, label: node.name,
                isValid: () => entry.visible !== false && this.game.harvest === this && !this.disposed,
                x: () => entry.x, z: () => entry.z,
                radius: r,
                range: () => reach,
                onHit: () => this.hit(entry, node)
            });
            return true;
        }

        gather(entry, node) {
            const g = this.game;
            const c = g.character;
            const st = this.state;
            if (!c || entry.visible === false) return;
            if (g.combat) g.combat.cancel();
            if (c.isMoving) c.stopMovement();

            if (this.env) this.env.setObjectVisible(entry.id, false);
            if (g.hideObjectTooltip) g.hideObjectTooltip();
            if (st) st.setFelled(this.location.id, entry.id, this.playTime);

            const drops = node.drops || [{ item: 'fern', min: 1, max: 1 }];
            const wo = g.worldObjects;
            drops.forEach(d => {
                const lo = Math.max(1, d.min | 0), hi = Math.max(lo, d.max | 0);
                const count = lo + Math.floor(Math.random() * (hi - lo + 1));
                if (count <= 0) return;
                const itemDef = window.AveloraItems ? window.AveloraItems.get(d.item) : null;
                const itemName = itemDef ? itemDef.name : d.item;

                if (st && st.inventory) {
                    const added = st.inventory.add(d.item, count);
                    if (added > 0 && g.ui) {
                        g.ui.floatText(`+${added} ${itemName}`, 'loot');
                        g.ui.pulseInventory();
                    }
                    if (added < count) {
                        const dropCount = count - added;
                        if (wo) wo.addDrop(d.item, dropCount, c.position.x, c.position.z);
                        if (g.ui) g.ui.floatText('Сумка полна — брошено на землю', 'warn');
                    }
                } else if (wo) {
                    wo.addDrop(d.item, count, entry.x, entry.z);
                }
            });

            // Burst a soft puff of green foliage particles at gathering spot
            const by = this.terrain ? this.terrain.getHeightAt(entry.x, entry.z) : 0;
            const fx = this.ensureFx();
            for (let i = 0; i < 8; i++) {
                fx.dust.add(entry.x + (Math.random() - 0.5) * 0.4, by + 0.35, entry.z + (Math.random() - 0.5) * 0.4,
                    (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.3, (Math.random() - 0.5) * 0.6,
                    0.8 + Math.random() * 0.4, 0.22, 1.2, 0, 0.25, 0.65, 0.28, 0.6);
            }

            window.dispatchEvent(new CustomEvent('game:nodeGathered', { detail: { id: entry.id } }));
        }

        hit(entry, node) {
            const c = this.game.character;
            if (!c || entry.visible === false) return;
            const n = (this.hits.get(entry.id) || 0) + 1;
            this.hits.set(entry.id, n);
            // Direction node -> player (chips fly toward the player)
            let dx = c.position.x - entry.x, dz = c.position.z - entry.z;
            const d = Math.hypot(dx, dz) || 1;
            dx /= d; dz /= d;
            const s = entry.s || 1;
            const by = this.baseY(entry);
            const isOre = entry.kind === 'ores' || node.tool === 'mine';
            const r = isOre ? 0.6 * s : TRUNK_RADIUS * s;
            const hitY = isOre ? by + 0.3 * s + 0.1 : by + 0.9;
            if (isOre) {
                this.burstStoneChips(entry.x + dx * r, hitY, entry.z + dz * r, dx, dz);
            } else {
                this.burstChips(entry.x + dx * r, hitY, entry.z + dz * r, dx, dz);
            }
            this.shakes.set(entry.id, { t: 0, ax: dz, az: -dx, entry }); // tip away from the player
            window.dispatchEvent(new CustomEvent('game:treeHit', { detail: { id: entry.id, hits: n, of: node.hits || 5 } }));
            if (n >= (node.hits || (isOre ? 3 : 5))) {
                if (isOre) this.shatterRock(entry, node, -dx, -dz);
                else this.fell(entry, node, -dx, -dz);
            }
        }

        // -----------------------------------------------------------
        // Felling
        // -----------------------------------------------------------
        fell(entry, node, fx, fz) {
            const g = this.game;
            this.hits.delete(entry.id);
            this.shakes.delete(entry.id);
            if (this.env) this.env.setObjectTransform(entry.id, null);
            if (this.state) this.state.setFelled(this.location.id, entry.id, this.playTime);
            const pivot = this.makeFallingCopy(entry);
            if (this.env) this.env.setObjectVisible(entry.id, false);
            if (g.hideObjectTooltip) g.hideObjectTooltip(); // "Дерево — рубить" must not linger over the felled tree
            this.addStump(entry, node);
            // Rotation axis: up × fallDir (tips the crown toward fallDir)
            const axis = new THREE.Vector3(fz, 0, -fx).normalize();
            this.falling.push({ entry, node, pivot, axis, fx, fz, t: 0, landed: false });
            window.dispatchEvent(new CustomEvent('game:treeFelled', { detail: { id: entry.id } }));
            if (g.ui) g.ui.floatText(`${node.name || 'Дерево'} срублено`, 'info');
        }

        shatterRock(entry, node, fx, fz) {
            const g = this.game;
            this.hits.delete(entry.id);
            this.shakes.delete(entry.id);
            if (this.env) this.env.setObjectTransform(entry.id, null);
            if (this.state) this.state.setFelled(this.location.id, entry.id, this.playTime);
            if (this.env) this.env.setObjectVisible(entry.id, false);
            if (g.hideObjectTooltip) g.hideObjectTooltip();

            // Burst stone rubble particles
            const by = this.baseY(entry);
            this.burstRockCrumble(entry.x, by + 0.5, entry.z);

            // Spawn drops on the ground around the shattered rock
            const wo = g.worldObjects;
            const drops = node.drops || [];
            drops.forEach(d => {
                const lo = Math.max(1, d.min | 0), hi = Math.max(lo, d.max | 0);
                const count = lo + Math.floor(Math.random() * (hi - lo + 1));
                if (count <= 0) return;
                const ox = (Math.random() - 0.5) * 0.9;
                const oz = (Math.random() - 0.5) * 0.9;
                if (wo) wo.addDrop(d.item, count, entry.x + ox, entry.z + oz);
            });

            // Remove obstacle from pathfinder so player and creatures can walk through
            if (g.pathfinder) {
                const obsR = Math.max(0.65, (entry.s || 0.25) * 2.2);
                g.pathfinder.removeObstacle(entry.x, entry.z, obsR);
            }

            this.restoreTool();
            window.dispatchEvent(new CustomEvent('game:oreMined', { detail: { id: entry.id } }));
            if (g.ui) g.ui.floatText(`${node.name || 'Жила'} выработана`, 'info');
        }

        /**
         * Temporary copy of a tree instance as one-instance InstancedMeshes
         * sharing the chunk's geometry/material (same shader programs as the
         * forest -> nothing to compile), under a pivot at the trunk base.
         */
        makeFallingCopy(entry) {
            const pivot = new THREE.Group();
            pivot.name = `falling:${entry.id}`;
            const bx = entry.x, by = this.baseY(entry), bz = entry.z;
            pivot.position.set(bx, by, bz);
            const inv = new THREE.Matrix4().makeTranslation(-bx, -by, -bz);
            const m = new THREE.Matrix4(), t = new THREE.Matrix4();
            entry.parts.forEach(p => {
                if (p.mesh.userData.hoverProxy) return;
                const o = p.mesh.position;
                t.makeTranslation(o.x, o.y, o.z);
                m.multiplyMatrices(t, p.matrix).premultiply(inv);
                const im = new THREE.InstancedMesh(p.mesh.geometry, p.mesh.material, 1);
                im.setMatrixAt(0, m);
                im.instanceMatrix.needsUpdate = true;
                im.frustumCulled = false;
                im.castShadow = true;
                im.receiveShadow = true;
                im.userData.sharedGeometry = true;
                pivot.add(im);
            });
            this.root.add(pivot);
            return pivot;
        }

        addStump(entry, node) {
            const wo = this.game.worldObjects;
            if (!wo || !node.stump) return;
            wo.addProp({ id: 'stump:' + entry.id, prop: node.stump, x: entry.x, z: entry.z,
                r: entry.r || 0, s: (entry.s || 1) * STUMP_SCALE });
        }

        /** Drops along the fallen trunk line (seeded per tree + fell time). */
        spawnDrops(f) {
            const wo = this.game.worldObjects;
            if (!wo) return;
            const e = f.entry, node = f.node;
            const H = TREE_HEIGHT * (e.s || 1);
            const rng = window.aveloraSeededRandom
                ? window.aveloraSeededRandom(hashString(e.id + ':' + Math.floor(this.playTime))) : Math.random;
            const yaw = Math.atan2(-f.fz, f.fx); // logs lie along local X -> along the trunk
            const drops = node.drops || [];
            drops.forEach((d, i) => {
                const lo = Math.max(0, d.min | 0), hi = Math.max(lo, d.max | 0);
                const count = lo + Math.floor(rng() * (hi - lo + 1));
                if (count <= 0) return;
                // Spread the drops along the trunk: first near the base, later ones toward the crown
                const along = H * (0.28 + 0.42 * (drops.length > 1 ? i / (drops.length - 1) : 0.5));
                const side = (rng() - 0.5) * 0.6;
                const x = e.x + f.fx * along - f.fz * side, z = e.z + f.fz * along + f.fx * side;
                const spot = wo.findDropSpot(x, z, e.x + f.fx * 1.5, e.z + f.fz * 1.5);
                wo.addDrop(d.item, count, spot.x, spot.z, yaw + (rng() - 0.5) * 0.3);
            });
        }

        applyFelled() {
            const st = this.state;
            if (!st || !this.env) return;
            const m = st.felled[this.location.id];
            if (!m) return;
            Object.keys(m).forEach(id => {
                const entry = this.env.objects.get(id);
                const node = entry ? this.nodeFor(entry.kind) : null;
                if (!entry || !node) { st.clearFelled(this.location.id, id); return; } // tree no longer exists
                if (this.playTime - m[id] >= this.regrowSeconds(node)) {
                    st.clearFelled(this.location.id, id);
                    return;
                }
                this.env.setObjectVisible(id, false);
                if (entry.kind === 'ores') {
                    if (this.game.pathfinder) {
                        const obsR = Math.max(0.65, (entry.s || 0.25) * 2.2);
                        this.game.pathfinder.removeObstacle(entry.x, entry.z, obsR);
                    }
                } else {
                    this.addStump(entry, node);
                }
            });
        }

        checkRegrow() {
            const st = this.state;
            if (!st || !this.env) return;
            const m = st.felled[this.location.id];
            if (!m) return;
            Object.keys(m).forEach(id => {
                const entry = this.env.objects.get(id);
                const node = entry ? this.nodeFor(entry.kind) : null;
                if (!entry || !node) { st.clearFelled(this.location.id, id); return; }
                if (this.playTime - m[id] < this.regrowSeconds(node)) return;
                // Still falling on screen? wait for it
                if (this.falling.some(f => f.entry === entry)) return;
                st.clearFelled(this.location.id, id);
                if (this.game.worldObjects) this.game.worldObjects.removeProp('stump:' + id);
                this.env.setObjectVisible(id, true);
                if (entry.kind === 'ores') {
                    if (this.game.pathfinder) {
                        const obsR = Math.max(0.65, (entry.s || 0.25) * 2.2);
                        this.game.pathfinder.addObstacle(entry.x, entry.z, obsR);
                    }
                }
                this.regrowing.set(id, { t: 0, entry });
                this.applyScale(entry, 0.02);
                window.dispatchEvent(new CustomEvent('game:treeRegrown', { detail: { id } }));
            });
        }

        applyScale(entry, k) {
            const bx = entry.x, by = this.baseY(entry), bz = entry.z;
            this._m.makeTranslation(-bx, -by, -bz);
            this._m2.makeScale(k, k, k);
            this._m.premultiply(this._m2);
            this._m2.makeTranslation(bx, by, bz);
            this._m.premultiply(this._m2);
            this.env.setObjectTransform(entry.id, this._m);
        }

        // -----------------------------------------------------------
        // VFX
        // -----------------------------------------------------------
        ensureFx() {
            if (this.fx) return this.fx;
            const chipTex = canvasTexture(32, (ctx, s) => {
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.moveTo(s * 0.18, s * 0.3); ctx.lineTo(s * 0.8, s * 0.14); ctx.lineTo(s * 0.86, s * 0.62);
                ctx.lineTo(s * 0.34, s * 0.86); ctx.closePath(); ctx.fill();
            });
            const dustTex = canvasTexture(64, (ctx, s) => {
                const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
                g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
            });
            const chips = new FxPoints(MAX_CHIPS, chipTex);
            const dust = new FxPoints(MAX_DUST, dustTex);
            this.root.add(dust.points, chips.points);
            this.fx = { chips, dust };
            return this.fx;
        }

        burstChips(x, y, z, dx, dz) {
            const fx = this.ensureFx();
            for (let i = 0; i < 14; i++) {
                const a = (Math.random() - 0.5) * 2.2;
                const ca = Math.cos(a), sa = Math.sin(a);
                const vx = (dx * ca - dz * sa), vz = (dz * ca + dx * sa);
                const sp = 1.6 + Math.random() * 2.8;
                const pale = Math.random() < 0.65;
                fx.chips.add(x, y + (Math.random() - 0.5) * 0.2, z,
                    vx * sp, 1.2 + Math.random() * 2.6, vz * sp,
                    0.9 + Math.random() * 0.6, 0.06 + Math.random() * 0.06, 0, 1,
                    pale ? 0.86 : 0.36, pale ? 0.72 : 0.26, pale ? 0.5 : 0.17, 1);
            }
            for (let i = 0; i < 4; i++) {
                fx.dust.add(x + dx * 0.1, y, z + dz * 0.1,
                    dx * (0.3 + Math.random() * 0.4), 0.25 + Math.random() * 0.3, dz * (0.3 + Math.random() * 0.4),
                    0.9 + Math.random() * 0.4, 0.28, 1.6, 0, 0.62, 0.55, 0.44, 0.45);
            }
        }

        burstStoneChips(x, y, z, dx, dz) {
            const fx = this.ensureFx();
            for (let i = 0; i < 14; i++) {
                const a = (Math.random() - 0.5) * 2.2;
                const ca = Math.cos(a), sa = Math.sin(a);
                const vx = (dx * ca - dz * sa), vz = (dz * ca + dx * sa);
                const sp = 1.4 + Math.random() * 2.4;
                const dark = Math.random() < 0.5;
                const col = dark ? 0.35 : 0.68;
                fx.chips.add(x, y + (Math.random() - 0.5) * 0.2, z,
                    vx * sp, 1.0 + Math.random() * 2.2, vz * sp,
                    0.8 + Math.random() * 0.5, 0.05 + Math.random() * 0.05, 0, 1,
                    col, col, col * 1.05, 1);
            }
            for (let i = 0; i < 5; i++) {
                fx.dust.add(x + dx * 0.1, y, z + dz * 0.1,
                    dx * (0.2 + Math.random() * 0.3), 0.2 + Math.random() * 0.25, dz * (0.2 + Math.random() * 0.3),
                    0.9 + Math.random() * 0.4, 0.25, 1.4, 0, 0.6, 0.6, 0.62, 0.5);
            }
        }

        burstRockCrumble(x, y, z) {
            const fx = this.ensureFx();
            for (let i = 0; i < 28; i++) {
                const ang = Math.random() * Math.PI * 2;
                const sp = 0.8 + Math.random() * 2.0;
                const col = 0.35 + Math.random() * 0.35;
                fx.chips.add(x, y + 0.1, z,
                    Math.cos(ang) * sp, 1.2 + Math.random() * 2.5, Math.sin(ang) * sp,
                    1.0 + Math.random() * 0.6, 0.06 + Math.random() * 0.06, 0, 1,
                    col, col, col * 1.05, 1);
            }
            for (let i = 0; i < 12; i++) {
                const ang = Math.random() * Math.PI * 2;
                const sp = 0.3 + Math.random() * 0.6;
                fx.dust.add(x, y + 0.1, z,
                    Math.cos(ang) * sp, 0.3 + Math.random() * 0.4, Math.sin(ang) * sp,
                    1.2 + Math.random() * 0.5, 0.5, 1.8, 0, 0.58, 0.58, 0.6, 0.6);
            }
        }

        dustAlongTrunk(f) {
            const fx = this.ensureFx();
            const e = f.entry;
            const H = TREE_HEIGHT * (e.s || 1);
            for (let i = 0; i < 26; i++) {
                const along = H * (0.1 + 0.9 * Math.random());
                const side = (Math.random() - 0.5) * 1.4 * (e.s || 1);
                const x = e.x + f.fx * along - f.fz * side, z = e.z + f.fz * along + f.fx * side;
                const gy = this.terrain.getHeightAt(x, z);
                fx.dust.add(x, gy + 0.15, z, (Math.random() - 0.5) * 0.8, 0.35 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8,
                    1.2 + Math.random() * 0.6, 0.5 + Math.random() * 0.5, 1.8, 0, 0.6, 0.54, 0.43, 0.5);
            }
        }

        // -----------------------------------------------------------
        // Per-frame
        // -----------------------------------------------------------
        update(delta) {
            if (this.disposed) return;
            if (this.autoSwap) {
                // give the previous hand item back ~1.2 s after the last tree/ore engagement ended
                const e = this.game.combat && this.game.combat.engagement;
                if (e && (e.kind === 'tree' || e.kind === 'ores')) this.toolIdle = 0;
                else if ((this.toolIdle = (this.toolIdle || 0) + delta) > 1.2) this.restoreTool();
            }
            this.checkTimer -= delta;
            if (this.checkTimer <= 0) {
                this.checkTimer = REGROW_CHECK;
                this.checkRegrow();
            }

            // Hit shakes: damped sway about the trunk base, away from the chopper
            if (this.shakes.size) {
                this.shakes.forEach((sh, id) => {
                    sh.t += delta;
                    if (sh.t >= SHAKE_TIME || sh.entry.visible === false) {
                        this.env.setObjectTransform(id, null);
                        this.shakes.delete(id);
                        return;
                    }
                    const u = sh.t / SHAKE_TIME;
                    const ang = Math.sin(sh.t * 38) * (1 - u) * (1 - u) * 0.035;
                    const e = sh.entry;
                    const bx = e.x, by = this.baseY(e), bz = e.z;
                    this._axis.set(sh.ax, 0, sh.az);
                    this._m.makeTranslation(-bx, -by, -bz);
                    this._m2.makeRotationAxis(this._axis, ang);
                    this._m.premultiply(this._m2);
                    this._m2.makeTranslation(bx, by, bz);
                    this._m.premultiply(this._m2);
                    this.env.setObjectTransform(id, this._m);
                });
            }

            // Regrowth scale-in
            if (this.regrowing.size) {
                this.regrowing.forEach((rg, id) => {
                    rg.t += delta;
                    const u = Math.min(1, rg.t / REGROW_TIME);
                    if (u >= 1) {
                        this.env.setObjectTransform(id, null);
                        this.regrowing.delete(id);
                        return;
                    }
                    const k = 1 - Math.pow(1 - u, 3);
                    this.applyScale(rg.entry, 0.02 + 0.98 * k);
                });
            }

            // Falling trees
            for (let i = this.falling.length - 1; i >= 0; i--) {
                const f = this.falling[i];
                f.t += delta;
                let ang, sink = 0;
                if (f.t < FALL_TIME) {
                    const u = f.t / FALL_TIME;
                    ang = FALL_ANGLE * Math.pow(u, 2.3); // accelerating fall
                } else {
                    if (!f.landed) {
                        f.landed = true;
                        this.spawnDrops(f);
                        this.dustAlongTrunk(f);
                        window.dispatchEvent(new CustomEvent('game:treeLanded', { detail: { id: f.entry.id } }));
                    }
                    const tb = f.t - FALL_TIME;
                    if (tb < BOUNCE_TIME) {
                        const u = tb / BOUNCE_TIME;
                        ang = FALL_ANGLE - Math.sin(u * Math.PI) * (1 - u * 0.5) * 0.09;
                    } else {
                        ang = FALL_ANGLE;
                        const ts = tb - BOUNCE_TIME - LIE_TIME;
                        if (ts > 0) sink = Math.min(1, ts / SINK_TIME);
                    }
                }
                f.pivot.quaternion.setFromAxisAngle(f.axis, ang);
                f.pivot.position.y = this.baseY(f.entry) - sink * 2.2 * (f.entry.s || 1);
                if (sink >= 1) {
                    this.root.remove(f.pivot);
                    f.pivot.children.forEach(im => im.dispose && im.dispose()); // geometry/material are shared with the forest
                    this.falling.splice(i, 1);
                }
            }

            if (this.fx && (this.fx.chips.n || this.fx.dust.n || this.fx.chips.points.visible || this.fx.dust.points.visible)) {
                const g = this.game;
                g.renderer.getDrawingBufferSize(this._bufSize);
                const scale = this._bufSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(g.camera.fov) / 2));
                this.fx.chips.update(delta, this.terrain, scale);
                this.fx.dust.update(delta, this.terrain, scale);
            }
        }

        // -----------------------------------------------------------
        // Tests / debug
        // -----------------------------------------------------------
        treeIds() {
            const out = [];
            if (this.env) this.env.objects.forEach(o => { if (o.kind === 'trees') out.push(o.id); });
            return out;
        }

        dispose() {
            if (this.autoSwap) this.restoreTool();
            this.disposed = true;
            // Pivots / points are under locationRoot -> freed by teardownLocation().
            this.falling.length = 0;
            this.shakes.clear();
            this.regrowing.clear();
            this.hits.clear();
            if (this.fx) {
                this.fx.chips.uniforms.uMap.value.dispose();
                this.fx.dust.uniforms.uMap.value.dispose();
            }
            this.fx = null;
        }
    }

    AveloraHarvest.TREE_HEIGHT = TREE_HEIGHT;
    window.AveloraHarvest = AveloraHarvest;
})();
