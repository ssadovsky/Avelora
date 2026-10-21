/**
 * Avelora — Skills: registry, casting, cooldowns, projectiles & VFX
 *
 * Skill definitions come from `window.GAME_CONTENT.skills` (content/skills/<id>/
 * skill.json); which character has which skills from GAME_CONTENT.characters
 * (content/characters/<charId>/skills.json — no file = no skills).
 *
 * Skill behaviour is implemented GENERICALLY by `type`, parameterised by the
 * JSON. Currently: type "projectile" (Spark):
 *   - aim: ground point under the last mouse position over the world (raycast
 *     terrain), clamped to `range`; last input was touch / no valid point ->
 *     straight ahead (character's facing) at full `range`.
 *   - `cooldown` (game seconds, starts at activation), `castTime` (character
 *     stops, turns to the target, projectile leaves the right hand after it),
 *     `speed` (m/s), straight flight to ground point + 0.3 m.
 *   - aim at a CREATURE: hovering one with the mouse aims at its body; after
 *     touch input the creature the player is fighting (tap = engage) is the aim.
 *   - impact: target reached / beyond range / dipped under terrain / entered a
 *     creature's body cylinder (creatures.js hitTest -> impact AT the creature),
 *     a tree, boulder, shrub or prop (simple radius+height test; felled trees
 *     no longer count). Fires window 'game:skillImpact' {skillId, point, radius,
 *     damage, amount}; creatures.js listens and applies `amount` to every
 *     creature within `radius` (= vfx.impactRadius) — direct hit + splash.
 *
 * VFX (additive, textures generated once from canvas radial gradients):
 *   Additive light alone washes out to white over the bright meadow, so each
 *   effect also gets a dark, NORMAL-blended underlay drawn first (a soft halo
 *   behind the projectile, a scorch mark under the impact) — that local contrast
 *   is what lets the skill color read on any ground.
 *   projectile = white star-flare core (rotating) + larger colored glow sprite
 *   (flicker/pulse) + fading, shrinking trail and shed sparks (THREE.Points with a
 *   tiny custom shader — one draw call for all trails, one for all sparks) +
 *   3 flickering lightning filaments (LineSegments re-jittered every ~45 ms).
 *   impact = expanding flash + colored bloom (~0.25-0.35 s), `impactSparks`
 *   sparks with gravity/ground bounce (~0.6 s), expanding ground ring of
 *   `impactRadius`, a ground glow decal and a few short lightning arcs.
 * Performance: everything is pooled and pre-allocated (MAX_* below); the
 * per-frame path allocates nothing. No THREE lights are ever added (a new light
 * would force every lit material to recompile). All of it advances only via
 * update(delta) -> frozen while paused. clearAll() on location change / teardown.
 *
 * type "teleport" ("Возвращение домой", home_recall): a held channel (`castTime` seconds,
 * character.startChannel() holds the cast pose; golden rune VFX in recall_fx.js), broken by
 * movement / attack / damage / death. Completing it starts the cooldown, remembers the current
 * location (state.returnTo) and calls game.changeLocation(). Used on its own destination
 * (`destination`, e.g. homeCamp) it goes back to state.returnTo instead (fallback: the start
 * location). An "arrival" rune burst plays at the destination (`game:location` event).
 */
