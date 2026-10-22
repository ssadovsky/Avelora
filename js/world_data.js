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
 * Для быстрого теста локации: откройте index.html#savanna (имя локации после #).
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
    // каменистый холм, проход на запад — в Золотую саванну.
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
            landFloor: 0.85, groundSet: 'baseForest',    // комбинированное покрытие: moss2 как база + лес/трава по реальным деревьям (маска uForestMap)

            // Естественный горный барьер по периметру (высота 6м, пики до 9м)
            mountainRim: { width: 16.0, height: 6.0 },
            // Горный перевал (ущелье) на запад в Золотую саванну
            mountainPasses: [],   // выреза нет: портал стоит на ровной земле перед горным поясом (пояс с x=-134)
            // Ровная площадка под порталом (радиус 4.5 м, дальше 5 м плавно возвращается к рельефу)
            flatSpots: [{ x: -128.0, z: 8.0, radius: 4.5, blend: 5.0 }, { x: 70.0, z: -15.0, radius: 4.6, blend: 5.0 }, { x: 25.5, z: -20.1, radius: 3.4, blend: 4.0 }],   // 2-й: под домиком, 3-й: под беседкой
            // Арочный вырез в восточном горном барьере для грота (севернее водопада)
            caves: [
                { x: 139.5, z: -18.0, minX: 134.0, maxX: 143.5, radiusZ: 3.5, backLen: 1.0, tintRadius: 26.0, tintStrength: 0.85 }
            ],

            waterBody: {
                type: 'lake',
                x: -20.0,
                z: -18.0,
                radius: 20.0,
                depth: -1.2,
                beachWidth: 18.0,
                shoreSmooth: true
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
                    smooth: { width: 3.0, blend: 7.0, win: 4 },   // рельеф вдоль дороги сглажен (профиль высот усреднён)
                    points: [
                        [120.0, 4.0], [98.0, 5.0], [75.0, 7.5], [52.0, 5.0],
                        [30.0, 1.0], [15.0, -2.0]
                    ]
                },
                {   // тонкая тропинка от каменной дороги к домику (70, -15), вход на юг
                    type: 'dirt', thin: true, width: 1.2, clearMargin: 1.4,
                    points: [[73.4, 4.9], [73.4, 2.0], [72.2, -2.0], [70.8, -7.0], [70.0, -11.9]]
                }
            ]
        },

        atmosphere: { sky: 0xc6dbe3, skyTop: 0x4a8fc9, fogDensity: 0.0055 },
        cameraAngle: 0.0,           // на старте камера смотрит на север (по тропе к Лираэль)
        // Зоны без папоротников (поляна барсуков): эллипсы {x, z, rx, rz}
        noFerns: [{ x: 72.0, z: 62.0, rx: 32.0, rz: 28.0 }, { x: 25.5, z: -17.5, rx: 6.0, rz: 8.5 }],   // 2-й: беседка и подход к ней

        spawns: {
            default:   { x: 127.0,  z: 77.5, r: 0.0 },   // новая игра: юго-восток долины, лицом на север к тропе (r: поворот модели = atan2+π, север = 0)
            camp:      { x: 6.0,    z: 12.0 },
            fromSavanna:  { x: -104.0, z: 8.0, r: 4.71 },  // выход из портала: в 14 м от рунного вепря (aggro 9), лицом на восток в долину
            waterfall: { x: 104.0,  z: 6.0, r: 4.71 },  // с видом на восточный каскадный водопад
            fromDungeon: { x: 135.0, z: -18.0, r: 1.57 } // площадка перед входом в пещеру (лицом на запад к долине)
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

        // Компактный грот-пещера в скалах за водопадом (вход на запад)
        grottos: [
            {
                id: 'torchlit_grotto',
                modelKey: 'torchlit_grotto',
                x: 139.5,
                z: -18.0,
                y: 3.44,                        // пол модели = 1.50, на 0.1 м выше земли внутри (terrain.caves: 1.40) — без мерцания
                scale: 4.55,
                rotationY: -Math.PI / 2         // вход смотрит на запад
            }
        ],

        exits: [
            // Проход в Золотую саванну через горный каньон на западе
            { id: 'toLake', x: -128.0, z: 8.0, radius: 3.5, to: 'savanna', spawn: 'fromForest', label: 'Золотая саванна' },
            // Тайный рунический портал в глубине пещеры (переход в подземелье)
            {
                id: 'toDungeon',
                x: 140.0,
                z: -17.7,
                y: 1.52,          // каменный пол грота
                radius: 1.3,
                height: 2.2,      // световой луч под сводом пещеры
                color: 0x6e8fff,  // мистический сине-фиолетовый рунный свет
                to: 'ancientCatacombs',
                spawn: 'entrance',
                label: 'В глубины подземелья'
            }
        ],

            // Тропы и поляны (свободные от плотных деревьев)
        clearings: [
            { x: -136.0, z: 8.0, radius: 8.0 },
            { x: -122.0, z: 8.0, radius: 8.0 },
            { x: -108.0, z: 8.0, radius: 7.0 },
            { x: -80.0,  z: 8.0, radius: 7.0 },
            { x: -65.0,  z: 20.0, radius: 16.0 }, // поляна выставки новых деревьев около озера
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
            { x: 30.0, z: 51.0, radius: 18.0 },  // поляна петухов (к западу от барсуков)
            { x: -78.0, z: 49.0, radius: 28.0 }, // юго-западная поляна синих пауков
            { x: 72.0, z: 72.0, radius: 11.0 }, { x: 55.0, z: 64.0, radius: 8.0 }, { x: 90.0, z: 64.0, radius: 8.0 },
            { x: 107.0, z: 67.5, radius: 6.5 },  // стартовый лагерь: пень с топором, брёвна, камни, посох
            { x: 70.0, z: -14.0, radius: 8.0 },  // домик и наковальня (70, -15)
            { x: 25.5, z: -20.1, radius: 4.5 }   // беседка между четырьмя дубами
        ],

        groups: [
            // Горные леса у подножия хребта
            { id: 'north_rim_forest', type: 'forest', x: 0.0,    z: -78.0, rx: 110.0, rz: 14.0, count: 45, seed: 11 },
            { id: 'south_rim_forest', type: 'forest', x: 0.0,    z: 78.0,  rx: 110.0, rz: 14.0, count: 45, seed: 14 },
            // (восточный горный массив включён в единый северо-восточный бор ниже)
            { id: 'east_south_forest',type: 'forest', x: 116.0,  z: 48.0,  rx: 14.0,  rz: 24.0, count: 18, spacing: 10.0, seed: 16 },
            { id: 'west_north_forest',type: 'forest', x: -115.0, z: -56.0, rx: 24.0,  rz: 31.0, count: 42, seed: 17, types: ['evergreen', 'fir_a', 'evergreen', 'fir_b', 'evergreen', 'fir_c'] },
            { id: 'west_south_forest',type: 'forest', x: -125.0, z: 62.0,  rx: 16.0,  rz: 28.0, count: 20, seed: 18 },

            // Лесочек вокруг поляны барсуков (без подлеска — папоротники здесь не растут)
            { id: 'badger_wood', type: 'forest', x: 72.0, z: 62.0, rx: 38.0, rz: 30.0, count: 30, seed: 91 },

            // Рощи внутри просторной долины
            { id: 'oak_grove',   type: 'forest', x: 26.0,  z: -20.0, radius: 11.0, count: 12, seed: 21 },
            { id: 'birch_copse', type: 'forest', x: -12.0, z: 32.0,  radius: 8.0,  count: 8,  seed: 22, undergrowth: true },
            { id: 'west_grove',  type: 'forest', x: -65.0, z: -25.0, radius: 10.0, count: 9,  seed: 23 },

            // Лесной пруд: двойные заросли на берегу перед игроком + куртины по периметру озера (все строго на кромке воды)
            { id: 'pond_reeds_1', type: 'reeds', x: -8.8, z: -6.8, radius: 3.2, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 31 },
            { id: 'pond_reeds_2', type: 'reeds', x: -27.9, z: -2.6, radius: 3.2, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 48 },
            { id: 'pond_reeds_3', type: 'reeds', x: -41.6, z: -21.4, radius: 3.2, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 65 },
            { id: 'pond_reeds_4', type: 'reeds', x: -23.5, z: -40.0, radius: 3.2, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 82 },
            { id: 'pond_reeds_5', type: 'reeds', x: -3.3, z: -26.5, radius: 3.2, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 99 },

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
        // Вепрь-страж охраняет вход в горный каньон в Золотую саванну
        creatures: [
            // Тестовые новые звери: медведь и волк агрессивные (5 уровень, Элита)
            { id: 'bear_1', type: 'bear', level: 7, rank: 'elite', x: 103.0, z: -60.0, r: 0 },
            // Яша (Sailback Fury): сильнее медведя; босс 8 уровня
            { id: 'yasha_1', type: 'yasha', level: 8, rank: 'boss', x: 0.0, z: 60.0, r: -2.89 },
            // Громовой Коготь (Thunderclaw): гигантский теропод-босс 10 уровня
            { id: 'thunderclaw_1', type: 'thunderclaw', level: 10, rank: 'boss', x: -27.0, z: 45.0, r: 0.6 },
            // 5 огненных лисиц на холмах к северу от водопада (3 уровень, квест Лираэль)
            { id: 'fox_1', type: 'fire_fox', level: 5, x: 88.0, z: -24.0, r: 1.0 },
            { id: 'fox_2', type: 'fire_fox', level: 5, x: 104.0, z: -28.0, r: 3.0 },
            { id: 'fox_3', type: 'fire_fox', level: 5, x: 93.0, z: -38.0, r: 5.0 },
            { id: 'fox_4', type: 'fire_fox', level: 5, x: 81.0, z: -33.0, r: 2.2 },
            { id: 'fox_5', type: 'fire_fox', level: 5, x: 100.0, z: -43.0, r: 4.1 },
            // Серый волк по центру севера долины у горной гряды (5 уровень, Элита, квест «Охота на волка»)
            { id: 'forest_wolf', type: 'wolf', level: 7, rank: 'elite', x: 0.0, z: -72.0, r: 0.0 },
            // 10 янтарных стрекоз на северо-западе: летают над лугом (8 уровень, квест Оленихи)
            { id: 'dragonfly_1', type: 'dragonfly', level: 8, x: -66.0, z: -58.0, r: 1.70 },
            { id: 'dragonfly_2', type: 'dragonfly', level: 8, x: -48.1, z: -54.5, r: 3.40 },
            { id: 'dragonfly_3', type: 'dragonfly', level: 8, x: -76.2, z: -37.3, r: 5.10 },
            { id: 'dragonfly_4', type: 'dragonfly', level: 8, x: -83.0, z: -54.0, r: 0.60 },
            { id: 'dragonfly_5', type: 'dragonfly', level: 8, x: -57.7, z: -41.0, r: 2.30 },
            { id: 'dragonfly_6', type: 'dragonfly', level: 8, x: -86.3, z: -28.4, r: 4.00 },
            { id: 'dragonfly_7', type: 'dragonfly', level: 8, x: -57.2, z: -64.4, r: 5.70 },
            { id: 'dragonfly_8', type: 'dragonfly', level: 8, x: -79.4, z: -64.5, r: 1.20 },
            { id: 'dragonfly_9', type: 'dragonfly', level: 8, x: -36.4, z: -62.1, r: 2.90 },
            { id: 'dragonfly_10', type: 'dragonfly', level: 8, x: -69.0, z: -46.5, r: 4.60 },
            // 10 лесных пчел на поляне (1 уровень, расширенная зона клевера X: 76..103, Z: 12..31)
            { id: 'bee_1',  type: 'bee', level: 3, x: 80.0, z: 22.0, r: 0.4 },
            { id: 'bee_2',  type: 'bee', level: 3, x: 86.5, z: 15.5, r: 2.1 },
            { id: 'bee_3',  type: 'bee', level: 3, x: 92.0, z: 24.5, r: 4.3 },
            { id: 'bee_4',  type: 'bee', level: 3, x: 98.5, z: 12.0, r: 1.2 },
            { id: 'bee_5',  type: 'bee', level: 3, x: 103.0, z: 20.0, r: 3.5 },
            { id: 'bee_6',  type: 'bee', level: 3, x: 77.5, z: 28.5, r: 1.8 },
            { id: 'bee_7',  type: 'bee', level: 3, x: 82.0, z: 31.0, r: 4.9 },
            { id: 'bee_8',  type: 'bee', level: 3, x: 76.0, z: 25.0, r: 0.9 },
            { id: 'bee_9',  type: 'bee', level: 3, x: 84.5, z: 26.5, r: 2.7 },
            { id: 'bee_10', type: 'bee', level: 3, x: 79.5, z: 33.5, r: 5.3 },
            // Радужные барсуки в лесочке на юге (1 уровень, квест Лираэль)
            { id: 'badger_1', type: 'badger', level: 1, x: 83.8, z: 77.0, r: 3.99 },
            { id: 'badger_2', type: 'badger', level: 2, x: 59.1, z: 63.3, r: 4.98 },
            { id: 'badger_3', type: 'badger', level: 2, x: 79.1, z: 47.9, r: 3.17 },
            { id: 'badger_4', type: 'badger', level: 2, x: 72.1, z: 63.2, r: 2.33 },
            { id: 'badger_5', type: 'badger', level: 2, x: 65.7, z: 59.2, r: 4.98 },
            { id: 'badger_6', type: 'badger', level: 2, x: 73.5, z: 72.1, r: 0.27 },
            { id: 'badger_7', type: 'badger', level: 1, x: 96.1, z: 61.7, r: 5.5 },
            { id: 'badger_8', type: 'badger', level: 2, x: 62.6, z: 75.0, r: 0.73 },
            { id: 'badger_9', type: 'badger', level: 2, x: 88.2, z: 58.2, r: 0.97 },
            { id: 'badger_10', type: 'badger', level: 2, x: 76.1, z: 55.2, r: 5.83 },
            { id: 'badger_11', type: 'badger', level: 2, x: 52.1, z: 66.5, r: 2.15 },
            { id: 'badger_12', type: 'badger', level: 2, x: 74.3, z: 80.5, r: 1.31 },
            { id: 'badger_13', type: 'badger', level: 2, x: 72.7, z: 43.7, r: 3.65 },
            { id: 'badger_14', type: 'badger', level: 2, x: 51.0, z: 75.8, r: 2.43 },
            { id: 'badger_15', type: 'badger', level: 2, x: 80.4, z: 63.1, r: 4.51 },
            { id: 'waterfall_fawn', type: 'fawn', level: 5, rank: 'elite', x: 110.0, z: 12.0, r: 2.8 },
            // Рунный вепрь-страж у портала в Золотую саванну (10 уровень, Элита)
            { id: 'portal_rune_boar', type: 'rune_boar', level: 10, rank: 'elite', x: -118.0, z: 8.0, r: 1.57 },
            // 10 обычных вепрей на северо-востоке долины (4 уровень, квест «Охота на вепрей»)
            { id: 'boar_1', type: 'boar', level: 6, x: 66.0, z: -58.0, r: 1.20 },
            { id: 'boar_2', type: 'boar', level: 6, x: 52.0, z: -62.0, r: 4.00 },
            { id: 'boar_3', type: 'boar', level: 6, x: 78.0, z: -48.0, r: 2.50 },
            { id: 'boar_4', type: 'boar', level: 6, x: 54.0, z: -48.0, r: 0.60 },
            { id: 'boar_5', type: 'boar', level: 6, x: 66.0, z: -44.0, r: 5.10 },
            { id: 'boar_6', type: 'boar', level: 6, x: 42.0, z: -56.0, r: 3.30 },
            { id: 'boar_7', type: 'boar', level: 6, x: 64.0, z: -32.0, r: 1.90 },
            { id: 'boar_8', type: 'boar', level: 6, x: 52.0, z: -36.0, r: 4.40 },
            { id: 'boar_9', type: 'boar', level: 6, x: 38.0, z: -44.0, r: 2.80 },
            { id: 'boar_10', type: 'boar', level: 6, x: 82.0, z: -62.0, r: 0.30 },
            // Утки на мелководье озера у (-10, -30), 6 шт, вразброс (1 уровень, мирные)
            { id: 'lake_duck_1', type: 'duck', level: 1, x: -12, z: -34, r: 0.8 },
            { id: 'lake_duck_2', type: 'duck', level: 1, x: -6, z: -30.5, r: 2.4 },
            { id: 'lake_duck_3', type: 'duck', level: 1, x: -1, z: -28, r: 4.0 },
            { id: 'lake_duck_4', type: 'duck', level: 1, x: -16.5, z: -37.5, r: 5.5 },
            { id: 'lake_duck_5', type: 'duck', level: 1, x: -4, z: -25.5, r: 1.3 },
            { id: 'lake_duck_6', type: 'duck', level: 1, x: -14, z: -28.5, r: 3.4 },
            // Красная панда за водопадом (3 уровень, защищается боксом)
            { id: 'waterfall_red_panda', type: 'red_panda', level: 3, x: 127.0, z: -9.0, r: -1.57 },
            // Оленёнок рядом с друидом
            { id: 'doe_fawn', type: 'spotted_fawn', level: 1, x: 8.0, z: 7.5, r: -2.30 },
            // Синие пауки на юго-западе долины (9 уровень, квест «Синие пауки»)
            { id: 'blue_spider_1', type: 'blue_spider', level: 9, x: -100.0, z: 40.0, r: 0.00 },
            { id: 'blue_spider_2', type: 'blue_spider', level: 9, x: -88.0, z: 38.0, r: 1.90 },
            { id: 'blue_spider_3', type: 'blue_spider', level: 9, x: -76.0, z: 42.0, r: 3.80 },
            { id: 'blue_spider_4', type: 'blue_spider', level: 9, x: -64.0, z: 40.0, r: 5.70 },
            { id: 'blue_spider_5', type: 'blue_spider', level: 9, x: -54.0, z: 47.0, r: 1.32 },
            { id: 'blue_spider_6', type: 'blue_spider', level: 9, x: -96.0, z: 51.0, r: 3.22 },
            { id: 'blue_spider_7', type: 'blue_spider', level: 9, x: -82.0, z: 52.0, r: 5.12 },
            { id: 'blue_spider_8', type: 'blue_spider', level: 9, x: -68.0, z: 55.0, r: 0.74 },
            { id: 'blue_spider_9', type: 'blue_spider', level: 9, x: -57.0, z: 59.0, r: 2.64 },
            { id: 'blue_spider_10', type: 'blue_spider', level: 9, x: -91.0, z: 60.0, r: 4.54 },
            // Рыжие петухи: поляна к западу от барсучьего луга (3 уровень)
            { id: 'rooster_1', type: 'rooster', level: 5, x: 18.0, z: 44.0, r: 0.00 },
            { id: 'rooster_2', type: 'rooster', level: 5, x: 28.0, z: 41.0, r: 1.70 },
            { id: 'rooster_3', type: 'rooster', level: 5, x: 38.0, z: 45.0, r: 3.40 },
            { id: 'rooster_4', type: 'rooster', level: 5, x: 22.0, z: 52.0, r: 5.10 },
            { id: 'rooster_5', type: 'rooster', level: 5, x: 32.0, z: 50.0, r: 0.52 },
            { id: 'rooster_6', type: 'rooster', level: 5, x: 42.0, z: 53.0, r: 2.22 },
            { id: 'rooster_7', type: 'rooster', level: 5, x: 17.0, z: 60.0, r: 3.92 },
            { id: 'rooster_8', type: 'rooster', level: 5, x: 26.0, z: 58.0, r: 5.62 },
            { id: 'rooster_9', type: 'rooster', level: 5, x: 35.0, z: 59.0, r: 1.04 },
            { id: 'rooster_10', type: 'rooster', level: 5, x: 44.0, z: 41.0, r: 2.74 },
            // Серые крысы у скал к северу от водопада (2 уровень)
            { id: 'grey_rat_1',  type: 'grey_rat', level: 4, x: 131.0, z: -27.5, r: 1.2 },
            { id: 'grey_rat_2',  type: 'grey_rat', level: 4, x: 128.5, z: -32.5, r: 3.4 },
            { id: 'grey_rat_3',  type: 'grey_rat', level: 4, x: 131.5, z: -35.0, r: 0.8 },
            { id: 'grey_rat_4',  type: 'grey_rat', level: 4, x: 122.0, z: -23.0, r: 2.1 },
            { id: 'grey_rat_5',  type: 'grey_rat', level: 4, x: 129.0, z: -23.5, r: 4.5 },
            { id: 'grey_rat_6',  type: 'grey_rat', level: 4, x: 123.5, z: -35.5, r: 5.2 },
            { id: 'grey_rat_7',  type: 'grey_rat', level: 4, x: 125.5, z: -39.0, r: 1.7 },
            { id: 'grey_rat_8',  type: 'grey_rat', level: 4, x: 120.5, z: -39.5, r: 3.9 },
            { id: 'grey_rat_9',  type: 'grey_rat', level: 4, x: 118.5, z: -41.5, r: 0.3 },
            { id: 'grey_rat_10', type: 'grey_rat', level: 4, x: 117.0, z: -43.0, r: 2.8 }
        ],

        pickups: [
            // Стартовые брёвна, камни и кинжал у пня убраны по запросу игрока
        ],

        props: [
            { id: 'start_stump', prop: 'stump', x: 107.0, z: 68.0, r: 0.4, s: 1.0 },
            // Домик (фасад с дверью смотрит на запад) и наковальня рядом
            { id: 'forestEdge.cottage', prop: 'cottage', x: 70.0, z: -15.0, r: 0.0 },
            { id: 'forestEdge.anvil', prop: 'anvil', x: 65.9, z: -12.0, r: 0.5 },
            { id: 'forestEdge.gazebo', prop: 'gazebo', x: 25.5, z: -20.1, r: 0.0 },
            // фиалки и пучки травы на пчелиной поляне
            { id: 'forestEdge.violets_1', prop: 'violet_flowerbed', x: 79, z: 19, r: 0.4, s: 0.5 },
            { id: 'forestEdge.violets_2', prop: 'violet_flowerbed', x: 84, z: 20.5, r: 1.9, s: 0.6 },
            { id: 'forestEdge.violets_3', prop: 'violet_flowerbed', x: 90, z: 18, r: 3.1, s: 0.45 },
            { id: 'forestEdge.violets_4', prop: 'violet_flowerbed', x: 95, z: 27, r: 5.0, s: 0.55 },
            { id: 'forestEdge.violets_5', prop: 'violet_flowerbed', x: 88, z: 29, r: 2.4, s: 0.5 },
            { id: 'forestEdge.violets_6', prop: 'violet_flowerbed', x: 100, z: 16.5, r: 0.9, s: 0.575 },
            { id: 'forestEdge.tuft_1', prop: 'grass_tuft', x: 81.5, z: 24, r: 0.2, s: 1.0 },
            { id: 'forestEdge.tuft_2', prop: 'grass_tuft', x: 87, z: 22.5, r: 1.5, s: 1.2 },
            { id: 'forestEdge.tuft_3', prop: 'grass_tuft', x: 92.5, z: 20.5, r: 2.9, s: 0.9 },
            { id: 'forestEdge.tuft_4', prop: 'grass_tuft', x: 97, z: 22, r: 4.1, s: 1.1 },
            { id: 'forestEdge.tuft_5', prop: 'grass_tuft', x: 78.5, z: 30, r: 5.5, s: 1.0 },
            { id: 'forestEdge.tuft_6', prop: 'grass_tuft', x: 94, z: 29.5, r: 0.8, s: 1.15 },
            { id: 'forestEdge.tuft_7', prop: 'grass_tuft', x: 101.5, z: 24, r: 3.6, s: 0.95 },
            { id: 'forestEdge.tuft_8', prop: 'grass_tuft', x: 85, z: 13.5, r: 2.2, s: 1.05 },
            // Лираэль, Хранительница Каменного Дозора (NPC у водопада)
            { id: 'forestEdge.lirael', prop: 'npc_lirael', x: 129.0, z: 19.5, r: 0.0 },
            // Олениха-друид (NPC): в тени одинокого большого дерева (14, 8.5), берёт отчёты по заданиям от Лираэль
            { id: 'forestEdge.doe_druid', prop: 'npc_doe_druid', x: 10.0, z: 5.0, r: 1.57 },

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

                // === ВЫСТАВКА ДЕРЕВЬЕВ У ОЗЕРА (~ -65, 20) ===
                // Центральное эталонное дерево с пышными листьями
                { id: 'tree_showcase_leaves', x: -65.0, z: 20.0, s: 1.0, r: 0.0, treeType: 'tree' },
                // Безлистное дерево (Withered Sentinel, пересобрано из оригинала 14.10)
                { id: 'tree_showcase_sentinel', x: -72.0, z: 30.0, s: 2.0, r: 2.1, treeType: 'sentinel' },

                // === НОВЫЕ ДЕРЕВЬЯ С ПЫШНЫМИ РОДНЫМИ ЛИСТЬЯМИ (Poly Haven) ===
                { id: 'tree_showcase_oak_wide', x: -65.0, z: 4.0, s: 1.5, r: 0.5, treeType: 'oak_wide' },
                { id: 'tree_showcase_oak_tall', x: -58.0, z: 4.0, s: 1.5, r: 1.2, treeType: 'oak_tall' },
                { id: 'tree_showcase_elm', x: -72.0, z: 4.0, s: 1.0, r: 2.3, treeType: 'elm' },
                { id: 'tree_showcase_sakura',   x: -75.0, z: -10.0, s: 1.0, r: 0.0, treeType: 'sakura' },
                { id: 'tree_showcase_poplar',   x: -56.0, z: -10.0, s: 1.5, r: 0.0, treeType: 'poplar' },
                // Яблоня возле озера (вечнозелёное дерево перенесено в северо-западный ельник)
                { id: 'tree_showcase_apple',     x: -48.0, z: -6.0, s: 1.0, r: 0.7, treeType: 'apple' }
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
            flowers: [
                // Пышный клевер на полянке у пчёл (flower_clover.glb)
                { x: 89.5, z: 18.0, s: 0.97, r: 1.4, flowerType: 'clover' },
                { x: 90.0, z: 12.0, s: 1.25, r: 0.55, flowerType: 'clover' },
                { x: 88.7, z: 19.7, s: 0.95, r: 3.17, flowerType: 'clover' },
                { x: 97.6, z: 19.6, s: 1.14, r: 3.42, flowerType: 'clover' },
                { x: 93.1, z: 25.4, s: 1.21, r: 0.04, flowerType: 'clover' },
                { x: 95.3, z: 12.3, s: 1.0, r: 0.98, flowerType: 'clover' },
                { x: 99.4, z: 17.7, s: 0.89, r: 0.61, flowerType: 'clover' },
                { x: 97.7, z: 13.6, s: 1.21, r: 4.58, flowerType: 'clover' },
                { x: 76.6, z: 17.1, s: 1.02, r: 3.47, flowerType: 'clover' },
                { x: 96.6, z: 13.1, s: 1.24, r: 3.63, flowerType: 'clover' },
                { x: 90.1, z: 17.3, s: 0.95, r: 1.82, flowerType: 'clover' },
                { x: 97.3, z: 21.0, s: 0.9, r: 1.75, flowerType: 'clover' },
                { x: 85.0, z: 15.1, s: 1.02, r: 1.32, flowerType: 'clover' },
                { x: 89.5, z: 27.2, s: 1.14, r: 3.83, flowerType: 'clover' },
                { x: 97.1, z: 25.4, s: 0.92, r: 2.38, flowerType: 'clover' },
                { x: 103.0, z: 18.6, s: 1.1, r: 4.3, flowerType: 'clover' },
                { x: 98.3, z: 12.8, s: 0.95, r: 0.2, flowerType: 'clover' },
                { x: 87.9, z: 23.0, s: 0.94, r: 5.92, flowerType: 'clover' },
                { x: 97.0, z: 15.7, s: 1.14, r: 2.48, flowerType: 'clover' },
                { x: 99.7, z: 16.1, s: 0.97, r: 1.55, flowerType: 'clover' },
                { x: 83.9, z: 17.4, s: 1.11, r: 5.64, flowerType: 'clover' },
                { x: 85.3, z: 21.4, s: 1.3, r: 3.2, flowerType: 'clover' },
                { x: 93.7, z: 20.0, s: 0.9, r: 3.94, flowerType: 'clover' },
                { x: 93.5, z: 13.7, s: 0.88, r: 2.4, flowerType: 'clover' },
                { x: 101.9, z: 18.8, s: 1.29, r: 5.41, flowerType: 'clover' },
                { x: 103.7, z: 19.5, s: 1.16, r: 3.37, flowerType: 'clover' },
                { x: 89.7, z: 25.8, s: 0.9, r: 2.73, flowerType: 'clover' },
                { x: 77.0, z: 21.4, s: 1.24, r: 1.65, flowerType: 'clover' },
                { x: 84.7, z: 19.0, s: 1.26, r: 5.47, flowerType: 'clover' },
                { x: 87.4, z: 25.5, s: 1.12, r: 0.96, flowerType: 'clover' },
                { x: 91.9, z: 12.8, s: 1.2, r: 3.33, flowerType: 'clover' },
                { x: 99.5, z: 19.0, s: 0.86, r: 5.83, flowerType: 'clover' },
                { x: 100.9, z: 13.6, s: 0.99, r: 0.36, flowerType: 'clover' },
                { x: 101.5, z: 13.3, s: 0.89, r: 3.05, flowerType: 'clover' },
                { x: 102.9, z: 22.1, s: 1.19, r: 0.81, flowerType: 'clover' },
                { x: 80.0, z: 20.0, s: 0.97, r: 5.48, flowerType: 'clover' },
                { x: 84.9, z: 20.8, s: 1.09, r: 4.58, flowerType: 'clover' },
                { x: 93.5, z: 23.5, s: 1.3, r: 4.08, flowerType: 'clover' },
                { x: 81.0, z: 21.3, s: 0.9, r: 1.41, flowerType: 'clover' },
                { x: 85.0, z: 24.5, s: 0.95, r: 1.38, flowerType: 'clover' },
                { x: 101.8, z: 21.9, s: 0.95, r: 5.69, flowerType: 'clover' },
                { x: 93.5, z: 17.3, s: 0.96, r: 4.2, flowerType: 'clover' },
                { x: 92.2, z: 22.0, s: 1.27, r: 3.59, flowerType: 'clover' },
                { x: 99.1, z: 22.2, s: 1.04, r: 2.93, flowerType: 'clover' },
                // Расширение поляны клевера в сторону 78 30
                { x: 75.5, z: 25.7, s: 1.03, r: 0.68, flowerType: 'clover' },
                { x: 83.1, z: 25.3, s: 1.09, r: 2.09, flowerType: 'clover' },
                { x: 82.7, z: 26.4, s: 1.0,  r: 2.1,  flowerType: 'clover' },
                { x: 77.2, z: 25.0, s: 1.05, r: 0.55, flowerType: 'clover' },
                { x: 80.4, z: 25.6, s: 0.99, r: 2.82, flowerType: 'clover' },
                { x: 83.1, z: 25.8, s: 0.91, r: 4.96, flowerType: 'clover' },
                { x: 75.2, z: 32.7, s: 1.11, r: 1.67, flowerType: 'clover' },
                { x: 82.5, z: 31.5, s: 1.0,  r: 5.03, flowerType: 'clover' },
                { x: 76.9, z: 30.2, s: 1.09, r: 5.08, flowerType: 'clover' },
                { x: 77.8, z: 28.4, s: 1.2,  r: 3.22, flowerType: 'clover' },
                { x: 81.2, z: 30.4, s: 1.15, r: 5.59, flowerType: 'clover' },
                { x: 79.4, z: 30.7, s: 1.02, r: 0.2,  flowerType: 'clover' },
                { x: 81.8, z: 26.5, s: 1.22, r: 5.74, flowerType: 'clover' },
                { x: 80.9, z: 26.4, s: 1.0,  r: 2.46, flowerType: 'clover' },
                { x: 75.7, z: 28.9, s: 1.11, r: 2.11, flowerType: 'clover' },
                { x: 76.7, z: 25.7, s: 1.13, r: 0.08, flowerType: 'clover' },
                { x: 78.2, z: 26.9, s: 1.09, r: 4.54, flowerType: 'clover' },
                { x: 83.2, z: 30.4, s: 1.3,  r: 6.05, flowerType: 'clover' },
                { x: 80.7, z: 27.0, s: 1.07, r: 1.12, flowerType: 'clover' },
                { x: 83.9, z: 28.8, s: 1.19, r: 0.28, flowerType: 'clover' }
            ],
            reeds: [],
            grass: [
                // Густая растительность на полянке у пчёл (grass_set.glb)
                { x: 89.2, z: 11.3, s: 1.39, r: 0.62, grassType: 'd' },
                { x: 89.0, z: 10.6, s: 0.95, r: 1.2, grassType: 'd' },
                { x: 95.5, z: 22.1, s: 1.13, r: 5.49, grassType: 'a' },
                { x: 76.7, z: 22.1, s: 1.18, r: 0.32, grassType: 'a' },
                { x: 106.6, z: 17.2, s: 1.32, r: 1.04, grassType: 'd' },
                { x: 75.8, z: 20.0, s: 1.35, r: 1.03, grassType: 'a' },
                { x: 99.5, z: 18.5, s: 1.29, r: 2.86, grassType: 'd' },
                { x: 86.4, z: 11.3, s: 1.29, r: 4.16, grassType: 'd' },
                { x: 96.1, z: 23.3, s: 1.38, r: 3.64, grassType: 'a' },
                { x: 90.9, z: 16.7, s: 1.19, r: 3.16, grassType: 'b' },
                { x: 102.0, z: 21.4, s: 1.33, r: 0.43, grassType: 'a' },
                { x: 87.4, z: 14.9, s: 0.96, r: 5.59, grassType: 'b' },
                { x: 88.1, z: 18.1, s: 0.94, r: 4.13, grassType: 'c' },
                { x: 97.8, z: 17.3, s: 1.26, r: 1.5, grassType: 'd' },
                { x: 100.0, z: 24.6, s: 1.13, r: 5.83, grassType: 'a' },
                { x: 104.0, z: 19.4, s: 1.18, r: 0.63, grassType: 'b' },
                { x: 85.0, z: 18.9, s: 1.07, r: 0.43, grassType: 'b' },
                { x: 86.5, z: 21.8, s: 1.32, r: 4.42, grassType: 'a' },
                { x: 84.9, z: 12.8, s: 1.37, r: 0.65, grassType: 'b' },
                { x: 89.6, z: 27.9, s: 1.27, r: 0.98, grassType: 'c' },
                { x: 79.9, z: 14.1, s: 1.0, r: 3.98, grassType: 'c' },
                { x: 82.7, z: 18.8, s: 1.35, r: 0.32, grassType: 'd' },
                { x: 92.7, z: 17.2, s: 1.07, r: 0.82, grassType: 'c' },
                { x: 96.8, z: 24.4, s: 1.25, r: 3.52, grassType: 'a' },
                { x: 104.8, z: 23.1, s: 1.35, r: 3.43, grassType: 'c' },
                { x: 85.5, z: 17.2, s: 0.96, r: 1.94, grassType: 'a' },
                { x: 97.1, z: 16.4, s: 1.02, r: 0.65, grassType: 'd' },
                { x: 105.1, z: 17.7, s: 1.36, r: 1.49, grassType: 'b' },
                { x: 105.7, z: 17.7, s: 1.34, r: 0.16, grassType: 'c' },
                { x: 93.1, z: 13.0, s: 1.23, r: 4.62, grassType: 'b' },
                { x: 89.5, z: 27.4, s: 0.95, r: 5.48, grassType: 'd' },
                { x: 93.6, z: 27.5, s: 1.13, r: 1.92, grassType: 'b' },
                { x: 93.3, z: 26.6, s: 1.1, r: 1.75, grassType: 'a' },
                { x: 99.5, z: 18.0, s: 1.22, r: 2.51, grassType: 'c' },
                { x: 96.2, z: 17.8, s: 1.39, r: 1.12, grassType: 'c' },
                { x: 103.4, z: 20.7, s: 1.07, r: 4.94, grassType: 'd' },
                { x: 81.7, z: 14.8, s: 1.09, r: 3.62, grassType: 'c' },
                { x: 101.5, z: 20.7, s: 1.16, r: 5.06, grassType: 'b' },
                { x: 88.1, z: 20.9, s: 1.23, r: 2.07, grassType: 'c' },
                { x: 88.0, z: 16.1, s: 1.35, r: 3.18, grassType: 'd' },
                { x: 84.7, z: 26.0, s: 1.18, r: 1.2, grassType: 'd' },
                { x: 84.1, z: 10.9, s: 1.21, r: 1.89, grassType: 'a' },
                { x: 88.5, z: 23.1, s: 1.29, r: 3.81, grassType: 'c' },
                { x: 80.3, z: 20.4, s: 1.01, r: 2.97, grassType: 'b' },
                { x: 86.2, z: 14.7, s: 1.23, r: 3.89, grassType: 'a' },
                { x: 97.0, z: 11.5, s: 1.24, r: 1.41, grassType: 'b' },
                { x: 93.1, z: 20.6, s: 1.39, r: 3.84, grassType: 'a' },
                { x: 76.1, z: 21.5, s: 1.19, r: 4.51, grassType: 'd' },
                { x: 82.9, z: 19.2, s: 1.23, r: 0.03, grassType: 'a' },
                { x: 92.4, z: 14.6, s: 1.3, r: 4.37, grassType: 'd' },
                { x: 98.8, z: 20.5, s: 1.32, r: 2.87, grassType: 'd' },
                { x: 82.9, z: 10.8, s: 1.2, r: 5.97, grassType: 'd' },
                { x: 80.4, z: 13.8, s: 1.15, r: 5.22, grassType: 'd' },
                { x: 102.4, z: 14.1, s: 1.14, r: 1.63, grassType: 'b' },
                { x: 95.6, z: 14.8, s: 1.29, r: 3.04, grassType: 'b' },
                { x: 90.3, z: 21.6, s: 1.04, r: 1.71, grassType: 'c' },
                { x: 94.7, z: 17.3, s: 0.98, r: 2.41, grassType: 'b' },
                { x: 89.9, z: 16.7, s: 1.1, r: 3.41, grassType: 'd' },
                { x: 104.9, z: 22.3, s: 1.09, r: 4.83, grassType: 'a' },
                { x: 100.0, z: 12.5, s: 1.09, r: 0.04, grassType: 'c' },
                { x: 87.9, z: 24.7, s: 1.35, r: 5.25, grassType: 'b' },
                { x: 82.4, z: 19.4, s: 1.14, r: 2.44, grassType: 'd' },
                { x: 88.6, z: 10.4, s: 1.36, r: 6.16, grassType: 'a' },
                { x: 101.6, z: 15.0, s: 1.23, r: 0.53, grassType: 'd' },
                { x: 98.4, z: 23.9, s: 0.93, r: 2.38, grassType: 'b' },
                // Расширение травы поляны в сторону 78 30 (grass_set.glb)
                { x: 75.5, z: 26.0, s: 1.03, r: 2.21, grassType: 'c' },
                { x: 84.5, z: 30.7, s: 0.9,  r: 3.88, grassType: 'c' },
                { x: 81.8, z: 24.9, s: 1.35, r: 5.0,  grassType: 'd' },
                { x: 74.8, z: 31.3, s: 1.1,  r: 6.19, grassType: 'c' },
                { x: 84.5, z: 24.3, s: 1.18, r: 2.6,  grassType: 'a' },
                { x: 81.0, z: 34.2, s: 1.34, r: 2.63, grassType: 'b' },
                { x: 78.1, z: 26.5, s: 0.94, r: 5.52, grassType: 'a' },
                { x: 82.3, z: 28.1, s: 1.05, r: 5.74, grassType: 'c' },
                { x: 82.5, z: 28.1, s: 0.96, r: 6.12, grassType: 'a' },
                { x: 80.9, z: 32.4, s: 1.09, r: 0.39, grassType: 'b' },
                { x: 79.0, z: 24.2, s: 1.12, r: 4.64, grassType: 'd' },
                { x: 77.3, z: 32.3, s: 0.91, r: 3.28, grassType: 'b' },
                { x: 77.8, z: 25.1, s: 1.26, r: 1.41, grassType: 'c' },
                { x: 75.0, z: 33.8, s: 1.02, r: 5.57, grassType: 'c' },
                { x: 78.4, z: 33.9, s: 0.94, r: 1.24, grassType: 'b' },
                { x: 82.3, z: 33.4, s: 0.91, r: 1.68, grassType: 'b' },
                { x: 74.9, z: 27.3, s: 1.07, r: 3.38, grassType: 'b' },
                { x: 82.6, z: 29.1, s: 1.27, r: 4.88, grassType: 'c' },
                { x: 81.9, z: 32.7, s: 1.33, r: 2.14, grassType: 'b' },
                { x: 83.2, z: 33.7, s: 1.2,  r: 0.04, grassType: 'd' },
                { x: 77.8, z: 30.1, s: 1.25, r: 2.26, grassType: 'd' },
                { x: 78.0, z: 31.0, s: 1.11, r: 2.25, grassType: 'd' },
                { x: 77.8, z: 31.9, s: 1.31, r: 1.13, grassType: 'a' },
                { x: 83.3, z: 27.9, s: 1.03, r: 5.81, grassType: 'd' },
                { x: 78.1, z: 33.7, s: 0.96, r: 1.67, grassType: 'c' }
            ]
        }
    },

    // -------------------------------------------------------------
    // ЛОКАЦИЯ: Золотая саванна (прежде тестовая локация Озёрный край)
    // -------------------------------------------------------------
    savanna: {
        id: 'savanna',
        name: 'Золотая саванна',

        // -------------------------------------------------------------
        // ЛОКАЦИЯ: Золотая саванна (бывший Озёрный край, id `savanna`)
        // 300×200 м, как стартовая. Портал на западе, дорога на восток:
        //   лужайка гиен у портала -> озеро и стоянка Ящера-отшельника -> вараны на берегах ->
        //   скалы пещерных львов на севере -> Круг стихий (4 элементаля) на северо-востоке ->
        //   лагерь ящеров (солдаты и командиры) на юго-востоке.
        // -------------------------------------------------------------
        terrain: {
            sizeX: 300,
            sizeZ: 200,
            seed: 6061,
            biome: 'forest',
            groundSet: 'savanna',          // золотая сухая трава, красная земля, зелень у воды
            segmentsX: 300,
            segmentsZ: 200,
            border: 0,
            baseHeight: 1.6,
            landFloor: 0.9,
            mountainRim: { width: 16.0, height: 6.0 },   // по периметру: рыжие скальные уступы
            mountainPasses: [],

            // Озеро — те же параметры, что у озера стартовой локации (пологий плавный берег)
            waterBody: {
                type: 'lake',
                x: -36.0,
                z: -12.0,
                radius: 20.0,
                depth: -1.2,
                beachWidth: 18.0,
                shoreSmooth: true
            },

            // Ровные площадки: портал, стоянка отшельника, Круг стихий, лагерь ящеров
            flatSpots: [
                { x: -131.0, z: 10.0, radius: 4.5, blend: 5.0 },
                { x: -115.0, z: 20.0, radius: 7.0, blend: 7.0 },
                { x: 74.0,   z: -42.0, radius: 15.0, blend: 9.0 },
                { x: 106.0,  z: 46.0, radius: 25.0, blend: 9.0 }
            ],
            hills: { amplitude: 2.6, inclineX: 0.25, inclineZ: -0.10 },

            paths: [
                // Главная тропа: портал -> стоянка отшельника -> южный берег озера -> центр -> Круг стихий
                {
                    type: 'dirt', width: 2.6,
                    points: [
                        [-131.0, 10.0], [-118.0, 8.0], [-102.0, 9.0], [-86.0, 15.0], [-68.0, 18.0], [-56.0, 30.0], [-32.0, 38.0],
                        [-6.0, 34.0], [22.0, 22.0], [44.0, 8.0], [58.0, -14.0], [66.0, -30.0], [72.0, -40.0]
                    ]
                },
                // Ответвление к лагерю ящеров
                {
                    type: 'dirt', width: 2.6,
                    points: [[22.0, 22.0], [50.0, 36.0], [76.0, 44.0], [96.0, 46.0], [116.0, 48.0]]
                },
                // Аллея стихий: камень на подходе к алтарям
                {
                    type: 'stone', width: 2.8,
                    points: [[58.0, -14.0], [66.0, -30.0], [74.0, -42.0]]
                }
            ]
        },

        atmosphere: { sky: 0xe9d9b6, skyTop: 0x5a96cc, fogColor: 0xe6d3a8, fogDensity: 0.0048 },
        lighting: { hemiSky: 0xffe6bd, hemiGround: 0x9c7c48, hemiIntensity: 1.75, sunColor: 0xffe2b4, sunIntensity: 0.95 },
        cameraAngle: 0.0,
        // Трава: почти вся сухая (солома), в открытых местах почти без проплешин
        foliage: { dryGrass: 0.85, openGap: 0.05 },

        spawns: {
            default:    { x: -120.0, z: 10.0, r: 4.71 },
            fromForest: { x: -124.0, z: 10.0, r: 4.71 }     // выход из портала, лицом на восток
        },

        exits: [
            { id: 'toForest', x: -131.0, z: 10.0, radius: 3.5, to: 'forestEdge', spawn: 'fromSavanna', label: 'Лесная опушка' }
        ],

        clearings: [
            { x: -131.0, z: 10.0, radius: 8.0 }, { x: -120.0, z: 10.0, radius: 7.0 },
            { x: -115.0, z: 20.0, radius: 11.0 },                 // стоянка отшельника
            { x: 74.0, z: -42.0, radius: 19.0 },                 // Круг стихий
            { x: 106.0, z: 46.0, radius: 26.0 },                 // расширенный лагерь ящеров
            { x: 4.0, z: -68.0, radius: 6.0 }, { x: 22.0, z: -64.0, radius: 6.0 }   // логово львов (кости)
        ],

        groups: [
            // Редкие акации и колчанные деревья: острова тени посреди золотой травы
            { id: 'acacia_w_north', type: 'forest', grass: false, x: -96.0, z: -40.0, rx: 26.0, rz: 24.0, count: 9, spacing: 15.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','twisted','quiver','sentinel'], undergrowth: true, ferns: 0, shrubs: 3, seed: 700 },
            { id: 'acacia_w_south', type: 'forest', grass: false, x: -98.0, z: 50.0, rx: 26.0, rz: 22.0, count: 8, spacing: 15.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','twisted','quiver'], undergrowth: true, ferns: 0, shrubs: 3, seed: 713 },
            { id: 'acacia_lake_s', type: 'forest', grass: false, x: -22.0, z: 56.0, rx: 34.0, rz: 14.0, count: 8, spacing: 16.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','twisted','quiver','oak_wide'], undergrowth: true, ferns: 0, shrubs: 3, seed: 726 },
            { id: 'acacia_lake_n', type: 'forest', grass: false, x: -34.0, z: -60.0, rx: 34.0, rz: 14.0, count: 8, spacing: 16.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','sentinel','quiver'], undergrowth: true, ferns: 0, shrubs: 3, seed: 739 },
            { id: 'acacia_mid_n', type: 'forest', grass: false, x: 14.0, z: -38.0, rx: 24.0, rz: 18.0, count: 6, spacing: 16.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','oak_wide','quiver'], undergrowth: true, ferns: 0, shrubs: 3, seed: 752 },
            { id: 'acacia_mid_s', type: 'forest', grass: false, x: 16.0, z: 50.0, rx: 26.0, rz: 14.0, count: 6, spacing: 16.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','oak_wide','quiver'], undergrowth: true, ferns: 0, shrubs: 3, seed: 765 },
            { id: 'acacia_centre', type: 'forest', grass: false, x: 42.0, z: 6.0, rx: 22.0, rz: 18.0, count: 6, spacing: 16.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','oak_wide','sentinel'], undergrowth: true, ferns: 0, shrubs: 3, seed: 778 },
            { id: 'lion_cliffs', type: 'forest', grass: false, x: 20.0, z: -68.0, rx: 32.0, rz: 10.0, count: 8, spacing: 14.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','sentinel','twisted'], undergrowth: true, ferns: 0, shrubs: 3, seed: 791 },
            { id: 'circle_grove', type: 'forest', grass: false, x: 74.0, z: -42.0, rx: 38.0, rz: 32.0, count: 9, spacing: 15.0, scaleMin: 0.85, scaleMax: 1.3, types: ['sentinel','twisted','oak_wide','quiver'], undergrowth: true, ferns: 0, shrubs: 3, seed: 804 },
            { id: 'lizard_grove', type: 'forest', grass: false, x: 98.0, z: 46.0, rx: 34.0, rz: 28.0, count: 9, spacing: 15.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','oak_wide','quiver','sentinel'], undergrowth: true, ferns: 0, shrubs: 3, seed: 817 },
            { id: 'east_quivers', type: 'forest', grass: false, x: 124.0, z: -6.0, rx: 12.0, rz: 44.0, count: 9, spacing: 14.0, scaleMin: 0.85, scaleMax: 1.3, types: ['quiver','quiver','twisted'], undergrowth: true, ferns: 0, shrubs: 3, seed: 830 },
            { id: 'west_rim_trees', type: 'forest', grass: false, x: -126.0, z: -50.0, rx: 10.0, rz: 24.0, count: 5, spacing: 15.0, scaleMin: 0.85, scaleMax: 1.3, types: ['twisted','quiver'], undergrowth: true, ferns: 0, shrubs: 3, seed: 843 },

            // Пальмы-оазис: колчанные деревья (пальмы) по берегам озера и тень над стоянкой отшельника
            { id: 'palms_lake_n', type: 'forest', grass: false, x: -36.0, z: -40.0, rx: 24.0, rz: 8.0, count: 6, spacing: 6.0, scaleMin: 0.85, scaleMax: 1.2, treeType: 'quiver', undergrowth: false, seed: 1101 },
            { id: 'palms_lake_s', type: 'forest', grass: false, x: -30.0, z: 20.0, rx: 22.0, rz: 6.0, count: 5, spacing: 6.0, scaleMin: 0.85, scaleMax: 1.2, treeType: 'quiver', undergrowth: false, seed: 1102 },
            { id: 'palms_lake_w', type: 'forest', grass: false, x: -66.0, z: -10.0, rx: 7.0, rz: 16.0, count: 5, spacing: 6.0, scaleMin: 0.85, scaleMax: 1.2, treeType: 'quiver', undergrowth: false, seed: 1103 },
            { id: 'palms_lake_e', type: 'forest', grass: false, x: -6.0, z: -10.0, rx: 7.0, rz: 16.0, count: 5, spacing: 6.0, scaleMin: 0.85, scaleMax: 1.2, treeType: 'quiver', undergrowth: false, seed: 1104 },
            { id: 'palms_camp', type: 'forest', grass: false, x: -112.0, z: 33.0, rx: 8.0, rz: 5.0, count: 3, spacing: 6.0, scaleMin: 0.9, scaleMax: 1.2, treeType: 'quiver', undergrowth: false, seed: 1105 },

            // Сухая трава (grass_set, солома): сплошной ковёр, разрежённый подлеском у деревьев
            { id: 'grass_w', type: 'grassland', x: -96.0, z: 0.0, rx: 40.0, rz: 80.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 800 },
            { id: 'grass_nw', type: 'grassland', x: -50.0, z: -62.0, rx: 50.0, rz: 24.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 811 },
            { id: 'grass_sw', type: 'grassland', x: -52.0, z: 58.0, rx: 50.0, rz: 22.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 822 },
            { id: 'grass_c', type: 'grassland', x: 10.0, z: 4.0, rx: 46.0, rz: 60.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 833 },
            { id: 'grass_n', type: 'grassland', x: 40.0, z: -62.0, rx: 50.0, rz: 22.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 844 },
            { id: 'grass_s', type: 'grassland', x: 50.0, z: 62.0, rx: 50.0, rz: 22.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 855 },
            { id: 'grass_e', type: 'grassland', x: 100.0, z: -8.0, rx: 36.0, rz: 60.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 866 },
            { id: 'grass_circle', type: 'grassland', x: 74.0, z: -42.0, rx: 22.0, rz: 20.0, density: 6.0, spacing: 2.1, scaleMin: 1.0, scaleMax: 1.5, weights: { a: 0.55, b: 0.06, c: 0.33, d: 0.06 }, maxSlope: 0.38, seed: 877 },

            // Камни и скальные выходы (кладки у озера, холмы-копье)
            { id: 'rocks_lake_e', type: 'rocks', x: -6.0, z: -30.0, radius: 6.0, count: 4, scaleMin: 0.9, scaleMax: 2.2, seed: 900 },
            { id: 'rocks_lake_s', type: 'rocks', x: -30.0, z: 34.0, radius: 5.0, count: 3, scaleMin: 0.9, scaleMax: 2.2, seed: 907 },
            { id: 'rocks_lake_w', type: 'rocks', x: -74.0, z: -20.0, radius: 6.0, count: 3, scaleMin: 0.9, scaleMax: 2.2, seed: 914 },
            { id: 'kopje_north', type: 'rocks', x: 8.0, z: -70.0, radius: 9.0, count: 6, scaleMin: 0.9, scaleMax: 2.2, seed: 921 },
            { id: 'kopje_north2', type: 'rocks', x: 40.0, z: -74.0, radius: 8.0, count: 5, scaleMin: 0.9, scaleMax: 2.2, seed: 928 },
            { id: 'kopje_centre', type: 'rocks', x: 40.0, z: 22.0, radius: 7.0, count: 4, scaleMin: 0.9, scaleMax: 2.2, seed: 935 },
            { id: 'kopje_west', type: 'rocks', x: -100.0, z: 20.0, radius: 8.0, count: 4, scaleMin: 0.9, scaleMax: 2.2, seed: 942 },
            { id: 'kopje_se', type: 'rocks', x: 60.0, z: 66.0, radius: 8.0, count: 4, scaleMin: 0.9, scaleMax: 2.2, seed: 949 },
            { id: 'kopje_east', type: 'rocks', x: 118.0, z: -48.0, radius: 9.0, count: 5, scaleMin: 0.9, scaleMax: 2.2, seed: 956 },
            { id: 'circle_rocks', type: 'rocks', x: 74.0, z: -70.0, radius: 10.0, count: 4, scaleMin: 0.9, scaleMax: 2.2, seed: 963 },

            // Кусты и травянистые заросли
            { id: 'shrubs_w', type: 'shrubCluster', x: -80.0, z: -4.0, radius: 22.0, count: 9, spacing: 5.0, seed: 1000 },
            { id: 'shrubs_c', type: 'shrubCluster', x: 0.0, z: 20.0, radius: 24.0, count: 9, spacing: 5.0, seed: 1005 },
            { id: 'shrubs_e', type: 'shrubCluster', x: 60.0, z: 24.0, radius: 22.0, count: 9, spacing: 5.0, seed: 1010 },
            { id: 'shrubs_n', type: 'shrubCluster', x: -10.0, z: -48.0, radius: 20.0, count: 9, spacing: 5.0, seed: 1015 },
            { id: 'shrubs_se', type: 'shrubCluster', x: 110.0, z: 70.0, radius: 16.0, count: 9, spacing: 5.0, seed: 1020 },

            // Камыш у озера: куртины по периметру воды (только на мелководье и мокром берегу)
            { id: 'lake_reeds_1', type: 'reeds', x: -15.3, z: -8.4, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 600 },
            { id: 'lake_reeds_2', type: 'reeds', x: -21.4, z: 3.1, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 617 },
            { id: 'lake_reeds_3', type: 'reeds', x: -33.1, z: 8.8, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 634 },
            { id: 'lake_reeds_4', type: 'reeds', x: -45.9, z: 6.5, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 651 },
            { id: 'lake_reeds_5', type: 'reeds', x: -54.9, z: -2.8, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 668 },
            { id: 'lake_reeds_6', type: 'reeds', x: -56.7, z: -15.6, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 685 },
            { id: 'lake_reeds_7', type: 'reeds', x: -50.6, z: -27.1, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 702 },
            { id: 'lake_reeds_8', type: 'reeds', x: -38.9, z: -32.8, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 719 },
            { id: 'lake_reeds_9', type: 'reeds', x: -26.1, z: -30.5, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 736 },
            { id: 'lake_reeds_10', type: 'reeds', x: -17.1, z: -21.2, radius: 5.5, count: 26, spacing: 0.5, clumps: 3, clumpRadius: 1.6, seed: 753 }
        ],

        // Звери саванны: мирные пока не ударишь (behavior retaliate в content/creatures)
        creatures: [
            { id: 'sv_hyena_1', type: 'hyena', x: -98.0, z: -12.0, r: 0.40 },
            { id: 'sv_hyena_2', type: 'hyena', x: -90.0, z: -22.0, r: 2.10 },
            { id: 'sv_hyena_3', type: 'hyena', x: -104.0, z: -28.0, r: 3.80 },
            { id: 'sv_hyena_4', type: 'hyena', x: -96.0, z: 40.0, r: 5.50 },
            { id: 'sv_hyena_5', type: 'hyena', x: -88.0, z: 50.0, r: 0.92 },
            { id: 'sv_hyena_6', type: 'hyena', x: -106.0, z: 52.0, r: 2.62 },
            { id: 'sv_komodo_1', type: 'komodo', x: 4.0, z: -14.0, r: 1.00 },
            { id: 'sv_komodo_2', type: 'komodo', x: -10.0, z: 20.0, r: 2.70 },
            { id: 'sv_komodo_3', type: 'komodo', x: -78.0, z: -22.0, r: 4.40 },
            { id: 'sv_komodo_4', type: 'komodo', x: -60.0, z: 38.0, r: 6.10 },
            // Саркозухи: на мелководье озера (наполовину в воде), могут выползать на берег; не агрессивные (retaliate)
            { id: 'sv_sarco_1', type: 'sarcosuchus', x: -25.8, z: -9.3, r: 1.31 },
            { id: 'sv_sarco_2', type: 'sarcosuchus', x: -40.4, z: 4.5, r: -0.26 },
            { id: 'sv_sarco_3', type: 'sarcosuchus', x: -47.7, z: -15.1, r: -1.83 },
            { id: 'sv_sarco_4', type: 'sarcosuchus', x: -36.0, z: -26.6, r: 3.14 },
            { id: 'sv_lion_1', type: 'cave_lion', x: 18.0, z: -66.0, r: 2.00 },
            { id: 'sv_lion_2', type: 'cave_lion', x: 34.0, z: -72.0, r: 3.70 },
            { id: 'sv_lion_3', type: 'cave_lion', x: 4.0, z: -74.0, r: 5.40 },
            // Серый носорог: элита, северо-запад у края карты, за гиеньими лугами (агрессивный, радиус 10 м)
            { id: 'sv_rhino_1', type: 'rhino', x: -112.0, z: -76.0, r: 1.57 },
            // Ящеры-солдаты в лагере (расширены по всей восточной и юго-восточной части)
            { id: 'sv_soldier_1', type: 'lizard_soldier', x: 105.6, z: 49.0, r: 0.50 },
            { id: 'sv_soldier_2', type: 'lizard_soldier', x: 98.2, z: 55.8, r: 2.20 },
            { id: 'sv_soldier_3', type: 'lizard_soldier', x: 88.7, z: 52.8, r: 3.90 },
            { id: 'sv_soldier_4', type: 'lizard_soldier', x: 86.4, z: 43.0, r: 5.60 },
            { id: 'sv_soldier_5', type: 'lizard_soldier', x: 93.8, z: 36.2, r: 1.02 },
            { id: 'sv_soldier_6', type: 'lizard_soldier', x: 103.3, z: 39.2, r: 2.72 },
            { id: 'sv_soldier_7', type: 'lizard_soldier', x: 74.0, z: 54.0, r: 4.42 },
            { id: 'sv_soldier_8', type: 'lizard_soldier', x: 122.0, z: 62.0, r: 6.12 },
            { id: 'sv_soldier_9', type: 'lizard_soldier', x: 114.0, z: 38.0, r: 1.80 },
            { id: 'sv_soldier_10', type: 'lizard_soldier', x: 118.0, z: 50.0, r: 3.50 },
            { id: 'sv_soldier_11', type: 'lizard_soldier', x: 128.0, z: 44.0, r: 4.90 },
            { id: 'sv_soldier_12', type: 'lizard_soldier', x: 132.0, z: 56.0, r: 0.80 },
            { id: 'sv_soldier_13', type: 'lizard_soldier', x: 108.0, z: 66.0, r: 2.40 },
            { id: 'sv_soldier_14', type: 'lizard_soldier', x: 92.0, z: 62.0, r: 4.10 },
            { id: 'sv_soldier_15', type: 'lizard_soldier', x: 135.0, z: 32.0, r: 5.70 },
            // Командиры ящеров
            { id: 'sv_commander_1', type: 'lizard', x: 104.0, z: 44.0, r: 3.00 },
            { id: 'sv_commander_2', type: 'lizard', x: 124.0, z: 32.0, r: 4.70 },
            { id: 'sv_commander_3', type: 'lizard', x: 126.0, z: 52.0, r: 1.20 },
            { id: 'sv_fire_elemental', type: 'fire_elemental', x: 74.0, z: -52.0, r: 0.00 },
            { id: 'sv_stone_elemental', type: 'stone_elemental', x: 84.0, z: -42.0, r: 1.57 },
            { id: 'sv_water_elemental', type: 'water_elemental', x: 74.0, z: -32.0, r: 3.14 },
            { id: 'sv_air_elemental', type: 'air_elemental', x: 64.0, z: -42.0, r: 4.71 }
        ],

        pickups: [],

        // Стоянка отшельника, Круг стихий, лагерь ящеров, путевые камни
        props: [
            { id: 'savanna.hermit', prop: 'npc_lizard_hermit', x: -112.0, z: 22.5, r: 0.0 },
            { id: 'savanna.hermit_fire', prop: 'campfire', x: -115.0, z: 20.0, r: 0.0 },
            { id: 'savanna.hermit_hut', prop: 'hermit_hut', x: -122.0, z: 25.0, r: 0.9 },
            { id: 'savanna.hermit_rack', prop: 'drying_rack', x: -109.0, z: 15.0, r: 0.3 },
            { id: 'savanna.hermit_stump_1', prop: 'stump', x: -118.5, z: 18.0, r: 0.4 },
            { id: 'savanna.hermit_stump_2', prop: 'stump', x: -111.0, z: 18.0, r: 1.2 },
            { id: 'savanna.hermit_log', prop: 'fallen_log', x: -117.0, z: 15.0, r: 0.6, noObstacle: true, s: 2.4 },
            { id: 'savanna.waystone', prop: 'waystone', x: -126.0, z: 5.5, r: 0.3 },
            { id: 'savanna.waystone_2', prop: 'waystone', x: -126.0, z: 14.5, r: -0.3 },
            { id: 'savanna.altar_fire', prop: 'elemental_altar_fire', x: 74.0, z: -48.0, r: 0.0 },
            { id: 'savanna.altar_stone', prop: 'elemental_altar_stone', x: 80.0, z: -42.0, r: 1.57 },
            { id: 'savanna.altar_water', prop: 'elemental_altar_water', x: 74.0, z: -36.0, r: 3.14 },
            { id: 'savanna.altar_air', prop: 'elemental_altar_air', x: 68.0, z: -42.0, r: 4.71 },
            { id: 'savanna.obelisk', prop: 'elemental_obelisk', x: 74.0, z: -42.0, r: 0.0 },

            // Центральный узел лагеря ящеров
            { id: 'savanna.lizard_totem', prop: 'lizard_totem', x: 92.0, z: 40.0, r: 0.5 },
            { id: 'savanna.lizard_fire', prop: 'campfire', x: 96.0, z: 46.0, r: 0.0 },
            { id: 'savanna.lizard_drum_1', prop: 'lizard_drum', x: 94.0, z: 42.5, r: 0.8 },
            { id: 'savanna.lizard_drum_2', prop: 'lizard_drum', x: 99.0, z: 43.5, r: -0.6 },
            { id: 'savanna.bones_1', prop: 'bone_pile', x: 90.0, z: 46.0, r: 0.4 },

            // Шатры (рассредоточены от центра на восток к краю карты)
            { id: 'savanna.lizard_tent_1', prop: 'lizard_tent', x: 86.0, z: 50.0, r: 0.8 },
            { id: 'savanna.lizard_tent_2', prop: 'lizard_tent', x: 104.0, z: 52.0, r: -0.6 },
            { id: 'savanna.lizard_tent_3', prop: 'lizard_tent', x: 108.0, z: 38.0, r: 2.4 },
            { id: 'savanna.lizard_tent_4', prop: 'lizard_tent', x: 124.0, z: 42.0, r: 1.1 },
            { id: 'savanna.lizard_tent_5', prop: 'lizard_tent', x: 130.0, z: 54.0, r: -1.8 },

            // Боевые знамёна
            { id: 'savanna.lizard_banner_1', prop: 'lizard_banner', x: 88.0, z: 36.0, r: 0.0 },
            { id: 'savanna.lizard_banner_2', prop: 'lizard_banner', x: 100.0, z: 34.0, r: 0.0 },
            { id: 'savanna.lizard_banner_3', prop: 'lizard_banner', x: 114.0, z: 46.0, r: 1.2 },
            { id: 'savanna.lizard_banner_4', prop: 'lizard_banner', x: 120.0, z: 28.0, r: 0.4 },
            { id: 'savanna.lizard_banner_5', prop: 'lizard_banner', x: 134.0, z: 44.0, r: -0.8 },

            // Частокол из кольев с проходами (основной широкий вход с тропы на северо-западе + проход на юг)
            // Северное крыло частокола
            { id: 'savanna.lizard_barricade_n1', prop: 'lizard_barricade', x: 82.0, z: 32.0, r: 0.45 },
            { id: 'savanna.lizard_barricade_n2', prop: 'lizard_barricade', x: 87.5, z: 29.5, r: 0.35 },
            // ВХОД С ТРОПЫ: свободен между x: 88..97, z: 30..38 (проём шириной более 8 метров)
            { id: 'savanna.lizard_barricade_n3', prop: 'lizard_barricade', x: 105.0, z: 29.0, r: -0.15 },
            { id: 'savanna.lizard_barricade_n4', prop: 'lizard_barricade', x: 112.0, z: 28.0, r: -0.20 },
            { id: 'savanna.lizard_barricade_n5', prop: 'lizard_barricade', x: 127.0, z: 26.0, r: -0.30 },

            // Западное крыло частокола
            { id: 'savanna.lizard_barricade_w1', prop: 'lizard_barricade', x: 78.0, z: 37.0, r: 1.45 },
            { id: 'savanna.lizard_barricade_w2', prop: 'lizard_barricade', x: 77.0, z: 44.0, r: 1.55 },
            { id: 'savanna.lizard_barricade_w3', prop: 'lizard_barricade', x: 78.0, z: 52.0, r: 1.65 },

            // Южное крыло частокола
            { id: 'savanna.lizard_barricade_s1', prop: 'lizard_barricade', x: 84.0, z: 60.0, r: 2.85 },
            { id: 'savanna.lizard_barricade_s2', prop: 'lizard_barricade', x: 91.0, z: 62.0, r: 2.95 },
            // ЮЖНЫЙ ПРОХОД: свободен между x: 92..102 (проём шириной ~10 метров)
            { id: 'savanna.lizard_barricade_s3', prop: 'lizard_barricade', x: 104.0, z: 64.0, r: 3.10 },
            { id: 'savanna.lizard_barricade_s4', prop: 'lizard_barricade', x: 114.0, z: 63.0, r: -3.05 },
            { id: 'savanna.lizard_barricade_s5', prop: 'lizard_barricade', x: 126.0, z: 60.0, r: -2.85 },

            // Кости в других зонах
            { id: 'savanna.bones_2', prop: 'bone_pile', x: 20.0, z: -62.0, r: 1.9 },
            { id: 'savanna.bones_3', prop: 'bone_pile', x: -8.0, z: -70.0, r: 0.7 },
            { id: 'savanna.bones_4', prop: 'bone_pile', x: -100.0, z: -18.0, r: 2.5 }
        ],

        decorations: {
            trees: [],
            boulders: [],
            shrubs: [],
            ferns: [],
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
            groundSet: 'baseForest',    // moss2 как база + лес/трава по реальным деревьям (прежний вариант: 'camp' — по координатам карты)
            segments: 240,
            baseHeight: 0.85,       // комфортная высота суши над водой
            groundNoise: 0.15,      // ровная удобная плоскость для строительства с естественной фактурой
            // РЕЧКА: русло вдоль сглаженной линии points [x, z]; вода (Y = 0) закрывает карту целиком,
            // но видна только там, где рельеф ниже нуля. Перейти вброд нельзя (глубина): через речку — мост.
            waterBody: {
                type: 'river',
                width: 5.5,
                depth: -0.9,
                beachWidth: 5.0,   // плавный берег с гравием (как у озера), без выхода камыша на сушу
                points: [[-84, -18], [-56, -26], [-30, -21], [-8, -25], [0, -25], [8, -25], [32, -30], [58, -23], [84, -28]]
            },
            // deckY подобран под высоту суши у торцов моста в зоне береговой зоны (beachWidth 5.0, baseHeight 0.85)
            bridges: [{ x: 0.0, z: -25.0, length: 12.0, width: 3.0, deckY: 0.65 }],
            hills: { amplitude: 0.0, inclineX: 0.0, inclineZ: 0.0 }
        },

        cameraAngle: 0.0,           // на старте камера смотрит на север по компасу (север = −Z)

        // Строительство (building.js): меню «Строить» (B) есть только здесь; ставить можно внутри area (метры)
        building: { types: ['sawmill', 'storage'], area: { x: 0.0, z: 10.0, hx: 38.0, hz: 30.0 } },   // z от −20 до 40

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
            // Южный берег: лес вдоль горного хребта
            { id: 'forest_s_w',   type: 'forest', x: -45.0, z: 54.0, rx: 24.0, rz: 10.0, count: 14, spacing: 8.0, shrubs: 6, seed: 401, types: ['evergreen', 'evergreen', 'tree', 'tree_small'] },
            { id: 'forest_s_mid', type: 'forest', x: 0.0,   z: 56.0, rx: 26.0, rz: 10.0, count: 16, spacing: 8.0, shrubs: 6, seed: 402, types: ['tree', 'evergreen', 'evergreen', 'tree_small'] },
            { id: 'forest_s_e',   type: 'forest', x: 45.0,  z: 54.0, rx: 24.0, rz: 10.0, count: 14, spacing: 8.0, shrubs: 6, seed: 403, types: ['evergreen', 'tree', 'evergreen', 'tree_small'] },

            // Западный фланг: лес от южных гор ДО САМОЙ РЕКИ
            { id: 'forest_sw_mid',   type: 'forest', x: -56.0, z: 32.0, rx: 14.0, rz: 16.0, count: 12, spacing: 8.0, shrubs: 4, seed: 404 },
            { id: 'forest_sw_river', type: 'forest', x: -54.0, z: -2.0, rx: 14.0, rz: 16.0, count: 12, spacing: 8.0, shrubs: 4, seed: 406 },

            // Восточный фланг: лес от южных гор ДО САМОЙ РЕКИ
            { id: 'forest_se_mid',   type: 'forest', x: 56.0,  z: 32.0, rx: 14.0, rz: 16.0, count: 12, spacing: 8.0, shrubs: 4, seed: 405 },
            { id: 'forest_se_river', type: 'forest', x: 54.0,  z: -2.0, rx: 14.0, rz: 16.0, count: 12, spacing: 8.0, shrubs: 4, seed: 407 },

            // Подлесок: скальные валуны и папоротники
            { id: 'rocks_s1',   type: 'rocks',  x: -36.0, z: 58.0, radius: 6.0, count: 4, seed: 411 },
            { id: 'rocks_s2',   type: 'rocks',  x: 36.0,  z: 58.0, radius: 6.0, count: 4, seed: 412 },
            { id: 'ferns_s1',   type: 'fernPatch', x: -22.0, z: 49.0, radius: 6.0, count: 10, seed: 421 },
            { id: 'ferns_s2',   type: 'fernPatch', x: 22.0,  z: 46.0, radius: 6.0, count: 10, seed: 422 },
            { id: 'ferns_sw',   type: 'fernPatch', x: -48.0, z: 14.0, radius: 6.0, count: 8, seed: 423 },
            { id: 'ferns_se',   type: 'fernPatch', x: 48.0,  z: 14.0, radius: 6.0, count: 8, seed: 424 },

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
    },

    // -------------------------------------------------------------
    // ЛОКАЦИЯ: Древние катакомбы (Подземелье)
    // -------------------------------------------------------------
    ancientCatacombs: {
        id: 'ancientCatacombs',
        name: 'Древние катакомбы',
        isDungeon: true,
        surfaceLocation: 'forestEdge',
        surfaceSpawn: 'fromDungeon',

        terrain: {
            size: 130,
            seed: 777,
            biome: 'forest',
            flat: true,
            hidden: true,
            segments: 4,
            waterBody: { type: 'none' },
            hills: { amplitude: 0.0, inclineX: 0.0, inclineZ: 0.0 },
            baseHeight: 0.0,
            border: 0
        },

        // Атмосфера глубокого подземелья: мрак и туман
        atmosphere: {
            sky: 0x06080c,
            skyTop: 0x040508,
            fogColor: 0x06080c,
            fogDensity: 0.022
        },

        // Освещение: приглушенный амбиент, слабый холодный свет сверху, факелы дают основной свет
        lighting: {
            hemiSky: 0x3a4660,
            hemiGround: 0x2a2420,
            hemiIntensity: 1.05,
            sunColor: 0x486080,
            sunIntensity: 0.15
        },

        cameraAngle: Math.PI,   // камера позади героя, который идёт вглубь пещеры (+Z)
        cameraDistance: 6.8,
        minDistance: 3.8,
        maxDistance: 8.5,
        pitchZoomedIn: 0.28,
        pitchZoomedOut: 0.52,

        // Камера подземелья: настоящая проверка столкновений со стенами и сводом (AveloraDungeon.constrainCamera)

        spawns: {
            default:  { x: 0.0, z: -38.0, r: Math.PI }, // лицом вглубь пещеры (на +Z)
            entrance: { x: 0.0, z: -38.0, r: Math.PI }
        },

        exits: [
            // Обратный портал на поверхность (выход в грот)
            {
                id: 'toSurface',
                x: 0.0,
                z: -41.2,
                y: 0.02,
                radius: 1.3,
                height: 2.2,
                color: 0x6e8fff,
                to: 'forestEdge',
                spawn: 'fromDungeon',
                label: 'Выход на поверхность'
            }
        ],

        dungeon: {
            id: 'crypt_passage',
            // Босс убит -> на его месте открывается портал выхода, входной портал на поверхности гаснет;
            // через resetSeconds (настенные часы) данж откатывается полностью (босс и все мобы возрождаются)
            bossId: 'catacombs_minotaur_1',
            resetSeconds: 60,   // (секунды по настенным часам; для боя поставить 7200) откат начинается, когда герой ВЫШЕЛ из данжа после убийства босса
            // подход к кобольду: все оставшиеся живыми крысы и пауки бегут в атаку
            rally: { triggerId: 'catacombs_kobold_1', radius: 16, types: ['rat', 'spider'] },
            bossExit: { id: 'bossExit', x: 0.0, z: 42.0, y: 0.02, radius: 1.3, height: 2.2, color: 0x6e8fff, to: 'forestEdge', spawn: 'fromDungeon', label: 'Выход из подземелья' }
        },

        creatures: [
            // Чёрные крысы в гротах и коридоре подземелья (5 уровень, Элита)
            { id: 'catacombs_rat_1', type: 'rat', level: 5, rank: 'elite', x: -9.5, z: -30.0, r: 1.0, behavior: 'aggressive', aggroRadius: 8.0 },
            { id: 'catacombs_rat_2', type: 'rat', level: 5, rank: 'elite', x: -6.0, z: -26.0, r: 4.2, behavior: 'aggressive', aggroRadius: 8.0 },
            { id: 'catacombs_rat_3', type: 'rat', level: 5, rank: 'elite', x: -1.3, z: -15.5, r: 0.5, behavior: 'aggressive', aggroRadius: 8.0 },
            { id: 'catacombs_rat_4', type: 'rat', level: 5, rank: 'elite', x: 1.3,  z: -13.0, r: 3.7, behavior: 'aggressive', aggroRadius: 8.0 },
            { id: 'catacombs_rat_5', type: 'rat', level: 5, rank: 'elite', x: -1.1, z: -1.5,  r: 1.8, behavior: 'aggressive', aggroRadius: 8.0 },
            { id: 'catacombs_rat_6', type: 'rat', level: 5, rank: 'elite', x: 1.1,  z: 2.0,   r: 5.0, behavior: 'aggressive', aggroRadius: 8.0 },

            // Пауки в боковых гротах подземелья (5 уровень, Элита)
            { id: 'catacombs_spider_1', type: 'spider', level: 5, rank: 'elite', x: 12.0,  z: -13.7, r: -1.2, behavior: 'aggressive', aggroRadius: 9.0 },
            { id: 'catacombs_spider_2', type: 'spider', level: 5, rank: 'elite', x: -20.5, z: -28.5, r: 1.57, behavior: 'aggressive', aggroRadius: 9.0 },

            // Кобольд-рудокоп в каменном склепе перед решёткой (5 уровень, Элита)
            { id: 'catacombs_kobold_1', type: 'kobold', level: 5, rank: 'elite', x: 0.0, z: 15.0, r: Math.PI, behavior: 'aggressive', aggroRadius: 9.0, leashRadius: 22.0 },

            // Железнокожий минотавр в Великом Зале босса за решёткой (6 уровень, БОСС, арена боя во всём зале)
            { id: 'catacombs_minotaur_1', type: 'minotaur', level: 6, rank: 'boss', x: 0.0, z: 42.0, r: Math.PI, behavior: 'aggressive', aggroRadius: 11.0, leashRadius: 36.0 }
        ],

        decorations: [],
        groups: []
    }
};

// Совместимость со старым кодом: текущая локация (движок обновляет её при переходах)
window.CURRENT_LOCATION = window.LOCATIONS[window.START_LOCATION];
