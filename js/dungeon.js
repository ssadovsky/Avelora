/**
 * AVELORA — Modular Dungeon & Catacombs System (AveloraDungeon)
 *
 * Создает процедурно-модульную архитектуру подземелий, катакомб и склепов:
 * - Каменный сводчатый проход (продолжение пещеры), переходящий в галерею;
 * - Монументальные каменные стены, арки, пилястры и каменный пол;
 * - Настенные факелы с живым пламенем (AveloraFire) и мерцающим светом;
 * - Автоматическая регистрация непроходимых стен и колонн в DiabloPathfinder;
 * - Оптимизированная геометрия под мобильные устройства и ПК (60 FPS).
 */
(function () {
    'use strict';

    class AveloraDungeon {
        constructor(scene, config = {}, terrain = null, pathfinder = null) {
            this.scene = scene;
            this.config = config;
            this.terrain = terrain;
            this.pathfinder = pathfinder;

            this.group = new THREE.Group();
            this.group.name = `dungeon:${config.id || 'catacombs'}`;
            this.scene.add(this.group);

            this.fires = [];
            this.lights = [];
            this.geometries = [];
            this.materials = [];
            this.disposed = false;

            this._initMaterials();
            this._buildPassage();
            this._buildTorches();
            this._registerColliders();
        }

        _initMaterials() {
            const assets = (window.GAME_ASSETS && window.GAME_ASSETS.textures) || {};
            const texLoader = new THREE.TextureLoader();

            // PBR текстуры стен и пола
            const rockDiff = assets.rockDiff ? texLoader.load(assets.rockDiff) : null;
            const rockNor = (assets.rockNor || assets.beachNor) ? texLoader.load(assets.rockNor || assets.beachNor) : null;
            if (rockDiff) {
                rockDiff.wrapS = rockDiff.wrapT = THREE.RepeatWrapping;
                rockDiff.repeat.set(2.0, 2.0);
            }
            if (rockNor) {
                rockNor.wrapS = rockNor.wrapT = THREE.RepeatWrapping;
                rockNor.repeat.set(2.0, 2.0);
            }

            const floorDiff = assets.stoneTrailDiff ? texLoader.load(assets.stoneTrailDiff) : rockDiff;
            if (floorDiff && floorDiff !== rockDiff) {
                floorDiff.wrapS = floorDiff.wrapT = THREE.RepeatWrapping;
                floorDiff.repeat.set(2.5, 6.0);
            }

            // Материал стен (серый древний сланец / гранит)
            this.wallMat = new THREE.MeshStandardMaterial({
                color: 0x8a8e94,
                map: rockDiff,
                normalMap: rockNor,
                roughness: 0.88,
                metalness: 0.04
            });
            this.materials.push(this.wallMat);

            // Материал пола (каменные плиты)
            this.floorMat = new THREE.MeshStandardMaterial({
                color: 0x76797f,
                map: floorDiff,
                normalMap: rockNor,
                roughness: 0.82,
                metalness: 0.02
            });
            this.materials.push(this.floorMat);

            // Материал арочных сводов и колонн (чуть более темный каменный блок)
            this.trimMat = new THREE.MeshStandardMaterial({
                color: 0x686c72,
                map: rockDiff,
                normalMap: rockNor,
                roughness: 0.90,
                metalness: 0.05
            });
            this.materials.push(this.trimMat);

            // Металл для кованых держателей факелов и решетки в конце коридора
            this.ironMat = new THREE.MeshStandardMaterial({
                color: 0x222428,
                roughness: 0.45,
                metalness: 0.82
            });
            this.materials.push(this.ironMat);
        }

        _buildPassage() {
            // Размеры коридора
            const length = 28.0;      // z от -3.5 до +24.5
            const width = 4.8;        // от x = -2.4 до x = +2.4
            const height = 5.4;       // высота стен
            const zStart = -3.5;
            const zEnd = 24.5;
            const zCenter = (zStart + zEnd) * 0.5;

            // 1. Каменный пол (строго на Y=0.0 вровень со ступнями героя)
            const floorGeo = new THREE.PlaneGeometry(width, length, 12, 28);
            floorGeo.rotateX(-Math.PI / 2);
            const floorMesh = new THREE.Mesh(floorGeo, this.floorMat);
            floorMesh.position.set(0, 0.0, zCenter);
            floorMesh.receiveShadow = true;
            this.group.add(floorMesh);
            this.geometries.push(floorGeo);

            // 2. Левая и правая стены коридора
            const wallThick = 0.8;
            const wallGeo = new THREE.BoxGeometry(wallThick, height, length);
            this.geometries.push(wallGeo);

            // Левая стена (x = -width/2 - wallThick/2)
            const leftWall = new THREE.Mesh(wallGeo, this.wallMat);
            leftWall.position.set(-width * 0.5 - wallThick * 0.5, height * 0.5, zCenter);
            leftWall.castShadow = true;
            leftWall.receiveShadow = true;
            this.group.add(leftWall);

            // Правая стена (x = width/2 + wallThick/2)
            const rightWall = new THREE.Mesh(wallGeo, this.wallMat);
            rightWall.position.set(width * 0.5 + wallThick * 0.5, height * 0.5, zCenter);
            rightWall.castShadow = true;
            rightWall.receiveShadow = true;
            this.group.add(rightWall);

            // 3. Задняя стена за порталом (входной каменный альков, z = zStart - wallThick/2)
            const backGeo = new THREE.BoxGeometry(width + wallThick * 2, height, wallThick);
            this.geometries.push(backGeo);
            const backWall = new THREE.Mesh(backGeo, this.wallMat);
            backWall.position.set(0, height * 0.5, zStart - wallThick * 0.5);
            backWall.castShadow = true;
            backWall.receiveShadow = true;
            this.group.add(backWall);

            // 4. Сплошной каменный свод / потолок коридора (монолитный верх над всей галереей)
            const roofGeo = new THREE.BoxGeometry(width + wallThick * 2, 0.6, length + wallThick * 2);
            this.geometries.push(roofGeo);
            const roofMesh = new THREE.Mesh(roofGeo, this.trimMat);
            roofMesh.position.set(0, height + 0.3, zCenter);
            roofMesh.castShadow = true;
            roofMesh.receiveShadow = true;
            this.group.add(roofMesh);

            // 4.1 Внешний защитный кожух (Backdrop shell): темный матовый монолит снаружи стен и потолка
            const shellMat = new THREE.MeshBasicMaterial({ color: 0x050608, side: THREE.BackSide });
            this.materials.push(shellMat);
            const shellGeo = new THREE.BoxGeometry(width + wallThick * 2 + 0.4, height + 1.2, length + wallThick * 2 + 0.4);
            this.geometries.push(shellGeo);
            const shellMesh = new THREE.Mesh(shellGeo, shellMat);
            shellMesh.position.set(0, height * 0.5 + 0.1, zCenter);
            this.group.add(shellMesh);

            // 5. Каменные колонны и стрельчатые арки вдоль коридора
            const archSteps = [0.0, 5.0, 10.0, 15.0, 20.0, zEnd];
            const pillarGeo = new THREE.BoxGeometry(0.7, height, 0.7);
            const archBeamGeo = new THREE.BoxGeometry(width + 0.2, 0.5, 0.6);
            this.geometries.push(pillarGeo, archBeamGeo);

            archSteps.forEach(z => {
                // Колонна слева
                const pLeft = new THREE.Mesh(pillarGeo, this.trimMat);
                pLeft.position.set(-width * 0.5 + 0.25, height * 0.5, z);
                pLeft.castShadow = true;
                pLeft.receiveShadow = true;
                this.group.add(pLeft);

                // Колонна справа
                const pRight = new THREE.Mesh(pillarGeo, this.trimMat);
                pRight.position.set(width * 0.5 - 0.25, height * 0.5, z);
                pRight.castShadow = true;
                pRight.receiveShadow = true;
                this.group.add(pRight);

                // Поперечная арка под потолком
                const arch = new THREE.Mesh(archBeamGeo, this.trimMat);
                arch.position.set(0, height - 0.25, z);
                arch.castShadow = true;
                this.group.add(arch);
            });

            // 6. Дальний конец коридора (массивная кованая решетка и арка входа в будущий Великий Зал)
            const endWallGeo = new THREE.BoxGeometry(width + wallThick * 2, height, wallThick);
            this.geometries.push(endWallGeo);
            const endWall = new THREE.Mesh(endWallGeo, this.wallMat);
            endWall.position.set(0, height * 0.5, zEnd + wallThick * 0.5);
            endWall.castShadow = true;
            this.group.add(endWall);

            // Кованая железная решетка (Portcullis) в конце коридора
            this._buildPortcullis(0, zEnd);
        }

        _buildPortcullis(x, z) {
            const gateGroup = new THREE.Group();
            gateGroup.position.set(x, 0, z);

            // Рама решетки
            const frameGeo = new THREE.BoxGeometry(3.2, 4.4, 0.2);
            this.geometries.push(frameGeo);

            // Вертикальные прутья
            const barGeo = new THREE.CylinderGeometry(0.04, 0.04, 4.0, 8);
            this.geometries.push(barGeo);

            for (let bx = -1.3; bx <= 1.35; bx += 0.35) {
                const bar = new THREE.Mesh(barGeo, this.ironMat);
                bar.position.set(bx, 2.0, 0);
                gateGroup.add(bar);
            }

            // Горизонтальные поперечины
            const crossGeo = new THREE.BoxGeometry(2.9, 0.08, 0.1);
            this.geometries.push(crossGeo);
            [0.8, 1.8, 2.8, 3.6].forEach(by => {
                const cross = new THREE.Mesh(crossGeo, this.ironMat);
                cross.position.set(0, by, 0);
                gateGroup.add(cross);
            });

            this.group.add(gateGroup);
        }

        _buildTorches() {
            // Расстановка парных факелов на стенах
            const torchZs = [1.5, 7.5, 13.5, 19.5];
            const torchX = 2.15; // отступ от центра к стенам
            const torchY = 2.2;  // комфортная высота на уровне взгляда героя

            torchZs.forEach((tz, idx) => {
                this._createWallTorch(-torchX, torchY, tz, 1);   // левый факел (смотрит вправо)
                this._createWallTorch(torchX, torchY, tz, -1);  // правый факел (смотрит влево)
            });
        }

        _createWallTorch(x, y, z, dirX) {
            const torchGroup = new THREE.Group();
            torchGroup.position.set(x, y, z);

            // Кронштейн факела (диагональный металлический держатель)
            const holderGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.55, 6);
            holderGeo.rotateZ(dirX * 0.55);
            this.geometries.push(holderGeo);
            const holder = new THREE.Mesh(holderGeo, this.ironMat);
            holder.position.set(dirX * 0.18, 0, 0);
            torchGroup.add(holder);

            // Чаша факела
            const cupGeo = new THREE.CylinderGeometry(0.12, 0.06, 0.18, 8);
            this.geometries.push(cupGeo);
            const cup = new THREE.Mesh(cupGeo, this.ironMat);
            cup.position.set(dirX * 0.32, 0.22, 0);
            torchGroup.add(cup);

            // Живое пламя (AveloraFire)
            if (window.AveloraFire) {
                const fire = new window.AveloraFire(torchGroup, {
                    y: 0.24,
                    size: 0.38
                });
                fire.group.position.set(dirX * 0.32, 0.24, 0);
                this.fires.push(fire);
            }

            // Динамический точечный источник света
            const light = new THREE.PointLight(0xff942c, 1.45, 9.5, 2.0);
            light.position.set(dirX * 0.32, 0.35, 0);
            torchGroup.add(light);

            this.lights.push({
                light: light,
                baseIntensity: 1.45,
                seed: Math.random() * 100.0
            });

            this.group.add(torchGroup);
        }

        _registerColliders() {
            if (!this.pathfinder) return;

            const r = 0.35;
            // 1. Задняя стена за порталом (z = -3.5)
            for (let x = -3.0; x <= 3.0; x += 0.5) {
                this.pathfinder.addObstacle(x, -3.5, r);
            }

            // 2. Левая стена (x = -2.5) и правая стена (x = +2.5)
            for (let z = -3.5; z <= 25.5; z += 0.5) {
                this.pathfinder.addObstacle(-2.5, z, r);
                this.pathfinder.addObstacle(2.5, z, r);
            }

            // 3. Колонны вдоль прохода (чуть выдаются внутрь)
            const archSteps = [0.0, 5.0, 10.0, 15.0, 20.0, 24.5];
            archSteps.forEach(z => {
                this.pathfinder.addObstacle(-2.2, z, 0.45);
                this.pathfinder.addObstacle(2.2, z, 0.45);
            });

            // 4. Решетка/тупик в конце коридора (z = 24.5)
            for (let x = -3.0; x <= 3.0; x += 0.5) {
                this.pathfinder.addObstacle(x, 24.5, r);
            }
        }

        update(delta, time) {
            if (this.disposed) return;

            // Обновление частиц пламени факелов
            for (let i = 0; i < this.fires.length; i++) {
                this.fires[i].update(delta);
            }

            // Реалистичное мерцание света факелов
            const now = time || 0;
            for (let i = 0; i < this.lights.length; i++) {
                const item = this.lights[i];
                const flick = 0.90 + 0.10 * Math.sin(now * 11.0 + item.seed) * Math.sin(now * 6.5 + item.seed * 2.3);
                item.light.intensity = item.baseIntensity * flick;
            }
        }

        dispose() {
            this.disposed = true;
            if (this.group.parent) this.group.parent.remove(this.group);

            // Очистка огня
            this.fires.forEach(f => f.dispose());
            this.fires.length = 0;

            // Очистка геометрий
            this.geometries.forEach(g => g.dispose());
            this.geometries.length = 0;

            // Очистка материалов
            this.materials.forEach(m => m.dispose());
            this.materials.length = 0;
        }
    }

    window.AveloraDungeon = AveloraDungeon;
})();
