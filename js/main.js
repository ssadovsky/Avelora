/**
 * Avelora - Diablo-style Medieval RPG Core Engine
 *
 * PAUSE & GAME TIME (важно для будущих систем: бои, баффы, кулдауны, спавн):
 * - Вся игровая логика двигается ТОЛЬКО через `delta` из animate() или через
 *   `this.gameTime` (секунды игрового времени, не идут во время паузы).
 * - НЕ используйте Date.now()/performance.now()/setTimeout/setInterval для игровых
 *   таймеров — они продолжат тикать на паузе. Вместо этого:
 *     const id = game.setGameTimeout(() => {...}, 2.5); // секунды игрового времени
 *     game.clearGameTimeout(id);
 * - Состояние паузы: game.isPaused; события window 'game:pause' / 'game:resume'.
 *
 * LOCATIONS (world_data.js):
 * - Всё, что относится к локации (рельеф, объекты, маркеры проходов), добавляется в
 *   `this.locationRoot` и полностью освобождается при переходе (teardownLocation).
 * - Персонаж, камера, свет и вода живут всю сессию.
 * - Переход: game.changeLocation('lakeLand', 'fromForest') или вход в зону `exits`.
 * - Стартовая локация: window.START_LOCATION, для теста — index.html#lakeLand
 *
 * ITEMS / HOTBAR / SKILLS (CLAUDE.md §7b): per-character state — game_state.js
 * (`this.gameState`), pickups & props — world_objects.js (`this.worldObjects`,
 * per location), skills & VFX — skills.js (`this.skills`), hotbar/inventory/
 * skills panels — ui_hotbar.js (`this.ui`). main.js only wires them in.
 *
 * COMBAT / CREATURES / HARVEST (CLAUDE.md §7c): player HP, death & melee —
 * combat.js (`this.combat`, session-wide); creatures of the location —
 * creatures.js (`this.creatures`); tree chopping & regrow — harvest.js
 * (`this.harvest`). Click priority: HUD > creature > item pile > tree > ground.
 * `gameState.playTime` (played seconds, the respawn/regrow clock) advances here.
 */

// HUD elements that must not trigger ground clicks / camera gestures
const UI_SELECTOR = '#hud-top-left, #compass-btn, #skill-bar, #inventory-panel, #skills-panel, #hero-panel, #quests-panel, #potion-modal, .micromenu-dock, .micromenu-container, #item-tooltip, #quantity-modal, #pause-overlay, #character-select-overlay, #hp-bar, #death-overlay';
window.AVELORA_UI_SELECTOR = UI_SELECTOR; // ui_hotbar.js: "released over the world?" (drop from the bag)

// Real-time (not game-time) interval for the save-progress heartbeat. This is
// persistence bookkeeping, not gameplay simulation, so it's exempt from the
// "never use setInterval for gameplay timing" rule (CLAUDE.md §Pause Rule) —
// saving is harmless whether or not the game happens to be paused.
const AUTOSAVE_INTERVAL_MS = 20000;

// Sun offset relative to the camera target (keeps shadow direction stable anywhere on the map)
const SUN_OFFSET = new THREE.Vector3(38, 48, 32);

// Pathfinding grid resolution (meters per cell)
const NAV_CELL_SIZE = 0.75;

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

