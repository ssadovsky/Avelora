/**
 * Avelora — Location Groups (prefabs)
 *
 * Разворачивает компактные описания групп из world_data.js в отдельные объекты:
 *
 *   groups: [
 *     { type: 'forest',    x: 30, z: -40, radius: 14, count: 16, seed: 3 },
 *     { type: 'reeds',     x: -20, z: 5, radius: 8, count: 60, seed: 11 },
 *     { type: 'fernPatch', x: 12, z: 18, radius: 6, count: 14, seed: 5 }
 *   ]
 *
 * - Каждое дерево/камень/пучок камыша получает СВОЙ id (например "north_forest.tree7"),
 *   поэтому позже с ним можно взаимодействовать по отдельности (срубить, собрать, осмотреть).
 * - Один и тот же seed = одна и та же раскладка при каждом запуске.
 * - Объекты ставятся только на подходящую поверхность (деревья — на сушу,
 *   камыш — на мелководье и мокрый берег) и не загораживают проходы (exits),
 *   точки появления (spawns) и расчищенные места (clearings).
 */
(function () {
    'use strict';

    const KINDS = ['trees', 'boulders', 'shrubs', 'ferns', 'dandelions', 'reeds', 'grass'];
    const SINGULAR = {
        trees: 'tree', boulders: 'boulder', shrubs: 'shrub', ferns: 'fern',
        dandelions: 'flower', reeds: 'reed', grass: 'grass'
    };

    // Поверхности по высоте рельефа (плоскость воды на Y = 0)
    const SURFACES = {
        land: (h, slope) => h > 0.35 && slope < 0.45,
        shallow: (h) => h > -0.45 && h < 0.28,   // мелководье + мокрая кромка берега
        shore: (h) => h > 0.05 && h < 0.6,       // песок/влажный берег над водой
        any: (h) => h > -0.2
    };

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function hashString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function round2(v) { return Math.round(v * 100) / 100; }

    // ---------------------------------------------------------------
    // Context: terrain queries, reserved zones, spacing between objects
    // ---------------------------------------------------------------
    function makeContext(location, terrain) {
        const t = location.terrain || {};
        // rectangular locations (forestEdge) give sizeX/sizeZ instead of a square `size`
        const halfX = (t.sizeX || t.size || 120) / 2 - 1.0;
        const halfZ = (t.sizeZ || t.size || 120) / 2 - 1.0;

        const reserved = [];
        (location.exits || []).forEach(e => reserved.push({ x: e.x, z: e.z, r: (e.radius || 3) + 2.5 }));
        const spawns = location.spawns || {};
        Object.keys(spawns).forEach(k => reserved.push({ x: spawns[k].x, z: spawns[k].z, r: 3.0 }));
        if (location.playerSpawn) reserved.push({ x: location.playerSpawn.x, z: location.playerSpawn.z, r: 3.0 });
        (location.clearings || []).forEach(c => reserved.push({ x: c.x, z: c.z, r: c.radius || 4 }));
        // Item piles and props (world_objects.js) keep grass/trees from growing through them
        (location.pickups || []).forEach(p => reserved.push({ x: p.x, z: p.z, r: 1.0 }));
        (location.props || []).forEach(p => reserved.push({ x: p.x, z: p.z, r: 1.3 * (p.s || 1) }));

        const placed = {};
        KINDS.forEach(k => { placed[k] = []; });

        return {
            terrain,
            placed,
            isInsideMap(x, z) { return Math.abs(x) < halfX && Math.abs(z) < halfZ; },
            isReserved(x, z) {
                for (const r of reserved) {
                    const dx = x - r.x, dz = z - r.z;
                    if (dx * dx + dz * dz < r.r * r.r) return true;
                }
                return false;
            },
            isFree(kind, x, z, spacing) {
                if (!spacing) return true;
                const list = placed[kind];
                const s2 = spacing * spacing;
                for (let i = 0; i < list.length; i++) {
                    const dx = x - list[i].x, dz = z - list[i].z;
                    if (dx * dx + dz * dz < s2) return false;
                }
                return true;
            },
            surfaceOk(surface, x, z) {
                const test = SURFACES[surface] || SURFACES.land;
                const h = terrain.getHeightAt(x, z);
                const slope = terrain.getSlopeAt ? terrain.getSlopeAt(x, z) : 0;
                return test(h, slope);
            }
        };
    }

    // Point inside group shape (circle or rotated ellipse); returns normalized distance
    function shapeDistance(g, x, z) {
        const rx = g.rx || g.radius || 8;
        const rz = g.rz || g.radius || 8;
        let dx = x - g.x, dz = z - g.z;
        if (g.angle) {
            const c = Math.cos(-g.angle), s = Math.sin(-g.angle);
            const tx = dx * c - dz * s;
            dz = dx * s + dz * c;
            dx = tx;
        }
        return Math.sqrt((dx / rx) * (dx / rx) + (dz / rz) * (dz / rz));
    }

    function randomInShape(g, rng) {
        const rx = g.rx || g.radius || 8;
        const rz = g.rz || g.radius || 8;
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng());
        let dx = Math.cos(a) * d * rx;
        let dz = Math.sin(a) * d * rz;
        if (g.angle) {
            const c = Math.cos(g.angle), s = Math.sin(g.angle);
            const tx = dx * c - dz * s;
            dz = dx * s + dz * c;
            dx = tx;
        }
        return { x: g.x + dx, z: g.z + dz };
    }

    function gaussian(rng) {
        const u = Math.max(1e-6, rng());
        const v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /**
     * Scatter objects of one kind inside group shape.
     * spec: { kind, count, spacing, scale:[min,max], surface, clumps, clumpRadius, centers, edgeFalloff }
     */
    function scatter(ctx, g, spec, rng) {
        const out = [];
        if (!spec.count || spec.count <= 0) return out;

        // Clump centers: explicit (e.g. around trees) or random inside shape on valid surface
        let centers = spec.centers || null;
        if (!centers && spec.clumps) {
            centers = [];
            let tries = 0;
            while (centers.length < spec.clumps && tries++ < spec.clumps * 200) {
                const p = randomInShape(g, rng);
                if (ctx.isInsideMap(p.x, p.z) && ctx.surfaceOk(spec.surface, p.x, p.z) && !ctx.isReserved(p.x, p.z)) {
                    centers.push(p);
                }
            }
            if (centers.length === 0) centers = null;
        }

        const maxAttempts = spec.count * 60;
        let attempts = 0;
        while (out.length < spec.count && attempts++ < maxAttempts) {
            let p;
            if (centers) {
                const c = centers[Math.floor(rng() * centers.length)];
                const cr = spec.clumpRadius || 2;
                p = { x: c.x + gaussian(rng) * cr * 0.5, z: c.z + gaussian(rng) * cr * 0.5 };
                if (shapeDistance(g, p.x, p.z) > 1.15) continue;
            } else {
                p = randomInShape(g, rng);
                // Ragged, natural group edge instead of a hard circle
                const d = shapeDistance(g, p.x, p.z);
                const falloff = spec.edgeFalloff !== undefined ? spec.edgeFalloff : 0.6;
                if (d > falloff && rng() < (d - falloff) / (1 - falloff) * 0.75) continue;
            }

            if (!ctx.isInsideMap(p.x, p.z)) continue;
            if (ctx.isReserved(p.x, p.z)) continue;
            if (!ctx.surfaceOk(spec.surface, p.x, p.z)) continue;
            if (!ctx.isFree(spec.kind, p.x, p.z, spec.spacing)) continue;

            const [smin, smax] = spec.scale;
            const obj = { x: round2(p.x), z: round2(p.z), s: round2(smin + rng() * (smax - smin)), r: round2(rng() * Math.PI * 2) };
            out.push(obj);
            ctx.placed[spec.kind].push(obj);
        }
        return out;
    }

    // ---------------------------------------------------------------
    // Group presets
    // ---------------------------------------------------------------
    const PRESETS = {
        // Лес / роща: деревья + подлесок (папоротники и трава у стволов)
        forest(ctx, g, rng) {
            const count = g.count !== undefined ? g.count : 12;
            const trees = scatter(ctx, g, {
                kind: 'trees', count, spacing: g.spacing || 3.4,
                scale: [g.scaleMin || 0.85, g.scaleMax || 1.35], surface: 'land'
            }, rng);
            const res = { trees };
            if (g.undergrowth !== false && trees.length) {
                res.ferns = scatter(ctx, g, {
                    kind: 'ferns', count: Math.round(trees.length * (g.ferns !== undefined ? g.ferns : 0.7)),
                    spacing: 1.3, scale: [2.3, 3.4], surface: 'land', centers: trees, clumpRadius: 3.2
                }, rng);
                res.grass = scatter(ctx, g, {
                    kind: 'grass', count: Math.round(trees.length * (g.grass !== undefined ? g.grass : 1.6)),
                    spacing: 0.7, scale: [0.9, 1.4], surface: 'land', centers: trees, clumpRadius: 3.6
                }, rng);
            }
            if (g.shrubs) {
                res.shrubs = scatter(ctx, g, {
                    kind: 'shrubs', count: g.shrubs, spacing: 3.0, scale: [1.4, 2.0], surface: 'land'
                }, rng);
            }
            return res;
        },

        // Заросли камыша: плотные куртины на мелководье и мокром берегу, с просветами
        reeds(ctx, g, rng) {
            const count = g.count !== undefined ? g.count : 50;
            return {
                reeds: scatter(ctx, g, {
                    kind: 'reeds', count, spacing: g.spacing || 0.38,
                    scale: [g.scaleMin || 0.7, g.scaleMax || 1.25], surface: 'shallow',
                    clumps: g.clumps || Math.max(2, Math.round(count / 14)), clumpRadius: g.clumpRadius || 1.8
                }, rng)
            };
        },

        // Каменистый участок: валуны + трава и папоротники у камней
        rocks(ctx, g, rng) {
            const count = g.count !== undefined ? g.count : 4;
            const boulders = scatter(ctx, g, {
                kind: 'boulders', count, spacing: g.spacing || 2.6,
                scale: [g.scaleMin || 0.7, g.scaleMax || 1.7], surface: g.surface || 'land'
            }, rng);
            return {
                boulders,
                grass: scatter(ctx, g, {
                    kind: 'grass', count: boulders.length * 3, spacing: 0.7, scale: [0.9, 1.3],
                    surface: 'land', centers: boulders, clumpRadius: 2.6
                }, rng),
                ferns: scatter(ctx, g, {
                    kind: 'ferns', count: Math.round(boulders.length * 0.5), spacing: 1.4, scale: [2.2, 3.0],
                    surface: 'land', centers: boulders, clumpRadius: 2.4
                }, rng)
            };
        },

        // Папоротниковая заросль: плотное самостоятельное скопление папоротников
        // (не привязанное к деревьям/камням, в отличие от подлеска в forest/rocks),
        // с редкой травой между кустами для естественности.
        fernPatch(ctx, g, rng) {
            const count = g.count !== undefined ? g.count : 14;
            const res = {
                ferns: scatter(ctx, g, {
                    kind: 'ferns', count, spacing: g.spacing || 1.1,
                    scale: [g.scaleMin || 2.0, g.scaleMax || 3.2], surface: g.surface || 'land',
                    clumps: g.clumps || Math.max(1, Math.round(count / 8)), clumpRadius: g.clumpRadius || 2.4
                }, rng)
            };
            if (g.grass !== false && res.ferns.length) {
                res.grass = scatter(ctx, g, {
                    kind: 'grass', count: g.grassCount !== undefined ? g.grassCount : Math.round(count * 1.2),
                    spacing: 0.7, scale: [0.9, 1.4], surface: g.surface || 'land',
                    centers: res.ferns, clumpRadius: 2.0
                }, rng);
            }
            return res;
        },

        // Луг: пятна травы и одуванчиков
        meadow(ctx, g, rng) {
            const count = g.count !== undefined ? g.count : 50;
            return {
                grass: scatter(ctx, g, {
                    kind: 'grass', count, spacing: g.spacing || 0.55, scale: [0.9, 1.45], surface: 'land',
                    clumps: Math.max(2, Math.round(count / 9)), clumpRadius: g.clumpRadius || 2.6
                }, rng),
                dandelions: scatter(ctx, g, {
                    kind: 'dandelions', count: g.flowers !== undefined ? g.flowers : Math.round(count * 0.2),
                    spacing: 0.7, scale: [1.6, 2.4], surface: 'land',
                    clumps: Math.max(1, Math.round(count / 25)), clumpRadius: 2.2
                }, rng)
            };
        }
    };

    /**
     * Returns final object lists for a location:
     * { trees: [{id, x, z, s, r, group}], boulders: [...], ... }
     * Explicit `decorations` come first (their ids: "trees_0", ... or their own `id`),
     * then objects generated by `groups`.
     */
    function expandLocationObjects(location, terrain) {
        const ctx = makeContext(location, terrain);
        const result = {};
        KINDS.forEach(k => { result[k] = []; });

        // 1) Hand-placed decorations (kept exactly as the level designer wrote them)
        const deco = location.decorations || {};
        KINDS.forEach(kind => {
            (deco[kind] || []).forEach((p, i) => {
                const obj = Object.assign({}, p, { id: p.id || `${kind}_${i}`, group: null });
                result[kind].push(obj);
                ctx.placed[kind].push(obj);
            });
        });

        // 2) Groups (prefabs)
        (location.groups || []).forEach((g, gi) => {
            const preset = PRESETS[g.type];
            if (!preset) {
                console.warn(`[Avelora] Unknown group type "${g.type}" in location "${location.id}"`);
                return;
            }
            const groupId = g.id || `${g.type}${gi + 1}`;
            const seed = g.seed !== undefined ? g.seed : hashString(`${location.id}:${groupId}`);
            const rng = mulberry32(seed);
            const generated = preset(ctx, g, rng);
            Object.keys(generated).forEach(kind => {
                generated[kind].forEach((obj, n) => {
                    obj.id = `${groupId}.${SINGULAR[kind]}${n + 1}`;
                    obj.group = groupId;
                    result[kind].push(obj);
                });
            });
        });

        // 3) Zones where no ferns may grow (location.noFerns: ellipses {x, z, rx, rz})
        (location.noFerns || []).forEach(zn => {
            result.ferns = result.ferns.filter(f => {
                const dx = (f.x - zn.x) / zn.rx, dz = (f.z - zn.z) / zn.rz;
                return dx * dx + dz * dz > 1;
            });
        });

        return result;
    }

    window.AVELORA_GROUP_TYPES = Object.keys(PRESETS);
    window.expandLocationObjects = expandLocationObjects;
    window.aveloraSeededRandom = mulberry32;
})();
