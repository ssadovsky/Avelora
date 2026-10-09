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
            hills: { amplitude: 1.6, inclineX: 0.2, inclineZ: -0.15 },
            // Дороги локации:
            // 1. Грунтовая дорожка от точки старта до водопада и Лираэль
            // 2. Каменная мостовая от водопада (120, 4) к озеру в центре (-18, -16)
            paths: [
                {
                    type: 'dirt',
                    width: 2.6,
                    points: [
                        [127.0, 76.0], [124.5, 66.0], [126.5, 55.0], [124.0, 44.0],
                        [127.0, 33.0], [128.0, 25.0]
                    ]
                },
                {
                    type: 'stone',
                    width: 2.8,
                    points: [
                        [120.0, 4.0], [98.0, 5.0], [75.0, 7.5], [52.0, 5.0],
                        [30.0, 1.0], [15.0, -2.0]
                    ]
                }
            ]
        },

        atmosphere: { sky: 0xc6dbe3, skyTop: 0x4a8fc9, fogDensity: 0.0055 },
        cameraAngle: 0.0,           // на старте камера смотрит на север (по тропе к Лираэль)
        // Зоны без папоротников (поляна барсуков): эллипсы {x, z, rx, rz}
        noFerns: [{ x: 72.0, z: 62.0, rx: 32.0, rz: 28.0 }],

        spawns: {
            default:   { x: 127.0,  z: 77.5, r: 0.0 },   // новая игра: юго-восток долины, лицом на север к тропе (r: поворот модели = atan2+π, север = 0)
            camp:      { x: 6.0,    z: 12.0 },
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
            { x: 124.0,  z: 6.0, radius: 18.0 },  // чаша горного озера у водопада
            { x: 135.0,  z: 10.0, radius: 22.0 }, // скалы, чаша и каменные уступы водопада Stonewatch Falls
            // Просека вдоль грунтовой тропы от точки появления к Лираэль (лес не растёт на тропе)
            { x: 127.0, z: 75.0, radius: 6.0 }, { x: 124.5, z: 66.0, radius: 5.0 }, { x: 126.5, z: 55.0, radius: 5.0 },
            { x: 124.0, z: 44.0, radius: 5.0 }, { x: 127.0, z: 33.0, radius: 5.0 }, { x: 128.0, z: 25.0, radius: 6.0 },
            { x: 129.0, z: 19.5, radius: 6.0 },
            { x: 72.0, z: 55.0, radius: 12.0 },  // открытая поляна барсуков
            { x: 72.0, z: 72.0, radius: 11.0 }, { x: 55.0, z: 64.0, radius: 8.0 }, { x: 90.0, z: 64.0, radius: 8.0 },
            { x: 107.0, z: 67.5, radius: 6.5 }   // стартовый лагерь: пень с топором, брёвна, камни, посох
        ],

        groups: [
            // Горные леса у подножия хребта
            { id: 'north_rim_forest', type: 'forest', x: 0.0,    z: -78.0, rx: 110.0, rz: 14.0, count: 45, seed: 11 },
            { id: 'south_rim_forest', type: 'forest', x: 0.0,    z: 78.0,  rx: 110.0, rz: 14.0, count: 45, seed: 14 },
            // (восточный горный массив включён в единый северо-восточный бор ниже)
            { id: 'east_south_forest',type: 'forest', x: 116.0,  z: 48.0,  rx: 14.0,  rz: 24.0, count: 18, spacing: 10.0, seed: 16 },
            { id: 'west_north_forest',type: 'forest', x: -117.0, z: -56.0, rx: 20.0,  rz: 26.0, count: 26, seed: 17, types: ['fir_a', 'fir_b', 'fir_c'] },
            { id: 'west_south_forest',type: 'forest', x: -125.0, z: 62.0,  rx: 16.0,  rz: 28.0, count: 20, seed: 18 },

            // Лесочек вокруг поляны барсуков (без подлеска — папоротники здесь не растут)
            { id: 'badger_wood', type: 'forest', x: 72.0, z: 62.0, rx: 38.0, rz: 30.0, count: 30, seed: 91 },

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
            // Поляна папоротников на юго-востоке: цель квеста Лираэль «Принеси 10 папоротника»
            { id: 'quest_ferns', type: 'fernPatch', x: 97.5, z: 77.5, radius: 7.0, count: 18, seed: 73 },

            // Луговая поляна в центре и тропа
            { id: 'glade',       type: 'meadow', x: 4.0,   z: 4.0,  radius: 26.0, count: 120, flowers: 20, seed: 51 },
            { id: 'path_meadow', type: 'meadow', x: -34.0, z: 14.0, radius: 10.0, count: 35,  flowers: 5,  seed: 52 },
            { id: 'east_meadow', type: 'meadow', x: 80.0,  z: 6.0,  radius: 18.0, count: 60,  flowers: 10, seed: 53 },

            // === СЕВЕРО-ВОСТОЧНЫЙ ЛЕСНОЙ МАССИВ (просторное редколесье, шаг стволов ~10м) ===
            // 1. Северная горная кайма (у подножия северных скал Z: -61..-90, закрывает угол X: 126, Z: -78.5)
            { id: 'ne_mountain_rim_forest', type: 'forest', grass: false, x: 105.0, z: -76.0, rx: 34.0, rz: 15.0, count: 18, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 8, seed: 301 },

            // 2. Северо-западные скалистые склоны (стыкуется с центральным северным хребтом)
            { id: 'ne_northwest_highlands', type: 'forest', grass: false, x: 68.0, z: -74.0, rx: 18.0, rz: 14.0, count: 10, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 6, seed: 302 },

            // 3. Восточная горная стена (вдоль скалистого обрыва от водопада до севера, X: 114..140, Z: -33..-77)
            { id: 'ne_east_mountain_wall', type: 'forest', grass: false, x: 128.0, z: -55.0, rx: 14.0, rz: 22.0, count: 12, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 6, seed: 303 },

            // 4. Центрально-северная чаща (заделывает просеку между холмами, X: 77..127, Z: -32..-68)
            { id: 'ne_north_mid_forest', type: 'forest', grass: false, x: 102.0, z: -50.0, rx: 25.0, rz: 18.0, count: 15, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 8, seed: 304 },

            // 5. Лиственный бор на холмах лисиц (X: 56..96, Z: -22..-58)
            { id: 'ne_fox_hills_woods', type: 'forest', grass: false, x: 76.0, z: -40.0, rx: 20.0, rz: 18.0, count: 12, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 6, seed: 305 },

            // 6. Центральная чаща буков (высокие кроны, свободный шаг между стволами 10м, X: 80..132, Z: -9..-41)
            { id: 'ne_central_beech_woods', type: 'forest', grass: false, x: 106.0, z: -25.0, rx: 26.0, rz: 16.0, count: 16, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 8, seed: 306 },

            // 7. Лесистый гребень над водопадом (X: 114..138, Z: -12..-36)
            { id: 'ne_waterfall_ridge', type: 'forest', grass: false, x: 127.0, z: -24.0, rx: 13.0, rz: 15.0, count: 10, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, shrubs: 5, seed: 307 },

            // 8. Редколесье вдоль каменной дороги (деревья отступают минимум на 6м от края полотна дороги)
            { id: 'ne_roadside_forest', type: 'forest', grass: false, x: 85.0, z: -9.0, rx: 34.0, rz: 6.0, count: 12, spacing: 10.0, scaleMin: 0.9, scaleMax: 1.35, types: ['tree', 'small'], undergrowth: true, shrubs: 6, seed: 308 },

            // 9. Разновысокие проходимые кусты подлеска (растут естественными лесными куртинами)
            { id: 'ne_shrubs_central', type: 'shrubCluster', x: 104.0, z: -28.0, radius: 16.0, count: 10, seed: 310 },
            { id: 'ne_shrubs_north', type: 'shrubCluster', x: 105.0, z: -62.0, radius: 18.0, count: 12, seed: 311 },
            { id: 'ne_shrubs_fox', type: 'shrubCluster', x: 75.0, z: -35.0, radius: 14.0, count: 8, seed: 312 },
            { id: 'ne_shrubs_slope', type: 'shrubCluster', x: 124.0, z: -36.0, radius: 12.0, count: 8, seed: 313 },

            // 10. Декоративные замшелые камни (масштаб 0.10 .. 0.20)
            { id: 'ne_ores_1', type: 'oreCluster', x: 112.0, z: -22.0, radius: 12.0, count: 6, seed: 314 },
            { id: 'ne_ores_2', type: 'oreCluster', x: 82.0, z: -30.0, radius: 10.0, count: 5, seed: 315 },
            { id: 'ne_ores_north', type: 'oreCluster', x: 110.0, z: -65.0, radius: 14.0, count: 7, seed: 316 },

            // 11. Декоративные сухие ветки и сучья на лесной подстилке
            { id: 'ne_forest_branches_1', type: 'branches', x: 98.0, z: -28.0, radius: 18.0, count: 16, seed: 317 },
            { id: 'ne_forest_branches_2', type: 'branches', x: 108.0, z: -55.0, radius: 20.0, count: 18, seed: 318 },

            // === Юго-восточный сектор (Z 5..35, лагерь Лираэль и крысы): аккуратные перелески ===
            { id: 'lirael_east_woods', type: 'forest', x: 136.0, z: 34.0, rx: 5.0, rz: 6.0, count: 6, spacing: 10.0, types: ['tree', 'small'], undergrowth: true, seed: 141 },
            { id: 'lirael_west_copse', type: 'forest', x: 106.0, z: 20.0, radius: 8.0, count: 8, types: ['tree', 'small'], undergrowth: true, seed: 142 },
            { id: 'waterfall_rocks', type: 'rocks', x: 128.0, z: 5.5, radius: 5.0, count: 4, seed: 161 },

            // === ТРАВА СЕВЕРО-ВОСТОЧНОГО ЛЕСА: отдельный слой, одиночные кустики 4 видов (grass_set), БЕЗ куч ===
            // Те же эллипсы, что у лесных групп выше; rng у всех свой. Плотность — кустиков на 100 м² (density), минимум 2.6 м между кустиками.
            // Группы стоят после всех ne_* лесов и кустов, чтобы кустики обходили стволы (≥1.3 м) и кустарник (≥1.2 м). Остальные леса и луга не тронуты.
            { id: 'mountain_rim_forest_grass', type: 'grassland', x: 105.0, z: -76.0, rx: 34.0, rz: 15.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 401 },
            { id: 'northwest_highlands_grass', type: 'grassland', x: 68.0, z: -74.0, rx: 18.0, rz: 14.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 402 },
            { id: 'east_mountain_wall_grass', type: 'grassland', x: 128.0, z: -55.0, rx: 14.0, rz: 22.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 403 },
            { id: 'north_mid_forest_grass', type: 'grassland', x: 102.0, z: -50.0, rx: 25.0, rz: 18.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 404 },
            { id: 'fox_hills_woods_grass', type: 'grassland', x: 76.0, z: -40.0, rx: 20.0, rz: 18.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 405 },
            { id: 'central_beech_woods_grass', type: 'grassland', x: 106.0, z: -25.0, rx: 26.0, rz: 16.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 406 },
            { id: 'waterfall_ridge_grass', type: 'grassland', x: 127.0, z: -24.0, rx: 13.0, rz: 15.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 407 },
            { id: 'roadside_forest_grass', type: 'grassland', x: 85.0, z: -9.0, rx: 34.0, rz: 6.0, density: 6, spacing: 2.6, scaleMin: 1.0, scaleMax: 1.5, seed: 408 }
        ],

        // Существа в долине:
        // Вепрь-страж охраняет вход в горный каньон к Озерному краю
        creatures: [
            // Тестовые новые звери: медведь и волк агрессивные, лисы мирные
            { id: 'bear_1', type: 'bear', x: 103.0, z: -60.0, r: 0 },
            { id: 'wolf_1', type: 'wolf', x: 55.0, z: -60.0, r: 0 },
            // Яша (Sailback Fury): сильнее медведя; пока не агрессивный (behavior: 'retaliate' в content/creatures/yasha)
            { id: 'yasha_1', type: 'yasha', x: 0.0, z: 60.0, r: -2.89 },
            // 5 огненных лисиц на холмах к северу от водопада (квест Лираэль)
            { id: 'fox_1', type: 'fire_fox', x: 88.0, z: -24.0, r: 1.0 },
            { id: 'fox_2', type: 'fire_fox', x: 104.0, z: -28.0, r: 3.0 },
            { id: 'fox_3', type: 'fire_fox', x: 93.0, z: -38.0, r: 5.0 },
            { id: 'fox_4', type: 'fire_fox', x: 81.0, z: -33.0, r: 2.2 },
            { id: 'fox_5', type: 'fire_fox', x: 100.0, z: -43.0, r: 4.1 },
            // Серый волк в лесной глуши за озером (квест Лираэль)
            { id: 'forest_wolf', type: 'wolf', x: -60.0, z: -35.0, r: 1.8 },
            // Десяток крыс (все с локации собраны сюда, вокруг 90; 19)
            { id: 'rat_1', type: 'rat', x: 78.0, z: 21.9, r: 5.8 },
            { id: 'rat_2', type: 'rat', x: 84.0, z: 16.1, r: 3.21 },
            { id: 'rat_3', type: 'rat', x: 79.8, z: 10.6, r: 0.59 },
            { id: 'rat_4', type: 'rat', x: 88.5, z: 22.7, r: 5.08 },
            { id: 'rat_5', type: 'rat', x: 106.8, z: 17.6, r: 4.11 },
            { id: 'rat_6', type: 'rat', x: 97.1, z: 21.1, r: 1.52 },
            { id: 'rat_7', type: 'rat', x: 97.9, z: 9.8, r: 1.98 },
            { id: 'rat_8', type: 'rat', x: 103.7, z: 23.9, r: 2.51 },
            { id: 'rat_9', type: 'rat', x: 91.8, z: 12.4, r: 0.55 },
            { id: 'rat_10', type: 'rat', x: 81.9, z: 30.1, r: 4.76 },
            // Радужные барсуки в лесочке на юге (на них — квест Лираэль)
            { id: 'badger_1', type: 'badger', x: 83.8, z: 77.0, r: 3.99 },
            { id: 'badger_2', type: 'badger', x: 59.1, z: 63.3, r: 4.98 },
            { id: 'badger_3', type: 'badger', x: 79.1, z: 47.9, r: 3.17 },
            { id: 'badger_4', type: 'badger', x: 72.1, z: 63.2, r: 2.33 },
            { id: 'badger_5', type: 'badger', x: 65.7, z: 59.2, r: 4.98 },
            { id: 'badger_6', type: 'badger', x: 73.5, z: 72.1, r: 0.27 },
            { id: 'badger_7', type: 'badger', x: 96.1, z: 61.7, r: 5.5 },
            { id: 'badger_8', type: 'badger', x: 62.6, z: 75.0, r: 0.73 },
            { id: 'badger_9', type: 'badger', x: 88.2, z: 58.2, r: 0.97 },
            { id: 'badger_10', type: 'badger', x: 76.1, z: 55.2, r: 5.83 },
            { id: 'badger_11', type: 'badger', x: 52.1, z: 66.5, r: 2.15 },
            { id: 'badger_12', type: 'badger', x: 74.3, z: 80.5, r: 1.31 },
            { id: 'badger_13', type: 'badger', x: 72.7, z: 43.7, r: 3.65 },
            { id: 'badger_14', type: 'badger', x: 51.0, z: 75.8, r: 2.43 },
            { id: 'badger_15', type: 'badger', x: 80.4, z: 63.1, r: 4.51 },
            { id: 'waterfall_fawn', type: 'fawn', x: 110.0, z: 12.0, r: 2.8 },
            { id: 'portal_boar', type: 'boar', x: -118.0, z: 8.0,  r: 1.57 },
            // Оленёнок перемещён на сушу юго-восточнее пруда (раньше стоял в воде)
            { id: 'stump_fawn',  type: 'fawn', x: 4.0,    z: -7.0,  r: 1.2 },
            // Минотавр неагрессивный: патрулирует туда-обратно вдоль берега
            { id: 'minotaur_1', type: 'minotaur', x: 0.0, z: -50.0, r: 0.5,
              patrol: [{ x: 0.0, z: -40.0 }, { x: 0.0, z: -60.0 }] },
            // Красная панда за водопадом: танцует 3 танца по очереди, при нападении защищается боксом
            { id: 'waterfall_red_panda', type: 'red_panda', x: 127.0, z: -9.0, r: -1.57 },
            // Олениха-друид (Forest Doe Enchantress): мирно гуляет по каменной дороге от водопада к озеру
            { id: 'forest_doe_1', type: 'forest_doe', x: 120.0, z: 4.0, r: -1.57,
              patrol: [
                { x: 120.0, z: 4.0 },
                { x: 98.0, z: 5.0 },
                { x: 75.0, z: 7.5 },
                { x: 52.0, z: 5.0 },
                { x: 30.0, z: 1.0 },
                { x: 15.0, z: -2.0 }
              ]
            }
        ],

        pickups: [
            { id: 'start_stones', item: 'stone', count: 5, x: 105.0, z: 65.8 },
            { id: 'start_logs',   item: 'log',   count: 3, x: 109.0, z: 65.8, r: 0.5 },
            // Топор воткнут лезвием в срез пня (пень — в props ниже, центр 1.0/18.0).
            // x, z, y — точка хвата (низ топорища), y — высота над землёй;
            // rotation — наклон [x, y, z]: топорище смотрит вверх-наружу, лезвие в дереве.
            { id: 'stump_axe',    item: 'axe',   count: 1, x: 107.35, z: 68.12, y: 0.72, rotation: [3.142, 0.347, 1.082] },
            // Кирка лежит на земле рядом с пеньком
            { id: 'stump_pickaxe', item: 'pickaxe', count: 1, x: 106.3, z: 68.4, y: 0.04, r: 0.7 },
            // Кинжал лежит у пня; посох (маг) и лук (лучница) выдаёт Лираэль за первый квест
            { id: 'start_dagger', item: 'dagger', count: 1, y: 0.03, x: 108.6, z: 70.4, rotation: [0, 0.9, -1.571] }
        ],

        props: [
            { id: 'start_stump', prop: 'stump', x: 107.0, z: 68.0, r: 0.4, s: 1.0 },
            // Лираэль, Хранительница Каменного Дозора (NPC у водопада)
            { id: 'forestEdge.lirael', prop: 'npc_lirael', x: 129.0, z: 19.5, r: 0.0 },

            // Декоративные поваленные стволы в северном лесу (проходимые, персонаж переступает)
            { id: 'ne_log_1', prop: 'fallen_log', x: 106.0, z: -18.0, r: 0.8, s: 2.8, noObstacle: true },
            { id: 'ne_log_2', prop: 'fallen_log', x: 124.0, z: -26.0, r: -0.5, s: 2.6, noObstacle: true },
            { id: 'ne_log_3', prop: 'fallen_log', x: 88.0, z: -32.0, r: 1.3, s: 2.5, noObstacle: true },
            { id: 'ne_log_4', prop: 'fallen_log', x: 110.0, z: -56.0, r: 2.1, s: 2.7, noObstacle: true },
            { id: 'ne_log_5', prop: 'fallen_log', x: 96.0, z: -72.0, r: 0.4, s: 2.6, noObstacle: true },

            // Декоративные лесные пни в северном лесу (проходимые)
            { id: 'ne_stump_1', prop: 'stump', x: 114.0, z: -12.0, r: 0.4, s: 1.2, noObstacle: true },
            { id: 'ne_stump_2', prop: 'stump', x: 92.0, z: -22.0, r: 1.1, s: 1.3, noObstacle: true },
            { id: 'ne_stump_3', prop: 'stump', x: 104.0, z: -64.0, r: 1.8, s: 1.2, noObstacle: true }
        ],

        decorations: {
            // Одинокое большое дерево на поляне (ставится вручную)
            trees: [
                { x: 14.0, z: 8.5, s: 1.6, r: 0.3 },
                // Колчанное дерево (пальма) у портала
                { x: -123.0, z: -8.0, s: 1.1, r: 0.8, treeType: 'quiver' }
            ],
            // 6 замшелых валунов для добычи камня и железа вдоль тропы под восточными горами к водопаду
            ores: [
                { x: 134.5, z: 70.0, modelIndex: 0, s: 0.28, r: 0.4 },
                { x: 135.0, z: 58.0, modelIndex: 1, s: 0.25, r: 1.2 },
                { x: 133.8, z: 47.0, modelIndex: 2, s: 0.29, r: 2.1 },
                { x: 135.5, z: 36.0, modelIndex: 3, s: 0.24, r: 0.8 },
                { x: 134.0, z: 25.0, modelIndex: 4, s: 0.26, r: 2.8 },
                { x: 135.2, z: 14.0, modelIndex: 5, s: 0.25, r: 1.6 }
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
                // 4 отдельных кустика из shrub_01 (первые 2 и последние 2 по одному на опушке перед лесом)
                { x: 108.0, z: -15.0, s: 1.0, r: 0.4, shrubType: 'shrub_a' }, // первый 1 (густой)
                { x: 112.0, z: -16.0, s: 1.0, r: 1.8, shrubType: 'shrub_b' }, // первый 2 (густой)
                { x: 116.0, z: -15.0, s: 1.0, r: 2.7, shrubType: 'shrub_c' }, // последний 1 (компактный)
                { x: 120.0, z: -17.0, s: 1.0, r: 0.9, shrubType: 'shrub_d' }, // последний 2 (компактный)
                // Отдельные кусты в глубине леса у поваленных брёвен
                { x: 104.0, z: -20.0, s: 1.1, r: 1.2, shrubType: 'shrub_a' },
                { x: 92.0,  z: -26.0, s: 1.0, r: 2.1, shrubType: 'shrub_b' },
                { x: 122.0, z: -28.0, s: 1.1, r: 0.5, shrubType: 'shrub_c' },
                { x: 125.0, z: -32.0, s: 1.0, r: 1.6, shrubType: 'shrub_d' }
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
            reeds: [],
            grass: []
        }
    },

    // ------------------------------------------------------------------
    // Домашний лагерь — тихая солнечная поляна с речкой. Попасть сюда можно только навыком
    // «Возвращение домой» (content/skills/home_recall); им же возвращаются в прежнюю локацию.
    // ------------------------------------------------------------------
    homeCamp: {
        id: 'homeCamp',
        name: 'Домашний лагерь',

        terrain: {
            size: 160,
            seed: 7311,
            biome: 'forest',
            groundSet: 'meadow',  // прежнее ровное зелёное покрытие (лесная подстилка — только в первой локации)
            segments: 240,
            baseHeight: 1.1,        // суша заметно выше воды: без луж вне русла
            groundNoise: 0.0,       // ровная земля под будущую застройку (горы по краю и русло остаются)
            // РЕЧКА: русло вдоль сглаженной линии points [x, z]; вода (Y = 0) закрывает карту целиком,
            // но видна только там, где рельеф ниже нуля. Перейти вброд нельзя (глубина): через речку — мост.
            waterBody: {
                type: 'river',
                width: 5.5,
                depth: -0.9,
                beachWidth: 3.2,
                points: [[-84, -18], [-56, -26], [-30, -21], [-8, -25], [0, -25], [8, -25], [32, -30], [58, -23], [84, -28]]
            },
            // Мост через речку в центре карты (палуба = проходимая высота, см. terrain.getHeightAt)
            bridges: [{ x: 0.0, z: -25.0, length: 12.0, width: 3.0, deckY: 1.25 }],
            hills: { amplitude: 0.0, inclineX: 0.0, inclineZ: 0.0 }
        },

        cameraAngle: 0.0,           // на старте камера смотрит на север по компасу (север = −Z)

        atmosphere: { sky: 0xd6e6dc, skyTop: 0x4f97d6, fogDensity: 0.0045 },

        spawns: {
            default: { x: -10.0, z: -8.5, r: -1.7 }   // южный берег, слева от моста, лицом к костру
        },

        exits: [],

        clearings: [
            { x: -14.0, z: -9.0, radius: 4.0 },    // костровище
            { x: -10.0, z: -8.5, radius: 2.2 },    // точка появления
            { x: -18.5, z: -9.5, radius: 1.6 },    // сундук
            { x: 0.0, z: -16.0, radius: 3.5 },     // подход к мосту (юг)
            { x: 0.0, z: -34.0, radius: 3.5 }      // подход к мосту (север)
        ],

        groups: [
            // Южный берег (лагерь): чистая земля под застройку — никакой травы-кустиков, камней и деревьев

            // Северный берег: луг, камни и лес
            { id: 'meadow_n1',  type: 'meadow', x: -28.0, z: -38.0, radius: 9.0, count: 35, flowers: 5, seed: 304 },
            { id: 'meadow_n2',  type: 'meadow', x: 26.0,  z: -42.0, radius: 9.0, count: 35, flowers: 5, seed: 305 },
            { id: 'rocks_n1',   type: 'rocks',  x: -40.0, z: -44.0, radius: 6.0, count: 4, seed: 321 },
            { id: 'rocks_n2',   type: 'rocks',  x: 42.0,  z: -38.0, radius: 6.0, count: 3, seed: 322 },
            { id: 'forest_n1',  type: 'forest', x: -34.0, z: -54.0, rx: 22.0, rz: 6.0, count: 12, seed: 331 },
            { id: 'forest_n2',  type: 'forest', x: 34.0,  z: -54.0, rx: 22.0, rz: 6.0, count: 12, seed: 332 },
            { id: 'ferns_n',    type: 'fernPatch', x: 12.0, z: -44.0, radius: 5.0, count: 10, seed: 311 },

            // Камыш вдоль речки
            { id: 'reeds_a',    type: 'reeds', x: -56.0, z: -26.0, radius: 6.0, count: 25, seed: 341 },
            { id: 'reeds_b',    type: 'reeds', x: -30.0, z: -21.0, radius: 6.0, count: 35, seed: 342 },
            { id: 'reeds_c',    type: 'reeds', x: -14.0, z: -25.0, radius: 4.0, count: 20, seed: 343 },
            { id: 'reeds_d',    type: 'reeds', x: 20.0,  z: -27.0, radius: 6.0, count: 30, seed: 344 },
            { id: 'reeds_e',    type: 'reeds', x: 56.0,  z: -24.0, radius: 6.0, count: 30, seed: 345 }
        ],

        // Костровище: огонь и брёвна-сиденья (content/props/campfire, огонь — js/fire.js)
        props: [
            { id: 'homeCamp.campfire', prop: 'campfire', x: -14.0, z: -9.0, r: 0.5, s: 1.7 },
            // Сундук для излишков (содержимое хранится в сохранении персонажа)
            { id: 'homeCamp.chest1', prop: 'chest', x: -18.5, z: -9.5, r: 0.5 }
        ]
    }
};

// Совместимость со старым кодом: текущая локация (движок обновляет её при переходах)
window.CURRENT_LOCATION = window.LOCATIONS[window.START_LOCATION];
