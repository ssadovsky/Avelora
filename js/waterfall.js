/**
 * AVELORA - Stonewatch Cliffs waterfall (east rim of «Лесная опушка»)
 *
 * Rocks: static Meshy model `waterfall_cliffs` (temp_work/lib/3d/Stonewatch_Cliffs_texture.glb,
 * simplified 112k -> 40k tris, textures 2048/1024 JPEG) — a horseshoe of cliffs with a flat
 * stone basin in front (local +Z). The model itself has NO water and NO shader tricks.
 *
 * Water is built here from simple geometry, in the model's LOCAL coordinates (the group is
 * scaled/rotated as a whole), so it stays glued to the rocks whatever x/z/scale/rotation:
 *   - ribbons: curved sheets from the plateau lip down the cliff face; UV-scrolling streaks
 *     and foam, ragged fading edges, a faint faster "veil" layer in front of each sheet;
 *   - pool: a shallow water sheet over the basin with impact foam and expanding ripples;
 *   - spray + mist: GPU particles (all motion in the vertex shader, zero JS work per frame).
 *
 * Local landmarks (measured by ray-casting the model; bbox x -0.95..0.95, y -0.39..0.38,
 * z -0.72..0.72): upper plateau y ~0.21 (centre) / ~0.29 (right), right mid ledge y ~-0.06,
 * basin floor y ~-0.33..-0.37 at z 0.05..0.65.
 */
