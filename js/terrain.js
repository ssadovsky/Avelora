/**
 * Realistic Procedural Terrain with Configurable Water Bodies:
 * - 'coast': Sea / Ocean along any edge ('west', 'east', 'north', 'south')
 * - 'lake': Enclosed lake basin with custom center and radius
 * - 'island': Land island surrounded by ocean
 * Smooth beach, rolling meadow (0.4m to 1.8m), seamless photographic PBR textures
 */
class LakesideTerrain {
    constructor(scene, options = {}, location = null) {
        this.scene = scene;

        const loc = location || window.CURRENT_LOCATION || {};
        const locTerrain = loc.terrain || {};
        // `size` = playable square (meters). The visible terrain mesh extends `border`
        // meters beyond it on every side, so the camera never shows the edge of the world.
        this.size = options.size || locTerrain.size || 120;
        this.segments = options.segments || locTerrain.segments || 240; // 240x240 сетка для плавных холмов без low-poly ступеней
        this.border = (locTerrain.border !== undefined) ? locTerrain.border : 28;
        this.biome = locTerrain.biome || 'forest';

        // Water body configuration (lake, coast, island)
        this.waterConfig = locTerrain.waterBody || locTerrain.lake || {
            type: 'lake',
            x: -14.0,
            z: 2.0,
            radius: 24.0,
            depth: -1.6
        };

        this.hillsConfig = locTerrain.hills || { amplitude: 1.4, inclineX: 0.8, inclineZ: 0.4 };
        // Average ground level above the water plane (Y = 0). Higher = drier land, fewer puddles.
        this.baseHeight = (locTerrain.baseHeight !== undefined) ? locTerrain.baseHeight : 0.85;
        this.noise = new SimplexNoise(locTerrain.seed !== undefined ? locTerrain.seed : 4242);

        this.mesh = null;
        this.material = null;

        this.init();
    }

