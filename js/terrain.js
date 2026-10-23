/**
 * Realistic Procedural Terrain with Configurable Water Bodies:
 * - 'coast': Sea / Ocean along any edge ('west', 'east', 'north', 'south')
 * - 'lake': Enclosed lake basin with custom center and radius
 * - 'island': Land island surrounded by ocean
 * - 'river': A winding channel carved along a centre-line: waterBody { type:'river', points:[[x,z],...]
 *             (Catmull-Rom smoothed), width (m), depth (<0), beachWidth (bank slope, m) }. The water plane
 *             (water.js) covers the whole map at Y = 0; land above 0 simply hides it.
 * Smooth beach, rolling meadow (0.4m to 1.8m), seamless photographic PBR textures
 */
// Затемнение земли у оснований деревьев/камней: столько ближайших якорей (environment.updateContactAO) перебирает
// шейдер в каждом пикселе. Было 48; 16 ближайших к герою визуально то же, а пиксель заметно дешевле (телефон).
const TERRAIN_AO_N = 16;
// Текстура расстояния до троп хранит расстояние до PATH_DIST_MAX м (дальше маски троп всё равно нулевые)
const PATH_DIST_MAX = 8.0;

const OCT_SIN = [0, 0.70711, 1, 0.70711, 0, -0.70711, -1, -0.70711], OCT_COS = [1, 0.70711, 0, -0.70711, -1, -0.70711, 0, 0.70711];
const PATH_DIST_PX_PER_M = 2;
window.TERRAIN_AO_N = TERRAIN_AO_N;

class LakesideTerrain {
    constructor(scene, options = {}, location = null) {
        this.scene = scene;

        const loc = location || window.CURRENT_LOCATION || {};
        const locTerrain = loc.terrain || {};
        this.location = loc;
        this.locTerrain = locTerrain;

        // Support rectangular dimensions (e.g. 300x200, 3:2 landscape) with fallback to square
        this.sizeX = locTerrain.sizeX || (Array.isArray(locTerrain.size) ? locTerrain.size[0] : locTerrain.size) || options.size || 120;
        this.sizeZ = locTerrain.sizeZ || (Array.isArray(locTerrain.size) ? locTerrain.size[1] : locTerrain.size) || options.size || 120;
        this.size = Math.max(this.sizeX, this.sizeZ);
        this.halfX = this.sizeX / 2;
        this.halfZ = this.sizeZ / 2;

        this.segmentsX = locTerrain.segmentsX || locTerrain.segments || options.segments || 240;
        this.segmentsZ = locTerrain.segmentsZ || locTerrain.segments || options.segments || 240;
        this.segments = Math.max(this.segmentsX, this.segmentsZ);

        this.border = (locTerrain.border !== undefined) ? locTerrain.border : 0;
        this.biome = locTerrain.biome || 'forest';
        this.groundSet = locTerrain.groundSet || 'moss';   // 'moss' — лесная подстилка (по умолчанию), 'meadow' — ровное зелёное покрытие

        // Water body configuration (lake, coast, island)
        this.waterConfig = locTerrain.waterBody || locTerrain.lake || {
            type: 'lake',
            x: -14.0,
            z: 2.0,
            radius: 24.0,
            depth: -1.6
        };

        this.hillsConfig = locTerrain.hills || { amplitude: 1.4, inclineX: 0.8, inclineZ: 0.4 };
        // Average ground level above the water plane (Y = 0). Higher = drier land, fewer puddles.
        this.baseHeight = (locTerrain.baseHeight !== undefined) ? locTerrain.baseHeight : 0.85;
        // Dirt paths (forest biome): [{points:[[x,z],...], width}] drawn by the terrain shader (max 12 segments)
        this.paths = locTerrain.paths || null;
        this.bridges = locTerrain.bridges || null; // [{x, z, length (along Z), width, deckY}]
        this.platforms = [];                       // building.js: raised plank decks with a ramp (see addPlatform)
        this.noise = new SimplexNoise(locTerrain.seed !== undefined ? locTerrain.seed : 4242);

        this.mesh = null;
        this.material = null;

        // Скальная «подкраска» склона вокруг грота (vec4: x, z, радиус, сила): гора темнеет и сереет к цвету камней модели
        const _cv = (locTerrain.caves && locTerrain.caves[0]) || null;
        const _rt = locTerrain.rockTint || null;   // тёмный камень горного пояса вокруг точки (ущелье-проход): { x, z, tintRadius, tintStrength }
        this.rockTintUniform = { value: _rt ? new THREE.Vector4(_rt.x, _rt.z, _rt.tintRadius || 24.0, _rt.tintStrength !== undefined ? _rt.tintStrength : 0.85) : new THREE.Vector4(0, 0, 1, 0) };
        this.caveRockUniform = { value: _cv ? new THREE.Vector4(_cv.x, _cv.z, _cv.tintRadius || 26.0, _cv.tintStrength !== undefined ? _cv.tintStrength : 0.85) : new THREE.Vector4(0, 0, 1, 0) };

        // Маска плотности леса для groundSet 'baseForest' (R-канал, 0 = поляна, 1 = лес). Заполняется setForestMask().
        this.forestN = 128;
        this.forestExt = this.size + 2 * this.border + 8;
        this.forestData = new Uint8Array(this.forestN * this.forestN * 4);
        this.forestTex = new THREE.DataTexture(this.forestData, this.forestN, this.forestN, THREE.RGBAFormat);
        this.forestTex.magFilter = THREE.LinearFilter;
        this.forestTex.minFilter = THREE.LinearFilter;
        this.forestTex.wrapS = this.forestTex.wrapT = THREE.ClampToEdgeWrapping;
        this.forestTex.needsUpdate = true;
        this.forestUniform = { value: this.forestTex };
        this.forestRectUniform = { value: new THREE.Vector4(-this.forestExt / 2, -this.forestExt / 2, 1 / this.forestExt, 0) };

        if (this.waterConfig.type === 'river') this.buildRiver();

        this.init();
    }

