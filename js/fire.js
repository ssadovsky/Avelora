/**
 * Avelora — Campfire flame (AveloraFire)
 *
 * Self-contained fire made of GPU particles: every particle's motion is computed in the vertex
 * shader from `uTime`, so the per-frame JS cost is a couple of uniform writes and there is
 * nothing to allocate. Layers (back to front):
 *   - ground glow (soft warm disc on the ground, flickers) + coals (glowing patch in the pit),
 *   - flame tongues (additive, white-yellow -> orange -> red-dark over their life),
 *   - embers (tiny bright sparks drifting up and sideways),
 *   - smoke (big soft NORMAL-blended grey puffs — readable in daylight, additive would vanish).
 * No THREE lights are added (a new light would recompile every lit material); the "light" is the
 * glow sprite. Advances via update(delta) only -> frozen on pause.
 *
 * Created by world_objects.js for props whose prop.json has a `fire` block:
 *   "fire": { "y": 0.1, "size": 0.65 }   // y = flame base above the prop origin (m, prop scale
 *                                        // applied), size = overall flame scale (1 ~ 1 m tall)
 * Everything lives under game.locationRoot -> teardownLocation() disposes it with the location.
 */
(function () {
    'use strict';

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const VERT = `
        uniform float uTime, uPixel, uHeight, uRadius, uSway, uRise;
        attribute float aSeed, aSpeed, aSize, aAng, aRad;
        varying float vAge;
        varying float vSeed;
        void main() {
            float t = fract(aSeed + uTime * aSpeed);
            vAge = t;
            vSeed = aSeed;
            float sw = sin(uTime * 2.6 + aSeed * 37.0 + t * 4.0) * uSway * t;
            float sw2 = cos(uTime * 2.1 + aSeed * 23.0 + t * 3.0) * uSway * t;
            float r = aRad * uRadius * (1.0 - t * uRise);
            vec3 p = vec3(cos(aAng) * r + sw, t * uHeight * (0.6 + 0.4 * fract(aSeed * 7.13)), sin(aAng) * r + sw2);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float flick = 0.88 + 0.12 * sin(uTime * 13.0 + aSeed * 31.0);
            gl_PointSize = aSize * flick * SIZE_CURVE * uPixel / max(1.0, -mv.z);
        }`;

    const FRAG_FLAME = `
        varying float vAge;
        varying float vSeed;
        void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c) * 2.0;
            if (d > 1.0) discard;
            float soft = 1.0 - d; soft *= soft;
            vec3 col = mix(vec3(1.0, 0.93, 0.62), vec3(1.0, 0.46, 0.08), smoothstep(0.0, 0.5, vAge));
            col = mix(col, vec3(0.65, 0.13, 0.02), smoothstep(0.5, 1.0, vAge));
            float a = soft * smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge)) * 0.85;
            gl_FragColor = vec4(col, a);
        }`;
    const FRAG_EMBER = `
        varying float vAge;
        varying float vSeed;
        void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c) * 2.0;
            if (d > 1.0) discard;
            float soft = exp(-d * d * 3.5);
            vec3 col = mix(vec3(1.0, 0.85, 0.45), vec3(1.0, 0.35, 0.05), vAge);
            float tw = 0.6 + 0.4 * sin(vAge * 40.0 + vSeed * 50.0);
            float a = soft * tw * smoothstep(0.0, 0.05, vAge) * (1.0 - smoothstep(0.4, 1.0, vAge));
            gl_FragColor = vec4(col, a);
        }`;
    const FRAG_SMOKE = `
        varying float vAge;
        varying float vSeed;
        void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c) * 2.0;
            if (d > 1.0) discard;
            float soft = 1.0 - d; soft = soft * soft * (3.0 - 2.0 * soft);
            float shade = 0.36 + 0.14 * fract(vSeed * 9.7);
            float a = soft * smoothstep(0.0, 0.18, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge)) * 0.17;
            gl_FragColor = vec4(vec3(shade), a);
        }`;

    class AveloraFire {
        /** parent: THREE.Object3D (game.locationRoot). opts: { x, y (world), z, size, seed } */
        constructor(parent, opts) {
            this.parent = parent;
            this.time = Math.random() * 10;
            this.size = opts.size || 1;
            const S = this.size;
            this.group = new THREE.Group();
            this.group.name = 'fire';
            this.group.position.set(opts.x, opts.y, opts.z);
            this.materials = [];
            this.geometries = [];
            this.textures = [];
            const rnd = mulberry32(opts.seed || 1234);

            // ---- soft radial texture for glow / coals
            const cv = document.createElement('canvas');
            cv.width = cv.height = 64;
            const cx = cv.getContext('2d');
            const gr = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
            [[0, 1], [0.25, 0.7], [0.55, 0.28], [0.8, 0.07], [1, 0]].forEach(([o, a]) => gr.addColorStop(o, `rgba(255,255,255,${a})`));
            cx.fillStyle = gr; cx.fillRect(0, 0, 64, 64);
            const glowTex = new THREE.CanvasTexture(cv);
            this.textures.push(glowTex);

            const flat = (size, color, opacity, blending, order) => {
                const geo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
                const mat = new THREE.MeshBasicMaterial({
                    map: glowTex, color, transparent: true, opacity, depthWrite: false, blending,
                    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
                });
                const m = new THREE.Mesh(geo, mat);
                m.renderOrder = order;
                this.geometries.push(geo); this.materials.push(mat);
                this.group.add(m);
                return m;
            };
            // coals in the pit and the warm wash on the ground around it
            this.coals = flat(1.25 * S, 0xff5a14, 0.75, THREE.AdditiveBlending, 6);
            this.coals.position.y = 0.02;
            this.glow = flat(5.2 * S, 0xff8a30, 0.2, THREE.AdditiveBlending, 5);
            this.glow.position.y = -0.06 * S;

            // ---- particle layers
            this.uniformSets = [];
            this.tmp = new THREE.Vector2();
            const layer = (cfg) => {
                const n = cfg.count;
                const g = new THREE.BufferGeometry();
                const mk = f => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = f(i); return new THREE.BufferAttribute(a, 1); };
                g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
                g.setAttribute('aSeed', mk(() => rnd()));
                g.setAttribute('aSpeed', mk(() => cfg.speed[0] + rnd() * (cfg.speed[1] - cfg.speed[0])));
                g.setAttribute('aSize', mk(() => (cfg.size[0] + rnd() * (cfg.size[1] - cfg.size[0])) * S));
                g.setAttribute('aAng', mk(() => rnd() * Math.PI * 2));
                g.setAttribute('aRad', mk(() => Math.sqrt(rnd())));
                g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, cfg.height * S * 0.5, 0), cfg.height * S + 2);
                const u = {
                    uTime: { value: 0 }, uPixel: { value: 800 }, uHeight: { value: cfg.height * S },
                    uRadius: { value: cfg.radius * S }, uSway: { value: cfg.sway * S }, uRise: { value: cfg.narrow }
                };
                const mat = new THREE.ShaderMaterial({
                    uniforms: u,
                    vertexShader: VERT.replace('SIZE_CURVE', cfg.sizeCurve),
                    fragmentShader: cfg.frag,
                    transparent: true, depthWrite: false, blending: cfg.blending, fog: false
                });
                const pts = new THREE.Points(g, mat);
                pts.renderOrder = cfg.order;
                pts.onBeforeRender = (renderer, scene, camera) => {
                    const h = renderer.getDrawingBufferSize(this.tmp).y;
                    u.uPixel.value = h / (2 * Math.tan((camera.fov || 45) * Math.PI / 360));
                };
                this.geometries.push(g); this.materials.push(mat); this.uniformSets.push(u);
                this.group.add(pts);
            };
            layer({ count: 34, speed: [0.85, 1.35], size: [0.55, 0.85], height: 1.05, radius: 0.26, sway: 0.10, narrow: 0.75, sizeCurve: '(1.0 - t * 0.72)', frag: FRAG_FLAME, blending: THREE.AdditiveBlending, order: 8 });
            layer({ count: 16, speed: [1.1, 1.8], size: [0.30, 0.5], height: 0.7, radius: 0.18, sway: 0.06, narrow: 0.6, sizeCurve: '(1.0 - t * 0.6)', frag: FRAG_FLAME, blending: THREE.AdditiveBlending, order: 9 });
            layer({ count: 14, speed: [0.16, 0.30], size: [0.07, 0.12], height: 3.2, radius: 0.3, sway: 0.65, narrow: -0.6, sizeCurve: '1.0', frag: FRAG_EMBER, blending: THREE.AdditiveBlending, order: 10 });
            layer({ count: 11, speed: [0.10, 0.17], size: [0.9, 1.5], height: 3.4, radius: 0.22, sway: 0.75, narrow: -1.1, sizeCurve: '(0.55 + t * 1.0)', frag: FRAG_SMOKE, blending: THREE.NormalBlending, order: 7 });

            parent.add(this.group);
            this.update(0);
        }

        update(delta) {
            this.time += delta;
            const t = this.time;
            for (let i = 0; i < this.uniformSets.length; i++) this.uniformSets[i].uTime.value = t;
            const f = 0.5 + 0.5 * Math.sin(t * 9.0) * Math.sin(t * 5.3 + 1.0);
            this.glow.material.opacity = 0.16 + 0.07 * f + 0.02 * Math.sin(t * 23.0);
            this.coals.material.opacity = 0.62 + 0.2 * Math.sin(t * 3.1) * Math.sin(t * 7.7);
        }

        dispose() {
            if (this.group.parent) this.group.parent.remove(this.group);
            this.geometries.forEach(g => g.dispose());
            this.materials.forEach(m => m.dispose());
            this.textures.forEach(t => t.dispose());
            this.geometries.length = this.materials.length = this.textures.length = 0;
        }
    }

    window.AveloraFire = AveloraFire;
})();
