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

// Decoded GLB buffers are cached between locations (atob of multi-MB strings is slow)
const GLB_BUFFER_CACHE = {};

// Readable names for the hover tooltip (main.js). Only kinds listed in
// HOVER_KINDS are actually raycast-able — dandelions/grass are dense
// filler and would make hovering noisy, so they're left out on purpose.
// Ferns ARE included: in this asset set they're large multi-frond clusters
// (not small ground filler), placed sparsely enough to be a real object.
const KIND_LABELS = {
    trees: 'Дерево', boulders: 'Камень', shrubs: 'Куст', reeds: 'Камыш',
    ferns: 'Папоротник', dandelions: 'Одуванчик', grass: 'Трава'
};
const HOVER_KINDS = new Set(['trees', 'boulders', 'shrubs', 'reeds', 'ferns']);

// Of the hoverable kinds, only 'trees' gets an invisible generous proxy
// cylinder for hit-testing instead of its real mesh. Reason: a tree's real
// geometry is mostly thin trunk + sparse alpha-cutout leaf quads, so the
// actual hit area is tiny and sits low near the ground. Boulders/shrubs/reeds
// have solid-ish real geometry that already gives a reasonable hover target,
// and giving them oversized invisible proxies too made hover unreliable near
// trees/rocks (a bigger tree/boulder proxy nearby would grab the raycast hit
// before the smaller shrub/reed one, or the two would fight) — so they keep
// raycasting their own visible InstancedMesh, same as before.
const PROXY_HOVER_KINDS = new Set(['trees']);