    // Continuous, deterministic terrain elevation evaluation
    getHeightAt(x, z) {
        const nx = x / this.size;
        const nz = z / this.size;

        // Base rolling meadow (hills)
        let meadowHills = this.noise.fbm(nx * 1.8, nz * 1.8, 3, 2.0, 0.45) * this.hillsConfig.amplitude;
        meadowHills += (nx * this.hillsConfig.inclineX) + (nz * this.hillsConfig.inclineZ);

        // Natural subtle ground undulation
        const groundMicro = this.noise.noise2D(x * 0.08, z * 0.08) * 0.35 + this.noise.noise2D(x * 0.2, z * 0.2) * 0.12;
        let height = meadowHills + groundMicro + this.baseHeight;

        // Calculate distance from shoreline based on water body type:
        // distFromShore < 0 means under water (sea/lake bed)
        // distFromShore > 0 means land above water
        let distFromShore = 0;
        let waterDepth = -1.6;
        let beachWidth = 14.0;
        let bedSlope = 20.0; // meters from shoreline until full depth

        const wType = this.waterConfig.type || 'lake';

        if (wType === 'coast') {
            // SEA COASTLINE: stretches infinitely along an entire edge of the map
            const side = this.waterConfig.side || 'west';
            const shoreLine = (this.waterConfig.shoreLine !== undefined) ? this.waterConfig.shoreLine : -10.0;
            waterDepth = (this.waterConfig.depth !== undefined) ? this.waterConfig.depth : -2.0;
            beachWidth = (this.waterConfig.beachWidth !== undefined) ? this.waterConfig.beachWidth : 14.0;

            // Natural organic fractal curves along the coast
            if (side === 'west') {
                const curve = shoreLine + this.noise.noise2D(nz * 2.5, 0.5) * 6.5 + this.noise.noise2D(nz * 6.0, 1.2) * 2.5;
                distFromShore = x - curve;
            } else if (side === 'east') {
                const curve = shoreLine - (this.noise.noise2D(nz * 2.5, 0.5) * 6.5 + this.noise.noise2D(nz * 6.0, 1.2) * 2.5);
                distFromShore = curve - x;
            } else if (side === 'north') {
                const curve = shoreLine + this.noise.noise2D(nx * 2.5, 0.5) * 6.5 + this.noise.noise2D(nx * 6.0, 1.2) * 2.5;
                distFromShore = z - curve;
            } else if (side === 'south') {
                const curve = shoreLine - (this.noise.noise2D(nx * 2.5, 0.5) * 6.5 + this.noise.noise2D(nx * 6.0, 1.2) * 2.5);
                distFromShore = curve - z;
            }
        } else if (wType === 'island') {
            // ISLAND: land in center, sea all around
            const distFromCenter = Math.sqrt(x * x + z * z);
            const islandRadius = (this.waterConfig.radius || 35.0) + this.noise.noise2D(x * 0.05, z * 0.05) * 6.0;
            distFromShore = islandRadius - distFromCenter;
            waterDepth = this.waterConfig.depth || -2.5;
            beachWidth = this.waterConfig.beachWidth || 12.0;
        } else if (wType === 'none') {
            // Flat land, no water
            return height;
        } else {
            // LAKE: enclosed round/fractal lake basin
            const lakeX = (this.waterConfig.x !== undefined) ? this.waterConfig.x : -14.0;
            const lakeZ = (this.waterConfig.z !== undefined) ? this.waterConfig.z : 2.0;
            const baseRadius = this.waterConfig.radius || 24.0;
            waterDepth = (this.waterConfig.depth !== undefined) ? this.waterConfig.depth : -1.6;
            beachWidth = (this.waterConfig.beachWidth !== undefined) ? this.waterConfig.beachWidth : 14.0;

            const dx = x - lakeX;
            const dz = z - lakeZ;
            const distCenter = Math.sqrt(dx * dx + dz * dz);
            const angle = Math.atan2(dz, dx);
            // Shoreline wobble scales with lake size (small ponds stay pond-shaped)
            const wobble = Math.min(1.0, baseRadius / 24.0);
            const lakeRadius = baseRadius + (this.noise.noise2D(Math.cos(angle) * 1.3, Math.sin(angle) * 1.3) * 6.0
                                          + this.noise.noise2D(Math.cos(angle * 3) * 2.2, Math.sin(angle * 3) * 2.2) * 2.5) * wobble;
            distFromShore = distCenter - lakeRadius;
            bedSlope = Math.min(20.0, baseRadius * 0.85); // small ponds get deep quickly
        }

        // Apply smooth beach and water bed profile:
        if (distFromShore < 0) {
            // Under water (seabed or lakebed)
            const t = Math.min(1.0, -distFromShore / bedSlope);
            const smoothT = t * t * (3.0 - 2.0 * t);
            height = THREE.MathUtils.lerp(0.1, waterDepth, smoothT);
        } else if (distFromShore < beachWidth) {
            // Gentle sandy beach slope from waterline (0.1m) to meadow
            const t = distFromShore / beachWidth;
            const smoothT = t * t * (3.0 - 2.0 * t);
            height = THREE.MathUtils.lerp(0.1, height, smoothT);
        }

        return height;
    }

    getNormalAt(x, z) {
        const eps = 0.25;
        const hL = this.getHeightAt(x - eps, z);
        const hR = this.getHeightAt(x + eps, z);
        const hD = this.getHeightAt(x, z - eps);
        const hU = this.getHeightAt(x, z + eps);

        const normal = new THREE.Vector3(hL - hR, 2.0 * eps, hD - hU).normalize();
        return normal;
    }

    getSlopeAt(x, z) {
        const normal = this.getNormalAt(x, z);
        return 1.0 - normal.y;
    }

