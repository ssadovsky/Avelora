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

    // Target indicator: flat ring drawn under the selected creature's feet
    const TARGET_RING_SEGS = 40;
    const TARGET_RING_COLOR = 0xffdd44;

    function makeTargetRing() {
        const geo = new THREE.RingGeometry(0.82, 1.08, TARGET_RING_SEGS);
        const mat = new THREE.MeshBasicMaterial({
            color: TARGET_RING_COLOR, transparent: true, opacity: 0.85,
            depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
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
            this.renderHp(true);
        }

        /** New character in play: its max HP, full health, no fight. */
        bindCharacter(config) {
            this.maxHp = Math.max(1, (config && config.maxHp) || 100);
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
        }

        /** Deselect the current target. */
        clearTarget() {
            this.selectedTarget = null;
            if (this._targetRing) this._targetRing.visible = false;
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

        // -----------------------------------------------------------
        // Engagement
        // -----------------------------------------------------------
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
                onHit: w => cr.damage(rec, rollDamage(w.damage), 'melee')
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
                const dur = Math.min(0.85, w.cooldown * 0.85);
                if (c.playAttack) c.playAttack(dur, w.style);
                else c.startSwing(dur, w.style);
                this.nextSwingAt = now + w.cooldown;
                this.pendingHit = { at: now + dur * window.MedievalCharacter.SWING_HIT_FRAC, target: e, weapon: w };
                this.lastCombatAt = now;
            }
        }

        // -----------------------------------------------------------
        // Player health
        // -----------------------------------------------------------
        damagePlayer(amount, source) {
            if (this.isDead || !(amount > 0)) return;
            const g = this.game;
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
                        if (ph.weapon.style === 'staff' && g.character.staffZap) g.character.staffZap(e.x(), e.z());
                        e.onHit(ph.weapon);
                        this.lastCombatAt = now;
                    }
                }
                if (this.engagement) this.updateEngagement(delta, false);

                if (this.hp < this.maxHp && now - this.lastCombatAt >= REGEN_DELAY) {
                    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * REGEN_PER_SEC * delta);
                    this.renderHp();
                }
            }

            // --- Target ring update ---
            const sel = this.selectedTarget;
            const cr = g.creatures;
            if (sel && cr && cr.isAlive(sel) && this._targetRing) {
                const ring = this._targetRing;
                this._ringAge += delta;
                const pulse = 0.65 + 0.35 * Math.sin(this._ringAge * 3.5);
                ring.material.opacity = 0.75 * pulse;
                const gy = g.terrain ? g.terrain.getHeightAt(sel.x, sel.z) : sel.y;
                ring.position.set(sel.x, gy + 0.06, sel.z);
                const r = Math.max(0.55, (sel.def.hitRadius || 0.4) * 1.15);
                ring.scale.setScalar(r);
                ring.visible = true;
            } else {
                if (this._targetRing) this._targetRing.visible = false;
                // Auto-clear dead/gone target
                if (sel && cr && !cr.isAlive(sel)) this.selectedTarget = null;
            }

            // Red screen-edge flash (game time -> frozen on pause) + faint low-HP glow
            if (this.flash > 0) this.flash = Math.max(0, this.flash - delta / FLASH_DECAY);
            const low = !this.isDead && this.hp < this.maxHp * 0.3 ? 0.35 : 0;
            const v = Math.round(Math.max(low, this.flash) * 50) / 50;
            if (v !== this.vignetteShown && this.vignette) {
                this.vignetteShown = v;
                this.vignette.style.opacity = String(v);
            }
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
