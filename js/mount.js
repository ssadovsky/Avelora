/**
 * Avelora — Mounts System (AveloraMountManager)
 *
 * Handles summoning, riding, animation synchronization, terrain adaptation,
 * speed buff, dismounting on combat/damage and resource cleanup.
 */
(function () {
    'use strict';

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

    class AveloraMountManager {
        constructor(game) {
            this.game = game;
            this.isMounted = false;
            this.activeMount = null;     // { group, mixer, actions, currentAnim, def, tiltX, tiltZ, tiltY }
            this.templates = {};         // creatureId -> Promise<{ scene, clips }>
            this.normalSpeed = 4.8;
            this.summoning = null;       // { def, t, total }
            this._v1 = new THREE.Vector3();

            window.addEventListener('game:playerDamaged', () => {
                if (this.isMounted) this.dismount('damage');
                if (this.summoning) this.cancelSummon();
            });

            window.addEventListener('game:location', () => {
                if (this.isMounted) this.dismount('location');
                if (this.summoning) this.cancelSummon();
            });
        }

        /** Loads and caches the base creature GLB template */
        loadTemplate(creatureId) {
            if (this.templates[creatureId]) return this.templates[creatureId];
            const modelKey = `creatures/${creatureId}`;

            const assetReady = (window.AveloraAssets)
                ? window.AveloraAssets.ensure(modelKey)
                : Promise.resolve(true);

            this.templates[creatureId] = assetReady.then(() => new Promise((resolve) => {
                let buffer = window.LakesideEnvironment
                    ? window.LakesideEnvironment.getModelBuffer(modelKey)
                    : null;

                if (!buffer && window.GAME_ASSETS && window.GAME_ASSETS.models && window.GAME_ASSETS.models[modelKey]) {
                    const b64 = window.GAME_ASSETS.models[modelKey];
                    const bin = window.atob(b64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    buffer = bytes.buffer;
                }

                if (!buffer) {
                    console.error(`[AveloraMount] no model buffer for "${modelKey}"`);
                    resolve(null);
                    return;
                }

                const loader = new THREE.GLTFLoader();
                loader.parse(buffer, '', (gltf) => {
                    const scene = gltf.scene;
                    scene.traverse(o => {
                        if (o.isMesh) {
                            o.castShadow = true;
                            o.receiveShadow = true;
                        }
                    });
                    resolve({ scene, clips: gltf.animations || [] });
                }, (err) => {
                    console.error(`[AveloraMount] failed to parse "${modelKey}"`, err);
                    resolve(null);
                });
            }));

            return this.templates[creatureId];
        }

        /** Called when skill with type "mount" is activated on the hotbar */
        activate(skillDef) {
            const g = this.game;
            const c = g.character;
            if (!c || !g.terrain) return 'unavailable';

            // Already mounted on this or any mount -> toggle dismount
            if (this.isMounted) {
                this.dismount('manual');
                return 'ok';
            }

            if (this.summoning) {
                this.cancelSummon();
                return 'busy';
            }

            if (g.combat && g.combat.isDead) return 'unavailable';

            const castTime = Math.max(0, skillDef.castTime || 0);
            if (castTime > 0) {
                if (c.isMoving) c.stopMovement();
                this.summoning = { def: skillDef, t: castTime, total: castTime };
                if (c.playCast) c.playCast(castTime);
                if (g.ui && g.ui.floatText) g.ui.floatText('Призыв верхового животного...', 'info');
                return 'ok';
            }

            this.completeSummon(skillDef);
            return 'ok';
        }

        cancelSummon() {
            if (!this.summoning) return;
            this.summoning = null;
            if (this.game.ui && this.game.ui.floatText) {
                this.game.ui.floatText('Призыв прерван', 'warn');
            }
        }

        completeSummon(skillDef) {
            const g = this.game;
            const c = g.character;
            if (!c || !g.scene || !g.terrain) return;

            const creatureId = skillDef.mountCreature || 'wolf';
            this.loadTemplate(creatureId).then(tpl => {
                if (!tpl || !tpl.scene) {
                    if (g.ui && g.ui.floatText) g.ui.floatText('Не удалось призвать животное', 'warn');
                    return;
                }

                if (this.isMounted) this.dismount('replace');

                const model = cloneSkinned(tpl.scene);
                const scale = skillDef.mountScale || 1.45;
                model.scale.setScalar(scale);

                const group = new THREE.Group();
                group.name = `mount:${creatureId}`;
                group.add(model);

                // Setup animation mixer for the mount
                let mixer = null;
                const actions = {};
                if (tpl.clips.length) {
                    mixer = new THREE.AnimationMixer(model);
                    ['Idle', 'Run', 'Walk'].forEach(name => {
                        const clip = findClip(tpl.clips, name);
                        if (!clip) return;
                        const act = mixer.clipAction(clip);
                        act.setEffectiveWeight(1);
                        actions[name] = act;
                    });
                }

                let saddleBone = null;
                model.traverse(o => {
                    if (!saddleBone && o.isBone && (o.name === 'spine_1' || o.name.endsWith('spine_1') || o.name === 'spine_2')) {
                        saddleBone = o;
                    }
                });

                const idleAct = actions.Idle;
                if (idleAct) idleAct.play();

                const r = c.currentRotation;
                const fwdX = -Math.sin(r), fwdZ = -Math.cos(r);
                const seatOffset = skillDef.seatForward !== undefined ? skillDef.seatForward : 0.45;
                const mx = c.position.x + fwdX * seatOffset;
                const mz = c.position.z + fwdZ * seatOffset;
                const groundY = g.terrain.getHeightAt(mx, mz);
                group.position.set(mx, groundY, mz);
                if (c.mesh) group.rotation.y = c.mesh.rotation.y;

                g.scene.add(group);

                this.activeMount = {
                    group,
                    model,
                    mixer,
                    actions,
                    currentAnim: 'Idle',
                    def: skillDef,
                    creatureId,
                    tiltX: 0,
                    tiltZ: 0,
                    tiltY: 0,
                    saddleBone
                };

                this.isMounted = true;
                c.isMounted = true;
                c.isCasting = false;
                if (c.fadeToLogical) c.fadeToLogical('idle', 0.2);
                c.mountRideHeight = skillDef.rideHeight || 0.62;

                // Speed buff: normal 4.8 m/s -> 8.5 m/s (+75% movement speed)
                const bonus = skillDef.speedBonus !== undefined ? skillDef.speedBonus : 3.7;
                c.moveSpeed = this.normalSpeed + bonus;

                if (g.ui && g.ui.floatText) {
                    g.ui.floatText('Верхом на лютоволке!', 'loot');
                }

                // Trigger small arrival poof / sparkles
                this.spawnSummonVfx(c.position.x, groundY, c.position.z);
            });
        }

        dismount(reason = 'manual') {
            if (!this.isMounted && !this.activeMount) return;

            const g = this.game;
            const c = g.character;

            if (this.activeMount && this.activeMount.group) {
                if (this.activeMount.group.parent) {
                    this.activeMount.group.parent.remove(this.activeMount.group);
                }
                if (this.activeMount.mixer) {
                    this.activeMount.mixer.stopAllAction();
                }
            }

            this.activeMount = null;
            this.isMounted = false;

            if (c) {
                c.isMounted = false;
                c.mountSaddleY = undefined;
                if (c.mesh) {
                    c.mesh.rotation.x = 0;
                    c.mesh.rotation.z = 0;
                }
                c.moveSpeed = this.normalSpeed;
                // Instantly snap back to ground height
                const groundY = g.terrain ? g.terrain.getHeightAt(c.position.x, c.position.z) : c.position.y;
                c.position.y = groundY + (c._stepUpY || 0);
                if (c.mesh) c.mesh.position.y = c.position.y;
            }

            if (g.ui && g.ui.floatText) {
                if (reason === 'damage') {
                    g.ui.floatText('Спешивание (получен урон)', 'warn');
                } else if (reason === 'manual') {
                    g.ui.floatText('Спешивание', 'info');
                }
            }
        }

        spawnSummonVfx(x, y, z) {
            const g = this.game;
            if (!g.skills || !g.skills.addSpark) return;
            const count = 18;
            for (let i = 0; i < count; i++) {
                const a = (i / count) * Math.PI * 2;
                const sp = 2.0 + Math.random() * 1.5;
                g.skills.addSpark(
                    x, y + 0.3, z,
                    Math.cos(a) * sp, 1.2 + Math.random() * 1.5, Math.sin(a) * sp,
                    0.6, 0.12, '#64d2ff', 0.2
                );
            }
        }

        update(delta) {
            // Handle summoning cast
            if (this.summoning) {
                const c = this.game.character;
                if (c && c.isMoving) {
                    this.cancelSummon();
                    return;
                }
                this.summoning.t -= delta;
                if (this.summoning.t <= 0) {
                    const def = this.summoning.def;
                    this.summoning = null;
                    this.completeSummon(def);
                }
            }

            if (!this.isMounted || !this.activeMount) return;

            const g = this.game;
            const c = g.character;
            const m = this.activeMount;
            if (!c || !m.group || !g.terrain) return;

            // Sync horizontal position with hero (offset backward so wolf saddle aligns with rider)
            const r = c.currentRotation;
            const fwdX = -Math.sin(r), fwdZ = -Math.cos(r);
            const seatOffset = m.def.seatForward !== undefined ? m.def.seatForward : 0.45;
            const mx = c.position.x + fwdX * seatOffset;
            const mz = c.position.z + fwdZ * seatOffset;
            const groundY = g.terrain.getHeightAt(mx, mz);
            m.group.position.set(mx, groundY + m.tiltY, mz);

            // Sync yaw rotation with character mesh
            if (c.mesh) {
                m.group.rotation.y = c.mesh.rotation.y;
            }

            // Align mount body to terrain slope (tilt pitch & roll)
            this.alignMountToTerrain(m, delta);

            // Animation state: Run when moving, Idle when stopped
            const wantsRun = c.isMoving;
            const targetAnim = wantsRun ? 'Run' : 'Idle';

            if (m.currentAnim !== targetAnim && m.actions[targetAnim]) {
                const prev = m.actions[m.currentAnim];
                const next = m.actions[targetAnim];
                if (prev) prev.fadeOut(0.18);
                if (next) {
                    next.reset().fadeIn(0.18).play();
                }
                m.currentAnim = targetAnim;
            }

            // Adjust run playback speed based on actual hero velocity
            if (m.mixer) {
                if (m.currentAnim === 'Run') {
                    m.mixer.timeScale = 1.15;
                } else {
                    m.mixer.timeScale = 1.0;
                }
                m.mixer.update(delta);
            }

            // Smooth rhythmic rider bobbing synced with wolf breathing and gallop
            let bobY = 0;
            if (c.isMoving) {
                m.bobTime = (m.bobTime || 0) + delta * 9.5;
                bobY = Math.sin(m.bobTime) * 0.035;
            } else {
                m.bobTime = (m.bobTime || 0) + delta * 2.6;
                bobY = Math.sin(m.bobTime) * 0.012;
            }

            const targetHeight = (m.def.rideHeight || 0.65) + bobY;
            c.mountRideHeight = targetHeight;
            c.position.y = groundY + targetHeight;
            if (c.mesh) {
                c.mesh.position.y = c.position.y;
                // Rider leans together with wolf along hills and slopes
                c.mesh.rotation.x = m.tiltX * 0.65;
                c.mesh.rotation.z = m.tiltZ * 0.65;
            }
        }

        /** Smoothly tilts mount along terrain slope under paws */
        alignMountToTerrain(m, delta) {
            const ter = this.game.terrain;
            const pos = m.group.position;
            const yaw = m.group.rotation.y;

            const span = 0.85; // distance between front and hind paws
            const halfW = 0.35; // half width between left and right paws
            const sinY = Math.sin(yaw), cosY = Math.cos(yaw);

            // Front & hind paw offsets in world coords
            const fx = pos.x + sinY * span, fz = pos.z + cosY * span;
            const hx = pos.x - sinY * span, hz = pos.z - cosY * span;

            const hFL = ter.getHeightAt(fx - cosY * halfW, fz + sinY * halfW);
            const hFR = ter.getHeightAt(fx + cosY * halfW, fz - sinY * halfW);
            const hHL = ter.getHeightAt(hx - cosY * halfW, hz + sinY * halfW);
            const hHR = ter.getHeightAt(hx + cosY * halfW, hz - sinY * halfW);

            const pitch = -Math.atan2((hFL + hFR) * 0.5 - (hHL + hHR) * 0.5, span * 2.0);
            const roll = Math.atan2((hHR + hFR) * 0.5 - (hHL + hFL) * 0.5, halfW * 2.0);

            const rate = Math.min(1.0, 10.0 * delta);
            m.tiltX = THREE.MathUtils.lerp(m.tiltX, pitch, rate);
            m.tiltZ = THREE.MathUtils.lerp(m.tiltZ, roll, rate);

            m.model.rotation.order = 'YXZ';
            m.model.rotation.x = m.tiltX;
            m.model.rotation.z = m.tiltZ;
        }
    }

    window.AveloraMountManager = AveloraMountManager;
})();