(function () {
    'use strict';

    const MAX_PROJECTILES = 6;
    const MAX_IMPACTS = 9;      // + meteors of the fire rain
    const MAX_SPARKS = 360;
    const MAX_TRAIL_POINTS = 640;
    const FILAMENTS = 3, FILAMENT_SEGS = 4;
    const ARCS = 6, ARC_SEGS = 5;
    const GRAVITY = 11.0;
    const AIM_HEIGHT = 0.3;          // projectile aims this far above the ground point
    const TRAIL_FADE = 0.16;         // seconds for the trail to collapse after impact
    const IMPACT_LIFE = 1.3;         // seconds an impact record lives (the scorch mark is the last to fade)
    const MAX_STRIKES = 3;
    const STRIKE_BOLTS = 6;
    const STRIKE_SEGS = 18;
    const STRIKE_LIFE = 0.35;

    // ---------------------------------------------------------------
    // Canvas textures (generated once per session)
    // ---------------------------------------------------------------
    function canvasTexture(size, draw) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        draw(c.getContext('2d'), size);
        const t = new THREE.CanvasTexture(c);
        t.needsUpdate = true;
        return t;
    }

    function radial(ctx, size, stops) {
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        stops.forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
    }

    function makeTextures() {
        return {
            glow: canvasTexture(64, (ctx, s) => radial(ctx, s, [[0, 1], [0.18, 0.72], [0.42, 0.26], [0.7, 0.07], [1, 0]])),
            dot: canvasTexture(32, (ctx, s) => radial(ctx, s, [[0, 1], [0.3, 0.85], [0.55, 0.25], [1, 0]])),
            ring: canvasTexture(128, (ctx, s) => radial(ctx, s, [[0, 0.06], [0.55, 0.1], [0.74, 0.55], [0.82, 1], [0.9, 0.35], [1, 0]])),
            // Star flare: hot core + 4 thin rays (long H/V, shorter diagonals)
            flare: canvasTexture(128, (ctx, s) => {
                radial(ctx, s, [[0, 1], [0.08, 0.95], [0.2, 0.4], [0.45, 0.08], [1, 0]]);
                ctx.globalCompositeOperation = 'lighter';
                const rays = [[0, 1.0, 3], [Math.PI / 2, 1.0, 3], [Math.PI / 4, 0.55, 2], [-Math.PI / 4, 0.55, 2]];
                rays.forEach(([ang, len, w]) => {
                    const L = s / 2 * len;
                    ctx.save();
                    ctx.translate(s / 2, s / 2);
                    ctx.rotate(ang);
                    const g = ctx.createLinearGradient(-L, 0, L, 0);
                    g.addColorStop(0, 'rgba(255,255,255,0)');
                    g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
                    g.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.fillStyle = g;
                    ctx.fillRect(-L, -w / 2, 2 * L, w);
                    ctx.restore();
                });
            })
        };
    }

    // ---------------------------------------------------------------
    // Point batch: many soft particles in ONE draw call (custom shader,
    // per-point size in world meters + RGBA). Buffers are fixed-size.
    // ---------------------------------------------------------------
    class PointBatch {
        constructor(capacity, texture) {
            this.capacity = capacity;
            this.count = 0;
            this.pos = new Float32Array(capacity * 3);
            this.col = new Float32Array(capacity * 4);
            this.size = new Float32Array(capacity);
            const geo = new THREE.BufferGeometry();
            this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
            this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
            this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
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
                        gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 128.0);
                        gl_Position = projectionMatrix * mv;
                    }`,
                fragmentShader: `
                    uniform sampler2D uMap;
                    varying vec4 vColor;
                    void main() {
                        vec4 t = texture2D(uMap, gl_PointCoord);
                        gl_FragColor = vec4(vColor.rgb * t.rgb, t.a * vColor.a);
                    }`,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
            this.points = new THREE.Points(geo, mat);
            this.points.frustumCulled = false;
            this.points.renderOrder = 10;
            this.points.visible = false;
        }

        begin() { this.count = 0; }

        push(x, y, z, r, g, b, a, size) {
            if (this.count >= this.capacity || a <= 0.003) return;
            const i = this.count++;
            this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
            this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
            this.size[i] = size;
        }

        end(scale) {
            const n = this.count;
            this.uniforms.uScale.value = scale;
            this.points.visible = n > 0;
            this.points.geometry.setDrawRange(0, n);
            if (n > 0) {
                this.aPos.updateRange.count = n * 3; this.aPos.needsUpdate = true;
                this.aCol.updateRange.count = n * 4; this.aCol.needsUpdate = true;
                this.aSize.updateRange.count = n; this.aSize.needsUpdate = true;
            }
        }
    }

    function additiveSprite(texture, normal) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texture, transparent: true, depthWrite: false,
            blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending, toneMapped: false
        }));
        s.visible = false;
        s.renderOrder = normal ? 8 : 11; // dark underlays first, light on top
        return s;
    }

    function additivePlane(texture, normal) {
        const geo = new THREE.PlaneGeometry(1, 1);
        geo.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            map: texture, transparent: true, depthWrite: false,
            blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending,
            toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        }));
        m.visible = false;
        m.renderOrder = normal ? 7 : 9;
        return m;
    }

    function boltLines(bolts, segs) {
        const geo = new THREE.BufferGeometry();
        const arr = new Float32Array(bolts * segs * 2 * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3).setUsage(THREE.DynamicDrawUsage));
        const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
        }));
        line.frustumCulled = false;
        line.visible = false;
        line.renderOrder = 12;
        return line;
    }

    /**
     * Writes `count` jagged bolts (each `segs` segments) into a LineSegments
     * position buffer, in LOCAL space around the origin. dirY scales the vertical
     * spread (0.25 for arcs crawling along the ground, 1 for a spherical crackle).
     */
    function writeBolts(line, count, segs, minLen, maxLen, dirY, jitter) {
        const arr = line.geometry.attributes.position.array;
        let k = 0;
        for (let b = 0; b < count; b++) {
            let dx = Math.random() * 2 - 1, dy = (Math.random() * 2 - 1) * dirY, dz = Math.random() * 2 - 1;
            if (dirY < 1) dy = Math.abs(dy) + 0.05;
            const inv = 1 / Math.max(1e-4, Math.sqrt(dx * dx + dy * dy + dz * dz));
            dx *= inv; dy *= inv; dz *= inv;
            const len = minLen + Math.random() * (maxLen - minLen);
            let px = 0, py = 0, pz = 0;
            for (let s = 1; s <= segs; s++) {
                const t = s / segs;
                const j = s === segs ? 0.35 : 1.0;
                const nx = dx * len * t + (Math.random() - 0.5) * jitter * len * j;
                const ny = dy * len * t + (Math.random() - 0.5) * jitter * len * j;
                const nz = dz * len * t + (Math.random() - 0.5) * jitter * len * j;
                arr[k++] = px; arr[k++] = py; arr[k++] = pz;
                arr[k++] = nx; arr[k++] = ny; arr[k++] = nz;
                px = nx; py = ny; pz = nz;
            }
        }
        line.geometry.attributes.position.needsUpdate = true;
    }

    /** Writes a tight, beautiful, concentrated lightning cluster crashing directly into the target */
    function writeVerticalBolt(line, height, jitter) {
        const arr = line.geometry.attributes.position.array;
        let k = 0;
        const maxJitter = 0.32; // maximum jitter radius: strictly within 32 cm of target center

        // 6 distinct bolts crashing down together in a tight cluster directly into (0, 0, 0):
        for (let b = 0; b < STRIKE_BOLTS; b++) {
            // Small offset in the sky (within 20 cm of center)
            const topAngle = (b / STRIKE_BOLTS) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
            const topR = 0.14 + (Math.random() - 0.5) * 0.08;
            const topX = Math.cos(topAngle) * topR;
            const topZ = Math.sin(topAngle) * topR;

            // Target landing point: exactly (0, 0, 0)
            const botX = (Math.random() - 0.5) * 0.06;
            const botZ = (Math.random() - 0.5) * 0.06;

            let prevX = topX;
            let prevY = height;
            let prevZ = topZ;

            // Phase and spiral for natural electrical braid
            const spiralSpeed = 2.0 + (b % 2) * 1.5;
            const spiralDir = (b % 2 === 0) ? 1 : -1;
            const braidPhase = (b / STRIKE_BOLTS) * Math.PI * 2;

            for (let s = 1; s <= STRIKE_SEGS; s++) {
                const t = s / STRIKE_SEGS;
                // Base interpolation from sky to target
                const baseX = topX + (botX - topX) * t;
                const baseZ = topZ + (botZ - topZ) * t;

                // Envelope: 0 in sky, 0 at target impact point, peak in mid-air
                const env = Math.sin(t * Math.PI);

                // Tight braid wave around the central axis
                const braidR = 0.15 * env;
                const braidAngle = t * Math.PI * spiralSpeed * spiralDir + braidPhase;
                const waveX = Math.cos(braidAngle) * braidR;
                const waveZ = Math.sin(braidAngle) * braidR;

                // Electric jagged jitter
                const jX = (Math.random() - 0.5) * maxJitter * env;
                const jZ = (Math.random() - 0.5) * maxJitter * env;

                const curX = (s === STRIKE_SEGS) ? botX : (baseX + waveX + jX);
                const curY = height * (1 - t);
                const curZ = (s === STRIKE_SEGS) ? botZ : (baseZ + waveZ + jZ);

                arr[k++] = prevX; arr[k++] = prevY; arr[k++] = prevZ;
                arr[k++] = curX;  arr[k++] = curY;  arr[k++] = curZ;

                prevX = curX;
                prevY = curY;
                prevZ = curZ;
            }
        }

        line.geometry.attributes.position.needsUpdate = true;
    }

    function writeVerticalBoltCore(line, height, jitter) {
        const arr = line.geometry.attributes.position.array;
        let k = 0;
        const maxJitter = 0.12; // super tight core (12 cm)

        for (let b = 0; b < 2; b++) {
            let prevX = (Math.random() - 0.5) * 0.08;
            let prevY = height;
            let prevZ = (Math.random() - 0.5) * 0.08;

            for (let s = 1; s <= STRIKE_SEGS; s++) {
                const t = s / STRIKE_SEGS;
                const env = Math.sin(t * Math.PI);
                const curX = (s === STRIKE_SEGS) ? 0 : (prevX + (Math.random() - 0.5) * maxJitter * env);
                const curY = height * (1 - t);
                const curZ = (s === STRIKE_SEGS) ? 0 : (prevZ + (Math.random() - 0.5) * maxJitter * env);

                arr[k++] = prevX; arr[k++] = prevY; arr[k++] = prevZ;
                arr[k++] = curX;  arr[k++] = curY;  arr[k++] = curZ;

                prevX = curX;
                prevY = curY;
                prevZ = curZ;
            }
        }

        line.geometry.attributes.position.needsUpdate = true;
    }

    // ---------------------------------------------------------------
    // Skill system
    // ---------------------------------------------------------------
    class AveloraSkillSystem {
        constructor(game) {
            this.game = game;
            this.readyAt = {};        // skillId -> gameTime when usable again
            this.cdDuration = {};     // skillId -> last cooldown length (for the UI sweep)
            this.casting = null;      // { def, target: Vector3, t }
            this.channel = null;      // teleport channel: { def, dest, spawn, from, t, dur, fx }
            this.pendingArrival = null; // { def } — play the arrival burst once the new location is up
            this.recallFx = null;     // lazily created AveloraRecallFX
            this.res = null;          // lazily created VFX resources (pools)

            // Scratch objects (no per-frame allocation)
            this._v1 = new THREE.Vector3();
            this._v2 = new THREE.Vector3();
            this._v3 = new THREE.Vector3();
            this._color = new THREE.Color();
            this._white = new THREE.Color(1, 1, 1);
            this._mouse = new THREE.Vector2();
            this._bufSize = new THREE.Vector2();
            this._blockers = null;
            this._blockersEnv = null;

            // Damage breaks a teleport channel; the arrival burst waits for the new location.
            window.addEventListener('game:playerDamaged', () => this.interruptChannel('damage'));
            window.addEventListener('game:location', () => this.playArrival());
        }

        get(id) {
            const defs = (window.GAME_CONTENT && window.GAME_CONTENT.skills) || {};
            return (id && Object.prototype.hasOwnProperty.call(defs, id)) ? defs[id] : null;
        }

        /** Skill defs of a character (empty -> the skills button is hidden). */
        forCharacter(charId) {
            const st = this.game.gameState;
            // charId is the CLASS id ('mage'); the state's characterId is the slot id ('slot_...'), so compare the class too
            const learned = (st && (st.characterId === charId || st.classId === charId)) ? st.learnedSkills : [];
            const ids = window.AveloraState ? window.AveloraState.characterSkills(charId, learned) : [];
            return ids.map(id => this.get(id)).filter(Boolean);
        }

        hasSkill(charId, skillId) {
            return this.forCharacter(charId).some(d => d.id === skillId);
        }

        cooldownRemaining(id) {
            return Math.max(0, (this.readyAt[id] || 0) - this.game.gameTime);
        }

        /** 1 right after activation -> 0 when ready. */
        cooldownFraction(id) {
            const rem = this.cooldownRemaining(id);
            const d = this.cdDuration[id] || 0;
            return rem > 0 && d > 0 ? Math.min(1, rem / d) : 0;
        }

        /** Activates a skill for the current character. Returns 'ok' | 'cooldown' | 'busy' | 'unavailable'. */
        activate(skillId) {
            const g = this.game;
            const def = this.get(skillId);
            const charCfg = g.currentCharacterConfig;
            if (!def || !g.character || !charCfg || !this.hasSkill(charCfg.id, skillId)) return 'unavailable';
            if (!g.isReady || g.isPaused || g.isTransitioning || !g.terrain) return 'unavailable';
            if (this.casting || this.channel) return 'busy';
            // Re-using an active buff (mana shield) switches it off — no cost, not blocked by the cooldown
            if (def.type === 'buff' && def.buff && g.hero && g.hero.removeEffect(def.buff.id || def.id)) {
                if (g.ui && g.ui.floatText) g.ui.floatText(this.labelOf(def).name + ': снят', 'info');
                return 'ok';
            }
            if (this.cooldownRemaining(skillId) > 0) return 'cooldown';
            if (g.combat && g.combat.isDead) return 'unavailable';

            if (def.type === 'teleport') return this.startTeleport(def);
            if (def.type === 'blink') return this.startBlink(def);
            if (def.type === 'buff') return this.startBuff(def);
            if (def.type === 'nova') return this.startNova(def);

            if (def.type === 'projectile' || def.type === 'rain' || def.type === 'strike') {   // need a target
                const tgt = g.combat && g.combat.selectedTarget;
                const cr = g.creatures;
                if (!tgt || !cr || !cr.isAlive(tgt)) {
                    if (tgt && g.combat && g.combat.clearTarget) {
                        g.combat.clearTarget();
                    }
                    if (g.ui && g.ui.floatText) g.ui.floatText('Нет цели', 'warn');
                    return 'no_target';
                }

                const c = g.character;
                const range = (def.range || 12) + 2;
                const dist = Math.hypot(tgt.x - c.position.x, tgt.z - c.position.z);
                if (dist > range) {
                    if (g.ui && g.ui.floatText) g.ui.floatText('Цель слишком далеко', 'warn');
                    return 'out_of_range';
                }

                if (!this.payMana(def)) {
                    return 'mana';
                }
                const target = this.pickTarget(def, new THREE.Vector3());
                if (c.isMoving) c.stopMovement();
                if (g.worldObjects) g.worldObjects.cancelPending();
                c.faceTowards(target.x, target.z);
                this.startCooldown(def);
                const castDur = Math.max(0, def.castTime || 0);
                this.casting = { def, target, tgt, t: castDur };
                this.ensureResources();
                if (c.playCast) c.playCast(castDur || 0.6);
                else c.startSwing(castDur || 0.6);
                return 'ok';
            }
            console.warn(`[Avelora] skill "${skillId}": type "${def.type}" is not implemented`);
            return 'unavailable';
        }

        // ---------------------------------------------------------------
        // Teleport ("Возвращение домой")
        // ---------------------------------------------------------------
        getRecallFx() {
            if (!this.recallFx && window.AveloraRecallFX) this.recallFx = new window.AveloraRecallFX(this.game);
            return this.recallFx;
        }

        /** Name/description for the UI: a teleport used on its own destination reads "Возвращение в мир". */
        labelOf(def) {
            const here = this.game.location && this.game.location.id;
            if (def && def.type === 'teleport' && here === def.destination) {
                return { name: def.backName || def.name, description: def.backDescription || def.description };
            }
            return { name: def.name, description: def.description };
        }

        /** Where a teleport skill leads from the current location: { dest, spawn } or null. */
        teleportRoute(def) {
            const g = this.game, here = g.location && g.location.id;
            if (here === def.destination) {
                const back = g.gameState && g.gameState.returnTo;
                let dest = (back && back !== here && window.LOCATIONS[back]) ? back : (window.START_LOCATION || null);
                if (!dest || dest === here || !window.LOCATIONS[dest]) return null;
                const pos = (dest === back && g.gameState.returnPos) ? g.gameState.returnPos : null;
                return { dest, spawn: null, pos };   // no saved spot -> the location's default spawn
            }
            if (!window.LOCATIONS[def.destination]) return null;
            return { dest: def.destination, spawn: def.spawn || null, pos: null };
        }

        startTeleport(def) {
            const g = this.game, c = g.character;
            const route = this.teleportRoute(def);
            const fxSys = this.getRecallFx();
            if (!route || !fxSys) return 'unavailable';
            if (c.isMoving) c.stopMovement();
            if (g.worldObjects) g.worldObjects.cancelPending();
            if (g.combat) { g.combat.cancel(); }
            const dur = Math.max(0.5, def.castTime || 4);
            const vfx = def.vfx || {};
            c.startChannel();
            const fx = fxSys.start(c.position.x, c.position.z, { mode: 'channel', duration: dur, radius: vfx.radius, color: vfx.color, core: vfx.core });
            this.channel = { def, dest: route.dest, spawn: route.spawn, pos: route.pos, from: g.location ? g.location.id : null, t: dur, dur, fx };
            if (g.ui && g.ui.floatText) g.ui.floatText(this.labelOf(def).name + '…', 'info');
            return 'ok';
        }

        updateChannel(delta) {
            const ch = this.channel, g = this.game, c = g.character;
            if (!c || !c.isChanneling || c.isMoving || g.isTransitioning || (g.combat && g.combat.isDead)) {
                this.interruptChannel('move');
                return;
            }
            ch.t -= delta;
            if (ch.t <= 0) this.completeChannel();
        }

        /** Breaks a running teleport channel (movement, attack, damage, death). Safe to call any time. */
        interruptChannel(reason) {
            const ch = this.channel;
            if (!ch) return;
            this.channel = null;
            if (ch.fx) ch.fx.stop();
            const c = this.game.character;
            if (c && c.isChanneling) c.stopChannel();
            if (reason !== 'silent' && this.game.ui && this.game.ui.floatText) this.game.ui.floatText('Заклинание прервано', 'warn');
        }

        completeChannel() {
            const ch = this.channel, g = this.game;
            this.channel = null;
            this.startCooldown(ch.def);
            if (g.character) g.character.stopChannel();
            // Going TO the destination: remember where from, so the same skill can bring us back.
            if (g.gameState && ch.from && ch.from !== ch.def.destination) g.gameState.setReturnTo(ch.from, { x: g.character.position.x, z: g.character.position.z, r: g.character.currentRotation });
            // Quest tracking for home_recall
            if (ch.def.id === 'home_recall' && g.gameState) {
                if (ch.dest === 'homeCamp') {
                    g.gameState.setQuestFlag('home_camp_visited', true);
                    window.dispatchEvent(new CustomEvent('game:questUpdated'));
                } else if (ch.from === 'homeCamp') {
                    g.gameState.setQuestFlag('home_camp_returned', true);
                    window.dispatchEvent(new CustomEvent('game:questUpdated'));
                }
            }
            this.pendingArrival = { def: ch.def };
            g.changeLocation(ch.dest, ch.spawn, 'Золотые руны уносят вас…', ch.pos);
        }

        playArrival() {
            const pa = this.pendingArrival;
            if (!pa) return;
            this.pendingArrival = null;
            const g = this.game, c = g.character, fxSys = this.getRecallFx();
            if (!c || !fxSys) return;
            const vfx = pa.def.vfx || {};
            fxSys.start(c.position.x, c.position.z, { mode: 'arrival', duration: 1.8, radius: vfx.radius, color: vfx.color, core: vfx.core });
        }

        // ---------------------------------------------------------------
        // Self skills: blink (instant jump) and buff (timed effect on the hero, see hero.addEffect)
        // ---------------------------------------------------------------
        /** Short rune burst (recall_fx.js) at a point; never blocks anything. */
        playBurst(def, x, z, mode, duration, follow) {
            try {
                const fxSys = this.getRecallFx();
                if (!fxSys) return;
                const vfx = def.vfx || {};
                fxSys.start(x, z, { mode, duration, radius: vfx.radius || 1.2, follow: !!follow, color: vfx.color, core: vfx.core });
            } catch (e) { console.warn('skill fx', e); }
        }

        /** Mana is paid only after the skill is certain to happen. Returns false (message shown) when short of mana. */
        payMana(def) {
            const g = this.game;
            const cost = g.hero && typeof g.hero.skillManaCost === 'function' ? g.hero.skillManaCost(def) : (def.mana || 0);
            if (cost > 0 && g.hero && !g.hero.spend(cost)) {
                if (g.ui && g.ui.floatText) g.ui.floatText('Не хватает маны', 'warn');
                return false;
            }
            return true;
        }

        startBuff(def) {
            const g = this.game, hero = g.hero, c = g.character;
            const b = def.buff || {};
            if (!hero || !hero.state || !c) return 'unavailable';
            if (!this.payMana(def)) return 'mana';
            this.startCooldown(def);
            hero.addEffect({
                id: b.id || def.id, kind: b.kind || 'buff', name: this.labelOf(def).name, desc: def.description,
                icon: def.iconData || null, dur: b.duration || 0,
                manaPerDamage: b.manaPerDamage || 0, shield: !!b.shield, color: (def.vfx && def.vfx.color) || null
            });
            this.playBurst(def, c.position.x, c.position.z, 'levelup', 1.1, true);
            if (g.ui && g.ui.floatText) g.ui.floatText(this.labelOf(def).name, 'info');
            return 'ok';
        }

        /**
         * Blink direction = where the hero faces / walks (never the cursor: a click on the hotbar would aim at the panel).
         * Heading convention: rotation = atan2(dx, dz) + PI; in first person the camera decides (as in combat.findBestTarget).
         */
        blinkDir(range) {
            const g = this.game, c = g.character;
            const r = (g.viewMode === 'first') ? g.cameraAngle : c.currentRotation;
            return { x: -Math.sin(r), z: -Math.cos(r), dist: range };
        }

        startBlink(def) {
            const g = this.game, c = g.character, pf = g.pathfinder, p = c.position;
            if (!g.terrain) return 'unavailable';
            const range = def.range || 9, minRange = def.minRange || 1.5;
            const dir = this.blinkDir(range);
            // Walk the ray in half-cell steps: the jump ends at the last walkable point before water / rocks / walls.
            const step = 0.5;
            let best = 0;
            for (let d = step; ; d += step) {
                const dd = Math.min(d, dir.dist);
                if (pf && !pf.isWalkableWorld(p.x + dir.x * dd, p.z + dir.z * dd)) break;
                best = dd;
                if (dd >= dir.dist) break;
            }
            if (best < minRange) {
                if (g.ui && g.ui.floatText) g.ui.floatText('Сюда не переместиться', 'warn');
                return 'blocked';
            }
            if (!this.payMana(def)) return 'mana';
            const nx = p.x + dir.x * best, nz = p.z + dir.z * best;
            this.startCooldown(def);
            if (c.isMoving) c.stopMovement();
            if (g.worldObjects) g.worldObjects.cancelPending();
            if (g.combat) g.combat.cancel();
            this.playBurst(def, p.x, p.z, 'arrival', 0.9, false);
            c.teleport(nx, nz, Math.atan2(dir.x, dir.z) + Math.PI);
            this.playBurst(def, nx, nz, 'arrival', 1.1, false);
            return 'ok';
        }

        /**
         * type "nova" (Огненная волна): a ring of damage around the hero, no target needed.
         * `castTime` = wind-up (hero stops, cast pose), then the burst: every creature within vfx.impactRadius
         * takes the rolled damage (game:skillImpact, same hook as projectiles). No knockback yet.
         */
        startNova(def) {
            const g = this.game, c = g.character;
            if (!c || !g.terrain || !g.hero || !g.hero.state) return 'unavailable';
            if (!this.payMana(def)) return 'mana';
            if (c.isMoving) c.stopMovement();
            if (g.worldObjects) g.worldObjects.cancelPending();
            this.startCooldown(def);
            const castDur = Math.max(0, def.castTime || 0);
            this.casting = { def, target: null, nova: true, t: castDur };
            this.ensureResources();
            if (c.playCast) c.playCast(castDur || 0.6);
            else c.startSwing(castDur || 0.6);
            return 'ok';
        }

        fireNova(def) {
            const g = this.game, c = g.character;
            if (!c || (g.combat && g.combat.isDead)) return;
            const vfx = def.vfx || {};
            const pos = this._v1.set(c.position.x, c.position.y + 0.05, c.position.z);
            this._novaColor = this._novaColor || new THREE.Color();
            this._novaColor.set(vfx.color || '#ff7a1a');
            this.ensureResources();
            this.spawnImpact(def, pos, this._novaColor, true);
            const dmg = def.damage || null;
            const amount = dmg && Number.isFinite(dmg.min) && Number.isFinite(dmg.max)
                ? Math.max(1, Math.round((dmg.min + Math.random() * (dmg.max - dmg.min)) * (g.hero ? g.hero.skillMult(def) : 1))) : 0;
            window.dispatchEvent(new CustomEvent('game:skillImpact', {
                detail: { skillId: def.id, point: { x: pos.x, y: pos.y, z: pos.z }, radius: vfx.impactRadius || 1, damage: dmg, amount, knockback: def.knockback || null, slow: def.slow || null }
            }));
        }

        // Translucent bubble around the hero while an effect with `shield: true` is active
        ensureShield() {
            if (this.shieldMesh) return this.shieldMesh;
            const mat = new THREE.ShaderMaterial({
                transparent: true, depthWrite: false,
                uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#5aa9ff') }, uAlpha: { value: 1 } },
                vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
                fragmentShader: 'uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec3 vN; varying vec3 vV; void main() { float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float rim = pow(f, 2.2); float pulse = 0.85 + 0.15 * sin(uTime * 2.5); gl_FragColor = vec4(mix(uColor, vec3(0.9, 0.96, 1.0), rim * 0.6), (0.10 + 0.55 * rim) * pulse * uAlpha); }'
            });
            const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
            m.scale.set(0.85, 1.05, 0.85);
            m.renderOrder = 20;
            m.frustumCulled = false;
            m.visible = false;
            m.name = 'mana-shield-fx';
            this.game.scene.add(m);
            this.shieldMesh = m;
            return m;
        }

        updateShieldFx() {
            const g = this.game, hero = g.hero, c = g.character;
            let e = null;
            if (hero && hero.effects && hero.effects.size) hero.effects.forEach(x => { if (x.shield) e = x; });
            const m = this.shieldMesh;
            if (!e || !c || (g.combat && g.combat.isDead)) { if (m && m.visible) m.visible = false; return; }
            const mesh = this.ensureShield();
            mesh.visible = true;
            mesh.position.set(c.position.x, c.position.y + 0.98, c.position.z);
            const u = mesh.material.uniforms;
            u.uTime.value = g.gameTime;
            if (mesh.userData.col !== e.color) { mesh.userData.col = e.color; u.uColor.value.set(e.color || '#5aa9ff'); }
            u.uAlpha.value = (e.dur > 0 && e.t < 4) ? 0.55 + 0.45 * Math.sin(g.gameTime * 10) : 1;   // blinks when about to expire
        }

        startCooldown(def) {
            const cd = Math.max(0, def.cooldown || 0);
            this.readyAt[def.id] = this.game.gameTime + cd;
            this.cdDuration[def.id] = cd;
        }

        /** Ground point / creature body to aim at, in priority order:
         *  1. Soft-lock selectedTarget (combat.js) — always, regardless of mouse position
         *  2. Creature under the mouse (ПК hover-aim, when no selectedTarget)
         *  3. Ground point under the mouse cursor (ПК)
         *  4. Straight ahead at full range (mobile / no valid mouse hit)
         */
        pickTarget(def, out) {
            const g = this.game;
            const c = g.character;
            const range = def.range || 12;
            const p = c.position;

            // --- Priority 1: soft-lock selectedTarget ---
            const selTgt = g.combat && g.combat.selectedTarget;
            const cr = g.creatures;
            if (selTgt && cr && cr.isAlive(selTgt)) {
                const dx = selTgt.x - p.x, dz = selTgt.z - p.z;
                const d = Math.hypot(dx, dz);
                if (d > 0.3) {
                    if (d <= range) {
                        // In range: aim at body centre
                        out.set(selTgt.x, selTgt.y + selTgt.height * 0.5 - AIM_HEIGHT, selTgt.z);
                    } else {
                        // Out of range: aim as far as possible in that direction
                        const k = range / d;
                        out.set(p.x + dx * k, 0, p.z + dz * k);
                        out.y = g.terrain.getHeightAt(out.x, out.z);
                    }
                    return out;
                }
            }

            const lp = g.lastPointer;
            let ok = false;

            // --- Priority 2: creature under the mouse (no selectedTarget) ---
            let creature = null;
            if (lp && lp.type === 'mouse' && lp.valid && !lp.overUI && cr) {
                this._mouse.set((lp.x / window.innerWidth) * 2 - 1, -(lp.y / window.innerHeight) * 2 + 1);
                g.raycaster.setFromCamera(this._mouse, g.camera);
                creature = cr.pickAt(g.raycaster);
            } else if (g.combat) {
                creature = g.combat.targetCreature();
            }
            if (creature && cr && cr.isAlive(creature)) {
                const dx = creature.x - p.x, dz = creature.z - p.z;
                const d = Math.hypot(dx, dz);
                if (d > 0.3) {
                    // Aim point: middle of the body (spawnProjectile adds AIM_HEIGHT back)
                    out.set(creature.x, creature.y + creature.height * 0.5 - AIM_HEIGHT, creature.z);
                    if (d > range) {
                        const k = range / d;
                        out.set(p.x + dx * k, 0, p.z + dz * k);
                        out.y = g.terrain.getHeightAt(out.x, out.z);
                    }
                    return out;
                }
            }

            // --- Priority 3: ground under the mouse ---
            if (lp && lp.type === 'mouse' && lp.valid && !lp.overUI && g.terrain && g.terrain.mesh) {
                this._mouse.set((lp.x / window.innerWidth) * 2 - 1, -(lp.y / window.innerHeight) * 2 + 1);
                g.raycaster.setFromCamera(this._mouse, g.camera);
                const hit = g.raycaster.intersectObject(g.terrain.mesh)[0];
                if (hit) {
                    const dx = hit.point.x - p.x, dz = hit.point.z - p.z;
                    const d = Math.hypot(dx, dz);
                    if (d > 0.6) {
                        const k = Math.min(1, range / d);
                        out.set(p.x + dx * k, 0, p.z + dz * k);
                        ok = true;
                    }
                }
            }

            // --- Priority 4: straight ahead (mobile / no valid hit) ---
            if (!ok) {
                // Facing direction: character.js heading convention is rotation = atan2(dx, dz) + PI
                const r = c.currentRotation;
                out.set(p.x - Math.sin(r) * range, 0, p.z - Math.cos(r) * range);
            }
            out.y = g.terrain.getHeightAt(out.x, out.z);
            return out;
        }


        // -----------------------------------------------------------
        // Resources / pools
        // -----------------------------------------------------------
        ensureResources() {
            if (this.res) return this.res;
            const tex = makeTextures();
            const root = new THREE.Group();
            root.name = 'skills-vfx';
            this.game.scene.add(root);

            const trail = new PointBatch(MAX_TRAIL_POINTS, tex.glow);
            const sparks = new PointBatch(MAX_SPARKS * 3, tex.dot); // x3: each spark draws a short streak
            root.add(trail.points, sparks.points);

            const projectiles = [];
            for (let i = 0; i < MAX_PROJECTILES; i++) {
                const p = {
                    active: false, fading: false, def: null, targetCreature: null,
                    pos: new THREE.Vector3(), dir: new THREE.Vector3(), start: new THREE.Vector3(),
                    dist: 0, travelled: 0, age: 0, fade: 0, seed: 0, boltTimer: 0, emit: 0,
                    color: new THREE.Color(), core: new THREE.Color(),
                    coreSprite: additiveSprite(tex.flare),
                    glowSprite: additiveSprite(tex.glow),
                    shadeSprite: additiveSprite(tex.glow, true),
                    filaments: boltLines(FILAMENTS, FILAMENT_SEGS)
                };
                root.add(p.shadeSprite, p.coreSprite, p.glowSprite, p.filaments);
                projectiles.push(p);
            }

            const impacts = [];
            for (let i = 0; i < MAX_IMPACTS; i++) {
                const m = {
                    active: false, def: null, age: 0, onGround: true, boltTimer: 0,
                    pos: new THREE.Vector3(), color: new THREE.Color(),
                    flash: additiveSprite(tex.flare),
                    bloom: additiveSprite(tex.glow),
                    ring: additivePlane(tex.ring),
                    decal: additivePlane(tex.glow),
                    scorch: additivePlane(tex.glow, true),
                    arcs: boltLines(ARCS, ARC_SEGS)
                };
                root.add(m.scorch, m.flash, m.bloom, m.ring, m.decal, m.arcs);
                impacts.push(m);
            }

            const strikes = [];
            for (let i = 0; i < MAX_STRIKES; i++) {
                const s = {
                    active: false, def: null, age: 0, dur: STRIKE_LIFE, boltTimer: 0,
                    pos: new THREE.Vector3(),
                    color: new THREE.Color('#6fe3ff'),
                    coreColor: new THREE.Color('#ffffff'),
                    height: 26,
                    group: new THREE.Group(),
                    outerBolt: boltLines(STRIKE_BOLTS, STRIKE_SEGS),
                    coreBolt: boltLines(2, STRIKE_SEGS),
                    topFlare: additiveSprite(tex.flare)
                };
                s.group.name = 'strike-fx';
                s.group.visible = false;
                s.group.add(s.outerBolt, s.coreBolt, s.topFlare);
                root.add(s.group);
                strikes.push(s);
            }

            // Spark simulation state (structure of arrays, swap-remove)
            const S = MAX_SPARKS;
            const sp = {
                n: 0,
                x: new Float32Array(S), y: new Float32Array(S), z: new Float32Array(S),
                vx: new Float32Array(S), vy: new Float32Array(S), vz: new Float32Array(S),
                age: new Float32Array(S), life: new Float32Array(S), size: new Float32Array(S),
                r: new Float32Array(S), g: new Float32Array(S), b: new Float32Array(S),
                grav: new Float32Array(S)
            };

            // Fire rain: pulsing danger zone on the ground while the meteors fall
            const zone = { ring: additivePlane(tex.ring), glow: additivePlane(tex.glow) };
            root.add(zone.glow, zone.ring);

            this.res = { tex, root, trail, sparks, projectiles, impacts, strikes, sp, zone };
            return this.res;
        }

        /** Compile VFX shaders up-front so the first cast doesn't hitch (call once a character with skills is in play). */
        prewarm() {
            const r = this.ensureResources();
            if (r.prewarmed) return;
            r.prewarmed = true;
            const toggled = [];
            r.root.traverse(o => { if (o !== r.root && !o.visible) { o.visible = true; toggled.push(o); } });
            try { this.game.renderer.compile(this.game.scene, this.game.camera); } catch (e) { /* non-fatal */ }
            toggled.forEach(o => { o.visible = false; });
        }

        // -----------------------------------------------------------
        // Spawning
        // -----------------------------------------------------------
        /**
         * Basic attack of a bow (combat.js, weapon.style 'bow'): a plain arrow flies at a creature.
         * Visuals = the 'arrow' skill; damage = the bow's weapon.damage (scaled by Ловкость via skillMult).
         */
        shootBasic(rec, weapon) {
            const g = this.game, c = g.character;
            if (!c || !rec || !g.creatures || !g.creatures.isAlive(rec)) return false;
            const staff = weapon.style === 'staff';   // staff: a bolt of magic ('spark' visuals); bow: an arrow
            const base = this.get(staff ? 'spark' : 'arrow') || {};
            const def = Object.assign({}, base, {
                id: staff ? 'staff_shot' : 'bow_shot', mana: 0, cooldown: 0, castTime: 0,
                range: (weapon.range || 12) + 2,
                speed: base.speed || 34,
                damage: { min: weapon.damage[0], max: weapon.damage[1], type: staff ? 'lightning' : 'physical' }
            });
            const aim = this._v2 || (this._v2 = new THREE.Vector3());
            aim.set(rec.x, rec.y + rec.height * 0.5 - AIM_HEIGHT, rec.z);
            this.spawnProjectile(def, aim, rec);
            return true;
        }

        spawnProjectile(def, target, tgt = null) {
            const r = this.ensureResources();
            const p = r.projectiles.find(q => !q.active) || r.projectiles[0];
            const c = this.game.character;
            const start = p.start;
            if (!c.getRightHandWorldPosition || !c.getRightHandWorldPosition(start)) {
                // Fallback: chest height, a little in front of the character
                const rot = c.currentRotation;
                start.set(c.position.x - Math.sin(rot) * 0.45, c.position.y + 1.3, c.position.z - Math.cos(rot) * 0.45);
            }
            const aim = this._v1.set(target.x, target.y + AIM_HEIGHT, target.z);
            p.dir.subVectors(aim, start);
            p.dist = p.dir.length();
            if (p.dist < 1e-3) { p.dir.set(0, 0, -1); p.dist = 0.01; }
            p.dir.divideScalar(p.dist);
            p.dist = Math.min(p.dist, (def.range || 12) + 1.0);
            p.pos.copy(start);
            p.def = def;
            p.targetCreature = (tgt && this.game.creatures && this.game.creatures.isAlive(tgt)) ? tgt : null;
            p.travelled = 0; p.age = 0; p.fade = 0; p.emit = 0; p.boltTimer = 0;
            p.seed = Math.random() * 100;
            p.active = true; p.fading = false;
            const vfx = def.vfx || {};
            p.color.set(vfx.color || '#7fd4ff');
            p.core.set(vfx.core || '#ffffff');
            p.coreSprite.material.color.copy(p.core);
            p.glowSprite.material.color.copy(p.color);
            p.shadeSprite.material.color.copy(p.color).multiplyScalar(0.12);
            this._color.copy(p.color).lerp(this._white, 0.45);
            p.filaments.material.color.copy(this._color);
            p.coreSprite.visible = p.glowSprite.visible = p.shadeSprite.visible = true;
            p.filaments.visible = vfx.filaments !== false; // fire / arrows: no lightning crackle
            this.placeProjectileVisuals(p, 0);
        }

        // ---------------------------------------------------------------
        // Fire rain ("rain"): meteors fall over `rain.duration` s at random points of a disk around the target
        // ---------------------------------------------------------------
        startRain(def, target) {
            const g = this.game, r = this.ensureResources();
            const cfg = def.rain || {}, vfx = def.vfx || {};
            const count = Math.max(1, cfg.count | 0 || 14), dur = Math.max(0.5, cfg.duration || 3.5);
            const times = [0];
            for (let i = 1; i < count; i++) times.push(Math.random() * dur);
            times.sort((a, b) => a - b);
            this.rain = {
                def, cx: target.x, cz: target.z, radius: cfg.radius || 5, count, dur, times,
                fall: Math.max(0.2, cfg.fallTime || 0.55), height: cfg.height || 24,
                t: 0, spawned: 0, meteors: [], pool: [],
                color: new THREE.Color(vfx.color || '#ff5a14'), core: new THREE.Color(vfx.core || '#ffe08a')
            };
            const z = r.zone;
            const gy = g.terrain.getHeightAt(target.x, target.z);
            z.ring.position.set(target.x, gy + 0.07, target.z);
            z.glow.position.set(target.x, gy + 0.06, target.z);
            z.ring.material.color.copy(this.rain.color);
            z.glow.material.color.copy(this.rain.color);
            z.ring.visible = z.glow.visible = true;
        }

        updateRain(delta) {
            const R = this.rain, r = this.res, g = this.game;
            const def = R.def, vfx = def.vfx || {};
            const size = vfx.size || 0.9;
            R.t += delta;

            // New meteors: the first lands exactly on the target, the rest anywhere in the disk
            while (R.spawned < R.count && R.times[R.spawned] <= R.t) {
                const first = R.spawned === 0;
                const a = Math.random() * Math.PI * 2, rr = first ? 0 : R.radius * Math.sqrt(Math.random());
                const tx = R.cx + Math.cos(a) * rr, tz = R.cz + Math.sin(a) * rr;
                const ty = g.terrain.getHeightAt(tx, tz);
                const m = R.pool.pop() || {};
                m.tx = tx; m.ty = ty; m.tz = tz;
                m.sx = tx + 7 + Math.random() * 2; m.sy = ty + R.height; m.sz = tz + 4 + Math.random() * 2;
                m.t = 0; m.T = R.fall * (0.85 + Math.random() * 0.3);
                const dx = m.tx - m.sx, dy = m.ty - m.sy, dz = m.tz - m.sz, L = Math.hypot(dx, dy, dz);
                m.dx = dx / L; m.dy = dy / L; m.dz = dz / L; m.len = L;
                R.meteors.push(m);
                R.spawned++;
            }

            // Danger zone on the ground: fades in, pulses, fades out with the last meteors
            const z = r.zone;
            const fin = Math.min(1, R.t / 0.35), fout = R.spawned >= R.count ? Math.max(0, 1 - (R.t - R.times[R.count - 1]) / R.fall) : 1;
            const k = fin * fout, pulse = 0.75 + 0.25 * Math.sin(R.t * 9);
            z.ring.scale.set(R.radius * 2.15, 1, R.radius * 2.15);
            z.ring.material.opacity = 0.55 * k * pulse;
            z.glow.scale.set(R.radius * 2.3, 1, R.radius * 2.3);
            z.glow.material.opacity = 0.22 * k;

            // Meteors in flight (accelerating fall), trail + head drawn with the shared point batches
            const tb = r.trail, col = R.color, core = R.core;
            for (let i = R.meteors.length - 1; i >= 0; i--) {
                const m = R.meteors[i];
                m.t += delta;
                if (m.t >= m.T) {
                    this.rainImpact(R, m);
                    R.pool.push(m);
                    R.meteors[i] = R.meteors[R.meteors.length - 1];
                    R.meteors.pop();
                    continue;
                }
                const u = m.t / m.T, f = 0.65 * u + 0.35 * u * u;   // slight acceleration
                const d = f * m.len;
                const x = m.sx + m.dx * d, y = m.sy + m.dy * d, zz = m.sz + m.dz * d;
                tb.push(x, y, zz, core.r, core.g, core.b, 0.95, size * 2.0);
                tb.push(x, y, zz, col.r, col.g, col.b, 0.55, size * 3.4);
                const N = 9, sp = size * 0.55;
                for (let n = 1; n <= N; n++) {
                    const w = 1 - n / (N + 1), hot = w * w * 0.6;
                    tb.push(x - m.dx * n * sp + (Math.random() - 0.5) * 0.08, y - m.dy * n * sp, zz - m.dz * n * sp + (Math.random() - 0.5) * 0.08,
                        col.r + (1 - col.r) * hot, col.g + (1 - col.g) * hot, col.b + (1 - col.b) * hot,
                        Math.pow(w, 1.3) * 0.8, size * (0.3 + 0.7 * w) * 1.1);
                }
                if (Math.random() < delta * 40) {
                    this.addSpark(x, y, zz, (Math.random() - 0.5) * 2 - m.dx * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2 - m.dz * 2,
                        0.2 + Math.random() * 0.2, 0.04 + Math.random() * 0.04, col, 0.3);
                }
            }

            if (R.spawned >= R.count && R.meteors.length === 0) {
                z.ring.visible = z.glow.visible = false;
                this.rain = null;
            }
        }

        rainImpact(R, m) {
            const def = R.def, g = this.game, vfx = def.vfx || {};
            const pos = this._v1.set(m.tx, m.ty + 0.05, m.tz);
            this.spawnImpact(def, pos, R.color, true);
            const dmg = def.damage || null;
            const amount = dmg && Number.isFinite(dmg.min) && Number.isFinite(dmg.max)
                ? Math.max(1, Math.round((dmg.min + Math.random() * (dmg.max - dmg.min)) * (g.hero ? g.hero.skillMult(def) : 1))) : 0;
            window.dispatchEvent(new CustomEvent('game:skillImpact', {
                detail: { skillId: def.id, point: { x: m.tx, y: m.ty + 0.05, z: m.tz }, radius: vfx.impactRadius || 1, damage: dmg, amount, knockback: def.knockback || null, slow: def.slow || null }
            }));
        }

        fireStrike(def, target, tgt) {
            const g = this.game;
            if (!g.character || (g.combat && g.combat.isDead)) return;
            const r = this.ensureResources();
            const s = r.strikes.find(q => !q.active) || r.strikes[0];
            const vfx = def.vfx || {};
            const height = vfx.height || 26;
            const colorHex = vfx.color || '#6fe3ff';
            const coreHex = vfx.core || '#ffffff';

            // Если цель жива, берём её самые свежие текущие координаты прямо сейчас (попадание по движущейся цели)
            const cr = g.creatures;
            const aliveTgt = (tgt && cr && cr.isAlive(tgt)) ? tgt : null;
            const tx = aliveTgt ? aliveTgt.x : target.x;
            const tz = aliveTgt ? aliveTgt.z : target.z;
            const ty = aliveTgt ? aliveTgt.y : (g.terrain ? g.terrain.getHeightAt(tx, tz) : target.y);

            s.active = true;
            s.def = def;
            s.tgt = aliveTgt;
            s.age = 0;
            s.dur = STRIKE_LIFE;
            s.boltTimer = 0;
            s.height = height;
            s.color.set(colorHex);
            s.coreColor.set(coreHex);

            s.pos.set(tx, ty + 0.05, tz);
            s.group.position.copy(s.pos);
            s.group.visible = true;

            s.outerBolt.material.color.copy(s.color);
            s.outerBolt.material.opacity = 1.0;
            s.outerBolt.visible = true;

            s.coreBolt.material.color.copy(s.coreColor);
            s.coreBolt.material.opacity = 1.0;
            s.coreBolt.visible = true;

            s.topFlare.position.set(0, height, 0);
            s.topFlare.scale.set(3, 3, 1);
            s.topFlare.material.color.copy(s.coreColor);
            s.topFlare.material.opacity = 1.0;
            s.topFlare.visible = true;

            writeVerticalBolt(s.outerBolt, height, 1.8);
            writeVerticalBoltCore(s.coreBolt, height, 1.8);

            // Импакт на земле: вспышка, кольцо энергии, электрические искры во все стороны
            this.spawnImpact(def, s.pos, s.color, true);

            // Прямой удар в таргет (гарантированное попадание)
            const dmg = def.damage || null;
            const amount = dmg && Number.isFinite(dmg.min) && Number.isFinite(dmg.max)
                ? Math.max(1, Math.round((dmg.min + Math.random() * (dmg.max - dmg.min)) * (g.hero ? g.hero.skillMult(def) : 1))) : 0;

            if (aliveTgt && cr && cr.isAlive(aliveTgt)) {
                const dealt = cr.damage(aliveTgt, amount, 'spark');
                if (dealt > 0) {
                    if (def.stun) cr.stun(aliveTgt, def.stun);
                    if (def.knockback) cr.knockback(aliveTgt, tx, tz, def.knockback);
                    if (def.slow) cr.slow(aliveTgt, def.slow);
                }
                if (def.id === 'spark' && g.state && g.state.setQuestFlag) {
                    g.state.setQuestFlag('spark_hit_creature', true);
                    if (g.dialog && g.dialog.updateTracker) g.dialog.updateTracker();
                    if (g.ui && g.ui.updateQuestsProgress) g.ui.updateQuestsProgress();
                }
            }

            // Сплеш по площади вокруг точки удара (только если на скилле явно задано aoe: true)
            if (def.aoe) {
                window.dispatchEvent(new CustomEvent('game:skillImpact', {
                    detail: {
                        skillId: def.id,
                        point: { x: tx, y: ty + 0.05, z: tz },
                        radius: (vfx && vfx.impactRadius) || 2.0,
                        damage: dmg,
                        amount,
                        stun: def.stun || null,
                        knockback: def.knockback || null,
                        slow: def.slow || null,
                        excludeId: aliveTgt ? aliveTgt.id : null
                    }
                }));
            }
        }

        updateStrikes(delta) {
            const r = this.res;
            if (!r || !r.strikes) return;
            const cr = this.game.creatures;
            for (let i = 0; i < r.strikes.length; i++) {
                const s = r.strikes[i];
                if (!s.active) continue;
                s.age += delta;
                if (s.age >= s.dur) {
                    s.active = false;
                    s.group.visible = false;
                    s.tgt = null;
                    continue;
                }
                // Молния точно держится на движущейся цели во время разряда
                if (s.tgt && cr && cr.isAlive(s.tgt)) {
                    s.pos.set(s.tgt.x, s.tgt.y + 0.05, s.tgt.z);
                    s.group.position.copy(s.pos);
                }
                s.boltTimer -= delta;
                if (s.boltTimer <= 0) {
                    s.boltTimer = 0.035;
                    writeVerticalBolt(s.outerBolt, s.height, 1.8);
                    writeVerticalBoltCore(s.coreBolt, s.height, 1.8);
                }
                const fadeT = Math.max(0, (s.age - 0.06) / (s.dur - 0.06));
                const flicker = 0.75 + Math.random() * 0.25;
                const op = Math.max(0, 1 - fadeT) * flicker;
                s.outerBolt.material.opacity = op;
                s.coreBolt.material.opacity = op;
                s.topFlare.material.opacity = op;
            }
        }

        spawnImpact(def, point, color, onGround) {
            const r = this.res;
            const m = r.impacts.find(q => !q.active) || r.impacts[0];
            const vfx = def.vfx || {};
            m.active = true; m.def = def; m.age = 0; m.boltTimer = 0; m.onGround = onGround;
            m.pos.copy(point);
            m.color.copy(color);
            m.flash.position.copy(point);
            m.flash.material.rotation = Math.random() * Math.PI;
            m.flash.material.color.set(vfx.core || '#ffffff');
            m.bloom.position.copy(point);
            m.bloom.material.color.copy(color);
            const gy = this.game.terrain ? this.game.terrain.getHeightAt(point.x, point.z) : point.y;
            m.ring.position.set(point.x, gy + 0.06, point.z);
            m.decal.position.set(point.x, gy + 0.05, point.z);
            m.ring.material.color.copy(color);
            m.decal.material.color.copy(color);
            m.scorch.position.set(point.x, gy + 0.04, point.z);
            m.scorch.material.color.copy(color).multiplyScalar(0.1);
            m.arcs.position.copy(point);
            this._color.copy(color).lerp(this._white, 0.55);
            m.arcs.material.color.copy(this._color);
            m.flash.visible = m.bloom.visible = m.arcs.visible = true;
            if (vfx.arcs === false) m.arcs.visible = false;
            m.ring.visible = (vfx.ring !== false) && onGround;
            m.decal.visible = (vfx.decal !== false) && onGround;
            m.scorch.visible = onGround;
            writeBolts(m.arcs, ARCS, ARC_SEGS, (vfx.impactRadius || 1.4) * 0.5, (vfx.impactRadius || 1.4) * 1.05, onGround ? 0.35 : 1, 0.45);

            // Sparks burst: mostly up and outward, biased away from the incoming direction
            const count = Math.max(0, vfx.impactSparks | 0);
            if (vfx.nova) {
                // Ring wave: no flash over the caster, sparks fly flat outward and reach the radius together with the ground ring
                m.flash.visible = m.bloom.visible = m.arcs.visible = false;
                const NR = vfx.impactRadius || 5, life = 0.6;
                for (let i = 0; i < count; i++) {
                    const a = (i / count) * Math.PI * 2 + Math.random() * 0.12;
                    const sp = (NR / life) * (0.85 + Math.random() * 0.3);
                    this.addSpark(point.x, point.y + 0.15, point.z,
                        Math.cos(a) * sp, 0.5 + Math.random() * 1.3, Math.sin(a) * sp,
                        life * (0.8 + Math.random() * 0.4), 0.11 + Math.random() * 0.1, color, 0.2);
                }
                return;
            }
            for (let i = 0; i < count; i++) {
                const a = Math.random() * Math.PI * 2;
                const up = onGround ? 0.35 + Math.random() * 0.9 : Math.random() * 2 - 1;
                const sp = 2.5 + Math.random() * 5.5;
                this.addSpark(point.x, point.y + 0.05, point.z,
                    Math.cos(a) * sp, up * sp, Math.sin(a) * sp,
                    0.4 + Math.random() * 0.35, 0.09 + Math.random() * 0.09, color, 1);
            }
        }

        addSpark(x, y, z, vx, vy, vz, life, size, color, grav) {
            const s = this.res.sp;
            if (s.n >= MAX_SPARKS) return;
            const i = s.n++;
            s.x[i] = x; s.y[i] = y; s.z[i] = z;
            s.vx[i] = vx; s.vy[i] = vy; s.vz[i] = vz;
            s.age[i] = 0; s.life[i] = life; s.size[i] = size; s.grav[i] = grav;
            s.r[i] = color.r; s.g[i] = color.g; s.b[i] = color.b;
        }

        // -----------------------------------------------------------
        // Per-frame
        // -----------------------------------------------------------
        update(delta) {
            if (this.channel) this.updateChannel(delta);
            if (this.recallFx) this.recallFx.update(delta);
            this.updateShieldFx();

            // Cast in progress: spawn when castTime elapses (game time)
            if (this.casting) {
                this.casting.t -= delta;
                if (this.casting.t <= 0) {
                    const cst = this.casting;
                    this.casting = null;
                    if (this.game.character && this.game.terrain) {
                        if (cst.nova) this.fireNova(cst.def);
                        else if (cst.def.type === 'rain') this.startRain(cst.def, cst.target);
                        else if (cst.def.type === 'strike') this.fireStrike(cst.def, cst.target, cst.tgt);
                        else {
                            const cr = this.game.creatures;
                            const aliveTgt = (cst.tgt && cr && cr.isAlive(cst.tgt)) ? cst.tgt
                                : (this.game.combat && this.game.combat.selectedTarget && cr && cr.isAlive(this.game.combat.selectedTarget) ? this.game.combat.selectedTarget : null);
                            if (aliveTgt) {
                                cst.target.set(aliveTgt.x, aliveTgt.y + aliveTgt.height * 0.5 - AIM_HEIGHT, aliveTgt.z);
                                if (this.game.character && this.game.character.faceTowards) this.game.character.faceTowards(aliveTgt.x, aliveTgt.z);
                            }
                            this.spawnProjectile(cst.def, cst.target, aliveTgt);
                        }
                    }
                }
            }

            const r = this.res;
            if (!r) return;
            let busy = r.sp.n > 0 || !!this.rain;
            for (let i = 0; i < r.strikes.length && !busy; i++) busy = r.strikes[i].active;
            for (let i = 0; i < r.projectiles.length && !busy; i++) busy = r.projectiles[i].active;
            for (let i = 0; i < r.impacts.length && !busy; i++) busy = r.impacts[i].active;
            if (!busy && !r.trail.points.visible && !r.sparks.points.visible) return;

            r.trail.begin();
            r.sparks.begin();
            if (this.rain) this.updateRain(delta);
            this.updateStrikes(delta);
            for (let i = 0; i < r.projectiles.length; i++) {
                const p = r.projectiles[i];
                if (p.active) this.updateProjectile(p, delta);
            }
            for (let i = 0; i < r.impacts.length; i++) {
                const m = r.impacts[i];
                if (m.active) this.updateImpact(m, delta);
            }
            this.updateSparks(delta);

            // Points size scale: drawing-buffer pixels per meter at distance 1
            this.game.renderer.getDrawingBufferSize(this._bufSize);
            const scale = this._bufSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.game.camera.fov) / 2));
            r.trail.end(scale);
            r.sparks.end(scale);
        }

        updateProjectile(p, delta) {
            const def = p.def;
            const vfx = def.vfx || {};
            const size = vfx.size || 0.55;
            p.age += delta;

            if (!p.fading) {
                const cr = this.game.creatures;
                let hit = false;
                let onGround = false;

                // --- Homing: smooth steering towards target creature if alive ---
                const tgt = p.targetCreature;
                const tgtAlive = tgt && cr && cr.isAlive(tgt);
                if (tgtAlive) {
                    const tgtX = tgt.x;
                    const tgtY = tgt.y + tgt.height * 0.55;
                    const tgtZ = tgt.z;
                    const toX = tgtX - p.pos.x;
                    const toY = tgtY - p.pos.y;
                    const toZ = tgtZ - p.pos.z;
                    const distToTgt = Math.hypot(toX, toY, toZ);
                    const hitR = (tgt.def && tgt.def.hitRadius) ? tgt.def.hitRadius : 0.45;
                    const step = (def.speed || 20) * delta;

                    // Direct hit if close enough or reached in this frame step
                    if (distToTgt <= (hitR + 0.35) || distToTgt <= step) {
                        p.pos.set(tgtX, tgtY, tgtZ);
                        p.travelled += distToTgt;
                        hit = true;
                        onGround = false;
                    } else {
                        // Smoothly adjust direction towards target
                        const invD = 1.0 / distToTgt;
                        const desiredX = toX * invD;
                        const desiredY = toY * invD;
                        const desiredZ = toZ * invD;
                        const turnFactor = Math.min(1.0, delta * 20.0);
                        p.dir.x += (desiredX - p.dir.x) * turnFactor;
                        p.dir.y += (desiredY - p.dir.y) * turnFactor;
                        p.dir.z += (desiredZ - p.dir.z) * turnFactor;
                        p.dir.normalize();
                        p.dist = Math.min(p.travelled + distToTgt, (def.range || 12) + 6.0);
                    }
                } else if (tgt) {
                    p.targetCreature = null;
                }

                if (!hit) {
                    const step = (def.speed || 20) * delta;
                    if (p.travelled + step >= p.dist) {
                        p.pos.addScaledVector(p.dir, p.dist - p.travelled);
                        p.travelled = p.dist;
                        hit = true;
                        onGround = true;
                    } else {
                        // Sub-step so fast projectiles can't tunnel through a thin trunk
                        const n = Math.max(1, Math.ceil(step / 0.35));
                        const s = step / n;
                        for (let k = 0; k < n && !hit; k++) {
                            p.pos.addScaledVector(p.dir, s);
                            p.travelled += s;
                            const gy = this.game.terrain ? this.game.terrain.getHeightAt(p.pos.x, p.pos.z) : p.pos.y;
                            if (p.pos.y < gy + 0.05) { p.pos.y = gy + 0.08; hit = true; onGround = true; }
                            else if (cr && cr.hitTest(p.pos)) {
                                hit = true;
                                onGround = p.pos.y - gy < 0.6;
                            }
                            else if (this.hitsBlocker(p.pos)) { hit = true; onGround = p.pos.y - gy < 1.0; }
                        }
                    }
                }

                if (hit) {
                    if (p.def && p.def.id === 'spark') {
                        const st = this.game && this.game.gameState;
                        if (st && st.setQuestFlag) st.setQuestFlag('spark_hit_creature', true);
                        const dlg = (this.game && this.game.ui && this.game.ui.dialog);
                        if (dlg && dlg.updateTracker) dlg.updateTracker();
                        if (this.game && this.game.ui && this.game.ui.updateQuestsProgress) this.game.ui.updateQuestsProgress();
                        window.dispatchEvent(new CustomEvent('game:questUpdated'));
                    }
                    this.impact(p, onGround);
                } else {
                    this.placeProjectileVisuals(p, delta);
                    // Shed a few tiny sparks while flying
                    p.emit += delta * 45;
                    while (p.emit >= 1) {
                        p.emit -= 1;
                        this.addSpark(p.pos.x, p.pos.y, p.pos.z,
                            (Math.random() - 0.5) * 2.2 - p.dir.x * 1.5, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 2.2 - p.dir.z * 1.5,
                            0.18 + Math.random() * 0.18, 0.035 + Math.random() * 0.03, p.color, 0.3);
                    }
                }
            } else {
                p.fade += delta;
                if (p.fade >= TRAIL_FADE) { p.active = false; p.fading = false; p.targetCreature = null; return; }
            }
            this.pushTrail(p, size);
        }

        placeProjectileVisuals(p, delta) {
            const vfx = p.def.vfx || {};
            const size = vfx.size || 0.55;
            const t = p.age;
            const pulse = 1 + 0.16 * Math.sin(t * 38 + p.seed) + 0.08 * Math.sin(t * 91 + p.seed * 3.1);
            p.coreSprite.position.copy(p.pos);
            p.coreSprite.scale.setScalar(size * 0.8 * pulse);
            p.coreSprite.material.rotation += delta * 7.0;
            p.glowSprite.position.copy(p.pos);
            p.glowSprite.scale.setScalar(size * 2.3 * (1.0 + 0.22 * Math.sin(t * 27 + p.seed * 1.7)));
            p.glowSprite.material.opacity = 0.55 + 0.3 * Math.abs(Math.sin(t * 53 + p.seed));
            p.shadeSprite.position.copy(p.pos);
            p.shadeSprite.scale.setScalar(size * 3.4);
            p.shadeSprite.material.opacity = 0.5;
            p.filaments.position.copy(p.pos);
            p.boltTimer -= delta;
            if (p.boltTimer <= 0) {
                p.boltTimer = 0.035 + Math.random() * 0.03;
                writeBolts(p.filaments, FILAMENTS, FILAMENT_SEGS, size * 0.45, size * 1.05, 1, 0.55);
                p.filaments.material.opacity = 0.55 + Math.random() * 0.45;
            }
        }

        /** Trail = points straight back along the flight line (the flight IS a straight line), shrinking & fading. */
        pushTrail(p, size) {
            const vfx = p.def.vfx || {};
            const N = Math.max(2, Math.min(40, vfx.trail | 0 || 12));
            const spacing = size * 0.32;
            const full = N * spacing;
            let head = 0, len = Math.min(full, p.travelled), alphaK = 1;
            if (p.fading) {
                const f = p.fade / TRAIL_FADE;
                len *= (1 - f);          // tail catches up with the impact point
                alphaK = 1 - f * 0.6;
            }
            const tb = this.res.trail;
            const c = p.color;
            for (let k = 1; k <= N; k++) {
                const d = head + k * spacing;
                if (d > len) break;
                const u = k / N;                       // 0 at the head, 1 at the tail
                const jx = (Math.random() - 0.5) * 0.05, jy = (Math.random() - 0.5) * 0.05;
                const x = p.pos.x - p.dir.x * d + jx, y = p.pos.y - p.dir.y * d + jy, z = p.pos.z - p.dir.z * d;
                const w = 1 - u;
                // Hot (whitish) near the head, pure skill color toward the tail
                const hot = w * w * 0.6;
                tb.push(x, y, z,
                    c.r + (1 - c.r) * hot, c.g + (1 - c.g) * hot, c.b + (1 - c.b) * hot,
                    Math.pow(w, 1.4) * 0.85 * alphaK, size * (0.25 + 0.75 * w) * 0.9);
            }
        }

        impact(p, onGround) {
            const def = p.def;
            p.coreSprite.visible = p.glowSprite.visible = p.shadeSprite.visible = p.filaments.visible = false;
            p.fading = true;
            p.fade = 0;
            this.spawnImpact(def, p.pos, p.color, onGround);
            const dmg = def.damage || null;
            const amount = dmg && Number.isFinite(dmg.min) && Number.isFinite(dmg.max)
                ? Math.max(1, Math.round((dmg.min + Math.random() * (dmg.max - dmg.min)) * (this.game.hero ? this.game.hero.skillMult(def) : 1))) : 0;
            // Combat hook: creatures.js applies `amount` to every creature within `radius` of `point`.
            window.dispatchEvent(new CustomEvent('game:skillImpact', {
                detail: {
                    skillId: def.id,
                    point: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
                    radius: (def.vfx && def.vfx.impactRadius) || 1,
                    damage: dmg, amount, knockback: def.knockback || null, slow: def.slow || null
                }
            }));
            if (def && def.id === 'spark') {
                const cr = this.game.creatures;
                if (cr && cr.list) {
                    const anyNear = cr.list.some(r => cr.isAlive(r) && Math.hypot(r.x - p.pos.x, r.z - p.pos.z) <= (r.def.hitRadius || 0.4) + 2.0);
                    if (anyNear) {
                        const st = this.game && this.game.gameState;
                        if (st && st.setQuestFlag) st.setQuestFlag('spark_hit_creature', true);
                        const dlg = (this.game && this.game.ui && this.game.ui.dialog);
                        if (dlg && dlg.updateTracker) dlg.updateTracker();
                        if (this.game && this.game.ui && this.game.ui.updateQuestsProgress) this.game.ui.updateQuestsProgress();
                        window.dispatchEvent(new CustomEvent('game:questUpdated'));
                    }
                }
            }
        }

        updateImpact(m, delta) {
            m.age += delta;
            const vfx = m.def.vfx || {};
            const R = vfx.impactRadius || 1.4;
            const nova = !!vfx.nova;   // ring wave: no flash/bloom/decal over the caster, slower ring
            const size = vfx.size || 0.55;
            const a = m.age;
            if (a >= IMPACT_LIFE) {
                m.active = false;
                m.flash.visible = m.bloom.visible = m.ring.visible = m.decal.visible = m.scorch.visible = m.arcs.visible = false;
                return;
            }
            // Flash: fast expand, fade by 0.25 s
            const fT = Math.min(1, a / 0.25);
            m.flash.visible = !nova && fT < 1;
            m.flash.scale.setScalar(size * (1.6 + 5.6 * (1 - (1 - fT) * (1 - fT))));
            m.flash.material.opacity = (1 - fT) * (1 - fT);
            // Colored bloom: slightly slower
            const bT = Math.min(1, a / 0.35);
            m.bloom.visible = !nova && bT < 1;
            m.bloom.scale.setScalar(R * (1.2 + 1.4 * bT));
            m.bloom.material.opacity = 0.7 * (1 - bT);
            // Ground ring: expands to impactRadius, fades out
            if (m.onGround) {
                const rT = Math.min(1, a / (nova ? 0.6 : 0.45));
                const ease = 1 - Math.pow(1 - rT, 3);
                const d = 2 * R * (0.15 + 0.85 * ease);
                m.ring.scale.set(d, 1, d);
                m.ring.material.opacity = 0.95 * (1 - rT);
                m.ring.visible = (vfx.ring !== false) && rT < 1;
                const gT = Math.min(1, a / 0.65);
                m.decal.scale.set(R * 2.6, 1, R * 2.6);
                m.decal.material.opacity = 0.75 * (1 - gT) * (1 - gT);
                m.decal.visible = (vfx.decal !== false) && !nova && gT < 1;
                // Scorch: appears instantly, lingers, then fades over the rest of IMPACT_LIFE
                const sT = a / IMPACT_LIFE;
                m.scorch.scale.set(R * 2.1, 1, R * 2.1);
                m.scorch.material.opacity = (nova ? 0.3 : 0.62) * Math.min(1, (1 - sT) * 2.2);
            }
            // Short lightning arcs, re-jittered while they last
            if (a < 0.2) {
                m.boltTimer -= delta;
                if (m.boltTimer <= 0) {
                    m.boltTimer = 0.04;
                    writeBolts(m.arcs, ARCS, ARC_SEGS, R * 0.45, R * 1.05, m.onGround ? 0.35 : 1, 0.45);
                }
                m.arcs.material.opacity = 1 - a / 0.2;
            } else {
                m.arcs.visible = false;
            }
        }

        updateSparks(delta) {
            const s = this.res.sp;
            const batch = this.res.sparks;
            const terrain = this.game.terrain;
            const drag = Math.exp(-2.2 * delta);
            let i = 0;
            while (i < s.n) {
                s.age[i] += delta;
                if (s.age[i] >= s.life[i]) {
                    // swap-remove
                    const j = --s.n;
                    s.x[i] = s.x[j]; s.y[i] = s.y[j]; s.z[i] = s.z[j];
                    s.vx[i] = s.vx[j]; s.vy[i] = s.vy[j]; s.vz[i] = s.vz[j];
                    s.age[i] = s.age[j]; s.life[i] = s.life[j]; s.size[i] = s.size[j]; s.grav[i] = s.grav[j];
                    s.r[i] = s.r[j]; s.g[i] = s.g[j]; s.b[i] = s.b[j];
                    continue;
                }
                s.vy[i] -= GRAVITY * s.grav[i] * delta;
                s.vx[i] *= drag; s.vy[i] *= drag; s.vz[i] *= drag;
                s.x[i] += s.vx[i] * delta; s.y[i] += s.vy[i] * delta; s.z[i] += s.vz[i] * delta;
                if (terrain) {
                    const gy = terrain.getHeightAt(s.x[i], s.z[i]) + 0.02;
                    if (s.y[i] < gy) { s.y[i] = gy; s.vy[i] *= -0.35; s.vx[i] *= 0.55; s.vz[i] *= 0.55; }
                }
                const t = s.age[i] / s.life[i];
                const hot = (1 - t) * (1 - t);             // white-hot at birth, cools to the skill color
                const alpha = Math.pow(1 - t, 1.2);
                const cr = s.r[i] + (1 - s.r[i]) * hot, cg = s.g[i] + (1 - s.g[i]) * hot, cb = s.b[i] + (1 - s.b[i]) * hot;
                const sz = s.size[i] * (1 - 0.5 * t);
                batch.push(s.x[i], s.y[i], s.z[i], cr, cg, cb, alpha, sz);
                // Motion streak: two fainter points trailing along the velocity
                batch.push(s.x[i] - s.vx[i] * 0.012, s.y[i] - s.vy[i] * 0.012, s.z[i] - s.vz[i] * 0.012, cr, cg, cb, alpha * 0.6, sz * 0.8);
                batch.push(s.x[i] - s.vx[i] * 0.024, s.y[i] - s.vy[i] * 0.024, s.z[i] - s.vz[i] * 0.024, cr, cg, cb, alpha * 0.3, sz * 0.6);
                i++;
            }
        }

        // -----------------------------------------------------------
        // Obstacles (trees/boulders/shrubs + props): cylinder tests
        // -----------------------------------------------------------
        getBlockers() {
            const env = this.game.environment;
            const wo = this.game.worldObjects;
            const n = env ? env.objects.size : 0;
            // Versions: env bumps on hide/show (felled / regrown tree), wo on added/removed props (stumps)
            const ver = (env ? env.version || 0 : 0) * 100000 + (wo ? wo.version || 0 : 0);
            if (this._blockersEnv === env && this._blockersN === n && this._blockersWo === wo && this._blockersVer === ver && this._blockers) return this._blockers;
            const list = [];
            if (env) {
                env.objects.forEach(o => {
                    if (o.visible === false) return; // felled tree
                    const s = o.s || 1;
                    if (o.kind === 'trees') list.push({ x: o.x, z: o.z, r: 0.32 * s, h: 14, gy: null });
                    else if (o.kind === 'boulders') list.push({ x: o.x, z: o.z, r: 0.72 * (o.s || 1.8), h: 0.85 * (o.s || 1.8), gy: null });
                    else if (o.kind === 'shrubs') list.push({ x: o.x, z: o.z, r: 0.42 * (o.s || 1.8), h: 0.85 * (o.s || 1.8), gy: null });
                });
            }
            if (wo) wo.getBlockers().forEach(b => list.push({ x: b.x, z: b.z, r: b.r, h: b.h, gy: null }));
            const terrain = this.game.terrain;
            list.forEach(b => { b.gy = terrain ? terrain.getHeightAt(b.x, b.z) : 0; });
            this._blockers = list;
            this._blockersEnv = env;
            this._blockersN = n;
            this._blockersWo = wo;
            this._blockersVer = ver;
            return list;
        }

        hitsBlocker(pos) {
            const list = this.getBlockers();
            for (let i = 0; i < list.length; i++) {
                const b = list[i];
                const dx = pos.x - b.x, dz = pos.z - b.z;
                if (dx * dx + dz * dz < b.r * b.r && pos.y < b.gy + b.h) return true;
            }
            return false;
        }

        // -----------------------------------------------------------
        // Lifecycle
        // -----------------------------------------------------------
        /** Location change / character switch: drop the cast, every projectile, impact and spark. */
        clearAll() {
            this.casting = null;
            this.channel = null;
            this.rain = null;
            if (this.recallFx) this.recallFx.clearAll();
            this._blockers = null;
            this._blockersEnv = null;
            const r = this.res;
            if (!r) return;
            r.projectiles.forEach(p => {
                p.active = p.fading = false;
                p.targetCreature = null;
                p.coreSprite.visible = p.glowSprite.visible = p.shadeSprite.visible = p.filaments.visible = false;
            });
            r.impacts.forEach(m => {
                m.active = false;
                m.flash.visible = m.bloom.visible = m.ring.visible = m.decal.visible = m.scorch.visible = m.arcs.visible = false;
            });
            if (r.strikes) {
                r.strikes.forEach(s => { s.active = false; if (s.group) s.group.visible = false; s.tgt = null; });
            }
            if (r.zone) r.zone.ring.visible = r.zone.glow.visible = false;
            r.sp.n = 0;
            r.trail.begin(); r.trail.end(1);
            r.sparks.begin(); r.sparks.end(1);
        }

        /** Character switch: cooldowns belong to the previous character. */
        resetCooldowns() {
            this.readyAt = {};
            this.cdDuration = {};
        }

        /** Debug/tests: number of live projectiles. */
        activeProjectiles() {
            return this.res ? this.res.projectiles.filter(p => p.active && !p.fading).length : 0;
        }
    }

    window.AveloraSkillSystem = AveloraSkillSystem;
})();
