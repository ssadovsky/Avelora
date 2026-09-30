/**
 * AVELORA - WORLD & LOCATION DATA REGISTRY
 *
 * Здесь задаются ВСЕ локации игры. Подробная инструкция: world_data_help.txt
 *
 * Каждая локация — это:
 *   terrain      — размер, seed рельефа, водоём, холмы
 *   atmosphere   — цвет неба / плотность тумана (необязательно)
 *   spawns       — точки появления персонажа (default + точки прихода из других локаций)
 *   exits        — проходы в другие локации (светящийся круг на земле + подпись)
 *   clearings    — места, где группы НЕ ставят объекты (тропы, поляны)
 *   groups       — ГРУППЫ объектов: лес, заросли камыша, камни, луг (одной строкой)
 *   decorations  — объекты, расставленные вручную по одному { x, z, s, r }
 *   pickups      — кучки предметов на земле, которые можно подобрать:
 *                  { id, item, count, x, z, y?, r?, rotation? }
 *                  item — id из content/items; y — высота над землёй (м);
 *                  rotation — [x, y, z] в радианах (для одиночного предмета).
 *                  Подобранное запоминается для каждого персонажа отдельно (по id).
 *   props        — статичные объекты из content/props: { id, prop, x, z, r?, s? }
 *                  (пень и т.п.; радиус препятствия берётся из prop.json)
 *   creatures    — существа из content/creatures: { id, type, x, z, r? }
 *                  x, z — «дом» (там появляется и туда возвращается), r — поворот.
 *                  id уникален в локации: по нему запоминается, кто убит
 *                  (возрождение через respawnMinutes сыгранного времени).
 *
 * Высота Y везде рассчитывается АВТОМАТИЧЕСКИ по рельефу.
 * Для быстрого теста локации: откройте index.html#lakeLand (имя локации после #).
 */

// Вспомогательная функция: группа объектов в радиусе (для decorations).
// Детерминированная: при каждом запуске раскладка одинаковая (seed можно менять).
function createCluster(centerX, centerZ, radius, count, scaleMin, scaleMax, seed = 1) {
    let a = (seed * 2654435761) >>> 0;
    const rnd = () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const list = [];
    for (let i = 0; i < count; i++) {
        const angle = rnd() * Math.PI * 2;
        const dist = Math.sqrt(rnd()) * radius;
        list.push({
            x: Math.round((centerX + Math.cos(angle) * dist) * 10) / 10,
            z: Math.round((centerZ + Math.sin(angle) * dist) * 10) / 10,
            s: Math.round((scaleMin + rnd() * (scaleMax - scaleMin)) * 100) / 100,
            r: Math.round(rnd() * Math.PI * 2 * 100) / 100
        });
    }
    return list;
}

// Локация, с которой начинается игра
window.START_LOCATION = 'forestEdge';

