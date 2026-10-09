/**
 * Realistic Three.js Water Surface (lake / coast / island)
 *
 * ONE THREE.Water instance lives for the whole game session (its reflection render
 * target and shader are created once). On location change `setLocation()` only swaps
 * the plane geometry, position and shore foam. For `waterBody.type === 'none'`
 * the water is hidden, so its expensive reflection pass is skipped entirely.
 */
// Профили ряби по типам водоёма (озеро / море / река). Водопад — отдельная геометрия со своими шейдерами (waterfall.js),
// эти профили на него не влияют. Профиль применяется в setLocation, поэтому типы не влияют друг на друга.
const WATER_RIPPLE = {
    lake:  { normalScale: 0.55, size: 0.45, distortionScale: 1.4, timeSpeed: 0.12 },   // спокойное лесное озеро: крупная медленная рябь
    sea:   { normalScale: 1.5,  size: 1.0,  distortionScale: 3.2, timeSpeed: 0.35 },   // море/острова: прежняя волна
    river: { normalScale: 1.5,  size: 1.0,  distortionScale: 3.2, timeSpeed: 0.35 }
};

class LakesideWater {
    constructor(scene, sunLight, location = null) {
        this.scene = scene;
        this.sunLight = sunLight;
        this.water = null;
        this.foamMesh = null;
        this.elapsed = 0;
        this.timeSpeed = 0.35;

        this.createWater();
        this.setLocation(location || window.CURRENT_LOCATION || {});
    }

    createWater() {
        const texLoader = new THREE.TextureLoader();
        const waterNormals = texLoader.load(window.GAME_ASSETS.textures.waterNormals);
        waterNormals.wrapS = THREE.RepeatWrapping;
        waterNormals.wrapT = THREE.RepeatWrapping;

        const sunDir = this.sunLight.position.clone().normalize();

        this.water = new THREE.Water(new THREE.PlaneGeometry(1, 1), {
            textureWidth: 512,
            textureHeight: 512,
            waterNormals: waterNormals,
            sunDirection: sunDir,
            sunColor: 0xfff6e6,
            waterColor: 0x0a3338,
            distortionScale: 3.2,
            fog: true,
            alpha: 0.92
        });
        this.water.rotation.x = -Math.PI / 2;
        this.scene.add(this.water);

        this.foamMat = new THREE.MeshBasicMaterial({
            color: 0xddeeff,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
    }

    setLocation(location) {
        const locTerrain = location.terrain || {};
        const waterConfig = locTerrain.waterBody || locTerrain.lake || { type: 'lake', x: -14, z: 2, radius: 24 };
        const locWater = location.water || {};

        // Remove previous shore foam
        if (this.foamMesh) {
            this.scene.remove(this.foamMesh);
            this.foamMesh.geometry.dispose();
            this.foamMesh = null;
        }

        const wType = waterConfig.type || 'lake';
        const ripple = WATER_RIPPLE[wType === 'lake' ? 'lake' : (wType === 'river' ? 'river' : 'sea')];
        const U = this.water.material.uniforms;
        U['normalScale'].value = ripple.normalScale;
        U['size'].value = ripple.size;
        U['distortionScale'].value = ripple.distortionScale;
        this.timeSpeed = ripple.timeSpeed;
        if (wType === 'none') {
            this.water.visible = false;
            return;
        }
        this.water.visible = true;

        const mapSize = (locTerrain.size || 120) + 2 * ((locTerrain.border !== undefined) ? locTerrain.border : 28);

        let posX = 0;
        let posZ = 0;
        let sizeX = locWater.size || 160;
        let sizeZ = locWater.size || 160;

        if (wType === 'coast') {
            // Sea / ocean covering entire edge
            const side = waterConfig.side || 'west';
            const shoreLine = (waterConfig.shoreLine !== undefined) ? waterConfig.shoreLine : -10.0;
            const seaSpan = mapSize * 1.5;

            if (side === 'west') {
                sizeX = mapSize * 1.2; sizeZ = seaSpan;
                posX = shoreLine - sizeX / 2 + 2; posZ = 0;
            } else if (side === 'east') {
                sizeX = mapSize * 1.2; sizeZ = seaSpan;
                posX = shoreLine + sizeX / 2 - 2; posZ = 0;
            } else if (side === 'north') {
                sizeX = seaSpan; sizeZ = mapSize * 1.2;
                posX = 0; posZ = shoreLine - sizeZ / 2 + 2;
            } else if (side === 'south') {
                sizeX = seaSpan; sizeZ = mapSize * 1.2;
                posX = 0; posZ = shoreLine + sizeZ / 2 - 2;
            }
        } else if (wType === 'island') {
            sizeX = mapSize * 1.8;
            sizeZ = mapSize * 1.8;
        } else if (wType === 'river') {
            // one plane over the whole map at Y = 0: only the carved channel lies below it
            sizeX = sizeZ = (locTerrain.size || 120) + 6;
        } else {
            // Lake basin
            posX = (waterConfig.x !== undefined) ? waterConfig.x : -14.0;
            posZ = (waterConfig.z !== undefined) ? waterConfig.z : 2.0;
            const rad = waterConfig.radius || 24.0;
            sizeX = Math.max(locWater.size || 0, rad * 3.5);
            sizeZ = sizeX;
        }

        this.water.geometry.dispose();
        this.water.geometry = new THREE.PlaneGeometry(sizeX, sizeZ);
        this.water.position.set(posX, 0.0, posZ);

        // Shore foam effect (none for rivers: a ring/line would not follow the channel)
        if (wType === 'river') {
            return;
        }
        if (wType === 'coast') {
            const side = waterConfig.side || 'west';
            const shoreLine = (waterConfig.shoreLine !== undefined) ? waterConfig.shoreLine : -10.0;
            const isHorizontal = (side === 'north' || side === 'south');
            const foamGeo = new THREE.PlaneGeometry(
                isHorizontal ? mapSize * 1.3 : 8.0,
                isHorizontal ? 8.0 : mapSize * 1.3
            );
            foamGeo.rotateX(-Math.PI / 2);
            this.foamMesh = new THREE.Mesh(foamGeo, this.foamMat);
            if (side === 'west' || side === 'east') {
                this.foamMesh.position.set(shoreLine, 0.02, 0);
            } else {
                this.foamMesh.position.set(0, 0.02, shoreLine);
            }
        } else if (wType === 'island') {
            // Island shoreline ring (для озера и реки кольцо пены отключено — давало видимый круг на воде)
            const foamRadius = (waterConfig.radius || 24.0);
            const foamGeo = new THREE.RingGeometry(Math.max(0.5, foamRadius - 2.0), foamRadius + 4.0, 48);
            foamGeo.rotateX(-Math.PI / 2);
            this.foamMesh = new THREE.Mesh(foamGeo, this.foamMat);
            this.foamMesh.position.set(posX, 0.02, posZ);
        }
        if (this.foamMesh) this.scene.add(this.foamMesh);
    }

    update(delta) {
        this.elapsed += delta; // game time (stops on pause)
        if (this.water && this.water.material && this.water.material.uniforms['time']) {
            this.water.material.uniforms['time'].value += delta * this.timeSpeed;
        }
        if (this.foamMesh) {
            this.foamMat.opacity = 0.18 + Math.sin(this.elapsed * 2.0) * 0.06;
        }
    }
}

window.LakesideWater = LakesideWater;