    /**
     * Маска «лес / поляна» по реальным деревьям (groundSet 'baseForest').
     * Каждое дерево даёт широкое мягкое пятно (R = 22 м, линейное затухание); порог выше вклада одного дерева: одиночное дерево остаётся на траве, группа деревьев даёт сплошной лес с плавной опушкой.
     * Вызывать после определения списка деревьев локации (environment.loadRealisticTrees).
     */
    setForestMask(trees) {
        const N = this.forestN, ext = this.forestExt, cell = ext / N, R = 22.0;
        const acc = new Float32Array(N * N);
        const x0 = -ext / 2, z0 = -ext / 2;
        (trees || []).forEach(t => {
            const w0 = 0.7 + 0.3 * Math.min(2.0, (t.s || 1));
            const i0 = Math.max(0, Math.floor((t.x - R - x0) / cell)), i1 = Math.min(N - 1, Math.ceil((t.x + R - x0) / cell));
            const j0 = Math.max(0, Math.floor((t.z - R - z0) / cell)), j1 = Math.min(N - 1, Math.ceil((t.z + R - z0) / cell));
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const d = Math.hypot(x0 + (i + 0.5) * cell - t.x, z0 + (j + 0.5) * cell - t.z);
                if (d < R) { const f = 1 - d / R; acc[j * N + i] += f * w0; }
            }
        });
        const ss = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
        for (let k = 0; k < N * N; k++) {
            const v = Math.round(ss(1.4, 2.6, acc[k]) * 255);
            this.forestData[k * 4] = v; this.forestData[k * 4 + 1] = v; this.forestData[k * 4 + 2] = v; this.forestData[k * 4 + 3] = 255;
        }
        this.forestTex.needsUpdate = true;
    }

    /** River: smooth the control points into a dense polyline (flat arrays: fast distance queries). */
    buildRiver() {
        const pts = (this.waterConfig.points || [[-40, 0], [40, 0]]).map(p => new THREE.Vector3(p[0], 0, p[1]));
        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
        const n = Math.max(40, pts.length * 24);
        this.riverX = new Float32Array(n + 1);
        this.riverZ = new Float32Array(n + 1);
        const v = new THREE.Vector3();
        for (let i = 0; i <= n; i++) {
            curve.getPointAt(i / n, v);
            this.riverX[i] = v.x; this.riverZ[i] = v.z;
        }
    }

    /** Distance (m) from (x, z) to the river centre-line. */
    riverDistance(x, z) {
        const X = this.riverX, Z = this.riverZ;
        let best = Infinity;
        for (let i = 0; i < X.length - 1; i++) {
            const ax = X[i], az = Z[i], bx = X[i + 1] - ax, bz = Z[i + 1] - az;
            const len2 = bx * bx + bz * bz;
            let t = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const dx = x - (ax + bx * t), dz = z - (az + bz * t);
            const d2 = dx * dx + dz * dz;
            if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
    }

    // Continuous, deterministic terrain elevation evaluation
    /**
     * Ground height used by gameplay (characters, pathfinding, props). Bridges (locTerrain.bridges)
     * lift the walkable surface over the river; the terrain MESH is built from getRawHeightAt so the
     * channel stays visible under the deck.
     */
    getHeightAt(x, z) {
        const h = this.getRawHeightAt(x, z);
        if (this._rawOnly) return h;
        const br = this.bridges;
        for (let i = 0; br && i < br.length; i++) {
            const b = br[i];
            const ax = Math.abs(x - b.x), az = Math.abs(z - b.z);
            const hw = b.width / 2 + 0.6, hl = b.length / 2;
            if (ax >= hw || az >= hl) continue;
            const fx = Math.min(1, (hw - ax) / 0.6);
            const fz = Math.min(1, (hl - az) / 1.2);
            const f = Math.min(fx, fz);
            const k = f * f * (3 - 2 * f);
            const deckY = b.deckY;
            return h + (deckY - h) * k;
        }
        const pl = this.platforms;
        if (pl && pl.length) {
            for (let i = 0; i < pl.length; i++) {
                const p = pl[i];
                const dx = x - p.x, dz = z - p.z;
                if (dx * dx + dz * dz > p.reach2) continue;
                const lx = dx * p.cos - dz * p.sin;
                const lz = dx * p.sin + dz * p.cos;
                const alx = Math.abs(lx);
                if (p.oct) {   // восьмиугольный настил (беседка): плоская сторона к локальному +Z
                    let m = -1e9;
                    for (let k = 0; k < 8; k++) { const v = lx * OCT_SIN[k] + lz * OCT_COS[k]; if (v > m) m = v; }
                    if (m <= p.oct) return p.y;
                } else if (alx <= p.hx && lz >= -p.hz && lz <= p.hz) return p.y;   // deck
                if (lz > p.hz && lz < p.hz + p.rampLen && alx < p.rampHx + 0.25) {   // ramp down to the ground
                    let plane = p.y + (p.endY - p.y) * ((lz - p.hz) / p.rampLen);
                    if (alx > p.rampHx) plane -= (alx - p.rampHx) * 4;               // soft side edge
                    return plane > h ? plane : h;
                }
            }
        }
        return h;
    }

    /** Raised walkable deck (building.js): {id, x, z, cos, sin, hx, hz, y, rampLen, rampHx, endY, reach2}. */
    addPlatform(p) { if (!this.platforms) this.platforms = []; this.platforms.push(p); }
    removePlatform(id) { if (this.platforms) this.platforms = this.platforms.filter(q => q.id !== id); }

    /**
     * Raw ground height + flat spots (locTerrain.flatSpots: [{x, z, radius, blend}]): inside radius the ground is levelled
     * to the height at the centre, over the next `blend` metres it eases back to the natural relief (smoothstep, no steps).
     * Used for portal pads. Everything (mesh, characters, grass, trees, pathfinding) reads the same function.
     */
    /** Сглаживание рельефа вдоль дороги (path.smooth = {width, blend, win}): профиль высоты вдоль оси усредняется, поперёк — ровная полоса и плавный откос. */
    _buildRoadSmooth() {
        this._rs = [];
        (this.paths || []).forEach(pp => {
            if (!pp.smooth || !pp.points || pp.points.length < 2) return;
            const sm = pp.smooth, STEP = 1.5, xs = [], zs = [];
            for (let i = 0; i < pp.points.length - 1; i++) {
                const a = pp.points[i], b = pp.points[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const n = Math.max(1, Math.round(L / STEP));
                for (let k = 0; k < n; k++) { xs.push(a[0] + (b[0] - a[0]) * k / n); zs.push(a[1] + (b[1] - a[1]) * k / n); }
            }
            const e = pp.points[pp.points.length - 1]; xs.push(e[0]); zs.push(e[1]);
            let hs = xs.map((x, i) => this._getRawHeightBase(x, zs[i]));
            const R = sm.win || 4;
            for (let pass = 0; pass < 3; pass++) {
                const o = hs.slice();
                for (let i = 0; i < hs.length; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - R); j <= Math.min(hs.length - 1, i + R); j++) { s += hs[j]; c++; } o[i] = s / c; }
                hs = o;
            }
            const hw = sm.width || 3.0, bl = sm.blend || 6.0, m = hw + bl;
            this._rs.push({ xs, zs, hs, hw, bl, x0: Math.min(...xs) - m, x1: Math.max(...xs) + m, z0: Math.min(...zs) - m, z1: Math.max(...zs) + m });
        });
    }

    _roadSmoothedH(x, z, h) {
        if (this._rs === undefined) this._buildRoadSmooth();
        for (let r = 0; r < this._rs.length; r++) {
            const q = this._rs[r];
            if (x < q.x0 || x > q.x1 || z < q.z0 || z > q.z1) continue;
            let bd = 1e9, bh = 0;
            for (let i = 0; i < q.xs.length - 1; i++) {
                const ax = q.xs[i], az = q.zs[i], dx = q.xs[i + 1] - ax, dz = q.zs[i + 1] - az;
                const l2 = dx * dx + dz * dz || 1e-9;
                const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
                const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
                if (d < bd) { bd = d; bh = q.hs[i] + (q.hs[i + 1] - q.hs[i]) * t; }
            }
            if (bd >= q.hw + q.bl) continue;
            const u = bd <= q.hw ? 1 : 1 - (bd - q.hw) / q.bl;
            h += (bh - h) * u * u * (3 - 2 * u);
        }
        return h;
    }

    getRawHeightAt(x, z) {
        let h = this._getRawHeightBase(x, z);
        if (this.paths && this._rs !== null) { h = this._roadSmoothedH(x, z, h); if (this._rs && !this._rs.length) this._rs = null; }
        const fs = this.locTerrain.flatSpots;
        if (!fs || !fs.length) return h;
        if (!this._flatH) this._flatH = [];
        let out = h;
        for (let i = 0; i < fs.length; i++) {
            const f = fs[i];
            const bl = (f.blend !== undefined) ? f.blend : 5.0;
            const d = Math.hypot(x - f.x, z - f.z);
            if (d >= f.radius + bl) continue;
            if (this._flatH[i] === undefined) this._flatH[i] = (f.hFrom ? this._getRawHeightBase(f.hFrom[0], f.hFrom[1]) : this._getRawHeightBase(f.x, f.z)) + (f.dh || 0);   // hFrom: высота берётся в другой точке (ущелье в горном поясе: дно = уровень луга перед входом)
            const t = d <= f.radius ? 1.0 : 1.0 - (d - f.radius) / bl;
            const w = t * t * (3.0 - 2.0 * t);
            out += (this._flatH[i] - out) * w;
        }
        // Небольшие горки по краям среза модели ущелья (z = 96.5) до южного края локации: закрывают торцы обрезанной скалы
        const rt = this.locTerrain.rockTint;
        if (rt && z > 93.5 && Math.abs(x - rt.x) < 10.0) {
            if (this._passBaseY === undefined) this._passBaseY = this._getRawHeightBase(rt.x, 79.0) + 0.24;
            const ss = (a, b, v) => { const u = Math.min(1.0, Math.max(0.0, (v - a) / (b - a))); return u * u * (3.0 - 2.0 * u); };
            const dx = x - rt.x;
            const wz = (0.75 * ss(92.5, 96.6, z) + 0.18 * ss(92.5, 99.4, z)) * (1.0 + 0.01 * ss(98.0, 99.8, z));   // у края локации выше, к скале плавный спуск
            const z1 = ss(96.0, 97.0, z);
            let ly = -99.0;
            if (dx <= -1.0) {
                ly = -0.35 + 5.95 * ss(-1.1, -2.3, dx) * (1.0 - ss(-6.8, -10.0, dx));   // зеркально правой
            } else if (dx >= 1.0) {
                ly = -0.35 + 5.95 * ss(1.1, 2.3, dx) * (1.0 - ss(6.8, 10.0, dx));
            }
            if (ly > -50.0) {
                const cap = this._passBaseY - 0.35 + (ly + 0.35) * wz;
                if (cap > out) out = cap;
            }
        }
        return out;
    }

    _getRawHeightBase(x, z) {
        if (this.locTerrain.flat) {
            return (this.locTerrain.baseHeight !== undefined) ? this.locTerrain.baseHeight : 0.0;
        }

        const nx = x / this.sizeX;
        const nz = z / this.sizeZ;

        // Base rolling meadow (hills)
        let meadowHills = this.noise.fbm(nx * 1.8, nz * 1.8, 3, 2.0, 0.45) * this.hillsConfig.amplitude;
        meadowHills += (nx * this.hillsConfig.inclineX) + (nz * this.hillsConfig.inclineZ);

        // Natural subtle ground undulation
        const groundMicro = this.noise.noise2D(x * 0.08, z * 0.08) * 0.35 + this.noise.noise2D(x * 0.2, z * 0.2) * 0.12;
        const gnScale = (this.locTerrain.groundNoise !== undefined) ? this.locTerrain.groundNoise : 1;
        let height = meadowHills + groundMicro * gnScale + this.baseHeight;

        // Calculate distance from shoreline based on water body type:
        // distFromShore < 0 means under water (sea/lake bed)
        // distFromShore > 0 means land above water
        let distFromShore = 0;
        let waterDepth = -1.6;
        let beachWidth = 14.0;
        let bedSlope = 20.0; // meters from shoreline until full depth

        const wType = this.waterConfig.type || 'lake';

        if (wType === 'coast') {
            // SEA COASTLINE: stretches infinitely along an entire edge of the map
            const side = this.waterConfig.side || 'west';
            const shoreLine = (this.waterConfig.shoreLine !== undefined) ? this.waterConfig.shoreLine : -10.0;
            waterDepth = (this.waterConfig.depth !== undefined) ? this.waterConfig.depth : -2.0;
            beachWidth = (this.waterConfig.beachWidth !== undefined) ? this.waterConfig.beachWidth : 14.0;

            // Natural organic fractal curves along the coast
            if (side === 'west') {
                const curve = shoreLine + this.noise.noise2D(nz * 2.5, 0.5) * 6.5 + this.noise.noise2D(nz * 6.0, 1.2) * 2.5;
                distFromShore = x - curve;
            } else if (side === 'east') {
                const curve = shoreLine - (this.noise.noise2D(nz * 2.5, 0.5) * 6.5 + this.noise.noise2D(nz * 6.0, 1.2) * 2.5);
                distFromShore = curve - x;
            } else if (side === 'north') {
                const curve = shoreLine + this.noise.noise2D(nx * 2.5, 0.5) * 6.5 + this.noise.noise2D(nx * 6.0, 1.2) * 2.5;
                distFromShore = z - curve;
            } else if (side === 'south') {
                const curve = shoreLine - (this.noise.noise2D(nx * 2.5, 0.5) * 6.5 + this.noise.noise2D(nx * 6.0, 1.2) * 2.5);
                distFromShore = curve - z;
            }
        } else if (wType === 'coast_lake') {
            // COAST on west + INLAND LAKE in center
            const shoreLine = (this.waterConfig.shoreLine !== undefined) ? this.waterConfig.shoreLine : -75.0;
            waterDepth = (this.waterConfig.depth !== undefined) ? this.waterConfig.depth : -2.2;
            beachWidth = (this.waterConfig.beachWidth !== undefined) ? this.waterConfig.beachWidth : 16.0;

            const curve = shoreLine + this.noise.noise2D(nz * 2.5, 0.5) * 7.5 + this.noise.noise2D(nz * 6.0, 1.2) * 3.0;
            const distCoast = x - curve;

            const lakeX = (this.waterConfig.lakeX !== undefined) ? this.waterConfig.lakeX : 15.0;
            const lakeZ = (this.waterConfig.lakeZ !== undefined) ? this.waterConfig.lakeZ : -5.0;
            const baseRadius = this.waterConfig.radius || 20.0;
            const dx = x - lakeX;
            const dz = z - lakeZ;
            const distCenter = Math.sqrt(dx * dx + dz * dz);
            const angle = Math.atan2(dz, dx);
            const wobble = Math.min(1.0, baseRadius / 24.0);
            const sm = !!this.waterConfig.shoreSmooth;
            const lakeRadius = baseRadius + (this.noise.noise2D(Math.cos(angle) * 1.3, Math.sin(angle) * 1.3) * 6.0
                                          + (sm ? this.noise.noise2D(Math.cos(angle * 2) * 1.1, Math.sin(angle * 2) * 1.1) * 3.0
                                                : this.noise.noise2D(Math.cos(angle * 3) * 2.2, Math.sin(angle * 3) * 2.2) * 2.5)) * wobble;
            const distLake = distCenter - lakeRadius;

            distFromShore = Math.min(distCoast, distLake);
            bedSlope = Math.min(20.0, baseRadius * 0.85);
        } else if (wType === 'island') {
            // ISLAND: land in center, sea all around
            const distFromCenter = Math.sqrt(x * x + z * z);
            const islandRadius = (this.waterConfig.radius || 35.0) + this.noise.noise2D(x * 0.05, z * 0.05) * 6.0;
            distFromShore = islandRadius - distFromCenter;
            waterDepth = this.waterConfig.depth || -2.5;
            beachWidth = this.waterConfig.beachWidth || 12.0;
        } else if (wType === 'none') {
            // Flat land, no water
            return height;
        } else if (wType === 'river') {
            // RIVER: channel along a smoothed centre-line; banks wobble a little so it isn't a ditch
            const halfW = (this.waterConfig.width || 5.0) / 2;
            waterDepth = (this.waterConfig.depth !== undefined) ? this.waterConfig.depth : -0.9;
            beachWidth = (this.waterConfig.beachWidth !== undefined) ? this.waterConfig.beachWidth : 3.2;
            const wobble = this.noise.noise2D(x * 0.11, z * 0.11) * 0.55 + this.noise.noise2D(x * 0.3, z * 0.3) * 0.15;
            distFromShore = this.riverDistance(x, z) - halfW - wobble;
            bedSlope = Math.max(1.2, halfW * 0.8);
        } else {
            // LAKE: enclosed round/fractal lake basin
            const lakeX = (this.waterConfig.x !== undefined) ? this.waterConfig.x : -14.0;
            const lakeZ = (this.waterConfig.z !== undefined) ? this.waterConfig.z : 2.0;
            const baseRadius = this.waterConfig.radius || 24.0;
            waterDepth = (this.waterConfig.depth !== undefined) ? this.waterConfig.depth : -1.6;
            beachWidth = (this.waterConfig.beachWidth !== undefined) ? this.waterConfig.beachWidth : 14.0;

            const dx = x - lakeX;
            const dz = z - lakeZ;
            const distCenter = Math.sqrt(dx * dx + dz * dz);
            const angle = Math.atan2(dz, dx);
            // Shoreline wobble scales with lake size (small ponds stay pond-shaped)
            const wobble = Math.min(1.0, baseRadius / 24.0);
            // shoreSmooth: берег без зубцов — вторая гармоника в ~2 раза реже (крупные плавные заливы вместо «пилы»)
            const sm = !!this.waterConfig.shoreSmooth;
            const lakeRadius = baseRadius + (this.noise.noise2D(Math.cos(angle) * 1.3, Math.sin(angle) * 1.3) * 6.0
                                          + (sm ? this.noise.noise2D(Math.cos(angle * 2) * 1.1, Math.sin(angle * 2) * 1.1) * 3.0
                                                : this.noise.noise2D(Math.cos(angle * 3) * 2.2, Math.sin(angle * 3) * 2.2) * 2.5)) * wobble;
            distFromShore = distCenter - lakeRadius;
            bedSlope = Math.min(20.0, baseRadius * 0.85); // small ponds get deep quickly
        }

        // Apply smooth beach and water bed profile:
        if (distFromShore < 0) {
            // Under water (seabed or lakebed)
            const t = Math.min(1.0, -distFromShore / bedSlope);
            const smoothT = t * t * (3.0 - 2.0 * t);
            height = THREE.MathUtils.lerp(0.0, waterDepth, smoothT);
        } else if (distFromShore < beachWidth) {
            // Gentle sandy beach slope from waterline (0.0m) to meadow
            const t = distFromShore / beachWidth;
            let smoothT = t * t * (3.0 - 2.0 * t);
            if (this.waterConfig && this.waterConfig.type === 'lake') smoothT = 0.5 * smoothT + 0.5 * t;
            height = THREE.MathUtils.lerp(0.0, height, smoothT);
        }

        // Мягкий «пол» суши (locTerrain.landFloor): вдали от берега низины не опускаются к уровню воды (Y = 0) —
        // иначе в понижениях рельефа появляются «лужи». Плавное включение за пределами пляжа.
        if (this.locTerrain.landFloor !== undefined && distFromShore >= beachWidth) {
            const fl = this.locTerrain.landFloor, k = 0.35;
            const w = Math.min(1.0, (distFromShore - beachWidth) / 8.0);
            const sw = w * w * (3.0 - 2.0 * w);
            const soft = 0.5 * (height + fl + Math.sqrt((height - fl) * (height - fl) + k * k));
            height += (soft - height) * sw;
        }

        // Natural mountain barrier rim along the perimeter
        if (this.locTerrain.mountains !== false) {
            const rimWidth = (this.locTerrain.mountainRim && this.locTerrain.mountainRim.width) || 16.0;

            const noWest = !!(this.locTerrain.mountainRim && this.locTerrain.mountainRim.noWest);
            const distFromEdgeX = noWest ? (this.halfX - x) : (this.halfX - Math.abs(x));
            const distFromEdgeZ = this.halfZ - Math.abs(z);
            const distFromEdge = Math.min(distFromEdgeX, distFromEdgeZ);

            if (distFromEdge < rimWidth) {
                // Rising smoothly from 0 at rimWidth to 1 at distance 1.5m from boundary
                const t = Math.min(1.0, Math.max(0.0, (rimWidth - distFromEdge) / (rimWidth - 1.5)));
                const smoothFactor = t * t * (3.0 - 2.0 * t);

                // Multi-frequency peak and saddle modulation:
                // Generates diverse heights from ~5.5m up to ~9.5m across the perimeter
                const nx = x / this.sizeX, nz = z / this.sizeZ;
                const peakMod = Math.sin(nx * 18.0 + nz * 12.0) * 1.6 + Math.cos(nx * 26.0 - nz * 22.0) * 1.1;
                const baseHeight = 5.5 + peakMod;

                // Sharp ridged multifractal crags (creates sharp angular alpine ridges instead of smooth round mounds)
                const sharpRidge = 1.0 - Math.abs(this.noise.noise2D(x * 0.075, z * 0.075));
                const crags = Math.pow(sharpRidge, 1.8) * 2.4;
                const microCrags = Math.abs(this.noise.noise2D(x * 0.15, z * 0.15)) * 0.85;

                // Около оси ущелья (rimDip) острые гряды (crags) гасятся — мягкие округлые склоны без углов
                let cragK = 1.0;
                const rd0 = this.locTerrain.rimDip || [];
                for (let di = 0; di < rd0.length; di++) {
                    const D0 = rd0[di];
                    const q0 = Math.min(1.0, Math.abs(x - D0.x) / D0.w);
                    const s0 = q0 * q0 * (3.0 - 2.0 * q0);
                    cragK = Math.min(cragK, (D0.cragK !== undefined ? D0.cragK : 0.3) + (1.0 - (D0.cragK !== undefined ? D0.cragK : 0.3)) * s0);
                }
                // Гладкая замена острым гребням: у оси ущелья (cragK->0) вместо abs()-изломов - мягкий низкочастотный шум
                const cragSoft = 1.25 + 0.45 * this.noise.noise2D(x * 0.03 + 11.0, z * 0.03 - 7.0);
                const cragMix = cragSoft + ((crags + microCrags) - cragSoft) * cragK;
                let mHeight = smoothFactor * baseHeight + smoothFactor * cragMix;

                // Мягкий «провал» гор вдоль линии края (rimDip): минимум у оси ущелья (k0), плавно до полной высоты на расстоянии w по бокам
                const rd = this.locTerrain.rimDip || [];
                for (let di = 0; di < rd.length; di++) {
                    const D = rd[di];
                    const q = Math.min(1.0, Math.abs(x - D.x) / D.w);
                    const s = q * q * q * (q * (q * 6.0 - 15.0) + 10.0);
                    mHeight *= D.k0 + (1.0 - D.k0) * s;
                }

                // Mountain passes (western canyon cut to Lake Land)
                const passes = this.locTerrain.mountainPasses || [];
                for (let i = 0; i < passes.length; i++) {
                    const pass = passes[i];
                    // Проход режет гору от долины до тупика (pass.x). Портал стоит ПЕРЕД тупиком, дно прохода ровное.
                    // side:'east' — зеркально для восточного края (тупик: pass.x, конец стены: pass.maxX); по умолчанию — западный.
                    const east = pass.side === 'east';
                    const ax = east ? -x : x;                                   // ось прохода: растёт от тупика к долине
                    const deadX = east ? -pass.x : pass.x;
                    const minPassX = east ? -((pass.maxX !== undefined) ? pass.maxX : (this.halfX + 1.0))
                                          : ((pass.minX !== undefined) ? pass.minX : -141.0);
                    if (ax >= minPassX && ax <= (deadX + 12.0)) {
                        const dz = Math.abs(z - pass.z);
                        const pRadius = pass.radius || 14.0;
                        if (dz < pRadius) {
                            const passFactor = Math.cos((dz / pRadius) * (Math.PI / 2));
                            // За тупиком стена круто поднимается до полной высоты горы
                            const depthFactor = (ax < deadX) ? Math.max(0.0, (ax - minPassX) / (deadX - minPassX)) : 1.0;
                            mHeight *= (1.0 - Math.pow(passFactor * depthFactor, 1.8));
                        }
                    }
                }

                // Cave alcoves in the mountain rim (e.g. eastern cave at x≈139, z≈-18)
                const caves = this.locTerrain.caves || [];
                for (let ci = 0; ci < caves.length; ci++) {
                    const c = caves[ci];
                    const dz = Math.abs(z - c.z);
                    const rz = c.radiusZ || 3.5;
                    if (dz >= rz) continue;
                    const minCX = c.minX !== undefined ? c.minX : (c.x - 5.5);
                    const maxCX = c.maxX !== undefined ? c.maxX : (c.x + 4.0);
                    if (x < minCX || x > maxCX) continue;
                    const factorZ = Math.cos((dz / rz) * (Math.PI / 2));
                    const backLen = c.backLen !== undefined ? c.backLen : 1.0;
                    const taperX = (x > (maxCX - backLen)) ? Math.max(0.0, (maxCX - x) / backLen) : 1.0;
                    const cut = Math.pow(factorZ * taperX, 1.8);
                    mHeight *= (1.0 - cut);
                }

                height += mHeight;

                // Level floor inside cave interior so the 3D model's stone floor sits proud of grass
                for (let ci = 0; ci < caves.length; ci++) {
                    const c = caves[ci];
                    const dz = Math.abs(z - c.z);
                    const rz = (c.radiusZ || 3.5) * 0.85;
                    if (dz < rz && x >= (c.x - 3.5) && x <= (c.x + 2.5)) {
                        const f = Math.cos((dz / rz) * (Math.PI / 2));
                        const targetH = 1.40;   // на 0.1 м ниже каменного пола модели грота (grotto y=3.44 -> пол 1.50)
                        height = height * (1.0 - f) + targetH * f;
                    }
                }
            }
        }

        return height;
    }

    getNormalAt(x, z) {
        const eps = 0.25;
        const hL = this.getHeightAt(x - eps, z);
        const hR = this.getHeightAt(x + eps, z);
        const hD = this.getHeightAt(x, z - eps);
        const hU = this.getHeightAt(x, z + eps);

        const normal = new THREE.Vector3(hL - hR, 2.0 * eps, hD - hU).normalize();
        return normal;
    }

    getSlopeAt(x, z) {
        const normal = this.getNormalAt(x, z);
        return 1.0 - normal.y;
    }

    init() {
        const meshSizeX = this.sizeX + this.border * 2;
        const meshSizeZ = this.sizeZ + this.border * 2;
        const meshSegmentsX = Math.round(this.segmentsX * meshSizeX / this.sizeX);
        const meshSegmentsZ = Math.round(this.segmentsZ * meshSizeZ / this.sizeZ);
        const geo = new THREE.PlaneGeometry(meshSizeX, meshSizeZ, meshSegmentsX, meshSegmentsZ);
        geo.rotateX(-Math.PI / 2); // Lay flat on XZ plane

        const posAttr = geo.attributes.position;
        const normAttr = geo.attributes.normal;
        this._rawOnly = true; // mesh shows the real channel under bridges

        // Set heights once per vertex, then derive smooth normals from grid neighbors (avoids 4x getHeightAt per vertex)
        const cols = meshSegmentsX + 1;
        const rows = meshSegmentsZ + 1;
        const rawHeights = new Float32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i);
            const z = posAttr.getZ(i);
            const y = this.getHeightAt(x, z);
            rawHeights[i] = y;

            // Perimeter skirt: pull the outermost boundary vertices down below ground (-6m)
            // This forms a solid vertical rock back-wall, eliminating any open cross-section/void
            const atOuterEdge = Math.abs(x) >= (this.halfX - 0.25) || Math.abs(z) >= (this.halfZ - 0.25);
            posAttr.setY(i, atOuterEdge ? -6.0 : y);
        }

        const stepX = meshSizeX / meshSegmentsX;
        const stepZ = meshSizeZ / meshSegmentsZ;
        for (let rz = 0; rz < rows; rz++) {
            const rU = rz > 0 ? rz - 1 : rz;
            const rD = rz < rows - 1 ? rz + 1 : rz;
            const dz = (rD - rU) * stepZ;
            for (let cx = 0; cx < cols; cx++) {
                const cL = cx > 0 ? cx - 1 : cx;
                const cR = cx < cols - 1 ? cx + 1 : cx;
                const dx = (cR - cL) * stepX;
                const i = rz * cols + cx;
                const hL = rawHeights[rz * cols + cL];
                const hR = rawHeights[rz * cols + cR];
                const hU = rawHeights[rU * cols + cx];
                const hD = rawHeights[rD * cols + cx];
                const nx = (hL - hR) / dx;
                const nz = (hU - hD) / dz;
                const invLen = 1.0 / Math.sqrt(nx * nx + 1.0 + nz * nz);
                normAttr.setXYZ(i, nx * invLen, invLen, nz * invLen);
            }
        }

        this._rawOnly = false;
        posAttr.needsUpdate = true;
        normAttr.needsUpdate = true;

        // Load PBR Textures from base64 assets based on active biome
        const texLoader = new THREE.TextureLoader();
        let grassDiff, grassNor, trailDiff, rockDiff, rockNor, beachDiff;

        const assets = window.GAME_ASSETS && window.GAME_ASSETS.textures ? window.GAME_ASSETS.textures : {};

        if (this.biome === 'goldshire') {
            grassDiff = texLoader.load(assets.goldshireGrassDiff || assets.meadowDiff);
            grassNor = texLoader.load(assets.goldshireGrassNor || assets.meadowNor);
            trailDiff = texLoader.load(assets.goldshireTrailDiff || assets.gravelDiff || assets.beachDiff);
            rockDiff = texLoader.load(assets.rockDiff);
            rockNor = texLoader.load(assets.rockNor || assets.beachNor);
            beachDiff = texLoader.load(assets.beachDiff);
        } else {
            // forest / default / camp: base is photorealistic forest litter (meadowDiff)
            const useMeadow = (this.groundSet === 'meadow') && assets.meadowGrassDiff;
            grassDiff = texLoader.load(useMeadow ? assets.meadowGrassDiff : assets.meadowDiff);
            grassNor = texLoader.load(useMeadow ? (assets.meadowGrassNor || assets.meadowNor) : assets.meadowNor);
            trailDiff = texLoader.load(assets.gravelDiff || assets.beachDiff);
            rockDiff = texLoader.load(assets.rockDiff);
            rockNor = texLoader.load(assets.rockNor || assets.beachNor);
            const wType = this.waterConfig.type || 'lake';
            const isLakeOrRiver = (wType === 'lake' || wType === 'river');
            const shoreTex = (isLakeOrRiver && (assets.gravelDiff || assets.dirtTrailDiff)) ? (assets.gravelDiff || assets.dirtTrailDiff) : assets.beachDiff;
            beachDiff = texLoader.load(shoreTex);
        }

        const stoneTrailDiff = texLoader.load((this.locTerrain.stoneTexture && assets[this.locTerrain.stoneTexture]) || assets.stoneTrailDiff || assets.gravelDiff || assets.beachDiff);
        // groundMode:
        // 0: default single texture
        // 1: 'moss2' (forestEdge: подстилка + пятна травы и темный подлесок)
        // 2: 'grass2' (сплошное тёмное травяное покрытие)
        // 4: 'baseForest' (moss2 как база + лес/трава по реальным деревьям: маска плотности леса uForestMap)
        // 3: 'camp' (homeCamp: сочная зелёная трава на полянке без леса + лесная подстилка в лесу)
        const groundMode = (this.groundSet === 'savanna') ? 5 : (this.groundSet === 'baseForest') ? 4 : (this.groundSet === 'camp') ? 3 : ((this.groundSet === 'grass2') ? 2 : (this.groundSet === 'moss2' ? 1 : 0));
        const mixGround = groundMode > 0 && !!assets.meadowGrassDiff;
        this.contactAO = []; for (let i = 0; i < TERRAIN_AO_N; i++) this.contactAO.push(new THREE.Vector4(0, 0, 0, 0)); // uAO[TERRAIN_AO_N] is declared in every variant: always give it that many entries (empty array crashes the uniform upload)
        const grass2Diff = mixGround ? texLoader.load(assets.meadowGrassDiff) : grassDiff;
        this.textures = [grassDiff, grassNor, trailDiff, stoneTrailDiff, rockDiff, rockNor, beachDiff, grass2Diff];
        this.textures.forEach(tex => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = (window.GFX && window.GFX.aniso) || 8;   // телефон: 2 (gfx_profile.js MOBILE)
        });

        grassDiff.repeat.set(20, 20);
        trailDiff.repeat.set(18, 18);
        stoneTrailDiff.repeat.set(24, 24);
        const curWType = this.waterConfig.type || 'lake';
        const isLakeOrRiverWater = (curWType === 'lake' || curWType === 'river');
        beachDiff.repeat.set(isLakeOrRiverWater ? 24 : 14, isLakeOrRiverWater ? 24 : 14);
        rockDiff.repeat.set(16, 16);
        // Normal map uses mesh UVs: keep ~6 m tiles regardless of map size
        grassNor.repeat.set(20 * meshSizeX / 120, 20 * meshSizeZ / 120);

        // Standard Material with smooth PBR blending
        this.material = new THREE.MeshStandardMaterial({
            roughness: 0.86,
            metalness: 0.04,
            flatShading: false,
            normalMap: grassNor,
            normalScale: new THREE.Vector2(0.5, 0.5)
        });

        // КРИТИЧНО для Three.js: без customProgramCacheKey движок повторно использует
        // скомпилированный шейдер первой локации для всех последующих!
        this.material.customProgramCacheKey = () => `lakeside_terrain_${this.biome}_${this.segments}_v41_${this.groundSet}_mix${mixGround ? groundMode : 0}`;

        const biomeId = (this.biome === 'goldshire') ? 1.0 : ((this.biome === 'volcanic') ? 2.0 : 0.0);
        const waterTypeId = (curWType === 'coast') ? 1.0 : ((curWType === 'river') ? 2.0 : 0.0);

        this.material.onBeforeCompile = (shader) => {
            shader.uniforms.uGrassDiff = { value: grassDiff };
            shader.uniforms.uTrailDiff = { value: trailDiff };
            shader.uniforms.uStoneTrailDiff = { value: stoneTrailDiff };
            shader.uniforms.uRockDiff = { value: rockDiff };
            shader.uniforms.uRockNor = { value: rockNor };
            shader.uniforms.uBeachDiff = { value: beachDiff };
            shader.uniforms.uBiome = { value: biomeId };
            shader.uniforms.uWaterType = { value: waterTypeId };
            shader.uniforms.uGrass2Diff = { value: grass2Diff };
            shader.uniforms.uGroundMix = { value: mixGround ? groundMode : 0.0 };
            shader.uniforms.uAO = { value: this.contactAO || [] };
            shader.uniforms.uForestMap = this.forestUniform;
            shader.uniforms.uCaveRock = this.caveRockUniform;
            shader.uniforms.uRockTint = this.rockTintUniform;
            shader.uniforms.uForestRect = this.forestRectUniform;

            const dirtSegs = [];
            const stoneSegs = [];
            let dirtWidth = 2.6;
            let stoneWidth = 2.8;

            (this.paths || []).forEach(pp => {
                if (pp.thin) return;   // тонкие тропинки ширину общей маски не задают
                if (pp.type === 'stone') stoneWidth = pp.width || stoneWidth;
                else dirtWidth = pp.width || dirtWidth;
            });
            const dirtOff = [], stoneOff = [];
            (this.paths || []).forEach(pp => {
                const isStone = (pp.type === 'stone');
                const targetSegs = isStone ? stoneSegs : dirtSegs;
                const targetOff = isStone ? stoneOff : dirtOff;
                // тонкая тропинка: расстояние до неё увеличивается на разницу полуширин, шейдер остаётся общим
                const off = pp.thin ? Math.max(0, ((isStone ? stoneWidth : dirtWidth) - (pp.width || 1.0)) * 0.5) : 0;
                for (let i = 0; i + 1 < pp.points.length && targetSegs.length < 16; i++) {
                    targetSegs.push(new THREE.Vector4(pp.points[i][0], pp.points[i][1], pp.points[i + 1][0], pp.points[i + 1][1]));
                    targetOff.push(off);
                }
            });

            const nDirt = dirtSegs.length;
            const nStone = stoneSegs.length;
            while (dirtSegs.length < 16) dirtSegs.push(new THREE.Vector4(0, 0, 0, 0));
            while (stoneSegs.length < 16) stoneSegs.push(new THREE.Vector4(0, 0, 0, 0));

            shader.uniforms.uDirtSeg = { value: dirtSegs };
            shader.uniforms.uDirtCount = { value: nDirt };
            shader.uniforms.uDirtWidth = { value: dirtWidth };

            shader.uniforms.uStoneSeg = { value: stoneSegs };
            shader.uniforms.uStoneCount = { value: nStone };
            shader.uniforms.uStoneWidth = { value: stoneWidth };

            // Расстояние до троп считается один раз на локацию в текстуру (раньше — циклом по 2×16 отрезкам в каждом пикселе)
            const pathTex = this._buildPathDistTexture(dirtSegs, nDirt, stoneSegs, nStone, dirtOff, stoneOff);
            shader.uniforms.uPathDist = { value: pathTex.texture };
            shader.uniforms.uPathRect = { value: pathTex.rect };

            shader.vertexShader = `
                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;
                ${shader.vertexShader}
            `;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
                vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
                `
            );

            shader.fragmentShader = `
                #define TERRAIN_AO_N ${TERRAIN_AO_N}
                #define PATH_DIST_MAX ${PATH_DIST_MAX.toFixed(1)}
                uniform sampler2D uGrassDiff;
                uniform sampler2D uGrass2Diff;
                uniform float uGroundMix;
                uniform vec4 uAO[TERRAIN_AO_N];
                uniform sampler2D uPathDist;
                uniform vec4 uPathRect;
                uniform sampler2D uForestMap;
                uniform vec4 uCaveRock;
                uniform vec4 uRockTint;
                uniform vec4 uForestRect;
                uniform sampler2D uTrailDiff;
                uniform sampler2D uStoneTrailDiff;
                uniform sampler2D uRockDiff;
                uniform sampler2D uRockNor;
                uniform sampler2D uBeachDiff;
                uniform float uBiome;
                uniform float uWaterType;
                uniform int uDirtCount;
                uniform float uDirtWidth;
                uniform int uStoneCount;
                uniform float uStoneWidth;

                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;

                // Быстрый процедурный шум для органичных рваных краев тропинки
                float avHash(vec2 p) {
                    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
                }
                float avNoise(vec2 p) {
                    vec2 i = floor(p);
                    vec2 f = fract(p);
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(mix(avHash(i + vec2(0.0, 0.0)), avHash(i + vec2(1.0, 0.0)), u.x),
                               mix(avHash(i + vec2(0.0, 1.0)), avHash(i + vec2(1.0, 1.0)), u.x), u.y);
                }

                ${shader.fragmentShader}
            `;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                vec2 uvShore      = vWorldPosition.xz * 0.12;
                vec2 uvGrass      = vWorldPosition.xz * 0.16;
                vec2 uvDirtTrail  = vWorldPosition.xz * 0.18;
                vec2 uvStoneTrail = vWorldPosition.xz * 0.26;

                // Двухмасштабная проекция скальной породы с компенсацией уклона (без растягивания)
                vec2 uvRockMacro = vWorldPosition.xz * 0.22 + vec2(vWorldPosition.y * 0.10, 0.0);
                vec2 uvRockMicro = vWorldPosition.xz * 0.68 + vec2(0.0, vWorldPosition.y * 0.35);

                vec4 colGrass = texture2D(uGrassDiff, uvGrass);

                // Shore weight:
                float shoreWeight;
                if (uWaterType > 0.5 && uWaterType < 1.5) {
                    shoreWeight = 1.0 - smoothstep(0.12, 0.85, vWorldPosition.y);
                } else {
                    float shoreEdgeN = (vWorldPosition.y < 0.35) ? avNoise(vWorldPosition.xz * 0.45) * 0.05 : 0.0;
                    shoreWeight = 1.0 - smoothstep(0.02, 0.20 + shoreEdgeN, vWorldPosition.y);
                }
                vec3 colBeachRgb = (shoreWeight > 0.0005) ? texture2D(uBeachDiff, uvShore).rgb : vec3(0.0);

                // Rocky outcrop weight: moderate slope (normal.y < 0.90)
                float cliffWeight = 1.0 - smoothstep(0.70, 0.90, vWorldNormal.y);

                vec3 terrainColor;

                if (uBiome > 0.5 && uBiome < 1.5) {
                    // === BIOME: GOLDSHIRE (Poly Haven High-Res Scanned Terrain) ===
                    float roadCurveZ = 5.2 + sin(vWorldPosition.x * 0.072) * 3.6;
                    float roadDist = abs(vWorldPosition.z - roadCurveZ);
                    float roadMask = 1.0 - smoothstep(1.6, 3.8, roadDist);
                    roadMask *= smoothstep(0.0, 5.0, vWorldPosition.x);
                    roadMask *= 1.0 - smoothstep(49.0, 53.0, vWorldPosition.x);

                    vec3 colDirtRgb = (roadMask > 0.0005) ? texture2D(uTrailDiff, uvDirtTrail).rgb : colGrass.rgb;
                    vec3 baseCol = mix(colGrass.rgb, colDirtRgb, roadMask * 0.95);
                    terrainColor = mix(baseCol, colBeachRgb, shoreWeight);
                    if (cliffWeight > 0.0005) {
                        vec3 rockTex = mix(texture2D(uRockDiff, uvRockMacro).rgb, texture2D(uRockDiff, uvRockMicro).rgb * 1.15, 0.50);
                        terrainColor = mix(terrainColor, rockTex, cliffWeight * 0.80);
                    }
                    terrainColor = pow(terrainColor, vec3(1.10));
                } else if (uBiome > 1.5) {
                    // === BIOME: VOLCANIC (Future Extensibility) ===
                    vec3 rockTex = mix(texture2D(uRockDiff, uvRockMacro).rgb, texture2D(uRockDiff, uvRockMicro).rgb * 1.15, 0.50);
                    vec3 ashCol = rockTex * 0.35;
                    vec3 lavaGlow = vec3(1.0, 0.35, 0.05);
                    float lavaCracks = smoothstep(0.85, 0.98, sin(vWorldPosition.x * 0.25) * cos(vWorldPosition.z * 0.25));
                    terrainColor = mix(ashCol, lavaGlow, lavaCracks * 0.85);
                    terrainColor = mix(terrainColor, rockTex * 0.5, cliffWeight);
                } else {
                    // === BIOME: FOREST (Lush Meadow + Dirt Trail to Waterfall + Stone Road to Lake + Dirt Mountain Pass) ===

                    // 1) Грунтовая земляная тропа на запад к горному каньону (Z ~ 8, X от -10 до -146)
                    float passTrailZ = 8.0 + sin(vWorldPosition.x * 0.055) * 2.2;
                    float passTrailDist = abs(vWorldPosition.z - passTrailZ);
                    float passTrailMask = 1.0 - smoothstep(1.8, 3.8, passTrailDist);
                    passTrailMask *= (1.0 - smoothstep(-12.0, 6.0, vWorldPosition.x));
                    passTrailMask *= (1.0 - smoothstep(-148.0, -140.0, vWorldPosition.x));

                    // 2) Грунтовая дорожка от точки спавна к Лираэль и водопаду (uDirtSeg)
                    vec2 pathD = texture2D(uPathDist, (vWorldPosition.xz - uPathRect.xy) * uPathRect.zw).rg * PATH_DIST_MAX;
                    float dirtPathD = pathD.x;
                    float dirtMask = 0.0;
                    if (uDirtCount > 0 && dirtPathD < uDirtWidth * 0.5 + 1.2) {
                        float dirtEdgeNoise = avNoise(vWorldPosition.xz * 1.3) * 0.35 + sin(vWorldPosition.x * 0.8 + vWorldPosition.z * 0.7) * 0.18;
                        float dirtHalfW = (uDirtWidth * 0.5) + dirtEdgeNoise;
                        dirtMask = 1.0 - smoothstep(dirtHalfW - 0.45, dirtHalfW + 0.55, dirtPathD);
                    }
                    if (uGroundMix > 4.5) passTrailMask = 0.0;   // саванна: зашитой в шейдер тропы стартовой локации нет
                    passTrailMask = max(passTrailMask, dirtMask * 0.95 / 0.88);

                    // 3) Каменная тропа от водопада (120, 4) до озера в центре (-18, -16) (uStoneSeg)
                    float stonePathD = pathD.y;
                    float stoneMask = 0.0;
                    float shoulderMask = 0.0;
                    if (uStoneCount > 0 && stonePathD < uStoneWidth * 0.5 + 2.0) {
                        float stoneEdgeNoise = avNoise(vWorldPosition.xz * 1.4) * 0.42 + sin(vWorldPosition.x * 0.85 + vWorldPosition.z * 0.65) * 0.24;
                        float stoneHalfW = (uStoneWidth * 0.5) + stoneEdgeNoise;
                        stoneMask = 1.0 - smoothstep(stoneHalfW * 0.55, stoneHalfW + 0.35, stonePathD);
                        shoulderMask = 1.0 - smoothstep(stoneHalfW + 0.25, stoneHalfW + 1.25, stonePathD);
                    }

                    // Центр — старинная каменная мостовая Poly Haven (читаем текстуру только на тропе)
                    vec3 centerPath = (stoneMask > 0.0005) ? texture2D(uStoneTrailDiff, uvStoneTrail).rgb : vec3(0.0);
                    vec3 colDirtRgb = (passTrailMask > 0.0005 || shoulderMask > 0.0005 || uGroundMix > 4.5) ? texture2D(uTrailDiff, uvDirtTrail).rgb : vec3(0.0);

                    // Смешивание слоев покрытия:
                    // 1) Для 'camp' (uGroundMix > 2.5): сочная зелёная трава на полянке (где нет леса) + лесная подстилка в лесу
                    // 2) Для 'moss2' (uGroundMix > 0.5): оригинальная лесная подстилка + пятна травы и подлесок
                    vec3 groundCol = colGrass.rgb;
                    if (uGroundMix > 4.5) {
                        // === GROUND: SAVANNA (golden dry grass, patches of red earth, fresh green near water) ===
                        vec2 gxz = vWorldPosition.xz;
                        vec3 sT1 = texture2D(uGrass2Diff, gxz * 0.16 + vec2(0.13, 0.57)).rgb;
                        vec3 sT2 = texture2D(uGrass2Diff, gxz * 0.043 + vec2(0.71, 0.29)).rgb;   // крупный масштаб: разбивает повтор плитки
                        vec3 sTex = mix(sT1, sT2, 0.45);
                        vec3 sGray = vec3(dot(sTex, vec3(0.30, 0.55, 0.15))) * 1.30;   // яркость текстуры без зелёного оттенка
                        vec3 dryGold  = sGray * vec3(1.05, 0.68, 0.24);
                        vec3 dryPale  = sGray * vec3(1.25, 0.90, 0.38);
                        vec3 greenG   = sTex * vec3(0.55, 0.60, 0.22);
                        vec3 redSoil  = colDirtRgb * vec3(1.06, 0.60, 0.40);
                        float sA = avNoise(gxz * 0.030) * 0.65 + avNoise(gxz * 0.085 + 17.0) * 0.35;
                        groundCol = mix(dryGold, dryPale, smoothstep(0.35, 0.75, sA));
                        // свежая трава в низинах у воды и островками
                        float lowW   = 1.0 - smoothstep(0.25, 0.95, vWorldPosition.y);
                        float patchG = smoothstep(0.64, 0.82, avNoise(gxz * 0.05 + 31.0));
                        groundCol = mix(groundCol, greenG, clamp(lowW * 0.80 + patchG * 0.22, 0.0, 0.85));
                        // проплешины красной земли (больше на склонах)
                        float bare = smoothstep(0.58, 0.80, avNoise(gxz * 0.07 + 9.0) * 0.6 + avNoise(gxz * 0.35) * 0.4 + (1.0 - vWorldNormal.y) * 1.6);
                        groundCol = mix(groundCol, redSoil, bare * 0.60);
                        float sv = avNoise(gxz * 0.017 + 3.0) - 0.5;
                        groundCol *= vec3(1.0 + sv * 0.10, 1.0, 1.0 - sv * 0.14);
                        float aoMulS = 1.0;
                        vec2 aoD0S = gxz - uAO[0].xy;
                        if (uAO[0].z > 0.0 && dot(aoD0S, aoD0S) < 2800.0) {
                            for (int ai = 0; ai < TERRAIN_AO_N; ai++) {
                                vec4 an = uAO[ai];
                                vec2 adVec = gxz - an.xy;
                                float r2 = an.z * an.z;
                                float d2 = dot(adVec, adVec);
                                if (d2 < r2 && r2 > 0.0) {
                                    float ad = sqrt(d2) / an.z;
                                    aoMulS *= 1.0 - an.w * 0.40 * (1.0 - smoothstep(0.15, 1.0, ad));
                                }
                            }
                        }
                        groundCol *= max(aoMulS, 0.6);
                    } else if (uGroundMix > 2.5 && uGroundMix < 3.5) {
                        // === BIOME/GROUND: CAMP (Green grass on clearing where NO forest + forest litter in the woods) ===
                        vec2 gxz = vWorldPosition.xz;
                        // Границы лесного массива на карте лагеря:
                        // Южный лес: Z > 22..44
                        float southF = smoothstep(22.0, 44.0, gxz.y);
                        // Северный берег за рекой: Z < -30..-48
                        float northF = 1.0 - smoothstep(-48.0, -30.0, gxz.y);
                        // Западный лес: X < -24..-46
                        float westF  = 1.0 - smoothstep(-46.0, -24.0, gxz.x);
                        // Восточный лес: X > 24..46
                        float eastF  = smoothstep(24.0, 46.0, gxz.x);
                        float forestFactor = max(max(southF, northF), max(westF, eastF));

                        // Органичный процедурный шум для границы леса и поляны
                        float edgeN = (avNoise(gxz * 0.055) - 0.5) * 0.26 + (avNoise(gxz * 0.16 + 11.0) - 0.5) * 0.12;
                        forestFactor = clamp(forestFactor + edgeN, 0.0, 1.0);
                        float clearingFactor = 1.0 - forestFactor; // 1.0 на полянке без леса, 0.0 в лесу

                        // Слой сочной оливково-зелёной текстурной травы из комбинированного покрытия
                        vec3 gB = texture2D(uGrass2Diff, gxz * 0.16 + vec2(0.13, 0.57)).rgb;
                        gB *= vec3(0.40, 0.48, 0.28); // глубокий природный тон зелёной травы

                        // На полянке без леса — доминирующий красивый травяной покров
                        float grassAmount = clearingFactor * 0.88 + (avNoise(gxz * 0.08 + 3.0) - 0.5) * 0.08 * clearingFactor;
                        grassAmount = clamp(grassAmount, 0.0, 0.90);

                        // Смешивание лесной подстилки с зелёной травой на полянке
                        groundCol = mix(groundCol, gB, grassAmount);

                        // Тени подлеска в глубине леса
                        float under = avNoise(gxz * 0.055 + 41.0) * 0.65 + avNoise(gxz * 0.21) * 0.35;
                        float underM = smoothstep(0.40, 0.82, under) * forestFactor;
                        groundCol *= mix(1.0, 0.65, underM);

                        // Естественная вариация оттенков рельефа
                        float cv = avNoise(gxz * 0.017 + 3.0) - 0.5;
                        groundCol *= vec3(1.0 + cv * 0.08, 1.0, 1.0 - cv * 0.06);
                    } else if (uGroundMix > 0.5) {
                        vec2 gxz = vWorldPosition.xz;
                        float zoneN = avNoise(gxz * 0.030) * 0.65 + avNoise(gxz * 0.083 + 17.0) * 0.35;
                        float grassZone = (uGroundMix > 1.5) ? 0.92 : smoothstep(0.56, 0.82, zoneN) * 0.75;
                        // baseForest (uGroundMix > 3.5): лес/трава по реальным деревьям (маска плотности леса), остальное как у moss2
                        float forestF = 0.0;
                        if (uGroundMix > 3.5) {
                            float fm = texture2D(uForestMap, (gxz - uForestRect.xy) * uForestRect.z).r;
                            forestF = clamp(fm + (avNoise(gxz * 0.16 + 11.0) - 0.5) * 0.22 + (avNoise(gxz * 0.055) - 0.5) * 0.10, 0.0, 1.0);
                            float clearing = 1.0 - forestF;
                            grassZone = clearing * (0.80 + 0.12 * zoneN) + forestF * smoothstep(0.66, 0.86, zoneN) * 0.15;
                        }
                        if (grassZone > 0.003) {
                            vec3 gB = texture2D(uGrass2Diff, gxz * 0.16 + vec2(0.13, 0.57)).rgb;
                            gB *= vec3(0.40, 0.48, 0.28);           // тёмная оливковая трава, детали текстуры сохранены
                            groundCol = mix(groundCol, gB, grassZone);
                        }
                        float under = avNoise(gxz * 0.055 + 41.0) * 0.65 + avNoise(gxz * 0.21) * 0.35;
                        float underM = smoothstep(0.44, 0.80, under);
                        if (uGroundMix > 3.5) underM *= (0.22 + 0.78 * forestF); // подлесок темнее всего там, где лес
                        groundCol *= mix(1.0, 0.62, underM);        // глубокие тени подлеска, детали остаются
                        float cv = avNoise(gxz * 0.017 + 3.0) - 0.5;
                        groundCol *= vec3(1.0 + cv * 0.12, 1.0, 1.0 - cv * 0.10);
                        // мягкое затемнение у оснований деревьев/камней (по рельефу, без резких краёв)
                        float aoMul = 1.0;
                        vec2 aoD0 = gxz - uAO[0].xy;
                        if (uAO[0].z > 0.0 && dot(aoD0, aoD0) < 2800.0) {
                            for (int ai = 0; ai < TERRAIN_AO_N; ai++) {
                                vec4 an = uAO[ai];
                                vec2 adVec = gxz - an.xy;
                                float r2 = an.z * an.z;
                                float d2 = dot(adVec, adVec);
                                if (d2 < r2 && r2 > 0.0) {
                                    float ad = sqrt(d2) / an.z;
                                    aoMul *= 1.0 - an.w * 0.45 * (1.0 - smoothstep(0.15, 1.0, ad));
                                }
                            }
                        }
                        groundCol *= max(aoMul, 0.55);
                    }

                    // Сборка слоя каменной тропы: лесная подстилка -> земляная обочина -> чистая мостовая
                    vec3 pathBlended = mix(groundCol, colDirtRgb, shoulderMask * 0.78);
                    pathBlended = mix(pathBlended, centerPath, stoneMask * 0.96);

                    // Смешивание с грунтовыми тропами (от спавна до лагеря и западной к перевалу)
                    vec3 meadowBase = mix(pathBlended, colDirtRgb, passTrailMask * 0.88);

                    // Скальные уступы на крутых склонах и на высоте горного массива
                    float altitudeRock = smoothstep(2.4, 4.6, vWorldPosition.y);
                    float totalRock = clamp(cliffWeight * 1.5 + altitudeRock * 1.3, 0.0, 1.0);

                    vec3 baseCol = mix(meadowBase, colBeachRgb, shoreWeight);
                    terrainColor = baseCol;

                    vec2 caveDiff = vWorldPosition.xz - uCaveRock.xy;
                    bool nearCave = (uCaveRock.w > 0.001 && dot(caveDiff, caveDiff) < uCaveRock.z * uCaveRock.z);
                    vec2 tintDiff = vWorldPosition.xz - uRockTint.xy;
                    bool nearTint = (uRockTint.w > 0.001 && dot(tintDiff, tintDiff) < uRockTint.z * uRockTint.z);
                    if (totalRock > 0.0005 || nearCave || nearTint) {
                        vec3 rockTex = mix(texture2D(uRockDiff, uvRockMacro).rgb, texture2D(uRockDiff, uvRockMicro).rgb * 1.15, 0.50);
                        // Выразительный скальный микрорельеф на пиках
                        float peakAltitude = smoothstep(3.8, 8.5, vWorldPosition.y);
                        float rockRelief = 0.82 + 0.38 * smoothstep(0.40, 0.95, vWorldNormal.y);
                        vec3 peakRock = rockTex * rockRelief;
                        peakRock = mix(peakRock, pow(peakRock, vec3(1.18)) * 1.12, peakAltitude * 0.80);

                        if (uGroundMix > 4.5) peakRock = mix(peakRock, peakRock * vec3(1.50, 0.90, 0.62), 0.88);   // саванна: рыжий песчаник вместо серых гор
                        terrainColor = mix(baseCol, peakRock, totalRock);
                        terrainColor = pow(terrainColor, vec3(1.05));
                        // Склон вокруг грота: тёмный серо-зелёный камень (под цвет модели), чтобы пещера «росла» из горы
                        if (nearCave) {
                            float cd = sqrt(dot(caveDiff, caveDiff));
                            float ck = (1.0 - smoothstep(uCaveRock.z * 0.35, uCaveRock.z, cd)) * uCaveRock.w;
                            float ch = smoothstep(1.7, 3.0, vWorldPosition.y);
                            float cn = avNoise(vWorldPosition.xz * 0.35) * 0.5 + avNoise(vWorldPosition.xz * 1.1) * 0.5;
                            vec3 caveRock = rockTex * vec3(0.46, 0.47, 0.44) * (0.85 + 0.30 * cn);
                            caveRock = mix(caveRock, caveRock * vec3(0.80, 1.00, 0.70), smoothstep(0.55, 0.85, vWorldNormal.y) * 0.5);
                            terrainColor = mix(terrainColor, caveRock, ck * max(ch, totalRock));
                            // Внутри грота земля не должна просвечивать светлым сквозь щели модели: тёмная заливка по контуру пещеры
                            float inside = (1.0 - smoothstep(2.6, 3.6, abs(caveDiff.y))) * smoothstep(-3.6, -2.4, caveDiff.x) * (1.0 - smoothstep(4.4, 5.6, caveDiff.x));
                            inside *= 1.0 - smoothstep(1.9, 2.7, vWorldPosition.y);   // только низкий пол пещеры, не склон над ней
                            terrainColor *= mix(1.0, 0.10, inside);
                        }
                        // Ущелье-проход: склон горного пояса вокруг него — тёмный серо-зелёный камень под цвет модели скал
                        if (nearTint) {
                            float td = sqrt(dot(tintDiff, tintDiff));
                            float tk = (1.0 - smoothstep(uRockTint.z * 0.35, uRockTint.z, td)) * uRockTint.w;
                            float th = smoothstep(1.2, 2.6, vWorldPosition.y);
                            float tn = avNoise(vWorldPosition.xz * 0.35) * 0.5 + avNoise(vWorldPosition.xz * 1.1) * 0.5;
                            vec3 tRock = rockTex * vec3(0.50, 0.51, 0.47) * (0.85 + 0.30 * tn);
                            tRock = mix(tRock, tRock * vec3(0.80, 1.00, 0.70), smoothstep(0.55, 0.85, vWorldNormal.y) * 0.5);
                            terrainColor = mix(terrainColor, tRock, tk * max(th, totalRock));
                        }
                    } else {
                        terrainColor = pow(terrainColor, vec3(1.05));
                    }
                }

                // Намокание берега у самой кромки воды (влажная темная речная галька и песок)
                float wetBand = 1.0 - smoothstep(0.0, 0.22, abs(vWorldPosition.y - 0.02));
                terrainColor *= mix(1.0, 0.60, wetBand * 0.85);

                // Компенсация яркого освещения сцены (sun 1.45 + hemi 0.85 = 2.30x)
                // Предотвращает выгорание и белёсый засвет земли
                float macroVar = 0.62 + sin(vWorldPosition.x * 0.045) * cos(vWorldPosition.z * 0.045) * 0.05;
                terrainColor *= macroVar;

                diffuseColor = vec4(terrainColor, 1.0);
                `
            );
        };

        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = false;
        if (this.locTerrain.hidden) this.mesh.visible = false;
        this.scene.add(this.mesh);
    }

    /**
     * Текстура расстояний до троп (R — грунтовые, G — каменные; 0..PATH_DIST_MAX м → 0..255), 2 пикселя на метр,
     * только по прямоугольнику вокруг троп. Строится один раз на локацию; шейдер берёт одно чтение вместо цикла
     * по отрезкам в каждом пикселе. Отрезки и ширины — те же, что раньше шли в uniform-массивы, вид не меняется.
     */
    _buildPathDistTexture(dirtSegs, nDirt, stoneSegs, nStone, dirtOff = [], stoneOff = []) {
        if (this._pathTex) return this._pathTex;
        const segs = [];
        for (let i = 0; i < nDirt; i++) segs.push([dirtSegs[i], 0, dirtOff[i] || 0]);
        for (let i = 0; i < nStone; i++) segs.push([stoneSegs[i], 1, stoneOff[i] || 0]);
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        segs.forEach(([v]) => {
            minX = Math.min(minX, v.x, v.z); maxX = Math.max(maxX, v.x, v.z);
            minZ = Math.min(minZ, v.y, v.w); maxZ = Math.max(maxZ, v.y, v.w);
        });
        let W = 1, H = 1, data;
        if (!segs.length) {
            minX = minZ = 0; maxX = maxZ = 1;
            data = new Uint8Array([255, 255, 0, 255]);
        } else {
            const pad = PATH_DIST_MAX + 1;
            minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
            W = Math.min(2048, Math.max(2, Math.ceil((maxX - minX) * PATH_DIST_PX_PER_M)));
            H = Math.min(2048, Math.max(2, Math.ceil((maxZ - minZ) * PATH_DIST_PX_PER_M)));
            data = new Uint8Array(W * H * 4);
            const dist = [new Float32Array(W * H).fill(PATH_DIST_MAX), new Float32Array(W * H).fill(PATH_DIST_MAX)];
            const sx = (maxX - minX) / W, sz = (maxZ - minZ) / H;
            // каждый отрезок обновляет только пиксели в своей рамке ± PATH_DIST_MAX
            segs.forEach(([v, ch, off]) => {
                const ax = v.x, az = v.y, bx = v.z, bz = v.w;
                const abx = bx - ax, abz = bz - az, ab2 = Math.max(abx * abx + abz * abz, 1e-4);
                const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - PATH_DIST_MAX - minX) / sx));
                const i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + PATH_DIST_MAX - minX) / sx));
                const j0 = Math.max(0, Math.floor((Math.min(az, bz) - PATH_DIST_MAX - minZ) / sz));
                const j1 = Math.min(H - 1, Math.ceil((Math.max(az, bz) + PATH_DIST_MAX - minZ) / sz));
                const D = dist[ch];
                for (let j = j0; j <= j1; j++) {
                    const pz = minZ + (j + 0.5) * sz;
                    for (let i = i0; i <= i1; i++) {
                        const px = minX + (i + 0.5) * sx;
                        let t = ((px - ax) * abx + (pz - az) * abz) / ab2;
                        t = t < 0 ? 0 : (t > 1 ? 1 : t);
                        const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
                        const d = Math.sqrt(dx * dx + dz * dz) + off;
                        const k = j * W + i;
                        if (d < D[k]) D[k] = d;
                    }
                }
            });
            for (let k = 0; k < W * H; k++) {
                data[k * 4] = Math.round(Math.min(1, dist[0][k] / PATH_DIST_MAX) * 255);
                data[k * 4 + 1] = Math.round(Math.min(1, dist[1][k] / PATH_DIST_MAX) * 255);
                data[k * 4 + 3] = 255;
            }
        }
        const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        this._pathTex = { texture: tex, rect: new THREE.Vector4(minX, minZ, 1 / (maxX - minX), 1 / (maxZ - minZ)) };
        return this._pathTex;
    }

    // Textures bound via custom uniforms are not reachable from material properties
    dispose() {
        (this.textures || []).forEach(t => t.dispose());
        if (this._pathTex) { this._pathTex.texture.dispose(); this._pathTex = null; }
    }
}

window.LakesideTerrain = LakesideTerrain;