// object.visible stays true so the raycaster tests it; material.visible=false
// keeps it out of the render list. Sizes are in local/unscaled units — the
// object's own `s` scale is applied on top via the normal placement matrix.
const HOVER_PROXY_SIZE = {
    trees: { radiusBottom: 0.7, radiusTop: 1.35, height: 3.4 }
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
        const b64 = window.GAME_ASSETS && window.GAME_ASSETS.models[key];
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
                if (HOVER_KINDS.has(kind) && !PROXY_HOVER_KINDS.has(kind)) {
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
            if (PROXY_HOVER_KINDS.has(kind)) {
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
            }
        });
    }

    /** Cached per-location (see this._hoverProxyGeoCache in the constructor). */
    getHoverProxyGeometry(kind) {
        if (this._hoverProxyGeoCache[kind]) return this._hoverProxyGeoCache[kind];
        const cfg = HOVER_PROXY_SIZE[kind] || { radiusBottom: 0.8, radiusTop: 0.8, height: 1.5 };
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
        this.loadShrubs();
        this.loadFerns();
        this.loadDandelions();
        this.createAlphaCutoutReeds();
        this.createAlphaCutoutGrass();
        this.createAtmosphericParticles();
    }

    loadRealisticTrees() {
        const treePositions = this.getDecorations('trees');
        if (treePositions.length === 0) return;

        this.loadModel('tree', (gltf) => {
            const treeScene = gltf.scene;
            treeScene.updateMatrixWorld(true);

            const parts = [];
            treeScene.traverse(c => {
                if (!c.isMesh) return;
                if (c.material) {
                    c.material.side = THREE.DoubleSide;
                    if (c.material.name.includes('Tree_1') || c.material.alphaMode === 'MASK') {
                        c.material.alphaTest = 0.35;
                        c.material.depthWrite = true;
                    }
                }
                parts.push({ geometry: c.geometry, material: c.material, nodeMatrix: c.matrixWorld.clone() });
            });

            this.buildInstanced('trees', parts, treePositions, (p, idx, d) => {
                const gy = this.terrain.getHeightAt(p.x, p.z);
                const scale = p.s || 1.0;
                d.position.set(p.x, gy - 0.15, p.z);
                d.rotation.y = (p.r !== undefined) ? p.r : 0;
                d.scale.set(scale, scale, scale);
            });

            // Trunk obstacle (a single tree is walk-around-able, a dense forest acts as a wall)
            treePositions.forEach(p => this.pathfinder.addObstacle(p.x, p.z, (p.obstacle || 0.8) * (p.s || 1.0)));
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

            boulderPlacements.forEach(p => this.pathfinder.addObstacle(p.x, p.z, (p.s || 1.8) * 1.1));
        });
    }

    loadShrubs() {
        const shrubSpots = this.getDecorations('shrubs');
        if (shrubSpots.length === 0) return;

        this.loadModel('shrub', (gltf) => {
            let shrubMesh = null;
            gltf.scene.traverse(c => { if (c.isMesh && !shrubMesh) shrubMesh = c; });
            if (!shrubMesh) return;

            const shrubMat = shrubMesh.material;
            shrubMat.side = THREE.DoubleSide;
            shrubMat.alphaTest = 0.45;

            this.buildInstanced('shrubs', [{ geometry: shrubMesh.geometry, material: shrubMat }],
                shrubSpots, (sp, idx, d) => {
                    const gy = this.terrain.getHeightAt(sp.x, sp.z);
                    const scale = sp.s || 1.8;
                    d.position.set(sp.x, gy - 0.1, sp.z);
                    d.rotation.set(0, (sp.r !== undefined) ? sp.r : 0, 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: false, reflect: false }); // alpha-cutout foliage — see grass/dandelions/reeds note below

            shrubSpots.forEach(sp => this.pathfinder.addObstacle(sp.x, sp.z, (sp.s || 1.8) * 0.9));
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
                }, { castShadow: false, reflect: false }); // alpha-cutout foliage — see grass/dandelions/reeds note below
        });
    }

    loadDandelions() {
        const dandelionPlacements = this.getDecorations('dandelions');
        if (dandelionPlacements.length === 0) return;

        this.loadModel('dandelion', (gltf) => {
            let flowerMesh = null;
            gltf.scene.traverse(c => {
                if (c.isMesh && (!flowerMesh || c.geometry.attributes.position.count > flowerMesh.geometry.attributes.position.count)) {
                    flowerMesh = c;
                }
            });
            if (!flowerMesh) return;

            const flowerMat = flowerMesh.material;
            flowerMat.side = THREE.DoubleSide;
            flowerMat.alphaTest = 0.45;

            this.buildInstanced('dandelions', [{ geometry: flowerMesh.geometry, material: flowerMat }],
                dandelionPlacements, (p, idx, d) => {
                    const gy = this.terrain.getHeightAt(p.x, p.z);
                    const scale = p.s || 2.0;
                    d.position.set(p.x, gy, p.z);
                    d.rotation.set(0, (p.r !== undefined) ? p.r : 0, 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: false, reflect: false });
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
        const grassPlacements = this.getDecorations('grass');
        if (grassPlacements.length === 0) return;

        const locTerrain = (this.location && this.location.terrain) || {};
        const isGoldshire = locTerrain.biome === 'goldshire';

        // Настоящая 3D-модель травы из Poly Haven (grass.glb) используется для Goldshire (Локация 2)
        if (isGoldshire && window.GAME_ASSETS && window.GAME_ASSETS.models && window.GAME_ASSETS.models.grass) {
            this.loadModel('grass', (gltf) => {
                let grassMesh = null;
                gltf.scene.traverse(c => { if (c.isMesh && !grassMesh) grassMesh = c; });
                if (!grassMesh) return;

                const grassMat = grassMesh.material.clone();
                grassMat.roughness = 0.75;
                grassMat.metalness = 0.05;
                this.addWindSway(grassMat, 2.6, 0.08, 0.25, 0.02);

                this.buildInstanced('grass', [{ geometry: grassMesh.geometry, material: grassMat }], grassPlacements, (p, idx, d) => {
                    const gy = this.terrain.getHeightAt(p.x, p.z);
                    const scale = (p.s || 1.0) * 1.8;
                    d.position.set(p.x, gy - 0.02, p.z);
                    d.rotation.set(0, (p.r !== undefined) ? p.r : 0, 0);
                    d.scale.set(scale, scale, scale);
                }, { castShadow: false, reflect: false });
            });
            return;
        }

        const spriteKey = (isGoldshire && window.GAME_ASSETS && window.GAME_ASSETS.textures.goldshireGrassSprite)
            ? 'goldshireGrassSprite'
            : 'grassSprite';

        if (!window.GAME_ASSETS || !window.GAME_ASSETS.textures || !window.GAME_ASSETS.textures[spriteKey]) return;

        // Star-quad geometry: 3 vertical planes at 60 degree angles (*)
        const gw = 0.85;
        const gh = 0.55;
        const grassGeo = LakesideEnvironment.makeCrossQuad(gw, gh, 3);
        const grassTex = this.loadTexture(spriteKey);
        grassTex.anisotropy = 4;

        const grassMat = new THREE.MeshStandardMaterial({
            map: grassTex,
            alphaTest: 0.45,
            side: THREE.DoubleSide,
            roughness: 0.70,
            metalness: 0.04
        });
        this.addWindSway(grassMat, 2.6, 0.12, gh, 0.05);

        this.buildInstanced('grass', [{ geometry: grassGeo, material: grassMat }], grassPlacements, (p, idx, d) => {
            const gy = this.terrain.getHeightAt(p.x, p.z);
            const scale = (p.s || 1.0);
            d.position.set(p.x, gy - 0.02, p.z);
            d.rotation.set(0, (p.r !== undefined) ? p.r : 0, 0);
            d.scale.set(scale, scale, scale);
        }, { castShadow: false, reflect: false });
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

    update(delta) {
        this.windUniform.value += delta;

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

    dispose() {
        this.disposed = true;
        this.objects.clear();
        this.hoverMeshes.length = 0;
    }
}

LakesideEnvironment._m1 = new THREE.Matrix4();
LakesideEnvironment._m2 = new THREE.Matrix4();

window.LakesideEnvironment = LakesideEnvironment;
