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
            size: 120,          // игровая область 120 x 120 м (от -60 до 60)
            seed: 9127,         // другой seed = другие холмы
            biome: 'forest',    // лесной биом
            segments: 240,      // повышенная детализация сетки для гладких холмов
            baseHeight: 1.7,    // земля выше уровня воды -> нет случайных луж (по умолчанию 0.85)
            waterBody: {
                type: 'lake',   // небольшой лесной пруд
                x: -20.0,
                z: -18.0,
                radius: 20.0,
                depth: -1.2,
                beachWidth: 5.0 // узкий берег (у большого озера 14)
            },
            hills: { amplitude: 1.6, inclineX: 0.3, inclineZ: -0.2 }
        },

        atmosphere: { sky: 0xa7c4c6, fogDensity: 0.013 },

        spawns: {
            default:  { x: 6.0,   z: 12.0 },
            fromLake: { x: -36.5, z: 7.5, r: 4.71 }   // r — куда смотрит персонаж (радианы)
                                                       // отодвинуто от портала - вепрь агрится с 8 м
        },

        exits: [
            { id: 'toLake', x: -55.0, z: 8.0, radius: 3.0, to: 'lakeLand', spawn: 'fromForest', label: 'Озерный край' }
        ],

        // Тропа от прохода к поляне: здесь группы ничего не ставят
        clearings: [
            { x: -48.0, z: 8.0, radius: 6.0 },
            { x: -38.0, z: 7.0, radius: 5.0 },
            { x: -28.0, z: 6.0, radius: 5.0 }
        ],

        groups: [
            // Лес по краям карты (закрывает границу мира)
            { id: 'north_forest',     type: 'forest', x: 2.0,   z: -51.0, rx: 52.0, rz: 9.0,  count: 24, seed: 11 },
            { id: 'northwest_forest', type: 'forest', x: -49.0, z: -30.0, rx: 11.0, rz: 19.0, count: 12, seed: 12 },
            { id: 'southwest_forest', type: 'forest', x: -47.0, z: 40.0,  rx: 13.0, rz: 17.0, count: 12, seed: 13 },
            { id: 'south_forest',     type: 'forest', x: 8.0,   z: 51.0,  rx: 48.0, rz: 9.0,  count: 20, seed: 14 },
            { id: 'east_forest',      type: 'forest', x: 51.0,  z: 0.0,   rx: 9.0,  rz: 48.0, count: 20, seed: 15 },

            // Рощи внутри опушки
            { id: 'oak_grove',   type: 'forest', x: 26.0,  z: -20.0, radius: 9.0, count: 8, seed: 21 },
            { id: 'birch_copse', type: 'forest', x: -12.0, z: 28.0,  radius: 6.0, count: 5, seed: 22, undergrowth: true },

            // Лесной пруд: заросли камыша
            { id: 'pond_reeds', type: 'reeds', x: -20.0, z: -18.0, radius: 12.0, count: 60, seed: 31 },

            // Каменистый холм и камни у пруда
            { id: 'stone_hill', type: 'rocks', x: 30.0,  z: 22.0,  radius: 7.0, count: 3, seed: 41 },
            { id: 'pond_rocks', type: 'rocks', x: -9.0,  z: -27.0, radius: 4.0, count: 2, seed: 42 },

            // Луговая поляна в центре
            { id: 'glade',       type: 'meadow', x: 4.0,   z: 4.0,  radius: 22.0, count: 90, flowers: 14, seed: 51 },
            { id: 'path_meadow', type: 'meadow', x: -34.0, z: 14.0, radius: 9.0,  count: 25, flowers: 3,  seed: 52 }
        ],

        // Предметы на земле рядом со стартом: кучка камней, стопка брёвен,
        // топор, воткнутый в пень. Подобранное запоминается для каждого
        // персонажа отдельно (по id кучки) — не переименовывайте id зря.
        // Существа (content/creatures): крысы бродят у пруда и на каменистом холме —
        // мирные, пока их не ударить, потом дают сдачи. Стартовая поляна безопасна.
        // Вепрь-страж стоит у прохода к Озерному краю (aggressive, aggroRadius 8 м) -
        // поэтому spawns.fromLake отодвинут от портала на безопасное расстояние.
        creatures: [
            { id: 'pond_rat_1',  type: 'rat',  x: -3.0,  z: -8.0 },
            { id: 'pond_rat_2',  type: 'rat',  x: -9.0,  z: -1.0 },
            { id: 'hill_rat_1',  type: 'rat',  x: 27.0,  z: 19.0 },
            { id: 'hill_rat_2',  type: 'rat',  x: 29.5,  z: 26.0 },
            { id: 'portal_boar', type: 'boar', x: -49.5, z: 9.5,  r: 1.57 },
            { id: 'stump_fawn',  type: 'fawn', x: -8.0,  z: -12.0, r: 1.2 }
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
            boulders: [],
            shrubs: [
                { x: 18.0, z: 6.5, s: 1.6, r: 1.1 }
            ],
            ferns: [],
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