class AveloraGame {
    constructor() {
        this.container = document.getElementById('game-container');
        this.loadingEl = document.getElementById('loading-overlay');
        this.coordsEl = document.getElementById('hud-coords');

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.sunLight = null;

        this.terrain = null;
        this.water = null;
        this.environment = null;
        this.pathfinder = null;
        this.character = null;
        this.currentCharacterConfig = null; // CHARACTER_CATALOG entry of whoever is currently playing
        this.autosaveTimer = null;
        this.gameState = null;     // game_state.js CharacterState of the current character (inventory, hotbar, ...)
        this.worldObjects = null;  // world_objects.js: pickups/props of the current location
        this.skills = null;        // skills.js: skill casting + VFX (session-wide)
        this.ui = null;            // ui_hotbar.js: hotbar, inventory & skills panels
        this.combat = null;        // combat.js: player HP / death / melee (session-wide)
        this.creatures = null;     // creatures.js: creatures of the current location
        this.harvest = null;       // harvest.js: tree chopping / regrow of the current location
        this.map = null;           // map.js: location mini-map (M key)
        // Last pointer position over the WORLD (not over HUD) — skills aim here.
        // type 'touch' -> skills fire straight ahead instead (see skills.js).
        this.lastPointer = { x: 0, y: 0, type: 'none', valid: false };

        // Current location
        this.location = null;
        this.locationRoot = null;
        this.exits = [];
        this.isTransitioning = false;
        this.labelsEl = document.getElementById('world-labels');
        this.bannerEl = document.getElementById('location-banner');
        this.tooltipEl = document.getElementById('object-tooltip');

        this.raycaster = new THREE.Raycaster();
        // Layer 1 is where environment.js puts dense/cheap-to-skip foliage
        // (reeds/grass/ferns/dandelions, via the `reflect: false` opt) so the
        // water reflection's mirror camera — a bare THREE.PerspectiveCamera in
        // lib_js/Water.js, default layer-0-only, never touched — skips them for
        // free. The raycaster needs layer 1 enabled too, or hover/interaction
        // with reeds/ferns (they're in HOVER_KINDS) would silently stop working.
        this.raycaster.layers.enable(1);
        this.mouse = new THREE.Vector2();

        // Diablo Camera Settings
        this.cameraDistance = 24.0;
        this.minDistance = 5.0; // closer zoom for inspecting characters
        this.maxDistance = 42.0;
        this.cameraAngle = Math.PI * 0.25; // 45 deg yaw
        // Elevation (pitch) is no longer a fixed constant — it eases between
        // pitchZoomedIn (flatter, more cinematic) at minDistance and
        // pitchZoomedOut (today's classic top-down Diablo angle) at
        // maxDistance, smoothly following the current zoom level. See
        // updateCameraPosition()'s targetPitch calculation.
        this.pitchZoomedIn = 0.3491; // 20 deg elevation at max zoom-in (-5 deg lower, as requested)
        this.pitchZoomedOut = 0.88; // ~50 deg elevation at max zoom-out (unchanged default)
        this.cameraPitch = this.pitchZoomedOut; // current, eased value — see updateCameraPosition()
        // Exponential-smoothing rate for the pitch ease, in 1/seconds (higher = snappier).
        // Applied frame-rate-independently via (1 - exp(-k*delta)), unlike the older fixed
        // per-frame lerp factors elsewhere in this method (those were tuned assuming ~60fps
        // and left as-is; this one is delta-based so the ease speed doesn't drift with FPS).
        this.pitchEaseRate = 4.0;
        this.cameraTarget = new THREE.Vector3(15, 0, 8);
        this.isRightMouseDown = false;
        this.lastMouseX = 0;

        this.clock = new THREE.Clock();
        this.clickMarkers = [];

        // Game time & pause state
        this.isReady = false;      // true after character/world finished loading
        this.isPaused = false;
        this.gameTime = 0;         // seconds of unpaused gameplay
        this.timers = [];          // game-time timers (frozen while paused)
        this.nextTimerId = 1;
        this.needsRender = false;  // one-off redraw while paused (e.g. after resize)

        this.init();
    }

    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xa2c0cc);
        this.scene.fog = new THREE.FogExp2(0xa2c0cc, 0.012);

        // Camera setup
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 600);
        // Enable layer 1 (in addition to the default layer 0) so the main
        // camera keeps seeing dense foliage that environment.js moved to
        // layer 1 to hide it from the water reflection's mirror camera —
        // see the comment on this.raycaster.layers.enable(1) above.
        this.camera.layers.enable(1);
        this.updateCameraPosition(true);

        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.15;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        // Lighting
        this.setupLighting();

        // Water lives for the whole session (reconfigured per location)
        this.water = new LakesideWater(this.scene, this.sunLight, { terrain: { waterBody: { type: 'none' } } });

        // Click Indicator Ring Geometry & Material
        const ringGeo = new THREE.RingGeometry(0.3, 0.45, 32);
        ringGeo.rotateX(-Math.PI / 2);
        this.markerGeo = ringGeo;

        // Items / skills / hotbar systems (session-wide)
        this.skills = new AveloraSkillSystem(this);
        this.ui = new AveloraHotbarUI(this);
        this.combat = window.AveloraCombat ? new AveloraCombat(this) : null;
        this.map = window.AveloraMap ? new AveloraMap(this) : null;

        // Event Listeners
        this.setupEvents();

        // Animation Loop
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);

        this.bootstrap().catch(err => console.error('[Avelora] start failed', err));
    }

    // ---------------------------------------------------------------
    // Character selection & save-driven bootstrap
    // ---------------------------------------------------------------
    /** First thing that runs: exactly one valid save -> load it straight away, otherwise ask. */
    async bootstrap() {
        const saves = (window.AveloraSave && window.AveloraSave.listValidSaves()) || [];
        if (saves.length === 1) {
            const { character, save } = saves[0];
            await this.startGame(character, { locationId: save.locationId, position: { x: save.x, z: save.z, r: save.r } });
        } else {
            this.showCharacterSelect(false);
        }
    }

    /** allowCancel: true when opened from the pause menu (an existing game session to go back to). */
    showCharacterSelect(allowCancel) {
        this.isPaused = true; // belt-and-braces: animate() should touch nothing while this is up
        this.renderCharacterCards(allowCancel);
        const overlay = document.getElementById('character-select-overlay');
        if (overlay) overlay.classList.remove('hidden');
        this.hideLoading();
    }

    hideCharacterSelect() {
        const overlay = document.getElementById('character-select-overlay');
        if (overlay) overlay.classList.add('hidden');
    }

    renderCharacterCards(allowCancel) {
        const grid = document.getElementById('charselect-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const saves = (window.AveloraSave && window.AveloraSave.listValidSaves()) || [];
        const saveByCharId = {};
        saves.forEach(entry => { saveByCharId[entry.character.id] = entry.save; });

        (window.CHARACTER_CATALOG || []).forEach(char => {
            const save = saveByCharId[char.id] || null;

            const card = document.createElement('div');
            card.className = 'charcard';

            const icon = document.createElement('div');
            icon.className = 'charcard-icon';
            icon.textContent = char.icon;
            card.appendChild(icon);

            const name = document.createElement('div');
            name.className = 'charcard-name';
            name.textContent = char.name;
            card.appendChild(name);

            const cls = document.createElement('div');
            cls.className = 'charcard-class';
            cls.textContent = char.className;
            card.appendChild(cls);

            const progress = document.createElement('div');
            progress.className = 'charcard-progress';
            if (save) {
                const loc = window.LOCATIONS && window.LOCATIONS[save.locationId];
                progress.textContent = 'Прогресс: ' + (loc ? loc.name : save.locationId);
            } else {
                progress.textContent = 'Нет сохранения';
            }
            card.appendChild(progress);

            const mainBtn = document.createElement('button');
            mainBtn.type = 'button';
            mainBtn.className = 'pause-btn primary';
            mainBtn.textContent = save ? 'Продолжить' : 'Новая игра';
            mainBtn.addEventListener('click', () => this.chooseCharacter(char, save));
            card.appendChild(mainBtn);

            if (save) {
                const trashBtn = document.createElement('button');
                trashBtn.type = 'button';
                trashBtn.className = 'charcard-trash';
                trashBtn.title = 'Удалить сохранение';
                trashBtn.setAttribute('aria-label', 'Удалить сохранение');
                trashBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
                trashBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Удалить сохранение для персонажа «${char.name}»?`)) return;
                    window.AveloraSave.deleteSave(char.id);
                    if (this.gameState && this.gameState.characterId === char.id) this.gameState.discard();
                    this.renderCharacterCards(allowCancel);
                });
                card.appendChild(trashBtn);

                const newGameBtn = document.createElement('button');
                newGameBtn.type = 'button';
                newGameBtn.className = 'charcard-newgame';
                newGameBtn.textContent = 'Начать заново';
                newGameBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Удалить сохранение и начать заново за «${char.name}»?`)) return;
                    window.AveloraSave.deleteSave(char.id); // also clears avelora_state_<id>
                    if (this.gameState && this.gameState.characterId === char.id) this.gameState.discard();
                    this.chooseCharacter(char, null);
                });
                card.appendChild(newGameBtn);
            }

            grid.appendChild(card);
        });

        const backBtn = document.getElementById('charselect-back');
        if (backBtn) backBtn.style.display = allowCancel ? '' : 'none';
    }

    async chooseCharacter(char, save) {
        this.hideCharacterSelect();
        const opts = save
            ? { locationId: save.locationId, position: { x: save.x, z: save.z, r: save.r } }
            : {};
        await this.startGame(char, opts);
    }

    // ---------------------------------------------------------------
    // Locations
    // ---------------------------------------------------------------
    getStartLocationId() {
        const locs = window.LOCATIONS || {};
        // Dev shortcut: index.html#lakeLand or index.html#loc=lakeLand
        const hash = decodeURIComponent((location.hash || '').replace(/^#(loc=)?/, ''));
        if (hash && locs[hash]) return hash;
        if (window.START_LOCATION && locs[window.START_LOCATION]) return window.START_LOCATION;
        return Object.keys(locs)[0];
    }

    resolveSpawn(loc, spawnId) {
        const spawns = loc.spawns || {};
        return (spawnId && spawns[spawnId]) || spawns.default || loc.playerSpawn || { x: 0, z: 0 };
    }

    /**
     * (Re)starts the game for a chosen character. Called once at boot, and
     * again whenever the player switches character or starts a new game
     * from the pause menu — in that case it first tears down whatever
     * location/character is currently live, so it's always safe to call.
     *
     * opts: { locationId?, spawnId?, position?: {x,z,r} } — from a save
     * (locationId + exact position) or empty for a brand new game (world's
     * default start location + default spawn).
     */
    async startGame(characterConfig, opts) {
        opts = opts || {};
        this.showLoading('Avelora', characterConfig.name ? `Входит ${characterConfig.name}...` : 'Вход в средневековый мир...');
        await nextFrame();

        // Persist the OUTGOING character's progress before tearing anything
        // down — startGame() is also the character-switch/new-game entry
        // point, and without this the previous character's movement since
        // the last autosave tick (up to AUTOSAVE_INTERVAL_MS) was silently lost.
        this.saveProgress();
        if (this.gameState) this.gameState.save();

        // Clean slate if a previous character/location is still live (switch/new game)
        this.stopAutosave();
        if (this.locationRoot) this.teardownLocation();
        if (this.character) { this.character.dispose(); this.character = null; }
        if (this.skills) { this.skills.clearAll(); this.skills.resetCooldowns(); }

        this.currentCharacterConfig = characterConfig;
        // Per-character inventory/hotbar/pickups (separate key from the position save)
        this.gameState = window.AveloraState ? window.AveloraState.load(characterConfig.id) : null;

        const startId = (opts.locationId && window.LOCATIONS[opts.locationId]) ? opts.locationId : this.getStartLocationId();
        const defaultSpawn = this.buildLocation(startId, opts.spawnId || null);
        let spawn = opts.position || defaultSpawn;

        // Auto-rescue: check if character coordinates are stuck inside mountains/cliffs/water/edge (e.g. from an older map save)
        let rescued = false;
        if (this.pathfinder && !this.pathfinder.isWalkableWorld(spawn.x, spawn.z)) {
            console.warn(`[Avelora] Spawn position (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) is impassable. Rescuing to safe terrain...`);
            const safe = this.pathfinder.findNearestWalkableWorld(spawn.x, spawn.z, 120);
            if (safe) {
                spawn = { x: safe.x, z: safe.z, r: spawn.r || 0 };
            } else {
                spawn = defaultSpawn;
            }
            rescued = true;
        }

        const characterLoaded = new Promise(resolve => {
            this.character = new MedievalCharacter(this.scene, this.terrain, characterConfig, () => resolve());
        });
        this.character.teleport(spawn.x, spawn.z, spawn.r);
        this.cameraTarget.copy(this.character.position);
        this.updateCameraPosition(true);

        await Promise.all([characterLoaded, this.environment.ready, this.worldObjects ? this.worldObjects.ready : null,
            this.creatures ? this.creatures.ready : null, this.harvest ? this.harvest.ready : null]);
        if (this.combat) this.combat.bindCharacter(characterConfig); // full HP, no fight
        if (this.ui) {
            this.ui.bindCharacter(this.gameState);
            this.ui.applyEquipment();
        }
        if (this.skills && this.skills.forCharacter(characterConfig.id).length) this.skills.prewarm();
        await nextFrame();

        this.clock.getDelta(); // don't count select/loading time as game time
        this.isTransitioning = false;
        this.isPaused = false;
        this.isReady = true;
        this.hideLoading();
        this.showLocationBanner(this.location.name);

        // startGame() can be entered while isPaused was already true (boot's
        // character-select, or "Выбор персонажа"/"Начать заново" from the
        // pause menu) — in all of those the pause overlay's 'open' class was
        // left on screen. Setting isPaused above doesn't go through
        // setPaused(), so close it explicitly here too, otherwise it stays
        // visually stuck open (not dismissed by "Продолжить", needing an
        // extra Escape) even though the game underneath is now unpaused.
        if (this.pauseOverlay) {
            this.pauseOverlay.classList.remove('open');
            this.pauseOverlay.setAttribute('aria-hidden', 'true');
        }

        this.saveProgress();
        this.scheduleAutosave();
    }

    // ---------------------------------------------------------------
    // Save/progress (per character — see save.js)
    // ---------------------------------------------------------------
    /** Persists the current character's location + exact position. No-op until a character is playing. */
    saveProgress() {
        if (!this.currentCharacterConfig || !this.character || !this.location || !window.AveloraSave) return;
        window.AveloraSave.writeSave(this.currentCharacterConfig.id, {
            locationId: this.location.id,
            x: this.character.position.x,
            z: this.character.position.z,
            r: this.character.currentRotation
        });
    }

    scheduleAutosave() {
        this.stopAutosave();
        this.autosaveTimer = setInterval(() => this.saveProgress(), AUTOSAVE_INTERVAL_MS);
    }

    stopAutosave() {
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
            this.autosaveTimer = null;
        }
    }

    /** Builds terrain, navigation, water, objects and exits of a location. Returns spawn point. */
    buildLocation(id, spawnId) {
        const loc = window.LOCATIONS[id];
        if (!loc) throw new Error(`Unknown location "${id}"`);
        if (!loc.id) loc.id = id;
        window.CURRENT_LOCATION = loc;
        this.location = loc;

        const t = loc.terrain || {};
        const sizeX = t.sizeX || (Array.isArray(t.size) ? t.size[0] : t.size) || 120;
        const sizeZ = t.sizeZ || (Array.isArray(t.size) ? t.size[1] : t.size) || 120;

        // Sky & fog
        const atm = loc.atmosphere || {};
        const skyColor = new THREE.Color(atm.sky !== undefined ? atm.sky : 0xc6dbe3);
        const fogColor = new THREE.Color(atm.fogColor !== undefined ? atm.fogColor : (atm.sky !== undefined ? atm.sky : 0xc6dbe3));
        this.scene.background = fogColor;
        this.scene.fog = new THREE.FogExp2(fogColor.getHex(), atm.fogDensity !== undefined ? atm.fogDensity : 0.0065);
        this.buildSkyDome(atm);

        this.locationRoot = new THREE.Group();
        this.locationRoot.name = `location:${id}`;
        this.scene.add(this.locationRoot);

        const gridX = Math.round(sizeX / NAV_CELL_SIZE);
        const gridZ = Math.round(sizeZ / NAV_CELL_SIZE);

        this.terrain = new LakesideTerrain(this.locationRoot, {}, loc);
        this.pathfinder = new DiabloPathfinder(this.terrain, gridX, gridZ, sizeX, sizeZ);
        this.water.setLocation(loc);
        this.waterfall = (loc.waterfalls && loc.waterfalls.length && window.AveloraWaterfall)
            ? new AveloraWaterfall(this.locationRoot, loc.waterfalls[0], this.terrain, this.pathfinder)
            : null;
        this.environment = new LakesideEnvironment(this.locationRoot, this.terrain, this.pathfinder, loc);
        this.worldObjects = window.AveloraWorldObjects ? new AveloraWorldObjects(this, loc) : null;
        this.creatures = window.AveloraCreatures ? new AveloraCreatures(this, loc) : null;
        this.harvest = window.AveloraHarvest ? new AveloraHarvest(this, loc) : null;
        this.buildExits(loc);

        return this.resolveSpawn(loc, spawnId);
    }

    /** Releases everything that belongs to the current location. */
    teardownLocation() {
        this.hideObjectTooltip();
        this.exits.forEach(e => { if (e.labelEl) e.labelEl.remove(); });
        this.exits = [];

        if (this.waterfall) { this.waterfall.dispose(); this.waterfall = null; }
        if (this.skills) this.skills.clearAll(); // no projectile/impact survives into the next location
        if (this.combat) { this.combat.cancel(); this.combat.clearTarget(); }
        if (this.map) this.map.clearAll();        // close map panel when leaving location
        if (this.creatures) { this.creatures.dispose(); this.creatures = null; }
        if (this.harvest) { this.harvest.dispose(); this.harvest = null; }
        if (this.worldObjects) { this.worldObjects.dispose(); this.worldObjects = null; }
        if (this.environment) this.environment.dispose();
        if (this.terrain && this.terrain.dispose) this.terrain.dispose();

        // Click markers live in the scene root
        this.clickMarkers.forEach(m => { this.scene.remove(m.mesh); m.mesh.material.dispose(); });
        this.clickMarkers = [];

        if (this.locationRoot) {
            const geos = new Set();
            const mats = new Set();
            this.locationRoot.traverse(o => {
                if (o.geometry) geos.add(o.geometry);
                if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
            });
            mats.forEach(m => {
                Object.keys(m).forEach(k => { if (m[k] && m[k].isTexture) m[k].dispose(); });
                m.dispose();
            });
            geos.forEach(g => g.dispose());
            this.scene.remove(this.locationRoot);
        }

        this.locationRoot = null;
        this.environment = null;
        this.terrain = null;
        this.pathfinder = null;
    }

    buildSkyDome(atm = {}) {
        if (this.skyDome) {
            this.scene.remove(this.skyDome);
            this.skyDome.geometry.dispose();
            this.skyDome.material.dispose();
            this.skyDome = null;
        }
        const skyGeo = new THREE.SphereGeometry(460, 32, 16);
        const topHex = atm.skyTop !== undefined ? atm.skyTop : 0x4a8fc9;
        const btmHex = atm.sky !== undefined ? atm.sky : 0xc6dbe3;
        const skyMat = new THREE.ShaderMaterial({
            uniforms: {
                topColor: { value: new THREE.Color(topHex) },
                bottomColor: { value: new THREE.Color(btmHex) },
                offset: { value: 14.0 },
                exponent: { value: 0.55 }
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPosition.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 bottomColor;
                uniform float offset;
                uniform float exponent;
                varying vec3 vWorldPosition;
                void main() {
                    float h = normalize(vWorldPosition + offset).y;
                    gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
                }
            `,
            side: THREE.BackSide,
            depthWrite: false
        });
        this.skyDome = new THREE.Mesh(skyGeo, skyMat);
        this.skyDome.name = 'skyDome';
        this.scene.add(this.skyDome);
    }

    /** Travel to another location (loading screen, rebuild, place player at spawn). */
    async changeLocation(targetId, spawnId) {
        if (this.isTransitioning) return;
        const target = window.LOCATIONS && window.LOCATIONS[targetId];
        if (!target) {
            console.warn(`[Avelora] exit leads to unknown location "${targetId}"`);
            return;
        }

        this.isTransitioning = true;
        this.isReady = false;
        this.isRightMouseDown = false;
        this.setInventoryOpen(false);
        if (this.ui) this.ui.setSkillsOpen(false);
        if (this.character) this.character.stopMovement();

        this.showLoading(target.name || targetId, 'Дорога ведёт дальше…');
        if (this.gameState) this.gameState.save(); // persists playTime (the respawn/regrow clock)
        await nextFrame();
        await nextFrame();

        this.teardownLocation();
        let spawn = this.buildLocation(targetId, spawnId);
        if (this.pathfinder && !this.pathfinder.isWalkableWorld(spawn.x, spawn.z)) {
            const safe = this.pathfinder.findNearestWalkableWorld(spawn.x, spawn.z, 120);
            if (safe) spawn = { x: safe.x, z: safe.z, r: spawn.r || 0 };
        }

        this.character.setTerrain(this.terrain);
        this.character.teleport(spawn.x, spawn.z, spawn.r);
        this.cameraTarget.copy(this.character.position);
        this.updateCameraPosition(true);

        await Promise.all([this.environment.ready, this.worldObjects ? this.worldObjects.ready : null,
            this.creatures ? this.creatures.ready : null, this.harvest ? this.harvest.ready : null]);
        await nextFrame();

        this.clock.getDelta(); // don't count loading time as game time
        this.isTransitioning = false;
        this.isReady = true;
        this.hideLoading();
        this.showLocationBanner(this.location.name);
        this.saveProgress();
        window.dispatchEvent(new CustomEvent('game:location', { detail: { id: targetId, spawn: spawnId } }));
    }

    // ---------------------------------------------------------------
    // Exits (zones that lead to other locations)
    // ---------------------------------------------------------------
    buildExits(loc) {
        (loc.exits || []).forEach(ex => {
            const radius = ex.radius || 3;

            // Sit the marker directly on the terrain surface at exit center
            const y = this.terrain.getHeightAt(ex.x, ex.z) + 0.04;

            const group = new THREE.Group();
            group.position.set(ex.x, y, ex.z);

            const ringGeo = new THREE.RingGeometry(radius * 0.82, radius, 48);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xffd98a, transparent: true, opacity: 0.55,
                depthWrite: false, blending: THREE.AdditiveBlending
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            group.add(ring);

            // Soft vertical light column (fades upward)
            const pillarGeo = new THREE.CylinderGeometry(radius * 0.9, radius * 0.9, 3.2, 40, 1, true);
            pillarGeo.translate(0, 1.6, 0);
            const pillarMat = new THREE.ShaderMaterial({
                uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffd98a) } },
                vertexShader: `
                    varying float vH;
                    void main() {
                        vH = position.y / 3.2;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }`,
                fragmentShader: `
                    uniform float uTime;
                    uniform vec3 uColor;
                    varying float vH;
                    void main() {
                        float a = (1.0 - vH) * (1.0 - vH) * (0.22 + 0.08 * sin(uTime * 2.0));
                        gl_FragColor = vec4(uColor, a);
                    }`,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending
            });
            const pillar = new THREE.Mesh(pillarGeo, pillarMat);
            group.add(pillar);

            this.locationRoot.add(group);

            let labelEl = null;
            if (this.labelsEl) {
                labelEl = document.createElement('div');
                labelEl.className = 'world-label';
                const targetLoc = window.LOCATIONS[ex.to];
                labelEl.textContent = ex.label || (targetLoc && targetLoc.name) || ex.to;
                this.labelsEl.appendChild(labelEl);
            }

            this.exits.push({
                data: ex, radius, y, group, ring, pillarMat, labelEl,
                armed: false // armed once the player has been outside the zone
            });
        });
    }

    updateExits(delta) {
        if (!this.character) return;
        if (this.combat && this.combat.isDead) return; // a corpse doesn't travel
        const p = this.character.position;

        for (const ex of this.exits) {
            // Pulse (game time => frozen on pause)
            ex.pillarMat.uniforms.uTime.value = this.gameTime;
            ex.ring.material.opacity = 0.45 + Math.sin(this.gameTime * 2.4) * 0.15;

            const dx = p.x - ex.data.x;
            const dz = p.z - ex.data.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist > ex.radius + 0.5) ex.armed = true;
            if (ex.armed && dist < ex.radius * 0.8) {
                this.changeLocation(ex.data.to, ex.data.spawn);
                return;
            }
        }
    }

    updateWorldLabels() {
        if (!this.exits.length) return;
        const w = window.innerWidth, h = window.innerHeight;
        const v = new THREE.Vector3();
        for (const ex of this.exits) {
            if (!ex.labelEl) continue;
            v.set(ex.data.x, ex.y + 3.6, ex.data.z).project(this.camera);
            const visible = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
            ex.labelEl.style.display = visible ? 'block' : 'none';
            if (visible) {
                ex.labelEl.style.transform =
                    `translate(-50%, -100%) translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px)`;
            }
        }
    }

    // ---------------------------------------------------------------
    // Loading screen & location banner (UI only)
    // ---------------------------------------------------------------
    showLoading(title, subtitle) {
        if (!this.loadingEl) return;
        const t = this.loadingEl.querySelector('.loading-title');
        const s = this.loadingEl.querySelector('.loading-subtitle');
        if (t) t.textContent = title;
        if (s) s.textContent = subtitle || '';
        clearTimeout(this.loadingHideTimer);
        this.loadingEl.style.display = 'flex';
        this.loadingEl.classList.remove('hidden');
    }

    hideLoading() {
        if (!this.loadingEl) return;
        this.loadingEl.classList.add('hidden');
        this.loadingHideTimer = setTimeout(() => { this.loadingEl.style.display = 'none'; }, 600);
    }

    showLocationBanner(name) {
        if (!this.bannerEl || !name) return;
        this.bannerEl.textContent = name;
        this.bannerEl.classList.remove('show');
        void this.bannerEl.offsetWidth; // restart CSS animation
        this.bannerEl.classList.add('show');
    }

    setupLighting() {
        // Hemisphere ambient lighting: cool sky, warm earthy bounce
        const hemiLight = new THREE.HemisphereLight(0x89b8d6, 0x483d31, 0.85);
        hemiLight.position.set(0, 50, 0);
        this.scene.add(hemiLight);

        // Directional Sun Light casting soft shadows
        this.sunLight = new THREE.DirectionalLight(0xfff6dc, 1.45);
        this.sunLight.position.set(38, 48, 32);
        this.sunLight.castShadow = true;

        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 10;
        this.sunLight.shadow.camera.far = 140;

        const d = 42;
        this.sunLight.shadow.camera.left = -d;
        this.sunLight.shadow.camera.right = d;
        this.sunLight.shadow.camera.top = d;
        this.sunLight.shadow.camera.bottom = -d;
        this.sunLight.shadow.bias = -0.0004;

        this.scene.add(this.sunLight);
    }

    setupEvents() {
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.needsRender = true; // resize clears the canvas; redraw even if paused
        });

        // Pause menu: Escape toggles, "Продолжить" / ☰ button as alternatives
        this.pauseOverlay = document.getElementById('pause-overlay');
        this.pauseResumeBtn = document.getElementById('pause-resume');
        window.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            if (e.key === 'Escape' || e.code === 'Escape') {
                e.preventDefault();
                // Escape закрывает карту если она открыта
                if (this.map && this.map.isOpen) { this.map.close(); return; }
                // Escape closes open windows first (bag + skills + hero + quests + micromenu + potion), otherwise toggles pause
                const skillsOpen = this.ui && this.ui.isSkillsOpen();
                const heroOpen = this.ui && this.ui.isHeroOpen && this.ui.isHeroOpen();
                const questsOpen = this.ui && this.ui.isQuestsOpen && this.ui.isQuestsOpen();
                const microMenuOpen = this.ui && this.ui.isMicroMenuOpen && this.ui.isMicroMenuOpen();
                const potionOpen = this.ui && this.ui.isPotionOpen && this.ui.isPotionOpen();
                if (!this.isPaused && (this.isInventoryOpen || skillsOpen || heroOpen || questsOpen || microMenuOpen || potionOpen)) {
                    if (this.isInventoryOpen) this.setInventoryOpen(false);
                    if (skillsOpen) this.ui.setSkillsOpen(false);
                    if (heroOpen) this.ui.setHeroOpen(false);
                    if (questsOpen) this.ui.setQuestsOpen(false);
                    if (microMenuOpen) this.ui.closeMicroMenu();
                    if (potionOpen) this.ui.closePotionModal();
                } else if (this.isPaused && this.pauseSubview && this.pauseSubview !== 'main') {
                    this.showPausePanel('main');
                } else {
                    this.togglePause();
                }
            } else if (e.code === 'KeyI') { // physical key: works in RU layout too (Ш)
                if (!this.isPaused && this.isReady) this.toggleInventory();
            } else if (e.code === 'Tab') {
                // Tab: cycle through nearest living creatures in front of the character
                e.preventDefault();
                if (!this.isPaused && this.isReady && this.combat && !this.combat.isDead) {
                    this.combat.tabTarget();
                }
            } else if (e.code === 'KeyM') {
                e.preventDefault();
                if (!this.isReady || !this.map) return;
                // При открытом меню паузы карта по M не открывается
                const isMenuOpen = this.pauseOverlay && this.pauseOverlay.classList.contains('open');
                if (isMenuOpen) return;

                if (this.map.isOpen) {
                    this.map.close();
                } else if (!this.isPaused) {
                    this.map.open();
                }
            }
        });
        if (this.pauseResumeBtn) {
            this.pauseResumeBtn.addEventListener('click', () => this.setPaused(false));
        }
        const pauseUnstuckBtn = document.getElementById('pause-unstuck-btn');
        if (pauseUnstuckBtn) {
            pauseUnstuckBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this.character || !this.location) return;
                const curPos = this.character.position;
                let safe = null;
                if (this.pathfinder) {
                    safe = this.pathfinder.findNearestWalkableWorld(curPos.x, curPos.z, 120);
                }
                const targetPos = safe || this.resolveSpawn(this.location, 'default');
                this.character.teleport(targetPos.x, targetPos.z, 0);
                this.cameraTarget.copy(this.character.position);
                this.updateCameraPosition(true);
                this.saveProgress();
                this.setPaused(false);
                this.showLocationBanner('Персонаж на безопасной тропе');
            });
        }
        const menuBtn = document.getElementById('menu-btn');
        if (menuBtn) {
            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.ui && this.ui.closeMicroMenu) this.ui.closeMicroMenu();
                if (this.ui && this.ui.closePotionModal) this.ui.closePotionModal();
                this.togglePause();
            });
        }

        // Character-select entry point: always available from the pause menu,
        // to switch characters or start a fresh game mid-session.
        const pauseCharSelectBtn = document.getElementById('pause-character-select');
        if (pauseCharSelectBtn) {
            pauseCharSelectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showCharacterSelect(true);
            });
        }
        const charSelectBackBtn = document.getElementById('charselect-back');
        if (charSelectBackBtn) {
            charSelectBackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideCharacterSelect();
                // Still mid-session (this.character survived — we never torn it
                // down), so just drop back into the paused game.
                this.setPaused(true);
            });
        }

        // Final safety net: capture progress if the tab/window closes without
        // hitting a location change or an autosave tick in between.
        window.addEventListener('beforeunload', () => {
            this.saveProgress();
            if (this.gameState) this.gameState.save(); // state is written on every change; this is only a safety net
        });

        // Pause menu sub-panels ("Управление" / "Настройки") — kept as
        // separate popups behind buttons instead of always inline, so the
        // main pause panel stays short.
        this.pausePanelMain = document.getElementById('pause-panel-main');
        this.pausePanelControls = document.getElementById('pause-panel-controls');
        this.pausePanelSettings = document.getElementById('pause-panel-settings');
        const pauseControlsBtn = document.getElementById('pause-controls-btn');
        const pauseSettingsBtn = document.getElementById('pause-settings-btn');
        const pauseControlsBack = document.getElementById('pause-controls-back');
        const pauseSettingsBack = document.getElementById('pause-settings-back');
        if (pauseControlsBtn) pauseControlsBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showPausePanel('controls'); });
        if (pauseSettingsBtn) pauseSettingsBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showPausePanel('settings'); });
        if (pauseControlsBack) pauseControlsBack.addEventListener('click', (e) => { e.stopPropagation(); this.showPausePanel('main'); });
        if (pauseSettingsBack) pauseSettingsBack.addEventListener('click', (e) => { e.stopPropagation(); this.showPausePanel('main'); });

        const pauseTabs = document.querySelectorAll('.pause-tab-btn');
        pauseTabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = tab.dataset.tab;
                pauseTabs.forEach(t => t.classList.toggle('active', t === tab));
                const contents = document.querySelectorAll('.pause-tab-content');
                contents.forEach(c => {
                    c.classList.toggle('active', c.id === `tab-controls-${target}`);
                });
            });
        });

        const resetAllBtn = document.getElementById('reset-all-data-btn');
        if (resetAllBtn) {
            resetAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.confirm('ВНИМАНИЕ: Вы действительно хотите полностью сбросить ВСЕ сохранения ВСЕХ персонажей?')) return;
                try {
                    window.localStorage.clear();
                } catch (err) {
                    console.warn('[Avelora] failed to clear localStorage', err);
                }
                alert('Все сохранения успешно удалены.');
                location.reload();
            });
        }

        // FPS counter toggle — session-only (never persisted), always off on
        // load, lives in Settings.
        this.fpsCounterEnabled = false;
        this.fpsEl = document.getElementById('fps-counter');
        const fpsToggle = document.getElementById('fps-toggle');
        if (fpsToggle) {
            fpsToggle.checked = false;
            fpsToggle.addEventListener('change', (e) => {
                this.fpsCounterEnabled = e.target.checked;
                if (this.fpsEl) {
                    this.fpsEl.style.display = this.fpsCounterEnabled ? 'block' : 'none';
                    if (!this.fpsCounterEnabled) this.fpsEl.textContent = '';
                }
                this._fpsSmoothed = undefined;
                this._fpsAccum = 0;
            });
        }

        // Inventory (stub window; does NOT pause the game, like Diablo)
        this.isInventoryOpen = false;
        this.inventoryPanel = document.getElementById('inventory-panel');
        this.inventoryBtn = document.getElementById('inventory-btn');
        if (this.inventoryBtn) {
            this.inventoryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this.isPaused && this.isReady) this.toggleInventory();
            });
        }
        const inventoryClose = document.getElementById('inventory-close');
        if (inventoryClose) {
            inventoryClose.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setInventoryOpen(false);
            });
        }

        // PC Mouse Controls (LMB: Click to Move, RMB: Drag to Rotate Camera)
        window.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') return; // Handled by touch events below
            if (this.isPaused) return;
            if (e.button === 0) {
                this.handleGroundClick(e);
            } else if (e.button === 2) {
                this.isRightMouseDown = true;
                this.lastMouseX = e.clientX;
            }
        });

        window.addEventListener('pointerup', (e) => {
            if (e.pointerType === 'touch') return;
            if (e.button === 2) {
                this.isRightMouseDown = false;
            }
        });

        window.addEventListener('pointermove', (e) => {
            // Remember where the pointer last was over the world (skills aim there);
            // over HUD elements the previous world position is kept.
            if (e.pointerType === 'touch') {
                this.lastPointer.type = 'touch';
                return;
            }
            if (!(e.target && e.target.closest && e.target.closest(UI_SELECTOR))) {
                this.lastPointer.x = e.clientX;
                this.lastPointer.y = e.clientY;
                this.lastPointer.type = 'mouse';
                this.lastPointer.valid = true;
            }
            if (this.isPaused) return;
            if (this.isRightMouseDown) {
                const deltaX = e.clientX - this.lastMouseX;
                this.cameraAngle -= deltaX * 0.007;
                this.targetCameraAngle = this.cameraAngle;
                this.lastMouseX = e.clientX;
            }
            // Hover tooltip for interactable environment objects (trees/boulders/
            // shrubs/reeds) — skip while dragging the camera, matches click-to-move
            // which is also suppressed by the drag.
            if (!this.isRightMouseDown && !(this.ui && this.ui.drag && this.ui.drag.active)) {
                this.handleHover(e);
            }
        });

        // PC Mouse Wheel Zoom
        window.addEventListener('wheel', (e) => {
            if (this.isPaused) return;
            this.cameraDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.cameraDistance + e.deltaY * 0.02));
        }, { passive: true });

        // Mobile Touch Gestures (1-finger: Tap to Move, 2-finger: Pinch Zoom & Rotate)
        this.touchStartPos = { x: 0, y: 0 };
        this.touchMoved = false;
        this.touchStartDist = 0;
        this.touchStartAngle = 0;
        this.touchInitialCamDist = this.cameraDistance;
        this.touchInitialCamAngle = this.cameraAngle;

        window.addEventListener('touchstart', (e) => {
            this.lastPointer.type = 'touch'; // skills fire straight ahead after touch input
            if (this.isPaused || e.target.closest(UI_SELECTOR)) return;
            if (e.touches.length === 1) {
                this.touchStartPos.x = e.touches[0].clientX;
                this.touchStartPos.y = e.touches[0].clientY;
                this.touchMoved = false;
            } else if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                this.touchStartDist = Math.hypot(dx, dy);
                this.touchStartAngle = Math.atan2(dy, dx);
                this.touchInitialCamDist = this.cameraDistance;
                this.touchInitialCamAngle = this.cameraAngle;
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (this.isPaused || e.target.closest(UI_SELECTOR)) return;
            if (e.touches.length === 1) {
                const dist = Math.hypot(
                    e.touches[0].clientX - this.touchStartPos.x,
                    e.touches[0].clientY - this.touchStartPos.y
                );
                if (dist > 12) {
                    this.touchMoved = true;
                }
            } else if (e.touches.length === 2) {
                e.preventDefault(); // Prevent native browser pinch zoom of page
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const currentDist = Math.hypot(dx, dy);
                const currentAngle = Math.atan2(dy, dx);

                // Pinch to Zoom
                if (this.touchStartDist > 0) {
                    const factor = this.touchStartDist / currentDist;
                    this.cameraDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.touchInitialCamDist * factor));
                }

                // Two-finger Rotation
                const deltaAngle = currentAngle - this.touchStartAngle;
                this.cameraAngle = this.touchInitialCamAngle - deltaAngle * 1.3;
                this.targetCameraAngle = this.cameraAngle;
            }
        }, { passive: false });

        window.addEventListener('touchend', (e) => {
            if (this.isPaused || e.target.closest(UI_SELECTOR)) return;
            if (e.touches.length === 0 && !this.touchMoved) {
                // Clean single tap: move character
                this.handleGroundClick({
                    clientX: this.touchStartPos.x,
                    clientY: this.touchStartPos.y,
                    target: e.target
                });
            }
        });

        // Compass Click: Reset to North
        const compassBtn = document.getElementById('compass-btn');
        if (compassBtn) {
            compassBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.isPaused) return;
                this.resetCameraToNorth();
            });
        }

        // Prevent context menu on right click
        window.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // ---------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------
    togglePause() {
        if (this.map && this.map.isOpen) {
            this.map.close();
        }
        this.setPaused(!this.isPaused);
    }

    /** Swap which pause-overlay panel is visible: 'main' | 'controls' | 'settings'. */
    showPausePanel(name) {
        if (this.pausePanelMain) this.pausePanelMain.style.display = name === 'main' ? '' : 'none';
        if (this.pausePanelControls) this.pausePanelControls.style.display = name === 'controls' ? '' : 'none';
        if (this.pausePanelSettings) this.pausePanelSettings.style.display = name === 'settings' ? '' : 'none';
        this.pauseSubview = name;
    }

    setPaused(paused, showOverlay = true) {
        if (paused && !this.isReady) return; // no pause menu during loading screen
        if (paused === this.isPaused) {
            if (this.pauseOverlay && showOverlay && paused) {
                this.pauseOverlay.classList.add('open');
                this.pauseOverlay.setAttribute('aria-hidden', 'false');
                if (this.pauseResumeBtn) this.pauseResumeBtn.focus({ preventScroll: true });
            }
            return;
        }
        this.isPaused = paused;

        // Drop any in-progress camera drag so it doesn't "stick" after resume
        this.isRightMouseDown = false;
        this.touchMoved = true;
        if (paused && showOverlay) {
            this.hideObjectTooltip();
            this.showPausePanel('main'); // always open on the main panel, not a leftover sub-view
        }

        if (this.pauseOverlay) {
            const shouldOpen = paused && showOverlay;
            this.pauseOverlay.classList.toggle('open', shouldOpen);
            this.pauseOverlay.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
        }
        if (paused && showOverlay) {
            if (this.pauseResumeBtn) this.pauseResumeBtn.focus({ preventScroll: true });
        } else if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
        }

        // Если пауза снята (например кнопкой «Продолжить»), закрываем карту
        if (!paused && this.map && this.map.isOpen) {
            this.map.close();
        }

        // Discard the wall-clock time that passed while paused
        this.clock.getDelta();

        window.dispatchEvent(new CustomEvent(paused ? 'game:pause' : 'game:resume'));
    }

    // ---------------------------------------------------------------
    // Inventory
    // ---------------------------------------------------------------
    toggleInventory() {
        this.setInventoryOpen(!this.isInventoryOpen);
    }

    setInventoryOpen(open) {
        this.isInventoryOpen = open;
        if (this.inventoryPanel) {
            this.inventoryPanel.classList.toggle('open', open);
            this.inventoryPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
        if (this.inventoryBtn) this.inventoryBtn.classList.toggle('active', open);
        if (this.ui) this.ui.layoutPanels();
        if (!open && document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
        }
    }

    // ---------------------------------------------------------------
    // Game-time timers (use instead of setTimeout for gameplay)
    // ---------------------------------------------------------------
    setGameTimeout(callback, seconds) {
        const id = this.nextTimerId++;
        this.timers.push({ id, at: this.gameTime + seconds, callback });
        return id;
    }

    clearGameTimeout(id) {
        this.timers = this.timers.filter(t => t.id !== id);
    }

    updateTimers() {
        if (this.timers.length === 0) return;
        const due = this.timers.filter(t => t.at <= this.gameTime);
        if (due.length === 0) return;
        this.timers = this.timers.filter(t => t.at > this.gameTime);
        due.forEach(t => t.callback());
    }

    resetCameraToNorth() {
        // Points camera directly North (-Z)
        this.targetCameraAngle = 0.0;
    }

    /**
     * Click / tap in the world. Priority: HUD (ignored here) > creature (target/attack)
     * > item pile (pick up) > tree (chop / walk there) > ground (walk).
     *
     * TARGET LOGIC (soft-lock):
     *   First click on a creature  → select it as target (visual ring appears)
     *   Second click on the SAME creature (already targeted) → engage (walk up and attack)
     *   Click on a different creature → switch target to it (no attack yet)
     *   Click on ground / pile / tree → deselect target, then handle normally
     */
    handleGroundClick(e) {
        if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return;
        if (!this.isReady || this.isTransitioning || !this.terrain) return;
        if (this.combat && this.combat.isDead) return;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Creature: target on first click, attack on second click (same creature already targeted)
        const creature = this.creatures ? this.creatures.pickAt(this.raycaster) : null;
        if (creature && this.combat) {
            const alreadyTargeted = this.combat.selectedTarget === creature;
            this.combat.selectTarget(creature);   // always update/confirm the target
            if (alreadyTargeted) {
                // Second click on the same creature → engage (walk up and melee)
                this.combat.attackCreature(creature);
            }
            // First click: just selects target, no movement
            return;
        }

        // Clicked on something other than a creature: deselect target
        if (this.combat) {
            this.combat.clearTarget();
            this.combat.cancel(); // clicked anything else: stop fighting / chopping
        }

        // Click on an item pile: walk there and pick it up on arrival (world_objects.js)
        if (this.worldObjects) {
            const pile = this.worldObjects.pickAt(this.raycaster);
            if (pile) {
                this.worldObjects.requestPickup(pile);
                return;
            }
            this.worldObjects.cancelPending(); // clicked elsewhere: forget the pending pickup
        }

        // Tree (or another harvestable environment object): chop with a chop tool, else walk there
        if (this.harvest) {
            const entry = this.pickEnvironmentObject();
            if (entry && this.harvest.isHarvestable(entry) && this.harvest.request(entry)) return;
        }

        const intersects = this.raycaster.intersectObject(this.terrain.mesh);

        if (intersects.length > 0) {
            const hitPoint = intersects[0].point;

            // Spawn visual ground marker
            this.spawnClickMarker(hitPoint);

            // Pathfinding to hit point
            if (this.character && this.pathfinder) {
                const path = this.pathfinder.findPath(this.character.position, hitPoint);
                if (path && path.length > 0) {
                    this.character.setPath(path);
                }
            }
        }
    }


    // Hover tooltip for interactable environment props (trees/boulders/shrubs/
    // reeds — see HOVER_KINDS in environment.js). Ported from the "Озерье"
    // prototype's pickProp()/mousemove logic, adapted to Avelora's chunked
    // InstancedMesh foliage (needs an extra instanceId -> object-id lookup that
    // Озерье's per-mesh props didn't need). Text tooltip + cursor change only —
    // no outline/glow on the object itself, matching the original.
    handleHover(e) {
        if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) {
            this.hideObjectTooltip();
            return;
        }
        if (!this.isReady || this.isTransitioning || !this.environment) {
            this.hideObjectTooltip();
            return;
        }

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Creatures first (name + HP bar), then item piles: "Камень ×5" (small, in front of foliage)
        const creature = this.creatures ? this.creatures.pickAt(this.raycaster) : null;
        if (this.creatures) this.creatures.hovered = creature;
        if (creature) {
            this.showObjectTooltip(creature.def.name, e.clientX, e.clientY);
            return;
        }
        const pile = this.worldObjects ? this.worldObjects.pickAt(this.raycaster) : null;
        if (pile) {
            this.showObjectTooltip(this.worldObjects.labelOf(pile), e.clientX, e.clientY);
            return;
        }
        const entry = this.pickEnvironmentObject();
        if (entry) {
            const label = this.harvest && this.harvest.isHarvestable(entry) ? this.harvest.labelFor(entry) : entry.label;
            this.showObjectTooltip(label, e.clientX, e.clientY);
        } else {
            this.hideObjectTooltip();
        }
    }

    /** Hoverable environment object (tree/boulder/...) under the already set-up raycaster, or null. */
    pickEnvironmentObject() {
        if (!this.environment || !this.environment.hoverMeshes.length) return null;
        const intersects = this.raycaster.intersectObjects(this.environment.hoverMeshes, false);
        for (let i = 0; i < intersects.length; i++) {
            const hit = intersects[i];
            const objId = hit.object.userData.instanceIds ? hit.object.userData.instanceIds[hit.instanceId] : null;
            const entry = objId != null ? this.environment.objects.get(objId) : null;
            if (entry && entry.visible !== false) return entry; // skip felled (zero-scaled) trees
        }
        return null;
    }

    showObjectTooltip(label, clientX, clientY) {
        if (!this.tooltipEl) return;
        this.tooltipEl.textContent = label;
        this.tooltipEl.style.left = `${clientX + 14}px`;
        this.tooltipEl.style.top = `${clientY + 10}px`;
        this.tooltipEl.classList.remove('hidden');
        if (this.container) this.container.style.cursor = 'pointer';
    }

    hideObjectTooltip() {
        if (this.tooltipEl) this.tooltipEl.classList.add('hidden');
        if (this.container) this.container.style.cursor = '';
    }

    spawnClickMarker(pos) {
        const markerMat = new THREE.MeshBasicMaterial({
            color: 0xffd24d,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        const mesh = new THREE.Mesh(this.markerGeo, markerMat);
        mesh.position.set(pos.x, pos.y + 0.04, pos.z);
        mesh.scale.set(1, 1, 1);
        this.scene.add(mesh);

        this.clickMarkers.push({
            mesh: mesh,
            age: 0,
            maxAge: 0.6
        });
    }

    updateCameraPosition(instant = false, delta = 0.016) {
        if (!this.character || !this.character.position) return;

        // Smoothly interpolate camera rotation towards target angle (e.g. on compass click)
        if (!instant && this.targetCameraAngle !== undefined) {
            let diff = this.targetCameraAngle - this.cameraAngle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.cameraAngle += diff * 0.12;
        }

        // Target tracks character smoothly
        if (instant) {
            this.cameraTarget.copy(this.character.position);
        } else {
            this.cameraTarget.lerp(this.character.position, 0.08);
        }

        // Camera pitch eases with zoom: flatter/lower angle when zoomed in
        // (cinematic close-up), back to the classic top-down angle when
        // zoomed back out. zoomT: 0 at minDistance (fully zoomed in), 1 at
        // maxDistance (fully zoomed out).
        const zoomT = Math.max(0, Math.min(1, (this.cameraDistance - this.minDistance) / (this.maxDistance - this.minDistance)));
        const targetPitch = this.pitchZoomedIn + (this.pitchZoomedOut - this.pitchZoomedIn) * zoomT;
        if (instant) {
            this.cameraPitch = targetPitch;
        } else {
            // Frame-rate-independent exponential ease: reaches the same point
            // in the same wall-clock time regardless of FPS (unlike a fixed
            // per-frame multiplier, which would ease slower on lower FPS).
            const pitchLerp = 1 - Math.exp(-this.pitchEaseRate * delta);
            this.cameraPitch += (targetPitch - this.cameraPitch) * pitchLerp;
        }

        const hDist = this.cameraDistance * Math.cos(this.cameraPitch);
        const vDist = this.cameraDistance * Math.sin(this.cameraPitch);

        const cx = this.cameraTarget.x + Math.sin(this.cameraAngle) * hDist;
        const cz = this.cameraTarget.z + Math.cos(this.cameraAngle) * hDist;
        const cy = this.cameraTarget.y + vDist;

        if (instant) {
            this.camera.position.set(cx, cy, cz);
        } else {
            this.camera.position.lerp(new THREE.Vector3(cx, cy, cz), 0.12);
        }

        this.camera.lookAt(this.cameraTarget.x, this.cameraTarget.y + 1.2, this.cameraTarget.z);

        // Keep sun shadow camera focused near character
        if (this.sunLight) {
            this.sunLight.position.copy(this.cameraTarget).add(SUN_OFFSET);

            // Shadow area follows zoom: only what the camera can see casts shadows
            // (fewer objects in the shadow pass + sharper shadows from the same shadow map)
            const d = Math.max(20, Math.min(46, this.cameraDistance * 1.05 + 4));
            const sc = this.sunLight.shadow.camera;
            if (Math.abs(sc.right - d) > 0.5) {
                sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d;
                sc.updateProjectionMatrix();
            }
            this.sunLight.target.position.copy(this.cameraTarget);
            this.sunLight.target.updateMatrixWorld();
        }

        if (this.skyDome) {
            this.skyDome.position.set(this.camera.position.x, 0, this.camera.position.z);
        }
    }

    updateHUD() {
        if (this.coordsEl && this.character) {
            const p = this.character.position;
            const name = this.currentCharacterConfig ? this.currentCharacterConfig.name : '';
            this.coordsEl.textContent = `${name ? name + '  ' : ''}X: ${p.x.toFixed(1)} | Z: ${p.z.toFixed(1)}`;
        }

        // Update compass needle orientation (pointing North)
        const needle = document.getElementById('compass-needle');
        if (needle) {
            const deg = -(this.cameraAngle) * (180 / Math.PI);
            needle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
        }
    }

    /**
     * FPS counter — off by default and never persisted (see the Settings
     * toggle in setupEvents()); reflects the real render-loop rate, so it
     * deliberately keeps ticking even while paused (rAF still fires then),
     * unlike gameplay timers which must freeze — same "bookkeeping, not
     * simulation" exemption as the autosave heartbeat (see AUTOSAVE_INTERVAL_MS).
     */
    updateFPS(delta) {
        if (!this.fpsCounterEnabled || !this.fpsEl) return;
        const instant = delta > 0 ? 1 / delta : 0;
        this._fpsSmoothed = this._fpsSmoothed === undefined ? instant : this._fpsSmoothed * 0.9 + instant * 0.1;
        this._fpsAccum = (this._fpsAccum || 0) + delta;
        if (this._fpsAccum >= 0.25) {
            this._fpsAccum = 0;
            this.fpsEl.textContent = Math.round(this._fpsSmoothed) + ' FPS';
        }
    }

    animate() {
        requestAnimationFrame(this.animate);

        const delta = Math.min(this.clock.getDelta(), 0.1);
        this.updateFPS(delta);

        // PAUSED: freeze all simulation (movement, animations, water, wind,
        // particles, markers, camera, timers). Only redraw the frozen frame
        // when the canvas was cleared (window resize).
        if (this.isPaused) {
            if (this.needsRender) {
                this.renderer.render(this.scene, this.camera);
                this.needsRender = false;
            }
            return;
        }
        this.needsRender = false;

        // LOADING A LOCATION: simulation frozen, just draw (the loading screen covers it)
        if (this.isTransitioning) {
            this.renderer.render(this.scene, this.camera);
            return;
        }

        this.simulate(delta);

        // Render scene
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * One step of game simulation (everything except drawing). animate() calls it
     * once per frame with the real, clamped delta; debugAdvance() (tests) calls it
     * repeatedly with a fixed step to fast-forward on slow headless GPUs.
     */
    simulate(delta) {
        // Advance game time & fire due game timers
        this.gameTime += delta;
        if (this.gameState) this.gameState.playTime += delta; // played time: respawn / regrow clock
        this.updateTimers();

        // Update systems
        if (this.character) {
            this.character.update(delta);   // incl. the procedural swing / death pose overlay
        }
        if (this.combat) this.combat.update(delta);       // melee engagement, pending hits, HP regen
        if (this.creatures) this.creatures.update(delta); // AI, animation, corpses, respawns
        if (this.harvest) this.harvest.update(delta);     // chips, shakes, falling trees, regrow
        if (this.water) {
            this.water.update(delta);
        }
        if (this.waterfall) {
            this.waterfall.update(delta);
        }
        if (this.environment) {
            this.environment.update(delta);
        }
        if (this.worldObjects) this.worldObjects.update(delta); // auto-pickup on arrival
        if (this.skills) this.skills.update(delta);             // casts, projectiles, VFX
        if (this.ui) this.ui.update(delta);                     // cooldown sweeps, floating texts

        // Update click markers
        for (let i = this.clickMarkers.length - 1; i >= 0; i--) {
            const m = this.clickMarkers[i];
            m.age += delta;
            const progress = m.age / m.maxAge;
            if (progress >= 1.0) {
                this.scene.remove(m.mesh);
                m.mesh.geometry.dispose();
                m.mesh.material.dispose();
                this.clickMarkers.splice(i, 1);
            } else {
                const s = 1.0 + progress * 0.9;
                m.mesh.scale.set(s, s, s);
                m.mesh.material.opacity = (1.0 - progress) * 0.9;
            }
        }

        // Location exits (may start a location change)
        this.updateExits(delta);

        // Update camera and HUD
        this.updateCameraPosition(false, delta);
        this.updateHUD();
        this.updateWorldLabels();
    }

    // ---------------------------------------------------------------
    // Test / debug hooks (headless tests run SwiftShader at ~1 FPS)
    // ---------------------------------------------------------------
    /**
     * Fast-forwards `seconds` of game simulation in fixed `step`s without
     * drawing, then draws once. Respects pause/loading (returns false then).
     */
    debugAdvance(seconds, step) {
        if (this.isPaused || this.isTransitioning || !this.isReady) return false;
        const dt = step || 1 / 30;
        let left = seconds;
        while (left > 1e-6 && !this.isTransitioning && !this.isPaused) {
            const d = Math.min(dt, left);
            this.simulate(d);
            left -= d;
        }
        this.clock.getDelta();
        this.renderer.render(this.scene, this.camera);
        return true;
    }

    /** Adds played time (respawn / regrow clock) and runs the checks right away. */
    debugAddPlayTime(seconds) {
        if (!this.gameState) return;
        this.gameState.playTime += seconds;
        if (this.creatures) this.creatures.checkRespawns();
        if (this.harvest) this.harvest.checkRegrow();
        this.gameState.save();
    }
}

// Launch on page load
window.addEventListener('DOMContentLoaded', () => {
    window.game = new AveloraGame();
});
