/**
 * Avelora — "Возвращение домой" VFX: golden rune circle, light column and rising glyph sparks.
 *
 * Used by skills.js (type "teleport"). Two modes:
 *   channel — grows for `duration` seconds (the 4 s cast): two counter-rotating rune rings on the
 *             ground, a light column that rises and brightens, glyph sparks spiralling up;
 *   arrival — short burst at the destination: rings expand while fading, column collapses.
 *
 * Style rules shared with skills.js: no THREE lights (a new light would recompile every lit
 * material), additive light is always paired with a dark NORMAL-blended underlay so it reads on the
 * bright meadow, textures are canvas-generated once per session, per-frame work allocates nothing
 * and everything advances only via update(delta) — frozen on pause. Runes are drawn as strokes
 * (not font glyphs), so they look the same on every OS/browser.
 *
 * Objects live in game.scene (NOT locationRoot: teardownLocation() disposes everything under it,
 * including textures this class reuses). clearAll() is called on location change.
 */
(function () {
    'use strict';

    const COLUMN_H = 3.6;

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function canvasTexture(size, draw) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        draw(c.getContext('2d'), size);
        const t = new THREE.CanvasTexture(c);
        t.anisotropy = 4;
        t.needsUpdate = true;
        return t;
    }

    /** One pseudo-rune at (cx,cy): a stem along the radial direction + 1-3 short branches. */
    function drawRune(ctx, cx, cy, ang, len, rnd) {
        const ux = Math.cos(ang), uy = Math.sin(ang), tx = -uy, ty = ux;
        const a = [cx - ux * len * 0.5, cy - uy * len * 0.5], b = [cx + ux * len * 0.5, cy + uy * len * 0.5];
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        const branches = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < branches; i++) {
            const at = (rnd() - 0.5) * 0.7;          // position along the stem
            const side = rnd() < 0.5 ? -1 : 1;
            const px = cx + ux * len * at, py = cy + uy * len * at;
            const dir = rnd() < 0.5 ? 1 : -1;        // slants up or down the stem
            const l2 = len * (0.28 + rnd() * 0.28);
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + tx * side * l2 + ux * dir * l2 * 0.8, py + ty * side * l2 + uy * dir * l2 * 0.8);
            ctx.stroke();
        }
    }

    function makeTextures() {
        const glow = canvasTexture(64, (ctx, s) => {
            const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
            [[0, 1], [0.2, 0.7], [0.45, 0.25], [0.75, 0.06], [1, 0]].forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`));
            ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
        });
        // soft dark disc (alpha only matters): the NORMAL-blended underlay
        const shade = canvasTexture(64, (ctx, s) => {
            const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
            [[0, 0.9], [0.6, 0.65], [0.85, 0.25], [1, 0]].forEach(([o, a]) => g.addColorStop(o, `rgba(20,12,0,${a})`));
            ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
        });
        const ringOuter = canvasTexture(512, (ctx, s) => {
            const rnd = mulberry32(11), c = s / 2;
            ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineCap = 'round';
            ctx.shadowColor = '#fff'; ctx.shadowBlur = 6;
            ctx.lineWidth = 5;
            [0.985, 0.74].forEach(r => { ctx.beginPath(); ctx.arc(c, c, c * r, 0, Math.PI * 2); ctx.stroke(); });
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(c, c, c * 0.955, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(c, c, c * 0.77, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 4;
            const N = 28;
            for (let i = 0; i < N; i++) {
                const a = i / N * Math.PI * 2;
                drawRune(ctx, c + Math.cos(a) * c * 0.855, c + Math.sin(a) * c * 0.855, a, c * 0.11, rnd);
            }
            // separators between rune cells
            ctx.lineWidth = 3;
            for (let i = 0; i < N; i += 1) {
                const a = (i + 0.5) / N * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(c + Math.cos(a) * c * 0.775, c + Math.sin(a) * c * 0.775);
                ctx.lineTo(c + Math.cos(a) * c * 0.95, c + Math.sin(a) * c * 0.95);
                ctx.stroke();
            }
        });
        const ringInner = canvasTexture(512, (ctx, s) => {
            const rnd = mulberry32(29), c = s / 2;
            ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.shadowColor = '#fff'; ctx.shadowBlur = 6;
            ctx.lineWidth = 5;
            ctx.beginPath(); ctx.arc(c, c, c * 0.98, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(c, c, c * 0.62, 0, Math.PI * 2); ctx.stroke();
            // hexagram
            ctx.lineWidth = 4;
            [-Math.PI / 2, Math.PI / 2].forEach(base => {
                ctx.beginPath();
                for (let i = 0; i < 3; i++) {
                    const a = base + i * Math.PI * 2 / 3;
                    const x = c + Math.cos(a) * c * 0.62, y = c + Math.sin(a) * c * 0.62;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.closePath(); ctx.stroke();
            });
            const N = 12;
            ctx.lineWidth = 5;
            for (let i = 0; i < N; i++) {
                const a = (i + 0.5) / N * Math.PI * 2;
                drawRune(ctx, c + Math.cos(a) * c * 0.8, c + Math.sin(a) * c * 0.8, a, c * 0.14, rnd);
            }
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(c, c, c * 0.1, 0, Math.PI * 2); ctx.stroke();
        });
        return { glow, shade, ringOuter, ringInner };
    }

    const COLUMN_VERT = `
        varying float vH;
        varying float vAng;
        void main() {
            vH = position.y / ${COLUMN_H.toFixed(2)};
            vAng = atan(position.z, position.x);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`;
    const COLUMN_FRAG = `
        uniform float uTime;
        uniform float uAlpha;
        uniform vec3 uColor;
        uniform vec3 uCore;
        varying float vH;
        varying float vAng;
        void main() {
            float rays = 0.55 + 0.45 * sin(vAng * 7.0 + uTime * 2.6 - vH * 9.0);
            float fall = pow(1.0 - vH, 1.6);
            float a = fall * rays * uAlpha;
            vec3 col = mix(uColor, uCore, fall * 0.6);
            gl_FragColor = vec4(col, a);
        }`;

    const SPARK_VERT = `
        uniform float uTime, uProgress, uRadius, uPixel, uLift;
        attribute float aPhase, aAng, aRad, aSpeed, aSize;
        varying float vA;
        void main() {
            float t = fract(aPhase + uTime * aSpeed * (0.22 + 0.78 * uProgress));
            float dirn = aRad > 0.55 ? 1.0 : -1.0;
            float ang = aAng + uTime * (0.7 + 1.8 * uProgress) * dirn;
            float r = uRadius * mix(aRad, aRad * 0.3, t);
            vec3 p = vec3(cos(ang) * r, 0.05 + t * ${COLUMN_H.toFixed(2)} * uLift, sin(ang) * r);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = aSize * uPixel / max(1.0, -mv.z);
            vA = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.55, 1.0, t)) * (0.25 + 0.75 * uProgress);
        }`;
    const SPARK_FRAG = `
        uniform vec3 uColor;
        uniform vec3 uCore;
        varying float vA;
        void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c) * 2.0;
            if (d > 1.0) discard;
            float soft = exp(-d * d * 3.2);
            float cross = max(0.0, 1.0 - abs(c.x) * 14.0) * max(0.0, 1.0 - abs(c.y) * 2.2)
                        + max(0.0, 1.0 - abs(c.y) * 14.0) * max(0.0, 1.0 - abs(c.x) * 2.2);
            float a = (soft + cross * 0.6) * vA;
            gl_FragColor = vec4(mix(uColor, uCore, soft), a);
        }`;

    const SPARK_COUNT = 70;

    class AveloraRecallFX {
        constructor(game) {
            this.game = game;
            this.tex = null;
            this.geo = null;
            this.effects = [];
            this._tmpV2 = new THREE.Vector2();
            this._color = new THREE.Color();
            this._core = new THREE.Color();
        }

        ensureResources() {
            if (this.tex) return;
            this.tex = makeTextures();
            this.geo = {
                plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
                column: new THREE.CylinderGeometry(1, 1, COLUMN_H, 40, 1, true).translate(0, COLUMN_H / 2, 0),
                sparks: (() => {
                    const rnd = mulberry32(5);
                    const g = new THREE.BufferGeometry();
                    const z = new Float32Array(SPARK_COUNT * 3);
                    const attr = n => { const a = new Float32Array(SPARK_COUNT); for (let i = 0; i < SPARK_COUNT; i++) a[i] = n(i); return a; };
                    g.setAttribute('position', new THREE.BufferAttribute(z, 3));
                    g.setAttribute('aPhase', new THREE.BufferAttribute(attr(() => rnd()), 1));
                    g.setAttribute('aAng', new THREE.BufferAttribute(attr(() => rnd() * Math.PI * 2), 1));
                    g.setAttribute('aRad', new THREE.BufferAttribute(attr(() => 0.25 + rnd() * 0.75), 1));
                    g.setAttribute('aSpeed', new THREE.BufferAttribute(attr(() => 0.35 + rnd() * 0.55), 1));
                    g.setAttribute('aSize', new THREE.BufferAttribute(attr(() => 0.14 + rnd() * 0.22), 1));
                    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, COLUMN_H / 2, 0), 4);
                    return g;
                })()
            };
        }

        /**
         * Starts an effect at world (x, z). opts: { mode: 'channel'|'arrival', duration, radius, color, core }.
         * Returns a handle; call stop() to remove it early (fades out quickly).
         */
        start(x, z, opts) {
            this.ensureResources();
            const mode = opts.mode === 'arrival' ? 'arrival' : 'channel';
            const radius = opts.radius || 1.7;
            const color = new THREE.Color(opts.color || '#ffc94d');
            const core = new THREE.Color(opts.core || '#fff3c4');
            const tex = this.tex;
            const mats = [];
            const mk = (m) => { mats.push(m); return m; };

            const group = new THREE.Group();
            const y = this.game.terrain.getHeightAt(x, z);
            group.position.set(x, y + 0.07, z);
            group.renderOrder = 6;

            const flat = (mat, size, order) => {
                const m = new THREE.Mesh(this.geo.plane, mat);
                m.scale.set(size, 1, size);
                m.renderOrder = order;
                group.add(m);
                return m;
            };
            const common = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };

            const shade = flat(mk(new THREE.MeshBasicMaterial(Object.assign({ map: tex.shade, opacity: 0, fog: false }, common))), radius * 2.9, 6);
            const glowMat = mk(new THREE.MeshBasicMaterial(Object.assign({ map: tex.glow, color, opacity: 0, blending: THREE.AdditiveBlending, fog: false }, common)));
            const glow = flat(glowMat, radius * 2.4, 7);
            const outerMat = mk(new THREE.MeshBasicMaterial(Object.assign({ map: tex.ringOuter, color, opacity: 0, blending: THREE.AdditiveBlending, fog: false }, common)));
            const outer = flat(outerMat, radius * 2.0, 8);
            const innerMat = mk(new THREE.MeshBasicMaterial(Object.assign({ map: tex.ringInner, color: core, opacity: 0, blending: THREE.AdditiveBlending, fog: false }, common)));
            const inner = flat(innerMat, radius * 1.25, 9);

            const colMat = mk(new THREE.ShaderMaterial({
                uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: color }, uCore: { value: core } },
                vertexShader: COLUMN_VERT, fragmentShader: COLUMN_FRAG,
                transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false
            }));
            const column = new THREE.Mesh(this.geo.column, colMat);
            column.scale.set(radius * 0.72, 0.01, radius * 0.72);
            column.renderOrder = 10;
            group.add(column);

            const sparkMat = mk(new THREE.ShaderMaterial({
                uniforms: {
                    uTime: { value: 0 }, uProgress: { value: 0 }, uRadius: { value: radius * 0.92 }, uPixel: { value: 800 },
                    uLift: { value: 1 }, uColor: { value: color }, uCore: { value: core }
                },
                vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
                transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false
            }));
            const sparks = new THREE.Points(this.geo.sparks, sparkMat);
            sparks.renderOrder = 11;
            sparks.onBeforeRender = (renderer, scene, camera) => {
                const h = renderer.getDrawingBufferSize(this._tmpV2).y;
                sparkMat.uniforms.uPixel.value = h / (2 * Math.tan((camera.fov || 45) * Math.PI / 360));
            };
            group.add(sparks);

            this.game.scene.add(group);
            const fx = {
                mode, group, mats, radius, t: 0,
                duration: Math.max(0.2, opts.duration || (mode === 'arrival' ? 1.6 : 4)),
                fade: -1,            // >= 0 once stop() was called: seconds since
                fadeFrom: 1,
                level: 0,            // current overall intensity 0..1 (for stop() to fade from)
                rot: 0,
                parts: { shade, glow, outer, inner, column, sparks },
                u: { glowMat, outerMat, innerMat, colMat, sparkMat, shadeMat: shade.material },
                stop: () => { if (fx.fade < 0) { fx.fade = 0; fx.fadeFrom = Math.max(0.05, fx.level); } }
            };
            this.effects.push(fx);
            this.apply(fx, 0);
            return fx;
        }

        /** Sets every visual property from fx.t / fx.fade. */
        apply(fx, delta) {
            const { parts, u } = fx;
            const p = Math.min(1, fx.t / fx.duration);
            let intensity, radial, colH, colA, prog;
            if (fx.mode === 'channel') {
                const fadeIn = Math.min(1, fx.t / 0.45);
                intensity = fadeIn * fadeIn * (3 - 2 * fadeIn);
                radial = 0.55 + 0.45 * Math.min(1, fx.t / 0.6);
                prog = p;
                const rise = Math.max(0, Math.min(1, (p - 0.2) / 0.8));
                colH = 0.02 + rise * rise * (3 - 2 * rise);
                colA = 0.05 + 0.3 * rise + 0.25 * p * p;
            } else {
                const k = 1 - p;
                intensity = k * k;
                radial = 1.0 + (1 - k) * 0.55;
                prog = 1;
                colH = 0.35 + 0.65 * k;
                colA = 0.55 * k * k;
            }
            if (fx.fade >= 0) {
                const f = Math.max(0, 1 - fx.fade / 0.35);
                intensity *= f * fx.fadeFrom; colA *= f; prog *= f;
            }
            fx.level = intensity;

            const pulse = 0.85 + 0.15 * Math.sin(fx.t * 6.0);
            const spin = fx.mode === 'channel' ? (0.55 + 2.4 * p * p * p) : 1.2;
            fx.rot += spin * delta;
            parts.outer.rotation.y = fx.rot;
            parts.inner.rotation.y = -fx.rot * 1.35;
            parts.outer.scale.set(fx.radius * 2.0 * radial, 1, fx.radius * 2.0 * radial);
            parts.inner.scale.set(fx.radius * 1.25 * radial, 1, fx.radius * 1.25 * radial);
            u.shadeMat.opacity = 0.45 * intensity;
            u.glowMat.opacity = (0.30 + 0.25 * p) * intensity * pulse;
            u.outerMat.opacity = 0.95 * intensity;
            u.innerMat.opacity = 0.9 * intensity * (0.8 + 0.2 * pulse);
            parts.column.scale.set(fx.radius * 0.72 * (0.9 + 0.1 * pulse), Math.max(0.01, colH), fx.radius * 0.72 * (0.9 + 0.1 * pulse));
            u.colMat.uniforms.uAlpha.value = colA;
            u.colMat.uniforms.uTime.value = fx.t;
            u.sparkMat.uniforms.uTime.value = fx.t;
            u.sparkMat.uniforms.uProgress.value = fx.mode === 'channel' ? prog : 1;
            u.sparkMat.uniforms.uLift.value = 0.35 + 0.65 * (fx.mode === 'channel' ? Math.min(1, p * 1.4) : 1);
        }

        update(delta) {
            for (let i = this.effects.length - 1; i >= 0; i--) {
                const fx = this.effects[i];
                fx.t += delta;
                if (fx.fade >= 0) fx.fade += delta;
                this.apply(fx, delta);
                const done = fx.fade >= 0.35 || (fx.mode === 'arrival' && fx.t >= fx.duration);
                if (done) { this.remove(fx); this.effects.splice(i, 1); }
            }
        }

        remove(fx) {
            if (fx.group.parent) fx.group.parent.remove(fx.group);
            fx.mats.forEach(m => m.dispose());   // geometries + textures are shared and kept
        }

        /** Location change / character switch: drop every effect. */
        clearAll() {
            this.effects.forEach(fx => this.remove(fx));
            this.effects.length = 0;
        }
    }

    window.AveloraRecallFX = AveloraRecallFX;
})();
