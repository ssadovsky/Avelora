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
        this.noise = new SimplexNoise(locTerrain.seed !== undefined ? locTerrain.seed : 4242);

        this.mesh = null;
        this.material = null;

        // Скальная «подкраска» склона вокруг грота (vec4: x, z, радиус, сила): гора темнеет и сереет к цвету камней модели
        const _cv = (locTerrain.caves && locTerrain.caves[0]) || null;
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
        const br = this.bridges;
        if (!br || this._rawOnly) return h;
        for (let i = 0; i < br.length; i++) {
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
        return h;
    }

    /**
     * Raw ground height + flat spots (locTerrain.flatSpots: [{x, z, radius, blend}]): inside radius the ground is levelled
     * to the height at the centre, over the next `blend` metres it eases back to the natural relief (smoothstep, no steps).
     * Used for portal pads. Everything (mesh, characters, grass, trees, pathfinding) reads the same function.
     */
    getRawHeightAt(x, z) {
        const h = this._getRawHeightBase(x, z);
        const fs = this.locTerrain.flatSpots;
        if (!fs || !fs.length) return h;
        if (!this._flatH) this._flatH = [];
        let out = h;
        for (let i = 0; i < fs.length; i++) {
            const f = fs[i];
            const bl = (f.blend !== undefined) ? f.blend : 5.0;
            const d = Math.hypot(x - f.x, z - f.z);
            if (d >= f.radius + bl) continue;
            if (this._flatH[i] === undefined) this._flatH[i] = this._getRawHeightBase(f.x, f.z);
            const t = d <= f.radius ? 1.0 : 1.0 - (d - f.radius) / bl;
            const w = t * t * (3.0 - 2.0 * t);
            out += (this._flatH[i] - out) * w;
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

            const distFromEdgeX = this.halfX - Math.abs(x);
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

                let mHeight = smoothFactor * baseHeight + smoothFactor * (crags + microCrags);

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

        // Set heights and analytical continuous normals (eliminates all faceting/squares)
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i);
            const z = posAttr.getZ(i);
            let y = this.getHeightAt(x, z);

            // Perimeter skirt: pull the outermost boundary vertices down below ground (-6m)
            // This forms a solid vertical rock back-wall, eliminating any open cross-section/void
            const atOuterEdge = Math.abs(x) >= (this.halfX - 0.25) || Math.abs(z) >= (this.halfZ - 0.25);
            if (atOuterEdge) {
                y = -6.0;
            }

            posAttr.setY(i, y);

            const n = this.getNormalAt(x, z);
            normAttr.setXYZ(i, n.x, n.y, n.z);
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

        const stoneTrailDiff = texLoader.load(assets.stoneTrailDiff || assets.gravelDiff || assets.beachDiff);
        // groundMode:
        // 0: default single texture
        // 1: 'moss2' (forestEdge: подстилка + пятна травы и темный подлесок)
        // 2: 'grass2' (сплошное тёмное травяное покрытие)
        // 4: 'baseForest' (moss2 как база + лес/трава по реальным деревьям: маска плотности леса uForestMap)
        // 3: 'camp' (homeCamp: сочная зелёная трава на полянке без леса + лесная подстилка в лесу)
        const groundMode = (this.groundSet === 'baseForest') ? 4 : (this.groundSet === 'camp') ? 3 : ((this.groundSet === 'grass2') ? 2 : (this.groundSet === 'moss2' ? 1 : 0));
        const mixGround = groundMode > 0 && !!assets.meadowGrassDiff;
        this.contactAO = []; for (let i = 0; i < 48; i++) this.contactAO.push(new THREE.Vector4(0, 0, 0, 0)); // uAO[48] is declared in every variant: always give it 48 entries (empty array crashes the uniform upload)
        const grass2Diff = mixGround ? texLoader.load(assets.meadowGrassDiff) : grassDiff;
        this.textures = [grassDiff, grassNor, trailDiff, stoneTrailDiff, rockDiff, rockNor, beachDiff, grass2Diff];
        this.textures.forEach(tex => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = 8;
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
        this.material.customProgramCacheKey = () => `lakeside_terrain_${this.biome}_${this.segments}_v22_${this.groundSet}_mix${mixGround ? groundMode : 0}`;

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
            shader.uniforms.uForestRect = this.forestRectUniform;

            const dirtSegs = [];
            const stoneSegs = [];
            let dirtWidth = 2.6;
            let stoneWidth = 2.8;

            (this.paths || []).forEach(pp => {
                const isStone = (pp.type === 'stone');
                const targetSegs = isStone ? stoneSegs : dirtSegs;
                if (isStone) {
                    stoneWidth = pp.width || stoneWidth;
                } else {
                    dirtWidth = pp.width || dirtWidth;
                }
                for (let i = 0; i + 1 < pp.points.length && targetSegs.length < 16; i++) {
                    targetSegs.push(new THREE.Vector4(pp.points[i][0], pp.points[i][1], pp.points[i + 1][0], pp.points[i + 1][1]));
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
                uniform sampler2D uGrassDiff;
                uniform sampler2D uGrass2Diff;
                uniform float uGroundMix;
                uniform vec4 uAO[48];
                uniform sampler2D uForestMap;
                uniform vec4 uCaveRock;
                uniform vec4 uForestRect;
                uniform sampler2D uTrailDiff;
                uniform sampler2D uStoneTrailDiff;
                uniform sampler2D uRockDiff;
                uniform sampler2D uRockNor;
                uniform sampler2D uBeachDiff;
                uniform float uBiome;
                uniform float uWaterType;
                uniform vec4 uDirtSeg[16];
                uniform int uDirtCount;
                uniform float uDirtWidth;
                uniform vec4 uStoneSeg[16];
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

                vec4 colBeach      = texture2D(uBeachDiff, uvShore);
                vec4 colGrass      = texture2D(uGrassDiff, uvGrass);
                vec4 colDirtTrail  = texture2D(uTrailDiff, uvDirtTrail);
                vec4 colStoneTrail = texture2D(uStoneTrailDiff, uvStoneTrail);
                vec4 colRock1      = texture2D(uRockDiff, uvRockMacro);
                vec4 colRock2      = texture2D(uRockDiff, uvRockMicro);
                vec3 rockTex       = mix(colRock1.rgb, colRock2.rgb * 1.15, 0.50);

                // Shore weight:
                // Для открытого моря (uWaterType ~ 1.0): широкий песчаный пляж Y in [0.12, 0.85]
                // Для озера и реки (uWaterType == 0 или 2): трава/подстилка подходят почти до самой воды,
                // открытая влажная галька/песок занимает только узкую полоску у уреза воды
                float shoreWeight;
                if (uWaterType > 0.5 && uWaterType < 1.5) {
                    shoreWeight = 1.0 - smoothstep(0.12, 0.85, vWorldPosition.y);
                } else {
                    float shoreEdgeN = avNoise(vWorldPosition.xz * 0.45) * 0.05;
                    shoreWeight = 1.0 - smoothstep(0.02, 0.20 + shoreEdgeN, vWorldPosition.y);
                }

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

                    vec3 baseCol = mix(colGrass.rgb, colDirtTrail.rgb, roadMask * 0.95);
                    terrainColor = mix(baseCol, colBeach.rgb, shoreWeight);
                    terrainColor = mix(terrainColor, rockTex, cliffWeight * 0.80);
                    terrainColor = pow(terrainColor, vec3(1.10));
                } else if (uBiome > 1.5) {
                    // === BIOME: VOLCANIC (Future Extensibility) ===
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
                    float dirtPathD = 1e5;
                    for (int pi = 0; pi < 16; pi++) {
                        if (pi >= uDirtCount) break;
                        vec2 pa = uDirtSeg[pi].xy, pb = uDirtSeg[pi].zw;
                        vec2 pab = pb - pa;
                        float pt = clamp(dot(vWorldPosition.xz - pa, pab) / max(dot(pab, pab), 1e-4), 0.0, 1.0);
                        dirtPathD = min(dirtPathD, length(vWorldPosition.xz - (pa + pab * pt)));
                    }
                    float dirtEdgeNoise = avNoise(vWorldPosition.xz * 1.3) * 0.35 + sin(vWorldPosition.x * 0.8 + vWorldPosition.z * 0.7) * 0.18;
                    float dirtHalfW = (uDirtWidth * 0.5) + dirtEdgeNoise;
                    float dirtMask = (uDirtCount > 0) ? 1.0 - smoothstep(dirtHalfW - 0.45, dirtHalfW + 0.55, dirtPathD) : 0.0;
                    passTrailMask = max(passTrailMask, dirtMask * 0.95 / 0.88);

                    // 3) Каменная тропа от водопада (120, 4) до озера в центре (-18, -16) (uStoneSeg)
                    float stonePathD = 1e5;
                    for (int pi = 0; pi < 16; pi++) {
                        if (pi >= uStoneCount) break;
                        vec2 pa = uStoneSeg[pi].xy, pb = uStoneSeg[pi].zw;
                        vec2 pab = pb - pa;
                        float pt = clamp(dot(vWorldPosition.xz - pa, pab) / max(dot(pab, pab), 1e-4), 0.0, 1.0);
                        stonePathD = min(stonePathD, length(vWorldPosition.xz - (pa + pab * pt)));
                    }

                    // Живой непрямой край каменной тропы
                    float stoneEdgeNoise = avNoise(vWorldPosition.xz * 1.4) * 0.42 + sin(vWorldPosition.x * 0.85 + vWorldPosition.z * 0.65) * 0.24;
                    float stoneHalfW = (uStoneWidth * 0.5) + stoneEdgeNoise;

                    // Центр — старинная каменная брусчатка
                    float stoneMask = (uStoneCount > 0) ? 1.0 - smoothstep(stoneHalfW * 0.55, stoneHalfW + 0.35, stonePathD) : 0.0;
                    // Обочина каменной дороги — земляная вытоптанная полоса
                    float shoulderMask = (uStoneCount > 0) ? 1.0 - smoothstep(stoneHalfW + 0.25, stoneHalfW + 1.25, stonePathD) : 0.0;

                    // Центр — старинная каменная мостовая Poly Haven (без шахматных узоров)
                    vec3 centerPath = colStoneTrail.rgb;

                    // Смешивание слоев покрытия:
                    // 1) Для 'camp' (uGroundMix > 2.5): сочная зелёная трава на полянке (где нет леса) + лесная подстилка в лесу
                    // 2) Для 'moss2' (uGroundMix > 0.5): оригинальная лесная подстилка + пятна травы и подлесок
                    vec3 groundCol = colGrass.rgb;
                    if (uGroundMix > 2.5 && uGroundMix < 3.5) {
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
                        for (int ai = 0; ai < 48; ai++) {
                            vec4 an = uAO[ai];
                            if (an.z > 0.0) {
                                float ad = length(gxz - an.xy) / an.z;
                                aoMul *= 1.0 - an.w * 0.45 * (1.0 - smoothstep(0.15, 1.0, ad));
                            }
                        }
                        groundCol *= max(aoMul, 0.55);
                    }

                    // Сборка слоя каменной тропы: лесная подстилка -> земляная обочина -> чистая мостовая
                    vec3 pathBlended = mix(groundCol, colDirtTrail.rgb, shoulderMask * 0.78);
                    pathBlended = mix(pathBlended, centerPath, stoneMask * 0.96);

                    // Смешивание с грунтовыми тропами (от спавна до лагеря и западной к перевалу)
                    vec3 meadowBase = mix(pathBlended, colDirtTrail.rgb, passTrailMask * 0.88);

                    // Скальные уступы на крутых склонах и на высоте горного массива
                    float altitudeRock = smoothstep(2.4, 4.6, vWorldPosition.y);
                    float totalRock = clamp(cliffWeight * 1.5 + altitudeRock * 1.3, 0.0, 1.0);

                    // Выразительный скальный микрорельеф на пиках
                    float peakAltitude = smoothstep(3.8, 8.5, vWorldPosition.y);
                    float rockRelief = 0.82 + 0.38 * smoothstep(0.40, 0.95, vWorldNormal.y);
                    vec3 peakRock = rockTex * rockRelief;
                    peakRock = mix(peakRock, pow(peakRock, vec3(1.18)) * 1.12, peakAltitude * 0.80);

                    vec3 baseCol = mix(meadowBase, colBeach.rgb, shoreWeight);
                    terrainColor = mix(baseCol, peakRock, totalRock);
                    terrainColor = pow(terrainColor, vec3(1.05));
                    // Склон вокруг грота: тёмный серо-зелёный камень (под цвет модели), чтобы пещера «росла» из горы
                    if (uCaveRock.w > 0.001) {
                        float cd = length(vWorldPosition.xz - uCaveRock.xy);
                        float ck = (1.0 - smoothstep(uCaveRock.z * 0.35, uCaveRock.z, cd)) * uCaveRock.w;
                        float ch = smoothstep(1.7, 3.0, vWorldPosition.y);
                        float cn = avNoise(vWorldPosition.xz * 0.35) * 0.5 + avNoise(vWorldPosition.xz * 1.1) * 0.5;
                        vec3 caveRock = rockTex * vec3(0.46, 0.47, 0.44) * (0.85 + 0.30 * cn);
                        caveRock = mix(caveRock, caveRock * vec3(0.80, 1.00, 0.70), smoothstep(0.55, 0.85, vWorldNormal.y) * 0.5);
                        terrainColor = mix(terrainColor, caveRock, ck * max(ch, totalRock));
                        // Внутри грота земля не должна просвечивать светлым сквозь щели модели: тёмная заливка по контуру пещеры
                        vec2 cin = vWorldPosition.xz - uCaveRock.xy;
                        float inside = (1.0 - smoothstep(2.6, 3.6, abs(cin.y))) * smoothstep(-3.6, -2.4, cin.x) * (1.0 - smoothstep(4.4, 5.6, cin.x));
                        inside *= 1.0 - smoothstep(1.9, 2.7, vWorldPosition.y);   // только низкий пол пещеры, не склон над ней
                        terrainColor *= mix(1.0, 0.10, inside);
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

    // Textures bound via custom uniforms are not reachable from material properties
    dispose() {
        (this.textures || []).forEach(t => t.dispose());
    }
}

window.LakesideTerrain = LakesideTerrain;
