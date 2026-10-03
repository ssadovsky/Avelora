/**
 * Avelora — Creatures: spawning, AI, animation, damage, death & respawn
 *
 * Definitions: `window.GAME_CONTENT.creatures` (content/creatures/<id>/creature.json,
 * field reference in content/README.md). Spawns: world_data.js per location
 *
 *   creatures: [{ id, type, x, z, r? }]     // id = unique per location (persistence key)
 *
 * MODEL: `modelKey` (content/creatures/<id>/model.glb) is parsed ONCE per type per
 * location and cloned per spawn with a skinned-mesh clone (three r128 ships no
 * SkeletonUtils: cloneSkinned() below rebinds each clone's skeleton to its own
 * cloned bones). Materials are cloned per instance (the red hit-flash is per
 * creature); geometry/textures stay shared. Convention: faces +Z, origin on the
 * ground, meters; clips `Idle`, `Walk`, `Run`, `Attack` (hit at ~45% of the clip),
 * `Hit`, `Death` (last frame = corpse). A missing model -> a neutral body+head
 * fallback; a missing clip -> a small procedural bob / lunge / tilt / roll.
 *
 * AI states: idle -> wander (pauses, within wanderRadius of home, walkSpeed)
 *   `aggressive`: player alive within aggroRadius -> chase (runSpeed) -> attack
 *   `retaliate`:  ignores the player until damaged, then chases/attacks
 *   leash: farther than leashRadius from home, or the player died -> return home
 *   ("evading": immune, doesn't re-aggro), full heal on arrival.
 * Movement: terrain height; direct steering while the nav grid has line of sight
 * to the goal (checked every LOS_INTERVAL), otherwise the A* pathfinder
 * (re-path at most every REPATH_INTERVAL). Heading turns smoothly.
 *
 * DEATH: Death clip, the corpse stays CORPSE_TIME s, sinks, is removed. The kill
 * is persisted per character (game_state.js `killed[loc][id] = playTime`); after
 * `respawnMinutes` of PLAYED time the creature respawns at home (checked every
 * RESPAWN_CHECK s and whenever the location is (re)built).
 *
 * Hover/click/Spark use an invisible generous proxy cylinder (hitRadius) per
 * creature, like item piles. Everything lives under game.locationRoot; dispose()
 * on teardown. Only update(delta) moves anything -> frozen while paused.
 * Per-frame path allocates nothing (scratch vectors), except the occasional
 * A* re-path.
 */
