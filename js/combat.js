/**
 * Avelora — Player combat: health, damage, death & respawn, melee engagement
 *
 * Session-wide (one instance, `game.combat`); HP is NOT persisted (full on load,
 * on character switch and on respawn). Max HP per character: characters.js
 * `maxHp` (default 100).
 *
 * HEALTH: `#hp-bar` (fill + "85 / 100"), a brief red screen-edge flash on every
 * hit once HP is below LOW_HP_FLASH_FRAC (20 %) — above that, hits update the
 * bar with no flash, so routine trash damage doesn't nag (`#damage-vignette`,
 * driven from game time, plus a faint steady one below 30 %), regeneration
 * REGEN_PER_SEC of max HP per second once REGEN_DELAY s have passed without
 * taking or dealing damage.
 * DEATH: the character tips over (character.js procedural fall — no rig has a
 * death clip) -> "Вы погибли" overlay -> RESPAWN_DELAY s later: respawn at the
 * location's DEFAULT spawn with full HP; every living creature resets (home,
 * full HP, no aggro). Input (walking, hotbar, drag & drop) is ignored while dead.
 *
 * MELEE (everyone): the right-hand item's `weapon` stats (item.json) or bare
 * fists (AveloraItems.BARE_HANDS). A click/tap on a creature (or a tree, via
 * harvest.js) ENGAGES it: walk into range (re-path while it moves), stop, face
 * it, and swing every `cooldown` s while it lives and the player doesn't click
 * elsewhere (Diablo style — no need to hold the button). The swing is the
 * procedural arm/spine overlay in character.js; the hit lands at
 * SWING_HIT_FRAC of the swing (if the target is still in reach).
 *
 * Engagement target interface (creature or tree):
 *   { kind, isValid(), x(), z(), radius, range(weapon), onHit(weapon), label }
 * Everything advances only in update(delta) / game timers -> frozen on pause.
 */