window.LOCATIONS = {
    // -------------------------------------------------------------
    // ЛОКАЦИЯ: Лесная опушка (стартовая)
    // Поляна, окружённая лесом, лесной пруд с камышом на северо-западе,
    // каменистый холм, проход на запад — к Озерному краю.
    // -------------------------------------------------------------
    forestEdge: {
        id: 'forestEdge',
        name: 'Лесная опушка',

        terrain: {
            sizeX: 300,         // 300 м с запада на восток (от -150 до +150)
            sizeZ: 200,         // 200 м с севера на юг (от -100 до +100) — соотношение 3:2 landscape
            seed: 9127,
            biome: 'forest',
            segmentsX: 300,
            segmentsZ: 200,
            border: 0,          // без лишнего внешнего бордюра, горы доходят ровно до границы карты
            baseHeight: 1.7,

            // Естественный горный барьер по периметру (высота 6м, пики до 9м)
            mountainRim: { width: 16.0, height: 6.0 },
            // Горный перевал (ущелье) на запад к Озерному краю
            mountainPasses: [
                { x: -136.0, z: 8.0, radius: 14.0 }
            ],

            waterBody: {
                type: 'lake',
                x: -20.0,
                z: -18.0,
                radius: 20.0,
                depth: -1.2,
                beachWidth: 5.0
            },
            hills: { amplitude: 1.6, inclineX: 0.2, inclineZ: -0.15 }
        },

        atmosphere: { sky: 0xc6dbe3, skyTop: 0x4a8fc9, fogDensity: 0.0055 },

        spawns: {
            default:   { x: 6.0,    z: 12.0 },
            fromLake:  { x: -126.0, z: 8.0, r: 4.71 },  // персонаж выходит из ущелья в долину
            waterfall: { x: 104.0,  z: 6.0, r: 4.71 }   // с видом на восточный каскадный водопад
        },

        waterfalls: [
            {
                id: 'east_stonewatch_falls',
                modelKey: 'waterfall_cliffs',   // Stonewatch Cliffs: скалы-подкова, вода строится в waterfall.js
                x: 134.5,                       // спина скал (x ~146) утоплена в восточный горный обод
                z: 6.0,
                scale: 16.0,
                rotationY: -Math.PI / 2         // чаша (локальный +Z) смотрит на запад
            }
        ],

        exits: [
            // Проход в Озерный край через горный каньон на западе
            { id: 'toLake', x: -138.0, z: 8.0, radius: 3.5, to: 'lakeLand', spawn: 'fromForest', label: 'Озерный край' }
        ],

        // Тропы и поляны (свободные от плотных деревьев)
        clearings: [
            { x: -136.0, z: 8.0, radius: 8.0 },
            { x: -122.0, z: 8.0, radius: 8.0 },
            { x: -108.0, z: 8.0, radius: 7.0 },
            { x: -80.0,  z: 8.0, radius: 7.0 },
            { x: -48.0,  z: 8.0, radius: 6.0 },
            { x: -38.0,  z: 7.0, radius: 5.0 },
            { x: -28.0,  z: 6.0, radius: 5.0 },
            { x: 124.0,  z: 6.0, radius: 18.0 }  // водопад и чаша горного озера на востоке
        ],

        groups: [
            // Горные леса у подножия хребта
            { id: 'north_rim_forest', type: 'forest', x: 0.0,    z: -78.0, rx: 110.0, rz: 14.0, count: 45, seed: 11 },
            { id: 'south_rim_forest', type: 'forest', x: 0.0,    z: 78.0,  rx: 110.0, rz: 14.0, count: 45, seed: 14 },
            { id: 'east_rim_forest',  type: 'forest', x: 118.0,  z: -35.0, rx: 16.0,  rz: 40.0, count: 22, seed: 15 },
            { id: 'east_south_forest',type: 'forest', x: 118.0,  z: 42.0,  rx: 16.0,  rz: 35.0, count: 20, seed: 16 },
            { id: 'west_north_forest',type: 'forest', x: -125.0, z: -55.0, rx: 16.0,  rz: 30.0, count: 20, seed: 17 },
            { id: 'west_south_forest',type: 'forest', x: -125.0, z: 62.0,  rx: 16.0,  rz: 28.0, count: 20, seed: 18 },

            // Рощи внутри просторной долины
            { id: 'oak_grove',   type: 'forest', x: 26.0,  z: -20.0, radius: 11.0, count: 12, seed: 21 },
            { id: 'birch_copse', type: 'forest', x: -12.0, z: 32.0,  radius: 8.0,  count: 8,  seed: 22, undergrowth: true },
            { id: 'west_grove',  type: 'forest', x: -65.0, z: -25.0, radius: 10.0, count: 9,  seed: 23 },

            // Лесной пруд: заросли камыша
            { id: 'pond_reeds', type: 'reeds', x: -20.0, z: -18.0, radius: 12.0, count: 60, seed: 31 },

            // Каменистые холмы и валуны
            { id: 'stone_hill',     type: 'rocks', x: 30.0,  z: 22.0,  radius: 7.0, count: 4, seed: 41 },
            { id: 'pond_rocks',     type: 'rocks', x: -9.0,  z: -27.0, radius: 4.0, count: 3, seed: 42 },

            // Заросли папоротника для сбора целебных трав
            { id: 'camp_ferns',  type: 'fernPatch', x: 15.0, z: 16.0, radius: 8.0, count: 14, seed: 71 },
            { id: 'grove_ferns', type: 'fernPatch', x: 28.0, z: -16.0, radius: 7.0, count: 10, seed: 72 },

            // Луговая поляна в центре и тропа
            { id: 'glade',       type: 'meadow', x: 4.0,   z: 4.0,  radius: 26.0, count: 120, flowers: 20, seed: 51 },
            { id: 'path_meadow', type: 'meadow', x: -34.0, z: 14.0, radius: 10.0, count: 35,  flowers: 5,  seed: 52 },
            { id: 'east_meadow', type: 'meadow', x: 80.0,  z: 6.0,  radius: 18.0, count: 60,  flowers: 10, seed: 53 }
        ],

        // Существа в долине:
        // Вепрь-страж охраняет вход в горный каньон к Озерному краю
        creatures: [
            { id: 'pond_rat_1',  type: 'rat',  x: -3.0,   z: -8.0 },
            { id: 'pond_rat_2',  type: 'rat',  x: -9.0,   z: -1.0 },
            { id: 'hill_rat_1',  type: 'rat',  x: 27.0,   z: 19.0 },
            { id: 'hill_rat_2',  type: 'rat',  x: 29.5,   z: 26.0 },
            { id: 'waterfall_fawn', type: 'fawn', x: 110.0, z: 12.0, r: 2.8 },
            { id: 'portal_boar', type: 'boar', x: -118.0, z: 8.0,  r: 1.57 },
            { id: 'stump_fawn',  type: 'fawn', x: -8.0,   z: -12.0, r: 1.2 }
        ],

        pickups: [
            { id: 'start_stones', item: 'stone', count: 5, x: 9.5, z: 14.5 },
            { id: 'start_logs',   item: 'log',   count: 3, x: 2.5, z: 15.5, r: 0.5 },
            // Топор воткнут лезвием в срез пня (пень — в props ниже, центр 1.0/18.0).
            // x, z, y — точка хвата (низ топорища), y — высота над землёй;
            // rotation — наклон [x, y, z]: топорище смотрит вверх-наружу, лезвие в дереве.
            { id: 'stump_axe',    item: 'axe',   count: 1, x: 1.35, z: 18.12, y: 0.72, rotation: [3.142, 0.347, 1.082] },
            // Посох лежит в траве у камней: rotation [0, поворот, -π/2] кладёт древко
            // (+Y модели) горизонтально; y — толщина древка, чтобы не утонул в земле.
            { id: 'start_staff',  item: 'staff', count: 1, x: 7.2,  z: 16.6, y: 0.04, rotation: [0, 0.6, -1.571] }
        ],

        props: [
            { id: 'start_stump', prop: 'stump', x: 1.0, z: 18.0, r: 0.4, s: 1.0 }
        ],

        decorations: {
            // Одинокое большое дерево на поляне (ставится вручную)
            trees: [
                { x: 14.0, z: 2.0, s: 1.6, r: 0.3 }
            ],
            boulders: [
                // Каменные врата каньона на западном перевале
                { x: -124.0, z: 1.5, s: 2.2, r: 0.6 },
                { x: -124.0, z: 14.5, s: 2.2, r: 2.1 },
                { x: -132.0, z: 1.5, s: 2.0, r: 1.4 },
                { x: -132.0, z: 14.5, s: 2.0, r: 0.9 },
                { x: -140.0, z: 2.0, s: 1.8, r: 0.3 },
                { x: -140.0, z: 14.0, s: 1.8, r: 2.8 }
            ],
            shrubs: [
                { x: 18.0, z: 6.5, s: 1.6, r: 1.1 }
            ],
            ferns: [
                // Заметные кусты папоротника рядом с лагерем игрока для удобного сбора
                { x: 11.0, z: 15.0, s: 3.0, r: 0.4 },
                { x: 13.5, z: 17.0, s: 3.2, r: 1.2 },
                { x: 8.0,  z: 18.5, s: 2.8, r: 2.5 },
                { x: -7.0, z: 10.0, s: 3.0, r: 0.8 },
                { x: -4.0, z: 8.0,  s: 3.2, r: 1.7 },
                { x: 20.0, z: 13.0, s: 3.0, r: 2.1 }
            ],
            dandelions: [],
            reeds: [],
            grass: []
        }
    },

    // -------------------------------------------------------------
    // ЛОКАЦИЯ: Озерный Край (бывшая тестовая локация LakeLand)
    // -------------------------------------------------------------
    lakeLand: {
        id: 'lakeLand',
        name: 'Озерный край',

        terrain: {
            size: 120,
            seed: 4242,
            biome: 'goldshire', // WoW Златоземье: сочная изумрудная трава, грунтовые дорожки, стилизованные скалы
            segments: 240,      // гладкий рельеф без ступеней

            // ТИП ВОДОЕМА:
            // 1. 'lake'   - Замкнутое озеро в любой точке карты
            // 2. 'coast'  - Берег моря вдоль целого края карты ('west', 'east', 'north', 'south')
            // 3. 'island' - Остров в центре океана
            // 4. 'none'   - Сплошная суша без воды
            waterBody: {
                type: 'lake',
                x: -14.0,           // Центр озера по X
                z: 2.0,             // Центр озера по Z
                radius: 14.0,       // Радиус озера
                depth: -1.6         // Глубина водоема
            },

            hills: { amplitude: 1.4, inclineX: 0.8, inclineZ: 0.4 }
        },

        // Размер водной глади
        water: { size: 100 },

        spawns: {
            default:    { x: 15.0, z: 8.0 },
            fromForest: { x: 45.0, z: 6.0, r: 1.57 }
        },

        exits: [
            { id: 'toForest', x: 54.0, z: 6.0, radius: 3.0, to: 'forestEdge', spawn: 'fromLake', label: 'Лесная опушка' }
        ],

        clearings: [
            { x: 46.0, z: 6.0, radius: 2.5 }
        ],

        groups: [
            // Поляны с травой и цветами вдоль дороги от портала
            { id: 'meadow_portal_n', type: 'meadow', x: 40.0, z: 12.0,  radius: 7.0,  count: 35, flowers: 6, seed: 117 },
            { id: 'meadow_portal_s', type: 'meadow', x: 41.0, z: -1.0,  radius: 7.0,  count: 35, flowers: 5, seed: 118 },

            // Заросли камыша вдоль берега (с просветами открытого пляжа)
            { id: 'reeds_east',      type: 'reeds', x: 5.5,   z: -6.0,  radius: 7.0, count: 45, seed: 101 },
            { id: 'reeds_northeast', type: 'reeds', x: -1.0,  z: -19.0, radius: 7.0, count: 40, seed: 102 },
            { id: 'reeds_north',     type: 'reeds', x: -26.0, z: -18.0, radius: 8.0, count: 50, seed: 103 },
            { id: 'reeds_west',      type: 'reeds', x: -38.0, z: 4.0,   radius: 7.0, count: 35, seed: 104 },
            { id: 'reeds_southwest', type: 'reeds', x: -26.0, z: 21.0,  radius: 8.0, count: 45, seed: 105 },
            { id: 'reeds_south',     type: 'reeds', x: -4.0,  z: 20.0,  radius: 6.0, count: 30, seed: 106 },
            // Болотце в северо-западном углу
            { id: 'marsh_reeds',     type: 'reeds', x: -50.0, z: -46.0, radius: 12.0, count: 45, seed: 107 },

            // Пятна луговой травы (вместо ровного кольца)
            { id: 'meadow_ne',    type: 'meadow', x: 22.0,  z: -12.0, radius: 10.0, count: 45, flowers: 6, seed: 111 },
            { id: 'meadow_e',     type: 'meadow', x: 30.0,  z: 14.0,  radius: 10.0, count: 45, flowers: 6, seed: 112 },
            { id: 'meadow_s',     type: 'meadow', x: 8.0,   z: 32.0,  radius: 9.0,  count: 40, flowers: 4, seed: 113 },
            { id: 'meadow_nw',    type: 'meadow', x: -40.0, z: -30.0, radius: 10.0, count: 40, flowers: 4, seed: 114 },
            { id: 'meadow_sw',    type: 'meadow', x: -40.0, z: 36.0,  radius: 9.0,  count: 35, flowers: 3, seed: 115 },
            { id: 'meadow_shore', type: 'meadow', x: 14.0,  z: -2.0,  radius: 6.0,  count: 25, flowers: 0, seed: 116 },

            // Лес по краям
            { id: 'northeast_forest', type: 'forest', x: 44.0, z: -44.0, rx: 16.0, rz: 12.0, count: 14, seed: 121 },
            { id: 'south_forest',     type: 'forest', x: -6.0, z: 50.0,  rx: 32.0, rz: 8.0,  count: 16, seed: 122 }
        ],

        creatures: [
            { id: 'lake_rune_boar', type: 'rune_boar', x: 25.0, z: 12.0, r: 2.1 }
        ],

        // Объекты, расставленные вручную
        decorations: {
            trees: [
                { x: 14.0, z: 20.0, s: 1.10, r: 0.40 },
                { x: 20.0, z: 25.0, s: 1.25, r: 1.80 },
                { x: 16.0, z: 10.0, s: 1.05, r: 2.70 },
                { x: 23.0, z: 6.0, s: 1.20, r: 0.90 },
                { x: 18.0, z: -8.0, s: 1.15, r: 3.10 },
                { x: 24.0, z: -16.0, s: 1.30, r: 1.40 },
                { x: 11.0, z: -20.0, s: 0.95, r: 0.20 },
                { x: 18.0, z: -25.0, s: 1.10, r: 2.30 },
                { x: 28.0, z: 2.0, s: 1.35, r: 1.70 },
                { x: 30.0, z: -10.0, s: 1.40, r: 0.60 },
                { x: -5.0, z: 27.0, s: 1.05, r: 2.90 },
                { x: -16.0, z: 24.0, s: 1.15, r: 1.10 },
                { x: -24.0, z: -22.0, s: 1.25, r: 0.50 },
                { x: -26.0, z: -12.0, s: 1.10, r: 2.20 }
            ],
            boulders: [
                { x: -5.0, z: 18.0, s: 2.00, r: 0.40 },
                { x: 3.0, z: 15.0, s: 1.70, r: 1.20 },
                { x: 6.0, z: 7.0, s: 2.20, r: 2.10 },
                { x: 8.0, z: -4.0, s: 1.90, r: 0.80 },
                { x: 4.0, z: -15.0, s: 2.30, r: 3.00 },
                { x: -2.0, z: -20.0, s: 1.80, r: 1.70 },
                { x: -10.0, z: -22.0, s: 2.50, r: 0.50 },
                { x: -21.0, z: -17.0, s: 2.00, r: 2.60 },
                { x: 22.0, z: 15.0, s: 2.80, r: 0.30 },
                { x: 28.0, z: 20.0, s: 2.40, r: 1.90 },
                { x: 20.0, z: -15.0, s: 2.30, r: 1.40 }
            ],
            shrubs: [
                { x: 12.0, z: 18.0, s: 1.80, r: 0.00 },
                { x: 15.0, z: 12.0, s: 2.10, r: 1.30 },
                { x: 22.0, z: 24.0, s: 2.30, r: 2.60 },
                { x: 18.0, z: -5.0, s: 1.90, r: 3.90 },
                { x: 25.0, z: -14.0, s: 2.20, r: 5.20 },
                { x: 12.0, z: -19.0, s: 1.70, r: 0.50 },
                { x: 27.0, z: 4.0, s: 2.40, r: 1.80 },
                { x: 29.0, z: -6.0, s: 2.00, r: 3.10 },
                { x: -4.0, z: 25.0, s: 1.80, r: 4.40 },
                { x: -15.0, z: 23.0, s: 2.10, r: 5.70 }
            ],
            ferns: [
                { x: 10.0, z: 14.0, s: 3.00, r: 0.80 },
                { x: 18.0, z: 18.0, s: 2.80, r: 1.50 },
                { x: 22.0, z: 10.0, s: 3.20, r: 2.30 },
                { x: 15.0, z: -12.0, s: 2.90, r: 3.10 },
                { x: 21.0, z: -18.0, s: 3.40, r: 0.40 },
                { x: 26.0, z: -8.0, s: 2.70, r: 1.90 },
                { x: 14.0, z: 24.0, s: 3.10, r: 2.80 },
                { x: 28.0, z: 16.0, s: 3.30, r: 0.70 },
                { x: -3.0, z: 22.0, s: 2.80, r: 1.60 },
                { x: -12.0, z: 20.0, s: 3.00, r: 2.50 }
            ],
            dandelions: [
                { x: 11.0, z: 6.0, s: 2.00, r: 0.50 },
                { x: 13.0, z: 9.0, s: 1.80, r: 1.20 },
                { x: 17.0, z: 4.0, s: 2.20, r: 2.10 },
                { x: 19.0, z: 14.0, s: 1.90, r: 3.00 },
                { x: 8.0, z: 12.0, s: 2.10, r: 0.80 },
                { x: 21.0, z: -2.0, s: 1.70, r: 1.70 },
                { x: 23.0, z: -6.0, s: 2.30, r: 2.60 },
                { x: 16.0, z: -16.0, s: 2.00, r: 3.50 }
            ],
            reeds: [],
            grass: []
        }
    }
};

// Совместимость со старым кодом: текущая локация (движок обновляет её при переходах)
window.CURRENT_LOCATION = window.LOCATIONS[window.START_LOCATION];
