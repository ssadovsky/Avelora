/**
 * AVELORA — Torchlit Grotto
 *
 * Компактный грот-пещера в восточном горном барьере, северо-восточнее водопада.
 * Вход смотрит на запад (в сторону долины).
 *
 * Проблемы предыдущей версии:
 *  - Через открытый верх арки была видна поверхность горного рельефа.
 *    Решение: тёмная непрозрачная плоскость-«фон» в глубине туннеля.
 *  - FOOTPRINT_MASK ставил obstacle прямо в проходе у входа.
 *    Решение: только 4 явных боковых коллайдера (стены арки, не вход).
 */
(function () {
    // [lx, lz] в локальных координатах модели (единицы масштаба 1.0)
    const GROTTO_BLOCKED_CELLS = [[-0.879,0.0],[-0.769,0.549],[-0.769,0.44],[-0.769,0.33],[-0.769,0.22],[-0.769,0.11],[-0.769,0.0],[-0.769,-0.11],[-0.659,0.659],[-0.659,0.549],[-0.659,0.44],[-0.659,0.33],[-0.659,0.22],[-0.659,0.11],[-0.659,0.0],[-0.659,-0.11],[-0.659,-0.22],[-0.659,-0.33],[-0.659,-0.44],[-0.659,-0.549],[-0.549,0.659],[-0.549,0.549],[-0.549,0.44],[-0.549,0.33],[-0.549,0.22],[-0.549,0.11],[-0.549,0.0],[-0.549,-0.11],[-0.549,-0.22],[-0.549,-0.33],[-0.549,-0.44],[-0.549,-0.549],[-0.549,-0.659],[-0.44,0.769],[-0.44,0.659],[-0.44,0.549],[-0.44,0.44],[-0.44,0.33],[-0.44,0.22],[-0.44,0.11],[-0.44,0.0],[-0.44,-0.11],[-0.44,-0.22],[-0.44,-0.33],[-0.44,-0.44],[-0.44,-0.549],[-0.44,-0.659],[-0.33,0.549],[-0.33,0.44],[-0.33,0.33],[-0.33,0.22],[-0.33,0.11],[-0.33,0.0],[-0.33,-0.11],[-0.33,-0.22],[-0.33,-0.33],[-0.33,-0.44],[-0.33,-0.549],[-0.33,-0.659],[-0.33,-0.769],[-0.33,-0.879],[-0.33,-0.989],[-0.33,-1.099],[-0.22,0.44],[-0.22,0.33],[-0.22,0.22],[-0.22,-0.11],[-0.22,-0.22],[-0.22,-0.33],[-0.22,-0.44],[-0.22,-0.549],[-0.22,-0.659],[-0.22,-0.769],[-0.22,-0.879],[-0.22,-0.989],[-0.22,-1.099],[-0.11,-0.22],[-0.11,-0.33],[-0.11,-0.44],[-0.11,-0.549],[-0.11,-0.659],[-0.11,-0.769],[-0.11,-0.879],[-0.11,-0.989],[-0.11,-1.099],[0.0,-0.22],[0.0,-0.33],[0.0,-0.44],[0.0,-0.549],[0.0,-0.659],[0.0,-0.769],[0.0,-0.879],[0.0,-0.989],[0.0,-1.099],[0.11,-0.22],[0.11,-0.33],[0.11,-0.44],[0.11,-0.549],[0.11,-0.659],[0.11,-0.769],[0.11,-0.879],[0.11,-0.989],[0.11,-1.099],[0.22,-0.22],[0.22,-0.33],[0.22,-0.44],[0.22,-0.549],[0.22,-0.659],[0.22,-0.769],[0.22,-0.879],[0.22,-0.989],[0.22,-1.099],[0.33,0.33],[0.33,0.22],[0.33,-0.11],[0.33,-0.22],[0.33,-0.33],[0.33,-0.44],[0.33,-0.549],[0.33,-0.659],[0.33,-0.769],[0.33,-0.879],[0.33,-0.989],[0.33,-1.099],[0.44,0.549],[0.44,0.44],[0.44,0.33],[0.44,0.22],[0.44,0.11],[0.44,0.0],[0.44,-0.11],[0.44,-0.22],[0.44,-0.33],[0.44,-0.44],[0.44,-0.549],[0.44,-0.659],[0.44,-0.769],[0.44,-0.879],[0.44,-0.989],[0.44,-1.099],[0.549,0.549],[0.549,0.44],[0.549,0.33],[0.549,0.22],[0.549,0.11],[0.549,0.0],[0.549,-0.11],[0.549,-0.22],[0.549,-0.33],[0.549,-0.44],[0.549,-0.549],[0.549,-0.659],[0.659,0.44],[0.659,0.33],[0.659,0.22],[0.659,0.11],[0.659,0.0],[0.659,-0.11],[0.659,-0.22],[0.659,-0.33],[0.659,-0.44],[0.659,-0.549],[0.769,0.33],[0.769,0.22],[0.769,0.11],[0.769,0.0],[0.769,-0.11],[0.769,-0.22],[0.769,-0.33],[0.769,-0.44],[0.769,-0.549],[0.879,0.11],[0.879,0.0]];

    class AveloraGrotto {
        constructor(scene, config = {}, terrain = null, pathfinder = null) {
            this.scene = scene;
            this.config = config;
            this.terrain = terrain;
            this.pathfinder = pathfinder;

            this.x         = config.x         !== undefined ? config.x         : 139.5;
            this.z         = config.z         !== undefined ? config.z         : -18.0;
            this.scale     = config.scale     !== undefined ? config.scale     : 4.55;
            this.rotationY = config.rotationY !== undefined ? config.rotationY : -Math.PI / 2;

            this.group = new THREE.Group();
            this.group.name = `grotto:${config.id || 'main'}`;
            this.group.position.set(this.x, 0, this.z);
            this.group.rotation.y = this.rotationY;
            this.group.scale.setScalar(this.scale);

            this.group.position.y = config.y !== undefined ? config.y : this._autoY();
            this.group.updateMatrixWorld(true);

            this.scene.add(this.group);

            this._loadModel(config.modelKey || 'torchlit_grotto');
            this._buildBackdrop();
            this._registerObstacles();
        }

        // ───────────────────────────────────────────
        //  Высота: пещера приподнята, каменный пол четко виден над травой
        // ───────────────────────────────────────────
        _autoY() {
            if (!this.terrain || !this.terrain.getHeightAt) return 3.34;
            const groundY = this.terrain.getHeightAt(this.x, this.z);
            // Приподнимаем модель: каменный пол ложится четко поверх травы
            return groundY + 0.40 * this.scale + 0.22;
        }

        // ───────────────────────────────────────────
        //  Загрузка GLB модели
        // ───────────────────────────────────────────
        _loadModel(key) {
            const b64 = window.GAME_ASSETS && window.GAME_ASSETS.models && window.GAME_ASSETS.models[key];
            if (!b64) {
                console.warn(`[AveloraGrotto] Model "${key}" not found in GAME_ASSETS.models`);
                return;
            }
            const bin = window.atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

            new THREE.GLTFLoader().parse(bytes.buffer, '', (gltf) => {
                if (this._disposed) return;
                this.model = gltf.scene;
                this.model.traverse((child) => {
                    if (!child.isMesh) return;
                    child.castShadow    = true;
                    child.receiveShadow = true;
                    if (child.material) {
                        child.material.metalness = 0.0;
                        child.material.roughness = 0.88;
                    }
                });
                this.group.add(this.model);
            }, (err) => console.error(`[AveloraGrotto] GLTF parse error "${key}"`, err));
        }

        // ───────────────────────────────────────────
        //  Коллизии: запечённая по реальной геометрии модели карта проходимости.
        //  Ячейки 0.5 м (в локальных координатах модели, пересчитываются по x/z/scale/rotationY):
        //  стены, скальные выступы и глубина пещеры глубже ~3.5 м от входа закрыты, проход внутрь и коридор открыты.
        //  Раньше стояло лишь 6 кружков по бокам арки, поэтому по краям персонаж проходил сквозь камни.
        // ───────────────────────────────────────────
        _registerObstacles() {
            if (!this.pathfinder) return;
            const sc = this.scale, c = Math.cos(this.rotationY), s = Math.sin(this.rotationY);
            const r = 0.30;
            for (const [lx, lz] of GROTTO_BLOCKED_CELLS) {
                // поворот вокруг Y: x' = x cosθ + z sinθ,  z' = -x sinθ + z cosθ
                const wx = this.x + (lx * c + lz * s) * sc;
                const wz = this.z + (-lx * s + lz * c) * sc;
                this.pathfinder.addObstacle(wx, wz, r);
            }
        }

        // ───────────────────────────────────────────
        //  Тёмная «глубина»: сзади в модели есть прогалы на уровне пола, сквозь них виден горный склон (светлая гора в глубине).
        //  Закрываем их тёмным объёмом сразу за глубиной пещеры (виден только из пещеры, снаружи он спрятан в горе).
        // ───────────────────────────────────────────
        _buildBackdrop() {
            const mat = new THREE.MeshBasicMaterial({ color: 0x0e0805, side: THREE.DoubleSide });
            const geo = new THREE.BoxGeometry(1.5, 0.48, 0.45);
            const box = new THREE.Mesh(geo, mat);
            // локальные координаты: глубина пещеры по -lz (мир: wx = cx - lz*sc), центр около wx≈143.2
            box.position.set(0.0, -0.27, -0.82);
            box.name = 'grotto-backdrop';
            this.group.add(box);
            this._backdrop = box;
        }

        // Столкновение камеры: расстояние от головы героя до ближайшей поверхности модели по лучу (или null).
        // Проверка только вблизи грота (по описанной сфере), поэтому почти бесплатна.
        rayLimit(origin, dir, maxDist) {
            if (!this.model) return null;
            if (!this._sphere) {
                this.group.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(this.model);
                this._sphere = box.getBoundingSphere(new THREE.Sphere());
                this._ray = new THREE.Raycaster();
            }
            const s = this._sphere;
            // отрезок луча [origin, origin + dir*maxDist] не касается сферы — выходим
            const ox = s.center.x - origin.x, oy = s.center.y - origin.y, oz = s.center.z - origin.z;
            const tproj = Math.max(0, Math.min(maxDist, ox * dir.x + oy * dir.y + oz * dir.z));
            const px = origin.x + dir.x * tproj - s.center.x, py = origin.y + dir.y * tproj - s.center.y, pz = origin.z + dir.z * tproj - s.center.z;
            if (px * px + py * py + pz * pz > s.radius * s.radius) return null;
            this._ray.set(new THREE.Vector3(origin.x, origin.y, origin.z), new THREE.Vector3(dir.x, dir.y, dir.z));
            this._ray.far = maxDist + 0.5;
            // стены грота изнутри — «задние» грани: на время проверки считаем материалы двусторонними
            if (!this._mats) {
                this._mats = [];
                this.model.traverse((c) => { if (c.isMesh && c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((mt) => this._mats.push(mt)); });
            }
            const saved = this._mats.map((mt) => mt.side);
            this._mats.forEach((mt) => { mt.side = THREE.DoubleSide; });
            const hits = this._ray.intersectObject(this.model, true);
            this._mats.forEach((mt, i) => { mt.side = saved[i]; });
            return hits.length ? hits[0].distance : null;
        }

        update(delta) { /* факелов нет */ }

        dispose() {
            this._disposed = true;
            if (this.group && this.group.parent) this.group.parent.remove(this.group);
            if (this._backdrop) { this._backdrop.geometry.dispose(); this._backdrop.material.dispose(); }
            if (this.model) {
                this.model.traverse((child) => {
                    if (!child.isMesh) return;
                    if (child.geometry) child.geometry.dispose();
                    const m = child.material;
                    if (m) {
                        ['map', 'normalMap', 'roughnessMap', 'metalnessMap'].forEach(k => {
                            if (m[k]) m[k].dispose();
                        });
                        m.dispose();
                    }
                });
            }
        }
    }

    window.AveloraGrotto = AveloraGrotto;
})();
