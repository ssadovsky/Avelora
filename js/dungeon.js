/**
 * AVELORA — Modular Dungeon & Catacombs System (AveloraDungeon)
 *
 * Создает подземелье катакомб:
 * - Естественная пещера (процедурная сетка): извилистый ход, зал с колоннами, боковые гроты;
 * - Древняя каменная арка, вросшая в скалу, — стык пещеры и склепа;
 * - Геометрический каменный склеп-галерея за аркой;
 * - Монументальные каменные стены, арки, пилястры и каменный пол;
 * - Настенные факелы с живым пламенем (AveloraFire) и мерцающим светом;
 * - Автоматическая регистрация непроходимых стен и колонн в DiabloPathfinder;
 * - Оптимизированная геометрия под мобильные устройства и ПК (60 FPS).
 */
(function () {
    'use strict';

    class AveloraDungeon {
        constructor(scene, config = {}, terrain = null, pathfinder = null) {
            this.scene = scene;
            this.config = config;
            this.terrain = terrain;
            this.pathfinder = pathfinder;

            this.group = new THREE.Group();
            this.group.name = `dungeon:${config.id || 'catacombs'}`;
            this.scene.add(this.group);

            this.fires = [];
            this.lights = [];
            this.geometries = [];
            this.materials = [];
            this.disposed = false;

            this._initMaterials();
            this._buildCave();
            this._buildPassage();
            this._buildTorches();
            this._registerColliders();
        }

        _initMaterials() {
            const assets = (window.GAME_ASSETS && window.GAME_ASSETS.textures) || {};
            const texLoader = new THREE.TextureLoader();

            // PBR текстуры стен и пола
            const rockDiff = assets.rockDiff ? texLoader.load(assets.rockDiff) : null;
            const rockNor = (assets.rockNor || assets.beachNor) ? texLoader.load(assets.rockNor || assets.beachNor) : null;
            if (rockDiff) {
                rockDiff.wrapS = rockDiff.wrapT = THREE.RepeatWrapping;
                rockDiff.repeat.set(2.0, 2.0);
            }
            if (rockNor) {
                rockNor.wrapS = rockNor.wrapT = THREE.RepeatWrapping;
                rockNor.repeat.set(2.0, 2.0);
            }

            const floorDiff = assets.stoneTrailDiff ? texLoader.load(assets.stoneTrailDiff) : rockDiff;
            if (floorDiff && floorDiff !== rockDiff) {
                floorDiff.wrapS = floorDiff.wrapT = THREE.RepeatWrapping;
                floorDiff.repeat.set(2.5, 6.0);
            }

            // Материал стен (серый древний сланец / гранит)
            this.wallMat = new THREE.MeshStandardMaterial({
                color: 0x8a8e94,
                map: rockDiff,
                normalMap: rockNor,
                roughness: 0.88,
                metalness: 0.04
            });
            this.materials.push(this.wallMat);

            // Материал пола (каменные плиты)
            this.floorMat = new THREE.MeshStandardMaterial({
                color: 0x76797f,
                map: floorDiff,
                normalMap: rockNor,
                roughness: 0.82,
                metalness: 0.02
            });
            this.materials.push(this.floorMat);

            // Материал арочных сводов и колонн (чуть более темный каменный блок)
            this.trimMat = new THREE.MeshStandardMaterial({
                color: 0x686c72,
                map: rockDiff,
                normalMap: rockNor,
                roughness: 0.90,
                metalness: 0.05
            });
            this.materials.push(this.trimMat);

            // Металл для кованых держателей факелов и решетки в конце коридора
            this.ironMat = new THREE.MeshStandardMaterial({
                color: 0x222428,
                roughness: 0.45,
                metalness: 0.82
            });
            this.materials.push(this.ironMat);

            // Материал естественной пещеры: трипланарная текстура камня (без растяжения на стенах и своде) + цвет вершин
            const caveMap = assets.rockDiff ? texLoader.load(assets.rockDiff) : null;
            if (caveMap) { caveMap.wrapS = caveMap.wrapT = THREE.RepeatWrapping; }
            this.caveMat = new THREE.MeshStandardMaterial({
                color: 0xffffff, map: caveMap, vertexColors: true, roughness: 0.93, metalness: 0.02
            });
            this.caveMat.onBeforeCompile = (shader) => {
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', '#include <common>\nvarying vec3 vCavePos; varying vec3 vCaveNor;')
                    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCavePos = (modelMatrix * vec4(transformed, 1.0)).xyz; vCaveNor = normalize(mat3(modelMatrix) * objectNormal);');
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', '#include <common>\nvarying vec3 vCavePos; varying vec3 vCaveNor;')
                    .replace('#include <map_fragment>', `
                        #ifdef USE_MAP
                        vec3 cbw = pow(abs(normalize(vCaveNor)), vec3(4.0)); cbw /= (cbw.x + cbw.y + cbw.z);
                        float cs = 0.23;
                        vec4 ct = texture2D(map, vCavePos.zy * cs) * cbw.x + texture2D(map, vCavePos.xz * cs) * cbw.y + texture2D(map, vCavePos.xy * cs) * cbw.z;
                        diffuseColor *= ct;
                        #endif`);
            };
            this.caveMat.customProgramCacheKey = () => 'avelora_cave_v1';
            this.materials.push(this.caveMat);

            // Материал каменной арки/плит (крупный масштаб текстуры)
            const slabMap = assets.rockDiff ? texLoader.load(assets.rockDiff) : null;
            if (slabMap) { slabMap.wrapS = slabMap.wrapT = THREE.RepeatWrapping; slabMap.repeat.set(0.35, 0.35); }
            this.slabMat = new THREE.MeshStandardMaterial({ color: 0x8c9096, map: slabMap, roughness: 0.9, metalness: 0.04 });
            this.materials.push(this.slabMat);
        }

        // ====================================================================
        //  ЕСТЕСТВЕННАЯ ПЕЩЕРА (процедурная): вход-портал → извилистый ход → зал с колоннами
        //  → боковые гроты → древняя арка, вросшая в скалу → геометрический склеп.
        //  Пустота описана полем расстояний s(x,z): s<0 — внутри, s>0 — камень.
        //  Пол F(x,z) и свод C(x,z) строятся из s, у стен смыкаются на высоте CAVE_HE.
        // ====================================================================
        _hash(ix, iz) {
            const s = Math.sin(ix * 127.1 + iz * 311.7 + 17.13) * 43758.5453;
            return s - Math.floor(s);
        }

        _vnoise(x, z) {
            const ix = Math.floor(x), iz = Math.floor(z);
            const fx = x - ix, fz = z - iz;
            const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
            const a = this._hash(ix, iz), b = this._hash(ix + 1, iz);
            const c = this._hash(ix, iz + 1), d = this._hash(ix + 1, iz + 1);
            return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz; // 0..1
        }

        _fbm(x, z) { // -1..1
            return (this._vnoise(x, z) * 0.55 + this._vnoise(x * 2.03 + 7.1, z * 2.03 + 3.7) * 0.3
                + this._vnoise(x * 4.1 + 1.3, z * 4.1 + 9.2) * 0.15) * 2 - 1;
        }

        _catmull(pts, step) {
            const out = [];
            const n = pts.length;
            for (let i = 0; i < n - 1; i++) {
                const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
                const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
                const k = Math.max(2, Math.ceil(len / step));
                for (let j = 0; j < k; j++) {
                    const t = j / k, t2 = t * t, t3 = t2 * t;
                    const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
                    out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), p1[2] + (p2[2] - p1[2]) * t]);
                }
            }
            const l = pts[n - 1]; out.push([l[0], l[1], l[2]]);
            return out;
        }

        _sdfRaw(x, z) {
            // расстояние до оси ходов (минус радиус), гладкое объединение с залами, минус колонны
            const P = this._pathDense;
            let d = 1e9;
            for (let i = 0; i < P.length; i++) {
                const dx = x - P[i][0], dz = z - P[i][1];
                const v = Math.sqrt(dx * dx + dz * dz) - P[i][2];
                if (v < d) d = v;
            }
            const B = this._blobs;
            for (let i = 0; i < B.length; i++) {
                const dx = x - B[i][0], dz = z - B[i][1];
                const v = Math.sqrt(dx * dx + dz * dz) - B[i][2];
                // гладкий минимум k = 1.0
                const h = Math.max(1.0 - Math.abs(d - v), 0) / 1.0;
                d = Math.min(d, v) - h * h * 0.25;
            }
            // стены ходов шероховатые, но у арки (z → ZCLIP) шум гаснет — стык ровный
            const damp = Math.max(0, Math.min(1, (-z + this.ZCLIP - 0.1) / 4.0));
            d += (0.30 * this._fbm(x * 0.32 + 11, z * 0.32) + 0.11 * this._fbm(x * 0.9, z * 0.9 + 4)) * damp;
            // колонны: вернуть камень
            const K = this._pillars;
            for (let i = 0; i < K.length; i++) {
                const dx = x - K[i][0], dz = z - K[i][1];
                const v = K[i][2] - Math.sqrt(dx * dx + dz * dz);
                const h = Math.max(0.8 - Math.abs(d - (-v)), 0) / 0.8;
                d = Math.max(d, v) + h * h * 0.2;
            }
            return d;
        }

        _surf(x, z, s) {
            const HE = this.CAVE_HE;
            const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
            const t = sm(-0.3, 0.9, s);
            const w = 1.0 - sm(0.3, 0.9, s);
            let F = HE * Math.pow(t, 0.85) + 0.30 * this._fbm(x * 0.7 + 3, z * 0.7) * t * w
                + 0.035 * this._fbm(x * 1.7, z * 1.7 + 8) * (1 - t);
            const cmax = 3.2 + 2.3 * Math.max(0, Math.min(1, (-s - 1.0) / 3.0));
            let C = HE + (cmax - HE) * sm(0.9, -1.6, s) + 0.45 * this._fbm(x * 0.5 + 5, z * 0.5 + 2) * w;
            if (C < F + 0.05) C = F + 0.05;
            if (s >= 0.9) { F = HE; C = HE; }
            return [F, C];
        }

        _buildCave() {
            this.CAVE_HE = 2.3;
            this.ZCLIP = -4.25;                    // плоскость арки
            const H = 0.25;                        // шаг сетки
            const X0 = -17.0, X1 = 11.0, Z0 = -34.0, Z1 = this.ZCLIP;
            const NX = Math.round((X1 - X0) / H) + 1, NZ = Math.round((Z1 - Z0) / H) + 1;

            // Ось главного хода (x, z, радиус) и ответвления
            const main = [[0, -29.4, 1.9], [0, -27.0, 2.2], [-1.8, -23.6, 1.8], [-4.4, -20.4, 2.3], [-6.4, -16.0, 1.9],
                [-3.9, -12.0, 1.8], [1.0, -9.8, 1.9], [1.5, -7.4, 1.8], [0.5, -5.8, 1.7], [0, -4.0, 1.5], [0, -3.2, 1.5]];
            const nicheBr = [[1.0, -9.8, 1.6], [3.4, -10.8, 1.6], [5.6, -11.8, 1.9]];
            const westBr = [[-7.4, -17.4, 1.6], [-10.2, -19.4, 1.7], [-12.4, -22.4, 2.0]];
            this._pathMain = this._catmull(main, 0.2);
            this._pathDense = this._pathMain.concat(this._catmull(nicheBr, 0.2), this._catmull(westBr, 0.2));
            this._blobs = [[-6.3, -17.6, 3.7], [5.8, -12.0, 2.3], [-12.7, -22.9, 2.4]];
            this._pillars = [[-6.7, -18.6, 0.75], [-4.6, -15.8, 0.6]];

            // Поля
            const S = new Float32Array(NX * NZ), FF = new Float32Array(NX * NZ), CC = new Float32Array(NX * NZ);
            for (let iz = 0; iz < NZ; iz++) {
                for (let ix = 0; ix < NX; ix++) {
                    const x = X0 + ix * H, z = Z0 + iz * H;
                    const s = this._sdfRaw(x, z);
                    const fc = this._surf(x, z, s);
                    const k = iz * NX + ix;
                    S[k] = s; FF[k] = fc[0]; CC[k] = fc[1];
                }
            }
            this.cave = { X0, Z0, H, NX, NZ, S, F: FF, C: CC };

            // Геометрия: пол (нормали вверх) и свод (нормали вниз)
            const nV = NX * NZ;
            const pos = new Float32Array(nV * 2 * 3), col = new Float32Array(nV * 2 * 3);
            for (let iz = 0; iz < NZ; iz++) {
                for (let ix = 0; ix < NX; ix++) {
                    const k = iz * NX + ix, x = X0 + ix * H, z = Z0 + iz * H;
                    const s = S[k];
                    const n1 = this._vnoise(x * 0.8, z * 0.8), n2 = this._vnoise(x * 2.4 + 5, z * 2.4);
                    const shade = 0.62 + 0.30 * n1 + 0.14 * n2;
                    const wallDark = 1.0 - 0.35 * Math.min(1, Math.max(0, (s + 0.6) / 1.4));
                    pos[k * 3] = x; pos[k * 3 + 1] = FF[k]; pos[k * 3 + 2] = z;
                    const fcR = 0.95 * shade * wallDark, fcG = 0.90 * shade * wallDark, fcB = 0.90 * shade * wallDark * 1.04;
                    col[k * 3] = fcR; col[k * 3 + 1] = fcG; col[k * 3 + 2] = fcB;
                    const j = (nV + k);
                    pos[j * 3] = x; pos[j * 3 + 1] = CC[k]; pos[j * 3 + 2] = z;
                    const cs = shade * 0.82;
                    col[j * 3] = 0.72 * cs; col[j * 3 + 1] = 0.72 * cs; col[j * 3 + 2] = 0.80 * cs;
                }
            }
            const idx = [];
            for (let iz = 0; iz < NZ - 1; iz++) {
                for (let ix = 0; ix < NX - 1; ix++) {
                    const a = iz * NX + ix, b = a + 1, c = a + NX, d = c + 1;
                    if (Math.min(S[a], S[b], S[c], S[d]) >= 0.9) continue;
                    // пол: смотрит вверх
                    idx.push(a, c, b, b, c, d);
                    // свод: смотрит вниз
                    idx.push(nV + a, nV + b, nV + c, nV + b, nV + d, nV + c);
                }
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
            geo.setIndex(new THREE.BufferAttribute(nV * 2 > 65000 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
            geo.computeVertexNormals();
            this.geometries.push(geo);
            const mesh = new THREE.Mesh(geo, this.caveMat);
            mesh.name = 'cave_rock';
            mesh.receiveShadow = false;
            this.group.add(mesh);

            this._buildCaveProps();
        }

        // s, F, C в произвольной точке (билинейно по сетке); вне сетки — камень
        _caveSample(x, z) {
            const c = this.cave;
            const fx = (x - c.X0) / c.H, fz = (z - c.Z0) / c.H;
            if (fx < 0 || fz < 0 || fx >= c.NX - 1 || fz >= c.NZ - 1) return null;
            const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
            const k = iz * c.NX + ix;
            const bl = (A) => (A[k] * (1 - tx) + A[k + 1] * tx) * (1 - tz) + (A[k + c.NX] * (1 - tx) + A[k + c.NX + 1] * tx) * tz;
            return { s: bl(c.S), F: bl(c.F), C: bl(c.C) };
        }

        _caveSdf(x, z) {
            const q = this._caveSample(x, z);
            return q ? q.s : 5.0;
        }

        // Точка (x,y,z) в пустоте с запасом marginF от пола/стены и marginC от свода?
        _inCave(x, y, z, mF, mC) {
            const q = this._caveSample(x, z);
            if (!q) return false;
            return y > q.F + mF && y < q.C - mC;
        }

        _wallPoint(px, pz, dx, dz, target) {
            // идём из (px,pz) по (dx,dz) до стены s > target
            const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
            let x = px, z = pz;
            for (let i = 0; i < 160; i++) {
                if (this._caveSdf(x, z) > target) return { x, z };
                x += dx * 0.05; z += dz * 0.05;
            }
            return { x, z };
        }

        _buildCaveProps() {
            // Факелы на естественных стенах (по оси хода, чередуя стороны)
            const P = this._pathMain;
            const at = (f) => {
                const i = Math.max(1, Math.min(P.length - 2, Math.round(f * (P.length - 1))));
                const tx = P[i + 1][0] - P[i - 1][0], tz = P[i + 1][1] - P[i - 1][1];
                const l = Math.hypot(tx, tz) || 1;
                return { x: P[i][0], z: P[i][1], nx: -tz / l, nz: tx / l };
            };
            const torchSpec = [[0.17, 1], [0.47, -1], [0.74, 1]];
            torchSpec.forEach(([f, side]) => {
                const a = at(f);
                const wp = this._wallPoint(a.x, a.z, a.nx * side, a.nz * side, 0.55);
                this._createWallTorch(wp.x, 1.75, wp.z, 1, Math.atan2(a.nz * side, -a.nx * side), true);
            });
            // Факелы у арки (без лишних источников света — арку подсвечивают соседние)
            [-1, 1].forEach(sd => {
                const wp = this._wallPoint(sd * 0.9, this.ZCLIP - 1.4, sd, 0, 0.55);
                this._createWallTorch(wp.x, 1.8, wp.z, 1, Math.atan2(0, -sd), false);
            });

            // Сталактиты / сталагмиты (инстансы)
            const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a6e66, roughness: 0.95, metalness: 0.0, flatShading: true });
            this.materials.push(rockMat);
            const coneGeo = new THREE.ConeGeometry(1, 1, 6, 1);
            this.geometries.push(coneGeo);
            const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
            const sp = [];
            let seed = 3;
            const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
            const c = this.cave;
            for (let tries = 0; tries < 900 && sp.length < 70; tries++) {
                const x = c.X0 + rnd() * (c.NX - 1) * c.H, z = c.Z0 + rnd() * (c.NZ - 1) * c.H;
                if (z > this.ZCLIP - 1.6) continue;
                const smp = this._caveSample(x, z); if (!smp) continue;
                if (smp.s > -0.9 || smp.C < 3.4) continue;
                const down = rnd() < 0.7;
                const h = 0.4 + rnd() * (down ? 0.9 : 0.6), r = 0.16 + rnd() * 0.26;
                if (!down && smp.s > -1.6) continue;            // сталагмиты — только вдали от хода
                const y = down ? smp.C + 0.05 - h * 0.5 + 0.0 : smp.F - 0.05 + h * 0.5;
                e.set(down ? Math.PI : 0, rnd() * 6, 0); q.setFromEuler(e);
                m4.compose(new THREE.Vector3(x, down ? smp.C - h * 0.5 + 0.1 : smp.F + h * 0.5 - 0.05, z), q, new THREE.Vector3(r, h, r));
                sp.push(m4.clone());
            }
            if (sp.length) {
                const inst = new THREE.InstancedMesh(coneGeo, rockMat, sp.length);
                sp.forEach((m, i) => inst.setMatrixAt(i, m));
                inst.instanceMatrix.needsUpdate = true;
                this.group.add(inst);
            }

            // Светящиеся кристаллы: ниша и западный грот (+ один источник света у ниши)
            const crysMat = new THREE.MeshStandardMaterial({
                color: 0x2f6fd6, emissive: 0x2a86ff, emissiveIntensity: 1.6, roughness: 0.25, metalness: 0.1, flatShading: true
            });
            this.materials.push(crysMat);
            const cGeo = new THREE.ConeGeometry(0.16, 1.0, 5);
            this.geometries.push(cGeo);
            const clusters = [[6.4, -12.4], [-13.6, -23.8], [-8.4, -14.2], [-2.6, -25.2]];
            clusters.forEach(([cx, cz], ci) => {
                const grp = new THREE.Group();
                const wp = this._wallPoint(cx - 1.5, cz + 0.6, cx > 0 ? 1 : -1, -0.3, 0.2);
                const base = this._caveSample(wp.x, wp.z);
                grp.position.set(wp.x, base ? base.F : 0, wp.z);
                for (let i = 0; i < 5; i++) {
                    const m = new THREE.Mesh(cGeo, crysMat);
                    const hh = 0.5 + (i % 3) * 0.35;
                    m.scale.set(0.8 + (i % 2) * 0.5, hh, 0.8 + (i % 2) * 0.5);
                    m.position.set((i - 2) * 0.17, hh * 0.5 - 0.05, (i % 2 ? 0.12 : -0.1));
                    m.rotation.set((i - 2) * 0.12, i, (2 - i) * 0.14);
                    grp.add(m);
                }
                this.group.add(grp);
                if (ci === 0) {
                    const L = new THREE.PointLight(0x4f9bff, 1.3, 8.5, 2.0);
                    L.position.set(0, 0.9, 0); grp.add(L);
                    this.lights.push({ light: L, baseIntensity: 1.3, seed: 41, calm: true });
                }
            });
        }

        _buildPassage() {
            // Размеры коридора
            const length = 28.0;      // z от -3.5 до +24.5
            const width = 4.8;        // от x = -2.4 до x = +2.4
            const height = 5.4;       // высота стен
            const zStart = -3.5;
            const zEnd = 24.5;
            const zCenter = (zStart + zEnd) * 0.5;

            // 1. Каменный пол (строго на Y=0.0 вровень со ступнями героя)
            const floorGeo = new THREE.PlaneGeometry(width, length, 12, 28);
            floorGeo.rotateX(-Math.PI / 2);
            const floorMesh = new THREE.Mesh(floorGeo, this.floorMat);
            floorMesh.position.set(0, 0.0, zCenter);
            floorMesh.receiveShadow = true;
            this.group.add(floorMesh);
            this.geometries.push(floorGeo);

            // 2. Левая и правая стены коридора
            const wallThick = 0.8;
            const wallGeo = new THREE.BoxGeometry(wallThick, height, length);
            this.geometries.push(wallGeo);

            // Левая стена (x = -width/2 - wallThick/2)
            const leftWall = new THREE.Mesh(wallGeo, this.wallMat);
            leftWall.position.set(-width * 0.5 - wallThick * 0.5, height * 0.5, zCenter);
            leftWall.castShadow = true;
            leftWall.receiveShadow = true;
            this.group.add(leftWall);

            // Правая стена (x = width/2 + wallThick/2)
            const rightWall = new THREE.Mesh(wallGeo, this.wallMat);
            rightWall.position.set(width * 0.5 + wallThick * 0.5, height * 0.5, zCenter);
            rightWall.castShadow = true;
            rightWall.receiveShadow = true;
            this.group.add(rightWall);

            // 3. Древняя арка в скале: плита с арочным проёмом (стык пещеры и склепа) + обрамляющее кольцо
            const slabW = width + wallThick * 2, slabH = height + 0.6, depth = 0.75;
            const slabShape = new THREE.Shape();
            slabShape.moveTo(-slabW / 2, 0); slabShape.lineTo(slabW / 2, 0); slabShape.lineTo(slabW / 2, slabH); slabShape.lineTo(-slabW / 2, slabH); slabShape.lineTo(-slabW / 2, 0);
            const hole = new THREE.Path();
            hole.moveTo(-1.1, 0); hole.lineTo(-1.1, 2.0); hole.absarc(0, 2.0, 1.1, Math.PI, 0, true); hole.lineTo(1.1, 0); hole.lineTo(-1.1, 0);
            slabShape.holes.push(hole);
            const slabGeo = new THREE.ExtrudeGeometry(slabShape, { depth, bevelEnabled: false, curveSegments: 14 });
            this.geometries.push(slabGeo);
            const slab = new THREE.Mesh(slabGeo, this.slabMat);
            slab.position.set(0, 0, this.ZCLIP);
            slab.castShadow = true; slab.receiveShadow = true;
            this.group.add(slab);

            const ringShape = new THREE.Shape();
            ringShape.moveTo(-1.62, 0); ringShape.lineTo(-1.62, 2.0); ringShape.absarc(0, 2.0, 1.62, Math.PI, 0, true);
            ringShape.lineTo(1.62, 0); ringShape.lineTo(1.1, 0); ringShape.lineTo(1.1, 2.0);
            ringShape.absarc(0, 2.0, 1.1, 0, Math.PI, false); ringShape.lineTo(-1.1, 0); ringShape.lineTo(-1.62, 0);
            const ringGeo = new THREE.ExtrudeGeometry(ringShape, { depth: 0.32, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1, curveSegments: 14 });
            this.geometries.push(ringGeo);
            const ring = new THREE.Mesh(ringGeo, this.trimMat);
            ring.position.set(0, 0, this.ZCLIP - 0.32);
            ring.castShadow = true; ring.receiveShadow = true;
            this.group.add(ring);
            // замковый камень арки
            const keyGeo = new THREE.BoxGeometry(0.42, 0.62, 0.46);
            this.geometries.push(keyGeo);
            const key = new THREE.Mesh(keyGeo, this.trimMat);
            key.position.set(0, 2.0 + 1.36, this.ZCLIP - 0.28);
            this.group.add(key);

            // 3.1 Пол в проёме арки (между краем пещеры и склепом)
            const stripGeo = new THREE.PlaneGeometry(2.4, 0.95);
            stripGeo.rotateX(-Math.PI / 2);
            this.geometries.push(stripGeo);
            const strip = new THREE.Mesh(stripGeo, this.floorMat);
            strip.position.set(0, 0.0, this.ZCLIP + 0.375);
            strip.receiveShadow = true;
            this.group.add(strip);

            // 4. Сплошной каменный свод / потолок коридора (монолитный верх над всей галереей)
            const roofGeo = new THREE.BoxGeometry(width + wallThick * 2, 0.6, length + wallThick * 2);
            this.geometries.push(roofGeo);
            const roofMesh = new THREE.Mesh(roofGeo, this.trimMat);
            roofMesh.position.set(0, height + 0.3, zCenter);
            roofMesh.castShadow = true;
            roofMesh.receiveShadow = true;
            this.group.add(roofMesh);

            // 4.1 Внешний защитный кожух (Backdrop shell): темный матовый монолит снаружи стен и потолка
            const shellMat = new THREE.MeshBasicMaterial({ color: 0x050608, side: THREE.BackSide });
            this.materials.push(shellMat);
            const shellGeo = new THREE.BoxGeometry(width + wallThick * 2 + 0.4, height + 1.2, length + wallThick * 2 + 0.4);
            this.geometries.push(shellGeo);
            const shellMesh = new THREE.Mesh(shellGeo, shellMat);
            shellMesh.position.set(0, height * 0.5 + 0.1, zCenter);
            this.group.add(shellMesh);

            // 5. Каменные колонны и стрельчатые арки вдоль коридора
            const archSteps = [0.0, 5.0, 10.0, 15.0, 20.0, zEnd];
            const pillarGeo = new THREE.BoxGeometry(0.7, height, 0.7);
            const archBeamGeo = new THREE.BoxGeometry(width + 0.2, 0.5, 0.6);
            this.geometries.push(pillarGeo, archBeamGeo);

            archSteps.forEach(z => {
                // Колонна слева
                const pLeft = new THREE.Mesh(pillarGeo, this.trimMat);
                pLeft.position.set(-width * 0.5 + 0.25, height * 0.5, z);
                pLeft.castShadow = true;
                pLeft.receiveShadow = true;
                this.group.add(pLeft);

                // Колонна справа
                const pRight = new THREE.Mesh(pillarGeo, this.trimMat);
                pRight.position.set(width * 0.5 - 0.25, height * 0.5, z);
                pRight.castShadow = true;
                pRight.receiveShadow = true;
                this.group.add(pRight);

                // Поперечная арка под потолком
                const arch = new THREE.Mesh(archBeamGeo, this.trimMat);
                arch.position.set(0, height - 0.25, z);
                arch.castShadow = true;
                this.group.add(arch);
            });

            // 6. Дальний конец коридора (массивная кованая решетка и арка входа в будущий Великий Зал)
            const endWallGeo = new THREE.BoxGeometry(width + wallThick * 2, height, wallThick);
            this.geometries.push(endWallGeo);
            const endWall = new THREE.Mesh(endWallGeo, this.wallMat);
            endWall.position.set(0, height * 0.5, zEnd + wallThick * 0.5);
            endWall.castShadow = true;
            this.group.add(endWall);

            // Кованая железная решетка (Portcullis) в конце коридора
            this._buildPortcullis(0, zEnd);
        }

        _buildPortcullis(x, z) {
            const gateGroup = new THREE.Group();
            gateGroup.position.set(x, 0, z);

            // Рама решетки
            const frameGeo = new THREE.BoxGeometry(3.2, 4.4, 0.2);
            this.geometries.push(frameGeo);

            // Вертикальные прутья
            const barGeo = new THREE.CylinderGeometry(0.04, 0.04, 4.0, 8);
            this.geometries.push(barGeo);

            for (let bx = -1.3; bx <= 1.35; bx += 0.35) {
                const bar = new THREE.Mesh(barGeo, this.ironMat);
                bar.position.set(bx, 2.0, 0);
                gateGroup.add(bar);
            }

            // Горизонтальные поперечины
            const crossGeo = new THREE.BoxGeometry(2.9, 0.08, 0.1);
            this.geometries.push(crossGeo);
            [0.8, 1.8, 2.8, 3.6].forEach(by => {
                const cross = new THREE.Mesh(crossGeo, this.ironMat);
                cross.position.set(0, by, 0);
                gateGroup.add(cross);
            });

            this.group.add(gateGroup);
        }

        _buildTorches() {
            // Расстановка парных факелов на стенах
            const torchZs = [1.5, 7.5, 13.5, 19.5];
            const torchX = 2.15; // отступ от центра к стенам
            const torchY = 2.2;  // комфортная высота на уровне взгляда героя

            torchZs.forEach((tz, idx) => {
                this._createWallTorch(-torchX, torchY, tz, 1);   // левый факел (смотрит вправо)
                this._createWallTorch(torchX, torchY, tz, -1);  // правый факел (смотрит влево)
            });
        }

        _createWallTorch(x, y, z, dirX, rotY = 0, withLight = true) {
            const torchGroup = new THREE.Group();
            torchGroup.position.set(x, y, z);
            torchGroup.rotation.y = rotY;

            // Кронштейн факела (диагональный металлический держатель)
            const holderGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.55, 6);
            holderGeo.rotateZ(dirX * 0.55);
            this.geometries.push(holderGeo);
            const holder = new THREE.Mesh(holderGeo, this.ironMat);
            holder.position.set(dirX * 0.18, 0, 0);
            torchGroup.add(holder);

            // Чаша факела
            const cupGeo = new THREE.CylinderGeometry(0.12, 0.06, 0.18, 8);
            this.geometries.push(cupGeo);
            const cup = new THREE.Mesh(cupGeo, this.ironMat);
            cup.position.set(dirX * 0.32, 0.22, 0);
            torchGroup.add(cup);

            // Живое пламя (AveloraFire)
            if (window.AveloraFire) {
                const fire = new window.AveloraFire(torchGroup, {
                    y: 0.24,
                    size: 0.38
                });
                fire.group.position.set(dirX * 0.32, 0.24, 0);
                this.fires.push(fire);
            }

            // Динамический точечный источник света
            if (withLight) {
                const light = new THREE.PointLight(0xff942c, 1.45, 9.5, 2.0);
                light.position.set(dirX * 0.32, 0.35, 0);
                torchGroup.add(light);

                this.lights.push({
                    light: light,
                    baseIntensity: 1.45,
                    seed: Math.random() * 100.0
                });
            }

            this.group.add(torchGroup);
        }

        // Проходимо только: внутри пещеры (с запасом от стен), внутри склепа и в проёме арки.
        // Сетку навигации пишем напрямую (всё остальное в локации — камень).
        _corridorWalk(x, z, m) {
            if (z >= this.ZCLIP + 0.75 - 0.05 && z <= 24.0 - m) return Math.abs(x) <= 1.95 - m * 0.2;
            return false;
        }

        _isWalkPoint(x, z) {
            if (Math.abs(x) <= 1.0 && z > this.ZCLIP - 1.3 && z < this.ZCLIP + 0.9) return true;   // проём арки
            if (this._corridorWalk(x, z, 0.3)) return true;
            const q = this._caveSample(x, z);
            return !!q && q.s < -0.28 && z < this.ZCLIP - 0.9;
        }

        _registerColliders() {
            const pf = this.pathfinder;
            if (!pf || !pf.grid) return;
            const cw = pf.cellWidth, ch = pf.cellHeight;
            for (let gz = 0; gz < pf.gridSizeZ; gz++) {
                for (let gx = 0; gx < pf.gridSizeX; gx++) {
                    const p = pf.gridToWorld(gx, gz);
                    // клетка проходима, только если проходим центр и четыре точки внутри неё (с запасом от стен)
                    let ok = this._isWalkPoint(p.x, p.z);
                    if (ok) {
                        const ox = cw * 0.32, oz = ch * 0.32;
                        ok = this._isWalkPoint(p.x - ox, p.z - oz) && this._isWalkPoint(p.x + ox, p.z - oz)
                            && this._isWalkPoint(p.x - ox, p.z + oz) && this._isWalkPoint(p.x + ox, p.z + oz);
                    }
                    // проём арки — всегда проходим для связности
                    if (!ok && Math.abs(p.x) <= 0.95 && p.z > this.ZCLIP - 1.4 && p.z < this.ZCLIP + 1.3) ok = true;
                    pf.grid[pf.getIndex(gx, gz)] = ok ? 0 : 1;
                }
            }
        }

        // ---- Камера: настоящая проверка столкновений с пещерой и склепом ----
        // Точка камеры допустима, если она в пустоте пещеры, в склепе или в проёме арки.
        _camValid(x, y, z) {
            // склеп (внутренняя коробка с запасом от стен и свода)
            if (z >= this.ZCLIP + 0.1 && z <= 24.0 && Math.abs(x) <= 2.05 && y >= 0.6 && y <= 4.9) return true;
            // проём арки
            if (Math.abs(x) <= 0.95 && z > this.ZCLIP - 0.2 && z < this.ZCLIP + 0.95 && y >= 0.6 && y <= 2.9) return true;
            if (z < this.ZCLIP - 0.05) {
                const q = this._caveSample(x, z);
                return !!q && q.s < -0.12 && y > q.F + 0.55 && y < q.C - 0.45;
            }
            return false;
        }

        _camReach(head, dx, dy, dz, r) {
            // доходим по лучу до первой недопустимой точки; возвращаем дальность
            let best = 0;
            for (let i = 1; i <= 20; i++) {
                const t = i / 20;
                if (this._camValid(head.x + dx * r * t, head.y + dy * r * t, head.z + dz * r * t)) best = t; else break;
            }
            return best * r;
        }

        /**
         * Ставит камеру в допустимую точку. Если желаемая дальность упирается в стену или свод,
         * пробует приподнять камеру и слегка повернуть её вокруг героя и берёт лучший вариант
         * (иначе в узком ходу камера оказывалась бы вплотную к герою). head — точка взгляда.
         */
        constrainCamera(cam, head) {
            const vx = cam.x - head.x, vy = cam.y - head.y, vz = cam.z - head.z;
            const r = Math.hypot(vx, vy, vz) || 1;
            // свободный путь без поправок — самый частый случай
            const direct = this._camReach(head, vx / r, vy / r, vz / r, r);
            if (direct >= r - 0.01) return cam;

            const yaw0 = Math.atan2(vx, vz), pit0 = Math.asin(Math.max(-1, Math.min(1, vy / r)));
            const dyaws = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1];
            const dpits = [0, 0.14, 0.28, 0.42, 0.56];
            let bestScore = -1e9, bestD = null, bestIdx = -1, k = 0;
            for (let yi = 0; yi < dyaws.length; yi++) {
                for (let pi = 0; pi < dpits.length; pi++, k++) {
                    const yaw = yaw0 + dyaws[yi], pit = Math.min(1.25, pit0 + dpits[pi]);
                    const cp = Math.cos(pit);
                    const dx = Math.sin(yaw) * cp, dy = Math.sin(pit), dz = Math.cos(yaw) * cp;
                    const reach = this._camReach(head, dx, dy, dz, r);
                    const score = reach - 3.0 * Math.abs(dyaws[yi]) - 2.2 * dpits[pi] + (k === this._lastCamCand ? 0.5 : 0);
                    if (score > bestScore) { bestScore = score; bestD = [dx, dy, dz, reach]; bestIdx = k; }
                }
            }
            this._lastCamCand = bestIdx;
            const reach = Math.max(0.9, bestD[3]);
            cam.x = head.x + bestD[0] * reach;
            cam.y = head.y + bestD[1] * reach;
            cam.z = head.z + bestD[2] * reach;
            return cam;
        }

        update(delta, time) {
            if (this.disposed) return;

            // Обновление частиц пламени факелов
            for (let i = 0; i < this.fires.length; i++) {
                this.fires[i].update(delta);
            }

            // Реалистичное мерцание света факелов
            const now = time || 0;
            for (let i = 0; i < this.lights.length; i++) {
                const item = this.lights[i];
                const flick = 0.90 + 0.10 * Math.sin(now * 11.0 + item.seed) * Math.sin(now * 6.5 + item.seed * 2.3);
                item.light.intensity = item.baseIntensity * flick;
            }
        }

        dispose() {
            this.disposed = true;
            if (this.group.parent) this.group.parent.remove(this.group);

            // Очистка огня
            this.fires.forEach(f => f.dispose());
            this.fires.length = 0;

            // Очистка геометрий
            this.geometries.forEach(g => g.dispose());
            this.geometries.length = 0;

            // Очистка материалов
            this.materials.forEach(m => m.dispose());
            this.materials.length = 0;
        }
    }

    window.AveloraDungeon = AveloraDungeon;
})();
