/**
 * Lakeside Environment: Modular Scene Population from world_data.js
 * Renders Trees, Boulders, Shrubs, Ferns, Dandelions, Reeds and Grass.
 *
 * - Objects come from `expandLocationObjects()` (location_groups.js): hand-placed
 *   `decorations` + generated `groups` (forest, reeds, rocks, meadow).
 * - Every object has its own id -> `this.objects.get(id)` (for future interaction).
 * - All kinds are drawn with THREE.InstancedMesh, split into ~20 m spatial chunks so
 *   that off-screen chunks are frustum-culled. three.js r128 creates InstancedMesh with
 *   frustumCulled = false (its bounding sphere ignores instances), so every chunk gets its
 *   own bounding sphere covering all its instances and culling is switched back on.
 * - Everything is added to `root` (a THREE.Group owned by the current location) and is
 *   released with `dispose()` on location change.
 */
const ENV_CHUNK_SIZE = 20; // meters
// V0.3: множители радиуса куллинга чанков (GFX.grassRadius * mul)
const CULL_INNER_MUL = { dandelions_lod: 0.45 };
const CULL_RADIUS_MUL = { grass: 1.0, dandelions: 0.45, dandelions_lod: 1.0, ferns: 1.3, reeds: 1.5, shrubs: 1.8 };
const CULL_CHUNK_HALF_DIAG = ENV_CHUNK_SIZE * 0.7071; // расстояние от центра до угла чанка

// Decoded GLB buffers are cached between locations (atob of multi-MB strings is slow)
const GLB_BUFFER_CACHE = {};

// Readable names for the hover tooltip (main.js). Only kinds listed in
// HOVER_KINDS are actually raycast-able — dandelions/grass are dense
// filler and would make hovering noisy, so they're left out on purpose.
// Ferns ARE included: in this asset set they're large multi-frond clusters
// (not small ground filler), placed sparsely enough to be a real object.
const KIND_LABELS = {
    trees: 'Дерево', boulders: 'Камень', shrubs: 'Куст', reeds: 'Камыш',
    ferns: 'Папоротник', dandelions: 'Одуванчик', grass: 'Трава',
    ores: 'Замшелый валун'
};
// Кусты, камыш и декоративные камни являются фоновыми декорациями (без всплывающих подсказок и перехвата кликов)
const HOVER_KINDS = new Set(['trees', 'boulders', 'ferns', 'ores']);
const PROXY_HOVER_KINDS = new Set(['trees', 'ferns', 'ores']);

// object.visible stays true so the raycaster tests it; material.visible=false
// keeps it out of the render list. Sizes are in local/unscaled units — the
// object's own `s` scale is applied on top via the normal placement matrix.
const HOVER_PROXY_SIZE = {
    trees: { radiusBottom: 0.7, radiusTop: 1.35, height: 3.4 },
    ferns: { radiusBottom: 0.45, radiusTop: 0.4, height: 0.55 },
    ores:  { radiusBottom: 1.6, radiusTop: 1.3, height: 1.6 } // модель rock_moss ~2.4 x 1.5, на тропе масштаб ~0.27
};

class LakesideEnvironment {
    constructor(root, terrain, pathfinder, location) {
        this.root = root;
        this.scene = root; // backwards-compatible name
        this.terrain = terrain;
        this.pathfinder = pathfinder;
        this.location = location || window.CURRENT_LOCATION || {};

        this.loader = new THREE.GLTFLoader();
        this.texLoader = new THREE.TextureLoader();
        this.windUniform = { value: 0 };

        // id -> { id, kind, group, x, z, s, r, label, parts: [{ mesh, index, matrix }] }
        this.objects = new Map();
        this.pending = [];
        // Bumped whenever an object is hidden/shown (skills.js re-reads its
        // projectile blocker cache; felled trees stop blocking Spark).
        this.version = 0;

        // InstancedMeshes whose kind is in HOVER_KINDS — main.js raycasts only
        // against these for the hover tooltip (not grass/ferns/dandelions).
        // These are invisible generous proxy meshes, not the visible foliage
        // meshes (see HOVER_PROXY_SIZE above). Cached per-kind for this location
        // only (a fresh LakesideEnvironment is created per location, so this
        // never outlives the geometries' owning location / risks a stale
        // reference after teardownLocation() disposes them).
        this.hoverMeshes = [];
        this.cullMeshes = [];      // V0.3: чанки мелкой растительности (GFX.grassRadius)
        this.shadowMeshes = [];    // V4.5: тени деревьев по радиусу (GFX.treeShadowR)
        this._cullT = 1;
        this._hoverProxyGeoCache = {};

        this.lists = window.expandLocationObjects
            ? window.expandLocationObjects(this.location, this.terrain)
            : (this.location.decorations || {});

        this.init();

        // Resolves when every model/texture of this location is parsed and in the scene
        this.ready = Promise.all(this.pending).then(() => undefined);
    }