(function () {
    'use strict';

    const PLAYER_RADIUS = 0.35;     // m — reach is measured to the player's body, not its centre
    const REPATH_INTERVAL = 0.5;    // s — A* at most this often per creature
    const LOS_INTERVAL = 0.25;      // s — nav-grid line-of-sight re-check
    const CORPSE_TIME = 8;          // s the corpse lies before sinking
    const SINK_TIME = 1.6;          // s to sink into the ground
    const RESPAWN_CHECK = 2;        // s between respawn checks (game time)
    const HIT_FLASH = 0.22;         // s red emissive flash
    const HIT_CLIP_GAP = 0.7;       // s — don't restart the Hit clip more often than this
    const FADE = 0.2;               // s clip cross-fade
    const HP_BAR_SHOW = 4;          // s the HP bar stays after the last hit (then only while damaged & targeted/hovered)
    const SPAWN_GROW = 0.6;         // s scale-in on (re)spawn
    const TURN_RATE = 9;            // 1/s heading ease

    // -----------------------------------------------------------------
    // Skinned clone (equivalent of three's SkeletonUtils.clone, r128)
    // -----------------------------------------------------------------
    function parallelTraverse(a, b, cb) {
        cb(a, b);
        for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], cb);
    }

    function cloneSkinned(source) {
        const srcOf = new Map(), cloneOf = new Map();
        const clone = source.clone();
        parallelTraverse(source, clone, (s, c) => { srcOf.set(c, s); cloneOf.set(s, c); });
        clone.traverse(node => {
            if (!node.isSkinnedMesh) return;
            const src = srcOf.get(node);
            const bones = src.skeleton.bones.map(b => cloneOf.get(b));
            node.skeleton = new THREE.Skeleton(bones, src.skeleton.boneInverses);
            node.bind(node.skeleton, src.bindMatrix);
        });
        return clone;
    }

    function findClip(clips, name) {
        const lower = name.toLowerCase();
        return clips.find(c => c.name === name)
            || clips.find(c => c.name.toLowerCase().endsWith('|' + lower))
            || clips.find(c => c.name.toLowerCase() === lower)
            || null;
    }

    const _v = new THREE.Vector3();

    class AveloraCreatures {
        constructor(game, location) {
            this.game = game;
            this.location = location;
            this.root = game.locationRoot;
            this.terrain = game.terrain;
            this.pathfinder = game.pathfinder;
            this.list = [];              // every spawn record (alive, dead or waiting to respawn)
            this.proxies = [];           // proxy meshes of ALIVE creatures (raycast)
            this.templates = {};         // type -> Promise<{scene, clips, height}>
            this.proxyGeos = {};         // type -> CylinderGeometry
            this.hovered = null;
            this.respawnTimer = RESPAWN_CHECK;
            this.disposed = false;
            this.labelsEl = document.getElementById('world-labels');

            this.onSkillImpact = (e) => this.applySplash(e.detail);
            window.addEventListener('game:skillImpact', this.onSkillImpact);

            const jobs = [];
            (location.creatures || []).forEach(sp => {
                const def = this.def(sp.type);
                if (!def || !sp.id) {
                    console.warn(`[Avelora] location "${location.id}": bad creature spawn`, sp);
                    return;
                }
                const rec = this.makeRecord(sp, def);
                this.list.push(rec);
                if (this.state && this.state.isSlain(location.id, sp.id)) { rec.state = 'gone'; rec.slain = true; return; } // killed for good by a quest
                const killedAt = this.state ? this.state.getKilled(location.id, sp.id) : null;
                if (killedAt !== null && this.playTime - killedAt < this.respawnSeconds(def)) {
                    rec.state = 'gone'; // still dead: waits for respawn
                    return;
                }
                if (killedAt !== null && this.state) this.state.clearKilled(location.id, sp.id);
                jobs.push(this.spawn(rec, false));
            });
            this.ready = Promise.all(jobs).then(() => undefined);
        }

        get state() { return this.game.gameState; }
        get playTime() { return this.state ? this.state.playTime : 0; }

        def(type) {
            const defs = (window.GAME_CONTENT && window.GAME_CONTENT.creatures) || {};
            return Object.prototype.hasOwnProperty.call(defs, type) ? defs[type] : null;
        }

        respawnSeconds(def) { return Math.max(5, (Number(def.respawnMinutes) || 5) * 60); }

        makeRecord(sp, def) {
            return {
                id: sp.id, type: sp.type, def, spawn: sp,
                home: { x: sp.x, z: sp.z },
                state: 'gone',       // idle | wander | chase | attack | return | dead | gone
                hp: def.hp || 10, maxHp: def.hp || 10,
                x: sp.x, z: sp.z, y: 0, yaw: sp.r || 0,
                group: null, model: null, proxy: null, mixer: null, actions: {}, current: null, anim: null,
                materials: [], height: 0.5,
                timer: 0, goal: { x: sp.x, z: sp.z }, path: null, pathIdx: 0, lastPath: -99, losT: 0, los: false,
                pathGoal: { x: NaN, z: NaN },
                attackT: -1, attackHitDone: false, nextAttack: 0, attackDur: 0.6, hitAt: 0.3,
                staggerT: 0, lastHitClip: -99, flashT: 0, lastDamaged: -99, aggro: false,
                deadT: 0, growT: 0, speed: 0, moveAnim: 0,
                hpEl: null, hpFill: null, hpShown: false, hpFrac: -1
            };
        }

        // -----------------------------------------------------------
        // Templates
        // -----------------------------------------------------------
        loadTemplate(type, def) {
            if (this.templates[type]) return this.templates[type];
            this.templates[type] = new Promise(resolve => {
                const buffer = def.modelKey && window.LakesideEnvironment
                    ? window.LakesideEnvironment.getModelBuffer(def.modelKey) : null;
                const finish = (scene, clips) => {
                    if (!scene) scene = AveloraCreatures.makeFallback(def);
                    scene.traverse(o => {
                        if (o.isMesh) {
                            o.castShadow = true;
                            o.receiveShadow = true;
                            o.frustumCulled = false; // skinned bounds are the bind pose; creatures are few
                        }
                    });
                    scene.updateMatrixWorld(true);
                    const box = new THREE.Box3().setFromObject(scene);
                    const s = def.scale || 1;
                    const height = Math.max(0.3, (box.max.y - Math.max(0, box.min.y)) * s);
                    // body footprint (for the hit cylinder): geometric mean of width/length, as a radius
                    const bodyR = 0.5 * Math.sqrt(Math.max(1e-4, (box.max.x - box.min.x) * s) * Math.max(1e-4, (box.max.z - box.min.z) * s));
                    resolve({ scene, clips: clips || [], height, bodyR, fallback: !buffer });
                };
                if (!buffer) { finish(null, null); return; }
                try {
                    new THREE.GLTFLoader().parse(buffer, '', gltf => finish(gltf.scene, gltf.animations), err => {
                        console.warn(`[Avelora] creature model "${def.modelKey}" failed to parse — fallback`, err);
                        finish(null, null);
                    });
                } catch (err) {
                    console.warn(`[Avelora] creature model "${def.modelKey}" failed to parse — fallback`, err);
                    finish(null, null);
                }
            });
            return this.templates[type];
        }

        /** No model.glb yet: an ellipsoid body with a head bump, sized from hitRadius (+Z forward). */
        static makeFallback(def) {
            const r = Math.max(0.15, def.hitRadius || 0.4);
            const g = new THREE.Group();
            g.name = 'fallback';
            const mat = new THREE.MeshStandardMaterial({ color: 0x5c4a3a, roughness: 0.95 });
            const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat);
            body.scale.set(r * 0.85, r * 0.7, r * 1.4);
            body.position.y = r * 0.8;
            const head = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
            head.scale.set(r * 0.45, r * 0.42, r * 0.55);
            head.position.set(0, r * 0.95, r * 1.35);
            g.add(body, head);
            return g;
        }

        // -----------------------------------------------------------
        // Spawning / removal
        // -----------------------------------------------------------
        spawn(rec, grow) {
            return this.loadTemplate(rec.type, rec.def).then(tpl => {
                if (this.disposed || rec.group) return;
                const def = rec.def;
                const group = new THREE.Group();
                group.name = `creature:${rec.id}`;
                const model = tpl.fallback ? tpl.scene.clone() : cloneSkinned(tpl.scene);
                model.scale.setScalar(def.scale || 1);
                // Per-instance materials (hit flash); shared geometry/textures
                rec.materials.length = 0;
                model.traverse(o => {
                    if (!o.isMesh || !o.material) return;
                    const m = o.material.clone();
                    o.material = m;
                    if (m.emissive) {
                        m.userData.baseEmissive = m.emissive.clone();
                        m.userData.baseEmissiveIntensity = m.emissiveIntensity;
                        rec.materials.push(m);
                    }
                });
                group.add(model);

                // Generous invisible hit cylinder (hover / click / tap / Spark)
                if (!this.proxyGeos[rec.type]) {
                    const H = (window.AVELORA_HIT && window.AVELORA_HIT.creature) || { sizeMul: 0.9, minRadius: 0.3, maxRadius: 1.2, heightMul: 0.9, minHeight: 0.4 };
                    const pr = Math.min(H.maxRadius, Math.max(H.minRadius, (tpl.bodyR || def.hitRadius || 0.4) * H.sizeMul));
                    const ph = Math.max(H.minHeight, tpl.height * H.heightMul);
                    const geo = new THREE.CylinderGeometry(pr, pr, ph, 10, 1);
                    geo.translate(0, ph / 2 - 0.1, 0);
                    this.proxyGeos[rec.type] = geo;
                }
                const proxy = new THREE.Mesh(this.proxyGeos[rec.type], window.AveloraWorldObjects
                    ? window.AveloraWorldObjects.proxyMaterial() : new THREE.MeshBasicMaterial({ visible: false }));
                proxy.userData.creature = rec;
                group.add(proxy);
                if (window.AveloraHitDebug) window.AveloraHitDebug.attach(proxy, 'creature');

                rec.group = group; rec.model = model; rec.proxy = proxy;
                rec.height = tpl.height;
                rec.hp = rec.maxHp;
                rec.x = rec.home.x; rec.z = rec.home.z; rec.yaw = rec.spawn.r || 0;
                rec.y = this.terrain.getHeightAt(rec.x, rec.z);
                rec.state = 'idle';
                rec.timer = 1 + Math.random() * 3;
                rec.aggro = false; rec.attackT = -1; rec.staggerT = 0; rec.flashT = 0; rec.path = null;
                rec.deadT = 0; rec.lastDamaged = -99;
                rec.growT = grow ? 0 : SPAWN_GROW;
                group.position.set(rec.x, rec.y, rec.z);
                group.rotation.y = rec.yaw;
                group.scale.setScalar(grow ? 0.01 : 1);

                rec.mixer = null; rec.actions = {}; rec.current = null; rec.anim = null;
                if (tpl.clips.length) {
                    rec.mixer = new THREE.AnimationMixer(model);
                    ['Idle', 'Walk', 'Run', 'Attack', 'Hit', 'Death'].forEach(n => {
                        const clip = findClip(tpl.clips, n);
                        if (!clip) return;
                        const a = rec.mixer.clipAction(clip);
                        if (n === 'Attack' || n === 'Hit' || n === 'Death') {
                            a.setLoop(THREE.LoopOnce, 1);
                            a.clampWhenFinished = true;
                        }
                        rec.actions[n] = a;
                    });
                    const atk = rec.actions.Attack;
                    if (atk) {
                        const dur = atk.getClip().duration;
                        // A clip longer than the cooldown is sped up so attacks never overlap
                        const cd = Math.max(0.4, def.attackCooldown || 1.2);
                        atk.timeScale = dur > cd * 0.9 ? dur / (cd * 0.9) : 1;
                        rec.attackDur = dur / atk.timeScale;
                        rec.hitAt = rec.attackDur * 0.45;
                    }
                }
                if (!rec.actions.Attack) { rec.attackDur = 0.55; rec.hitAt = 0.28; }
                this.play(rec, 'Idle', 0);

                this.root.add(group);
                this.proxies.push(proxy);
            });
        }

        /** Detach and free a creature's instance (corpse gone / teardown). */
        despawn(rec) {
            if (rec.proxy) {
                const i = this.proxies.indexOf(rec.proxy);
                if (i >= 0) this.proxies.splice(i, 1);
            }
            if (rec.mixer) { rec.mixer.stopAllAction(); rec.mixer.uncacheRoot(rec.model); }
            if (rec.group && rec.group.parent) rec.group.parent.remove(rec.group);
            rec.materials.forEach(m => m.dispose());
            if (rec.model) rec.model.traverse(o => {
                if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
                if (o.isMesh && o.material && rec.materials.indexOf(o.material) < 0) o.material.dispose();
            });
            rec.materials.length = 0;
            rec.group = rec.model = rec.proxy = rec.mixer = null;
            rec.actions = {}; rec.current = null; rec.anim = null;
            if (this.hovered === rec) this.hovered = null;
            this.hideHpBar(rec);
        }

        // -----------------------------------------------------------
        // Animation
        // -----------------------------------------------------------
        /** Cross-fade to a clip by name; `restart` replays a one-shot clip. Missing clip -> procedural only. */
        play(rec, name, fade, restart) {
            if (rec.anim === name && !restart) return;
            rec.anim = name;
            rec.animT = 0;
            const next = rec.actions[name];
            if (!next) return;
            const f = fade === undefined ? FADE : fade;
            next.reset();
            next.enabled = true;
            next.setEffectiveWeight(1);
            next.fadeIn(f).play();
            if (rec.current && rec.current !== next) rec.current.fadeOut(f);
            rec.current = next;
        }

        hasClip(rec, name) { return !!rec.actions[name]; }

        /** Procedural stand-ins for missing clips (bob when moving, lunge, hit tilt, death roll). */
        proceduralPose(rec, dt) {
            const m = rec.model;
            if (!m) return;
            const h = rec.height;
            let py = 0, pz = 0, rx = 0, rz = 0, ry = 0;
            if (rec.state === 'dead') {
                if (!this.hasClip(rec, 'Death')) {
                    const t = Math.min(1, rec.deadT / 0.5);
                    rz = t * t * Math.PI * 0.5;
                    py = t * h * 0.15;
                }
            } else {
                if (rec.speed > 0.05 && !this.hasClip(rec, rec.speed > rec.def.walkSpeed * 1.2 ? 'Run' : 'Walk')) {
                    rec.moveAnim += dt * (4 + rec.speed * 3);
                    py = Math.abs(Math.sin(rec.moveAnim)) * h * 0.06;
                    rx = Math.sin(rec.moveAnim * 2) * 0.05;
                    if (rec.def.proceduralIdle) { rz = Math.sin(rec.moveAnim) * 0.05; ry = Math.sin(rec.moveAnim) * 0.07; }
                } else if (rec.def.proceduralIdle && !this.hasClip(rec, 'Idle') && rec.state !== 'attack') {
                    // no skeleton: breathing, periodic sniffing (nose down + twitch), looking around
                    rec.idleT = (rec.idleT || Math.random() * 20) + dt;
                    const t = rec.idleT, u = (t % 9) / 9;
                    rx = Math.sin(t * 1.7) * 0.012;
                    py = Math.sin(t * 1.7) * h * 0.004;
                    if (u < 0.4) {
                        const env = Math.sin(u / 0.4 * Math.PI);
                        rx += env * (0.16 + Math.sin(t * 13) * 0.025);
                        ry = Math.sin(t * 0.9) * 0.22 * env;
                        py -= env * h * 0.01;
                    } else if (u > 0.6 && u < 0.85) {
                        ry = Math.sin((u - 0.6) / 0.25 * Math.PI) * 0.3 * Math.sin(t * 0.6 + 1);
                    }
                }
                if (rec.attackT >= 0 && !this.hasClip(rec, 'Attack')) {
                    const u = rec.attackT / rec.attackDur;
                    const k = u < 0.5 ? -Math.sin(u / 0.5 * Math.PI * 0.5) * 0.3 : Math.sin((u - 0.5) / 0.5 * Math.PI) ;
                    pz = k * (rec.def.hitRadius || 0.4) * 0.6;
                    rx = k * 0.15;
                }
                if (rec.staggerT > 0 && !this.hasClip(rec, 'Hit')) {
                    rx -= rec.staggerT * 0.6;
                }
            }
            m.position.set(0, py, pz);
            m.rotation.set(rx, ry, rz);
        }

        // -----------------------------------------------------------
        // Per-frame
        // -----------------------------------------------------------
        update(delta) {
            if (this.disposed) return;
            const g = this.game;
            const c = g.character;
            const combat = g.combat;
            const playerAlive = !!(c && combat && !combat.isDead);
            const now = g.gameTime;

            this.respawnTimer -= delta;
            if (this.respawnTimer <= 0) {
                this.respawnTimer = RESPAWN_CHECK;
                this.checkRespawns();
            }

            for (let i = 0; i < this.list.length; i++) {
                const rec = this.list[i];
                if (!rec.group) continue;

                if (rec.growT < SPAWN_GROW) {
                    rec.growT = Math.min(SPAWN_GROW, rec.growT + delta);
                    const t = rec.growT / SPAWN_GROW;
                    rec.group.scale.setScalar(0.01 + 0.99 * (1 - (1 - t) * (1 - t)));
                }

                if (rec.state === 'dead') {
                    this.updateDead(rec, delta);
                    // the corpse may have just sunk and been removed (rec.group = null)
                    if (!rec.group) continue;
                } else {
                    this.think(rec, delta, now, c, playerAlive);
                }

                // Hit flash (per-instance materials)
                if (rec.flashT > 0) {
                    rec.flashT = Math.max(0, rec.flashT - delta);
                    const k = rec.flashT / HIT_FLASH;
                    for (let j = 0; j < rec.materials.length; j++) {
                        const m = rec.materials[j];
                        m.emissive.copy(m.userData.baseEmissive).lerp(AveloraCreatures.FLASH_COLOR, k);
                        m.emissiveIntensity = Math.max(m.userData.baseEmissiveIntensity, k * 1.4);
                    }
                }

                if (rec.mixer) rec.mixer.update(delta);
                this.proceduralPose(rec, delta);
                rec.group.position.set(rec.x, rec.y, rec.z);
                rec.group.rotation.y = rec.yaw;
                if (rec.def.tiltSpan && rec.state !== 'dead') this.alignToTerrain(rec, delta);
            }
            this.updateHpBars();
        }

        think(rec, dt, now, c, playerAlive) {
            const def = rec.def;
            const p = c ? c.position : null;
            const dxp = p ? p.x - rec.x : 0, dzp = p ? p.z - rec.z : 0;
            const distP = p ? Math.sqrt(dxp * dxp + dzp * dzp) : Infinity;
            const distHome = Math.hypot(rec.x - rec.home.x, rec.z - rec.home.z);
            const leash = def.leashRadius || 14;
            const reach = (def.attackRange || 0.8) + (def.hitRadius || 0.4) + PLAYER_RADIUS;
            rec.speed = 0;
            if (rec.staggerT > 0) rec.staggerT = Math.max(0, rec.staggerT - dt);

            // Attack in progress: runs to completion (the hit lands at hitAt)
            if (rec.attackT >= 0) {
                rec.attackT += dt;
                if (p) this.turnTowards(rec, p.x, p.z, dt);
                if (!rec.attackHitDone && rec.attackT >= rec.hitAt) {
                    rec.attackHitDone = true;
                    if (playerAlive && distP <= reach + 0.5 && this.game.combat) {
                        const d = def.damage || [1, 2];
                        const amount = Math.round(d[0] + Math.random() * ((d[1] || d[0]) - d[0]));
                        this.game.combat.damagePlayer(amount, rec);
                    }
                }
                if (rec.attackT >= rec.attackDur) {
                    rec.attackT = -1;
                    this.play(rec, 'Idle', 0.15);
                }
                return;
            }

            // Aggro acquisition (aggressive only; retaliate is set in damage())
            if (def.behavior === 'aggressive' && !rec.aggro && playerAlive && rec.state !== 'return'
                && distP < (def.aggroRadius || 0) && Math.hypot(p.x - rec.home.x, p.z - rec.home.z) < leash) {
                rec.aggro = true;
            }
            if (rec.aggro && (!playerAlive || distHome > leash)) {
                this.startReturn(rec);
            }
            if (rec.aggro && rec.state !== 'chase' && rec.state !== 'attack' && rec.state !== 'return') {
                rec.state = 'chase';
                rec.lastPath = -99;
            }
            if (rec.staggerT > 0) return; // flinching from a hit

            switch (rec.state) {
                case 'idle': {
                    this.play(rec, 'Idle');
                    rec.timer -= dt;
                    if (rec.timer <= 0) this.pickWander(rec);
                    break;
                }
                case 'wander': {
                    if (this.moveTo(rec, rec.goal.x, rec.goal.z, def.walkSpeed || 1, dt, 0.3, now)) {
                        rec.state = 'idle';
                        const ip = def.idlePause || [2, 6];
                        rec.timer = ip[0] + Math.random() * (ip[1] - ip[0]);
                    }
                    break;
                }
                case 'chase': {
                    if (distP <= reach * 0.85) {
                        rec.state = 'attack';
                        rec.path = null;
                        break;
                    }
                    this.moveTo(rec, p.x, p.z, def.runSpeed || 3, dt, reach * 0.8, now);
                    break;
                }
                case 'attack': {
                    if (distP > reach + 0.3) { rec.state = 'chase'; rec.lastPath = -99; break; }
                    this.play(rec, 'Idle', 0.15);
                    this.turnTowards(rec, p.x, p.z, dt);
                    if (now >= rec.nextAttack) this.startAttack(rec, now);
                    break;
                }
                case 'return': {
                    if (this.moveTo(rec, rec.home.x, rec.home.z, def.runSpeed || 3, dt, 0.5, now)) {
                        rec.state = 'idle';
                        rec.timer = 1 + Math.random() * 2;
                        rec.hp = rec.maxHp;
                    }
                    break;
                }
            }

            // Separation: не проходим сквозь игрока в пассивных состояниях
            if (p && rec.state !== 'chase' && rec.state !== 'attack') {
                const sep = (def.hitRadius || 0.4) + PLAYER_RADIUS + 0.15;
                const sdx = rec.x - p.x, sdz = rec.z - p.z;
                const sd = Math.sqrt(sdx * sdx + sdz * sdz);
                if (sd < sep && sd > 0.001) {
                    const push = sep - sd;
                    rec.x += (sdx / sd) * push;
                    rec.z += (sdz / sd) * push;
                    rec.y = this.terrain.getHeightAt(rec.x, rec.z);
                }
            }
        }

        /** Big animals: pitch/roll the body so the feet follow the slope (tiltSpan = [hindZ, frontZ, halfWidth] in metres, model space). */
        alignToTerrain(rec, dt) {
            const T = rec.def.tiltSpan, th = this.terrain;
            if (!th || !th.getHeightAt) return;
            const sy = Math.sin(rec.yaw), cy = Math.cos(rec.yaw);
            const H = (fz, rx) => th.getHeightAt(rec.x + sy * fz + cy * rx, rec.z + cy * fz - sy * rx);
            // the four feet (hind pair at T[0], front pair at T[1]); fit a plane, then lift so no foot is below ground
            const hHL = H(T[0], -T[2]), hHR = H(T[0], T[2]), hFL = H(T[1], -T[2]), hFR = H(T[1], T[2]);
            const span = T[1] - T[0];
            const pitch = -Math.atan2((hFL + hFR) / 2 - (hHL + hHR) / 2, span);
            const roll = Math.atan2((hHR + hFR) / 2 - (hHL + hFL) / 2, 2 * T[2]);
            const sp = Math.sin(pitch), sr = Math.sin(roll);
            const off = (z, x) => -sp * z + sr * x;
            const y0 = Math.max(hHL - off(T[0], -T[2]), hHR - off(T[0], T[2]), hFL - off(T[1], -T[2]), hFR - off(T[1], T[2]));
            const k = Math.min(1, 6 * dt);
            rec.tiltX = (rec.tiltX || 0) + (pitch - (rec.tiltX || 0)) * k;
            rec.tiltZ = (rec.tiltZ || 0) + (roll - (rec.tiltZ || 0)) * k;
            rec.tiltY = (rec.tiltY === undefined ? y0 : rec.tiltY) + (y0 - (rec.tiltY === undefined ? y0 : rec.tiltY)) * k;
            if (y0 > rec.tiltY) rec.tiltY = y0;   // never sink: rise at once, settle down smoothly
            const g = rec.group;
            g.rotation.order = 'YXZ';
            g.rotation.x = rec.tiltX; g.rotation.z = rec.tiltZ;
            g.position.y = rec.tiltY;
        }

        startAttack(rec, now) {
            rec.attackT = 0;
            rec.attackHitDone = false;
            rec.nextAttack = now + Math.max(0.4, rec.def.attackCooldown || 1.2);
            this.play(rec, 'Attack', 0.08, true);
        }

        startReturn(rec) {
            rec.aggro = false;
            rec.state = 'return';
            rec.attackT = -1;
            rec.lastPath = -99;
            rec.hp = rec.maxHp; // leashing resets the fight
        }

        pickWander(rec) {
            // Patrol: фиксированный маршрут туда-обратно (задаётся в spawn как patrol:[{x,z},...])
            const patrol = rec.spawn.patrol;
            if (patrol && patrol.length >= 2) {
                if (rec.patrolIdx === undefined) { rec.patrolIdx = 0; rec.patrolDir = 1; }
                const next = rec.patrolIdx + rec.patrolDir;
                if (next >= patrol.length)      { rec.patrolDir = -1; rec.patrolIdx = patrol.length - 2; }
                else if (next < 0)              { rec.patrolDir =  1; rec.patrolIdx = 1; }
                else                            { rec.patrolIdx = next; }
                const pt = patrol[rec.patrolIdx];
                rec.goal.x = pt.x; rec.goal.z = pt.z;
                rec.state = 'wander';
                rec.lastPath = -99;
                return;
            }
            const wr = rec.def.wanderRadius || 0;
            if (wr <= 0.2) { rec.timer = 3 + Math.random() * 3; return; }
            for (let k = 0; k < 6; k++) {
                const a = Math.random() * Math.PI * 2, d = wr * (0.35 + 0.65 * Math.sqrt(Math.random()));
                const x = rec.home.x + Math.cos(a) * d, z = rec.home.z + Math.sin(a) * d;
                if (this.isWalkable(x, z)) {
                    rec.goal.x = x; rec.goal.z = z;
                    rec.state = 'wander';
                    rec.lastPath = -99;
                    return;
                }
            }
            rec.timer = 2 + Math.random() * 2;
        }

        isWalkable(x, z) {
            const pf = this.pathfinder;
            if (!pf) return true;
            const gx = Math.floor((x + pf.halfWorld) / pf.cellSize), gz = Math.floor((z + pf.halfWorld) / pf.cellSize);
            return pf.isWalkable(gx, gz);
        }

        losTo(rec, x, z) {
            const pf = this.pathfinder;
            if (!pf) return true;
            const h = pf.halfWorld, cs = pf.cellSize, n = pf.gridSize - 1;
            const cl = v => Math.max(0, Math.min(n, v));
            return pf.hasLineOfSight(
                cl(Math.floor((rec.x + h) / cs)), cl(Math.floor((rec.z + h) / cs)),
                cl(Math.floor((x + h) / cs)), cl(Math.floor((z + h) / cs)));
        }

        /**
         * Steps toward (tx, tz); returns true once within `stopDist`.
         * Direct steering with nav-grid line of sight, otherwise A* waypoints.
         */
        moveTo(rec, tx, tz, speed, dt, stopDist, now) {
            let dx = tx - rec.x, dz = tz - rec.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist <= stopDist) return true;

            rec.losT -= dt;
            if (rec.losT <= 0) {
                rec.losT = LOS_INTERVAL;
                rec.los = this.losTo(rec, tx, tz);
            }
            let sx = tx, sz = tz;
            if (!rec.los && this.pathfinder) {
                const moved = Math.hypot(tx - rec.pathGoal.x, tz - rec.pathGoal.z);
                if (!rec.path || (now - rec.lastPath >= REPATH_INTERVAL && moved > 0.8) || now - rec.lastPath > 3) {
                    if (now - rec.lastPath >= REPATH_INTERVAL) {
                        _v.set(tx, 0, tz);
                        rec.path = this.pathfinder.findPath({ x: rec.x, z: rec.z }, _v);
                        rec.pathIdx = 0;
                        rec.lastPath = now;
                        rec.pathGoal.x = tx; rec.pathGoal.z = tz;
                    }
                }
                const path = rec.path;
                while (path && rec.pathIdx < path.length && Math.hypot(path[rec.pathIdx].x - rec.x, path[rec.pathIdx].z - rec.z) < 0.3) rec.pathIdx++;
                if (path && rec.pathIdx < path.length) { sx = path[rec.pathIdx].x; sz = path[rec.pathIdx].z; }
                else if (path && path.length === 0) { return true; } // unreachable: give up where we are
            }
            dx = sx - rec.x; dz = sz - rec.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > 1e-4) {
                const step = Math.min(d, speed * dt);
                const nx = rec.x + (dx / d) * step, nz = rec.z + (dz / d) * step;
                // Never step into water / blocked cells (e.g. while steering directly)
                if (this.isWalkable(nx, nz) || !this.isWalkable(rec.x, rec.z)) {
                    rec.x = nx; rec.z = nz;
                    rec.speed = speed;
                } else {
                    rec.los = false; rec.losT = LOS_INTERVAL; // force the pathfinder next frame
                }
                this.turnTowards(rec, sx, sz, dt);
            }
            rec.y = this.terrain.getHeightAt(rec.x, rec.z);
            this.play(rec, speed > (rec.def.walkSpeed || 1) * 1.2 && this.hasClip(rec, 'Run') ? 'Run' : (this.hasClip(rec, 'Walk') ? 'Walk' : 'Run'));
            return false;
        }

        turnTowards(rec, x, z, dt) {
            const dx = x - rec.x, dz = z - rec.z;
            if (dx * dx + dz * dz < 1e-6) return;
            const target = Math.atan2(dx, dz); // model faces +Z
            let diff = target - rec.yaw;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            rec.yaw += diff * Math.min(1, TURN_RATE * dt);
        }

        updateDead(rec, dt) {
            rec.deadT += dt;
            rec.speed = 0;
            if (rec.deadT > CORPSE_TIME) {
                const t = (rec.deadT - CORPSE_TIME) / SINK_TIME;
                rec.y = this.terrain.getHeightAt(rec.x, rec.z) - t * (rec.height + 0.3);
                if (t >= 1) {
                    this.despawn(rec);
                    rec.state = 'gone';
                }
            }
        }

        // -----------------------------------------------------------
        // Damage
        // -----------------------------------------------------------
        isAlive(rec) { return !!(rec && rec.group && rec.state !== 'dead' && rec.state !== 'gone'); }

        /** Applies damage from the player (melee / Spark). Returns the damage actually dealt. */
        damage(rec, amount, source) {
            if (!this.isAlive(rec) || !(amount > 0)) return 0;
            const ui = this.game.ui;
            if (rec.state === 'return') {
                if (ui && ui.floatAt) ui.floatAt('Уклонение', 'miss', rec.x, rec.y + rec.height + 0.3, rec.z);
                return 0;
            }
            const now = this.game.gameTime;
            rec.hp = Math.max(0, rec.hp - amount);
            rec.lastDamaged = now;
            rec.flashT = HIT_FLASH;
            if (ui && ui.floatAt) ui.floatAt(String(Math.round(amount)), source === 'spark' ? 'dmg-magic' : 'dmg', rec.x, rec.y + rec.height + 0.25, rec.z);
            window.dispatchEvent(new CustomEvent('game:creatureDamaged', { detail: { id: rec.id, type: rec.type, amount, hp: rec.hp, source } }));
            if (rec.hp <= 0) {
                this.kill(rec);
                return amount;
            }
            // Retaliate (and aggressive creatures that hadn't noticed yet)
            rec.aggro = true;
            // Hit reaction: never cuts an attack short, and not re-triggered constantly
            if (rec.attackT < 0 && now - rec.lastHitClip >= HIT_CLIP_GAP) {
                rec.lastHitClip = now;
                if (this.hasClip(rec, 'Hit')) {
                    this.play(rec, 'Hit', 0.06, true);
                    rec.staggerT = Math.min(0.45, rec.actions.Hit.getClip().duration);
                } else {
                    rec.staggerT = 0.25;
                }
            }
            return amount;
        }

        kill(rec) {
            rec.state = 'dead';
            rec.deadT = 0;
            rec.attackT = -1;
            rec.aggro = false;
            rec.staggerT = 0;
            const i = this.proxies.indexOf(rec.proxy);
            if (i >= 0) this.proxies.splice(i, 1);
            this.play(rec, 'Death', 0.1, true);
            if (this.hovered === rec) this.hovered = null;
            this.hideHpBar(rec);
            if (this.state) this.state.setKilled(this.location.id, rec.id, this.playTime);
            this.dropLoot(rec);
            window.dispatchEvent(new CustomEvent('game:creatureKilled', { detail: { id: rec.id, type: rec.type } }));
        }

        /**
         * creature.json `drops: [{item, count, chance?}]`: straight into the bag; whatever does not fit
         * lies on the ground by the corpse (monster loot vanishes from the ground after despawnMinutes).
         */
        dropLoot(rec) {
            const wo = this.game.worldObjects, st = this.state, ui = this.game.ui, drops = rec.def.drops;
            if (!st || !Array.isArray(drops)) return;
            drops.forEach((d, i) => {
                if (!d || !d.item || !window.AveloraItems.get(d.item) || (d.chance !== undefined && Math.random() > d.chance)) return;
                const want = Math.max(1, d.count || 1);
                const got = st.inventory.add(d.item, want);
                const def = window.AveloraItems.get(d.item);
                if (got > 0 && ui) { ui.bagFloat(`+${got} ${def.name}`, i * 0.15); ui.pulseInventory(); }
                const left = want - got;
                if (left > 0 && wo) {
                    if (ui) ui.floatText('Сумка полна', 'warn', i * 0.2 + 0.1);
                    const a = (i / Math.max(1, drops.length)) * Math.PI * 2 + rec.y;
                    wo.addDrop(d.item, left, rec.x + Math.cos(a) * 0.6, rec.z + Math.sin(a) * 0.6);
                }
            });
        }

        /** Spark impact hook (window 'game:skillImpact'): damage every creature whose body is within the radius. */
        applySplash(detail) {
            if (!detail || !detail.point || !(detail.amount > 0) || this.disposed) return;
            const pt = detail.point, R = detail.radius || 1;
            for (let i = 0; i < this.list.length; i++) {
                const rec = this.list[i];
                if (!this.isAlive(rec)) continue;
                const d = Math.hypot(rec.x - pt.x, rec.z - pt.z) - (rec.def.hitRadius || 0.4);
                if (d <= R && pt.y <= rec.y + rec.height + R) this.damage(rec, detail.amount, 'spark');
            }
        }

        /** Projectile collision (skills.js): alive creature whose body cylinder contains `pos`, or null. */
        hitTest(pos) {
            for (let i = 0; i < this.list.length; i++) {
                const rec = this.list[i];
                if (!this.isAlive(rec)) continue;
                const r = rec.def.hitRadius || 0.4;
                const dx = pos.x - rec.x, dz = pos.z - rec.z;
                if (dx * dx + dz * dz <= r * r && pos.y >= rec.y - 0.1 && pos.y <= rec.y + rec.height + 0.1) return rec;
            }
            return null;
        }

        /** Creature under the (already set up) raycaster, or null. */
        pickAt(raycaster) {
            if (!this.proxies.length) return null;
            const hit = raycaster.intersectObjects(this.proxies, false)[0];
            return hit ? hit.object.userData.creature || null : null;
        }

        /** Player died / respawned: every living creature forgets the fight and goes home at full health. */
        resetAll() {
            this.list.forEach(rec => {
                if (!this.isAlive(rec)) return;
                rec.aggro = false;
                rec.attackT = -1;
                rec.staggerT = 0;
                rec.hp = rec.maxHp;
                rec.x = rec.home.x; rec.z = rec.home.z;
                rec.y = this.terrain.getHeightAt(rec.x, rec.z);
                rec.state = 'idle';
                rec.timer = 1 + Math.random() * 2;
                rec.path = null;
                this.play(rec, 'Idle', 0.1);
            });
        }

        // -----------------------------------------------------------
        // Respawn (played time)
        // -----------------------------------------------------------
        checkRespawns() {
            const st = this.state;
            if (!st) return;
            for (let i = 0; i < this.list.length; i++) {
                const rec = this.list[i];
                if (rec.state !== 'gone' || rec.group || rec.slain) continue;
                const t = st.getKilled(this.location.id, rec.id);
                if (t !== null && this.playTime - t < this.respawnSeconds(rec.def)) continue;
                if (t !== null) st.clearKilled(this.location.id, rec.id);
                rec.state = 'spawning';
                this.spawn(rec, true);
            }
        }

        // -----------------------------------------------------------
        // HP bars (DOM, only while damaged / targeted / hovered)
        // -----------------------------------------------------------
        ensureHpBar(rec) {
            if (rec.hpEl || !this.labelsEl) return;
            const el = document.createElement('div');
            el.className = 'creature-hp';
            const fill = document.createElement('div');
            fill.className = 'creature-hp-fill';
            el.appendChild(fill);
            el.style.display = 'none';
            this.labelsEl.appendChild(el);
            rec.hpEl = el; rec.hpFill = fill; rec.hpShown = false; rec.hpFrac = -1;
        }

        hideHpBar(rec) {
            if (rec.hpEl && rec.hpShown) { rec.hpEl.style.display = 'none'; rec.hpShown = false; }
        }

        updateHpBars() {
            const g = this.game;
            const combat = g.combat;
            const engTarget = combat ? combat.targetCreature() : null;
            const selTarget = combat ? combat.selectedTarget : null;
            const w = window.innerWidth, h = window.innerHeight;
            for (let i = 0; i < this.list.length; i++) {
                const rec = this.list[i];
                const alive = this.isAlive(rec);
                const want = alive && (rec === engTarget || rec === selTarget || rec === this.hovered
                    || g.gameTime - rec.lastDamaged < HP_BAR_SHOW
                    || (rec.hp < rec.maxHp && rec.aggro));
                if (!want) { this.hideHpBar(rec); continue; }
                this.ensureHpBar(rec);
                if (!rec.hpEl) continue;
                _v.set(rec.x, rec.y + rec.height + 0.35, rec.z).project(g.camera);
                if (_v.z >= 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1) { this.hideHpBar(rec); continue; }
                if (!rec.hpShown) { rec.hpEl.style.display = 'block'; rec.hpShown = true; }
                const frac = Math.round(rec.hp / rec.maxHp * 100) / 100;
                if (frac !== rec.hpFrac) { rec.hpFrac = frac; rec.hpFill.style.width = (frac * 100) + '%'; }
                rec.hpEl.style.transform = `translate(-50%, -100%) translate(${((_v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - _v.y) / 2 * h).toFixed(1)}px)`;
            }
        }

        // -----------------------------------------------------------
        // Tests / debug
        // -----------------------------------------------------------
        get(id) { return this.list.find(r => r.id === id) || null; }
        aliveCount() { return this.list.filter(r => this.isAlive(r)).length; }
        /** Screen position of a creature's body (tests click/tap on it). */
        screenPos(rec) {
            _v.set(rec.x, rec.y + rec.height * 0.5, rec.z).project(this.game.camera);
            return [(_v.x + 1) / 2 * window.innerWidth, (1 - _v.y) / 2 * window.innerHeight];
        }

        dispose() {
            this.disposed = true;
            window.removeEventListener('game:skillImpact', this.onSkillImpact);
            this.list.forEach(rec => {
                if (rec.group) this.despawn(rec);
                if (rec.hpEl) { rec.hpEl.remove(); rec.hpEl = null; }
            });
            this.list.length = 0;
            this.proxies.length = 0;
            Object.keys(this.proxyGeos).forEach(k => this.proxyGeos[k].dispose());
            this.proxyGeos = {};
            // Templates are never in the scene: free their GPU resources (clones share them)
            Object.keys(this.templates).forEach(k => this.templates[k].then(tpl => {
                const geos = new Set(), mats = new Set();
                tpl.scene.traverse(o => {
                    if (o.geometry) geos.add(o.geometry);
                    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
                });
                mats.forEach(m => {
                    Object.keys(m).forEach(key => { if (m[key] && m[key].isTexture) m[key].dispose(); });
                    m.dispose();
                });
                geos.forEach(g => g.dispose());
            }));
            this.templates = {};
        }
    }

    AveloraCreatures.FLASH_COLOR = new THREE.Color(1.0, 0.12, 0.05);
    AveloraCreatures.cloneSkinned = cloneSkinned;
    window.AveloraCreatures = AveloraCreatures;
})();