    init() {
        const meshSize = this.size + this.border * 2;
        const meshSegments = Math.round(this.segments * meshSize / this.size);
        const geo = new THREE.PlaneGeometry(meshSize, meshSize, meshSegments, meshSegments);
        geo.rotateX(-Math.PI / 2); // Lay flat on XZ plane

        const posAttr = geo.attributes.position;
        const normAttr = geo.attributes.normal;

        // Set heights and analytical continuous normals (eliminates all faceting/squares)
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i);
            const z = posAttr.getZ(i);
            const y = this.getHeightAt(x, z);
            posAttr.setY(i, y);

            const n = this.getNormalAt(x, z);
            normAttr.setXYZ(i, n.x, n.y, n.z);
        }

        posAttr.needsUpdate = true;
        normAttr.needsUpdate = true;

        // Load PBR Textures from base64 assets based on active biome
        const texLoader = new THREE.TextureLoader();
        let grassDiff, grassNor, trailDiff, rockDiff, beachDiff;

        const assets = window.GAME_ASSETS && window.GAME_ASSETS.textures ? window.GAME_ASSETS.textures : {};

        if (this.biome === 'goldshire') {
            grassDiff = texLoader.load(assets.goldshireGrassDiff || assets.meadowDiff);
            grassNor = texLoader.load(assets.goldshireGrassNor || assets.meadowNor);
            trailDiff = texLoader.load(assets.goldshireTrailDiff || assets.gravelDiff || assets.beachDiff);
            rockDiff = texLoader.load(assets.rockDiff);
            beachDiff = texLoader.load(assets.beachDiff);
        } else {
            // forest / default
            grassDiff = texLoader.load(assets.meadowDiff);
            grassNor = texLoader.load(assets.meadowNor);
            trailDiff = texLoader.load(assets.gravelDiff || assets.beachDiff);
            rockDiff = texLoader.load(assets.rockDiff);
            beachDiff = texLoader.load(assets.beachDiff);
        }

        this.textures = [grassDiff, grassNor, trailDiff, rockDiff, beachDiff];
        this.textures.forEach(tex => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = 8;
        });

        grassDiff.repeat.set(20, 20);
        trailDiff.repeat.set(18, 18);
        beachDiff.repeat.set(14, 14);
        rockDiff.repeat.set(16, 16);
        // Normal map uses mesh UVs: keep ~6 m tiles regardless of map size
        const norRepeat = 20 * meshSize / 120;
        grassNor.repeat.set(norRepeat, norRepeat);

        // Standard Material with smooth PBR blending
        this.material = new THREE.MeshStandardMaterial({
            roughness: 0.86,
            metalness: 0.04,
            flatShading: false,
            normalMap: grassNor,
            normalScale: new THREE.Vector2(0.5, 0.5)
        });

        // КРИТИЧНО для Three.js: без customProgramCacheKey движок повторно использует
        // скомпилированный шейдер первой локации для всех последующих!
        this.material.customProgramCacheKey = () => `lakeside_terrain_${this.biome}_${this.segments}`;

        const biomeId = (this.biome === 'goldshire') ? 1.0 : ((this.biome === 'volcanic') ? 2.0 : 0.0);

        this.material.onBeforeCompile = (shader) => {
            shader.uniforms.uGrassDiff = { value: grassDiff };
            shader.uniforms.uTrailDiff = { value: trailDiff };
            shader.uniforms.uRockDiff = { value: rockDiff };
            shader.uniforms.uBeachDiff = { value: beachDiff };
            shader.uniforms.uBiome = { value: biomeId };

            shader.vertexShader = `
                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;
                ${shader.vertexShader}
            `;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
                vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
                `
            );

            shader.fragmentShader = `
                uniform sampler2D uGrassDiff;
                uniform sampler2D uTrailDiff;
                uniform sampler2D uRockDiff;
                uniform sampler2D uBeachDiff;
                uniform float uBiome;

                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;
                ${shader.fragmentShader}
            `;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                vec2 uvShore = vWorldPosition.xz * 0.12;
                vec2 uvGrass = vWorldPosition.xz * 0.16;
                vec2 uvTrail = vWorldPosition.xz * 0.18;
                vec2 uvRock  = vWorldPosition.xz * 0.14;

                vec4 colBeach = texture2D(uBeachDiff, uvShore);
                vec4 colGrass = texture2D(uGrassDiff, uvGrass);
                vec4 colTrail = texture2D(uTrailDiff, uvTrail);
                vec4 colRock  = texture2D(uRockDiff, uvRock);

                // Shore weight: highest near water level Y in [-0.5, 0.8]
                float shoreWeight = 1.0 - smoothstep(0.12, 0.85, vWorldPosition.y);

                // Rocky outcrop weight: moderate slope (normal.y < 0.84)
                float cliffWeight = 1.0 - smoothstep(0.68, 0.86, vWorldNormal.y);

                vec3 terrainColor;

                if (uBiome > 0.5 && uBiome < 1.5) {
                    // === BIOME: GOLDSHIRE (Poly Haven High-Res Scanned Terrain) ===
                    // Плавная извилистая дорога от портала (X~50, Z~6) к озеру (X~2, Z~4)
                    float roadCurveZ = 5.2 + sin(vWorldPosition.x * 0.072) * 3.6;
                    float roadDist = abs(vWorldPosition.z - roadCurveZ);
                    float roadMask = 1.0 - smoothstep(1.6, 3.8, roadDist);
                    roadMask *= smoothstep(0.0, 5.0, vWorldPosition.x);
                    roadMask *= 1.0 - smoothstep(49.0, 53.0, vWorldPosition.x);

                    // Смешивание сочной травы и грунтовой дороги из Poly Haven
                    vec3 baseCol = mix(colGrass.rgb, colTrail.rgb, roadMask * 0.95);

                    // Золотистый песок у озера
                    terrainColor = mix(baseCol, colBeach.rgb, shoreWeight);

                    // Скальные выходы на крутых склонах
                    terrainColor = mix(terrainColor, colRock.rgb, cliffWeight * 0.80);

                    // Насыщенность и контраст Poly Haven PBR
                    terrainColor = pow(terrainColor, vec3(1.10));
                } else if (uBiome > 1.5) {
                    // === BIOME: VOLCANIC (Future Extensibility) ===
                    vec3 ashCol = colRock.rgb * 0.35;
                    vec3 lavaGlow = vec3(1.0, 0.35, 0.05);
                    float lavaCracks = smoothstep(0.85, 0.98, sin(vWorldPosition.x * 0.25) * cos(vWorldPosition.z * 0.25));
                    terrainColor = mix(ashCol, lavaGlow, lavaCracks * 0.85);
                    terrainColor = mix(terrainColor, colRock.rgb * 0.5, cliffWeight);
                } else {
                    // === BIOME: FOREST (Classic Meadow) ===
                    terrainColor = mix(colGrass.rgb, colBeach.rgb, shoreWeight);
                    terrainColor = mix(terrainColor, colRock.rgb, cliffWeight * 0.65);
                    terrainColor = pow(terrainColor, vec3(1.05));
                }

                // Shoreline moisture darkening right at water boundary
                if (vWorldPosition.y < 0.25 && vWorldPosition.y > -0.4) {
                    terrainColor *= 0.85;
                }

                // Компенсация яркого освещения сцены (sun 1.45 + hemi 0.85 = 2.30x)
                // Предотвращает выгорание и белёсый засвет земли
                float macroVar = 0.62 + sin(vWorldPosition.x * 0.045) * cos(vWorldPosition.z * 0.045) * 0.05;
                terrainColor *= macroVar;

                diffuseColor = vec4(terrainColor, 1.0);
                `
            );
        };

        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = false;
        this.scene.add(this.mesh);
    }

    // Textures bound via custom uniforms are not reachable from material properties
    dispose() {
        (this.textures || []).forEach(t => t.dispose());
    }
}

window.LakesideTerrain = LakesideTerrain;
