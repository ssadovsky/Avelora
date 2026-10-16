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
    const BARE_HANDS = Object.freeze({ id: null, name: 'Кулаки', damage: [1, 3], range: 1.2, cooldown: 0.9, chop: 0, mine: 0 });

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

        /** State slot an equippable item goes to: 'right' (hand) or item.json use.slot (head/cloak/body/hands/ring/feet). */
        equipSlot(id) {
            const def = this.get(id);
            return (def && def.use && def.use.type === 'equip' && def.use.slot) || 'right';
        },

        isEquippable(id) {
            const def = this.get(id);
            return !!(def && def.use && def.use.type === 'equip');
        },

        /**
         * Melee stats of an item (item.json `weapon`: {damage:[min,max], range (m),
         * cooldown (s), chop?, mine?}) or BARE_HANDS when the item has none / no item.
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
                chop: Number(w.chop) || 0,
                mine: Number(w.mine) || 0,
                style: w.style || null,
                stat: w.stat || null
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
        makeFallback(kind, id, def) {
            const mat = new THREE.MeshStandardMaterial({ color: 0x8a7f70, roughness: 0.9, metalness: 0.0 });
            let geo;
            if (kind === 'prop') {
                const svProp = this.makeSavannaProp(id, def);
                if (svProp) return svProp;
            }
            // prop.json "stub": { box:[w,h,d] | cyl:[rTop,rBottom,h], color:'#hex' } — заглушка нужного размера (меш потом нарисуем)
            if (def && def.stub && (def.stub.box || def.stub.cyl)) {
                if (def.stub.box) { geo = new THREE.BoxGeometry(def.stub.box[0], def.stub.box[1], def.stub.box[2]); geo.translate(0, def.stub.box[1] / 2, 0); }
                else { geo = new THREE.CylinderGeometry(def.stub.cyl[0], def.stub.cyl[1], def.stub.cyl[2], 16); geo.translate(0, def.stub.cyl[2] / 2, 0); }
                if (def.stub.color) mat.color.set(def.stub.color);
                const sm = new THREE.Mesh(geo, mat);
                sm.name = 'fallback';
                return sm;
            }
            if (kind === 'held' && id === 'staff') {
                const staffGroup = new THREE.Group();
                const shaftGeo = new THREE.CylinderGeometry(0.016, 0.024, 1.85, 8);
                shaftGeo.translate(0, 0.35, 0);
                const shaftMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.85, metalness: 0.05 });
                const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
                staffGroup.add(shaftMesh);

                // Золотое кольцо-оправа навершия
                const ringGeo = new THREE.TorusGeometry(0.045, 0.012, 6, 12);
                ringGeo.translate(0, 1.25, 0);
                const ringMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.35, metalness: 0.85 });
                const ringMesh = new THREE.Mesh(ringGeo, ringMat);
                staffGroup.add(ringMesh);

                // Ограненный кристалл маны с небесно-голубым свечением
                const gemGeo = new THREE.OctahedronGeometry(0.065, 0);
                gemGeo.translate(0, 1.29, 0);
                const gemMat = new THREE.MeshStandardMaterial({
                    color: 0x70d8ff,
                    emissive: 0x1a8cff,
                    emissiveIntensity: 0.9,
                    roughness: 0.15,
                    metalness: 0.1
                });
                const gemMesh = new THREE.Mesh(gemGeo, gemMat);
                staffGroup.add(gemMesh);

                staffGroup.name = 'staff';
                return staffGroup;
            } else if (kind === 'held') {
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
        },

        /**
         * Procedural 3D models for Savanna location props when no external model.glb is provided.
         * If content/props/<id>/model.glb is added later and built via build_assets.py,
         * world_objects.js automatically loads model.glb instead of this procedural mesh.
         */
        makeSavannaProp(id, def) {
            const SAVANNA_IDS = {
                waystone: 1, hermit_hut: 1, drying_rack: 1,
                elemental_obelisk: 1, elemental_altar_fire: 1, elemental_altar_water: 1,
                elemental_altar_stone: 1, elemental_altar_air: 1,
                lizard_tent: 1, lizard_totem: 1, lizard_banner: 1, bone_pile: 1
            };
            if (!SAVANNA_IDS[id]) return null;

            let seed = 1337;
            for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
            const rnd = () => {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };

            const makeTex = (drawFn, size = 256, repeatX = 1, repeatY = 1) => {
                const c = document.createElement('canvas');
                c.width = size; c.height = size;
                drawFn(c.getContext('2d'), size);
                const t = new THREE.CanvasTexture(c);
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.repeat.set(repeatX, repeatY);
                if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
                t.needsUpdate = true;
                return t;
            };

            const makeStoneTex = (baseHex, veinHex, rep = 2) => makeTex((ctx, S) => {
                ctx.fillStyle = baseHex;
                ctx.fillRect(0, 0, S, S);
                for (let i = 0; i < 900; i++) {
                    const x = rnd() * S, y = rnd() * S, r = 2 + rnd() * 14;
                    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,250,235,0.06)' : 'rgba(20,15,10,0.08)';
                    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
                }
                ctx.strokeStyle = veinHex || 'rgba(40,30,20,0.22)';
                for (let i = 0; i < 28; i++) {
                    ctx.lineWidth = 0.8 + rnd() * 1.8;
                    ctx.beginPath();
                    let x = rnd() * S, y = rnd() * S;
                    ctx.moveTo(x, y);
                    for (let s = 0; s < 4; s++) {
                        x += (rnd() - 0.5) * 45; y += (rnd() - 0.5) * 45;
                        ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }
            }, 256, rep, rep);

            const makeWoodTex = (baseR = 115, baseG = 82, baseB = 50) => makeTex((ctx, S) => {
                for (let y = 0; y < S; y++) {
                    const k = 0.88 + Math.sin(y * 0.18) * 0.06 + (rnd() - 0.5) * 0.08;
                    ctx.fillStyle = `rgb(${Math.round(baseR * k)},${Math.round(baseG * k)},${Math.round(baseB * k)})`;
                    ctx.fillRect(0, y, S, 1);
                }
                for (let i = 0; i < 160; i++) {
                    ctx.strokeStyle = `rgba(35,20,10,${0.08 + rnd() * 0.14})`;
                    ctx.lineWidth = 0.8 + rnd() * 1.5;
                    const x = rnd() * S, y = rnd() * S, len = 25 + rnd() * 90;
                    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (rnd() - 0.5) * 4); ctx.stroke();
                }
            }, 256, 1, 2);

            const makeThatchTex = () => makeTex((ctx, S) => {
                ctx.fillStyle = '#b58d47';
                ctx.fillRect(0, 0, S, S);
                for (let i = 0; i < 1400; i++) {
                    const x = rnd() * S, y = rnd() * S, len = 14 + rnd() * 28;
                    const shade = 0.72 + rnd() * 0.42;
                    ctx.strokeStyle = `rgb(${Math.round(190 * shade)},${Math.round(148 * shade)},${Math.round(72 * shade)})`;
                    ctx.lineWidth = 1.2 + rnd() * 1.6;
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(x + (rnd() - 0.5) * 6, y + len);
                    ctx.stroke();
                }
            }, 256, 3, 2);

            const makeHideTex = (withSpots = true) => makeTex((ctx, S) => {
                ctx.fillStyle = '#9c7448';
                ctx.fillRect(0, 0, S, S);
                for (let i = 0; i < 500; i++) {
                    ctx.fillStyle = rnd() > 0.5 ? 'rgba(235,200,150,0.06)' : 'rgba(60,38,18,0.07)';
                    ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, 4 + rnd() * 16, 0, Math.PI * 2); ctx.fill();
                }
                if (withSpots) {
                    for (let i = 0; i < 55; i++) {
                        ctx.fillStyle = `rgba(52,32,16,${0.35 + rnd() * 0.3})`;
                        ctx.beginPath();
                        ctx.ellipse(rnd() * S, rnd() * S, 4 + rnd() * 8, 3 + rnd() * 6, rnd() * Math.PI, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }, 256, 1, 1);

            const perturbGeo = (geo, ampXZ, ampY = 0) => {
                const pos = geo.attributes.position;
                const vMap = new Map();
                for (let i = 0; i < pos.count; i++) {
                    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
                    const key = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
                    let off = vMap.get(key);
                    if (!off) {
                        off = [(rnd() - 0.5) * 2 * ampXZ, (rnd() - 0.5) * 2 * ampY, (rnd() - 0.5) * 2 * ampXZ];
                        vMap.set(key, off);
                    }
                    pos.setXYZ(i, x + off[0], y + off[1], z + off[2]);
                }
                geo.computeVertexNormals();
                return geo;
            };

            const addMesh = (parent, geo, mat, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
                const m = new THREE.Mesh(geo, mat);
                m.position.set(px, py, pz);
                if (rx || ry || rz) m.rotation.set(rx, ry, rz);
                if (sx !== 1 || sy !== 1 || sz !== 1) m.scale.set(sx, sy, sz);
                m.castShadow = true;
                m.receiveShadow = true;
                parent.add(m);
                return m;
            };

            const addPoleBetween = (parent, mat, p0, p1, r0, r1, seg = 7) => {
                const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
                const len = Math.hypot(dx, dy, dz);
                if (len < 0.001) return null;
                const geo = new THREE.CylinderGeometry(r1, r0, len, seg);
                const m = new THREE.Mesh(geo, mat);
                m.position.set((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5, (p0[2] + p1[2]) * 0.5);
                const up = new THREE.Vector3(0, 1, 0);
                const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
                m.quaternion.setFromUnitVectors(up, dir);
                m.castShadow = true;
                m.receiveShadow = true;
                parent.add(m);
                return m;
            };

            const addBeastSkull = (parent, boneMat, hornMat, darkMat, px, py, pz, ry = 0, scale = 1.0) => {
                const g = new THREE.Group();
                g.position.set(px, py, pz);
                g.rotation.y = ry;
                g.scale.setScalar(scale);
                // Cranium + snout
                const cran = perturbGeo(new THREE.DodecahedronGeometry(0.18, 1), 0.02, 0.015);
                addMesh(g, cran, boneMat, 0, 0.14, -0.04, 0.2, 0, 0, 1.05, 0.82, 1.15);
                const snout = new THREE.CylinderGeometry(0.065, 0.12, 0.28, 7);
                addMesh(g, snout, boneMat, 0, 0.09, 0.14, Math.PI * 0.42, 0, 0, 0.95, 1.0, 0.75);
                // Eye sockets
                const eyeGeo = new THREE.SphereGeometry(0.045, 7, 6);
                addMesh(g, eyeGeo, darkMat, -0.09, 0.15, 0.04);
                addMesh(g, eyeGeo, darkMat, 0.09, 0.15, 0.04);
                // Curved horns
                for (const side of [-1, 1]) {
                    addPoleBetween(g, hornMat, [side * 0.11, 0.20, -0.06], [side * 0.28, 0.30, -0.10], 0.042, 0.026, 6);
                    addPoleBetween(g, hornMat, [side * 0.28, 0.30, -0.10], [side * 0.36, 0.42, 0.04], 0.026, 0.008, 6);
                }
                parent.add(g);
                return g;
            };

            const group = new THREE.Group();
            group.name = id;

            // -------------------------------------------------------
            // 1. WAYSTONE (Путевой камень у портала)
            // -------------------------------------------------------
            if (id === 'waystone') {
                const stoneTex = makeStoneTex('#a89274', 'rgba(65,48,30,0.28)', 2);
                const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.88, metalness: 0.04 });
                const darkStoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0x857258, roughness: 0.92, metalness: 0.02 });
                const runeMat = new THREE.MeshStandardMaterial({
                    color: 0xffc864, emissive: 0xd97b16, emissiveIntensity: 0.85, roughness: 0.3, metalness: 0.1
                });

                // Stepped sandstone base
                const base1 = perturbGeo(new THREE.CylinderGeometry(0.54, 0.62, 0.20, 8), 0.03, 0.01);
                addMesh(group, base1, darkStoneMat, 0, 0.10, 0);
                const base2 = perturbGeo(new THREE.CylinderGeometry(0.42, 0.50, 0.18, 8), 0.025, 0.01);
                addMesh(group, base2, stoneMat, 0, 0.28, 0, 0, 0.35, 0);

                // Tapered menhir monolith
                const shaft = perturbGeo(new THREE.CylinderGeometry(0.23, 0.37, 1.28, 7), 0.025, 0.02);
                addMesh(group, shaft, stoneMat, 0, 0.98, 0, 0.03, 0.2, -0.02);

                // Pointed cap stone
                const cap = perturbGeo(new THREE.ConeGeometry(0.25, 0.32, 7), 0.02, 0.015);
                addMesh(group, cap, stoneMat, 0, 1.76, 0, 0, 0.2, 0);

                // Carved collar band + glowing wayfinder runes on front & back
                const band = new THREE.CylinderGeometry(0.30, 0.31, 0.07, 8);
                addMesh(group, band, darkStoneMat, 0, 1.32, 0);
                for (const dir of [-1, 1]) {
                    const ring = new THREE.TorusGeometry(0.11, 0.018, 6, 14);
                    addMesh(group, ring, runeMat, 0, 1.05, dir * 0.275, 0, 0, 0);
                    const core = new THREE.OctahedronGeometry(0.055, 0);
                    addMesh(group, core, runeMat, 0, 1.05, dir * 0.285, 0, Math.PI / 4, 0);
                    const bar = new THREE.BoxGeometry(0.028, 0.42, 0.02);
                    addMesh(group, bar, runeMat, 0, 0.78, dir * 0.295, -dir * 0.08, 0, 0);
                }

                // Small scatter stones around base
                for (let i = 0; i < 5; i++) {
                    const a = (i / 5) * Math.PI * 2 + 0.4;
                    const r = 0.52 + (rnd() - 0.5) * 0.08;
                    const rk = perturbGeo(new THREE.DodecahedronGeometry(0.11 + rnd() * 0.05, 0), 0.02, 0.01);
                    addMesh(group, rk, darkStoneMat, Math.cos(a) * r, 0.07, Math.sin(a) * r, rnd(), rnd(), rnd(), 1.2, 0.75, 1.1);
                }
                return group;
            }

            // -------------------------------------------------------
            // 2. HERMIT HUT (Хижина Ящера-отшельника: 4.2 x 2.6 x 3.6 м)
            // -------------------------------------------------------
            if (id === 'hermit_hut') {
                const mudTex = makeStoneTex('#9e7b52', 'rgba(55,36,18,0.22)', 2);
                const thatchTex = makeThatchTex();
                const woodTex = makeWoodTex(105, 74, 44);
                const hideTex = makeHideTex(true);

                const mudMat = new THREE.MeshStandardMaterial({ map: mudTex, roughness: 0.94, metalness: 0.0 });
                const plinthMat = new THREE.MeshStandardMaterial({ map: mudTex, color: 0x7c6244, roughness: 0.95, metalness: 0.0 });
                const thatchMat = new THREE.MeshStandardMaterial({ map: thatchTex, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide });
                const thatchDarkMat = new THREE.MeshStandardMaterial({ map: thatchTex, color: 0xc9a35e, roughness: 0.94, metalness: 0.0 });
                const woodMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.88, metalness: 0.02 });
                const hideMat = new THREE.MeshStandardMaterial({ map: hideTex, roughness: 0.86, metalness: 0.0, side: THREE.DoubleSide });
                const darkInsideMat = new THREE.MeshStandardMaterial({ color: 0x18110b, roughness: 1.0, metalness: 0.0 });
                const boneMat = new THREE.MeshStandardMaterial({ color: 0xdfd5be, roughness: 0.75, metalness: 0.04 });
                const potMat = new THREE.MeshStandardMaterial({ color: 0xa65432, roughness: 0.78, metalness: 0.05 });

                // Earthen foundation rim (oval ~ 3.9 x 3.4 m)
                const baseGeo = perturbGeo(new THREE.CylinderGeometry(1.88, 2.02, 0.22, 16), 0.04, 0.01);
                addMesh(group, baseGeo, plinthMat, 0, 0.11, 0, 0, 0, 0, 1.04, 1.0, 0.88);

                // Circular adobe clay wall
                const wallGeo = perturbGeo(new THREE.CylinderGeometry(1.68, 1.78, 1.32, 16), 0.03, 0.015);
                addMesh(group, wallGeo, mudMat, 0, 0.84, 0, 0, 0, 0, 1.04, 1.0, 0.88);

                // Exterior crooked acacia support posts & horizontal wattle bands
                const numPosts = 10;
                for (let i = 0; i < numPosts; i++) {
                    const ang = (i / numPosts) * Math.PI * 2;
                    // Leave front doorway gap around ang ~ 0 (+Z)
                    if (Math.abs(Math.sin(ang)) < 0.34 && Math.cos(ang) > 0.7) continue;
                    const px = Math.sin(ang) * 1.78 * 1.03;
                    const pz = Math.cos(ang) * 1.78 * 0.87;
                    addPoleBetween(group, woodMat,
                        [px * 1.03, 0.05, pz * 1.03],
                        [px * 0.95, 1.52, pz * 0.95],
                        0.065, 0.05, 6);
                }

                // Front arched doorway (+Z side) with dark interior recess, door posts, lintel, and awning
                addMesh(group, new THREE.BoxGeometry(0.86, 1.18, 0.24), darkInsideMat, 0, 0.72, 1.46);
                addPoleBetween(group, woodMat, [-0.48, 0.08, 1.54], [-0.44, 1.38, 1.48], 0.075, 0.06, 7);
                addPoleBetween(group, woodMat, [0.48, 0.08, 1.54], [0.44, 1.38, 1.48], 0.075, 0.06, 7);
                addPoleBetween(group, woodMat, [-0.62, 1.34, 1.54], [0.62, 1.34, 1.54], 0.065, 0.065, 7);
                // Threshold flat stone step
                addMesh(group, perturbGeo(new THREE.BoxGeometry(1.05, 0.14, 0.46), 0.02, 0.01), plinthMat, 0, 0.07, 1.68);
                // Slanted front hide awning over entrance supported by 2 forward poles
                addPoleBetween(group, woodMat, [-0.68, 0.02, 2.02], [-0.58, 1.24, 1.96], 0.045, 0.038, 6);
                addPoleBetween(group, woodMat, [0.68, 0.02, 2.02], [0.58, 1.24, 1.96], 0.045, 0.038, 6);
                addPoleBetween(group, woodMat, [-0.64, 1.22, 1.98], [0.64, 1.22, 1.98], 0.04, 0.04, 6);
                const awningGeo = new THREE.PlaneGeometry(1.28, 0.68, 4, 2);
                addMesh(group, awningGeo, hideMat, 0, 1.32, 1.76, -1.25, 0, 0);

                // 3-tier conical savanna straw thatch roof (total height ~ 2.68 m)
                const tier1 = perturbGeo(new THREE.ConeGeometry(2.18, 0.72, 18, 2, true), 0.04, 0.03);
                addMesh(group, tier1, thatchMat, 0, 1.62, 0, 0, 0.1, 0, 1.04, 1.0, 0.90);
                const tier2 = perturbGeo(new THREE.ConeGeometry(1.72, 0.70, 16, 2, true), 0.035, 0.025);
                addMesh(group, tier2, thatchDarkMat, 0, 1.98, 0, 0, 0.3, 0, 1.03, 1.0, 0.90);
                const tier3 = perturbGeo(new THREE.ConeGeometry(1.12, 0.68, 14, 2), 0.03, 0.02);
                addMesh(group, tier3, thatchMat, 0, 2.34, 0, 0, 0.5, 0, 1.02, 1.0, 0.90);

                // Roof rafters jutting from apex & eaves + skull trophy over door
                for (let i = 0; i < 8; i++) {
                    const a = (i / 8) * Math.PI * 2 + 0.2;
                    const ex = Math.sin(a) * 2.22 * 1.03;
                    const ez = Math.cos(a) * 2.22 * 0.89;
                    addPoleBetween(group, woodMat, [ex, 1.22, ez], [-Math.sin(a) * 0.18, 2.76, -Math.cos(a) * 0.18], 0.038, 0.025, 5);
                }
                addBeastSkull(group, boneMat, woodMat, darkInsideMat, 0, 1.48, 1.58, 0, 0.85);

                // Clay amphora pots & firewood by the side wall
                const potBody = new THREE.CylinderGeometry(0.12, 0.16, 0.38, 10);
                addMesh(group, potBody, potMat, -1.35, 0.19, 1.32);
                const potNeck = new THREE.CylinderGeometry(0.08, 0.06, 0.12, 10);
                addMesh(group, potNeck, potMat, -1.35, 0.42, 1.32);
                const pot2 = new THREE.SphereGeometry(0.18, 10, 8);
                addMesh(group, pot2, potMat, -1.08, 0.16, 1.48, 0, 0, 0, 1.0, 0.9, 1.0);
                return group;
            }

            // -------------------------------------------------------
            // 3. DRYING RACK (Вешала для шкур: 2.2 x 1.6 x 0.35 м)
            // -------------------------------------------------------
            if (id === 'drying_rack') {
                const woodMat = new THREE.MeshStandardMaterial({ map: makeWoodTex(118, 84, 52), roughness: 0.88, metalness: 0.02 });
                const ropeMat = new THREE.MeshStandardMaterial({ color: 0xc2a26e, roughness: 0.92, metalness: 0.0 });
                const hideMat = new THREE.MeshStandardMaterial({ map: makeHideTex(true), roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
                const meatMat = new THREE.MeshStandardMaterial({ color: 0x6e261a, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide });

                // Left and right A-frame bipod legs + top crossbar + lower brace
                for (const side of [-1, 1]) {
                    const x0 = side * 1.02;
                    addPoleBetween(group, woodMat, [x0 - side * 0.06, 0.0, 0.24], [x0, 1.66, -0.04], 0.048, 0.036, 7);
                    addPoleBetween(group, woodMat, [x0 + side * 0.04, 0.0, -0.24], [x0, 1.66, 0.04], 0.046, 0.035, 7);
                    // Lashing ring at A-frame apex
                    const lash = new THREE.TorusGeometry(0.055, 0.018, 6, 10);
                    addMesh(group, lash, ropeMat, x0, 1.52, 0, Math.PI / 2, 0, 0);
                }
                // Main top ridge pole & bottom horizontal pole
                addPoleBetween(group, woodMat, [-1.18, 1.54, 0], [1.18, 1.54, 0], 0.046, 0.042, 8);
                addPoleBetween(group, woodMat, [-1.05, 0.28, 0.02], [1.05, 0.28, 0.02], 0.036, 0.034, 7);

                // Stretched animal pelt with irregular hide silhouette (7x7 grid deformed into hide with 4 leg corners)
                const hideGeo = new THREE.PlaneGeometry(1.36, 1.02, 8, 8);
                const hp = hideGeo.attributes.position;
                for (let i = 0; i < hp.count; i++) {
                    let x = hp.getX(i), y = hp.getY(i);
                    const nx = x / 0.68, ny = y / 0.51; // -1..1
                    // Waist pinch in the middle, flared leg corners at diagonals
                    const corner = Math.abs(nx) * Math.abs(ny);
                    const waist = (1 - Math.abs(ny) * 0.8) * 0.16;
                    const neck = (1 - Math.abs(nx) * 1.2) * 0.10;
                    x *= (1.0 - waist + corner * 0.22);
                    y *= (1.0 - neck + corner * 0.18);
                    const z = Math.sin(nx * 2.2) * 0.025 + Math.cos(ny * 2.5) * 0.02;
                    hp.setXYZ(i, x, y, z);
                }
                hideGeo.computeVertexNormals();
                addMesh(group, hideGeo, hideMat, -0.18, 0.92, 0.01);

                // Tension cords tying the 6 hide points to the wooden frame
                const tiePairs = [
                    [[-0.78, 1.38, 0.01], [-0.96, 1.52, 0]],
                    [[0.42, 1.38, 0.01], [0.60, 1.52, 0]],
                    [[-0.18, 1.36, 0.01], [-0.18, 1.54, 0]],
                    [[-0.78, 0.46, 0.01], [-0.98, 0.30, 0.02]],
                    [[0.42, 0.46, 0.01], [0.60, 0.30, 0.02]],
                    [[-0.82, 0.92, 0.01], [-1.02, 0.94, 0]]
                ];
                tiePairs.forEach(([a, b]) => addPoleBetween(group, ropeMat, a, b, 0.008, 0.008, 4));

                // Two cured jerky / small pelt strips hanging on the right side of the rack
                for (let k = 0; k < 2; k++) {
                    const sx = 0.68 + k * 0.22;
                    addPoleBetween(group, ropeMat, [sx, 1.54, 0], [sx, 1.34, 0], 0.009, 0.009, 4);
                    const strip = perturbGeo(new THREE.CylinderGeometry(0.04, 0.06, 0.56, 6), 0.012, 0.01);
                    addMesh(group, strip, k === 0 ? meatMat : hideMat, sx, 1.08, 0, 0, k * 0.7, 0.05, 1.2, 1.0, 0.35);
                }
                return group;
            }

            // -------------------------------------------------------
            // 4. ELEMENTAL OBELISK (Обелиск стихий: h ~ 4.7 м)
            // -------------------------------------------------------
            if (id === 'elemental_obelisk') {
                const stoneTex = makeStoneTex('#726d66', 'rgba(30,26,22,0.3)', 2);
                const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.85, metalness: 0.08 });
                const darkMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0x4f4b46, roughness: 0.9, metalness: 0.1 });
                const goldMat = new THREE.MeshStandardMaterial({ color: 0xc9a048, roughness: 0.38, metalness: 0.78 });

                // Two-stepped octagonal/square sanctuary pedestal
                addMesh(group, perturbGeo(new THREE.CylinderGeometry(1.05, 1.16, 0.32, 8), 0.02, 0.01), darkMat, 0, 0.16, 0, 0, Math.PI / 8, 0);
                addMesh(group, perturbGeo(new THREE.BoxGeometry(1.36, 0.36, 1.36), 0.015, 0.01), stoneMat, 0, 0.50, 0);
                addMesh(group, new THREE.BoxGeometry(1.14, 0.16, 1.14), darkMat, 0, 0.76, 0);

                // 4 corner bollards on the base
                for (const sx of [-0.62, 0.62]) {
                    for (const sz of [-0.62, 0.62]) {
                        addMesh(group, new THREE.BoxGeometry(0.22, 0.52, 0.22), darkMat, sx, 0.54, sz);
                        addMesh(group, new THREE.ConeGeometry(0.16, 0.16, 4), goldMat, sx, 0.88, sz, 0, Math.PI / 4, 0);
                    }
                }

                // Tall tapered 4-sided obelisk shaft (y = 0.84 .. 4.14 m)
                const shaftGeo = perturbGeo(new THREE.CylinderGeometry(0.38, 0.64, 3.30, 4), 0.015, 0.01);
                addMesh(group, shaftGeo, stoneMat, 0, 2.49, 0, 0, Math.PI / 4, 0);

                // Carved collar bands along the shaft
                addMesh(group, new THREE.BoxGeometry(0.84, 0.10, 0.84), goldMat, 0, 1.45, 0);
                addMesh(group, new THREE.BoxGeometry(0.68, 0.09, 0.68), goldMat, 0, 2.95, 0);
                addMesh(group, new THREE.BoxGeometry(0.58, 0.08, 0.58), goldMat, 0, 4.12, 0);

                // Pyramidion cap (y = 4.14 .. 4.74 m) + floating prismatic elemental crystal
                const capGeo = new THREE.ConeGeometry(0.40, 0.62, 4);
                addMesh(group, capGeo, darkMat, 0, 4.45, 0, 0, Math.PI / 4, 0);
                const topGemMat = new THREE.MeshStandardMaterial({
                    color: 0xffffff, emissive: 0x66ccff, emissiveIntensity: 0.95, roughness: 0.15, metalness: 0.2
                });
                addMesh(group, new THREE.OctahedronGeometry(0.18, 0), topGemMat, 0, 4.95, 0);

                // 4 Elemental Rune channels on the 4 cardinal faces matching the 4 altars:
                // -Z = Fire, +X = Stone, +Z = Water, -X = Air
                const faces = [
                    { nx: 0, nz: -1, ry: 0, col: 0xff5722 },
                    { nx: 1, nz: 0, ry: Math.PI / 2, col: 0xffb300 },
                    { nx: 0, nz: 1, ry: Math.PI, col: 0x00bcd4 },
                    { nx: -1, nz: 0, ry: -Math.PI / 2, col: 0xb3e5fc }
                ];
                faces.forEach(f => {
                    const rMat = new THREE.MeshStandardMaterial({
                        color: f.col, emissive: f.col, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.1
                    });
                    // Vertical rune strip tilted slightly with the obelisk taper (~0.055 rad)
                    const strip = new THREE.BoxGeometry(0.06, 2.25, 0.025);
                    addMesh(group, strip, rMat, f.nx * 0.365, 2.48, f.nz * 0.365, f.nz * 0.055, f.ry, -f.nx * 0.055);
                    // Elemental diamond sigil at chest height
                    const sigil = new THREE.OctahedronGeometry(0.11, 0);
                    addMesh(group, sigil, rMat, f.nx * 0.43, 1.85, f.nz * 0.43, 0, f.ry, 0, 1.0, 1.3, 0.35);
                });
                return group;
            }

            // -------------------------------------------------------
            // 5. FOUR ELEMENTAL ALTARS (Алтари Огня, Воды, Камня, Воздуха: 1.7 x 1.7 м)
            // -------------------------------------------------------
            if (id.indexOf('elemental_altar_') === 0) {
                const elem = id.replace('elemental_altar_', ''); // fire | water | stone | air
                const cfg = {
                    fire:  { stone: '#5e3c32', dark: 0x3b231c, glow: 0xff4518, accent: 0xd97724 },
                    water: { stone: '#4c6b78', dark: 0x2f4854, glow: 0x18c5ff, accent: 0x66e0ff },
                    stone: { stone: '#7a7264', dark: 0x544d42, glow: 0xf5a623, accent: 0x8bc34a },
                    air:   { stone: '#cfd8dc', dark: 0x9aa7ad, glow: 0x9be7ff, accent: 0xe1f5fe }
                }[elem] || { stone: '#77736b', dark: 0x55524c, glow: 0xffaa00, accent: 0xffffff };

                const stoneTex = makeStoneTex(cfg.stone, 'rgba(20,15,10,0.28)', 2);
                const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.86, metalness: 0.06 });
                const darkMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: cfg.dark, roughness: 0.9, metalness: 0.08 });
                const glowMat = new THREE.MeshStandardMaterial({
                    color: cfg.glow, emissive: cfg.glow, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.15
                });
                const accentMat = new THREE.MeshStandardMaterial({
                    color: cfg.accent, emissive: cfg.glow, emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.3
                });

                // Shared sacred 2-stepped altar base (1.72 x 1.72 m footprint, altar table y = 0.88 m)
                addMesh(group, perturbGeo(new THREE.BoxGeometry(1.72, 0.22, 1.72), 0.02, 0.01), darkMat, 0, 0.11, 0);
                addMesh(group, perturbGeo(new THREE.BoxGeometry(1.40, 0.22, 1.40), 0.015, 0.01), stoneMat, 0, 0.33, 0);
                addMesh(group, perturbGeo(new THREE.BoxGeometry(1.08, 0.36, 1.08), 0.012, 0.01), darkMat, 0, 0.62, 0);
                addMesh(group, perturbGeo(new THREE.BoxGeometry(1.26, 0.14, 1.26), 0.012, 0.008), stoneMat, 0, 0.85, 0);

                // 4 carved corner horns + glowing side runes on pedestal
                for (const sx of [-0.56, 0.56]) {
                    for (const sz of [-0.56, 0.56]) {
                        addPoleBetween(group, darkMat, [sx, 0.44, sz], [sx * 1.12, 1.04, sz * 1.12], 0.09, 0.04, 5);
                        addMesh(group, new THREE.OctahedronGeometry(0.055, 0), glowMat, sx * 1.12, 1.06, sz * 1.12);
                    }
                }
                for (let side = 0; side < 4; side++) {
                    const a = side * Math.PI / 2;
                    addMesh(group, new THREE.BoxGeometry(0.36, 0.08, 0.03), glowMat,
                        Math.sin(a) * 0.545, 0.62, Math.cos(a) * 0.545, 0, a, 0);
                }

                // Unique Elemental Centerpiece on top of the altar (y >= 0.92 m)
                if (elem === 'fire') {
                    // Forged bronze brazier bowl with glowing coals (AveloraFire flames spawn at y=0.98)
                    const bowl = new THREE.CylinderGeometry(0.48, 0.28, 0.22, 12);
                    addMesh(group, bowl, darkMat, 0, 0.98, 0);
                    const coals = perturbGeo(new THREE.SphereGeometry(0.38, 10, 8), 0.03, 0.025);
                    addMesh(group, coals, glowMat, 0, 1.02, 0, 0, 0, 0, 1.0, 0.35, 1.0);
                    for (let i = 0; i < 6; i++) {
                        const a = (i / 6) * Math.PI * 2;
                        const shard = new THREE.ConeGeometry(0.06, 0.24, 5);
                        addMesh(group, shard, darkMat, Math.cos(a) * 0.42, 1.12, Math.sin(a) * 0.42,
                            Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
                    }
                } else if (elem === 'water') {
                    // Carved stone water font + translucent turquoise pool + aquamarine spires
                    const rim = new THREE.TorusGeometry(0.46, 0.08, 8, 18);
                    addMesh(group, rim, stoneMat, 0, 0.95, 0, Math.PI / 2, 0, 0);
                    const poolMat = new THREE.MeshStandardMaterial({
                        color: 0x18b8e8, emissive: 0x0a6c8c, emissiveIntensity: 0.6, roughness: 0.12, metalness: 0.1
                    });
                    addMesh(group, new THREE.CylinderGeometry(0.43, 0.43, 0.05, 16), poolMat, 0, 0.95, 0);
                    // Rising water crystals
                    addMesh(group, new THREE.CylinderGeometry(0.02, 0.11, 0.58, 6), glowMat, 0, 1.24, 0);
                    for (let i = 0; i < 3; i++) {
                        const a = (i / 3) * Math.PI * 2 + 0.5;
                        addMesh(group, new THREE.CylinderGeometry(0.015, 0.075, 0.38, 6), accentMat,
                            Math.cos(a) * 0.16, 1.12, Math.sin(a) * 0.16, Math.sin(a) * 0.28, 0, -Math.cos(a) * 0.28);
                    }
                } else if (elem === 'stone') {
                    // Craggy boulder mound + cluster of 5 jagged amber-earth quartz crystals
                    const mound = perturbGeo(new THREE.DodecahedronGeometry(0.38, 1), 0.04, 0.03);
                    addMesh(group, mound, darkMat, 0, 0.98, 0, 0, 0, 0, 1.15, 0.55, 1.15);
                    addMesh(group, new THREE.CylinderGeometry(0.03, 0.14, 0.72, 6), glowMat, 0, 1.32, 0, 0.06, 0.2, -0.05);
                    const angles = [0.2, 1.5, 2.8, 4.1, 5.3];
                    angles.forEach((a, idx) => {
                        const h = 0.36 + (idx % 2) * 0.14;
                        addMesh(group, new THREE.CylinderGeometry(0.02, 0.09, h, 6), idx % 2 ? glowMat : accentMat,
                            Math.cos(a) * 0.22, 1.05 + h * 0.4, Math.sin(a) * 0.22,
                            Math.sin(a) * 0.38, a, -Math.cos(a) * 0.38);
                    });
                } else if (elem === 'air') {
                    // 4 arched wind pillars + 2 intersecting silver wind rings + levitating sky crystal
                    for (let i = 0; i < 4; i++) {
                        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
                        addPoleBetween(group, stoneMat,
                            [Math.cos(a) * 0.38, 0.90, Math.sin(a) * 0.38],
                            [Math.cos(a) * 0.20, 1.38, Math.sin(a) * 0.20], 0.055, 0.035, 6);
                    }
                    const ringGeo = new THREE.TorusGeometry(0.30, 0.022, 8, 20);
                    addMesh(group, ringGeo, accentMat, 0, 1.38, 0, 0.65, 0.3, 0);
                    addMesh(group, ringGeo, accentMat, 0, 1.38, 0, -0.65, -0.3, 0);
                    addMesh(group, new THREE.OctahedronGeometry(0.16, 0), glowMat, 0, 1.38, 0, 0, Math.PI / 4, 0, 0.85, 1.35, 0.85);
                }
                return group;
            }

            // -------------------------------------------------------
            // 6. LIZARD TENT (Шатёр ящеров: 3.6 x 2.2 x 3.2 м)
            // -------------------------------------------------------
            if (id === 'lizard_tent') {
                const hideTex = makeTex((ctx, S) => {
                    ctx.fillStyle = '#825f3a';
                    ctx.fillRect(0, 0, S, S);
                    // Stitched leather panels + crimson war stripes
                    ctx.fillStyle = 'rgba(130,36,24,0.65)';
                    ctx.fillRect(0, S * 0.18, S, S * 0.12);
                    ctx.fillRect(0, S * 0.68, S, S * 0.08);
                    for (let i = 0; i < 600; i++) {
                        ctx.fillStyle = rnd() > 0.5 ? 'rgba(240,205,155,0.06)' : 'rgba(40,22,10,0.08)';
                        ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, 3 + rnd() * 14, 0, Math.PI * 2); ctx.fill();
                    }
                }, 256, 2, 1);

                const hideMat = new THREE.MeshStandardMaterial({ map: hideTex, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide });
                const woodMat = new THREE.MeshStandardMaterial({ map: makeWoodTex(95, 66, 38), roughness: 0.88, metalness: 0.02 });
                const boneMat = new THREE.MeshStandardMaterial({ color: 0xded3ba, roughness: 0.75, metalness: 0.04 });
                const darkMat = new THREE.MeshStandardMaterial({ color: 0x16100b, roughness: 1.0, metalness: 0.0 });

                // Main A-frame wooden ridge structure (width X=3.5m, depth Z=3.1m, height Y=2.25m)
                // Ridge beam along Z
                addPoleBetween(group, woodMat, [0, 2.15, -1.68], [0, 2.22, 1.72], 0.065, 0.06, 7);
                // Front & back crossed A-frame poles jutting out above the ridge
                for (const zSide of [-1.42, 1.42]) {
                    addPoleBetween(group, woodMat, [-1.72, 0.0, zSide], [0.22, 2.48, zSide], 0.06, 0.04, 7);
                    addPoleBetween(group, woodMat, [1.72, 0.0, zSide], [-0.22, 2.48, zSide], 0.06, 0.04, 7);
                }
                // Middle diagonal ribs + staked pegs
                for (const zMid of [-0.48, 0.48]) {
                    for (const xSide of [-1, 1]) {
                        addPoleBetween(group, woodMat, [xSide * 1.76, 0.0, zMid], [0, 2.16, zMid], 0.048, 0.038, 6);
                        addPoleBetween(group, woodMat, [xSide * 1.84, 0.0, zMid], [xSide * 1.72, 0.34, zMid], 0.035, 0.025, 5);
                    }
                }

                // Stretched pitched hide canopy panels (left slope, right slope)
                const slopeLen = Math.hypot(1.70, 2.15);
                const slopeAng = Math.atan2(1.70, 2.15);
                for (const side of [-1, 1]) {
                    const panel = perturbGeo(new THREE.BoxGeometry(0.03, slopeLen, 2.95, 1, 6, 6), 0.015, 0.015);
                    addMesh(group, panel, hideMat, side * 0.85, 1.08, 0, 0, 0, side * slopeAng);
                }
                // Dark interior shadow block so tent looks occupied and deep from outside
                const innerGeo = new THREE.ConeGeometry(1.45, 2.0, 4);
                addMesh(group, innerGeo, darkMat, 0, 1.0, -0.08, 0, Math.PI / 4, 0, 1.05, 1.0, 1.25);

                // Horned lizard skull trophy mounted above the front tent peak (+Z)
                addBeastSkull(group, boneMat, boneMat, darkMat, 0, 2.02, 1.56, 0, 0.95);
                return group;
            }

            // -------------------------------------------------------
            // 7. LIZARD TOTEM (Тотем ящеров: h ~ 3.45 м)
            // -------------------------------------------------------
            if (id === 'lizard_totem') {
                const woodMat = new THREE.MeshStandardMaterial({ map: makeWoodTex(92, 62, 36), roughness: 0.86, metalness: 0.03 });
                const paintRedMat = new THREE.MeshStandardMaterial({ color: 0x94291c, roughness: 0.78, metalness: 0.05 });
                const paintGoldMat = new THREE.MeshStandardMaterial({ color: 0xd49b35, roughness: 0.55, metalness: 0.35 });
                const stoneMat = new THREE.MeshStandardMaterial({ map: makeStoneTex('#7a6b58', null, 1), roughness: 0.9, metalness: 0.02 });
                const boneMat = new THREE.MeshStandardMaterial({ color: 0xe3d8c0, roughness: 0.72, metalness: 0.04 });
                const eyeGlowMat = new THREE.MeshStandardMaterial({
                    color: 0xff3b14, emissive: 0xff2200, emissiveIntensity: 1.1, roughness: 0.2, metalness: 0.1
                });

                // Stone cairn base + 3 small skulls at the foot
                addMesh(group, perturbGeo(new THREE.CylinderGeometry(0.48, 0.64, 0.36, 9), 0.03, 0.015), stoneMat, 0, 0.18, 0);
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2;
                    const rk = perturbGeo(new THREE.DodecahedronGeometry(0.16, 0), 0.02, 0.01);
                    addMesh(group, rk, stoneMat, Math.cos(a) * 0.52, 0.14, Math.sin(a) * 0.52, a, i, 0, 1.2, 0.8, 1.1);
                }

                // Main carved wooden totem trunk (y = 0.30 .. 3.15 m)
                const trunk = perturbGeo(new THREE.CylinderGeometry(0.22, 0.34, 2.85, 8), 0.018, 0.01);
                addMesh(group, trunk, woodMat, 0, 1.72, 0);

                // Painted tribal rings & jutting bone tusks at 3 tiers
                [0.95, 1.75, 2.55].forEach((ty, idx) => {
                    addMesh(group, new THREE.CylinderGeometry(0.31 - idx * 0.02, 0.32 - idx * 0.02, 0.14, 8),
                        idx % 2 === 0 ? paintRedMat : paintGoldMat, 0, ty, 0);
                    for (const side of [-1, 1]) {
                        addPoleBetween(group, boneMat,
                            [side * 0.22, ty, 0.04],
                            [side * (0.58 - idx * 0.04), ty + 0.24, 0.12],
                            0.055, 0.012, 6);
                    }
                });

                // Middle carved tribal shield/mask on front (+Z)
                const maskGeo = perturbGeo(new THREE.CylinderGeometry(0.34, 0.26, 0.65, 6), 0.015, 0.01);
                addMesh(group, maskGeo, paintRedMat, 0, 1.85, 0.14, 0, 0, 0, 1.1, 1.0, 0.55);
                addMesh(group, new THREE.SphereGeometry(0.05, 7, 6), eyeGlowMat, -0.11, 1.96, 0.30);
                addMesh(group, new THREE.SphereGeometry(0.05, 7, 6), eyeGlowMat, 0.11, 1.96, 0.30);

                // Top sculpted horned reptile effigy head + crown of feathers/spikes (y = 2.95 .. 3.48 m)
                addBeastSkull(group, boneMat, boneMat, eyeGlowMat, 0, 2.98, 0.06, 0, 1.45);
                for (let i = -2; i <= 2; i++) {
                    const ang = i * 0.28;
                    addPoleBetween(group, i % 2 === 0 ? paintRedMat : paintGoldMat,
                        [Math.sin(ang) * 0.12, 3.12, -0.08],
                        [Math.sin(ang) * 0.42, 3.48 - Math.abs(i) * 0.05, -0.14],
                        0.032, 0.01, 5);
                }
                return group;
            }

            // -------------------------------------------------------
            // 8. LIZARD BANNER (Знамя ящеров: h ~ 3.1 м)
            // -------------------------------------------------------
            if (id === 'lizard_banner') {
                const woodMat = new THREE.MeshStandardMaterial({ map: makeWoodTex(90, 60, 34), roughness: 0.86, metalness: 0.03 });
                const stoneMat = new THREE.MeshStandardMaterial({ color: 0x736452, roughness: 0.92, metalness: 0.02 });
                const boneMat = new THREE.MeshStandardMaterial({ color: 0xe0d5be, roughness: 0.74, metalness: 0.04 });
                const ironMat = new THREE.MeshStandardMaterial({ color: 0x4a4642, roughness: 0.45, metalness: 0.75 });

                const bannerTex = makeTex((ctx, S) => {
                    ctx.fillStyle = '#7c2418';
                    ctx.fillRect(0, 0, S, S);
                    // Ochre borders
                    ctx.fillStyle = '#c98a2c';
                    ctx.fillRect(10, 0, 14, S);
                    ctx.fillRect(S - 24, 0, 14, S);
                    ctx.fillRect(0, 14, S, 16);
                    // Tribal lizard-sun emblem in center
                    ctx.strokeStyle = '#e6b84c';
                    ctx.fillStyle = '#e6b84c';
                    ctx.lineWidth = 8;
                    ctx.beginPath(); ctx.arc(S / 2, S * 0.44, 44, 0, Math.PI * 2); ctx.stroke();
                    for (let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2;
                        ctx.beginPath();
                        ctx.moveTo(S / 2 + Math.cos(a) * 48, S * 0.44 + Math.sin(a) * 48);
                        ctx.lineTo(S / 2 + Math.cos(a) * 70, S * 0.44 + Math.sin(a) * 70);
                        ctx.stroke();
                    }
                    // Slit reptile eye in the sun
                    ctx.beginPath();
                    ctx.ellipse(S / 2, S * 0.44, 10, 30, 0, 0, Math.PI * 2);
                    ctx.fill();
                }, 256, 1, 1);
                const clothMat = new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide });

                // Base stone socket + tall wooden spear pole (3.05 m)
                addMesh(group, perturbGeo(new THREE.CylinderGeometry(0.18, 0.26, 0.22, 8), 0.02, 0.01), stoneMat, 0, 0.11, 0);
                addPoleBetween(group, woodMat, [0, 0.0, 0], [0, 2.98, 0], 0.045, 0.032, 8);
                // Spearhead finial at top
                addMesh(group, new THREE.ConeGeometry(0.055, 0.26, 4), ironMat, 0, 3.08, 0);

                // Horizontal crossbar at y = 2.62 m with curved bone horn tips
                addPoleBetween(group, woodMat, [-0.46, 2.62, 0.04], [0.46, 2.62, 0.04], 0.032, 0.032, 7);
                addPoleBetween(group, boneMat, [-0.46, 2.62, 0.04], [-0.58, 2.74, 0.06], 0.028, 0.008, 5);
                addPoleBetween(group, boneMat, [0.46, 2.62, 0.04], [0.58, 2.74, 0.06], 0.028, 0.008, 5);

                // Draped war banner cloth (y = 0.85 .. 2.60 m) with wind curve & tattered bottom
                const clothGeo = new THREE.PlaneGeometry(0.76, 1.72, 6, 10);
                const cp = clothGeo.attributes.position;
                for (let i = 0; i < cp.count; i++) {
                    const x = cp.getX(i), y = cp.getY(i); // y in -0.86..+0.86
                    const t = (0.86 - y) / 1.72; // 0 at top crossbar, 1 at bottom hem
                    const wave = Math.sin(t * Math.PI * 1.4 + x * 2.0) * 0.07 * t;
                    // Tattered V-notches along bottom edge
                    const notch = t > 0.88 ? Math.sin(x * 14.0) * 0.10 * ((t - 0.88) / 0.12) : 0;
                    cp.setXYZ(i, x, y + notch, wave);
                }
                clothGeo.computeVertexNormals();
                addMesh(group, clothGeo, clothMat, 0, 1.74, 0.06);
                return group;
            }

            // -------------------------------------------------------
            // 9. BONE PILE (Груда костей: 1.4 x 0.5 x 1.1 м)
            // -------------------------------------------------------
            if (id === 'bone_pile') {
                const boneMat = new THREE.MeshStandardMaterial({ color: 0xe3dac3, roughness: 0.76, metalness: 0.03 });
                const oldBoneMat = new THREE.MeshStandardMaterial({ color: 0xc9be9f, roughness: 0.84, metalness: 0.02 });
                const hornMat = new THREE.MeshStandardMaterial({ color: 0x5c4a38, roughness: 0.80, metalness: 0.05 });
                const dirtMat = new THREE.MeshStandardMaterial({ map: makeStoneTex('#9e8258', null, 1), roughness: 0.96, metalness: 0.0 });
                const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c150e, roughness: 1.0, metalness: 0.0 });

                // Low sandy-earth mound under the bones
                const mound = perturbGeo(new THREE.CylinderGeometry(0.55, 0.68, 0.12, 12), 0.04, 0.015);
                addMesh(group, mound, dirtMat, 0, 0.06, 0, 0, 0, 0, 1.05, 1.0, 0.82);

                // Spine ridge + 8 curved ribs arching up to y ~ 0.48 m
                addPoleBetween(group, oldBoneMat, [-0.42, 0.12, -0.05], [0.32, 0.18, 0.04], 0.045, 0.035, 6);
                for (let i = 0; i < 4; i++) {
                    const bx = -0.34 + i * 0.19;
                    for (const side of [-1, 1]) {
                        const midZ = side * (0.22 + (i % 2) * 0.04);
                        const endZ = side * (0.36 + (i % 2) * 0.05);
                        const topY = 0.38 + (i === 1 || i === 2 ? 0.08 : 0);
                        addPoleBetween(group, boneMat, [bx, 0.14, 0], [bx + 0.03, topY, midZ], 0.028, 0.024, 6);
                        addPoleBetween(group, boneMat, [bx + 0.03, topY, midZ], [bx + 0.06, 0.08, endZ], 0.024, 0.012, 6);
                    }
                }

                // Large horned beast skull on the right + scattered femurs
                addBeastSkull(group, boneMat, hornMat, darkMat, 0.36, 0.08, 0.12, 0.85, 1.15);
                const scatterBones = [
                    [[-0.52, 0.07, 0.24], [-0.12, 0.11, 0.36]],
                    [[-0.46, 0.07, -0.28], [0.02, 0.09, -0.34]],
                    [[0.12, 0.07, -0.32], [0.54, 0.08, -0.18]]
                ];
                scatterBones.forEach(([a, b]) => {
                    addPoleBetween(group, oldBoneMat, a, b, 0.026, 0.024, 6);
                    addMesh(group, new THREE.SphereGeometry(0.038, 6, 5), oldBoneMat, a[0], a[1], a[2]);
                    addMesh(group, new THREE.SphereGeometry(0.038, 6, 5), oldBoneMat, b[0], b[1], b[2]);
                });
                return group;
            }

            return null;
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