(function () {
    const BASIN_LEVEL = -0.327;   // local Y of the pool surface

    // Ribbon centre-lines (local). w = width (local units), reset = water lands and restarts slowly
    const FALLS = [
        {   // main fall: centre plateau -> basin
            bulge: 0.018,
            points: [
                { p: [-0.06, 0.212, -0.15], w: 0.20 },
                { p: [-0.06, 0.209, -0.075], w: 0.27 },
                { p: [-0.06, 0.200, -0.050], w: 0.29 },
                { fall: { to: -0.335, k: 0.23 }, w: 0.31 }
            ]
        },
        {   // right cascade: upper plateau -> mid ledge -> basin
            bulge: 0.012,
            points: [
                { p: [0.45, 0.292, -0.245], w: 0.10 },
                { p: [0.45, 0.286, -0.175], w: 0.14 },
                { p: [0.45, 0.278, -0.150], w: 0.15 },
                { fall: { to: -0.045, k: 0.20 }, w: 0.16 },
                { p: [0.45, -0.047, 0.020], w: 0.17, reset: true },
                { p: [0.45, -0.052, 0.062], w: 0.17 },
                { fall: { to: -0.320, k: 0.19 }, w: 0.18 }
            ]
        }
    ];

    const POOL = { cx: 0.08, cz: 0.335, rx: 0.40, rz: 0.30 };

    const GLSL_NOISE = `
        float wf_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wf_noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(wf_hash(i), wf_hash(i + vec2(1.0, 0.0)), f.x),
                       mix(wf_hash(i + vec2(0.0, 1.0)), wf_hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float wf_fbm(vec2 p) {
            float v = 0.0, a = 0.5;
            for (int i = 0; i < 3; i++) { v += a * wf_noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
            return v;
        }
    `;

    class AveloraWaterfall {
        constructor(scene, config = {}, terrain = null, pathfinder = null) {
            this.scene = scene;
            this.config = config;
            this.terrain = terrain;
            this.pathfinder = pathfinder;

            this.x = config.x !== undefined ? config.x : 128.0;
            this.z = config.z !== undefined ? config.z : 6.0;
            this.scale = config.scale || 16.0;
            this.rotationY = config.rotationY !== undefined ? config.rotationY : -Math.PI / 2;

            this.time = 0;
            this.timeUniform = { value: 0 };
            this.materials = [];
            this.geometries = [];

            this.group = new THREE.Group();
            this.group.name = `waterfall:${config.id || 'stonewatch'}`;
            this.group.position.set(this.x, 0, this.z);
            this.group.rotation.y = this.rotationY;
            this.group.scale.setScalar(this.scale);
            this.group.updateMatrixWorld(true);
            this.group.position.y = config.y !== undefined ? config.y : this.autoHeight();
            this.scene.add(this.group);

            this.loadModel(config.modelKey || 'waterfall_cliffs');
            this.buildFalls();
            this.buildPool();
            this.buildSpray();
            this.registerObstacles();
        }

        /** Basin surface just above the highest ground under the pool, so grass never pokes through. */
        autoHeight() {
            if (!this.terrain || !this.terrain.getHeightAt) return 5.65;
            const v = new THREE.Vector3();
            let maxG = -Infinity;
            for (let a = 0; a < 6; a++) {
                for (let r = 0; r <= 1.0001; r += 0.25) {
                    const ang = a / 6 * Math.PI * 2;
                    v.set(POOL.cx + Math.cos(ang) * POOL.rx * r * 1.1, 0, POOL.cz + Math.sin(ang) * POOL.rz * r * 1.1);
                    this.group.localToWorld(v);
                    maxG = Math.max(maxG, this.terrain.getHeightAt(v.x, v.z));
                }
            }
            return maxG + 0.04 - BASIN_LEVEL * this.scale;
        }

        loadModel(key) {
            const b64 = window.GAME_ASSETS && window.GAME_ASSETS.models && window.GAME_ASSETS.models[key];
            if (!b64) {
                console.warn(`[AveloraWaterfall] Model "${key}" not found in GAME_ASSETS.models`);
                return;
            }
            const bin = window.atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

            new THREE.GLTFLoader().parse(bytes.buffer, '', (gltf) => {
                if (this.disposed) return;
                this.model = gltf.scene;
                this.model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                this.group.add(this.model);
            }, (err) => console.error(`[AveloraWaterfall] Failed to parse GLTF model "${key}"`, err));
        }

        // ------------------------------------------------------------------
        // Falling water sheets
        // ------------------------------------------------------------------
        /** Expands `fall` steps into a parabolic free-fall arc from the previous point. */
        expandPath(def) {
            const out = [];
            let last = null;
            def.points.forEach((pt) => {
                if (pt.fall) {
                    const lip = last.p;
                    const drop = lip[1] - pt.fall.to;
                    const n = 9;
                    for (let i = 1; i <= n; i++) {
                        const t = i / n;
                        const d = drop * t * t; // denser samples near the lip, where the curve bends
                        const p = [lip[0], lip[1] - d, lip[2] + pt.fall.k * Math.sqrt(d)];
                        out.push({ p, w: last.w + (pt.w - last.w) * t });
                    }
                    last = out[out.length - 1];
                } else {
                    last = { p: pt.p, w: pt.w, reset: pt.reset };
                    out.push(last);
                }
            });
            return out;
        }

        buildRibbonGeometry(def, offsetOut, widthMul) {
            const pts = this.expandPath(def);
            const curve = new THREE.CatmullRomCurve3(pts.map(q => new THREE.Vector3(q.p[0], q.p[1], q.p[2])), false, 'centripetal');
            const SEG = 64, ACROSS = 14;
            const s = this.scale;

            // width / reset lookup by nearest control point along the curve parameter
            const cum = [0];
            for (let i = 1; i < pts.length; i++) {
                const a = pts[i - 1].p, b = pts[i].p;
                cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
            }
            const total = cum[cum.length - 1];
            const widthAt = (u) => {
                const L = u * total;
                for (let i = 1; i < cum.length; i++) {
                    if (L <= cum[i]) {
                        const t = (L - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
                        return pts[i - 1].w + (pts[i].w - pts[i - 1].w) * t;
                    }
                }
                return pts[pts.length - 1].w;
            };
            const resetYs = pts.filter(q => q.reset).map(q => q.p[1]);

            const pos = [], uv = [], along = [], widthM = [], idx = [];
            const across = new THREE.Vector3(1, 0, 0);
            const tan = new THREE.Vector3(), nrm = new THREE.Vector3(), c = new THREE.Vector3();
            let T = 0, prev = null, topY = pts[0].p[1];

            for (let i = 0; i <= SEG; i++) {
                const u = i / SEG;
                curve.getPointAt(u, c);
                curve.getTangentAt(u, tan);
                nrm.crossVectors(across, tan).normalize();          // points out of the cliff (+Z-ish)
                if (nrm.z < 0) nrm.negate();
                resetYs.forEach(ry => { if (prev && prev.y > ry + 0.002 && c.y <= ry + 0.002) topY = ry; });
                // travel time: water accelerates as it falls (v = sqrt(v0^2 + 2 g h)) -> streaks stretch
                if (prev) {
                    const dropM = Math.max(0, (topY - c.y) * s);
                    const speed = Math.sqrt(1.4 * 1.4 + 2 * 9.8 * dropM);
                    T += prev.distanceTo(c) * s / speed;
                }
                prev = c.clone();
                const w = widthAt(u) * widthMul;
                for (let j = 0; j <= ACROSS; j++) {
                    const v = j / ACROSS;
                    const x = (v - 0.5) * w;
                    const bulge = def.bulge * (1 - (2 * v - 1) * (2 * v - 1)) + offsetOut;
                    pos.push(c.x + x, c.y + nrm.y * bulge, c.z + nrm.z * bulge);
                    uv.push(v, T);
                    along.push(u);
                    widthM.push(w * s);
                }
            }
            for (let i = 0; i < SEG; i++) {
                for (let j = 0; j < ACROSS; j++) {
                    const a = i * (ACROSS + 1) + j, b = a + ACROSS + 1;
                    idx.push(a, b, a + 1, b, b + 1, a + 1);
                }
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
            g.setAttribute('aWidthM', new THREE.Float32BufferAttribute(widthM, 1));
            g.setIndex(idx);
            g.computeVertexNormals();
            this.geometries.push(g);
            return g;
        }

        makeRibbonMaterial(opts) {
            const mat = new THREE.ShaderMaterial({
                uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
                    uTime: { value: 0 },
                    uOpacity: { value: opts.opacity },
                    uFlow: { value: opts.flow },
                    uSeed: { value: opts.seed }
                }]),
                vertexShader: `
                    attribute float aAlong;
                    attribute float aWidthM;
                    varying vec2 vUv;
                    varying float vAlong;
                    varying float vWidthM;
                    varying vec3 vNormalW;
                    varying vec3 vViewW;
                    #include <fog_pars_vertex>
                    void main() {
                        vUv = uv; vAlong = aAlong; vWidthM = aWidthM;
                        vec4 wp = modelMatrix * vec4(position, 1.0);
                        vNormalW = normalize(mat3(modelMatrix) * normal);
                        vViewW = cameraPosition - wp.xyz;
                        vec4 mvPosition = viewMatrix * wp;
                        gl_Position = projectionMatrix * mvPosition;
                        #include <fog_vertex>
                    }`,
                fragmentShader: `
                    uniform float uTime;
                    uniform float uOpacity;
                    uniform float uFlow;
                    uniform float uSeed;
                    varying vec2 vUv;
                    varying float vAlong;
                    varying float vWidthM;
                    varying vec3 vNormalW;
                    varying vec3 vViewW;
                    #include <fog_pars_fragment>
                    ${GLSL_NOISE}
                    void main() {
                        float flow = (vUv.y - uTime * uFlow) * 2.2;
                        float xm = vUv.x * vWidthM;
                        float n1 = wf_fbm(vec2(xm * 0.9 + uSeed, flow * 0.9));
                        float n2 = wf_fbm(vec2(xm * 2.6 + uSeed * 3.1, flow * 2.4));
                        float streak = smoothstep(0.38, 0.78, n1 * 0.55 + n2 * 0.45);

                        // ragged side edges + soft start on the plateau
                        float ragged = (n2 - 0.5) * 0.10;
                        float edge = smoothstep(0.0, 0.16 + ragged, vUv.x) * smoothstep(1.0, 0.84 - ragged, vUv.x);
                        float head = smoothstep(0.03, 0.15, vAlong);

                        // foam: churn at the lip and heavy white water at the impact
                        float lipFoam = smoothstep(0.08, 0.20, vAlong) * (1.0 - smoothstep(0.22, 0.40, vAlong));
                        float impact = smoothstep(0.72, 1.0, vAlong);
                        float foam = clamp(streak * 0.75 + impact * (0.55 + 0.6 * n2) + lipFoam * 0.35 * n1, 0.0, 1.0);

                        vec3 deep  = vec3(0.16, 0.36, 0.40);
                        vec3 light = vec3(0.55, 0.76, 0.80);
                        vec3 white = vec3(0.93, 0.97, 1.0);
                        vec3 col = mix(deep, light, n1);
                        col = mix(col, white, foam);

                        vec3 N = normalize(vNormalW), V = normalize(vViewW);
                        float fres = pow(1.0 - abs(dot(N, V)), 2.0);
                        col += vec3(0.10, 0.13, 0.15) * fres;

                        float a = uOpacity * edge * head * (0.50 + 0.50 * max(streak, foam));
                        if (a < 0.01) discard;
                        gl_FragColor = vec4(col, a);
                        #include <fog_fragment>
                    }`,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: true
            });
            mat.uniforms.uTime = this.timeUniform;
            this.materials.push(mat);
            return mat;
        }

        buildFalls() {
            FALLS.forEach((def, i) => {
                const sheet = new THREE.Mesh(this.buildRibbonGeometry(def, 0.0, 1.0),
                    this.makeRibbonMaterial({ opacity: 0.92, flow: 1.0, seed: i * 13.7 }));
                sheet.renderOrder = 3;
                this.group.add(sheet);

                // faster, fainter veil a little in front: gives the sheet thickness and motion depth
                const veil = new THREE.Mesh(this.buildRibbonGeometry(def, 0.012, 1.08),
                    this.makeRibbonMaterial({ opacity: 0.38, flow: 1.35, seed: i * 13.7 + 5.3 }));
                veil.renderOrder = 4;
                this.group.add(veil);
            });
        }

        // ------------------------------------------------------------------
        // Plunge pool
        // ------------------------------------------------------------------
        buildPool() {
            const g = new THREE.CircleGeometry(1, 72);
            g.rotateX(-Math.PI / 2);
            const p = g.attributes.position;
            for (let i = 0; i < p.count; i++) {
                p.setX(i, POOL.cx + p.getX(i) * POOL.rx);
                p.setZ(i, POOL.cz + p.getZ(i) * POOL.rz);
                p.setY(i, BASIN_LEVEL);
            }
            this.geometries.push(g);

            // impact zones in local xz: main fall = segment, right cascade = point
            const main = this.expandPath(FALLS[0]), right = this.expandPath(FALLS[1]);
            const mEnd = main[main.length - 1], rEnd = right[right.length - 1];
            const mat = new THREE.ShaderMaterial({
                uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
                    uTime: { value: 0 },
                    uScale: { value: this.scale },
                    uPool: { value: new THREE.Vector4(POOL.cx, POOL.cz, POOL.rx, POOL.rz) },
                    uHitA: { value: new THREE.Vector2(mEnd.p[0] - mEnd.w * 0.45, mEnd.p[2]) },
                    uHitB: { value: new THREE.Vector2(mEnd.p[0] + mEnd.w * 0.45, mEnd.p[2]) },
                    uHitC: { value: new THREE.Vector2(rEnd.p[0], rEnd.p[2]) }
                }]),
                vertexShader: `
                    varying vec2 vLocal;
                    varying vec3 vViewW;
                    #include <fog_pars_vertex>
                    void main() {
                        vLocal = position.xz;
                        vec4 wp = modelMatrix * vec4(position, 1.0);
                        vViewW = cameraPosition - wp.xyz;
                        vec4 mvPosition = viewMatrix * wp;
                        gl_Position = projectionMatrix * mvPosition;
                        #include <fog_vertex>
                    }`,
                fragmentShader: `
                    uniform float uTime;
                    uniform float uScale;
                    uniform vec4 uPool;
                    uniform vec2 uHitA, uHitB, uHitC;
                    varying vec2 vLocal;
                    varying vec3 vViewW;
                    #include <fog_pars_fragment>
                    ${GLSL_NOISE}
                    float segDist(vec2 p, vec2 a, vec2 b) {
                        vec2 ab = b - a; float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
                        return length(p - (a + ab * t));
                    }
                    void main() {
                        vec2 m = vLocal * uScale;                       // meters
                        float e = length((vLocal - uPool.xy) / uPool.zw);
                        float edge = 1.0 - smoothstep(0.78, 1.0, e + (wf_noise(m * 0.6) - 0.5) * 0.12);

                        float d1 = segDist(vLocal, uHitA, uHitB) * uScale;
                        float d2 = length(vLocal - uHitC) * uScale;
                        float d = min(d1, d2 * 1.4);

                        // outward-drifting churn near the impacts
                        vec2 dir = vec2(0.0, 1.0);
                        float churn = wf_fbm(m * 0.9 - dir * uTime * 0.9) * 0.6 + wf_fbm(m * 2.3 + uTime * 0.4) * 0.4;
                        float foam = smoothstep(0.35, 0.75, churn * exp(-d * 0.32) * 1.8);
                        foam = max(foam, smoothstep(0.55, 0.9, churn) * exp(-d * 0.8));

                        float rings = sin(d * 3.2 - uTime * 4.5) * 0.5 + 0.5;
                        rings *= exp(-d * 0.22);

                        vec3 V = normalize(vViewW);
                        float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
                        vec3 deep = vec3(0.07, 0.24, 0.27);
                        vec3 shallow = vec3(0.20, 0.44, 0.44);
                        vec3 sky = vec3(0.62, 0.76, 0.84);
                        vec3 col = mix(deep, shallow, smoothstep(0.2, 1.0, e));
                        col = mix(col, sky, fres * 0.55);
                        col += vec3(0.10, 0.14, 0.15) * rings;
                        float spark = pow(wf_noise(m * 4.0 + vec2(uTime * 0.9, -uTime * 0.7)), 24.0) * 0.8;
                        col += spark * (1.0 - foam);
                        col = mix(col, vec3(0.93, 0.97, 1.0), foam);

                        float a = edge * mix(0.80, 0.97, max(foam, fres));
                        if (a < 0.01) discard;
                        gl_FragColor = vec4(col, a);
                        #include <fog_fragment>
                    }`,
                transparent: true,
                depthWrite: false,
                fog: true
            });
            mat.uniforms.uTime = this.timeUniform;
            this.materials.push(mat);
            const pool = new THREE.Mesh(g, mat);
            pool.renderOrder = 2;
            this.group.add(pool);
        }

        // ------------------------------------------------------------------
        // Spray + mist (GPU particles)
        // ------------------------------------------------------------------
        makeParticles(count, spawn, opts) {
            const start = [], vel = [], phase = [], life = [], size = [];
            for (let i = 0; i < count; i++) {
                const sp = spawn(i);
                start.push(sp.x, sp.y, sp.z);
                vel.push(sp.vx, sp.vy, sp.vz);
                phase.push(Math.random());
                life.push(opts.life[0] + Math.random() * (opts.life[1] - opts.life[0]));
                size.push(opts.size[0] + Math.random() * (opts.size[1] - opts.size[0]));
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(start, 3));
            g.setAttribute('aVel', new THREE.Float32BufferAttribute(vel, 3));
            g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
            g.setAttribute('aLife', new THREE.Float32BufferAttribute(life, 1));
            g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
            g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.1, 0, 0.2), 1.2);
            this.geometries.push(g);

            const mat = new THREE.ShaderMaterial({
                uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
                    uTime: { value: 0 },
                    uGravity: { value: opts.gravity / this.scale },
                    uFloor: { value: BASIN_LEVEL },
                    uPixelScale: { value: 800 },
                    uOpacity: { value: opts.opacity },
                    uGrow: { value: opts.grow }
                }]),
                vertexShader: `
                    uniform float uTime, uGravity, uFloor, uPixelScale, uGrow;
                    attribute vec3 aVel;
                    attribute float aPhase, aLife, aSize;
                    varying float vAlpha;
                    #include <fog_pars_vertex>
                    void main() {
                        float t = mod(uTime + aPhase * aLife, aLife);
                        float k = t / aLife;
                        vec3 p = position + aVel * t;
                        p.y -= 0.5 * uGravity * t * t;
                        p.y = max(p.y, uFloor);
                        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
                        gl_Position = projectionMatrix * mvPosition;
                        gl_PointSize = aSize * (1.0 + uGrow * k) * uPixelScale / max(1.0, -mvPosition.z);
                        vAlpha = smoothstep(0.0, 0.12, k) * (1.0 - smoothstep(0.55, 1.0, k));
                        #include <fog_vertex>
                    }`,
                fragmentShader: `
                    uniform float uOpacity;
                    varying float vAlpha;
                    #include <fog_pars_fragment>
                    void main() {
                        vec2 c = gl_PointCoord - 0.5;
                        float r2 = dot(c, c) * 4.0;
                        if (r2 > 1.0) discard;
                        float a = exp(-r2 * 3.0) * vAlpha * uOpacity;
                        gl_FragColor = vec4(0.94, 0.97, 1.0, a);
                        #include <fog_fragment>
                    }`,
                transparent: true,
                depthWrite: false,
                fog: true
            });
            mat.uniforms.uTime = this.timeUniform;
            this.materials.push(mat);
            const pts = new THREE.Points(g, mat);
            pts.renderOrder = 5;
            pts.frustumCulled = true;
            // keep point size right for any canvas size / fov
            pts.onBeforeRender = (renderer, scene, camera) => {
                const h = renderer.getDrawingBufferSize(this._tmpV2 || (this._tmpV2 = new THREE.Vector2())).y;
                mat.uniforms.uPixelScale.value = h / (2 * Math.tan((camera.fov || 45) * Math.PI / 360));
            };
            this.group.add(pts);
            return pts;
        }

        buildSpray() {
            const s = this.scale;
            const main = this.expandPath(FALLS[0]), right = this.expandPath(FALLS[1]);
            const mEnd = main[main.length - 1], rEnd = right[right.length - 1];
            const ledge = right.find(q => q.reset);
            const hits = [
                { x: mEnd.p[0], z: mEnd.p[2], w: mEnd.w * 0.9, y: BASIN_LEVEL, weight: 0.65 },
                { x: rEnd.p[0], z: rEnd.p[2], w: rEnd.w * 0.8, y: BASIN_LEVEL, weight: 0.22 },
                { x: ledge.p[0], z: ledge.p[2] - 0.01, w: ledge.w * 0.7, y: ledge.p[1] + 0.005, weight: 0.13 }
            ];
            const pick = () => {
                let r = Math.random();
                for (const h of hits) { if ((r -= h.weight) <= 0) return h; }
                return hits[0];
            };
            // splash droplets: up and outward, gravity pulls them back
            this.spray = this.makeParticles(260, () => {
                const h = pick();
                const a = (Math.random() - 0.5) * 2.4;
                const sp = (1.5 + Math.random() * 2.6) / s;
                return {
                    x: h.x + (Math.random() - 0.5) * h.w, y: h.y, z: h.z + Math.random() * 0.02,
                    vx: Math.sin(a) * sp * 0.6, vy: (2.2 + Math.random() * 3.0) / s, vz: Math.abs(Math.cos(a)) * sp
                };
            }, { life: [0.7, 1.4], size: [0.25, 0.6], gravity: 9.8, opacity: 0.55, grow: 1.2 });

            // mist: big, slow, rising and drifting away from the cliff
            this.mist = this.makeParticles(40, () => {
                const h = Math.random() < 0.75 ? hits[0] : hits[1];
                return {
                    x: h.x + (Math.random() - 0.5) * h.w * 1.4, y: h.y + 0.01, z: h.z + Math.random() * 0.05,
                    vx: (Math.random() - 0.5) * 0.3 / s, vy: (0.5 + Math.random() * 0.8) / s, vz: (0.4 + Math.random() * 0.8) / s
                };
            }, { life: [4.0, 7.0], size: [2.5, 5.0], gravity: 0.0, opacity: 0.10, grow: 1.4 });
        }

        // ------------------------------------------------------------------
        registerObstacles() {
            if (!this.pathfinder) return;
            // Model footprint (ray-cast from above, 0.1 local step: x -0.9..0.9 by columns,
            // z -0.7..0.7 by rows; small holes filled). Rocks AND the pool are not walkable.
            const MASK = AveloraWaterfall.FOOTPRINT_MASK;
            const v = new THREE.Vector3();
            const r = 0.078 * this.scale;
            MASK.forEach((row, iz) => {
                for (let ix = 0; ix < row.length; ix++) {
                    if (row[ix] !== '#') continue;
                    v.set(-0.9 + ix * 0.1, 0, -0.7 + iz * 0.1);
                    this.group.localToWorld(v);
                    this.pathfinder.addObstacle(v.x, v.z, r);
                }
            });
        }

        update(delta) {
            this.time += delta;
            this.timeUniform.value = this.time;
        }

        dispose() {
            this.disposed = true;
            if (this.group && this.group.parent) this.group.parent.remove(this.group);
            this.geometries.forEach(g => g.dispose());
            this.materials.forEach(m => m.dispose());
            this.geometries = [];
            this.materials = [];
            if (this.model) {
                this.model.traverse((child) => {
                    if (!child.isMesh) return;
                    if (child.geometry) child.geometry.dispose();
                    const m = child.material;
                    if (m) {
                        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach(k => { if (m[k]) m[k].dispose(); });
                        m.dispose();
                    }
                });
            }
        }
    }

    // След модели (скалы + бассейн) на сетке 0.1 локальной единицы: колонки x -0.9..0.9, строки z -0.7..0.7.
    // Используется для непроходимости (registerObstacles) и чтобы на скалах/в бассейне не росла трава (grass_carpet.js).
    AveloraWaterfall.FOOTPRINT_MASK = [
        '....#..............',
        '...##############..',
        '..###############..',
        '.#################.',
        '.#################.',
        '###################',
        '.##################',
        '##################.',
        '##################.',
        '#################..',
        '..##############...',
        '....############...',
        '....###########....',
        '......#########....',
        '........#..........'
    ];
    window.AveloraWaterfall = AveloraWaterfall;
})();