(function () {
    'use strict';

    const REGEN_DELAY = 6;          // s without taking/dealing damage before regen starts
    const REGEN_PER_SEC = 0.05;     // fraction of max HP per second
    const DEATH_OVERLAY_DELAY = 0.9; // s after the fall starts
    const RESPAWN_DELAY = 2.0;      // s the overlay is shown before respawning
    const REPATH_INTERVAL = 0.4;    // s between re-paths toward a moving target
    const HIT_TOLERANCE = 0.6;      // m of extra reach when the hit lands (target stepped back a bit)
    const MAX_PATH_FAILS = 3;
    const FLASH_DECAY = 0.55;       // s red vignette fade
    const LOW_HP_FLASH_FRAC = 0.2;  // flash-on-every-hit only kicks in below this HP fraction

    // Target indicator: terrain-conforming ring drawn under the selected creature's feet
    const TARGET_RING_SEGS = 48;
    const TARGET_RING_COLOR = 0xffdd44;
    const TARGET_RING_COLOR_AGGRO = 0xff2a1a;   // creatures that attack on sight

    const CREATURE_ICONS = {
        'spider': '🕷️', 'blue_spider': '🕷️', 'rat': '🐀', 'grey_rat': '🐀',
        'bear': '🐻', 'wolf': '🐺', 'boar': '🐗', 'rune_boar': '🐗',
        'badger': '🦡', 'bee': '🐝', 'dragonfly': '🦗', 'fawn': '🦌',
        'spotted_fawn': '🦌', 'forest_doe': '🦌', 'rooster': '🐓', 'fire_fox': '🦊',
        'red_panda': '🐼', 'hyena': '🐕', 'cave_lion': '🦁', 'komodo': '🦎',
        'lizard': '🦎', 'lizard_soldier': '🦎', 'kobold': '⛏️', 'minotaur': '🐂',
        'thunderclaw': '🦖', 'yasha': '🐊', 'fire_elemental': '🔥',
        'water_elemental': '💧', 'air_elemental': '💨', 'stone_elemental': '🗿'
    };

    function makeTargetRing() {
        const geo = new THREE.RingGeometry(0.82, 1.08, TARGET_RING_SEGS, 1);
        geo.rotateX(-Math.PI / 2);
        geo.userData.basePositions = geo.attributes.position.clone();
        const mat = new THREE.MeshBasicMaterial({
            color: TARGET_RING_COLOR, transparent: true, opacity: 0.85,
            depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 1;
        mesh.visible = false;
        mesh.name = 'target-ring';
        return mesh;
    }

    function rollDamage(range) {
        const lo = range[0], hi = range[1];
        return Math.max(1, Math.round(lo + Math.random() * (hi - lo)));
    }

    class AveloraCombat {
        constructor(game) {
            this.game = game;
            this.maxHp = 100;
            this.hp = 100;
            this.isDead = false;
            this.engagement = null;     // current melee target (see header)
            this.pendingHit = null;     // { at, target, weapon }
            this.nextSwingAt = 0;
            this.lastCombatAt = -99;
            this.flash = 0;
            this.vignetteShown = -1;
            this.hpShown = -1;
            this.deathTimers = [];
            this._target = new THREE.Vector3();

            // --- Soft-lock target ---
            this.selectedTarget = null; // creature rec (soft-lock for skills + 2nd-click melee)
            this._ringAge = 0;
            this._targetRing = makeTargetRing();
            game.scene.add(this._targetRing);

            this.hpBar = document.getElementById('hp-bar');
            this.hpFill = document.getElementById('hp-fill');
            this.hpText = document.getElementById('hp-text');
            this.vignette = document.getElementById('damage-vignette');
            this.deathOverlay = document.getElementById('death-overlay');

            // --- Target Frame DOM ---
            this.targetFrame = document.getElementById('target-frame');
            this.targetPortraitWrap = document.getElementById('target-portrait-wrap');
            this.targetPortraitImg = document.getElementById('target-portrait-img');
            this.targetLevelBadge = document.getElementById('target-level-badge');
            this.targetName = document.getElementById('target-name');
            this.targetHpBar = document.getElementById('target-hp-bar');
            this.targetHpFill = document.getElementById('target-hp-fill');
            this.targetHpText = document.getElementById('target-hp-text');
            this.targetRankBadge = document.getElementById('target-rank-badge');
            this.targetStatusBar = document.getElementById('target-status-bar');
            this._targetHpShown = -1;
            this._targetMaxHpShown = -1;

            if (this.targetPortraitWrap) {
                const deselectTarget = (e) => {
                    if (e) {
                        e.stopPropagation();
                        if (e.preventDefault && e.cancelable) e.preventDefault();
                    }
                    window.__avelora_just_ui_tap = performance.now();
                    this.clearTarget();
                };
                this.targetPortraitWrap.addEventListener('click', deselectTarget);
                this.targetPortraitWrap.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    window.__avelora_just_ui_tap = performance.now();
                });
                this.targetPortraitWrap.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    if (e.cancelable) e.preventDefault();
                    window.__avelora_just_ui_tap = performance.now();
                }, { passive: false });
                this.targetPortraitWrap.addEventListener('touchend', deselectTarget, { passive: false });
            }

            if (this.targetFrame) {
                const absorbUI = (e) => {
                    window.__avelora_just_ui_tap = performance.now();
                    e.stopPropagation();
                };
                this.targetFrame.addEventListener('pointerdown', absorbUI);
                this.targetFrame.addEventListener('pointerup', absorbUI);
                this.targetFrame.addEventListener('touchstart', absorbUI, { passive: true });
                this.targetFrame.addEventListener('touchend', absorbUI, { passive: true });
                this.targetFrame.addEventListener('click', absorbUI);
            }

            this.renderHp(true);
        }

        /** New character in play: its max HP, full health, no fight. */
        bindCharacter(config) {
            const hero = this.game.hero;
            this.maxHp = Math.max(1, (hero && hero.state) ? hero.maxHp() : ((config && config.maxHp) || 100));
            this.hp = this.maxHp;
            this.isDead = false;
            this.cancel();
            this.clearTarget();
            this.clearDeathTimers();
            this.flash = 0;
            this.lastCombatAt = -99;
            if (this.deathOverlay) this.deathOverlay.classList.remove('show');
            if (this.game.character) this.game.character.resetDeathPose();
            this.renderHp(true);
        }

        get isAlive() { return !this.isDead; }

        /** Weapon stats of whatever is in the right hand (or fists). */
        weapon() {
            const st = this.game.gameState;
            return window.AveloraItems.weaponOf(st ? st.equipped.right : null);
        }

        // -----------------------------------------------------------
        // Soft-lock target
        // -----------------------------------------------------------
        /** Select a creature as the soft-lock target (visual ring, skill aim, 2nd-click melee). */
        selectTarget(rec) {
            const cr = this.game.creatures;
            if (!rec || !cr || !cr.isAlive(rec)) { this.clearTarget(); return; }
            this.selectedTarget = rec;
            this.renderTargetFrame();
        }

        /** Deselect the current target. */
        clearTarget() {
            this.selectedTarget = null;
            if (this._targetRing) this._targetRing.visible = false;
            this.renderTargetFrame();
        }

        /**
         * Tab-cycle target: picks the nearest living creature that is at most
         * 90° off the character's facing and closer than MAX_TAB_DIST,
         * cycling through them in ascending distance order.
         */
        tabTarget() {
            const cr = this.game.creatures;
            const c = this.game.character;
            if (!cr || !c || this.isDead) return;

            const MAX_TAB_DIST = 24;
            const p = c.position;
            const facing = c.currentRotation; // atan2(dx, dz)+PI convention
            // Facing direction vector: sin(r-PI) = -sin(r), cos(r-PI) = -cos(r)
            const fx = -Math.sin(facing), fz = -Math.cos(facing);

            // Build sorted candidate list (alive, in front, in range)
            const candidates = cr.list
                .filter(rec => {
                    if (!cr.isAlive(rec)) return false;
                    const dx = rec.x - p.x, dz = rec.z - p.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist > MAX_TAB_DIST) return false;
                    // dot product: cos of angle between facing and creature dir
                    const dot = (dx * fx + dz * fz) / (dist || 0.001);
                    return dot > 0.0; // anything in the front 180°
                })
                .sort((a, b) => {
                    const da = Math.hypot(a.x - p.x, a.z - p.z);
                    const db = Math.hypot(b.x - p.x, b.z - p.z);
                    return da - db;
                });

            if (!candidates.length) { this.clearTarget(); return; }

            // Find the current target in the list and advance
            const idx = this.selectedTarget ? candidates.indexOf(this.selectedTarget) : -1;
            const next = candidates[(idx + 1) % candidates.length];
            this.selectTarget(next);
        }

        /**
         * Find existing target or auto-acquire nearest candidate in front of the hero.
         * Used by skills to guarantee projectiles only fire when a valid target exists.
         */
        findBestTarget(maxRange = 16) {
            const cr = this.game.creatures;
            const c = this.game.character;
            if (!cr || !c || this.isDead) return null;

            if (this.selectedTarget && cr.isAlive(this.selectedTarget)) {
                const dist = Math.hypot(this.selectedTarget.x - c.position.x, this.selectedTarget.z - c.position.z);
                if (dist <= maxRange + 4) return this.selectedTarget;
            }

            const p = c.position;
            const facing = (this.game.viewMode === 'first') ? this.game.cameraAngle : c.currentRotation;
            const fx = -Math.sin(facing), fz = -Math.cos(facing);

            const candidates = (cr.list || [])
                .filter(rec => {
                    if (!cr.isAlive(rec)) return false;
                    const dx = rec.x - p.x, dz = rec.z - p.z;
                    const dist = Math.hypot(dx, dz);
                    if (dist > maxRange) return false;
                    if (dist < 3.5) return true; // immediate melee proximity: always targetable
                    const dot = (dx * fx + dz * fz) / (dist || 0.001);
                    return dot > 0.15; // in front cone (~140°)
                })
                .sort((a, b) => {
                    const da = Math.hypot(a.x - p.x, a.z - p.z);
                    const db = Math.hypot(b.x - p.x, b.z - p.z);
                    return da - db;
                });

            if (candidates.length > 0) {
                const best = candidates[0];
                this.selectTarget(best);
                return best;
            }
            return null;
        }

        /**
         * Triggers basic weapon attack (or bare hands) towards soft-lock target,
         * auto-acquired target in front cone, or free directional swing.
         */
        performBasicAttack() {
            if (this.isDead || !this.game.character) return;
            const cr = this.game.creatures;
            const c = this.game.character;

            // 1. If target is already selected and alive, attack it
            let target = this.selectedTarget;
            if (target && cr && cr.isAlive(target)) {
                this.attackCreature(target);
                return;
            }

            // 2. Try to auto-acquire enemy in front
            const acquired = this.autoAcquireTarget(16);
            if (acquired) {
                this.attackCreature(acquired);
                return;
            }

            // 3. Free directional swing / shot if no enemy nearby
            const now = this.game.gameTime;
            const w = this.weapon();
            if (now < this.nextSwingAt) return;
            const sty = w.style;
            const dur = sty === 'bow' ? Math.min(1.0, w.cooldown * 0.95) : Math.min(0.85, w.cooldown * 0.85);
            if (sty === 'bow') c.startSwing(dur, 'bow');
            else if (c.playAttack) c.playAttack(dur, sty);
            else c.startSwing(dur, sty);
            this.nextSwingAt = now + w.cooldown;
        }

        /** Attack a creature record (creatures.js). */
        attackCreature(rec) {
            const cr = this.game.creatures;
            if (!cr || !cr.isAlive(rec) || this.isDead) return;
            this.engage({
                kind: 'creature', rec, label: rec.def.name,
                isValid: () => cr.isAlive(rec) && this.game.creatures === cr,
                x: () => rec.x, z: () => rec.z,
                radius: rec.def.hitRadius || 0.4,
                range: w => w.range,
                onHit: w => cr.damage(rec, Math.max(1, Math.round(rollDamage(w.damage) * (this.game.hero ? this.game.hero.meleeMult(w) : 1))), 'melee')
            });
        }

        /** Generic engagement (creatures above, trees from harvest.js). */
        engage(target) {
            if (this.isDead || !this.game.character) return;
            if (this.game.worldObjects) this.game.worldObjects.cancelPending();
            this.engagement = target;
            target.lastPathAt = -99;
            target.pathFails = 0;
            target.lastGoalX = NaN; target.lastGoalZ = NaN;
            this.updateEngagement(0, true);
        }

        /** Clicked elsewhere / location change: stop fighting (a swing already in the air still finishes visually). */
        cancel() {
            const c = this.game && this.game.character;
            if (c && c._hideHandItemForGather && (!c.swing || c.swing.style !== 'gather')) {
                c._hideHandItemForGather = false;
                if (c.setHandItemVisible) c.setHandItemVisible(true);
            }
            this.engagement = null;
            this.pendingHit = null;
            // NOTE: does NOT clear selectedTarget — target persists until explicitly deselected
        }

        targetCreature() {
            const e = this.engagement;
            return e && e.kind === 'creature' ? e.rec : null;
        }

        /** Distance from the character to the target's EDGE (2D). */
        edgeDistance(e) {
            const p = this.game.character.position;
            return Math.hypot(e.x() - p.x, e.z() - p.z) - (e.radius || 0);
        }

        updateEngagement(delta, force) {
            const e = this.engagement;
            const g = this.game;
            const c = g.character;
            if (!e || !c) return;
            if (!e.isValid()) { this.engagement = null; return; }
            const w = this.weapon();
            const reach = e.range(w);
            const d = this.edgeDistance(e);
            const now = g.gameTime;

            if (d > reach) {
                // Walk toward it; re-path when it moved or the path ran out
                const moved = Math.hypot(e.x() - e.lastGoalX, e.z() - e.lastGoalZ);
                const stopped = !c.isMoving && now - e.lastPathAt > 0.15;
                if (force || stopped || (now - e.lastPathAt >= REPATH_INTERVAL && moved > 0.5)) {
                    // Path ended short of the target again and again (it stands where we can't get
                    // closer, e.g. across water): give up instead of twitching forever
                    if (stopped && !force && (e.stuck = (e.stuck || 0) + 1) > 6) { this.engagement = null; return; }
                    e.lastPathAt = now;
                    e.lastGoalX = e.x(); e.lastGoalZ = e.z();
                    this._target.set(e.x(), 0, e.z());
                    const path = g.pathfinder ? g.pathfinder.findPath(c.position, this._target) : [];
                    if (path && path.length) {
                        c.setPath(path);
                    } else if (++e.pathFails >= MAX_PATH_FAILS) {
                        this.engagement = null; // unreachable
                    }
                }
                return;
            }

            // In reach: stop, face, swing on cooldown
            if (c.isMoving) c.stopMovement();
            c.faceTowards(e.x(), e.z());
            const casting = g.skills && g.skills.casting;
            if (!casting && !c.isSwinging && !c.isCasting && now >= this.nextSwingAt) {
                // gathering a plant: gentle herbal gathering pose with bare hands
                const isGather = e.kind === 'gather';
                if (isGather && c.setHandItemVisible) {
                    c._hideHandItemForGather = true;
                    c.setHandItemVisible(false);
                }
                const sty = isGather ? 'gather' : w.style;
                const dur = isGather ? 0.95 : (sty === 'bow' ? Math.min(1.0, w.cooldown * 0.95) : Math.min(0.85, w.cooldown * 0.85));
                if (sty === 'gather') c.startSwing(dur, 'gather');
                else if (sty === 'bow') c.startSwing(dur, 'bow');
                else if (c.playAttack) c.playAttack(dur, sty);
                else c.startSwing(dur, sty);
                this.nextSwingAt = now + (isGather ? 1.05 : w.cooldown);
                this.pendingHit = { at: now + dur * 0.55, target: e, weapon: w, isGather };
                this.lastCombatAt = now;
            }
        }

        // -----------------------------------------------------------
        // Player health
        // -----------------------------------------------------------
        damagePlayer(amount, source) {
            if (this.isDead || !(amount > 0)) return;
            const g = this.game;
            const hero = g.hero;
            if (hero && hero.state) {
                const c0 = g.character;
                if (Math.random() < hero.dodge()) {
                    if (g.ui && g.ui.floatAt && c0) g.ui.floatAt('Уклонение', 'info', c0.position.x, c0.position.y + 2.0, c0.position.z);
                    return;
                }
                amount = Math.max(1, Math.round(amount * (1 - hero.mitigation())));
                // Mana shield (buff): the rest of the hit is paid with mana
                const before = amount;
                amount = Math.round(hero.absorbDamage(amount));
                if (amount <= 0) {
                    this.lastCombatAt = g.gameTime;
                    if (g.ui && g.ui.floatAt && c0) g.ui.floatAt('Поглощено ' + before, 'info', c0.position.x, c0.position.y + 2.0, c0.position.z);
                    return;
                }
            }
            this.hp = Math.max(0, this.hp - amount);
            this.lastCombatAt = g.gameTime;
            if (this.hp <= this.maxHp * LOW_HP_FLASH_FRAC) this.flash = 1;
            const c = g.character;
            if (g.ui && g.ui.floatAt && c) g.ui.floatAt('−' + Math.round(amount), 'hurt', c.position.x, c.position.y + 2.0, c.position.z);
            window.dispatchEvent(new CustomEvent('game:playerDamaged', { detail: { amount, hp: this.hp, source: source ? source.id : null } }));
            this.renderHp();
            if (this.hp <= 0) this.die();
        }

        heal(amount) {
            if (this.isDead) return;
            this.hp = Math.min(this.maxHp, this.hp + amount);
            this.renderHp();
        }

        die() {
            const g = this.game;
            this.isDead = true;
            this.hp = 0;
            this.cancel();
            if (g.hero) g.hero.clearEffects();
            if (g.worldObjects) g.worldObjects.cancelPending();
            if (g.skills) g.skills.casting = null;
            if (g.character) g.character.startDeathFall();
            this.renderHp(true);
            window.dispatchEvent(new CustomEvent('game:playerDied'));
            this.clearDeathTimers();
            this.deathTimers.push(g.setGameTimeout(() => {
                if (this.deathOverlay) this.deathOverlay.classList.add('show');
            }, DEATH_OVERLAY_DELAY));
            this.deathTimers.push(g.setGameTimeout(() => this.respawn(), DEATH_OVERLAY_DELAY + RESPAWN_DELAY));
        }

        clearDeathTimers() {
            this.deathTimers.forEach(id => this.game.clearGameTimeout(id));
            this.deathTimers.length = 0;
        }

        respawn() {
            const g = this.game;
            this.clearDeathTimers();
            if (!g.character || !g.location) return;
            this.isDead = false;
            this.hp = this.maxHp;
            this.flash = 0;
            this.lastCombatAt = -99;
            const spawn = g.resolveSpawn(g.location, null); // the location's default spawn
            g.character.resetDeathPose();
            g.character.teleport(spawn.x, spawn.z, spawn.r);
            g.cameraTarget.copy(g.character.position);
            g.updateCameraPosition(true);
            if (g.creatures) g.creatures.resetAll();
            if (this.deathOverlay) this.deathOverlay.classList.remove('show');
            this.renderHp(true);
            g.saveProgress();
            window.dispatchEvent(new CustomEvent('game:playerRespawned'));
        }

        // -----------------------------------------------------------
        // Per-frame
        // -----------------------------------------------------------
        update(delta) {
            const g = this.game;
            const now = g.gameTime;

            if (!this.isDead) {
                // Hit of a swing in flight
                const ph = this.pendingHit;
                if (ph && now >= ph.at) {
                    this.pendingHit = null;
                    const e = ph.target;
                    if (e.isValid() && g.character && this.edgeDistance(e) <= e.range(ph.weapon) + HIT_TOLERANCE) {
                        // bow / staff basic attack on a creature = a projectile; trees, plants etc. just get the hit
                        const ws = ph.weapon.style;
                        if ((ws === 'bow' || ws === 'staff') && e.kind === 'creature' && g.skills && g.skills.shootBasic) g.skills.shootBasic(e.rec, ph.weapon);
                        else e.onHit(ph.weapon);
                        this.lastCombatAt = now;
                    }
                }
                if (this.engagement) this.updateEngagement(delta, false);

                const cfgHpRegen = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.hpRegen) || {};
                const rDelay = Number.isFinite(cfgHpRegen.delay) ? cfgHpRegen.delay : REGEN_DELAY;
                const rFrac = Number.isFinite(cfgHpRegen.percent) ? cfgHpRegen.percent : REGEN_PER_SEC;
                if (this.hp < this.maxHp && now - this.lastCombatAt >= rDelay) {
                    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * rFrac * delta);
                    this.renderHp();
                }
            }

            // --- Target ring and leash update ---
            const sel = this.selectedTarget;
            const cr = g.creatures;
            const char = g.character;

            // Auto-clear target:
            // 1) Agro mob broke off combat and is returning home (leash reset)
            // 2) Player moved extremely far away (beyond 90m view distance)
            if (sel && cr && char && char.position) {
                const distToTarget = Math.hypot(sel.x - char.position.x, sel.z - char.position.z);
                if (sel.state === 'return' || distToTarget > 90.0) {
                    this.clearTarget();
                }
            }

            const currentSel = this.selectedTarget;
            if (currentSel && cr && cr.isAlive(currentSel) && this._targetRing) {
                const ring = this._targetRing;
                this._ringAge += delta;
                const pulse = 0.65 + 0.35 * Math.sin(this._ringAge * 3.5);
                ring.material.opacity = 0.75 * pulse;
                ring.material.color.setHex(currentSel.def.behavior === 'aggressive' ? TARGET_RING_COLOR_AGGRO : TARGET_RING_COLOR);
                const r = Math.max(0.55, (currentSel.def.hitRadius || 0.4) * 1.15);
                if (this._ringX === undefined ||
                    Math.abs(currentSel.x - this._ringX) + Math.abs(currentSel.z - this._ringZ) + Math.abs(r - this._ringR) > 0.03) {
                    this._ringX = currentSel.x;
                    this._ringZ = currentSel.z;
                    this._ringR = r;
                    const gy = (g.terrain && g.terrain.getHeightAt) ? g.terrain.getHeightAt(currentSel.x, currentSel.z) : currentSel.y;
                    ring.position.set(currentSel.x, gy, currentSel.z);
                    ring.scale.set(1, 1, 1);

                    const pos = ring.geometry.attributes.position;
                    const base = ring.geometry.userData.basePositions;
                    if (pos && base) {
                        const count = pos.count;
                        const hasTerrain = Boolean(g.terrain && g.terrain.getHeightAt);
                        for (let i = 0; i < count; i++) {
                            const bx = base.getX(i) * r;
                            const bz = base.getZ(i) * r;
                            const wy = hasTerrain ? (g.terrain.getHeightAt(currentSel.x + bx, currentSel.z + bz) + 0.05) : (gy + 0.05);
                            pos.setXYZ(i, bx, wy - gy, bz);
                        }
                        pos.needsUpdate = true;
                    }
                }
                ring.visible = true;
            } else {
                if (this._targetRing) this._targetRing.visible = false;
                // Auto-clear dead/gone target
                if (currentSel && cr && !cr.isAlive(currentSel)) this.selectedTarget = null;
            }

            // Red screen-edge flash (game time -> frozen on pause) + faint low-HP glow
            if (this.flash > 0) this.flash = Math.max(0, this.flash - delta / FLASH_DECAY);
            const low = !this.isDead && this.hp < this.maxHp * 0.3 ? 0.35 : 0;
            const v = Math.round(Math.max(low, this.flash) * 50) / 50;
            if (v !== this.vignetteShown && this.vignette) {
                this.vignetteShown = v;
                this.vignette.style.opacity = String(v);
            }

            // --- Target Frame HUD update ---
            this.renderTargetFrame();
        }

        renderTargetFrame() {
            const frame = this.targetFrame;
            if (!frame) return;
            const sel = this.selectedTarget;
            const cr = this.game.creatures;
            if (!sel || !cr || !cr.isAlive(sel)) {
                if (this._targetIdShown !== null) {
                    frame.style.display = 'none';
                    frame.classList.remove('active', 'elite', 'boss');
                    if (this.targetPortraitWrap) {
                        this.targetPortraitWrap.classList.remove('elite', 'boss', 'aggro', 'neutral');
                    }
                    this._targetIdShown = null;
                    this._targetHpShown = -1;
                    this._targetMaxHpShown = -1;
                    this._targetFxSig = '';
                }
                return;
            }

            const def = sel.def || {};
            const heroLvl = (this.game.hero && this.game.hero.level) || 1;
            if (this._targetIdShown !== sel.id || this._targetHeroLvlShown !== heroLvl) {
                this._targetIdShown = sel.id;
                this._targetHeroLvlShown = heroLvl;
                this._targetHpShown = -1;
                this._targetMaxHpShown = -1;
                this._targetFxSig = '';

                frame.style.display = 'flex';
                frame.classList.add('active');

                const isAggro = def.behavior === 'aggressive';
                const rank = sel.rank || def.rank || 'normal';

                frame.classList.toggle('elite', rank === 'elite');
                frame.classList.toggle('boss', rank === 'boss');

                // Окантовка портрета: красная для агро, золотисто-желтая для мирных, плюс аура элиты/босса
                if (this.targetPortraitWrap) {
                    this.targetPortraitWrap.classList.toggle('aggro', isAggro);
                    this.targetPortraitWrap.classList.toggle('neutral', !isAggro);
                    this.targetPortraitWrap.classList.toggle('elite', rank === 'elite');
                    this.targetPortraitWrap.classList.toggle('boss', rank === 'boss');
                }

                // Бейдж ранга (Элита / БОСС)
                if (this.targetRankBadge) {
                    if (rank === 'elite') {
                        this.targetRankBadge.style.display = 'inline-block';
                        this.targetRankBadge.className = 'target-rank-badge elite';
                        this.targetRankBadge.textContent = 'Элита';
                    } else if (rank === 'boss') {
                        this.targetRankBadge.style.display = 'inline-block';
                        this.targetRankBadge.className = 'target-rank-badge boss';
                        this.targetRankBadge.textContent = 'БОСС';
                    } else {
                        this.targetRankBadge.style.display = 'none';
                    }
                }

                // Портрет: используем отрендеренную 3D-морду из iconData (или эмодзи-фоллбек)
                const iconData = def.iconData || '';
                if (this.targetPortraitImg) {
                    if (iconData) {
                        if (this.targetPortraitImg.dataset.iconKey !== sel.type) {
                            this.targetPortraitImg.dataset.iconKey = sel.type;
                            this.targetPortraitImg.textContent = '';
                            this.targetPortraitImg.style.backgroundImage = `url("${iconData}")`;
                            this.targetPortraitImg.style.backgroundSize = 'cover';
                        }
                    } else {
                        delete this.targetPortraitImg.dataset.iconKey;
                        this.targetPortraitImg.style.backgroundImage = 'none';
                        const fallbackIcon = (def.icon) || CREATURE_ICONS[sel.type] || '👾';
                        if (this.targetPortraitImg.textContent !== fallbackIcon) {
                            this.targetPortraitImg.textContent = fallbackIcon;
                        }
                    }
                }

                // Уровень цели и цветовой класс опасности (относительно уровня героя)
                const lvl = sel.level || def.level || 1;
                const diff = lvl - heroLvl;
                let threatClass = 'lvl-normal';
                if (diff <= -4) threatClass = 'lvl-trivial';
                else if (diff <= -2) threatClass = 'lvl-easy';
                else if (diff <= 1) threatClass = 'lvl-normal';
                else if (diff <= 3) threatClass = 'lvl-hard';
                else threatClass = 'lvl-deadly';

                if (this.targetLevelBadge) {
                    this.targetLevelBadge.className = `target-level-badge ${threatClass}`;
                    const label = String(lvl);
                    if (this.targetLevelBadge.textContent !== label) {
                        this.targetLevelBadge.textContent = label;
                    }
                    this.targetLevelBadge.title = `Уровень цели: ${lvl}` + (rank !== 'normal' ? ` (${rank})` : '');
                }

                const name = def.name || sel.type;
                if (this.targetName && this.targetName.textContent !== name) {
                    this.targetName.textContent = name;
                }
            }

            // Здоровье моба
            const curHp = Math.max(0, Math.ceil(sel.hp));
            const maxHp = Math.max(1, Math.ceil(sel.maxHp));
            if (curHp !== this._targetHpShown || maxHp !== this._targetMaxHpShown) {
                this._targetHpShown = curHp;
                this._targetMaxHpShown = maxHp;
                const frac = Math.max(0, Math.min(1, curHp / maxHp));
                if (this.targetHpFill) this.targetHpFill.style.width = (frac * 100).toFixed(1) + '%';
                if (this.targetHpText) this.targetHpText.textContent = `${curHp} / ${maxHp}`;
                if (this.targetHpBar) this.targetHpBar.title = `Здоровье цели: ${curHp} / ${maxHp}`;
            }

            // Бафы и дебафы цели (Оглушение, Замедление и др.)
            this.renderTargetEffects(sel);
        }

        renderTargetEffects(sel) {
            const bar = this.targetStatusBar;
            if (!bar) return;
            const stunSec = sel.stunT > 0 ? Math.ceil(sel.stunT) : 0;
            const slowSec = sel.slowT > 0 ? Math.ceil(sel.slowT) : 0;
            const sig = `${stunSec}:${slowSec}`;
            if (sig === this._targetFxSig) return;
            this._targetFxSig = sig;

            if (!stunSec && !slowSec) {
                if (bar.style.display !== 'none') bar.style.display = 'none';
                return;
            }

            const effects = [];
            if (stunSec > 0) {
                effects.push({
                    id: 'stun',
                    kind: 'debuff',
                    name: 'Оглушение',
                    icon: '⚡',
                    t: sel.stunT,
                    sec: stunSec
                });
            }
            if (slowSec > 0) {
                effects.push({
                    id: 'slow',
                    kind: 'debuff',
                    name: 'Замедление',
                    icon: '❄️',
                    t: sel.slowT,
                    sec: slowSec
                });
            }

            if (bar.style.display === 'none') bar.style.display = 'flex';
            bar.innerHTML = '';
            effects.forEach(ef => {
                const el = document.createElement('div');
                el.className = `status-fx ${ef.kind}`;
                el.title = `${ef.name}: ${ef.t.toFixed(1)} с`;
                const iconSpan = document.createElement('span');
                iconSpan.className = 'status-fx-icon status-fx-glyph';
                iconSpan.textContent = ef.icon;
                const tm = document.createElement('span');
                tm.className = 'status-fx-time';
                tm.textContent = ef.sec;
                el.append(iconSpan, tm);
                bar.appendChild(el);
            });
        }

        renderHp(force) {
            const shown = Math.ceil(this.hp);
            if (!force && shown === this.hpShown) return;
            this.hpShown = shown;
            const frac = Math.max(0, Math.min(1, this.hp / this.maxHp));
            if (this.hpFill) this.hpFill.style.width = (frac * 100).toFixed(1) + '%';
            if (this.hpText) this.hpText.textContent = `${shown} / ${this.maxHp}`;
            if (this.hpBar) {
                this.hpBar.title = `Здоровье: ${shown} / ${this.maxHp}`;
                this.hpBar.classList.toggle('low', frac < 0.3);
            }
        }
    }

    window.AveloraCombat = AveloraCombat;
})();
