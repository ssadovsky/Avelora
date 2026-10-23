/**
 * Avelora — Строительство (building.js)
 *
 * Только в локациях с `building: { types: [...], area: {x, z, hx, hz} }` (сейчас — «Домашний лагерь»).
 * Меню строительства (кнопка «Строить» в микроменю / клавиша B) → выбор постройки → призрак под курсором
 * (зелёный = можно, красный = нельзя; R — поворот, ЛКМ / Enter — построить, Esc — отмена).
 *
 * Дощатый склад (`storage`): помост из досок (как мост через речку) с трапом, задняя стена, низкие борта,
 * двускатная крыша, внутри полки, бочки и большой сундук. В склад можно ЗАЙТИ.
 *   • модель — процедурная (BoxGeometry-подобные доски, слитые в 5 мешей, без внешних ассетов);
 *   • высота пола: terrain.addPlatform() (герой поднимается по трапу на помост), навигация: клетки стен
 *     и полок закрыты в pathfinder.grid, вход свободен;
 *   • камера: невидимые «прокси-коробки» (пол, борта, задняя стена, крыша) регистрируются через
 *     game.addCameraBlocker() — камера не лезет в текстуры. Когда герой внутри (вид от 3-го лица), крыша
 *     становится прозрачной, задняя стена — полупрозрачной, а их прокси выключаются из блокировки, чтобы
 *     камера смотрела в склад сверху, а не упиралась в потолок;
 *   • хранилище: запись в worldObjects.props с `container` — тот же интерфейс, что у сундука
 *     (клик → подойти → окно сундука + сумка, перетаскивание, сохранение в состоянии героя).
 * Состояние: gameState.buildings[locationId] = [{uid, type, x, z, r}] (game_state.js); содержимое склада —
 * gameState.chestData['<loc>/building:<uid>'].
 *
 * Диагностика: ?freebuild=1 — строить бесплатно. game.building.debugBuild(x, z, r) — поставить без проверок цены.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Размеры склада (метры, локальные координаты: центр основания, y = 0 — верх помоста, +Z — вход)
    // ------------------------------------------------------------------
    const HX = 2.3, HZ = 2.5;          // половины размеров помоста
    const RAMP_L = 1.6, RAMP_HX = 1.25; // трап перед входом
    const EAVE_X = HX + 0.45, EAVE_Y = 2.5, RIDGE_Y = 3.7;
    const CHEST_LZ = -1.95;            // сундук-хранилище у задней стены
    const BACK_STRIP = 1.35;           // глубина закрытой для ходьбы полосы у задней стены (полки, сундук)
    const SIDE_MARGIN = 0.2;           // запас от боковых стен
    const TILE_U = 1.0, TILE_V = 0.5;  // размер тайла текстуры дерева (вдоль волокон / поперёк), м
    const WALL_FADE = 0.22;            // прозрачность задней стены, когда герой внутри
    const FREE_BUILD = /[?&]freebuild=1/.test(location.search);

    // Пильня (`sawmill`): открытый навес на столбах, внутри козлы с брусом и двуручная пила. Рядом с ней (в радиусе
    // CRAFT_RADIUS от центра) в сумке доступны рецепты со `station: "sawmill"` — доски. Строится БЕЗ досок.
    const SX = 1.9, SZ = 1.5;          // половины размеров пильни
    const SAW_EAVE_X = SX + 0.3, SAW_RIDGE = 3.4;
    const CRAFT_RADIUS = 4.2;

    const TYPES = {
        sawmill: {
            id: 'sawmill',
            kind: 'station',
            station: 'sawmill',
            name: 'Пильня',
            desc: 'Открытый навес с козлами и двуручной пилой. Рядом с ней из брёвен делают доски: откройте сумку → «Создание». Для постройки доски не нужны.',
            cost: [{ item: 'log', count: 8 }, { item: 'branch', count: 4 }, { item: 'stone', count: 4 }],
            mesh: 'woodshed',
            craftRadius: 5.0,
            sep: 5.2,
            fp: { hx: 2.5, hz: 2.5, front: 0, eaveX: 2.6, ridgeY: 3.2 },
            rects: [
                { x0: -2.2, x1: 2.2, z0: -2.0, z1: -0.4 },        // задняя стена, козлы с брёвнами
                { x0: 1.1, x1: 2.3, z0: -0.4, z1: 1.9 },           // штабель брёвен справа
                { x0: -1.7, x1: -0.55, z0: 0.1, z1: 1.2 }          // колода с топором
            ],
            icon: '<path d="M6 16 24 7l18 9"/><path d="M10 15v26M38 15v26"/><path d="M8 33h32"/><path d="M13 33l4 8M35 33l-4 8"/><path d="M6 28h36" stroke-width="3.5"/><path d="M25 14v18M23 14h4" stroke-width="1.6"/>'
        },
        forge: {
            id: 'forge',
            kind: 'station',
            station: 'forge',
            name: 'Кузня',
            desc: 'Открытая кузня под навесом: каменный горн с трубой, наковальня, бадья для закалки, верстак. Рядом с ней можно ковать (рецепты со станцией «кузня»).',
            cost: [{ item: 'stone', count: 14 }, { item: 'iron_ore', count: 6 }, { item: 'log', count: 4 }, { item: 'plank', count: 6 }],
            mesh: 'smithy',
            rects: [
                { x0: -2.7, x1: 2.7, z0: -2.25, z1: -0.55 },       // задняя стена и горн
                { x0: -3.25, x1: -1.35, z0: -1.4, z1: 1.2 },       // поленница слева
                { x0: 1.8, x1: 2.9, z0: -1.0, z1: 2.2 },           // опора и бадья справа
                { x0: -0.85, x1: 0.05, z0: 1.1, z1: 2.0 }          // наковальня
            ],
            craftRadius: 5.2,
            sep: 5.0,
            fp: { hx: 3.0, hz: 2.45, front: 0.6, eaveX: 3.1, ridgeY: 4.2 },
            icon: '<path d="M6 18 24 8l18 10"/><path d="M9 18v22M39 18v22"/><path d="M15 40V26h18v14"/><path d="M19 26v-8h10v8"/><path d="M21 33h6" stroke-width="3"/><path d="M12 40h24"/>'
        },
        storage: {
            id: 'storage',
            kind: 'deck',
            name: 'Дощатый склад',
            slots: 36,
            desc: 'Просторный сарай на помосте из досок — в него можно зайти. У задней стены большой сундук-хранилище на 36 ячеек.',
            cost: [{ item: 'plank', count: 16 }, { item: 'log', count: 4 }],
            sep: 5.2,
            fp: { hx: HX, hz: HZ, front: RAMP_L, eaveX: EAVE_X, ridgeY: RIDGE_Y },
            icon: '<path d="M5 22 24 8l19 14"/><path d="M9 21v17h30V21"/><path d="M5 38h38"/><path d="M15 38V27h18v11"/><path d="M15 31h18"/><path d="M19 27v11M24 27v11M29 27v11" stroke-width="1.2"/>'
        }
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

    // ------------------------------------------------------------------
    // Текстура дерева (canvas, 256², волокна вдоль U) — нейтральная светлая, цвет даёт вершинный цвет доски
    // ------------------------------------------------------------------
    function makeWoodTexture() {
        const S = 256;
        const c = document.createElement('canvas');
        c.width = S; c.height = S;
        const g = c.getContext('2d');
        const rnd = mulberry32(7741);
        for (let y = 0; y < S; y++) {
            const w = Math.sin(y * 0.21) * 0.5 + Math.sin(y * 0.057 + 1.3) * 0.5 + Math.sin(y * 0.9) * 0.15;
            const v = 0.80 + w * 0.09 + (rnd() - 0.5) * 0.09;
            g.fillStyle = `rgb(${Math.round(v * 255)},${Math.round(v * 0.94 * 255)},${Math.round(v * 0.85 * 255)})`;
            g.fillRect(0, y, S, 1);
        }
        const streak = (x, y, len, a, lw) => {
            for (const ox of [0, -S]) {
                g.strokeStyle = `rgba(58,38,22,${a})`;
                g.lineWidth = lw;
                g.beginPath();
                g.moveTo(x + ox, y);
                g.bezierCurveTo(x + ox + len * 0.3, y + (rnd() - 0.5) * 4, x + ox + len * 0.7, y + (rnd() - 0.5) * 4, x + ox + len, y + (rnd() - 0.5) * 3);
                g.stroke();
            }
        };
        for (let i = 0; i < 280; i++) streak(rnd() * S, rnd() * S, 30 + rnd() * 140, 0.05 + rnd() * 0.12, 0.6 + rnd() * 1.2);
        for (let k = 0; k < 3; k++) {            // сучки
            const x = rnd() * S, y = 30 + rnd() * (S - 60);
            for (const ox of [0, -S]) {
                const gr = g.createRadialGradient(x + ox, y, 1, x + ox, y, 9);
                gr.addColorStop(0, 'rgba(70,44,26,0.55)');
                gr.addColorStop(1, 'rgba(70,44,26,0)');
                g.fillStyle = gr;
                g.beginPath(); g.ellipse(x + ox, y, 14, 6, 0, 0, Math.PI * 2); g.fill();
            }
        }
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
        tex.needsUpdate = true;
        return tex;
    }

    // ------------------------------------------------------------------
    // Мелкие помощники для слияния досок в один меш
    // ------------------------------------------------------------------
    const FACES = [
        { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
        { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
        { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
        { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
        { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
        { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] }
    ];
    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const _v = new THREE.Vector3();
    const _nv = new THREE.Vector3();

    function makeStoneTexture() {
        const S = 256;
        const c = document.createElement('canvas');
        c.width = S; c.height = S;
        const g = c.getContext('2d');
        const rnd = mulberry32(5513);
        g.fillStyle = '#5b5a58'; g.fillRect(0, 0, S, S);
        const rows = 4, rh = S / rows;
        for (let r = 0; r < rows; r++) {
            let x = -(rnd() * 40);
            while (x < S) {
                const w = 50 + rnd() * 50, v = 150 + Math.floor(rnd() * 70);
                g.fillStyle = `rgb(${v},${v - 2},${v - 8})`;
                g.fillRect(x + 2, r * rh + 2, w - 4, rh - 4);
                for (let k = 0; k < 40; k++) { const q = (rnd() - 0.5) * 36; g.fillStyle = `rgba(${q > 0 ? 255 : 0},${q > 0 ? 255 : 0},${q > 0 ? 255 : 0},0.05)`; g.fillRect(x + rnd() * w, r * rh + rnd() * rh, 3 + rnd() * 8, 2 + rnd() * 5); }
                x += w;
            }
        }
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        if (THREE.sRGBEncoding && !tex.colorSpace) tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = 4;
        return tex;
    }

    function makeBuf() { return { pos: [], nor: [], uv: [], col: [] }; }

    function mat(px, py, pz, rx, ry, rz) {
        const m = new THREE.Matrix4();
        m.makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ'));
        m.setPosition(px, py, pz);
        return m;
    }
    function child(parent, px, py, pz, rx, ry, rz) {
        return new THREE.Matrix4().multiplyMatrices(parent, mat(px, py, pz, rx, ry, rz));
    }

    function pushQuad(buf, pts, nrm, uvs, col) {
        const idx = [0, 1, 2, 0, 2, 3];
        for (let k = 0; k < 6; k++) {
            const i = idx[k];
            buf.pos.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
            buf.nor.push(nrm.x, nrm.y, nrm.z);
            buf.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
            buf.col.push(col[0], col[1], col[2]);
        }
    }

    /** Доска/брус sx×sy×sz в системе mat4. Волокна — вдоль самой длинной стороны. */
    function pushBox(buf, sx, sy, sz, mat4, col, rnd) {
        const ga = sx >= sy && sx >= sz ? 0 : (sy >= sz ? 1 : 2);
        const u0 = rnd(), v0 = rnd();
        for (let f = 0; f < 6; f++) {
            const F = FACES[f];
            const hn = Math.abs(F.n[0] * sx + F.n[1] * sy + F.n[2] * sz) / 2;
            const ha = Math.abs(F.a[0] * sx + F.a[1] * sy + F.a[2] * sz) / 2;
            const hb = Math.abs(F.b[0] * sx + F.b[1] * sy + F.b[2] * sz) / 2;
            const axA = F.a[0] ? 0 : (F.a[1] ? 1 : 2);
            const axB = F.b[0] ? 0 : (F.b[1] ? 1 : 2);
            _nv.set(F.n[0], F.n[1], F.n[2]).transformDirection(mat4);
            const nrm = { x: _nv.x, y: _nv.y, z: _nv.z };
            const pts = [], uvs = [];
            for (let c = 0; c < 4; c++) {
                const sa = CORNERS[c][0], sb = CORNERS[c][1];
                _v.set(
                    F.n[0] * hn + F.a[0] * sa * ha + F.b[0] * sb * hb,
                    F.n[1] * hn + F.a[1] * sa * ha + F.b[1] * sb * hb,
                    F.n[2] * hn + F.a[2] * sa * ha + F.b[2] * sb * hb
                ).applyMatrix4(mat4);
                pts.push(_v.x, _v.y, _v.z);
                const ua = (sa + 1) * ha, vb = (sb + 1) * hb;
                let u, v;
                if (axA === ga) { u = ua; v = vb; } else if (axB === ga) { u = vb; v = ua; } else { u = ua; v = vb; }
                uvs.push(u / TILE_U + u0, v / TILE_V + v0);
            }
            pushQuad(buf, pts, nrm, uvs, col);
        }
    }

    /** Усечённый цилиндр вдоль +Y из основания (0,0,0) в системе mat4 (бочки, мешки). */
    function pushCyl(buf, r0, r1, h, seg, mat4, col, rnd) {
        const u0 = rnd();
        for (let i = 0; i < seg; i++) {
            const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
            const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
            const pts = [];
            const P = [[c0 * r0, 0, s0 * r0], [c0 * r1, h, s0 * r1], [c1 * r1, h, s1 * r1], [c1 * r0, 0, s1 * r0]];
            P.forEach(p => { _v.set(p[0], p[1], p[2]).applyMatrix4(mat4); pts.push(_v.x, _v.y, _v.z); });
            const am = (a0 + a1) / 2;
            _nv.set(Math.cos(am), (r0 - r1) / Math.max(h, 0.01), Math.sin(am)).transformDirection(mat4);
            const uw = (Math.PI * 2 * r0) / seg / TILE_U;
            pushQuad(buf, pts, { x: _nv.x, y: _nv.y, z: _nv.z },
                [u0 + i * uw, 0, u0 + i * uw, h / TILE_V, u0 + (i + 1) * uw, h / TILE_V, u0 + (i + 1) * uw, 0], col);
        }
        // верхняя крышка
        _nv.set(0, 1, 0).transformDirection(mat4);
        for (let i = 0; i < seg; i++) {
            const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
            const P = [[0, h, 0], [Math.cos(a1) * r1, h, Math.sin(a1) * r1], [Math.cos(a0) * r1, h, Math.sin(a0) * r1], [0, h, 0]];
            const pts = [];
            P.forEach(p => { _v.set(p[0], p[1], p[2]).applyMatrix4(mat4); pts.push(_v.x, _v.y, _v.z); });
            pushQuad(buf, pts, { x: _nv.x, y: _nv.y, z: _nv.z }, [0.5, 0.5, 0.6, 0.6, 0.4, 0.6, 0.5, 0.5], col);
        }
    }

    function bufToMesh(buf, material, name) {
        if (!buf.pos.length) return null;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.name = name;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
    }

    // ------------------------------------------------------------------
    // Модель склада
    // ------------------------------------------------------------------
    /**
     * p: { drop — на сколько нижний край юбки ниже верха помоста (м), rampDrop — на сколько конец трапа ниже помоста (м) }
     * mats: { solid, wall, roof } — три материала; для призрака во все три кладётся один и тот же.
     * Возвращает { group, meshes: {frame, floor, wall, roof, furn}, roofSlab: {len, th, z}, rampLen, rampAngle }
     */
    function buildStorage(p, mats, rnd) {
        const B = { frame: makeBuf(), floor: makeBuf(), wall: makeBuf(), roof: makeBuf(), furn: makeBuf() };
        const WOOD = [0.60, 0.47, 0.31], DARK = [0.36, 0.27, 0.18], LOG = [0.42, 0.31, 0.20];
        const ROOF = [0.50, 0.40, 0.29], ROOFD = [0.24, 0.19, 0.14], IRON = [0.12, 0.12, 0.13], GOLD = [0.78, 0.60, 0.2];
        const sh = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
        const kv = () => 0.84 + rnd() * 0.3;
        const box = (buf, sx, sy, sz, px, py, pz, col, rx, ry, rz) => pushBox(buf, sx, sy, sz, mat(px, py, pz, rx, ry, rz), col, rnd);
        const drop = Math.max(0.35, p.drop);

        // --- помост: доски поперёк (вдоль X), как на мосту ---
        const nP = 15, stepZ = (2 * HZ) / nP;
        for (let i = 0; i < nP; i++) {
            box(B.floor, 2 * HX - 0.04, 0.12, stepZ - 0.03, 0, -0.06, -HZ + stepZ * (i + 0.5), sh(WOOD, kv()));
        }
        [-1.7, 0, 1.7].forEach(x => box(B.frame, 0.16, 0.2, 2 * HZ - 0.2, x, -0.22, 0, sh(DARK, 1)));
        [-1, 1].forEach(s => box(B.frame, 0.24, 0.24, 2 * HZ + 0.04, s * (HX - 0.10), -0.24, 0, sh(LOG, kv())));   // лежни выступают за столбы на 2–3 см: нет общих плоскостей
        [-1, 1].forEach(s => box(B.frame, 2 * HX - 0.4, 0.24, 0.26, 0, -0.24, s * (HZ - 0.10), sh(LOG, kv())));
        // юбка: закрывает зазор между помостом и землёй
        const skH = drop + 0.1 - 0.12, skY = -0.12 - skH / 2;
        [-1, 1].forEach(s => {
            box(B.frame, 0.05, skH, 2 * HZ - 0.1, s * (HX - 0.03), skY, 0, sh(DARK, 0.9));
            box(B.frame, 2 * HX - 0.1, skH, 0.05, 0, skY, s * (HZ - 0.03), sh(DARK, 0.9));
        });

        // --- столбы, боковые борта, верхние обвязки ---
        const postH = EAVE_Y + drop + 0.1 - 0.05, postY = (EAVE_Y - drop - 0.1) / 2 - 0.025;   // верх столба на 5 см ниже балок — без совпадающих плоскостей
        [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
            box(B.frame, 0.24, postH, 0.24, sx * (HX - 0.12), postY, sz * (HZ - 0.12), sh(LOG, kv()));
        }));
        [-1, 1].forEach(s => {
            for (let i = 0; i < 6; i++) box(B.frame, 0.1, 0.19, 2 * HZ - 0.48, s * (HX - 0.1), 0.1 + i * 0.2, 0, sh(WOOD, kv()));
            box(B.frame, 0.18, 0.12, 2 * HZ - 0.24, s * (HX - 0.1), 1.28, 0, sh(WOOD, 1.05));          // поручень
            box(B.frame, 0.16, EAVE_Y, 0.16, s * (HX - 0.08), EAVE_Y / 2, 0, sh(LOG, kv()));           // средний столб
            box(B.frame, 0.22, 0.16, 2 * HZ + 0.1, s * (HX - 0.12), EAVE_Y - 0.02, 0, sh(LOG, kv()));        // обвязка (торцы выступают за столбы — нет общих плоскостей)
        });
        box(B.frame, 2 * HX + 0.1, 0.2, 0.24, 0, EAVE_Y - 0.1, HZ - 0.08, sh(LOG, 1));                        // фронтальная балка (торцы выступают)
        [-1.6, 0, 1.6].forEach(z => box(B.frame, 2 * HX - 0.2, 0.14, 0.14, 0, EAVE_Y + 0.08, z, sh(DARK, 1)));
        // раскосы у входа
        [-1, 1].forEach(s => box(B.frame, 0.12, 0.9, 0.1, s * (HX - 0.36), EAVE_Y - 0.55, HZ - 0.1, sh(LOG, 0.95), 0, 0, s * 0.7));

        // --- задняя стена: горизонтальные доски на всю высоту (исчезает, когда герой внутри) ---
        for (let i = 0; i < 12; i++) box(B.wall, 2 * HX - 0.46, 0.19, 0.1, 0, 0.1 + i * 0.2, -HZ + 0.1, sh(WOOD, kv()));

        // --- крыша ---
        const rise = RIDGE_Y - EAVE_Y, slopeLen = Math.hypot(EAVE_X, rise), th = Math.atan2(rise, EAVE_X);
        const roofW = 2 * HZ + 0.9;
        const nB = 18, zStep = roofW / nB;
        [-1, 1].forEach(s => {
            const S = mat(s * EAVE_X / 2, (EAVE_Y + RIDGE_Y) / 2 + 0.06, 0, 0, 0, -s * th);
            pushBox(B.roof, slopeLen + 0.1, 0.06, roofW, S, sh(ROOFD, 1), rnd);
            for (let i = 0; i < nB; i++) {
                pushBox(B.roof, slopeLen + 0.1, 0.05, zStep - 0.035, child(S, 0, 0.055, -roofW / 2 + zStep * (i + 0.5), 0, 0, 0), sh(ROOF, kv()), rnd);
            }
        });
        box(B.roof, 0.22, 0.22, roofW + 0.05, 0, RIDGE_Y + 0.1, 0, sh(LOG, 0.9), 0, 0, Math.PI / 4);
        // фронтоны (треугольники из вертикальных досок)
        const nG = 20, gw = (2 * HX) / nG;
        for (let i = 0; i < nG; i++) {
            const x = -HX + (i + 0.5) * gw;
            const h = rise * (1 - Math.abs(x) / EAVE_X) - 0.04;
            if (h < 0.1) continue;
            box(B.roof, gw - 0.025, h, 0.08, x, EAVE_Y + h / 2 - 0.02, HZ - 0.06, sh(WOOD, kv()));
            box(B.roof, gw - 0.025, h, 0.08, x, EAVE_Y + h / 2 - 0.02, -HZ + 0.06, sh(WOOD, kv()));
        }

        // --- трап ---
        const rampLen = Math.hypot(RAMP_L, p.rampDrop), rampAngle = Math.atan2(p.rampDrop, RAMP_L);
        const R = mat(0, 0, HZ - 0.02, rampAngle, 0, 0);
        const nR = Math.max(3, Math.round(rampLen / 0.31)), rStep = rampLen / nR;
        for (let i = 0; i < nR; i++) {
            pushBox(B.floor, 2 * RAMP_HX, 0.08, rStep - 0.03, child(R, 0, -0.04, rStep * (i + 0.5), 0, 0, 0), sh(WOOD, kv()), rnd);
            if (i % 2 === 1) pushBox(B.floor, 2 * RAMP_HX - 0.1, 0.03, 0.05, child(R, 0, 0.012, rStep * (i + 0.5), 0, 0, 0), sh(DARK, 1), rnd);
        }
        [-1, 1].forEach(s => pushBox(B.frame, 0.14, 0.2, rampLen, child(R, s * (RAMP_HX - 0.07), -0.17, rampLen / 2, 0, 0, 0), sh(LOG, kv()), rnd));

        // --- внутри: полки, сундук, ящики, бочки ---
        const crate = (x, y, z, s, ry) => {
            box(B.furn, s, s, s, x, y + s / 2, z, sh(WOOD, kv() * 0.95), 0, ry || 0, 0);
            box(B.furn, s + 0.02, 0.04, s + 0.02, x, y + 0.05 + 0.02, z, sh(DARK, 1), 0, ry || 0, 0);
            box(B.furn, s + 0.02, 0.04, s + 0.02, x, y + s - 0.05, z, sh(DARK, 1), 0, ry || 0, 0);
        };
        const sack = (x, y, z, r, h, col) => pushCyl(B.furn, r, r * 0.55, h, 8, mat(x, y, z, 0, rnd() * 3, 0), col, rnd);
        const barrel = (x, z) => {
            pushCyl(B.furn, 0.3, 0.3, 0.82, 12, mat(x, 0, z, 0, 0, 0), sh(WOOD, 0.9), rnd);
            [0.14, 0.62].forEach(y => pushCyl(B.furn, 0.315, 0.315, 0.05, 12, mat(x, y, z, 0, 0, 0), IRON, rnd));
        };
        const shelf = (cx) => {
            const z0 = -HZ + 0.35, w = 1.2, d = 0.5;
            [-1, 1].forEach(sx => [-1, 1].forEach(sz => box(B.furn, 0.07, 1.8, 0.07, cx + sx * (w / 2 - 0.04), 0.9, z0 + sz * (d / 2 - 0.04), sh(LOG, kv()))));
            [0.5, 1.0, 1.5].forEach(y => box(B.furn, w, 0.04, d, cx, y, z0, sh(WOOD, kv())));
        };
        shelf(-1.55); shelf(1.55);
        // левая полка: ящики и мешки
        crate(-1.9, 0.52, -HZ + 0.35, 0.38, 0.2); crate(-1.35, 0.52, -HZ + 0.35, 0.36, -0.15);
        sack(-1.85, 1.02, -HZ + 0.35, 0.17, 0.36, [0.78, 0.7, 0.55]); sack(-1.5, 1.02, -HZ + 0.35, 0.16, 0.32, [0.72, 0.64, 0.5]);
        crate(-1.6, 1.52, -HZ + 0.35, 0.34, 0.1);
        // правая полка
        sack(1.25, 0.52, -HZ + 0.35, 0.17, 0.36, [0.76, 0.68, 0.52]); sack(1.6, 0.52, -HZ + 0.35, 0.18, 0.4, [0.8, 0.72, 0.56]);
        crate(1.9, 1.02, -HZ + 0.35, 0.38, -0.2); crate(1.4, 1.02, -HZ + 0.35, 0.34, 0.25);
        crate(1.6, 1.52, -HZ + 0.35, 0.36, 0);
        // на полу
        crate(-1.75, 0, -1.62, 0.42, 0.25); crate(-1.3, 0, -1.58, 0.4, -0.1); crate(-1.65, 0.42, -1.6, 0.36, 0.5);
        barrel(1.15, -1.6); barrel(1.82, -1.55);   // не пересекаются (расстояние > диаметра обручей 0.63), иначе мерцание
        // сундук-хранилище
        const cz = CHEST_LZ;
        const CHESTW = [0.50, 0.30, 0.17];
        box(B.furn, 1.5, 0.5, 0.8, 0, 0.25, cz, sh(CHESTW, 1.0));
        box(B.furn, 1.5, 0.16, 0.8, 0, 0.58, cz, sh(CHESTW, 1.12));
        box(B.furn, 1.5, 0.08, 0.6, 0, 0.7, cz, sh(CHESTW, 1.18));
        [-0.55, 0, 0.55].forEach(x => box(B.furn, 0.1, 0.8, 0.85, x, 0.38, cz, IRON));
        box(B.furn, 1.56, 0.06, 0.86, 0, 0.5, cz, IRON);
        box(B.furn, 0.16, 0.22, 0.05, 0, 0.5, cz + 0.43, GOLD);
        // вывеска над сундуком
        box(B.furn, 1.1, 0.28, 0.05, 0, 1.55, -HZ + 0.17, sh(DARK, 1.1));
        box(B.furn, 1.0, 0.18, 0.02, 0, 1.55, -HZ + 0.2, sh(WOOD, 1.15));

        const group = new THREE.Group();
        group.name = 'building:storage';
        const meshes = {
            frame: bufToMesh(B.frame, mats.solid, 'frame'),
            floor: bufToMesh(B.floor, mats.solid, 'floor'),
            furn: bufToMesh(B.furn, mats.solid, 'furniture'),
            wall: bufToMesh(B.wall, mats.wall, 'wall'),
            roof: bufToMesh(B.roof, mats.roof, 'roof')
        };
        Object.keys(meshes).forEach(k => { if (meshes[k]) group.add(meshes[k]); });
        return { group, meshes, slopeLen, roofW, th, rampLen, rampAngle };
    }

    // ------------------------------------------------------------------
    // Настоящие брёвна: модель предмета «Бревно» (content/items/log, 3 варианта, лежит вдоль X, ~1,31 м, Ø≈0,28 м).
    // Каждое бревно ставится отрезком p0→p1 (вытягивается вдоль оси — кора тянется по волокнам, торец остаётся кругом),
    // все брёвна одной постройки запекаются в несколько мешей по (вариант, материал) — несколько вызовов отрисовки.
    // ------------------------------------------------------------------
    const LOG_L = 1.313, LOG_CY = 0.127;
    const _q = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _vx = new THREE.Vector3(1, 0, 0);
    const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Vector3(), _sc = new THREE.Vector3();
    const _M = new THREE.Matrix4(), _T = new THREE.Matrix4(), _F = new THREE.Matrix4(), _NM = new THREE.Matrix3(), _pv = new THREE.Vector3(), _nv2 = new THREE.Vector3();

    /** Разбирает модель «Бревно» в шаблон { variants: [[{geo, mat, m}]] } (async, один раз на менеджер). */
    function prepareLogTemplate(done) {
        const It = window.AveloraItems;
        const def = It && It.get && It.get('log');
        if (!def || !def.modelKey || !It.parseModel) { done(null); return; }
        It.parseModel(def.modelKey, (scene) => {
            if (!scene) { done(null); return; }
            const tpl = { variants: [] };
            It.splitVariants(scene).forEach(v => {
                v.updateMatrixWorld(true);
                const parts = [];
                v.traverse(o => { if (o.isMesh && o.geometry && o.material) parts.push({ geo: o.geometry, mat: o.material, m: o.matrixWorld.clone() }); });
                if (parts.length) tpl.variants.push(parts);
            });
            done(tpl.variants.length ? tpl : null);
        });
    }

    function disposeLogTemplate(tpl) {
        if (!tpl) return;
        tpl.variants.forEach(parts => parts.forEach(p => {
            if (p.geo) p.geo.dispose();
            [].concat(p.mat).forEach(m => {
                ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach(k => { if (m[k]) m[k].dispose(); });
                m.dispose();
            });
        }));
    }

    function makeLogBaker(tpl, matOverride) {
        const buckets = new Map();
        return {
            /** Бревно от p0 до p1 ([x,y,z]); th — толщина относительно оригинала; variant 0..2; flip — перевернуть торцами. */
            add(p0, p1, th, variant, flip) {
                _p0.set(p0[0], p0[1], p0[2]); _p1.set(p1[0], p1[1], p1[2]);
                _d.subVectors(_p1, _p0);
                const len = _d.length();
                if (len < 0.01) return;
                _d.multiplyScalar(1 / len);
                _q.setFromUnitVectors(_vx, _d);
                _c.addVectors(_p0, _p1).multiplyScalar(0.5);
                _sc.set(len / LOG_L, th, th);
                _M.compose(_c, _q, _sc);
                if (flip) { _qf.setFromAxisAngle(_vx, Math.PI); _F.makeRotationFromQuaternion(_qf); _M.multiply(_F); }
                _T.makeTranslation(0, -LOG_CY, 0);
                _M.multiply(_T);
                const vi = ((variant % tpl.variants.length) + tpl.variants.length) % tpl.variants.length;
                tpl.variants[vi].forEach(part => {
                    const mat = matOverride || part.mat;
                    const key = vi + '_' + (matOverride ? 'g' : mat.uuid);
                    let bk = buckets.get(key);
                    if (!bk) { bk = { mat, pos: [], nor: [], uv: [], idx: [], n: 0 }; buckets.set(key, bk); }
                    const full = new THREE.Matrix4().multiplyMatrices(_M, part.m);
                    _NM.getNormalMatrix(full);
                    const g = part.geo, pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv;
                    for (let i = 0; i < pa.count; i++) {
                        _pv.fromBufferAttribute(pa, i).applyMatrix4(full);
                        bk.pos.push(_pv.x, _pv.y, _pv.z);
                        if (na) { _nv2.fromBufferAttribute(na, i).applyMatrix3(_NM).normalize(); bk.nor.push(_nv2.x, _nv2.y, _nv2.z); } else bk.nor.push(0, 1, 0);
                        if (ua) bk.uv.push(ua.getX(i), ua.getY(i)); else bk.uv.push(0, 0);
                    }
                    if (g.index) { for (let i = 0; i < g.index.count; i++) bk.idx.push(g.index.getX(i) + bk.n); }
                    else { for (let i = 0; i < pa.count; i++) bk.idx.push(i + bk.n); }
                    bk.n += pa.count;
                });
            },
            meshes() {
                const out = [];
                buckets.forEach(bk => {
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
                    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
                    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
                    geo.setIndex(bk.idx);
                    geo.computeBoundingSphere();
                    const m = new THREE.Mesh(geo, bk.mat);
                    m.name = 'logs'; m.castShadow = true; m.receiveShadow = true;
                    out.push(m);
                });
                return out;
            }
        };
    }

    // ------------------------------------------------------------------
    // Модель пильни: навес на 4 столбах-брёвнах (односкатная крыша, ВХОД С ВЫСОКОГО КРАЯ), козлы с распиленным бревном,
    // штабель брёвен, стопка досок, колода.
    // Локальные координаты: центр основания, y = 0 — верх земли, +Z — высокий (передний) край.
    // Порядок, чтобы не было мерцания (z-fighting) при скрытой крыше: боковые балки ниже, поперечные лежат на них,
    // столбы заканчиваются внутри балок; плоскости на одной высоте не совпадают.
    // ------------------------------------------------------------------
    function buildSawmill(p, mats, rnd) {
        const FORGE = !!(p && p.forge);
        const B = { frame: makeBuf(), floor: makeBuf(), wall: makeBuf(), roof: makeBuf(), furn: makeBuf(), stone: makeBuf(), glow: makeBuf() };
        const WOOD = [0.62, 0.49, 0.33], PALE = [0.80, 0.68, 0.48], DARK = [0.36, 0.27, 0.18], LOG = [0.42, 0.31, 0.20];
        const ROOF = [0.48, 0.38, 0.27], ROOFD = [0.24, 0.19, 0.14], STEEL = [0.62, 0.64, 0.67];
        const sh = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
        const kv = () => 0.84 + rnd() * 0.3;
        const box = (buf, sx, sy, sz, px, py, pz, col, rx, ry, rz) => pushBox(buf, sx, sy, sz, mat(px, py, pz, rx, ry, rz), col, rnd);
        const baker = mats.logTpl ? makeLogBaker(mats.logTpl, mats.logMat) : null;
        let lv = 0;
        /** Бревно p0→p1. Без шаблона модели — запасной брус того же размера. */
        const lg = (p0, p1, th) => {
            if (baker) { baker.add(p0, p1, th, lv++ + Math.floor(rnd() * 3), rnd() < 0.5); return; }
            _p0.set(p0[0], p0[1], p0[2]); _p1.set(p1[0], p1[1], p1[2]);
            const len = _p0.distanceTo(_p1);
            _d.subVectors(_p1, _p0).normalize();
            _q.setFromUnitVectors(_vx, _d);
            const M4 = new THREE.Matrix4().compose(_c.addVectors(_p0, _p1).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
            pushBox(B.frame, len, 0.26 * th, 0.28 * th, M4, sh(LOG, kv()), rnd);
        };

        const PX = SX - 0.17, PZ = SZ - 0.17;                 // оси столбов
        const FRONT_Y = 2.8, BACK_Y = 2.2;                    // верх столбов: передний (вход) выше
        const MID = (FRONT_Y + BACK_Y) / 2;
        const topAt = (z) => MID + (z / PZ) * (FRONT_Y - BACK_Y) / 2;
        const ANG = Math.atan2(BACK_Y - FRONT_Y, 2 * PZ);     // < 0: передний край (+Z) выше

        // каркас из гладких брусьев. Столбы уходят в землю, верх спрятан внутри боковых балок;
        // боковые балки идут по скату, поперечные лежат на них, крыша — на поперечных (без зазоров и общих плоскостей).
        const PXB = SX - 0.12, PZB = SZ - 0.12;
        [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
            const top = topAt(sz * PZ);
            box(B.frame, 0.24, top + 0.6 - 0.14, 0.24, sx * PXB, (top - 0.14 - 0.6) / 2, sz * PZB, sh(LOG, kv()));
        }));
        const SLOPE_LEN = (2 * PZ + 0.6) / Math.cos(ANG);
        [-1, 1].forEach(sx => box(B.frame, 0.2, 0.2, SLOPE_LEN, sx * PXB, MID - 0.1, 0, sh(LOG, kv()), ANG, 0, 0));   // боковые балки по скату
        [-1, 1].forEach(sz => box(sz > 0 ? B.roof : B.frame, 2 * SX + 0.2, 0.2, 0.22, 0, topAt(sz * PZ) + 0.09, sz * PZ, sh(LOG, kv())));   // поперечные балки (передняя, высокая — часть «крыши»: исчезает вместе с ней)
        // нижние лежни по бокам и сзади (чуть утоплены); спереди вход свободен
        [-1, 1].forEach(sx => box(B.frame, 0.22, 0.36, 2 * PZB - 0.2, sx * PXB, -0.12, -0.1, sh(LOG, kv() * 0.85)));
        box(B.frame, 2 * PXB - 0.1, 0.36, 0.22, 0, -0.12, -PZB, sh(LOG, kv() * 0.85));

        // --- крыша: односкатная, высокий край — вход (+Z) ---
        {
            const run = 2 * SZ + 0.6, len = run / Math.cos(ANG) + 0.05;
            const W = 2 * SX + 0.6;
            const S = mat(0, MID + 0.2, 0, ANG, 0, 0);
            pushBox(B.roof, W, 0.06, len, S, sh(ROOFD, 1), rnd);
            const nB = 12, step = len / nB;
            for (let i = 0; i < nB; i++) {
                pushBox(B.roof, W, 0.05, step - 0.035, child(S, 0, 0.055, -len / 2 + step * (i + 0.5), 0, 0, 0), sh(ROOF, kv()), rnd);
            }
            pushBox(B.roof, W + 0.04, 0.14, 0.16, child(S, 0, 0.1, len / 2 - 0.05, 0, 0, 0), sh(LOG, 0.9), rnd);   // доска по высокому краю
        }

        if (!FORGE) {
        // --- козлы (2 шт.) и целое бревно на них ---
        const trestle = (x) => {
            box(B.furn, 0.16, 0.16, 0.95, x, 0.93, 0, sh(DARK, 1.1));
            [-1, 1].forEach(s => box(B.furn, 0.14, 0.95, 0.14, x, 0.45, s * 0.34, sh(LOG, kv()), -s * 0.32, 0, 0));
            box(B.furn, 0.09, 0.09, 0.62, x, 0.38, 0, sh(WOOD, 1));
        };
        trestle(-1.15); trestle(1.15);
        lg([-1.6, 1.145, 0], [1.6, 1.145, 0.02], 1.15);                           // целое бревно на козлах
        // опилки и щепки у козел
        for (let i = 0; i < 9; i++) {
            const a = rnd() * Math.PI * 2, d = 0.15 + rnd() * 0.7;
            box(B.furn, 0.08 + rnd() * 0.1, 0.03, 0.05 + rnd() * 0.06, 0.1 + Math.cos(a) * d * 1.6, 0.03, Math.sin(a) * d * 0.9 + 0.1, sh(PALE, 0.8 + rnd() * 0.3), 0, rnd() * 3, 0);
        }

        // --- штабель брёвен слева сзади, стопка досок справа сзади, колода с топором спереди ---
        lg([-1.85, 0.13, -0.92], [-0.45, 0.13, -0.97], 1.0);
        lg([-1.85, 0.13, -0.6], [-0.45, 0.13, -0.58], 1.0);
        lg([-1.8, 0.34, -0.76], [-0.5, 0.34, -0.78], 0.95);
        for (let i = 0; i < 9; i++) {
            box(B.furn, 1.2, 0.05, 0.3, 1.2, 0.2 + i * 0.065, -0.92, sh(PALE, 0.88 + rnd() * 0.18), 0, (rnd() - 0.5) * 0.04, 0);
            if (i % 3 === 0) box(B.furn, 0.1, 0.04, 0.34, 1.2 + (i % 2 ? 0.4 : -0.4), 0.17 + i * 0.065 - 0.02, -0.92, sh(DARK, 1));
        }
        [-0.45, 0.45].forEach(x => box(B.furn, 0.1, 0.18, 0.34, 1.2 + x * 1.1, 0.09, -0.92, sh(DARK, 1)));
        lg([-1.2, 0.0, 1.0], [-1.2, 0.5, 1.0], 1.15);                         // колода — торец бревна


        } else {
        // ---------------- кузня: каменная задняя стена, горн с колпаком и трубой, наковальня, мехи, бадья ----------------
        const STONE = [0.80, 0.78, 0.74], STONED = [0.58, 0.57, 0.55], SOOT = [0.20, 0.19, 0.19], IRON = [0.34, 0.35, 0.39];
        const sb = (sx, sy, sz, px, py, pz, col, ry, rx, rz) => pushBox(B.stone, sx, sy, sz, mat(px, py, pz, rx, ry, rz), col, rnd);
        const gb = (sx, sy, sz, px, py, pz, col, ry) => pushBox(B.glow, sx, sy, sz, mat(px, py, pz, 0, ry || 0, 0), col, rnd);
        const LEATHER = [0.40, 0.25, 0.15];
        // задняя стена
        sb(2 * SX - 0.5, 2.0, 0.32, 0, 1.0, -SZ + 0.2, sh(STONE, 0.95));
        sb(2 * SX - 0.5, 0.14, 0.4, 0, 2.02, -SZ + 0.2, sh(STONED, 1));
        // горн: основание, плита, бортик, угли
        sb(1.8, 0.85, 0.9, 0, 0.425, -0.78, sh(STONE, 1));
        sb(1.9, 0.1, 1.0, 0, 0.9, -0.78, sh(STONED, 1));
        sb(1.0, 0.14, 0.12, 0, 1.0, -0.45, sh(STONE, 0.9));
        [-1, 1].forEach(sx => sb(0.12, 0.14, 0.62, sx * 0.56, 1.0, -0.78, sh(STONE, 0.9)));
        gb(0.96, 0.06, 0.56, 0, 0.96, -0.8, [1.0, 0.42, 0.08]);
        for (let i = 0; i < 9; i++) {
            const hot = rnd() < 0.55;
            gb(0.1 + rnd() * 0.12, 0.07 + rnd() * 0.05, 0.1 + rnd() * 0.1, (rnd() - 0.5) * 0.8, 1.0 + rnd() * 0.04, -0.8 + (rnd() - 0.5) * 0.4, hot ? [1.0, 0.72, 0.22] : [0.85, 0.28, 0.05], rnd() * 3);
        }
        for (let i = 0; i < 5; i++) sb(0.12 + rnd() * 0.08, 0.06, 0.1 + rnd() * 0.06, (rnd() - 0.5) * 0.9, 0.99, -0.62 + rnd() * 0.12, sh(SOOT, 0.7 + rnd() * 0.4), rnd() * 3);
        // колпак на опорах и труба сквозь крышу
        [-1, 1].forEach(sx => sb(0.22, 0.6, 0.5, sx * 0.68, 1.25, -0.9, sh(STONE, 0.95)));
        sb(1.6, 0.14, 0.9, 0, 1.6, -0.92, sh(STONED, 1));
        sb(1.2, 0.5, 0.6, 0, 1.92, -1.05, sh(STONE, 0.95));
        sb(0.8, 0.5, 0.5, 0, 2.4, -1.1, sh(STONE, 0.95));
        sb(0.56, 1.3, 0.44, 0, 3.3, -1.12, sh(STONE, 0.9));
        sb(0.7, 0.1, 0.56, 0, 4.0, -1.12, sh(STONED, 1));
        // наковальня на колоде
        pushCyl(B.furn, 0.3, 0.27, 0.5, 10, mat(0, 0, 0.2, 0, 0, 0), sh(LOG, 1.05), rnd);
        sb(0.40, 0.08, 0.26, 0, 0.54, 0.2, sh(IRON, 1));
        sb(0.20, 0.14, 0.18, 0, 0.65, 0.2, sh(IRON, 1.05));
        sb(0.66, 0.11, 0.28, 0, 0.775, 0.2, sh(IRON, 1.15));
        sb(0.2, 0.07, 0.17, 0.42, 0.78, 0.2, sh(IRON, 1.15));
        sb(0.12, 0.05, 0.1, 0.55, 0.775, 0.2, sh(IRON, 1.15));
        gb(0.30, 0.03, 0.05, -0.12, 0.84, 0.17, [1.0, 0.36, 0.08], 0.2);                  // раскалённая заготовка
        box(B.furn, 0.42, 0.04, 0.04, 0.12, 0.85, 0.37, sh(WOOD, 0.9), 0, 0.5, 0);        // молот: рукоять
        sb(0.13, 0.08, 0.08, 0.28, 0.86, 0.31, sh(IRON, 1.1), 0.5);                       // молот: боёк
        // мехи слева от горна
        box(B.furn, 0.56, 0.06, 0.8, -1.35, 0.5, -0.75, sh(WOOD, 1));
        box(B.furn, 0.56, 0.06, 0.8, -1.35, 0.82, -0.7, sh(WOOD, 1.05), 0, 0, 0.0);
        box(B.furn, 0.5, 0.32, 0.7, -1.35, 0.66, -0.73, sh(LEATHER, 1), 0, 0, 0);
        sb(0.7, 0.07, 0.07, -1.0, 0.62, -0.75, sh(IRON, 1));
        box(B.furn, 0.08, 0.5, 0.08, -1.35, 0.25, -0.5, sh(LOG, 1)); box(B.furn, 0.08, 0.5, 0.08, -1.35, 0.25, -1.0, sh(LOG, 1));
        box(B.furn, 0.04, 0.5, 0.04, -1.35, 1.1, -0.2, sh(WOOD, 0.8), 0.5, 0, 0);       // рукоять мехов
        // бадья для закалки справа-спереди
        box(B.furn, 0.96, 0.4, 0.06, 1.32, 0.2, 0.24, sh(WOOD, 0.9)); box(B.furn, 0.96, 0.4, 0.06, 1.32, 0.2, 0.68, sh(WOOD, 0.9));
        [-1, 1].forEach(s => box(B.furn, 0.06, 0.4, 0.5, 1.32 + s * 0.45, 0.2, 0.46, sh(WOOD, 0.85)));
        box(B.furn, 0.9, 0.05, 0.5, 1.32, 0.04, 0.46, sh(DARK, 1));
        sb(0.84, 0.02, 0.38, 1.32, 0.32, 0.46, [0.22, 0.38, 0.5]);
        [-0.3, 0.3].forEach(dx => box(B.furn, 0.04, 0.05, 0.5, 1.32 + dx, 0.42, 0.46, sh(IRON, 1)));   // обручи
        // верстак справа у стены: клещи, слитки
        box(B.furn, 0.9, 0.07, 0.5, 1.4, 0.8, -1.0, sh(WOOD, 1));
        [-1, 1].forEach(s => box(B.furn, 0.09, 0.8, 0.09, 1.4 + s * 0.38, 0.4, -1.0, sh(LOG, 1)));
        for (let i = 0; i < 4; i++) sb(0.3, 0.06, 0.13, 1.2 + (i % 2) * 0.05, 0.87 + i * 0.065, -1.0, sh(IRON, 0.9 + i * 0.07), (i % 2) * 0.1);
        sb(0.04, 0.5, 0.04, 1.62, 0.87, -0.9, sh(IRON, 1), 0, 0, 1.3);
        // инструмент на стене слева
        [-1.55, -1.3, -1.05].forEach((x, i) => { sb(0.05, 0.5 - i * 0.06, 0.03, x, 1.45, -1.28, sh(IRON, 1)); sb(0.12, 0.09, 0.05, x, 1.2 - i * 0.03, -1.28, sh(IRON, 1.1)); });
        // уголь кучей и дрова
        for (let i = 0; i < 14; i++) sb(0.1 + rnd() * 0.12, 0.08 + rnd() * 0.08, 0.1 + rnd() * 0.1, -1.55 + (rnd() - 0.5) * 0.6, 0.05 + rnd() * 0.12, 0.85 + (rnd() - 0.5) * 0.5, sh(SOOT, 0.6 + rnd() * 0.6), rnd() * 3);
        lg([-1.8, 0.13, 0.35], [-0.95, 0.13, 0.33], 0.8);
        lg([-1.8, 0.13, 0.05], [-0.95, 0.13, 0.04], 0.8);
        lg([-1.75, 0.32, 0.2], [-1.0, 0.32, 0.19], 0.75);
        }

        const group = new THREE.Group();
        group.name = FORGE ? 'building:forge' : 'building:sawmill';
        const meshes = {
            frame: bufToMesh(B.frame, mats.solid, 'frame'),
            floor: bufToMesh(B.floor, mats.solid, 'floor'),
            furn: bufToMesh(B.furn, mats.solid, 'furniture'),
            wall: null,
            roof: bufToMesh(B.roof, mats.roof, 'roof')
        };
        Object.keys(meshes).forEach(k => { if (meshes[k]) group.add(meshes[k]); });
        if (B.stone.pos.length) { const m = bufToMesh(B.stone, mats.stone || mats.solid, 'stone'); group.add(m); }
        if (B.glow.pos.length) { const m = bufToMesh(B.glow, mats.glow || mats.solid, 'glow'); m.castShadow = false; m.receiveShadow = false; group.add(m); }
        if (baker) baker.meshes().forEach(m => group.add(m));
        return { group, meshes, slopeLen: 0, roofW: 0, th: 0, rampLen: 0, rampAngle: 0 };
    }

    function buildModel(def, p, mats, rnd) {
        if (def.mesh) {   // готовая модель (content/props/<mesh>): подгружается асинхронно в пустую группу
            const group = new THREE.Group();
            group.name = 'building:' + def.id;
            if (mats.attachMesh) mats.attachMesh(group, def);
            return { group, meshes: {}, slopeLen: 0, roofW: 0, th: 0, rampLen: 0, rampAngle: 0 };
        }
        return def.kind === 'station' ? buildSawmill({ forge: def.id === 'forge' }, mats, rnd) : buildStorage(p, mats, rnd);
    }

    // ------------------------------------------------------------------
    // Интерфейс (DOM создаётся один раз и живёт между локациями)
    // ------------------------------------------------------------------
    const UI = {
        mgr: null, built: false, panelOpen: false,
        els: {},

        build() {
            if (this.built) return;
            this.built = true;
            const E = this.els;
            E.btn = document.getElementById('build-btn');

            const panel = document.createElement('div');
            panel.id = 'build-panel';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-hidden', 'true');
            panel.innerHTML = `
                <div class="inventory-header">
                    <div class="inventory-title">Строительство</div>
                    <button type="button" id="build-close" title="Закрыть" aria-label="Закрыть">×</button>
                </div>
                <div id="build-scroll">
                <div class="build-section">Постройки</div>
                <div id="build-cards"></div>
                <div class="build-section">Построено здесь</div>
                <div id="build-list"></div>
                <div class="build-hint">Возводить можно только на территории лагеря. Перед установкой нужно выбрать место: R — повернуть, ЛКМ — построить, Esc — отмена. Клавиша B — открыть/закрыть меню.</div>
                </div>`;
            (document.getElementById('game-ui') || document.body).appendChild(panel);
            E.panel = panel;
            E.cards = panel.querySelector('#build-cards');
            E.list = panel.querySelector('#build-list');
            panel.querySelector('#build-close').addEventListener('click', (e) => { e.stopPropagation(); this.closePanel(); });
            panel.addEventListener('click', (e) => e.stopPropagation());

            const bar = document.createElement('div');
            bar.id = 'build-bar';
            bar.innerHTML = `
                <div id="build-bar-title"></div>
                <div id="build-bar-status"></div>
                <div class="build-bar-btns">
                    <button type="button" id="build-rot" title="Повернуть (R)">⟳ Повернуть</button>
                    <button type="button" id="build-align" title="Выровнять по сетке: вход на север, дальше по кругу на 90° (G)">⊞ По сетке</button>
                    <button type="button" id="build-ok" title="Построить (ЛКМ / Enter)">✔ Построить</button>
                    <button type="button" id="build-cancel" title="Отмена (Esc)">✖ Отмена</button>
                </div>`;
            (document.getElementById('game-ui') || document.body).appendChild(bar);
            E.bar = bar;
            E.barTitle = bar.querySelector('#build-bar-title');
            E.barStatus = bar.querySelector('#build-bar-status');
            bar.addEventListener('click', (e) => e.stopPropagation());
            bar.querySelector('#build-rot').addEventListener('click', (e) => { e.stopPropagation(); if (this.mgr) this.mgr.rotateBy(Math.PI / 12); });
            bar.querySelector('#build-align').addEventListener('click', (e) => { e.stopPropagation(); if (this.mgr) this.mgr.alignGrid(); });
            bar.querySelector('#build-ok').addEventListener('click', (e) => { e.stopPropagation(); if (this.mgr) this.mgr.commit(); });
            bar.querySelector('#build-cancel').addEventListener('click', (e) => { e.stopPropagation(); if (this.mgr) this.mgr.cancelPlacing(); });

            if (E.btn) {
                E.btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.mgr && this.mgr.game.ui && this.mgr.game.ui.closeMicroMenu) this.mgr.game.ui.closeMicroMenu();
                    if (this.mgr && this.mgr.canUse()) this.togglePanel();
                });
            }

            window.addEventListener('keydown', (e) => {
                const m = this.mgr;
                if (!m || !m.cfg) return;
                const t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
                if (e.code === 'KeyB' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    if (m.canUse()) this.togglePanel();
                } else if (e.code === 'KeyG' && m.placing && !e.repeat) {
                    m.alignGrid();
                } else if (e.code === 'KeyR' && m.placing) {
                    m.keyRotate = e.shiftKey ? -1 : 1;
                } else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && m.placing && !e.repeat) {
                    e.preventDefault();
                    m.commit();
                }
            });
            window.addEventListener('keyup', (e) => { if (e.code === 'KeyR' && this.mgr) this.mgr.keyRotate = 0; });
            window.addEventListener('blur', () => { if (this.mgr) this.mgr.keyRotate = 0; });
            window.addEventListener('pointermove', (e) => {
                const m = this.mgr;
                if (!m || !m.placing || e.pointerType === 'touch') return;
                const sel = window.AVELORA_UI_SELECTOR;
                if (sel && e.target && e.target.closest && e.target.closest(sel)) return;
                m.pointerTo(e.clientX, e.clientY);
            });
        },

        attach(mgr) {
            this.build();
            this.mgr = mgr;
            this.closePanel();
            this.showBar(false);
            if (this.els.btn) this.els.btn.style.display = (mgr.cfg && (mgr.cfg.types || []).length) ? '' : 'none';
        },

        detach(mgr) {
            if (this.mgr !== mgr) return;
            this.mgr = null;
            this.closePanel();
            this.showBar(false);
            if (this.els.btn) this.els.btn.style.display = 'none';
        },

        togglePanel() { if (this.panelOpen) this.closePanel(); else this.openPanel(); },

        openPanel() {
            if (!this.mgr || !this.mgr.cfg) return;
            if (this.mgr.placing) this.mgr.cancelPlacing();
            this.panelOpen = true;
            this.els.panel.classList.add('open');
            this.els.panel.setAttribute('aria-hidden', 'false');
            if (this.els.btn) this.els.btn.classList.add('active');
            this.render();
        },

        closePanel() {
            this.panelOpen = false;
            if (!this.els.panel) return;
            this.els.panel.classList.remove('open');
            this.els.panel.setAttribute('aria-hidden', 'true');
            if (this.els.btn) this.els.btn.classList.remove('active');
        },

        showBar(on) {
            if (this.els.bar) this.els.bar.classList.toggle('open', !!on);
        },

        setStatus(ok, text) {
            if (!this.els.barStatus) return;
            this.els.barStatus.textContent = text;
            this.els.barStatus.className = ok ? 'ok' : 'bad';
        },

        render() {
            const m = this.mgr;
            if (!m || !this.panelOpen) return;
            const st = m.game.gameState;
            const Items = window.AveloraItems;
            const E = this.els;
            E.cards.innerHTML = '';
            (m.cfg.types || []).forEach(id => {
                const def = TYPES[id];
                if (!def) return;
                const card = document.createElement('div');
                card.className = 'build-card';
                let canBuild = true;
                const costHtml = def.cost.map(c => {
                    const it = Items.get(c.item);
                    const have = st ? st.inventory.count(c.item) : 0;
                    const okc = FREE_BUILD || have >= c.count;
                    if (!okc) canBuild = false;
                    return `<span class="${okc ? 'ok' : 'bad'}">${it ? it.name : c.item} ${have}/${c.count}</span>`;
                }).join('');
                card.innerHTML = `
                    <div class="build-card-icon"><svg viewBox="0 0 48 48" fill="none" stroke="#efcf7a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${def.icon || ''}</svg></div>
                    <div class="build-card-body">
                        <div class="build-card-name">${def.name}</div>
                        <div class="build-card-desc">${def.desc}</div>
                        <div class="build-cost">${FREE_BUILD ? '<span class="ok">Бесплатно (тест)</span>' : costHtml}</div>
                        <button type="button" class="build-go"${canBuild ? '' : ' disabled title="Не хватает материалов"'}>Разместить</button>
                    </div>`;
                card.querySelector('.build-go').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!canBuild) return;
                    this.closePanel();
                    m.startPlacing(id);
                });
                E.cards.appendChild(card);
            });

            E.list.innerHTML = '';
            const list = m.instances;
            if (!list.length) {
                E.list.innerHTML = '<div class="build-empty">Пока ничего не построено.</div>';
            } else {
                list.forEach(inst => {
                    const def = TYPES[inst.type];
                    const row = document.createElement('div');
                    row.className = 'build-row';
                    const used = m.storageUsed(inst);
                    const note = def.kind === 'station' ? 'доски — в сумке, «Создание»' : `занято ${used.used}/${used.total}`;
                    row.innerHTML = `<div class="build-row-name">${def.name} №${inst.uid}<span>${note}</span></div><div class="build-row-btns"><button type="button" class="build-mv">Переместить</button><button type="button" class="build-del">Снести</button></div>`;
                    row.querySelector('.build-mv').addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.closePanel();
                        m.move(inst.uid);
                    });
                    row.querySelector('.build-del').addEventListener('click', (e) => {
                        e.stopPropagation();
                        m.demolish(inst.uid);
                        this.render();
                    });
                    E.list.appendChild(row);
                });
            }
        }
    };

    // ------------------------------------------------------------------
    // Менеджер построек одной локации
    // ------------------------------------------------------------------
    class AveloraBuilding {
        constructor(game, location) {
            this.game = game;
            this.location = location;
            this.cfg = location.building || null;
            this.terrain = game.terrain;
            this.pathfinder = game.pathfinder;
            this.root = game.locationRoot;
            this.instances = [];
            this.floorProxies = [];
            this.placing = null;
            this.keyRotate = 0;
            this.disposed = false;
            this._ray = new THREE.Raycaster();
            this._ndc = new THREE.Vector2();
            this._uiT = 0;
            this._proxyMat = new THREE.MeshBasicMaterial({ visible: false });
            this.tex = null;

            UI.attach(this);
            if (!this.cfg) return;
            this.tex = makeWoodTexture();
            this.mats = {
                solid: new THREE.MeshStandardMaterial({ map: this.tex, vertexColors: true, roughness: 0.92, metalness: 0 }),
                wall: new THREE.MeshStandardMaterial({ map: this.tex, vertexColors: true, roughness: 0.92, metalness: 0, transparent: true }),
                roof: new THREE.MeshStandardMaterial({ map: this.tex, vertexColors: true, roughness: 0.92, metalness: 0, transparent: true }),
                stone: new THREE.MeshStandardMaterial({ map: makeStoneTexture(), vertexColors: true, roughness: 0.95, metalness: 0 }),
                glow: new THREE.MeshBasicMaterial({ vertexColors: true })
            };
            this.logTpl = null;
            // настоящие брёвна: сначала разбираем модель, потом ставим сохранённые постройки
            prepareLogTemplate((tpl) => {
                if (this.disposed) { disposeLogTemplate(tpl); return; }
                this.logTpl = tpl;
                this.mats.logTpl = tpl;
                const st = game.gameState;
                if (st) st.buildingsOf(location.id).forEach(b => { try { this.spawn(b); } catch (err) { console.error('[Avelora] building spawn failed', b, err); } });
                // постройки, стоящие в локации всегда (кузня у кузнеца): не в сохранении, не сносятся, не переносятся
                (this.cfg.fixed || []).forEach((b, i) => { try { this.spawn({ uid: -(i + 1), type: b.type, x: b.x, z: b.z, r: b.r || 0, fixed: true }); } catch (err) { console.error('[Avelora] fixed building failed', b, err); } });
            });
        }

        canUse() {
            const g = this.game;
            return !!(this.cfg && (this.cfg.types || []).length && g.isReady && !g.isPaused && !g.isTransitioning && g.gameState && !(g.combat && g.combat.isDead));
        }

        warn(text) { if (this.game.ui) this.game.ui.floatText(text, 'warn'); }

        // -------------------- геометрия посадки --------------------
        toWorld(x, z, r, lx, lz) {
            const c = Math.cos(r), s = Math.sin(r);
            return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
        }

        /** Высота помоста и параметры юбки/трапа по рельефу под постройкой (детерминированно). */
        fit(x, z, r, def) {
            const T = this.terrain;
            if (def && def.kind === 'station') {
                let smn = Infinity, smx = -Infinity;
                for (let i = 0; i <= 4; i++) {
                    for (let j = 0; j <= 4; j++) {
                        const fx = def.fp ? def.fp.hx : SX, fz = def.fp ? def.fp.hz : SZ;
                        const w = this.toWorld(x, z, r, -fx + i * fx / 2, -fz + j * fz / 2);
                        const h = T.getRawHeightAt(w.x, w.z);
                        if (h < smn) smn = h;
                        if (h > smx) smx = h;
                    }
                }
                return { mn: smn, mx: smx, rmn: smn, rmx: smx, deckY: smx - 0.04, drop: 0, endY: smx, gEnd: smx };
            }
            let mn = Infinity, mx = -Infinity;
            for (let i = 0; i <= 4; i++) {
                for (let j = 0; j <= 4; j++) {
                    const w = this.toWorld(x, z, r, -HX + i * HX / 2, -HZ + j * HZ / 2);
                    const h = T.getRawHeightAt(w.x, w.z);
                    if (h < mn) mn = h;
                    if (h > mx) mx = h;
                }
            }
            let rmn = Infinity, rmx = -Infinity;
            for (let i = 0; i <= 2; i++) {
                for (let j = 1; j <= 3; j++) {
                    const w = this.toWorld(x, z, r, -RAMP_HX + i * RAMP_HX, HZ + RAMP_L * j / 3);
                    const h = T.getRawHeightAt(w.x, w.z);
                    if (h < rmn) rmn = h;
                    if (h > rmx) rmx = h;
                }
            }
            const e = this.toWorld(x, z, r, 0, HZ + RAMP_L);
            const gEnd = T.getRawHeightAt(e.x, e.z);
            const deckY = mx + 0.30;
            return { mn, mx, rmn: Math.min(rmn, mn), rmx: Math.max(rmx, mx), deckY, drop: deckY - mn + 0.15, endY: gEnd - 0.12, gEnd };
        }

        /** Можно ли поставить постройку здесь? { ok, reason, fit } */
        validate(def, x, z, r) {
            const area = this.cfg && this.cfg.area;
            const fail = (reason) => ({ ok: false, reason });
            const F = def.fp, hx = F.hx, hz = F.hz, front = F.front;
            const isStation = def.kind === 'station';
            if (area) {
                const corners = [[-hx, -hz], [hx, -hz], [-hx, hz + front], [hx, hz + front]];
                for (const c of corners) {
                    const w = this.toWorld(x, z, r, c[0], c[1]);
                    if (Math.abs(w.x - area.x) > area.hx || Math.abs(w.z - area.z) > area.hz) return fail('Слишком далеко от лагеря — стройте ближе');
                }
            }
            const f = this.fit(x, z, r, def);
            if (f.mn < 0.3) return fail('Здесь слишком сыро — берег или вода');
            if (isStation) {
                if (f.mx - f.mn > 0.28) return fail('Слишком неровная земля — нужна ровная площадка');
            } else {
                if (f.rmx - f.rmn > 0.55) return fail('Слишком неровная земля');
                if ((f.deckY - f.gEnd) / RAMP_L > 0.42) return fail('Слишком крутой въезд на помост');
            }

            // ходимость клеток под постройкой (деревья, камни, вода, другие постройки)
            const pf = this.pathfinder;
            const c = Math.cos(r), s = Math.sin(r);
            const reach = Math.hypot(hx + 0.9, hz + front + 0.9) + 0.6;
            const g0 = pf.worldToGrid(x - reach, z - reach), g1 = pf.worldToGrid(x + reach, z + reach);
            for (let gz = g0.z; gz <= g1.z; gz++) {
                for (let gx = g0.x; gx <= g1.x; gx++) {
                    const w = pf.gridToWorld(gx, gz);
                    const dx = w.x - x, dz = w.z - z;
                    const lx = dx * c - dz * s, lz = dx * s + dz * c;
                    // клетка пересекается с зоной постройки; центр клетки внутри зоны с запасом
                    const inDeck = Math.abs(lx) <= hx + 0.5 && lz >= -hz - 0.5 && lz <= hz + 0.5;
                    const inRamp = front > 0 && Math.abs(lx) <= RAMP_HX + 0.4 && lz > hz && lz <= hz + front + 0.4;
                    if (!inDeck && !inRamp) continue;
                    if (!pf.isWalkable(gx, gz)) return fail('Мешает препятствие — дерево, камень или другая постройка');
                }
            }
            // растения и предметы, которые не закрывают клетки навигации
            const env = this.game.environment;
            if (env && env.objects) {
                let hit = false;
                env.objects.forEach(o => {
                    if (hit || o.visible === false || o.x === undefined) return;
                    const dx = o.x - x, dz = o.z - z;
                    if (dx * dx + dz * dz > 64) return;
                    const lx = dx * c - dz * s, lz = dx * s + dz * c;
                    if (Math.abs(lx) <= hx + 0.5 && lz >= -hz - 0.5 && lz <= hz + front + 0.5) hit = true;
                });
                if (hit) return fail('Мешают растения или камни');
            }
            const wo = this.game.worldObjects;
            if (wo) {
                const inFoot = (px, pz) => {
                    const dx = px - x, dz = pz - z;
                    const lx = dx * c - dz * s, lz = dx * s + dz * c;
                    return Math.abs(lx) <= hx + 0.6 && lz >= -hz - 0.6 && lz <= hz + front + 0.6;
                };
                if (wo.props.some(p => inFoot(p.x, p.z))) return fail('Мешает другой объект');
                let pile = false;
                wo.piles.forEach(p => { if (p.group && inFoot(p.data.x, p.data.z)) pile = true; });
                if (pile) return fail('На земле лежат предметы — уберите их');
            }
            const ch = this.game.character;
            if (ch) {
                const dx = ch.position.x - x, dz = ch.position.z - z;
                const lx = dx * c - dz * s, lz = dx * s + dz * c;
                if (Math.abs(lx) <= hx + 0.9 && lz >= -hz - 0.9 && lz <= hz + front + 0.9) return fail('Вы стоите в зоне постройки — отойдите');
            }
            // пересечение с уже построенными: точки новой площадки против площадок (с запасом) остальных
            for (const inst of this.instances) {
                const G = inst.fp, pc = inst.platform.cos, ps = inst.platform.sin;
                const mg = 0.6;
                for (let i = -hx; i <= hx + 1e-6; i += 0.5) {
                    for (let j = -hz; j <= hz + front + 1e-6; j += 0.5) {
                        const wx = x + i * c + j * s, wz = z - i * s + j * c;
                        const dx = wx - inst.x, dz = wz - inst.z;
                        const lx = dx * pc - dz * ps, lz = dx * ps + dz * pc;
                        if (Math.abs(lx) <= G.hx + mg && lz >= -G.hz - mg && lz <= G.hz + G.front + mg) return fail('Слишком близко к другой постройке');
                    }
                }
            }
            return { ok: true, reason: 'Можно строить', fit: f };
        }

        // -------------------- постройка --------------------
        spawn(b) {
            const def = TYPES[b.type];
            if (!def) return null;
            if (def.kind === 'station') return this.spawnStation(b, def);
            const f = this.fit(b.x, b.z, b.r, def);
            const rampDrop = Math.max(0.05, f.deckY - f.endY);
            const rnd = mulberry32(((b.uid * 2654435761) ^ Math.round(b.x * 100) ^ Math.round(b.z * 7919)) >>> 0);
            const model = buildStorage({ drop: f.drop, rampDrop }, this.mats, rnd);
            if (model.meshes.wall) model.meshes.wall.material = this.mats.wall.clone();
            if (model.meshes.roof) model.meshes.roof.material = this.mats.roof.clone();
            const g = model.group;
            g.position.set(b.x, f.deckY, b.z);
            g.rotation.y = b.r;
            this.root.add(g);

            // платформа для высоты ходьбы
            const platform = {
                id: 'building:' + b.uid, x: b.x, z: b.z, cos: Math.cos(b.r), sin: Math.sin(b.r),
                hx: HX, hz: HZ, y: f.deckY, rampLen: RAMP_L, rampHx: RAMP_HX, endY: f.endY,
                reach2: Math.pow(Math.hypot(HX, HZ + RAMP_L) + 0.8, 2)
            };
            this.terrain.addPlatform(platform);

            // невидимые прокси для камеры и кликов
            const pm = this._proxyMat;
            const addBox = (parent, sx, sy, sz, px, py, pz, rx, ry, rz) => {
                const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), pm);
                m.position.set(px, py, pz);
                m.rotation.set(rx || 0, ry || 0, rz || 0);
                parent.add(m);
                return m;
            };
            const low = new THREE.Group(); low.name = 'cam-low'; g.add(low);
            const shell = new THREE.Group(); shell.name = 'cam-shell'; g.add(shell);
            const deckBox = addBox(low, 2 * HX, 0.5, 2 * HZ, 0, -0.25, 0);
            const rampBox = addBox(low, 2 * RAMP_HX, 0.1, model.rampLen, 0, 0, 0);
            {   // трап: центр на половине длины вдоль наклона
                const R = mat(0, 0, HZ - 0.02, model.rampAngle, 0, 0);
                const cpos = new THREE.Vector3(0, -0.05, model.rampLen / 2).applyMatrix4(R);
                rampBox.position.copy(cpos);
                rampBox.rotation.set(model.rampAngle, 0, 0);
            }
            [-1, 1].forEach(s => addBox(shell, 0.14, 1.28, 2 * HZ, s * (HX - 0.1), 0.64, 0));   // борта блокируют камеру только пока герой снаружи — иначе при вращении камера «прыгает» об них
            addBox(shell, 2 * HX, EAVE_Y, 0.14, 0, EAVE_Y / 2, -HZ + 0.1);
            // the open front and the open upper sides are sealed for the camera while the hero is outside:
            // the camera stays outside the shed instead of sitting under the roof
            addBox(shell, 2 * HX, RIDGE_Y, 0.1, 0, RIDGE_Y / 2, HZ);
            [-1, 1].forEach(s => addBox(shell, 0.1, EAVE_Y - 1.28, 2 * HZ, s * HX, (1.28 + EAVE_Y) / 2, 0));
            [-1, 1].forEach(s => {
                addBox(shell, model.slopeLen + 0.1, 0.14, model.roofW, s * EAVE_X / 2, (EAVE_Y + RIDGE_Y) / 2 + 0.07, 0, 0, 0, -s * model.th);
            });
            this.floorProxies.push(deckBox, rampBox);

            // хранилище: тот же интерфейс, что у сундука
            const chestW = this.toWorld(b.x, b.z, b.r, 0, CHEST_LZ);
            const hit = addBox(g, 4.4, 1.9, 1.2, 0, 0.95, -HZ + 0.6);
            const inst = {
                uid: b.uid, type: b.type, x: b.x, z: b.z, r: b.r, def, fit: f,
                group: g, model, platform, low, shell, hit, deckBox, rampBox,
                cells: [], shellOn: false, wallOp: 1, roofOp: 1, inside: false, rec: null, fp: def.fp
            };
            this.blockCells(inst);
            const ap = this.toWorld(b.x, b.z, b.r, 0, -0.7);
            const acc = this.pathfinder.findNearestWalkableWorld(ap.x, ap.z, 8) || this.toWorld(b.x, b.z, b.r, 0, HZ + 0.8);
            const cos = platform.cos, sin = platform.sin;
            const rec = {
                id: 'building:' + b.uid, prop: 'building', x: chestW.x, z: chestW.z, r: 0.8, h: 1.2, s: 1, rotY: b.r,
                blocks: false, object: g, proxy: hit,
                container: { slots: def.slots, title: 'Склад' },
                access: { x: acc.x, z: acc.z }, reach: 2.9,
                distanceTo: (pos) => {
                    const dx = pos.x - b.x, dz = pos.z - b.z;
                    const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
                    if (Math.abs(lx) > HX || lz < -HZ + 1.1) return Infinity;   // за стеной / сбоку снаружи — не достать
                    return Math.hypot(pos.x - chestW.x, pos.z - chestW.z);
                }
            };
            inst.rec = rec;
            hit.userData.containerId = rec.id;
            const wo = this.game.worldObjects;
            if (wo) wo.registerContainer(rec, hit);
            if (window.AveloraHitDebug) window.AveloraHitDebug.attach(hit, 'container');

            this.game.addCameraBlocker(low);
            this.instances.push(inst);
            this.updateShell(inst, 0, true);
            return inst;
        }

        /** Пильня: открытый навес без помоста. Герой ходит под крышей, кроме занятых козлами и штабелями клеток. */
        spawnStation(b, def) {
            const f = this.fit(b.x, b.z, b.r, def);
            const rnd = mulberry32(((b.uid * 2654435761) ^ Math.round(b.x * 100) ^ Math.round(b.z * 7919)) >>> 0);
            const isForge = def.id === 'forge' && !def.mesh;
            const model = def.mesh
                ? buildModel(def, {}, Object.assign({}, this.mats, { attachMesh: (g, d) => this.attachMesh(g, d, null) }), rnd)
                : buildSawmill({ forge: isForge }, this.mats, rnd);
            if (model.meshes.roof) model.meshes.roof.material = this.mats.roof.clone();
            const g = model.group;
            g.position.set(b.x, f.deckY, b.z);
            g.rotation.y = b.r;
            this.root.add(g);

            const pm = this._proxyMat;
            const addBox = (parent, sx, sy, sz, px, py, pz, rx, ry, rz) => {
                const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), pm);
                m.position.set(px, py, pz);
                m.rotation.set(rx || 0, ry || 0, rz || 0);
                parent.add(m);
                return m;
            };
            const low = new THREE.Group(); low.name = 'cam-low'; g.add(low);
            const shell = new THREE.Group(); shell.name = 'cam-shell'; g.add(shell);
            // мелкие предметы блокируют камеру только пока герой снаружи (под навесом камера не прыгает об них при вращении)
            if (def.mesh) {
                // камеру держит сама модель (addCameraBlocker в attachMesh)
            } else if (isForge) {
                addBox(shell, 3.4, 2.0, 0.4, 0, 1.0, -1.3);                   // каменная стена
                addBox(shell, 1.9, 0.95, 1.0, 0, 0.47, -0.78);                // горн
                addBox(shell, 0.9, 0.85, 0.5, 0.1, 0.42, 0.2);                // наковальня
                addBox(shell, 1.0, 0.45, 0.55, 1.32, 0.22, 0.46);             // бадья
                addBox(shell, 0.7, 0.9, 0.9, -1.35, 0.45, -0.73);             // мехи
                addBox(shell, 1.0, 0.9, 0.6, 1.4, 0.45, -1.0);                // верстак
            } else {
            addBox(shell, 3.8, 1.25, 0.8, 0, 0.62, 0);                        // козлы с бревном
            addBox(shell, 1.5, 0.9, 1.0, -1.0, 0.45, -0.95);                  // штабель брёвен
            addBox(shell, 1.3, 0.8, 0.45, 1.2, 0.4, -1.0);                    // стопка досок
            addBox(shell, 0.6, 0.7, 0.6, -1.2, 0.35, 1.0);                    // колода
            }
            if (!def.mesh) {
                const ang = -Math.atan2(0.6, 2 * (SZ - 0.17));                // высокий край — вход (+Z)
                addBox(shell, 2 * SX + 0.6, 0.16, (2 * SZ + 0.6) / Math.cos(ang), 0, 2.72, 0, ang, 0, 0);
            }

            const inst = {
                uid: b.uid, type: b.type, x: b.x, z: b.z, r: b.r, def, fit: f,
                group: g, model, platform: { id: 'building:' + b.uid, cos: Math.cos(b.r), sin: Math.sin(b.r) }, low, shell,
                hit: null, deckBox: null, rampBox: null,
                cells: [], shellOn: false, wallOp: 1, roofOp: 1, inside: false, rec: null, fp: def.fp
            };
            if (isForge) {
                const light = new THREE.PointLight(0xff8a3a, 1.6, 9, 2);
                light.position.set(0, 1.35, -0.2);
                g.add(light);
                inst.light = light;
            }
            this.blockCells(inst);
            this.game.addCameraBlocker(low);
            this.instances.push(inst);
            this.updateShell(inst, 0, true);
            return inst;
        }

        /** Вставляет в группу модель из content/props/<def.mesh> (override — материал призрака). */
        attachMesh(group, def, override) {
            const wo = this.game.worldObjects;
            const pdef = ((window.GAME_CONTENT || {}).props || {})[def.mesh];
            if (!wo || !pdef) return;
            const run = () => wo.loadTemplates('props', def.mesh, pdef).then(vars => {
                if (this.disposed || !vars || !vars.length) return;
                const obj = vars[0].clone();
                obj.position.set(0, -0.02, 0);
                if (override) obj.traverse(o => { if (o.isMesh) { o.material = override; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 5; } });
                group.add(obj);
                if (!override && this.game.addCameraBlocker) this.game.addCameraBlocker(obj);
            });
            if (window.AveloraAssets && pdef.modelKey) window.AveloraAssets.ensure(pdef.modelKey).then(run); else run();
        }

        /** Ближайшая построенная станция данного типа в радиусе работы от позиции (для рецептов со `station`). */
        stationNear(stationId, pos) {
            const p = pos || (this.game.character && this.game.character.position);
            if (!p) return null;
            let best = null, bd = Infinity;
            for (const inst of this.instances) {
                if (inst.def.station !== stationId) continue;
                const d = Math.hypot(p.x - inst.x, p.z - inst.z);
                if (d <= (inst.def.craftRadius || CRAFT_RADIUS) && d < bd) { bd = d; best = inst; }
            }
            return best;
        }

        /** Закрывает клетки навигации: боковые борта, заднюю стену с полками и сундуком. Вход и середина свободны. */
        blockCells(inst) {
            const pf = this.pathfinder;
            const c = inst.platform.cos, s = inst.platform.sin;
            const station = inst.def.kind === 'station';
            const rects = inst.def.rects ? inst.def.rects.slice() : station && inst.def.id === 'forge' ? [
                { x0: -2.05, x1: 2.05, z0: -1.65, z1: -1.12 },       // стена
                { x0: -1.0, x1: 1.0, z0: -1.3, z1: -0.3 },           // горн
                { x0: -1.75, x1: -1.0, z0: -1.2, z1: -0.3 },         // мехи
                { x0: 0.95, x1: 1.9, z0: -1.4, z1: -0.65 },          // верстак
                { x0: -0.45, x1: 0.7, z0: -0.1, z1: 0.5 },           // наковальня
                { x0: 0.85, x1: 1.85, z0: 0.2, z1: 0.75 },           // бадья
                { x0: -2.05, x1: -0.9, z0: 0.65, z1: 1.2 }           // уголь и дрова
            ] : station ? [
                { x0: -1.95, x1: 1.95, z0: -0.5, z1: 0.5 },          // козлы, брус, пила
                { x0: -2.05, x1: -0.2, z0: -1.55, z1: -0.7 },        // штабель брёвен
                { x0: 0.5, x1: 2.05, z0: -1.55, z1: -0.7 },          // стопка досок
                { x0: -1.5, x1: -0.9, z0: 0.7, z1: 1.3 }             // колода
            ] : [
                { x: 0 },
                { x0: -HX - 0.1, x1: -HX + 0.15 + SIDE_MARGIN, z0: -HZ - 0.1, z1: HZ + 0.1 },
                { x0: HX - 0.15 - SIDE_MARGIN, x1: HX + 0.1, z0: -HZ - 0.1, z1: HZ + 0.1 },
                { x0: -HX - 0.1, x1: HX + 0.1, z0: -HZ - 0.1, z1: -HZ + BACK_STRIP }
            ];
            if (!station) rects.shift();
            const reach = Math.hypot(inst.fp.hx, inst.fp.hz) + 1.2;
            const g0 = pf.worldToGrid(inst.x - reach, inst.z - reach), g1 = pf.worldToGrid(inst.x + reach, inst.z + reach);
            const ext = 0.5 * pf.cellWidth * (Math.abs(c) + Math.abs(s));
            for (let gz = g0.z; gz <= g1.z; gz++) {
                for (let gx = g0.x; gx <= g1.x; gx++) {
                    const w = pf.gridToWorld(gx, gz);
                    const dx = w.x - inst.x, dz = w.z - inst.z;
                    const lx = dx * c - dz * s, lz = dx * s + dz * c;
                    let blocked = false;
                    for (let k = 0; k < rects.length && !blocked; k++) {
                        const R = rects[k];
                        if (lx + ext > R.x0 && lx - ext < R.x1 && lz + ext > R.z0 && lz - ext < R.z1) blocked = true;
                    }
                    if (!blocked) continue;
                    const idx = pf.getIndex(gx, gz);
                    if (pf.grid[idx] === 0) { pf.grid[idx] = 1; inst.cells.push(idx); }
                }
            }
        }

        unblockCells(inst) {
            const pf = this.pathfinder;
            inst.cells.forEach(i => { pf.grid[i] = 0; });
            inst.cells.length = 0;
        }

        // -------------------- крыша и камера --------------------
        updateShell(inst, delta, force) {
            const g = this.game;
            const ch = g.character;
            const pl = inst.platform;
            let inside = inst.inside;
            if (ch && g.viewMode !== 'first') {
                // hero on the deck (hysteresis: leaves only after the ramp)
                const dx = ch.position.x - inst.x, dz = ch.position.z - inst.z;
                const lx = dx * pl.cos - dz * pl.sin, lz = dx * pl.sin + dz * pl.cos;
                const F = inst.fp, fhx = F.hx, fhz = F.hz;
                const stn = inst.def.kind === 'station';
                const zFront = stn ? fhz : fhz + 0.1, zFrontOut = stn ? fhz + 0.35 : fhz + 0.7;
                let heroIn = inst.heroIn;
                if (!heroIn) heroIn = Math.abs(lx) < fhx - 0.05 && lz > -fhz && lz < zFront;
                else heroIn = !(Math.abs(lx) > fhx + 0.3 || lz < -fhz - 0.3 || lz > zFrontOut);
                inst.heroIn = heroIn;
                // camera inside the building volume (e.g. the hero walks away from the front, the camera trails behind):
                // the roof is cut away too, otherwise the view is a close-up of the ceiling
                let camIn = false;
                let cp = g.camera && g.camera.position;
                if (cp && ch) {
                    // желаемая позиция камеры: тот же луч от головы героя, но на полной дистанции зума. Фактическая позиция зависит от
                    // «оболочки» (её включаем мы сами) — на ней получалась обратная связь: оболочка → камера → оболочка → мерцание и дрожь.
                    const hx0 = ch.position.x, hy0 = ch.position.y + 1.5, hz0 = ch.position.z;
                    let dx = cp.x - hx0, dy = cp.y - hy0, dz = cp.z - hz0;
                    const dl = Math.hypot(dx, dy, dz);
                    const want = Math.max(dl, g.cameraDistance || dl);
                    if (dl > 0.05) { dx /= dl; dy /= dl; dz /= dl; cp = { x: hx0 + dx * want, y: hy0 + dy * want, z: hz0 + dz * want }; }
                }
                if (cp) {
                    const cx = cp.x - inst.x, cz = cp.z - inst.z;
                    const clx = cx * pl.cos - cz * pl.sin, clz = cx * pl.sin + cz * pl.cos;
                    const m = inst.camIn ? 0.6 : 0;
                    camIn = Math.abs(clx) < F.eaveX + m && clz > -F.hz - 0.45 - m && clz < F.hz + 0.45 + m && cp.y < inst.fit.deckY + F.ridgeY + 0.3 + m && cp.y > inst.fit.deckY - 1;
                }
                inst.camIn = camIn;
                inside = heroIn || camIn;
            } else { inside = false; inst.heroIn = false; inst.camIn = false; }
            inst.inside = inside;

            const wT = inside ? WALL_FADE : 1, rT = inside ? 0 : 1;
            const k = force ? 1 : Math.min(1, (delta || 0) * 4);
            inst.wallOp += (wT - inst.wallOp) * k;
            inst.roofOp += (rT - inst.roofOp) * k;
            if (Math.abs(inst.wallOp - wT) < 0.01) inst.wallOp = wT;
            if (Math.abs(inst.roofOp - rT) < 0.01) inst.roofOp = rT;
            const m = inst.model.meshes;
            if (m.wall) {
                m.wall.visible = inst.wallOp > 0.02;
                m.wall.material.opacity = inst.wallOp;
                m.wall.material.depthWrite = inst.wallOp > 0.98;
            }
            if (m.roof) {
                m.roof.visible = inst.roofOp > 0.02;
                m.roof.material.opacity = inst.roofOp;
                m.roof.material.depthWrite = inst.roofOp > 0.98;
            }
            // стена и крыша блокируют камеру только пока герой снаружи (или в первом лице)
            const wantBlock = !inside;
            if (wantBlock !== inst.shellOn) {
                inst.shellOn = wantBlock;
                const arr = g.cameraBlockers || (g.cameraBlockers = []);
                const i = arr.indexOf(inst.shell);
                if (wantBlock && i < 0) g.addCameraBlocker(inst.shell);
                else if (!wantBlock && i >= 0) arr.splice(i, 1);
            }
        }

        // -------------------- размещение --------------------
        startPlacing(typeId, moveRec) {
            if (!this.canUse()) return;
            const def = TYPES[typeId];
            if (!def) return;
            this.cancelPlacing();
            const ch = this.game.character;
            const a = this.game.cameraAngle || 0;
            const x0 = ch ? ch.position.x - Math.sin(a) * 8 : 0, z0 = ch ? ch.position.z - Math.cos(a) * 8 : 0;
            const gm = new THREE.MeshBasicMaterial({ color: 0x66e07a, transparent: true, opacity: 0.5, depthWrite: false });
            const rnd = mulberry32(99);
            const ghost = buildModel(def, { drop: 0.6, rampDrop: 0.3 }, { solid: gm, wall: gm, roof: gm, stone: gm, glow: gm, logTpl: this.logTpl, logMat: gm, attachMesh: (g, d) => this.attachMesh(g, d, gm) }, rnd);
            ghost.group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.renderOrder = 5; } });
            this.root.add(ghost.group);
            this.placing = {
                def, ghost, mat: gm, moveRec: moveRec || null,
                x: moveRec ? moveRec.x : Math.round(x0 * 4) / 4, z: moveRec ? moveRec.z : Math.round(z0 * 4) / 4,
                r: moveRec ? moveRec.r : Math.round(a / (Math.PI / 12)) * (Math.PI / 12),
                ok: false, reason: '', dirty: true, rampDrop: 0.3, drop: 0.6
            };
            UI.els.barTitle.textContent = `${moveRec ? 'Перемещение' : 'Размещение'}: ${def.name}`;
            UI.showBar(true);
            this.showZones();
            this.refreshGhost();
        }

        /** Взять построенное здание и поставить заново (бесплатно; содержимое склада остаётся). Esc — вернуть на место. */
        move(uid) {
            if (!this.canUse()) return;
            const st = this.game.gameState;
            const inst = this.instances.find(i => i.uid === uid);
            const rec = st && st.buildingsOf(this.location.id).find(b => b.uid === uid);
            if (!inst || !rec) return;
            this.cancelPlacing();
            const wo = this.game.worldObjects;
            if (wo && inst.rec) {
                if (wo.closeChest) wo.closeChest();
                wo.unregisterContainer(inst.rec.id);
            }
            this.removeInstance(inst);
            this.startPlacing(rec.type, rec);
        }

        /** «По сетке»: первое нажатие — вход строго на север, дальше по кругу на 90° (В → Ю → З → С); позиция — на сетку 0,5 м. */
        alignGrid() {
            const pl = this.placing;
            if (!pl) return;
            const dirs = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];      // вход смотрит: С (−Z), В (+X), Ю (+Z), З (−X)
            const names = ['на север', 'на восток', 'на юг', 'на запад'];
            let idx = -1;
            dirs.forEach((d, i) => { if (Math.abs(Math.atan2(Math.sin(pl.r - d), Math.cos(pl.r - d))) < 0.02) idx = i; });
            const next = idx < 0 ? 0 : (idx + 1) % 4;
            pl.r = dirs[next];
            pl.x = Math.round(pl.x * 2) / 2;
            pl.z = Math.round(pl.z * 2) / 2;
            pl.dirty = true;
            if (this.game.ui) this.game.ui.floatText(`Вход смотрит ${names[next]}`, 'info');
        }

        /** Красная подсветка зон, где строить нельзя (вне лагеря, вода, крутизна, лес, камни, постройки, предметы). */
        showZones() {
            this.hideZones();
            const area = this.cfg && this.cfg.area;
            if (!area) return;
            const T = this.terrain, pf = this.pathfinder;
            const step = 1.0, pad = 5;
            const x0 = area.x - area.hx - pad, z0 = area.z - area.hz - pad;
            const nx = Math.ceil((2 * (area.hx + pad)) / step), nz = Math.ceil((2 * (area.hz + pad)) / step);
            const W = nx + 1;
            const H = new Float32Array(W * (nz + 1));
            for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * W + i] = T.getRawHeightAt(x0 + i * step, z0 + j * step);
            const obj = new Uint8Array(nx * nz);
            const mark = (wx, wz, rad) => {
                const i0 = Math.max(0, Math.floor((wx - rad - x0) / step)), i1 = Math.min(nx - 1, Math.floor((wx + rad - x0) / step));
                const j0 = Math.max(0, Math.floor((wz - rad - z0) / step)), j1 = Math.min(nz - 1, Math.floor((wz + rad - z0) / step));
                for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) obj[j * nx + i] = 1;
            };
            const env = this.game.environment;
            if (env && env.objects) env.objects.forEach(o => { if (o.visible !== false && o.x !== undefined) mark(o.x, o.z, 0.5); });
            const wo = this.game.worldObjects;
            if (wo) {
                wo.props.forEach(p => mark(p.x, p.z, (p.r || 0.5) + 0.3));
                wo.piles.forEach(p => { if (p.group && p.data) mark(p.data.x, p.data.z, 0.6); });
            }
            const pos = [];
            const push = (i, j) => { const h = H[j * W + i] + 0.09; pos.push(x0 + i * step, h, z0 + j * step); };
            for (let j = 0; j < nz; j++) {
                for (let i = 0; i < nx; i++) {
                    const cx = x0 + (i + 0.5) * step, cz = z0 + (j + 0.5) * step;
                    const hs = [H[j * W + i], H[j * W + i + 1], H[(j + 1) * W + i], H[(j + 1) * W + i + 1]];
                    const hmin = Math.min(hs[0], hs[1], hs[2], hs[3]), hmax = Math.max(hs[0], hs[1], hs[2], hs[3]);
                    const outside = Math.abs(cx - area.x) > area.hx || Math.abs(cz - area.z) > area.hz;
                    const bad = outside || hmin < 0.3 || hmax - hmin > 0.5 || obj[j * nx + i] === 1 || !pf.isWalkableWorld(cx, cz);
                    if (!bad) continue;
                    push(i, j); push(i, j + 1); push(i + 1, j + 1);
                    push(i, j); push(i + 1, j + 1); push(i + 1, j);
                }
            }
            if (!pos.length) return;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.computeBoundingSphere();
            const m = new THREE.MeshBasicMaterial({
                color: 0xd8332b, transparent: true, opacity: 0.30, depthWrite: false, side: THREE.DoubleSide,
                polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
            });
            const mesh = new THREE.Mesh(geo, m);
            mesh.name = 'build-zones';
            mesh.renderOrder = 2;
            mesh.frustumCulled = false;
            this.root.add(mesh);
            this.zones = mesh;
        }

        hideZones() {
            const z = this.zones;
            if (!z) return;
            this.zones = null;
            if (z.parent) z.parent.remove(z);
            if (z.geometry) z.geometry.dispose();
            if (z.material) z.material.dispose();
        }

        cancelPlacing() {
            const pl = this.placing;
            if (!pl) return;
            this.placing = null;
            this.keyRotate = 0;
            this.root.remove(pl.ghost.group);
            pl.ghost.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
            pl.mat.dispose();
            this.hideZones();
            UI.showBar(false);
            // перемещение отменено — здание возвращается на прежнее место
            if (pl.moveRec && !pl.committed && !this.disposed) { try { this.spawn(pl.moveRec); } catch (err) { console.error('[Avelora] building restore failed', err); } }
        }

        rotateBy(d) { if (this.placing) { this.placing.r += d; this.placing.dirty = true; } }

        /** Ground point under screen coords (analytic ray vs relief, no mesh raycast). */
        groundAt(nx, ny) {
            const cam = this.game.camera;
            if (!cam) return null;
            this._ndc.set(nx, ny);
            this._ray.setFromCamera(this._ndc, cam);
            const o = this._ray.ray.origin, d = this._ray.ray.direction;
            if (d.y > -0.02) return null;
            let h = 0.85, x = 0, z = 0;
            for (let i = 0; i < 4; i++) {
                const t = (h - o.y) / d.y;
                x = o.x + d.x * t; z = o.z + d.z * t;
                h = this.terrain.getRawHeightAt(x, z);
            }
            return { x, z };
        }

        pointerTo(cx, cy) {
            const pl = this.placing;
            if (!pl) return;
            const p = this.groundAt((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
            if (!p) return;
            const nx = Math.round(p.x * 4) / 4, nz = Math.round(p.z * 4) / 4;
            if (nx !== pl.x || nz !== pl.z) { pl.x = nx; pl.z = nz; pl.dirty = true; }
        }

        /** Клик в мир (main.js handleGroundClick). true = клик поглощён. */
        handleWorldClick(e) {
            if (!this.placing) return false;
            if (e.aimCenter) this.pointerTo(window.innerWidth / 2, window.innerHeight / 2);
            else if (e.clientX !== undefined) this.pointerTo(e.clientX, e.clientY);
            const mouse = e.pointerType === 'mouse' || e.pointerType === 'pen';
            this.refreshGhost();
            if (mouse) this.commit();
            return true;
        }

        refreshGhost() {
            const pl = this.placing;
            if (!pl) return;
            pl.dirty = false;
            const v = this.validate(pl.def, pl.x, pl.z, pl.r);
            const f = v.fit || this.fit(pl.x, pl.z, pl.r, pl.def);
            pl.ok = v.ok; pl.reason = v.reason;
            const g = pl.ghost.group;
            g.position.set(pl.x, f.deckY, pl.z);
            g.rotation.y = pl.r;
            pl.mat.color.setHex(v.ok ? 0x66e07a : 0xe0605a);
            let costOk = true;
            if (v.ok && !FREE_BUILD && !pl.moveRec) {
                const st = this.game.gameState;
                for (const c of pl.def.cost) if (!st || st.inventory.count(c.item) < c.count) costOk = false;
            }
            UI.setStatus(v.ok && costOk, v.ok ? (costOk ? 'Можно строить' : 'Не хватает материалов') : v.reason);
        }

        commit() {
            const pl = this.placing;
            if (!pl) return;
            const st = this.game.gameState;
            if (!st) return;
            this.refreshGhost();
            if (!pl.ok) { this.warn(pl.reason); return; }
            if (pl.moveRec) {
                const rec = pl.moveRec;
                rec.x = Math.round(pl.x * 100) / 100; rec.z = Math.round(pl.z * 100) / 100; rec.r = Math.round(pl.r * 1000) / 1000;
                st.save();
                pl.committed = true;
                this.cancelPlacing();
                this.spawn(rec);
                if (this.game.ui) this.game.ui.floatText(`Перемещено: ${pl.def.name}`, 'gain');
                return;
            }
            if (!FREE_BUILD) {
                for (const c of pl.def.cost) {
                    if (st.inventory.count(c.item) < c.count) { this.warn('Не хватает материалов'); return; }
                }
                pl.def.cost.forEach(c => st.inventory.remove(c.item, c.count));
            }
            const b = st.addBuilding(this.location.id, pl.def.id, pl.x, pl.z, pl.r);
            this.cancelPlacing();
            this.spawn(b);
            window.dispatchEvent(new CustomEvent('game:questUpdated'));
            if (this.game.ui && this.game.ui.updateQuestsProgress) this.game.ui.updateQuestsProgress();
            if (this.game.ui && this.game.ui.dialog && this.game.ui.dialog.updateTracker) this.game.ui.dialog.updateTracker();
            if (this.game.ui) {
                this.game.ui.floatText(`Построено: ${pl.def.name}`, 'gain');
                if (this.game.ui.pulseInventory) this.game.ui.pulseInventory();
            }
            if (this.game.hero && this.game.hero.addXp) {
                this.game.hero.addXp(35);
            }
        }

        /** Для тестов/консоли: поставить без проверок цены и размещения. */
        debugBuild(x, z, r, type) {
            const st = this.game.gameState;
            if (!st) return null;
            const b = st.addBuilding(this.location.id, type || 'storage', x, z, r || 0);
            return this.spawn(b);
        }

        // -------------------- снос --------------------
        storageUsed(inst) {
            const st = this.game.gameState;
            if (!inst.rec) return { used: 0, total: 0 };
            const inv = st.chestInventory(`${this.location.id}/${inst.rec.id}`, inst.def.slots);
            return { used: inv.cells.filter(Boolean).length, total: inv.cells.length };
        }

        demolish(uid) {
            const st = this.game.gameState;
            const inst = this.instances.find(i => i.uid === uid);
            if (!st || !inst) return false;
            const key = inst.rec ? `${this.location.id}/${inst.rec.id}` : null;
            if (key && !st.chestInventory(key, inst.def.slots).isEmpty()) { this.warn('Сначала опустошите склад'); return false; }
            for (const c of inst.def.cost) {
                if (st.inventory.spaceFor(c.item) < c.count) { this.warn('В сумке нет места для материалов'); return false; }
            }
            const wo = this.game.worldObjects;
            if (wo && inst.rec) wo.unregisterContainer(inst.rec.id);
            inst.def.cost.forEach(c => st.inventory.add(c.item, c.count));
            if (key) st.dropChest(key);
            st.removeBuilding(this.location.id, uid);
            this.removeInstance(inst);
            if (this.game.ui) {
                this.game.ui.floatText(`Снесено: ${inst.def.name}`, 'info');
                if (this.game.ui.pulseInventory) this.game.ui.pulseInventory();
            }
            return true;
        }

        removeInstance(inst) {
            const arr = this.game.cameraBlockers || [];
            [inst.low, inst.shell].forEach(o => { const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); });
            this.floorProxies = this.floorProxies.filter(m => m !== inst.deckBox && m !== inst.rampBox);
            if (inst.def.kind !== 'station') this.terrain.removePlatform(inst.platform.id);
            this.unblockCells(inst);
            this.root.remove(inst.group);
            inst.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
            if (inst.model.meshes.wall) inst.model.meshes.wall.material.dispose();
            if (inst.model.meshes.roof) inst.model.meshes.roof.material.dispose();
            this.instances = this.instances.filter(i => i !== inst);
        }

        // -------------------- клики по полу --------------------
        /** Пересечение луча с полом помоста/трапом (для хождения по клику внутри склада). */
        pickFloor(raycaster) {
            if (!this.floorProxies.length) return null;
            const hits = raycaster.intersectObjects(this.floorProxies, false);
            return hits.length ? hits[0] : null;
        }

        // -------------------- цикл --------------------
        update(delta) {
            if (!this.cfg) return;
            for (let i = 0; i < this.instances.length; i++) this.updateShell(this.instances[i], delta, false);
            this._fT = (this._fT || 0) + delta;
            const ft = this._fT, fl = 0.8 + 0.12 * Math.sin(ft * 9.1) + 0.08 * Math.sin(ft * 23.7 + 1.3);
            if (this.mats && this.mats.glow) this.mats.glow.color.setScalar(fl);
            for (let i = 0; i < this.instances.length; i++) { const L = this.instances[i].light; if (L) L.intensity = 1.6 * fl; }
            // станции (пильня): когда герой входит в радиус / выходит из него — обновить вкладку «Создание»
            this._stT = (this._stT || 0) - delta;
            if (this._stT <= 0) {
                this._stT = 0.3;
                const key = Object.keys(TYPES).filter(k => TYPES[k].kind === 'station').map(k => {
                    const n = this.stationNear(TYPES[k].station);
                    return n ? n.uid : 0;
                }).join(',');
                if (key !== this._stKey) {
                    const prev = this._stKey;
                    this._stKey = key;
                    const ui = this.game.ui;
                    if (ui && ui.currentTab === 'craft' && ui.renderCrafting) ui.renderCrafting();
                }
            }
            const pl = this.placing;
            if (pl) {
                if (this.keyRotate) { pl.r += this.keyRotate * 1.8 * delta; pl.dirty = true; }
                const ch = this.game.character;
                if (ch) {
                    const mv = Math.hypot(ch.position.x - (pl._hx || 0), ch.position.z - (pl._hz || 0));
                    if (mv > 0.15) { pl._hx = ch.position.x; pl._hz = ch.position.z; pl.dirty = true; }
                }
                if (pl.dirty) this.refreshGhost();
            }
            if (UI.panelOpen && UI.mgr === this) {
                this._uiT -= delta;
                if (this._uiT <= 0) { this._uiT = 0.5; UI.render(); }
            }
        }

        /** Escape: закрыть режим размещения / меню. true = обработано. */
        onEscape() {
            if (this.placing) { this.cancelPlacing(); return true; }
            if (UI.panelOpen) { UI.closePanel(); return true; }
            return false;
        }

        dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.cancelPlacing();
            UI.detach(this);
            // меши/геометрии/материалы под locationRoot освобождает teardownLocation()
            this.hideZones();
            disposeLogTemplate(this.logTpl);
            this.logTpl = null;
            this.instances.length = 0;
            this.floorProxies.length = 0;
        }
    }

    window.AveloraBuilding = AveloraBuilding;
    window.AveloraBuildingTypes = TYPES;
})();