    // ---------------------------------------------------------------
    // Asset helpers
    // ---------------------------------------------------------------
    static getModelBuffer(key) {
        if (GLB_BUFFER_CACHE[key]) return GLB_BUFFER_CACHE[key];
        const b64 = (window.GAME_ASSETS && window.GAME_ASSETS.models && window.GAME_ASSETS.models[key])
            || (window.GAME_CONTENT && window.GAME_CONTENT.models && window.GAME_CONTENT.models[key]);
        if (!b64) return null;
        const binaryString = window.atob(b64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
        GLB_BUFFER_CACHE[key] = bytes.buffer;
        return bytes.buffer;
    }

    // Kept for compatibility with older code
    base64ToArrayBuffer(base64) {
        const binaryString = window.atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        return bytes.buffer;
    }

    loadModel(key, onLoaded) {
        const buffer = LakesideEnvironment.getModelBuffer(key);
        if (!buffer) return;
        const p = new Promise((resolve) => {
            this.loader.parse(buffer, '', (gltf) => {
                if (this.disposed) { resolve(); return; }
                try { onLoaded(gltf); } catch (err) { console.error(`[Avelora] model "${key}"`, err); }
                resolve();
            }, (err) => {
                console.error(`[Avelora] failed to parse model "${key}"`, err);
                resolve();
            });
        });
        this.pending.push(p);
    }

    loadTexture(key) {
        let resolveFn;
        this.pending.push(new Promise(r => { resolveFn = r; }));
        return this.texLoader.load(window.GAME_ASSETS.textures[key], () => resolveFn(), undefined, () => resolveFn());
    }

    getDecorations(key) {
        return (this.lists && this.lists[key]) || [];
    }

    // ---------------------------------------------------------------
    // Chunked instancing
    // ---------------------------------------------------------------
    /**
     * @param kind   'trees' | 'boulders' | ...
     * @param parts  [{ geometry, material, nodeMatrix? }] — one InstancedMesh per part per chunk
     * @param items  objects with {id, x, z, ...}
     * @param placeFn (item, idx, dummy:Object3D) => void — sets world transform of the item
     * @param opts   { castShadow, receiveShadow }
     */
    buildInstanced(kind, parts, items, placeFn, opts = {}) {
        if (!items.length || !parts.length) return;

        // Group items by chunk
        const chunks = new Map();
        items.forEach((item, idx) => {
            const cx = Math.floor(item.x / ENV_CHUNK_SIZE);
            const cz = Math.floor(item.z / ENV_CHUNK_SIZE);
            const key = `${cx}:${cz}`;
            if (!chunks.has(key)) {
                chunks.set(key, { ox: (cx + 0.5) * ENV_CHUNK_SIZE, oz: (cz + 0.5) * ENV_CHUNK_SIZE, list: [] });
            }
            chunks.get(key).list.push({ item, idx });
        });

        const dummy = new THREE.Object3D();
        const placeMatrix = new THREE.Matrix4();
        const offset = new THREE.Matrix4();
        const m = new THREE.Matrix4();
        const sphere = new THREE.Sphere();
        const box = new THREE.Box3();

        parts.forEach(part => {
            if (!part.geometry.boundingSphere) part.geometry.computeBoundingSphere();
        });

        chunks.forEach(chunk => {
            offset.makeTranslation(-chunk.ox, 0, -chunk.oz);

            parts.forEach(part => {
                // Lightweight geometry wrapper: shares GPU buffers, own bounding sphere per chunk
                const geo = new THREE.BufferGeometry();
                geo.setIndex(part.geometry.index);
                Object.keys(part.geometry.attributes).forEach(k => geo.setAttribute(k, part.geometry.attributes[k]));
                geo.groups = part.geometry.groups;

                const mesh = new THREE.InstancedMesh(geo, part.material, chunk.list.length);
                mesh.frustumCulled = true; // r128 default is false for InstancedMesh
                mesh.castShadow = opts.castShadow !== false;
                mesh.receiveShadow = opts.receiveShadow !== false;
                // opts.reflect === false: keep this kind OFF the water reflection
                // render. Water.js's mirror camera (lib_js/Water.js) is a bare
                // THREE.PerspectiveCamera with the THREE.Layers default (layer 0
                // only) and we never touch it — so moving a mesh onto layer 1
                // ONLY (not 0) makes the reflection pass skip it for free,
                // without editing vendor code. The main game camera and the
                // hover raycaster both explicitly enable layer 1 too (see
                // main.js), so normal viewing/hovering is unaffected — only the
                // mirror camera doesn't see it. Used for dense, low-value-in-a-
                // wavy-reflection foliage (reeds/grass/ferns/dandelions): it's
                // most of the instance count in a water-heavy location like
                // lakeLand, and doubling that many alpha-cutout draws just for a
                // barely-visible distorted reflection isn't worth the cost.
                if (opts.reflect === false) {
                    mesh.layers.set(1);
                }
                mesh.position.set(chunk.ox, 0, chunk.oz);
                mesh.userData.kind = kind;
                mesh.userData.instanceIds = [];
                if (kind === 'trees' && mesh.castShadow) this.shadowMeshes.push({ mesh, x: chunk.ox, z: chunk.oz });
                if (CULL_RADIUS_MUL[kind]) this.cullMeshes.push({ mesh, x: chunk.ox, z: chunk.oz, mul: CULL_RADIUS_MUL[kind], inner: CULL_INNER_MUL[kind] || 0 });
                if (HOVER_KINDS.has(kind) && !PROXY_HOVER_KINDS.has(kind) && !opts.noHover) {
                    mesh.userData.hoverable = true;
                    this.hoverMeshes.push(mesh);
                }

                box.makeEmpty();
                chunk.list.forEach(({ item, idx }, i) => {
                    dummy.position.set(0, 0, 0);
                    dummy.rotation.set(0, 0, 0);
                    dummy.scale.set(1, 1, 1);
                    placeFn(item, idx, dummy);
                    dummy.updateMatrix();

                    placeMatrix.copy(dummy.matrix);
                    if (part.nodeMatrix) placeMatrix.multiply(part.nodeMatrix);
                    m.multiplyMatrices(offset, placeMatrix);
                    mesh.setMatrixAt(i, m);

                    sphere.copy(part.geometry.boundingSphere).applyMatrix4(m);
                    box.expandByPoint(sphere.center.clone().addScalar(sphere.radius));
                    box.expandByPoint(sphere.center.clone().subScalar(sphere.radius));

                    mesh.userData.instanceIds.push(item.id);
                    this.registerPart(kind, item, mesh, i, m);
                });

                geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
                geo.boundingBox = box.clone();
                mesh.instanceMatrix.needsUpdate = true;
                this.root.add(mesh);
            });

            // Invisible generous hit-proxy for the hover tooltip (main.js) — see
            // HOVER_PROXY_SIZE above for why this doesn't reuse the visible mesh.
            if (PROXY_HOVER_KINDS.has(kind) && !opts.noHover) {
                const proxyGeo = this.getHoverProxyGeometry(kind);
                const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
                const proxyMesh = new THREE.InstancedMesh(proxyGeo, proxyMat, chunk.list.length);
                proxyMesh.visible = true; // stays raycast-able; proxyMat.visible=false keeps it out of the render list
                proxyMesh.frustumCulled = false; // never rendered, so no culling bookkeeping needed
                proxyMesh.position.set(chunk.ox, 0, chunk.oz);
                proxyMesh.userData.kind = kind;
                proxyMesh.userData.instanceIds = [];
                proxyMesh.userData.hoverProxy = true;

                chunk.list.forEach(({ item, idx }, i) => {
                    dummy.position.set(0, 0, 0);
                    dummy.rotation.set(0, 0, 0);
                    dummy.scale.set(1, 1, 1);
                    placeFn(item, idx, dummy);
                    dummy.updateMatrix();

                    m.multiplyMatrices(offset, dummy.matrix);
                    proxyMesh.setMatrixAt(i, m);
                    proxyMesh.userData.instanceIds.push(item.id);
                    this.registerPart(kind, item, proxyMesh, i, m);
                });

                proxyMesh.instanceMatrix.needsUpdate = true;
                this.hoverMeshes.push(proxyMesh);
                this.root.add(proxyMesh);
                if (window.AveloraHitDebug) window.AveloraHitDebug.attachInstanced(proxyMesh, kind === 'trees' ? 'tree' : kind === 'ferns' ? 'fern' : 'ore', this.root);
            }
        });
    }

    /** Cached per-location (see this._hoverProxyGeoCache in the constructor). */
    getHoverProxyGeometry(kind) {
        if (this._hoverProxyGeoCache[kind]) return this._hoverProxyGeoCache[kind];
        const H = window.AVELORA_HIT || {};
        const cfg = (kind === 'trees' && H.tree) || (kind === 'ferns' && H.fern) || HOVER_PROXY_SIZE[kind] || { radiusBottom: 0.8, radiusTop: 0.8, height: 1.5 };
        const geo = new THREE.CylinderGeometry(cfg.radiusTop, cfg.radiusBottom, cfg.height, 8, 1);
        geo.translate(0, cfg.height / 2, 0); // base at local y=0, matching item placement (ground point)
        geo.computeBoundingSphere();
        this._hoverProxyGeoCache[kind] = geo;
        return geo;
    }

    registerPart(kind, item, mesh, index, matrix) {
        let entry = this.objects.get(item.id);
        if (!entry) {
            entry = {
                id: item.id, kind, group: item.group || null,
                x: item.x, z: item.z, s: item.s, r: item.r,
                label: KIND_LABELS[kind] || kind,
                visible: true, parts: []
            };
            this.objects.set(item.id, entry);
        }
        entry.parts.push({ mesh, index, matrix: matrix.clone() });
    }

    /** Hide/show a single object (e.g. a chopped tree) without touching its neighbours. */
    setObjectVisible(id, visible) {
        const entry = this.objects.get(id);
        if (!entry || entry.visible === visible) return;
        const zero = new THREE.Matrix4().makeScale(0, 0, 0);
        entry.parts.forEach(p => {
            p.mesh.setMatrixAt(p.index, visible ? p.matrix : zero);
            p.mesh.instanceMatrix.needsUpdate = true;
        });
        entry.visible = visible;
        this.version++;
    }

    /**
     * Temporarily transforms one (visible) object: `worldPre` is a WORLD-space
     * matrix applied on top of its placement (e.g. a small rotation about the
     * trunk base for a hit shake, or a scale about the base while regrowing);
     * null restores the original placement. Allocation-free (harvest.js calls
     * it every frame of a shake).
     */
    setObjectTransform(id, worldPre) {
        const entry = this.objects.get(id);
        if (!entry || !entry.visible) return;
        const m = LakesideEnvironment._m1, t = LakesideEnvironment._m2;
        entry.parts.forEach(p => {
            if (!worldPre) {
                p.mesh.setMatrixAt(p.index, p.matrix);
            } else {
                // chunk-local = T(-chunk) * pre * T(chunk) * placement
                const o = p.mesh.position;
                t.makeTranslation(o.x, o.y, o.z);
                m.multiplyMatrices(t, p.matrix);
                m.premultiply(worldPre);
                t.makeTranslation(-o.x, -o.y, -o.z);
                m.premultiply(t);
                p.mesh.setMatrixAt(p.index, m);
            }
            p.mesh.instanceMatrix.needsUpdate = true;
        });
    }

    getObjectsByGroup(groupId) {
        return Array.from(this.objects.values()).filter(o => o.group === groupId);
    }

    // ---------------------------------------------------------------
    // Population
    // ---------------------------------------------------------------
    init() {
        this.loadBoulders();
        this.loadRealisticTrees();
        this.loadOres();
        this.loadShrubs();
        this.loadBranches();
        this.loadFerns();
        this.loadFlowers();
        this.loadGrass();
        this.createAlphaCutoutReeds();
    }

    loadRealisticTrees() {
        const treePositions = this.getDecorations('trees');
        if (treePositions.length === 0) return;

        // Group placements by treeType: 'tree' (beech), 'fir'/'fir_a'/'fir_b'/'fir_c' (spruce/fir variants), 'small' (young tree), 'quiver' (palm)
        const treeGroups = {
            tree: [],
            fir: [],
            fir_a: [],
            fir_b: [],
            fir_c: [],
            small: [],
            quiver: []
        };
        treePositions.forEach(p => {
            const t = p.treeType || 'tree';
            if (treeGroups[t]) treeGroups[t].push(p);
            else treeGroups.tree.push(p);
        });

        const typeModelMap = {
            tree: 'tree',
            fir: 'fir_tree',
            fir_a: 'fir_tree_a',
            fir_b: 'fir_tree_b',
            fir_c: 'fir_tree_c',
            small: 'tree_small',
            quiver: 'quiver_tree'
        };

        const defaultScales = {
            tree: 3.0,      // буков 3
            fir: 0.9,
            fir_a: 0.9,
            fir_b: 0.9,
            fir_c: 0.9,
            small: 2.0,    // молодых деревьев до 2
            quiver: 4.8
        };

        Object.keys(treeGroups).forEach(typeKey => {
            const list = treeGroups[typeKey];
            if (!list.length) return;
            const modelKey = typeModelMap[typeKey] || 'tree';
            const baseScale = defaultScales[typeKey] || 1.0;

            this.loadModel(modelKey, (gltf) => {
                const treeScene = gltf.scene;
                treeScene.updateMatrixWorld(true);

                const parts = [];
                treeScene.traverse(c => {
                    if (!c.isMesh) return;
                    if (c.material) {
                        c.material.side = THREE.DoubleSide;
                        const mName = (c.material.name || '').toLowerCase();
                        if (mName.includes('tree_1') || mName.includes('twig') || mName.includes('leaves') || mName.includes('needle')) {
                            c.material.transparent = false;
                            c.material.alphaTest = 0.22;
                            c.material.alphaToCoverage = true;
                            c.material.depthWrite = true;
                        }
                    }
                    parts.push({ geometry: c.geometry, material: c.material, nodeMatrix: c.matrixWorld.clone() });
                });

                // Некоторые GLB (fir_tree, fir_tree_b, fir_tree_c) имеют ствол не в начале координат (смещение 5–10 ед.):
                // дерево стояло в стороне от точки размещения (и хитбокса/препятствия) и «левитировало» на другой высоте рельефа.
                // Центрируем ствол по XZ: берём самую низкую по высоте часть (основание ствола).
                {
                    let base = null, baseTop = Infinity;
                    const bb = new THREE.Box3();
                    parts.forEach(pt => {
                        if (!pt.geometry.boundingBox) pt.geometry.computeBoundingBox();
                        bb.copy(pt.geometry.boundingBox).applyMatrix4(pt.nodeMatrix);
                        if (bb.max.y < baseTop) { baseTop = bb.max.y; base = bb.clone(); }
                    });
                    if (base) {
                        const cx = (base.min.x + base.max.x) / 2, cz = (base.min.z + base.max.z) / 2;
                        if (Math.abs(cx) > 0.3 || Math.abs(cz) > 0.3) {
                            const shift = new THREE.Matrix4().makeTranslation(-cx, 0, -cz);
                            parts.forEach(pt => { pt.nodeMatrix = shift.clone().multiply(pt.nodeMatrix); });
                        }
                    }
                }

                this.buildInstanced('trees', parts, list, (p, idx, d) => {
                    const gy = this.terrain.getHeightAt(p.x, p.z);
                    const scale = (p.s || 1.0) * baseScale;
                    d.position.set(p.x, gy - 0.05, p.z);
                    d.rotation.y = (p.r !== undefined) ? p.r : 0;
                    d.scale.set(scale, scale, scale);
                });

                // Trunk obstacle centered strictly at (p.x, p.z) with comfortable walking clearance
                list.forEach(p => {
                    const r = p.obstacle || (typeKey === 'quiver' ? 0.75 : (typeKey.startsWith('fir') ? 0.6 : 0.22));
                    this.pathfinder.addObstacle(p.x, p.z, r * (p.s || 1.0));
                });
            });
        });
    }

    loadOres() {
        const orePlacements = this.getDecorations('ores');
        if (orePlacements.length === 0) return;

        this.loadModel('rock_moss', (gltf) => {
            const meshes = [];
            gltf.scene.traverse(o => {
                if (o.isMesh) meshes.push(o);
            });
            if (meshes.length === 0) return;
            meshes.sort((a, b) => a.name.localeCompare(b.name));

            // Group placements by rock model index (0..5)
            const groups = new Map();
            orePlacements.forEach((p, idx) => {
                const mIdx = (p.modelIndex !== undefined ? p.modelIndex : idx) % meshes.length;
                if (!groups.has(mIdx)) groups.set(mIdx, []);
                groups.get(mIdx).push(p);
            });

            // Два вида камней: рудные (вдоль тропы, крупнее, добываются киркой) и декоративные (p.decor — мельче, без взаимодействия).
            groups.forEach((all, mIdx) => {
                const sourceMesh = meshes[mIdx] || meshes[0];
                const place = (p, idx, d) => {
                    const groundY = this.terrain.getHeightAt(p.x, p.z);
                    const scale = p.s || 1.0;
                    d.position.set(p.x, groundY, p.z);
                    d.rotation.set(0, p.r !== undefined ? p.r : 0, 0);
                    d.scale.set(scale, scale, scale);
                };
                const part = [{ geometry: sourceMesh.geometry, material: sourceMesh.material }];
                const mineable = all.filter(p => !p.decor), decor = all.filter(p => p.decor);
                if (mineable.length) this.buildInstanced('ores', part, mineable, place);
                if (decor.length) this.buildInstanced('ores', part, decor, place, { noHover: true });
            });

            // Декоративные замшелые камни (ores) не блокируют путь — персонаж свободно перешагивает через них
        });
    }

    loadBoulders() {
        const boulderPlacements = this.getDecorations('boulders');
        if (boulderPlacements.length === 0) return;

        this.loadModel('boulder', (gltf) => {
            const boulderMesh = gltf.scene.children[0];
            if (!boulderMesh) return;

            this.buildInstanced('boulders', [{ geometry: boulderMesh.geometry, material: boulderMesh.material }],
                boulderPlacements, (p, idx, d) => {
                    const groundY = this.terrain.getHeightAt(p.x, p.z);
                    const scale = p.s || 1.8;
                    d.position.set(p.x, groundY - 0.25 * scale, p.z);
                    d.rotation.set(0.08 * Math.sin(idx), (p.r !== undefined) ? p.r : 0, 0.08 * Math.cos(idx));
                    d.scale.set(scale, scale * 0.9, scale);
                });

            // Препятствием являются только огромные скальные валуны (масштаб >= 2.0)
            boulderPlacements.forEach(p => {
                if ((p.s || 1.8) >= 2.0 && !p.noObstacle) {
                    this.pathfinder.addObstacle(p.x, p.z, (p.s || 1.8) * 0.9);
                }
            });
        });
    }

    loadShrubs() {
        const shrubSpots = this.getDecorations('shrubs');
        if (shrubSpots.length === 0) return;

        // 4 одиночных естественных куста из shrub_01 (первые 2 густые, последние 2 легкие/компактные)
        const shrubTypes = ['shrub_a', 'shrub_b', 'shrub_c', 'shrub_d'];
        const shrubGroups = {
            shrub_a: [],
            shrub_b: [],
            shrub_c: [],
            shrub_d: []
        };

        const defaultScales = {
            shrub_a: 1.9,
            shrub_b: 1.85,
            shrub_c: 1.95,
            shrub_d: 1.9
        };

        shrubSpots.forEach((sp, idx) => {
            let t = sp.shrubType || shrubTypes[idx % shrubTypes.length];
            if (t === 'shrub' || !shrubGroups[t]) t = 'shrub_a';
            shrubGroups[t].push(sp);
        });

        Object.keys(shrubGroups).forEach(typeKey => {
            const list = shrubGroups[typeKey];
            if (!list.length) return;
            const baseScale = defaultScales[typeKey] || 1.9;

            this.loadModel(typeKey, (gltf) => {
                let shrubMesh = null;
                gltf.scene.traverse(c => {
                    if (c.isMesh && !shrubMesh) shrubMesh = c;
                });
                if (!shrubMesh) return;

                if (shrubMesh.material) {
                    shrubMesh.material.side = THREE.DoubleSide;
                    shrubMesh.material.alphaTest = 0.38;
                    shrubMesh.material.depthWrite = true;
                }

                this.buildInstanced(`shrubs_${typeKey}`, [{ geometry: shrubMesh.geometry, material: shrubMesh.material }],
                    list, (sp, idx, d) => {
                        const gy = this.terrain.getHeightAt(sp.x, sp.z);
                        const scale = (sp.s && sp.s >= 1.5) ? sp.s : baseScale;
                        d.position.set(sp.x, gy - 0.02, sp.z);
                        const rotY = (sp.r !== undefined) ? sp.r : ((idx * 1.618) % (Math.PI * 2));
                        d.rotation.set(0, rotY, 0);
                        d.scale.set(scale, scale, scale);
                    }, { castShadow: false, reflect: false });
            });
        });
    }

    loadBranches() {
        const branchSpots = this.getDecorations('branches');
        if (!branchSpots || branchSpots.length === 0) return;

        this.loadModel('items/branch', (gltf) => {
            const variants = [];
            gltf.scene.traverse(c => {
                if (c.isMesh) {
                    if (c.material) {
                        c.material.roughness = 0.92;
                        c.material.metalness = 0.0;
                    }
                    const geo = c.geometry.clone();
                    geo.computeBoundingBox();
                    const bb = geo.boundingBox;
                    const cx = (bb.min.x + bb.max.x) * 0.5;
                    const cz = (bb.min.z + bb.max.z) * 0.5;
                    const minY = bb.min.y;
                    geo.translate(-cx, -minY, -cz);
                    variants.push({ geometry: geo, material: c.material });
                }
            });
            if (!variants.length) return;

            variants.forEach((v, vIdx) => {
                const subList = branchSpots.filter((_, idx) => (idx % variants.length) === vIdx);
                if (!subList.length) return;

                this.buildInstanced(`branches_v${vIdx}`, [v], subList, (sp, idx, d) => {
                    const gy = this.terrain.getHeightAt(sp.x, sp.z);
                    const scale = (sp.s || 1.0) * 2.2;
                    d.position.set(sp.x, gy + 0.03, sp.z);
                    const rotY = (sp.r !== undefined) ? sp.r : (idx * 1.73);
                    d.rotation.set(0, rotY, 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: true, reflect: false });
            });
        });
    }

    loadFerns() {
        const fernPlacements = this.getDecorations('ferns');
        if (fernPlacements.length === 0) return;

        this.loadModel('fern', (gltf) => {
            let fernMesh = null;
            gltf.scene.traverse(c => {
                if (c.isMesh && (!fernMesh || c.geometry.attributes.position.count > fernMesh.geometry.attributes.position.count)) {
                    fernMesh = c;
                }
            });
            if (!fernMesh) return;

            const fernMat = fernMesh.material.clone();
            fernMat.transparent = true;
            fernMat.alphaTest = 0.45;
            fernMat.side = THREE.DoubleSide;

            this.buildInstanced('ferns', [{ geometry: fernMesh.geometry, material: fernMat }],
                fernPlacements, (p, idx, d) => {
                    const gy = this.terrain.getHeightAt(p.x, p.z);
                    const scale = p.s || 3.0;
                    d.position.set(p.x, gy - 0.05, p.z);
                    d.rotation.set(0, (p.r !== undefined) ? p.r : 0, 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: false, reflect: false });
        });
    }

    loadFlowers() {
        const flowerPlacements = this.getDecorations('flowers');
        if (!flowerPlacements || flowerPlacements.length === 0) return;

        const redList = [];
        const cloverList = [];
        const yellowList = [];
        flowerPlacements.forEach((p, idx) => {
            if (p.flowerType === 'yellow') {
                yellowList.push(p);
            } else if (p.flowerType === 'clover') {
                cloverList.push(p);
            } else if (p.flowerType === 'red') {
                redList.push(p);
            } else {
                const mod = idx % 3;
                if (mod === 0) redList.push(p);
                else if (mod === 1) cloverList.push(p);
                else yellowList.push(p);
            }
        });

        const loadFlowerType = (modelKey, list, baseScale) => {
            if (!list.length) return;
            this.loadModel(modelKey, (gltf) => {
                let mesh = null;
                gltf.scene.traverse(c => { if (c.isMesh && !mesh) mesh = c; });
                if (!mesh) return;

                if (mesh.material) {
                    mesh.material.side = THREE.DoubleSide;
                    mesh.material.alphaTest = 0.40;
                    mesh.material.depthWrite = true;
                }

                this.buildInstanced(`flowers_${modelKey}`, [{ geometry: mesh.geometry, material: mesh.material }],
                    list, (p, idx, d) => {
                        const gy = this.terrain.getHeightAt(p.x, p.z);
                        const scale = (p.s || 1.0) * baseScale;
                        d.position.set(p.x, gy, p.z);
                        d.rotation.set(0, (p.r !== undefined) ? p.r : ((idx * 1.618) % (Math.PI * 2)), 0);
                        d.scale.set(scale, scale, scale);
                    }, { castShadow: false, reflect: false });
            });
        };

        loadFlowerType('flower_red', redList, 1.15);
        loadFlowerType('flower_clover', cloverList, 1.15);
        loadFlowerType('flower_yellow', yellowList, 1.15);
    }

    loadGrass() {
        const grassPlacements = this.getDecorations('grass');
        if (!grassPlacements || grassPlacements.length === 0) return;

        // Новая трава (grassType a/b/c/d из группы 'grassland') — отдельный слой из модели grass_set;
        // прежние пучки без grassType продолжают рисоваться моделью grass_tuft.
        const setPlacements = grassPlacements.filter(p => p.grassType);
        const tuftPlacements = grassPlacements.filter(p => !p.grassType);
        if (setPlacements.length) this.loadGrassSet(setPlacements);
        // Старые пучки grass_tuft (чёрные цветы сверху) убраны везде по просьбе: рисуем их только если включено явно.
        if (!window.AVELORA_LEGACY_TUFT || !tuftPlacements.length) return;

        this.loadModel('grass_tuft', (gltf) => {
            let mesh = null;
            gltf.scene.traverse(c => { if (c.isMesh && !mesh) mesh = c; });
            if (!mesh) return;

            if (mesh.material) {
                mesh.material.side = THREE.DoubleSide;
                mesh.material.alphaTest = 0.42;
                mesh.material.depthWrite = true;
            }

            this.buildInstanced('grass', [{ geometry: mesh.geometry, material: mesh.material }],
                tuftPlacements, (p, idx, d) => {
                    const gy = this.terrain.getHeightAt(p.x, p.z);
                    const scale = (p.s || 1.0) * 1.85;
                    d.position.set(p.x, gy - 0.02, p.z);
                    d.rotation.set(0, (p.r !== undefined) ? p.r : ((idx * 1.618) % (Math.PI * 2)), 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: false, reflect: false });
        });
    }

    /**
     * Лесная трава отдельным слоем (models/environment/grass_set.glb, сборка: temp_work/grass_build/bake_grass_set.py).
     * Четыре вида кустиков: a, b (жёлтые цветки), c, d (синие цветки). Один общий материал на атласе с альфой;
     * лёгкое покачивание на ветру, мягкое освещение (нормаль не переворачивается у задней стороны лезвий).
     */
    loadGrassSet(placements) {
        const NODE = { a: 'grass_a', b: 'grass_b', c: 'grass_c', d: 'grass_d' };
        const GRASS_TINT = 0xb9cf9a;   // оттенок травы (множитель цвета атласа): темнее и спокойнее, чем «неоновый» исходник
        this.loadModel('grass_set', (gltf) => {
            const meshes = {};
            gltf.scene.traverse(c => { if (c.isMesh) meshes[c.name] = c; });
            const first = meshes[NODE.a] || Object.values(meshes)[0];
            if (!first) return;

            const mat = first.material;
            mat.side = THREE.DoubleSide;
            mat.alphaTest = 0.5;
            mat.transparent = false;
            mat.depthWrite = true;
            mat.roughness = 1.0;
            mat.metalness = 0.0;
            mat.color.setHex(GRASS_TINT);
            const windUniform = this.windUniform;
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uWindTime = windUniform;
                shader.vertexShader = 'uniform float uWindTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
                    #include <begin_vertex>
                    {
                        float hN = clamp(position.y / 0.55, 0.0, 1.0);
                        vec3 ip = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
                        float ph = ip.x * 0.7 + ip.z * 0.9;
                        float sw = sin(uWindTime * 1.7 + ph) * 0.045 * hN * hN;
                        transformed.x += sw;
                        transformed.z += sw * 0.6;
                    }`);
                // нормаль берём как есть и для задней стороны (в геометрии она «почти вверх») — без тёмных/светлых полос
                shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
                    '#include <normal_fragment_begin>\n    normal = normalize(vNormal);');
            };
            mat.customProgramCacheKey = () => 'avelora_grass_set_v1';

            Object.keys(NODE).forEach((type) => {
                const list = placements.filter(p => p.grassType === type);
                const src = meshes[NODE[type]];
                if (!list.length || !src) return;
                this.buildInstanced('grass', [{ geometry: src.geometry, material: mat }], list, (p, idx, d) => {
                    const gy = this.terrain.getHeightAt(p.x, p.z);
                    const scale = p.s || 1.0;
                    d.position.set(p.x, gy - 0.01, p.z);
                    d.rotation.set(0, (p.r !== undefined) ? p.r : ((idx * 1.618) % (Math.PI * 2)), 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: false, reflect: false });
            });
        });
    }


    // Merge N copies of a vertical plane rotated around Y into one cross/star geometry
    static makeCrossQuad(width, height, planes) {
        const src = [];
        for (let i = 0; i < planes; i++) {
            const p = new THREE.PlaneGeometry(width, height);
            p.translate(0, height * 0.5, 0);
            if (i > 0) p.rotateY((Math.PI / planes) * i);
            src.push(p);
        }
        const vCount = src[0].attributes.position.count;
        const iCount = src[0].index.count;
        const pos = new Float32Array(vCount * 3 * planes);
        const uv = new Float32Array(vCount * 2 * planes);
        const index = new Uint16Array(iCount * planes);
        src.forEach((p, n) => {
            pos.set(p.attributes.position.array, n * vCount * 3);
            uv.set(p.attributes.uv.array, n * vCount * 2);
            for (let i = 0; i < iCount; i++) index[n * iCount + i] = p.index.array[i] + n * vCount;
            p.dispose();
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(new THREE.BufferAttribute(index, 1));
        geo.computeVertexNormals();
        return geo;
    }

    addWindSway(material, speed, amount, heightNorm, minY) {
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uWindTime = this.windUniform;
            shader.vertexShader = `
                uniform float uWindTime;
                ${shader.vertexShader}
            `;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                if (position.y > ${minY.toFixed(2)}) {
                    float sway = sin(uWindTime * ${speed.toFixed(2)} + position.x * 1.5 + position.z * 1.2) * ${amount.toFixed(3)} * (position.y / ${heightNorm.toFixed(2)});
                    transformed.x += sway;
                    transformed.z += sway * 0.6;
                }
                `
            );
        };
    }

    createAlphaCutoutReeds() {
        if (!window.GAME_ASSETS.textures.reedSprite) return;
        const reedPlacements = this.getDecorations('reeds');
        if (reedPlacements.length === 0) return;

        // Cross-quad geometry: 2 vertical intersecting planes (+)
        const reedGeo = LakesideEnvironment.makeCrossQuad(0.85, 2.3, 2);
        const reedTex = this.loadTexture('reedSprite');
        reedTex.anisotropy = 4;

        const reedMat = new THREE.MeshStandardMaterial({
            map: reedTex,
            alphaTest: 0.45,
            side: THREE.DoubleSide,
            roughness: 0.75,
            metalness: 0.05
        });
        this.addWindSway(reedMat, 2.2, 0.14, 2.3, 0.1);

        // castShadow: false — thin alpha-cutout cross-quads (2026-09-24): the
        // shadow depth pass can't skip the fragment shader on alpha-tested
        // material (early-z doesn't apply), so every reed blade was paying
        // full per-fragment shadow cost for a shadow that's barely visible on
        // thin geometry anyway. Same treatment grass/dandelions already had;
        // reeds and ferns were the two kinds still missing it. lakeLand alone
        // has ~290 reed instances across its 7 reed groups (vs. forestEdge's
        // single 60-instance group) — likely the main reason lakeLand ran
        // noticeably heavier than other locations.
        // reflect: false — same reasoning, one level up: even with shadows
        // off, the water reflection pass (water.js/lib_js/Water.js) still
        // re-renders every visible instance a second time from the mirror
        // camera. A distorted, wave-rippled reflection of individual reed
        // blades reads as noise anyway, so it's not worth doubling ~290
        // draws for. See the `reflect` opt / layers note in buildInstanced().
        this.buildInstanced('reeds', [{ geometry: reedGeo, material: reedMat }], reedPlacements, (p, idx, d) => {
            const gy = this.terrain.getHeightAt(p.x, p.z);
            const scale = p.s || 1.0;
            d.position.set(p.x, gy - 0.05, p.z);
            d.rotation.set(0, (p.r !== undefined) ? p.r : 0, 0);
            d.scale.set(scale, scale, scale);
        }, { castShadow: false, reflect: false });
    }

    createAlphaCutoutGrass() {
        return; // Star-quad / cutout grass removed per user direction
    }

    createAtmosphericParticles() {
        const mapSize = (this.location.terrain && this.location.terrain.size) || 120;
        const spread = mapSize * 0.65;
        const count = Math.min(220, Math.round(120 * (spread / 75) * (spread / 75)));
        const rng = window.aveloraSeededRandom ? window.aveloraSeededRandom(1234) : Math.random;

        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            positions[i * 3] = (rng() - 0.5) * spread;
            positions[i * 3 + 1] = 0.5 + rng() * 4.0;
            positions[i * 3 + 2] = (rng() - 0.5) * spread;
        }
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0xfffae8,
            size: 0.12,
            transparent: true,
            opacity: 0.65,
            blending: THREE.AdditiveBlending
        });

        this.particles = new THREE.Points(geo, mat);
        this.particles.frustumCulled = false;
        this.root.add(this.particles);
    }

    update(delta, playerPos) {
        this.windUniform.value += delta;
        this.updateCulling(delta, playerPos);

        if (this.particles) {
            const pos = this.particles.geometry.attributes.position.array;
            for (let i = 0; i < pos.length; i += 3) {
                pos[i] += Math.sin(this.windUniform.value * 0.8 + pos[i + 2] * 0.1) * 0.015;
                pos[i + 1] += Math.cos(this.windUniform.value * 1.2 + pos[i] * 0.1) * 0.008;
                if (pos[i + 1] > 5.0) pos[i + 1] = 0.4;
                if (pos[i + 1] < 0.2) pos[i + 1] = 4.8;
            }
            this.particles.geometry.attributes.position.needsUpdate = true;
        }
    }

    /** V0.3: видимость чанков мелкой растительности и тени деревьев по расстоянию (раз в 0.25 c). */
    updateCulling(delta, playerPos) {
        if (!playerPos || !(this.cullMeshes.length || this.shadowMeshes.length)) return;
        this._cullT += delta;
        if (this._cullT < 0.25) return;
        this._cullT = 0;
        // V4.5: деревья отбрасывают тень только в радиусе GFX.treeShadowR (чанк целиком дальше — без тени)
        const SR = (window.GFX && window.GFX.treeShadowR) || 1e9;
        for (const c of this.shadowMeshes) {
            const dx = c.x - playerPos.x, dz = c.z - playerPos.z;
            const lim = SR + CULL_CHUNK_HALF_DIAG;
            const cast = SR >= 1e8 || (dx * dx + dz * dz) <= lim * lim;
            if (c.mesh.castShadow !== cast) c.mesh.castShadow = cast;
        }
        const R = window.GFX ? window.GFX.grassRadius : 1e9;
        const px = playerPos.x, pz = playerPos.z;
        for (const c of this.cullMeshes) {
            const lim = R * c.mul + CULL_CHUNK_HALF_DIAG;
            const dx = c.x - px, dz = c.z - pz;
            const d2 = dx * dx + dz * dz;
            if (R >= 1e8) { c.mesh.visible = !c.inner; continue; }
            let vis = d2 <= lim * lim;
            if (vis && c.inner) {
                const inLim = R * c.inner - CULL_CHUNK_HALF_DIAG;
                vis = inLim <= 0 || d2 >= inLim * inLim;
            }
            c.mesh.visible = vis;
        }
    }

    dispose() {
        this.disposed = true;
        this.objects.clear();
        this.hoverMeshes.length = 0;
        this.cullMeshes.length = 0;
        this.shadowMeshes.length = 0;
    }
}

LakesideEnvironment._m1 = new THREE.Matrix4();
LakesideEnvironment._m2 = new THREE.Matrix4();

window.LakesideEnvironment = LakesideEnvironment;
