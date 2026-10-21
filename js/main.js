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
 * - Переход: game.changeLocation('savanna', 'fromForest') или вход в зону `exits`.
 * - Стартовая локация: window.START_LOCATION, для теста — index.html#savanna
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
const UI_SELECTOR = '#player-frame, #player-frame *, #target-frame, #target-frame *, #player-portrait-btn, #player-portrait-btn *, .player-portrait-wrap, .player-portrait-wrap *, #hud-top-left, #compass-btn, #cam-btn, #joy-zone, #skill-bar, #inventory-panel, #chest-panel, #build-panel, #build-bar, #dialog-panel, #skills-panel, #crafting-panel, #hero-panel, #quests-panel, #quest-tracker, #quest-tracker *, #potion-modal, .micromenu-dock, .micromenu-container, #item-tooltip, #quantity-modal, #pause-overlay, #character-select-overlay, #hp-bar, #mana-bar, #xp-bar, #death-overlay, #map-overlay, #orientation-warning';
window.AVELORA_UI_SELECTOR = UI_SELECTOR; // ui_hotbar.js: "released over the world?" (drop from the bag)

// Real-time (not game-time) interval for the save-progress heartbeat. This is
// persistence bookkeeping, not gameplay simulation, so it's exempt from the
// "never use setInterval for gameplay timing" rule (CLAUDE.md §Pause Rule) —
// saving is harmless whether or not the game happens to be paused.
const AUTOSAVE_INTERVAL_MS = 20000;
const PORTAL_LABEL_DIST = 30;   // portal captions are shown only this close (m) — читаемо издалека, но не на всю локацию

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
        this.lastPointer = { x: 0, y: 0, type: 'none', valid: false, overUI: false };   // overUI: cursor is on a HUD element right now (hotbar click) -> no cursor aiming

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
        this.minDistance = 5.0; // closer zoom for inspecting characters
        this.maxDistance = 42.0;
        // Camera modes: 'main' (0%..25%) | 'topdown' (25%..100%) | 'first' (1st person)
        this.camMode = 'main';
        this.cameraDistance = this.minDistance + (this.maxDistance - this.minDistance) * 0.10; // Default 10%
        this.savedMainDist = this.cameraDistance;
        this.savedTopdownDist = this.minDistance + (this.maxDistance - this.minDistance) * 0.50;
        // View mode: 'third' (classic) | 'first' (1st person).
        this.viewMode = 'third';
        this.camPitchOffset = 0;     // third person: extra camera elevation set by RMB / finger drag (rad)
        this.fpPitch = 0;            // look up/down in first person (rad)
        this.fpEyeHeight = 1.65;     // eye level above the hero's feet
        this.fpFov = 72;
        this.thirdFov = 45;
        this.moveKeys = {};          // held keys (e.code) for first-person movement
        this.leftDown = false;       // LMB held (LMB+RMB = forward in first person)
        this.joy = { active: false, id: null, x: 0, y: 0 }; // mobile joystick, -1..1 (y>0 = forward)
        this.lookTouchId = null;     // finger that rotates the camera in first person
        this.viewSwitchT = 0;        // time of the last view switch (wheel cooldown)
        this.lastWheelT = 0;
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
        this.renderer = new THREE.WebGLRenderer({ antialias: !(window.GFX && window.GFX.aa === false), powerPreference: (window.GFX && window.GFX.isPhone) ? 'default' : 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.05;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);
        this.createVignette();

        // Lighting
        this.setupLighting();
        this.applyGraphicsProfile(true);

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
        this.hero = window.AveloraHero ? new AveloraHero(this) : null;   // level / xp / stats / mana (hero.js)
        this.map = window.AveloraMap ? new AveloraMap(this) : null;

        // Event Listeners
        this.setupEvents();

        // Animation Loop
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);

        this.bootstrap().catch(err => console.error('[Avelora] start failed', err));
    }

    // ---------------------------------------------------------------
    // Character selection & save-driven bootstrap (WoW-style)
    // ---------------------------------------------------------------
    /** First thing that runs */
    async bootstrap() {
        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
        if (slots.length === 0) {
            this.showCharacterSelect(false);
            this.openCharacterCreateModal();
        } else {
            this.selectedSlotId = slots[0].slotId;
            this.showCharacterSelect(false);
        }
    }

    /** allowCancel: true when opened from the pause menu (an existing game session to go back to). */
    showCharacterSelect(allowCancel) {
        this.isPaused = true;
        this.isCharacterSelectOpen = true;
        document.body.classList.add('charselect-mode');

        // Atmospheric dark fantasy background & fog for showcase
        if (this.scene) {
            if (!this._origSceneBg) this._origSceneBg = this.scene.background;
            if (!this._origSceneFog) this._origSceneFog = this.scene.fog;
            this.scene.background = new THREE.Color(0x0e1418);
            this.scene.fog = new THREE.FogExp2(0x0e1418, 0.035);
        }

        // Camera framing the character showcase stage
        if (this.camera) {
            this.camera.position.set(-0.35, 1.15, 2.7);
            this.camera.lookAt(-0.35, 0.95, 0);
        }

        // If gameplay character mesh is live, hide it so it doesn't overlap
        if (this.character && this.character.mesh) {
            this.character.mesh.visible = false;
        }

        // Ensure showcase stage is active
        if (!this.csPreviewGroup) {
            this.setupCharacterSelectStage();
        } else {
            this.csPreviewGroup.visible = true;
        }

        this.setupCharacterSelectEvents();
        this.renderCharacterSlots();

        const overlay = document.getElementById('character-select-overlay');
        if (overlay) overlay.classList.remove('hidden');

        const backBtn = document.getElementById('cs-btn-back') || document.getElementById('charselect-back');
        if (backBtn) backBtn.style.display = allowCancel ? '' : 'none';

        this.hideLoading();
    }

    hideCharacterSelect() {
        this.isCharacterSelectOpen = false;
        document.body.classList.remove('charselect-mode');

        if (this.csPreviewGroup) {
            this.csPreviewGroup.visible = false;
        }
        if (this.character && this.character.mesh) {
            this.character.mesh.visible = true;
        }

        // Restore scene background / fog
        if (this.scene && this._origSceneBg) {
            this.scene.background = this._origSceneBg;
            this.scene.fog = this._origSceneFog;
        }

        const overlay = document.getElementById('character-select-overlay');
        if (overlay) overlay.classList.add('hidden');
        this.closeCharacterCreateModal();
    }

    base64ToArrayBuffer(base64) {
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    setupCharacterSelectStage() {
        if (this.csPreviewGroup) return;
        this.csPreviewGroup = new THREE.Group();

        // 1. Pedestal: Dark circular stone slab (proportional to character)
        const pedestalGeo = new THREE.CylinderGeometry(0.65, 0.72, 0.08, 48);
        const pedestalMat = new THREE.MeshStandardMaterial({
            color: 0x12171a,
            roughness: 0.85,
            metalness: 0.15
        });
        const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
        pedestal.position.set(-0.35, -0.04, 0);
        pedestal.receiveShadow = true;
        this.csPreviewGroup.add(pedestal);

        // 2. Glowing Golden Rune Ring on top of the stone
        const ringGeo = new THREE.RingGeometry(0.42, 0.56, 48);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xc3a05f,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(-0.35, 0.003, 0);
        this.csPreviewGroup.add(ring);

        // Outer ornate gold rim
        const rimGeo = new THREE.TorusGeometry(0.65, 0.012, 12, 48);
        rimGeo.rotateX(Math.PI / 2);
        const rimMat = new THREE.MeshStandardMaterial({
            color: 0x9a8045,
            metalness: 0.8,
            roughness: 0.35
        });
        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.position.set(-0.35, 0.003, 0);
        this.csPreviewGroup.add(rim);

        // 3. Stage Lighting (moody, contrasted dark fantasy showcase)
        const amb = new THREE.AmbientLight(0x28323a, 0.7);
        this.csPreviewGroup.add(amb);

        const keyLight = new THREE.DirectionalLight(0xffecd0, 2.0);
        keyLight.position.set(1.5, 3.8, 3.0);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 1024;
        keyLight.shadow.mapSize.height = 1024;
        this.csPreviewGroup.add(keyLight);

        // Golden rim / back light to outline the character silhouette against the dark background
        const rimLight = new THREE.DirectionalLight(0xefcf7a, 1.6);
        rimLight.position.set(-2.0, 2.5, -2.5);
        this.csPreviewGroup.add(rimLight);

        // Cool blue fill from bottom-left
        const fillLight = new THREE.DirectionalLight(0x40607a, 0.7);
        fillLight.position.set(-2.5, 1.0, 2.0);
        this.csPreviewGroup.add(fillLight);

        this.scene.add(this.csPreviewGroup);
    }

    updatePreviewCharacter(classId) {
        if (!classId) classId = 'mage';
        if (this.csCurrentPreviewClass === classId && this.csPreviewModel) return;
        this.csCurrentPreviewClass = classId;

        if (!this.csPreviewGroup) {
            this.setupCharacterSelectStage();
        }

        const catalog = window.CHARACTER_CATALOG || [];
        const charConfig = catalog.find(c => c.id === classId) || catalog[0];
        if (!charConfig) return;

        const modelKey = charConfig.modelKey;
        if (!window.AveloraAssets) return;

        window.AveloraAssets.ensure(modelKey).then(() => {
            if (!this.isCharacterSelectOpen || this.csCurrentPreviewClass !== classId) return;
            const b64 = window.GAME_ASSETS && window.GAME_ASSETS.models[modelKey];
            if (!b64) return;

            try {
                const buffer = this.base64ToArrayBuffer(b64);
                const loader = new THREE.GLTFLoader();
                loader.parse(buffer, '', (gltf) => {
                    if (!this.isCharacterSelectOpen || this.csCurrentPreviewClass !== classId) return;

                    if (this.csPreviewModel) {
                        this.csPreviewGroup.remove(this.csPreviewModel);
                        this.csPreviewModel = null;
                    }
                    if (this.csMixer) {
                        this.csMixer.stopAllAction();
                        this.csMixer = null;
                    }

                    const model = gltf.scene;
                    const scale = charConfig.scale || 1.0;
                    model.scale.set(scale, scale, scale);
                    model.position.set(-0.35, 0, 0);

                    // Face toward the camera (+Z)
                    const faceAngle = (charConfig.facingOffset || 0) + Math.PI;
                    model.rotation.y = faceAngle;

                    model.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                            if (child.material) {
                                child.material.roughness = Math.max(0.35, child.material.roughness || 0.6);
                                child.material.metalness = Math.min(0.2, child.material.metalness || 0.0);
                            }
                        }
                    });

                    // Play Idle animation
                    const mixer = new THREE.AnimationMixer(model);
                    this.csMixer = mixer;

                    const clips = gltf.animations || [];
                    const idleName = (charConfig.animMap && charConfig.animMap.idle) || 'Idle';
                    let clip = clips.find(c => c.name.toLowerCase() === idleName.toLowerCase())
                        || clips.find(c => c.name.toLowerCase().includes('idle'))
                        || clips[0];

                    if (clip) {
                        const action = mixer.clipAction(clip);
                        action.play();
                    }

                    this.csPreviewModel = model;
                    this.csPreviewGroup.add(model);
                    this.needsRender = true;
                }, (err) => console.error('[Avelora] GLTF parse error for preview', err));
            } catch (err) {
                console.error('[Avelora] could not build character preview', err);
            }
        });
    }

    setupCharacterSelectEvents() {
        if (this._charSelectEventsBound) return;
        this._charSelectEventsBound = true;

        // "ВОЙТИ В МИР" button
        const enterBtn = document.getElementById('cs-btn-enter-world');
        if (enterBtn) {
            enterBtn.addEventListener('click', () => {
                const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
                if (slots.length === 0) {
                    this.openCharacterCreateModal();
                    return;
                }
                const slot = slots.find(s => s.slotId === this.selectedSlotId) || slots[0];
                if (slot) this.enterWorldWithSlot(slot);
            });
        }

        // "Новый персонаж" button
        const createBtn = document.getElementById('cs-btn-create-new');
        if (createBtn) {
            createBtn.addEventListener('click', () => this.openCharacterCreateModal());
        }

        // "Удалить" button
        const deleteBtn = document.getElementById('cs-btn-delete-char');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => this.deleteSelectedCharacter());
        }

        // "Импорт" button & File input (strictly loads from .json file)
        const importBtn = document.getElementById('cs-btn-import');
        const fileInput = document.getElementById('cs-file-input');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                if (fileInput) {
                    fileInput.value = '';
                    fileInput.click();
                } else {
                    this.handleSlotImport();
                }
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', () => {
                const file = fileInput.files && fileInput.files[0];
                if (!file) return;
                window.AveloraSlots.importSlotFile(file, (res) => {
                    if (res.ok) {
                        this.selectedSlotId = res.slot.slotId;
                        alert(`Персонаж «${res.slot.name}» успешно импортирован из файла!`);
                        this.renderCharacterSlots();
                    } else {
                        alert('Ошибка импорта: ' + res.error);
                    }
                    fileInput.value = '';
                });
            });
        }

        // "Экспорт" button
        const exportBtn = document.getElementById('cs-btn-export');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
                const slot = slots.find(s => s.slotId === this.selectedSlotId);
                if (!slot) return;
                const ok = window.AveloraSlots.downloadSlotFile(slot.slotId);
                if (ok) {
                    alert(`Файл сохранения персонажа «${slot.name}» скачан на устройство!`);
                } else {
                    this.handleSlotExport();
                }
            });
        }

        // "Назад в игру" button (mid-session)
        const backBtn = document.getElementById('cs-btn-back');
        if (backBtn) {
            backBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideCharacterSelect();
                this.setPaused(true);
            });
        }
        const oldBackBtn = document.getElementById('charselect-back');
        if (oldBackBtn && oldBackBtn !== backBtn) {
            oldBackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideCharacterSelect();
                this.setPaused(true);
            });
        }

        // Modal close buttons
        const modalClose = document.getElementById('cs-create-close');
        if (modalClose) modalClose.addEventListener('click', () => this.closeCharacterCreateModal());
        const modalCancel = document.getElementById('cs-create-cancel');
        if (modalCancel) modalCancel.addEventListener('click', () => this.closeCharacterCreateModal());
        const modalBackdrop = document.getElementById('cs-create-backdrop');
        if (modalBackdrop) modalBackdrop.addEventListener('click', () => this.closeCharacterCreateModal());

        // Modal confirm button
        const modalConfirm = document.getElementById('cs-create-confirm');
        if (modalConfirm) modalConfirm.addEventListener('click', () => this.confirmCharacterCreate());

        // Enter key in character name input
        const nameInput = document.getElementById('cs-char-name-input');
        if (nameInput) {
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.confirmCharacterCreate();
                }
            });
        }

        // Global Enter key: if character select overlay is visible and modal is NOT open, enter world
        window.addEventListener('keydown', (e) => {
            const overlay = document.getElementById('character-select-overlay');
            const modal = document.getElementById('cs-create-modal');
            if (overlay && !overlay.classList.contains('hidden') && (!modal || modal.style.display === 'none')) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
                    const slot = slots.find(s => s.slotId === this.selectedSlotId) || slots[0];
                    if (slot) this.enterWorldWithSlot(slot);
                }
            }
        });
    }

    renderCharacterSlots() {
        const slotsList = document.getElementById('cs-slots-list');
        if (!slotsList) return;
        slotsList.innerHTML = '';

        const maxSlots = window.AveloraSlots ? window.AveloraSlots.MAX_SLOTS : 8;
        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];

        // Counter
        const counterEl = document.getElementById('cs-slot-counter');
        if (counterEl) counterEl.textContent = `${slots.length} / ${maxSlots}`;

        // Ensure valid selection
        if (!this.selectedSlotId || !slots.some(s => s.slotId === this.selectedSlotId)) {
            this.selectedSlotId = slots.length > 0 ? slots[0].slotId : null;
        }

        // Render filled slot cards
        slots.forEach(slot => {
            const details = window.AveloraSlots.getSlotDetails(slot);
            const isActive = slot.slotId === this.selectedSlotId;

            const card = document.createElement('div');
            card.className = 'cs-slot-card' + (isActive ? ' active' : '');
            card.dataset.slotId = slot.slotId;

            // Icon / Avatar
            const iconBox = document.createElement('div');
            iconBox.className = 'cs-slot-icon-box';
            iconBox.textContent = details.icon || '🔮';
            card.appendChild(iconBox);

            // Main Info
            const mainBox = document.createElement('div');
            mainBox.className = 'cs-slot-main';

            const header = document.createElement('div');
            header.className = 'cs-slot-header';

            const name = document.createElement('div');
            name.className = 'cs-slot-name';
            name.textContent = details.name;
            header.appendChild(name);

            const level = document.createElement('div');
            level.className = 'cs-slot-level';
            level.textContent = `Ур. ${details.level}`;
            header.appendChild(level);
            mainBox.appendChild(header);

            const cls = document.createElement('div');
            cls.className = 'cs-slot-class';
            cls.textContent = details.className;
            mainBox.appendChild(cls);

            const meta = document.createElement('div');
            meta.className = 'cs-slot-meta';

            const loc = document.createElement('div');
            loc.className = 'cs-slot-loc';
            loc.textContent = details.locationName;
            meta.appendChild(loc);

            const time = document.createElement('div');
            time.className = 'cs-slot-time';
            time.textContent = details.playTimeStr;
            meta.appendChild(time);

            mainBox.appendChild(meta);
            card.appendChild(mainBox);

            // Single click selects
            card.addEventListener('click', () => {
                this.selectedSlotId = slot.slotId;
                const allCards = slotsList.querySelectorAll('.cs-slot-card');
                allCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                this.updateSlotPreview();
            });

            // Double click enters world
            card.addEventListener('dblclick', () => {
                this.selectedSlotId = slot.slotId;
                this.enterWorldWithSlot(slot);
            });

            slotsList.appendChild(card);
        });

        // Render empty slot cards
        for (let i = slots.length; i < maxSlots; i++) {
            const emptyCard = document.createElement('div');
            emptyCard.className = 'cs-slot-empty';
            emptyCard.innerHTML = `<span class="cs-empty-plus">+</span><span>Пустой слот</span>`;
            emptyCard.title = 'Нажмите, чтобы создать нового персонажа';
            emptyCard.addEventListener('click', () => this.openCharacterCreateModal());
            slotsList.appendChild(emptyCard);
        }

        // Disable "Новый персонаж" button if full
        const createBtn = document.getElementById('cs-btn-create-new');
        if (createBtn) {
            createBtn.style.opacity = slots.length >= maxSlots ? '0.5' : '1';
            createBtn.style.pointerEvents = slots.length >= maxSlots ? 'none' : '';
        }

        // Update action buttons and preview
        const hasSelection = !!this.selectedSlotId;
        const enterBtn = document.getElementById('cs-btn-enter-world');
        if (enterBtn) {
            enterBtn.disabled = slots.length === 0;
            enterBtn.style.opacity = slots.length === 0 ? '0.5' : '1';
        }
        const deleteBtn = document.getElementById('cs-btn-delete-char');
        if (deleteBtn) {
            deleteBtn.style.display = hasSelection ? '' : 'none';
        }
        const exportBtn = document.getElementById('cs-btn-export');
        if (exportBtn) {
            exportBtn.style.display = hasSelection ? '' : 'none';
        }

        this.updateSlotPreview();
    }

    updateSlotPreview() {
        const previewBox = document.getElementById('cs-selected-preview');
        if (!previewBox) return;

        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
        const slot = slots.find(s => s.slotId === this.selectedSlotId);

        if (!slot) {
            previewBox.style.display = 'none';
            if (this.csPreviewModel && this.csPreviewGroup) {
                this.csPreviewGroup.remove(this.csPreviewModel);
                this.csPreviewModel = null;
            }
            return;
        }

        const details = window.AveloraSlots.getSlotDetails(slot);
        previewBox.style.display = 'flex';

        const nameEl = document.getElementById('cs-big-name');
        if (nameEl) nameEl.textContent = details.name;

        const classEl = document.getElementById('cs-big-class');
        if (classEl) classEl.textContent = `${details.className} • Уровень ${details.level} • Время в пути: ${details.playTimeStr}`;

        const locEl = document.getElementById('cs-big-loc');
        if (locEl) locEl.textContent = `${details.locationName} • Золото: ${details.gold} 🪙`;

        // Update 3D model in the center of the scene!
        this.updatePreviewCharacter(details.classId);
    }

    async enterWorldWithSlot(slot) {
        if (!slot) return;
        this.tryLockLandscape();
        clearTimeout(this.loadingHideTimer);

        const details = window.AveloraSlots.getSlotDetails(slot);
        const charConfig = details.charConfig || (window.CHARACTER_CATALOG && window.CHARACTER_CATALOG[0]);
        const customConfig = { ...charConfig, name: slot.name || charConfig.name };

        this.showLoading('Avelora', `Входит ${customConfig.name}...`);
        await nextFrame();
        await nextFrame();
        this.hideCharacterSelect();
        if (this.pauseOverlay) this.pauseOverlay.classList.remove('open');

        let save = null;
        if (window.AveloraSave && window.AveloraSave.loadSave) {
            save = window.AveloraSave.loadSave(slot.saveId);
        }

        const opts = save ? {
            saveId: slot.saveId,
            locationId: save.locationId,
            position: { x: save.x, z: save.z, r: save.r },
            relocated: !!save.relocated
        } : {
            saveId: slot.saveId
        };

        await this.startGame(customConfig, opts);
    }

    openCharacterCreateModal() {
        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
        const maxSlots = window.AveloraSlots ? window.AveloraSlots.MAX_SLOTS : 8;
        if (slots.length >= maxSlots) {
            alert(`Все слоты персонажей заняты (максимум ${maxSlots}). Удалите ненужного персонажа.`);
            return;
        }

        const modal = document.getElementById('cs-create-modal');
        if (!modal) return;

        const classContainer = document.getElementById('cs-class-cards');
        if (classContainer) {
            classContainer.innerHTML = '';
            const catalog = (window.CHARACTER_CATALOG || []).filter(c => !c.hidden);
            let firstSelectable = null;

            catalog.forEach(char => {
                const card = document.createElement('div');
                card.className = 'cs-class-card' + (char.disabled ? ' disabled' : '');
                card.dataset.classId = char.id;

                const icon = document.createElement('div');
                icon.className = 'cs-class-card-icon';
                icon.textContent = char.icon || '⚔️';
                card.appendChild(icon);

                const name = document.createElement('div');
                name.className = 'cs-class-card-name';
                name.textContent = char.className || char.name;
                card.appendChild(name);

                const desc = document.createElement('div');
                desc.className = 'cs-class-card-desc';
                desc.textContent = char.disabled ? 'Скоро в игре' : (char.description || (char.id === 'mage' ? 'Владыка стихийной магии' : 'Герой Авелоры'));
                card.appendChild(desc);

                if (!char.disabled) {
                    if (!firstSelectable) firstSelectable = char;
                    card.addEventListener('click', () => {
                        this._createSelectedClassId = char.id;
                        classContainer.querySelectorAll('.cs-class-card').forEach(c => c.classList.remove('selected'));
                        card.classList.add('selected');
                        const nameInput = document.getElementById('cs-char-name-input');
                        if (nameInput && (!nameInput.value || nameInput.value === 'Маг' || nameInput.value === 'Лучница' || nameInput.value === 'Воин')) {
                            nameInput.value = char.name;
                        }
                        // Update 3D preview model to match clicked class!
                        this.updatePreviewCharacter(char.id);
                    });
                }

                classContainer.appendChild(card);
            });

            // Default selection
            const defaultClass = firstSelectable || catalog[0];
            if (defaultClass) {
                this._createSelectedClassId = defaultClass.id;
                const firstCard = classContainer.querySelector(`.cs-class-card[data-class-id="${defaultClass.id}"]`);
                if (firstCard) firstCard.classList.add('selected');
                this.updatePreviewCharacter(defaultClass.id);
            }
        }

        const nameInput = document.getElementById('cs-char-name-input');
        if (nameInput) {
            const defChar = (window.CHARACTER_CATALOG || []).find(c => c.id === this._createSelectedClassId);
            nameInput.value = (defChar && defChar.name) || 'Маг';
            setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
        }

        modal.style.display = 'flex';
    }

    closeCharacterCreateModal() {
        const modal = document.getElementById('cs-create-modal');
        if (modal) modal.style.display = 'none';
        // Restore preview of currently selected slot if any
        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
        const slot = slots.find(s => s.slotId === this.selectedSlotId);
        if (slot) {
            const details = window.AveloraSlots.getSlotDetails(slot);
            this.updatePreviewCharacter(details.classId);
        }
    }

    confirmCharacterCreate() {
        const classId = this._createSelectedClassId || 'mage';
        const nameInput = document.getElementById('cs-char-name-input');
        const customName = nameInput ? nameInput.value.trim() : '';

        const newSlot = window.AveloraSlots.createCharacter(classId, customName);
        if (!newSlot) return;

        this.closeCharacterCreateModal();
        this.selectedSlotId = newSlot.slotId;
        this.enterWorldWithSlot(newSlot);
    }

    deleteSelectedCharacter() {
        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
        const slot = slots.find(s => s.slotId === this.selectedSlotId);
        if (!slot) return;

        const details = window.AveloraSlots.getSlotDetails(slot);
        const confirmed = window.confirm(
            `Удалить персонажа «${details.name}» (${details.className}, Ур. ${details.level})?\n\n` +
            `Все сохранения, предметы в инвентаре и прогресс квестов этого персонажа будут удалены безвозвратно.`
        );
        if (!confirmed) return;

        window.AveloraSlots.deleteCharacter(slot.slotId);
        if (this.gameState && this.currentSaveId === slot.saveId) {
            this.gameState.discard();
        }

        this.selectedSlotId = null;
        this.renderCharacterSlots();
    }

    handleSlotImport() {
        // First check for legacy hero
        const importedCount = window.AveloraSlots.importLegacyHero();
        if (importedCount > 0) {
            alert(`Успешно импортировано сохранений: ${importedCount}`);
            this.renderCharacterSlots();
            return;
        }

        // Otherwise prompt for JSON backup
        const jsonStr = window.prompt('Вставьте JSON строку данных сохранения персонажа:');
        if (!jsonStr) return;

        const res = window.AveloraSlots.importSlotData(jsonStr);
        if (res.ok) {
            this.selectedSlotId = res.slot.slotId;
            alert(`Персонаж «${res.slot.name}» успешно импортирован!`);
            this.renderCharacterSlots();
        } else {
            alert('Ошибка импорта: ' + res.error);
        }
    }

    handleSlotExport() {
        const slots = window.AveloraSlots ? window.AveloraSlots.getSlots() : [];
        const slot = slots.find(s => s.slotId === this.selectedSlotId);
        if (!slot) return;

        const jsonStr = window.AveloraSlots.exportSlotData(slot.slotId);
        if (!jsonStr) {
            alert('Не удалось сформировать данные сохранения.');
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonStr).then(() => {
                alert(`Сохранение персонажа «${slot.name}» скопировано в буфер обмена!\n\nВы можете сохранить его в текстовый файл.`);
            }).catch(() => {
                window.prompt('Скопируйте данные персонажа:', jsonStr);
            });
        } else {
            window.prompt('Скопируйте данные персонажа:', jsonStr);
        }
    }

    async chooseCharacter(char, save) {
        const opts = save
            ? { locationId: save.locationId, position: { x: save.x, z: save.z, r: save.r }, relocated: !!save.relocated }
            : {};
        await this.startGame(char, opts);
    }

    // ---------------------------------------------------------------
    // Locations
    // ---------------------------------------------------------------
    getStartLocationId() {
        const locs = window.LOCATIONS || {};
        // Dev shortcut: index.html#savanna or index.html#loc=savanna
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
    /** Locations with camera settings apply them on entering; resets to default if omitted. */
    applyLocationCamera(loc) {
        if (loc && typeof loc.cameraAngle === 'number') {
            this.cameraAngle = this.targetCameraAngle = loc.cameraAngle;
        }
        this.minDistance = (loc && typeof loc.minDistance === 'number') ? loc.minDistance : 5.0;
        this.maxDistance = (loc && typeof loc.maxDistance === 'number') ? loc.maxDistance : 42.0;

        const limits = this.getCameraZoomLimits();
        // Always default to 'main' mode at 10% on start / load as requested
        this.camMode = 'main';
        this.cameraDistance = limits.main.def;
        this.savedMainDist = this.cameraDistance;
        this.savedTopdownDist = limits.topdown.def;

        this.pitchZoomedIn = (loc && typeof loc.pitchZoomedIn === 'number') ? loc.pitchZoomedIn : 0.3491;
        this.pitchZoomedOut = (loc && typeof loc.pitchZoomedOut === 'number') ? loc.pitchZoomedOut : 0.82;
    }

    /** Returns min, max, default distances for current mode brackets */
    getCameraZoomLimits() {
        const minD = (typeof this.minDistance === 'number') ? this.minDistance : 5.0;
        const maxD = (typeof this.maxDistance === 'number') ? this.maxDistance : 42.0;
        const span = Math.max(0.1, maxD - minD);
        const d25 = minD + span * 0.25;
        return {
            main: { min: minD, max: d25, def: minD + span * 0.10 },
            topdown: { min: d25, max: maxD, def: minD + span * 0.50 }
        };
    }

    /** Cycle through the 3 camera modes: main (0-25%) -> topdown (25-100%) -> first person -> main */
    cycleCamMode() {
        const limits = this.getCameraZoomLimits();
        if (this.camMode === 'main') {
            this.savedMainDist = this.cameraDistance;
            this.camMode = 'topdown';
            if (this.viewMode === 'first') this.setViewMode('third');
            this.cameraDistance = Math.max(limits.topdown.min, Math.min(limits.topdown.max, this.savedTopdownDist || limits.topdown.def));
        } else if (this.camMode === 'topdown') {
            this.savedTopdownDist = this.cameraDistance;
            this.camMode = 'first';
            this.setViewMode('first');
        } else { // 'first'
            this.camMode = 'main';
            this.setViewMode('third');
            this.cameraDistance = Math.max(limits.main.min, Math.min(limits.main.max, this.savedMainDist || limits.main.def));
        }
    }

    async startGame(characterConfig, opts) {
        opts = opts || {};
        clearTimeout(this.loadingHideTimer);
        this.showLoading('Avelora', characterConfig.name ? `Входит ${characterConfig.name}...` : 'Вход в средневековый мир...');
        this.isTransitioning = true;
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
        if (this.ui) {
            if (this.ui.closeDialog) this.ui.closeDialog();
            if (this.ui.closeChest) this.ui.closeChest();
        }
        if (this.worldObjects && this.worldObjects.openContainer) {
            this.worldObjects.openContainer = null;
        }
        if (this.setInventoryOpen) this.setInventoryOpen(false);

        this.currentCharacterConfig = characterConfig;
        this.currentSaveId = (opts && opts.saveId) || characterConfig.id;
        // Per-character inventory/hotbar/pickups (separate key from the position save)
        this.gameState = window.AveloraState ? window.AveloraState.load(this.currentSaveId, characterConfig.id) : null;

        let startId = (opts.locationId && window.LOCATIONS[opts.locationId]) ? opts.locationId : this.getStartLocationId();

        // Безопасность подземелий: если сохранение было в данже, при перезагрузке выкидываем наружу ко входу в пещеру
        if (window.LOCATIONS && window.LOCATIONS[startId] && window.LOCATIONS[startId].isDungeon) {
            const dungeonLoc = window.LOCATIONS[startId];
            startId = dungeonLoc.surfaceLocation || 'forestEdge';
            opts.spawnId = dungeonLoc.surfaceSpawn || 'fromDungeon';
            opts.position = null; // спавним в безопасной точке снаружи
        }

        // Сохранение указывало на несуществующую локацию: координаты чужие, ставим в стартовую точку
        if (opts.locationId && !window.LOCATIONS[opts.locationId]) { opts.position = null; opts.relocated = true; }
        const built = this.buildLocationSafe(startId, opts.spawnId || null);
        if (built.fallback) { opts.position = null; opts.relocated = true; }
        const defaultSpawn = built.spawn;
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
        this.applyLocationCamera(this.location);
        this.updateCameraPosition(true);

        const minLoadTime = new Promise(r => setTimeout(r, 80));

        await Promise.all([
            characterLoaded,
            this.environment ? this.environment.ready : null,
            this.worldObjects ? this.worldObjects.ready : null,
            this.creatures ? this.creatures.ready : null,
            this.harvest ? this.harvest.ready : null,
            window.AveloraAssets ? window.AveloraAssets.idle() : null,   // модели локации подгружены своими файлами
            minLoadTime
        ]);
        if (window.AveloraAssets) window.AveloraAssets.evictUnused();   // модели прошлой локации — из памяти
        if (this.hero) this.hero.bind(this.gameState, characterConfig);
        if (this.combat) this.combat.bindCharacter(characterConfig); // full HP, no fight
        if (this.ui) {
            this.ui.bindCharacter(this.gameState);
            this.ui.applyEquipment();
            if (opts.relocated && this.ui.floatText) setTimeout(() => this.ui.floatText('Прежняя локация недоступна: вы на стартовой точке', 'info'), 1500);
        }
        if (this.skills && this.skills.forCharacter(characterConfig.id).length) this.skills.prewarm();

        // Warm up shaders & render fresh frame under loading overlay so old frame is never seen
        try {
            if (this.renderer && this.scene && this.camera) {
                if (typeof this.renderer.compile === 'function') {
                    this.renderer.compile(this.scene, this.camera);
                }
                this.renderer.render(this.scene, this.camera);
            }
        } catch (e) {
            console.warn('[Avelora] Shader warmup warning:', e);
        }

        await nextFrame();
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
        const saveId = this.currentSaveId || this.currentCharacterConfig.id;
        window.AveloraSave.writeSave(saveId, {
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

    /**
     * buildLocation с запасным выходом: если локацию не удалось построить (ошибка в данных, удалена и т.п.),
     * герой (со всей сумкой, навыками и опытом — они в game_state) переносится на стартовую точку стартовой локации.
     * Возвращает { spawn, fallback }.
     */
    buildLocationSafe(id, spawnId) {
        try {
            return { spawn: this.buildLocation(id, spawnId), fallback: false };
        } catch (e) {
            console.error(`[Avelora] location "${id}" failed to build, moving the hero to the start location`, e);
            try { this.teardownLocation(); } catch (e2) { console.warn('[Avelora] teardown after failed build', e2); }
            const sid = (window.START_LOCATION && window.LOCATIONS[window.START_LOCATION]) ? window.START_LOCATION : id;
            return { spawn: this.buildLocation(sid, null), fallback: true };
        }
    }

    /** Builds terrain, navigation, water, objects and exits of a location. Returns spawn point. */
    buildLocation(id, spawnId) {
        const loc = window.LOCATIONS[id];
        if (!loc) throw new Error(`Unknown location "${id}"`);
        if (!loc.id) loc.id = id;
        window.CURRENT_LOCATION = loc;
        this.location = loc;
        // asset_loader.js: с этого момента считаем, какие модели нужны локации (остальные выгрузятся после загрузки)
        if (window.AveloraAssets) window.AveloraAssets.beginLocation();

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
        // Lighting adjustment (dungeons vs outdoor)
        if (loc.lighting) {
            if (this.hemiLight) {
                if (loc.lighting.hemiSky !== undefined) this.hemiLight.color.setHex(loc.lighting.hemiSky);
                if (loc.lighting.hemiGround !== undefined) this.hemiLight.groundColor.setHex(loc.lighting.hemiGround);
                if (loc.lighting.hemiIntensity !== undefined) this.hemiLight.intensity = loc.lighting.hemiIntensity;
            }
            if (this.sunLight) {
                if (loc.lighting.sunColor !== undefined) this.sunLight.color.setHex(loc.lighting.sunColor);
                if (loc.lighting.sunIntensity !== undefined) this.sunLight.intensity = loc.lighting.sunIntensity;
            }
        } else {
            if (this.hemiLight) {
                this.hemiLight.color.setHex(0x9ec8e8);
                this.hemiLight.groundColor.setHex(0x6e8060);
                this.hemiLight.intensity = 1.8;
            }
            if (this.sunLight) {
                this.sunLight.color.setHex(0xfff5e6);
                this.sunLight.intensity = 0.85;
            }
        }

        this.grottos = (loc.grottos && loc.grottos.length && window.AveloraGrotto)
            ? loc.grottos.map(cfg => new AveloraGrotto(this.locationRoot, cfg, this.terrain, this.pathfinder))
            : [];
        this.dungeon = (loc.dungeon && window.AveloraDungeon)
            ? new AveloraDungeon(this.locationRoot, loc.dungeon, this.terrain, this.pathfinder)
            : null;
        this.environment = new LakesideEnvironment(this.locationRoot, this.terrain, this.pathfinder, loc);
        this.worldObjects = window.AveloraWorldObjects ? new AveloraWorldObjects(this, loc) : null;
        this.building = window.AveloraBuilding ? new AveloraBuilding(this, loc) : null;   // building.js: player buildings (home camp)
        this.creatures = window.AveloraCreatures ? new AveloraCreatures(this, loc) : null;
        this.harvest = window.AveloraHarvest ? new AveloraHarvest(this, loc) : null;
        this.buildExits(loc);

        return this.resolveSpawn(loc, spawnId);
    }

    /** Releases everything that belongs to the current location. */
    teardownLocation() {
        this.hideObjectTooltip();
        // leaving a dungeon whose boss is dead (any portal / death): the reset countdown starts now
        const od = this.location && this.location.dungeon;
        if (od && od.bossId && this.gameState && this.gameState.getKilled(this.location.id, od.bossId) !== null
            && this.gameState.getKilled(this.location.id, '__exit') === null) {
            this.gameState.setKilled(this.location.id, '__exit', Math.floor(Date.now() / 1000));
        }
        this.exits.forEach(e => { if (e.labelEl) e.labelEl.remove(); });
        this.exits = [];

        if (this.waterfall) { this.waterfall.dispose(); this.waterfall = null; }
        if (this.grottos) { this.grottos.forEach(g => g.dispose()); this.grottos = []; }
        this.cameraBlockers = [];
        if (this.dungeon) { this.dungeon.dispose(); this.dungeon = null; }
        if (this.skills) this.skills.clearAll(); // no projectile/impact survives into the next location
        if (this.combat) { this.combat.cancel(); this.combat.clearTarget(); }
        if (this.map) this.map.clearAll();        // close map panel when leaving location
        if (this.creatures) { this.creatures.dispose(); this.creatures = null; }
        if (this.harvest) { this.harvest.dispose(); this.harvest = null; }
        if (this.building) { this.building.dispose(); this.building = null; }
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
                    // небо всегда на дальней плоскости: отражение воды рисуется с дальностью 50 м (lib/Water.js), небо при этом не обрезается
                    gl_Position.z = gl_Position.w * 0.99999;
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
    async changeLocation(targetId, spawnId, loadingText, position) {
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

        this.showLoading(target.name || targetId, loadingText || 'Дорога ведёт дальше…');
        if (this.gameState) this.gameState.save(); // persists playTime (the respawn/regrow clock)
        await nextFrame();
        await nextFrame();

        this.teardownLocation();
        const builtLoc = this.buildLocationSafe(targetId, spawnId);
        targetId = this.location.id || targetId;
        let spawn = builtLoc.spawn;
        if (position && !builtLoc.fallback) spawn = { x: position.x, z: position.z, r: position.r || 0 };
        if (this.pathfinder && !this.pathfinder.isWalkableWorld(spawn.x, spawn.z)) {
            const safe = this.pathfinder.findNearestWalkableWorld(spawn.x, spawn.z, 120);
            if (safe) spawn = { x: safe.x, z: safe.z, r: spawn.r || 0 };
        }

        this.character.setTerrain(this.terrain);
        this.character.teleport(spawn.x, spawn.z, spawn.r);
        this.cameraTarget.copy(this.character.position);
        this.applyLocationCamera(this.location);
        this.updateCameraPosition(true);

        await Promise.all([this.environment.ready, this.worldObjects ? this.worldObjects.ready : null,
            this.creatures ? this.creatures.ready : null, this.harvest ? this.harvest.ready : null,
            window.AveloraAssets ? window.AveloraAssets.idle() : null]);
        if (window.AveloraAssets) window.AveloraAssets.evictUnused();   // модели прошлой локации — из памяти
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

            // Sit the marker directly on the terrain surface or at explicit Y
            const y = (ex.y !== undefined) ? ex.y : ((this.terrain && this.terrain.getHeightAt) ? this.terrain.getHeightAt(ex.x, ex.z) + 0.04 : 0.04);
            const colorHex = (ex.color !== undefined) ? ex.color : 0xffd98a;
            const pHeight = (ex.height !== undefined) ? ex.height : 3.2;

            const group = new THREE.Group();
            group.position.set(ex.x, y, ex.z);

            const ringGeo = new THREE.RingGeometry(radius * 0.82, radius, 64, 1);
            ringGeo.rotateX(-Math.PI / 2);
            // на открытой местности кольцо повторяет рельеф (иначе на неровной земле видна только «подкова»);
            // у порталов с явным Y (грот, подземелье) пол ровный — оставляем плоским
            const conform = (ex.y === undefined) && this.terrain && this.terrain.getHeightAt;
            if (conform) {
                const rp = ringGeo.attributes.position;
                for (let i = 0; i < rp.count; i++) rp.setY(i, this.terrain.getHeightAt(ex.x + rp.getX(i), ex.z + rp.getZ(i)) + 0.08 - y);
                rp.needsUpdate = true;
            }
            const ringMat = new THREE.MeshBasicMaterial({
                color: colorHex, transparent: true, opacity: 0.55,
                depthWrite: false, blending: THREE.AdditiveBlending
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            group.add(ring);

            // Soft vertical light column (fades upward)
            // столб уходит на 1.2 м под землю (на склоне нижний край не висит в воздухе); шейдер зажимает высоту
            const pDown = conform ? 1.2 : 0.0;
            const pillarGeo = new THREE.CylinderGeometry(radius * 0.9, radius * 0.9, pHeight + pDown, 40, 1, true);
            pillarGeo.translate(0, (pHeight - pDown) * 0.5, 0);
            const pillarMat = new THREE.ShaderMaterial({
                uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(colorHex) } },
                vertexShader: `
                    varying float vH;
                    void main() {
                        vH = clamp(position.y / ${pHeight.toFixed(2)}, 0.0, 1.0);
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
            if (ex.disabled) continue;
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

    /** True while the dungeon `locId` is cooling down: its boss was killed less than dungeon.resetSeconds (played time) ago. */
    dungeonCooling(locId) {
        const L = window.LOCATIONS && window.LOCATIONS[locId];
        const d = L && L.dungeon, st = this.gameState;
        if (!d || !d.bossId || !st) return false;
        // the clock starts when the hero LEAVES the dungeon after the boss kill (killed['__exit'] = wall-clock seconds;
        // it runs while the game is closed; a clock set back counts as elapsed)
        const t = st.getKilled(locId, '__exit');
        if (st.getKilled(locId, d.bossId) === null || st.getKilled(locId, '__cleared') === null || t === null) return false;
        const el = Date.now() / 1000 - t;
        return el >= 0 && el < (d.resetSeconds || 60);
    }

    /**
     * Boss killed: the entrance portal on the surface goes out and an exit portal opens where the boss stood;
     * when the dungeon resets (boss respawned) the exit closes and the entrance is back.
     */
    updateDungeonPortals() {
        const loc = this.location;
        if (!loc || !this.gameState) return;
        for (const ex of this.exits) {
            const target = window.LOCATIONS && window.LOCATIONS[ex.data.to];
            if (!target || !target.dungeon || !target.dungeon.bossId) continue;
            const off = this.dungeonCooling(ex.data.to);
            if (!!ex.disabled !== off) { ex.disabled = off; ex.group.visible = !off; ex.armed = false; }
        }
        const d = loc.dungeon;
        if (d && d.bossId && d.bossExit) {
            const cooling = this.gameState.getKilled(loc.id, d.bossId) !== null && this.gameState.getKilled(loc.id, '__cleared') !== null;   // boss dead -> exit portal open
            const i = this.exits.findIndex(e => e.data.id === d.bossExit.id);
            if (cooling && i < 0) this.buildExits({ exits: [Object.assign({}, d.bossExit)] });
            else if (!cooling && i >= 0) {
                const e = this.exits[i];
                if (e.group && e.group.parent) e.group.parent.remove(e.group);
                if (e.labelEl) e.labelEl.remove();
                this.exits.splice(i, 1);
            }
        }
    }

    updateWorldLabels() {
        if (!this.exits.length) return;
        const w = window.innerWidth, h = window.innerHeight;
        const v = new THREE.Vector3();
        const pp = this.character ? this.character.position : null;
        for (const ex of this.exits) {
            if (!ex.labelEl) continue;
            const pHeight = (ex.data.height !== undefined) ? ex.data.height : 3.2;
            v.set(ex.data.x, ex.y + pHeight + 0.35, ex.data.z).project(this.camera);
            // portal captions only close up (not across the whole location)
            const near = pp && Math.hypot(pp.x - ex.data.x, pp.z - ex.data.z) < PORTAL_LABEL_DIST;
            const visible = !ex.disabled && near && v.z > -1 && v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
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
        this.loadingEl.style.transition = 'none';
        this.loadingEl.style.opacity = '1';
        this.loadingEl.classList.remove('hidden');
        void this.loadingEl.offsetWidth; // force browser layout
        requestAnimationFrame(() => {
            if (this.loadingEl) this.loadingEl.style.transition = '';
        });
    }

    hideLoading() {
        if (!this.loadingEl) return;
        this.loadingEl.style.transition = 'opacity 0.5s ease-out';
        this.loadingEl.classList.add('hidden');
        this.loadingHideTimer = setTimeout(() => { this.loadingEl.style.display = 'none'; }, 550);
    }

    tryLockLandscape() {
        try {
            if (screen.orientation && typeof screen.orientation.lock === 'function') {
                screen.orientation.lock('landscape').catch(() => {});
            }
        } catch (_) {}
    }

    showLocationBanner(name) {
        if (!this.bannerEl || !name) return;
        this.bannerEl.textContent = name;
        this.bannerEl.classList.remove('show');
        void this.bannerEl.offsetWidth; // restart CSS animation
        this.bannerEl.classList.add('show');
    }

    setupLighting() {
        // HemisphereLight: небо (0x9ec8e8) даёт мягкий дневной рассеянный свет,
        // земляной отскок (0x6e8060) убирает чёрные провалы в тени снизу.
        const hemiLight = new THREE.HemisphereLight(0x9ec8e8, 0x6e8060, 1.8);
        hemiLight.position.set(0, 50, 0);
        this.scene.add(hemiLight);
        this.hemiLight = hemiLight;

        // Солнце: даёт направление и тени, но НЕ слепит (0.85 вместо оригинальных 1.45)
        this.sunLight = new THREE.DirectionalLight(0xfff5e6, 0.85);
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

    /**
     * VISUAL_TODO V0.2: применяет профиль GFX (low/high) на лету, без пересоздания сцены.
     * Вызывается на старте (force) и из handleResize (debounce) — срабатывает только при смене профиля.
     */
    applyGraphicsProfile(force = false) {
        const G = window.GFX;
        if (!G) return;
        const changed = G.refresh();
        if (!changed && !force) return;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, G.dpr));
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        const sun = this.sunLight;
        if (sun) {
            // Телефон (GFX.softShadows = false): обычный PCF вместо PCFSoft — заметно дешевле на каждый пиксель
            const shadowType = G.softShadows === false ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
            const typeChanged = this.renderer.shadowMap.type !== shadowType;
            this.renderer.shadowMap.type = shadowType;
            const shadowsChanged = this.renderer.shadowMap.enabled !== G.shadows || typeChanged;
            this.renderer.shadowMap.enabled = G.shadows;
            sun.castShadow = G.shadows;
            if (sun.shadow.mapSize.width !== G.shadowMapSize) {
                sun.shadow.mapSize.set(G.shadowMapSize, G.shadowMapSize);
                if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
            }
            if (shadowsChanged) {
                this.scene.traverse(o => {
                    const m = o.material;
                    if (!m) return;
                    (Array.isArray(m) ? m : [m]).forEach(mm => { mm.needsUpdate = true; });
                });
            }
        }
        if (this.scene.fog && this._fogBase !== undefined) this.scene.fog.density = this._fogBase * G.fogMul;
        document.body.classList.toggle('gfx-low', G.tier === 'low');
        document.body.classList.toggle('gfx-high', G.tier === 'high');
        // Отражение воды (lib/Water.js читает AVELORA_WOPT.throttle каждый кадр): раз в N кадров
        if (window.AVELORA_WOPT && G.waterThrottle) window.AVELORA_WOPT.throttle = G.waterThrottle;
        if (this.environment && this.character && this.character.position) {
            this.environment._cullT = 1;
            this.environment.updateCulling(0, this.character.position);
        }
        this.needsRender = true;
    }

    setupEvents() {
        const handleResize = () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
            if (this.isCharacterSelectOpen) {
                this.camera.position.set(-0.35, 1.15, 2.7);
                this.camera.lookAt(-0.35, 0.95, 0);
            }
            this.needsRender = true; // resize clears the canvas; redraw even if paused
            clearTimeout(this._gfxTimer);
            this._gfxTimer = setTimeout(() => this.applyGraphicsProfile(), 150);
        };
        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', () => {
            handleResize();
            setTimeout(handleResize, 100);
            setTimeout(handleResize, 300);
        });
        document.addEventListener('fullscreenchange', () => {
            handleResize();
            setTimeout(handleResize, 100);
            setTimeout(handleResize, 300);
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
                if (!this.isPaused && this.building && this.building.onEscape()) return;   // placement mode / build menu
                // Escape closes open windows first (bag + skills + hero + quests + micromenu + potion), otherwise toggles pause
                const skillsOpen = this.ui && this.ui.isSkillsOpen();
                const heroOpen = this.ui && this.ui.isHeroOpen && this.ui.isHeroOpen();
                const questsOpen = this.ui && this.ui.isQuestsOpen && this.ui.isQuestsOpen();
                const microMenuOpen = this.ui && this.ui.isMicroMenuOpen && this.ui.isMicroMenuOpen();
                const potionOpen = this.ui && this.ui.isPotionOpen && this.ui.isPotionOpen();
                const chestOpen = this.ui && ((this.ui.isChestOpen && this.ui.isChestOpen()) || (this.ui.isDialogOpen && this.ui.isDialogOpen()));
                if (!this.isPaused && chestOpen) {
                    if (this.worldObjects) this.worldObjects.closeChest(); else this.ui.closeChest();
                    if (this.isInventoryOpen) this.setInventoryOpen(false);
                } else if (!this.isPaused && (this.isInventoryOpen || skillsOpen || heroOpen || questsOpen || microMenuOpen || potionOpen)) {
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
            } else if (e.code === 'F4') { // debug: show/hide hover/click hit cylinders (hitboxes.js)
                e.preventDefault();
                if (window.AveloraHitDebug) {
                    const on = window.AveloraHitDebug.toggle(this);
                    if (this.ui && this.ui.floatText) this.ui.floatText(on ? 'Хитбоксы: показаны (F4)' : 'Хитбоксы: скрыты', 'info');
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

        const pauseExitBtn = document.getElementById('pause-exit-btn');
        if (pauseExitBtn) {
            pauseExitBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.confirm('Вы действительно хотите выйти из игры? Весь прогресс сохранён.')) return;
                this.saveProgress();
                if (this.gameState) this.gameState.save();

                // 1. Android Native Bridges (WebView JavascriptInterface)
                if (window.Android && typeof window.Android.exitApp === 'function') { window.Android.exitApp(); return; }
                if (window.Android && typeof window.Android.closeApp === 'function') { window.Android.closeApp(); return; }
                if (window.AndroidBridge && typeof window.AndroidBridge.closeApp === 'function') { window.AndroidBridge.closeApp(); return; }
                if (window.AveloraApp && typeof window.AveloraApp.exit === 'function') { window.AveloraApp.exit(); return; }

                // 2. Cordova / Capacitor
                if (navigator.app && typeof navigator.app.exitApp === 'function') { navigator.app.exitApp(); return; }
                if (navigator.device && typeof navigator.device.exitApp === 'function') { navigator.device.exitApp(); return; }

                // 3. Web Window Close (handles WebChromeClient.onCloseWindow)
                try {
                    window.close();
                } catch (_) {}

                // 4. Exit fullscreen if active so mobile system navigation reappears
                try {
                    const doc = document;
                    const exitFs = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
                    if (exitFs && (doc.fullscreenElement || doc.webkitFullscreenElement)) {
                        exitFs.call(doc).catch(() => {});
                    }
                } catch (_) {}

                // 5. Fallback if browser policy blocks window.close():
                // Safely dismiss pause menu, return to character select, and notify user
                if (this.pauseOverlay) this.pauseOverlay.classList.remove('open');
                this.showCharacterSelect(false);
                this.showLocationBanner('Игра сохранена');
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

        // FPS counter toggle — lives in Settings, remembered in localStorage ('avelora_fps_counter').
        this.fpsEl = document.getElementById('fps-counter');
        const fpsToggle = document.getElementById('fps-toggle');
        const setFpsCounter = (on) => {
            this.fpsCounterEnabled = !!on;
            if (this.fpsEl) {
                this.fpsEl.style.display = this.fpsCounterEnabled ? 'block' : 'none';
                if (!this.fpsCounterEnabled) this.fpsEl.textContent = '';
            }
            this._fpsSmoothed = undefined;
            this._fpsAccum = 0;
        };
        let savedFps = false;
        try { savedFps = localStorage.getItem('avelora_fps_counter') === 'true'; } catch (_) {}
        setFpsCounter(savedFps);
        if (fpsToggle) {
            fpsToggle.checked = savedFps;
            fpsToggle.addEventListener('change', (e) => {
                setFpsCounter(e.target.checked);
                try { localStorage.setItem('avelora_fps_counter', e.target.checked ? 'true' : 'false'); } catch (_) {}
            });
        }

        // «Экономная графика» (только ПК; на телефоне всегда экономная и строки в настройках нет).
        // Выбор запоминается (gfx_profile.js, 'avelora_gfx_quality'), по умолчанию — полная графика.
        const gfxRow = document.getElementById('gfx-eco-row');
        const gfxToggle = document.getElementById('gfx-eco-toggle');
        const G0 = window.GFX;
        if (gfxRow && G0 && G0.isPhone) gfxRow.style.display = 'none';
        if (gfxToggle && G0) {
            gfxToggle.checked = G0.quality() === 'eco';
            gfxToggle.addEventListener('change', (e) => {
                G0.setQuality(e.target.checked ? 'eco' : 'high');
                this.applyGraphicsProfile();
            });
        }

        // Mobile visual joystick setting
        this.lastManualCamTime = 0;
        let savedJoyVisual = null;
        try { savedJoyVisual = localStorage.getItem('avelora_joy_visual'); } catch (_) {}
        if (savedJoyVisual === 'false') {
            document.body.classList.add('joy-visual-hidden');
        } else {
            document.body.classList.remove('joy-visual-hidden');
        }
        const joyToggle = document.getElementById('joystick-toggle');
        if (joyToggle) {
            joyToggle.checked = !document.body.classList.contains('joy-visual-hidden');
            joyToggle.addEventListener('change', (e) => {
                this.setVisualJoystick(e.target.checked);
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

        const orientBtn = document.getElementById('orient-lock-btn');
        if (orientBtn) {
            orientBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.tryLockLandscape();
                const doc = document.documentElement;
                const req = doc.requestFullscreen || doc.webkitRequestFullscreen || doc.mozRequestFullScreen || doc.msRequestFullscreen;
                if (req) req.call(doc).catch(() => {});
            });
        }

        // PC Mouse Controls (LMB: Click to Move, RMB: Drag to Rotate Camera)
        window.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') return; // Handled by touch events below
            if (this.isPaused) return;
            if (e.button === 0) {
                if (!(e.target && e.target.closest && e.target.closest(UI_SELECTOR))) this.leftDown = true;
                if (this.viewMode === 'first') {
                    // first person: LMB acts on what is under the mouse (RMB held = pure movement/look)
                    if (!this.isRightMouseDown) this.handleGroundClick({ fpAim: true, clientX: e.clientX, clientY: e.clientY, target: e.target });
                } else if (!this.isRightMouseDown) {   // RMB held: LMB+RMB = run forward, not click-to-move
                    this.handleGroundClick(e);
                }
            } else if (e.button === 2) {
                this.isRightMouseDown = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            }
        });

        window.addEventListener('pointerup', (e) => {
            if (e.pointerType === 'touch') return;
            if (e.button === 0) this.leftDown = false;
            if (e.button === 2) {
                this.isRightMouseDown = false;
            }
            this.syncMouseButtons(e);
        });
        window.addEventListener('blur', () => { this.moveKeys = {}; this.leftDown = false; this.isRightMouseDown = false; });
        // First-person movement keys (physical keys: work in any layout)
        const MOVE_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
        window.addEventListener('keydown', (e) => {
            if (!MOVE_CODES.includes(e.code)) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            this.moveKeys[e.code] = true;
            if (this.viewMode === 'first' && e.code.startsWith('Arrow')) e.preventDefault();
        });
        window.addEventListener('keyup', (e) => { delete this.moveKeys[e.code]; });
        this.setupJoystick();

        window.addEventListener('pointermove', (e) => {
            // Remember where the pointer last was over the world (skills aim there);
            // over HUD elements the previous world position is kept.
            if (e.pointerType === 'touch') {
                if (this.viewMode !== 'first') this.lastPointer.type = 'touch';
                return;
            }
            this.inputTouch = false;   // a real mouse is in use: it aims (first person too)
            if (!(e.target && e.target.closest && e.target.closest(UI_SELECTOR))) {
                this.lastPointer.x = e.clientX;
                this.lastPointer.y = e.clientY;
                this.lastPointer.type = 'mouse';
                this.lastPointer.valid = true;
                this.lastPointer.overUI = false;
            } else {
                this.lastPointer.overUI = true;
            }
            this.syncMouseButtons(e);
            if (this.isPaused) return;
            if (this.isRightMouseDown) {
                const deltaX = e.clientX - this.lastMouseX;
                this.cameraAngle -= deltaX * 0.007;
                this.targetCameraAngle = this.cameraAngle;
                this.lastManualCamTime = performance.now();
                this.lastMouseX = e.clientX;
                this.tiltCamera(e.clientY - this.lastMouseY, 0.005);   // mouse up/down: look up/down (both views)
                this.lastMouseY = e.clientY;
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
            if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return; // scrolling a panel/list must not zoom the camera
            const now = performance.now();
            this.lastWheelT = now;
            if (now - this.viewSwitchT < 350) return;      // cooldown after a view switch

            // Mode 3: First person
            if (this.viewMode === 'first' || this.camMode === 'first') {
                if (e.deltaY > 0) {
                    // Zoom out: exit back to main mode
                    this.camMode = 'main';
                    this.setViewMode('third');
                }
                return;
            }

            const limits = this.getCameraZoomLimits();
            // Mode 1: Main (0% .. 25%)
            if (this.camMode === 'main') {
                this.cameraDistance = Math.max(limits.main.min, Math.min(limits.main.max, this.cameraDistance + e.deltaY * 0.02));
                this.savedMainDist = this.cameraDistance;
                return;
            }

            // Mode 2: Top-down (25% .. 100%)
            if (this.camMode === 'topdown') {
                this.cameraDistance = Math.max(limits.topdown.min, Math.min(limits.topdown.max, this.cameraDistance + e.deltaY * 0.02));
                this.savedTopdownDist = this.cameraDistance;
                return;
            }
        }, { passive: true });

        // Camera button: cycle through 3 camera modes (Main -> Top-down -> 1st Person -> Main)
        const camBtn = document.getElementById('cam-btn');
        if (camBtn) {
            camBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.isPaused) return;
                this.cycleCamMode();
            });
        }

        // Mobile Touch Gestures (1-finger: Tap to Move, 2-finger: Pinch Zoom & Rotate)
        this.touchStartPos = { x: 0, y: 0 };
        this.touchMoved = false;
        this.touchStartedOnUI = false;
        this.touchStartDist = 0;
        this.touchStartAngle = 0;
        this.touchInitialCamDist = this.cameraDistance;
        this.touchInitialCamAngle = this.cameraAngle;

        window.addEventListener('touchstart', (e) => {
            this.tryLockLandscape();
            this.inputTouch = true;
            document.body.classList.add('touch-ui');
            if (this.viewMode !== 'first') this.lastPointer.type = 'touch'; // skills fire straight ahead after touch input
            // Touch screens: a finger on the right half of the screen rotates the camera (both 1st and 3rd person)
            const onUI = !!(e.target && e.target.closest && e.target.closest(UI_SELECTOR));
            if (!this.isPaused && !onUI) {
                for (const t of e.changedTouches) {
                    if (this.lookTouchId === null && t.clientX > window.innerWidth * 0.42) {
                        this.lookTouchId = t.identifier;
                        this.touchLast = { x: t.clientX, y: t.clientY };
                        this.lookStart = { x: t.clientX, y: t.clientY, t: performance.now() };
                    }
                }
            }
            if (this.viewMode === 'first') {
                if (this.isPaused || onUI) return;
                if (e.touches.length === 2 && !this.joy.active) {   // two free fingers: pinch out = back to third person
                    this.touchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                    this.pinchSwitched = false;
                    this.fpPinch = true;
                }
                return;
            }
            if (this.isPaused || onUI) {
                this.touchStartedOnUI = true;
                return;
            }
            this.touchStartedOnUI = false;
            if (e.touches.length === 1) {
                this.touchStartPos.x = e.touches[0].clientX;
                this.touchStartPos.y = e.touches[0].clientY;
                this.touchMoved = false;
            } else if (e.touches.length === 2 && !this.joy.active) {
                this.pinchSwitched = false;
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                this.touchStartDist = Math.hypot(dx, dy);
                this.touchStartAngle = Math.atan2(dy, dx);
                this.touchInitialCamDist = this.cameraDistance;
                this.touchInitialCamAngle = this.cameraAngle;
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            // finger on the right half: rotate + tilt the camera (not while two free fingers pinch)
            if (!this.isPaused && this.lookTouchId !== null && (e.touches.length === 1 || this.joy.active || this.viewMode === 'first')) {
                for (const t of e.changedTouches) {
                    if (t.identifier === this.lookTouchId && this.touchLast) {
                        const dx = t.clientX - this.touchLast.x;
                        const dy = t.clientY - this.touchLast.y;
                        if (Math.hypot(dx, dy) > 2) this.touchMoved = true;
                        this.cameraAngle -= dx * 0.006;
                        this.targetCameraAngle = this.cameraAngle;
                        this.lastManualCamTime = performance.now();
                        this.tiltCamera(dy, 0.004);
                        this.touchLast = { x: t.clientX, y: t.clientY };
                    }
                }
            }
            if (this.viewMode === 'first') {
                if (this.isPaused) return;
                if (e.touches.length === 2 && this.fpPinch && !this.joy.active && !this.pinchSwitched) {
                    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                    if (this.touchStartDist > 0 && d > this.touchStartDist * 1.3) {
                        this.pinchSwitched = true;
                        this.camMode = 'main';
                        this.setViewMode('third');
                    }
                }
                if (e.cancelable) e.preventDefault();
                return;
            }
            if (this.isPaused || e.target.closest(UI_SELECTOR)) return;
            if (e.touches.length === 1) {
                const dist = Math.hypot(
                    e.touches[0].clientX - this.touchStartPos.x,
                    e.touches[0].clientY - this.touchStartPos.y
                );
                if (dist > 12) {
                    this.touchMoved = true;
                }
            } else if (e.touches.length === 2 && !this.joy.active) {
                e.preventDefault(); // Prevent native browser pinch zoom of page
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const currentDist = Math.hypot(dx, dy);
                const currentAngle = Math.atan2(dy, dx);

                // Pinch to Zoom
                if (this.touchStartDist > 0) {
                    const factor = this.touchStartDist / currentDist;
                    const limits = this.getCameraZoomLimits();
                    if (this.viewMode === 'first' || this.camMode === 'first') {
                        if (factor > 1.3 && !this.pinchSwitched) {
                            this.pinchSwitched = true;
                            this.camMode = 'main';
                            this.setViewMode('third');
                        }
                    } else if (!this.pinchSwitched) {
                        const raw = this.touchInitialCamDist * factor;
                        if (this.camMode === 'main') {
                            this.cameraDistance = Math.max(limits.main.min, Math.min(limits.main.max, raw));
                            this.savedMainDist = this.cameraDistance;
                        } else {
                            this.cameraDistance = Math.max(limits.topdown.min, Math.min(limits.topdown.max, raw));
                            this.savedTopdownDist = this.cameraDistance;
                        }
                    }
                }

                // Two-finger Rotation (third person only)
                if (this.viewMode !== 'first' && !this.pinchSwitched) {
                    const deltaAngle = currentAngle - this.touchStartAngle;
                    this.cameraAngle = this.touchInitialCamAngle - deltaAngle * 1.3;
                    this.targetCameraAngle = this.cameraAngle;
                }
            }
        }, { passive: false });

        const fpTouchEnd = (e) => {
            for (const t of e.changedTouches) {
                if (t.identifier !== this.lookTouchId) continue;
                this.lookTouchId = null;
                // short tap on the right half = action at the crosshair
                const ls = this.lookStart;
                if (e.type === 'touchend' && ls && this.viewMode === 'first' && !this.isPaused
                    && performance.now() - ls.t < 300 && Math.hypot(t.clientX - ls.x, t.clientY - ls.y) < 14) {
                    this.handleGroundClick({ fpAim: true, aimCenter: true, target: null });
                }
            }
            if (e.touches.length < 2) this.fpPinch = false;
        };
        window.addEventListener('touchcancel', fpTouchEnd);
        window.addEventListener('touchend', (e) => {
            fpTouchEnd(e);
            const justUiTap = (performance.now() - (window.__avelora_just_ui_tap || 0) < 450);
            const onUI = this.touchStartedOnUI || justUiTap || !!(e.target && e.target.closest && e.target.closest(UI_SELECTOR));
            if (e.touches.length === 0) this.touchStartedOnUI = false;
            if (this.isPaused || onUI || justUiTap) return;
            if (e.touches.length === 0 && !this.touchMoved && this.viewMode !== 'first') {
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

        const shouldOpen = paused && showOverlay;
        if (!shouldOpen && document.activeElement && this.pauseOverlay && this.pauseOverlay.contains(document.activeElement)) {
            try { document.activeElement.blur(); } catch (_) {}
        }
        if (this.pauseOverlay) {
            this.pauseOverlay.classList.toggle('open', shouldOpen);
            this.pauseOverlay.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
        }
        if (paused && showOverlay) {
            if (this.pauseResumeBtn) this.pauseResumeBtn.focus({ preventScroll: true });
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
        if (!open && document.activeElement && this.inventoryPanel && this.inventoryPanel.contains(document.activeElement)) {
            try { document.activeElement.blur(); } catch (_) {}
        }
        if (this.inventoryPanel) {
            this.inventoryPanel.classList.toggle('open', open);
            this.inventoryPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
        if (this.inventoryBtn) this.inventoryBtn.classList.toggle('active', open);
        if (this.ui) this.ui.layoutPanels();
    }

    setVisualJoystick(show) {
        document.body.classList.toggle('joy-visual-hidden', !show);
        try { localStorage.setItem('avelora_joy_visual', show ? 'true' : 'false'); } catch (_) {}
        const joyToggle = document.getElementById('joystick-toggle');
        if (joyToggle) joyToggle.checked = show;
        if (this.ui && this.ui.floatText) {
            this.ui.floatText(show ? 'Отображение джойстика: Вкл' : 'Отображение джойстика: Скрыто', 'info');
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
        // First person: only crosshair actions (fpAim), never walking to a ground point
        const fpAim = this.viewMode === 'first';
        if (fpAim && !e.fpAim) return;
        if (this.combat && this.combat.isDead) return;
        if (this.building && this.building.handleWorldClick(e)) return;   // placing a building: the click is its own

        const center = fpAim && e.aimCenter;   // touch: the screen centre (crosshair)
        this.mouse.x = center ? 0 : (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = center ? 0 : -(e.clientY / window.innerHeight) * 2 + 1;

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

        if (performance.now() - (window.__avelora_just_ui_tap || 0) < 450) return;

        // A click out in the world closes the chest window (unless it is the chest itself)
        if (this.worldObjects && this.worldObjects.openContainer) {
            const hitChest = this.worldObjects.pickContainerAt(this.raycaster);
            if (!hitChest || hitChest !== this.worldObjects.openContainer) this.worldObjects.closeChest();
        }

        // Clicked elsewhere: stop melee engagement / chopping, but KEEP selectedTarget (deselected only via portrait click or death)
        if (this.combat) {
            this.combat.cancel();
        }

        // Click on an item pile: walk there and pick it up on arrival (world_objects.js)
        if (this.worldObjects) {
            const pile = this.worldObjects.pickAt(this.raycaster);
            if (pile) {
                this.worldObjects.requestPickup(pile);
                return;
            }
            const chest = this.worldObjects.pickContainerAt(this.raycaster);
            if (chest) {
                this.worldObjects.requestOpenContainer(chest);
                return;
            }
            this.worldObjects.cancelPending(); // clicked elsewhere: forget the pending pickup
        }

        // Tree (or another harvestable environment object): chop with a chop tool, else walk there
        if (this.harvest) {
            const entry = this.pickEnvironmentObject();
            if (entry && this.harvest.isHarvestable(entry) && this.harvest.request(entry)) return;
        }

        if (fpAim) return;
        let intersects = this.raycaster.intersectObject(this.terrain.mesh);
        // walking on a plank deck: the floor of a building is hit before the ground under it
        const floorHit = this.building ? this.building.pickFloor(this.raycaster) : null;
        if (floorHit && (!intersects.length || floorHit.distance < intersects[0].distance)) intersects = [floorHit];

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
        if (!this.isReady || this.isTransitioning || !this.environment || (this.building && this.building.placing)) {
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
        const chestHover = this.worldObjects ? this.worldObjects.pickContainerAt(this.raycaster) : null;
        if (chestHover) {
            this.showObjectTooltip(this.worldObjects.labelOfContainer(chestHover), e.clientX, e.clientY);
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

    /**
     * The 2nd mouse button pressed while another is held does NOT fire pointerdown (and the
     * first release does not fire pointerup) — so LMB/RMB state is re-read from e.buttons.
     */
    syncMouseButtons(e) {
        if (e.pointerType === 'touch') return;
        this.leftDown = !!(e.buttons & 1);
        const r = !!(e.buttons & 2);
        if (r && !this.isRightMouseDown) {
            this.isRightMouseDown = true;
            this.lastMouseX = e.clientX; this.lastMouseY = e.clientY;
        } else if (!r && this.isRightMouseDown) {
            this.isRightMouseDown = false;
        }
    }

    /** Mouse / finger drag up-down: first person looks up/down, third person raises/lowers the camera. */
    tiltCamera(dy, k) {
        if (this.viewMode === 'first') {
            this.fpPitch = Math.max(-1.0, Math.min(1.0, this.fpPitch - dy * k));
        } else {
            // drag up = look up = camera goes lower
            this.camPitchOffset = Math.max(-0.3, Math.min(0.5, this.camPitchOffset + dy * k * 0.8));
        }
    }

    /** Mobile virtual joystick (compact racing style, works with touch and mouse). */
    setupJoystick() {
        const zone = document.getElementById('joy-zone');
        const base = document.getElementById('joy-base');
        const knob = document.getElementById('joy-knob');
        if (!zone || !base || !knob) return;
        const checkTouch = () => {
            // Класс ставится и СНИМАЕТСЯ по текущим условиям: при сенсорном экране, сужении окна <= 880
            // или альбомной ориентации мобильного экрана (высота <= 540) включается мобильный HUD.
            const hwTouch = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
                'ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) || this.inputTouch;
            const isMobileScreen = window.innerWidth <= 880 || (window.innerHeight <= 540 && window.innerWidth > window.innerHeight);
            document.body.classList.toggle('touch-ui', !!(hwTouch || isMobileScreen));
        };
        checkTouch();
        window.addEventListener('resize', checkTouch);
        const maxRadius = 70;
        const reset = () => {
            this.joy.active = false;
            this.joy.id = null;
            this.joy.x = 0;
            this.joy.y = 0;
            knob.style.transform = 'translate(0px, 0px)';
            base.classList.remove('active');
        };

        const handleMove = (clientX, clientY) => {
            const rect = base.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const dx = clientX - centerX;
            const dy = clientY - centerY;
            const dist = Math.hypot(dx, dy);

            let clampedX = dx;
            let clampedY = dy;
            if (dist > maxRadius) {
                clampedX = (dx / dist) * maxRadius;
                clampedY = (dy / dist) * maxRadius;
            }

            knob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
            let nx = clampedX / maxRadius;
            let ny = -clampedY / maxRadius;
            if (Math.hypot(nx, ny) < 0.1) { nx = 0; ny = 0; } // dead zone
            this.joy.x = nx;
            this.joy.y = ny;
        };

        zone.addEventListener('pointerdown', (e) => {
            if (this.joy.active) return;
            e.preventDefault();
            this.joy.active = true;
            this.joy.id = e.pointerId;
            try { zone.setPointerCapture(e.pointerId); } catch (_) {}
            base.classList.add('active');
            handleMove(e.clientX, e.clientY);
        });

        zone.addEventListener('pointermove', (e) => {
            if (!this.joy.active || e.pointerId !== this.joy.id) return;
            e.preventDefault();
            handleMove(e.clientX, e.clientY);
        });

        const up = (e) => {
            if (e.pointerId === this.joy.id) {
                e.preventDefault();
                reset();
            }
        };
        zone.addEventListener('pointerup', up);
        zone.addEventListener('pointercancel', up);
        this._joyReset = reset;
    }

    /** First person: skills aim at the screen centre (crosshair); tooltip of whatever is under it. */
    updateFpAim(delta) {
        const touchAim = this.viewMode === 'first' && !!this.inputTouch;
        document.body.classList.toggle('aim-center', touchAim);   // crosshair is shown only for touch aiming
        if (!touchAim) return;                                    // mouse: the real cursor aims
        const lp = this.lastPointer;
        lp.x = window.innerWidth / 2; lp.y = window.innerHeight / 2; lp.type = 'mouse'; lp.valid = true; lp.overUI = false;
        this._hoverT = (this._hoverT || 0) - delta;
        if (this._hoverT <= 0) {
            this._hoverT = 0.1;
            this.handleHover({ clientX: lp.x, clientY: lp.y, target: null });
        }
    }

    /**
     * Direct (WoW-style) movement in both views: WASD / arrows, LMB+RMB, joystick.
     * Click-to-move (third person) still works; manual input simply takes over.
     * First person and "RMB held": the hero faces where the camera looks (backpedal/strafe slower);
     * otherwise he turns toward the direction he walks.
     */
    updateDirectMove(delta) {
        const c = this.character;
        if (!c || !c.driveStep) return;
        const fp = this.viewMode === 'first';
        if (this.combat && this.combat.isDead) {
            if (c.driving) c.driveStep(0, 0, 0);
            return;
        }
        const k = this.moveKeys;
        // keyboard turning (arrows): right = camera angle decreases
        const turn = (k.ArrowLeft ? 1 : 0) - (k.ArrowRight ? 1 : 0);
        if (turn) { this.cameraAngle += turn * 2.2 * delta; this.targetCameraAngle = this.cameraAngle; }

        const rmb = this.isRightMouseDown;
        let fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
        let str = (k.KeyD || k.KeyE ? 1 : 0) - (k.KeyA || k.KeyQ ? 1 : 0);
        if (this.leftDown && rmb) fwd += 1;      // WoW: LMB+RMB = forward

        // Hybrid joystick input:
        // 1st person: pure FPS stick (joy.y = fwd/back, joy.x = pure sideways strafe, camera orientation unchanged)
        // 3rd person: 360-degree movement relative to current camera heading
        fwd += this.joy.y;
        str += this.joy.x;

        const mag = Math.hypot(fwd, str);
        if (mag > 1) { fwd /= mag; str /= mag; }
        const a = this.cameraAngle;
        const faceCam = fp || rmb;
        const manual = mag > 0.01;

        if (faceCam && (fp || manual || !c.isMoving || c.driving)) {   // hero looks where the camera looks
            c.currentRotation = a; c.targetRotation = a; c.isTurning = false;
        }
        if (manual) {   // steering by hand: drop auto-chase / auto-walk / click-to-move
            if (this.combat && this.combat.engagement) this.combat.cancel();
            if (this.worldObjects && this.worldObjects.cancelPending) this.worldObjects.cancelPending();
        }
        const sp = c.moveSpeed * ((k.ShiftLeft || k.ShiftRight) ? 0.5 : 1);
        let vx, vz;
        const fx = -Math.sin(a), fz = -Math.cos(a), rx = Math.cos(a), rz = -Math.sin(a);
        if (faceCam) {
            const fSp = (fwd < 0 ? 0.6 : 1) * fwd, rSp = 0.85 * str;
            vx = (fx * fSp + rx * rSp) * sp;
            vz = (fz * fSp + rz * rSp) * sp;
        } else {
            vx = (fx * fwd + rx * str) * sp;
            vz = (fz * fwd + rz * str) * sp;
            if (manual && !c.isCasting && !c.isAttacking) {   // turn toward the walking direction
                const tr = Math.atan2(vx, vz) + Math.PI;
                let diff = tr - c.currentRotation;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                c.targetRotation = tr; c.isTurning = false;
                c.currentRotation += diff * Math.min(1, 14 * delta);

                // Smart subtle camera follow (3rd person only):
                // Triggers ONLY when continuously running mostly forward (fwd > 0.65, |str| < 0.4),
                // ONLY after a 1.8s cooldown from manual camera rotation,
                // and NEVER when backing up / strafing / rotating camera by hand.
                const now = performance.now();
                const sinceManualCam = now - (this.lastManualCamTime || 0);
                const isRunningForward = fwd > 0.65 && Math.abs(str) < 0.4;
                if (!rmb && this.lookTouchId === null && isRunningForward && sinceManualCam > 1800) {
                    let camDiff = tr - this.cameraAngle;
                    while (camDiff < -Math.PI) camDiff += Math.PI * 2;
                    while (camDiff > Math.PI) camDiff -= Math.PI * 2;
                    const followSpeed = 1.4; // gentle, smooth centering
                    this.cameraAngle += camDiff * Math.min(1.0, followSpeed * delta);
                    this.targetCameraAngle = this.cameraAngle;
                }
            }
        }
        const pf = this.pathfinder;
        c.driveStep(delta, vx, vz, pf ? (x, z) => !pf.isWalkableWorld(x, z) : null);
    }

    /** 'first' | 'third'. Hides the whole hero body in first person, shows the crosshair. */
    setViewMode(mode) {
        if (mode === this.viewMode) return;
        this.viewMode = mode;
        this.viewSwitchT = performance.now();
        this.isRightMouseDown = false;
        if (this.character && this.character.driveStep) this.character.driveStep(0, 0, 0);
        this.leftDown = false; this.lookTouchId = null;
        if (this._joyReset) this._joyReset();
        if (this.hideObjectTooltip) this.hideObjectTooltip();
        if (this.creatures) this.creatures.hovered = null;
        if (mode === 'first') {
            this.camMode = 'first';
            if (this.character && this.character.isMoving) this.character.stopMovement(); // drop any click-to-move path
            this.fpPitch = 0;
            if (this.hideObjectTooltip) this.hideObjectTooltip();
        } else {
            if (this.camMode === 'first') this.camMode = 'main';
            const limits = this.getCameraZoomLimits();
            if (this.camMode === 'main') {
                this.cameraDistance = Math.max(limits.main.min, Math.min(limits.main.max, this.savedMainDist || limits.main.def));
            } else {
                this.cameraDistance = Math.max(limits.topdown.min, Math.min(limits.topdown.max, this.savedTopdownDist || limits.topdown.def));
            }
        }
        document.body.classList.toggle('fp-view', mode === 'first');
        this.applyBodyVisibility();
        this.updateCameraPosition(true);
    }

    applyBodyVisibility() {
        const m = this.character && this.character.mesh;
        if (m) m.visible = this.viewMode !== 'first';
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

        // ---- First person: camera sits at the hero's eyes ----
        const fp = this.viewMode === 'first';
        const wantFov = fp ? this.fpFov : this.thirdFov;
        if (Math.abs(this.camera.fov - wantFov) > 0.05) {
            this.camera.fov = instant ? wantFov : this.camera.fov + (wantFov - this.camera.fov) * (1 - Math.exp(-10 * delta));
            this.camera.updateProjectionMatrix();
        }
        this.applyBodyVisibility();
        if (fp) {
            const p = this.character.position;
            this.cameraTarget.copy(p);
            const yaw = this.cameraAngle, pit = this.fpPitch, cp = Math.cos(pit);
            const ex = p.x - Math.sin(yaw) * 0.12, ey = p.y + this.fpEyeHeight, ez = p.z - Math.cos(yaw) * 0.12;
            this.camera.position.set(ex, ey, ez);
            this.camera.lookAt(ex - Math.sin(yaw) * cp, ey + Math.sin(pit), ez - Math.cos(yaw) * cp);
        }

        // Target tracks character smoothly
        if (fp) {
            // (camera already placed above)
        } else if (instant) {
            this.cameraTarget.copy(this.character.position);
        } else {
            this.cameraTarget.lerp(this.character.position, 0.08);
        }

        // Camera pitch eases with zoom: flatter/lower angle when zoomed in
        // (cinematic close-up), back to the classic top-down angle when
        // zoomed back out. zoomT: 0 at minDistance (fully zoomed in), 1 at
        // maxDistance (fully zoomed out).
        const zoomT = Math.max(0, Math.min(1, (this.cameraDistance - this.minDistance) / (this.maxDistance - this.minDistance)));
        const targetPitch = Math.max(0.08, Math.min(1.35, this.pitchZoomedIn + (this.pitchZoomedOut - this.pitchZoomedIn) * zoomT + this.camPitchOffset));
        if (instant) {
            this.cameraPitch = targetPitch;
        } else {
            // Frame-rate-independent exponential ease: reaches the same point
            // in the same wall-clock time regardless of FPS (unlike a fixed
            // per-frame multiplier, which would ease slower on lower FPS).
            const pitchLerp = 1 - Math.exp(-this.pitchEaseRate * delta);
            this.cameraPitch += (targetPitch - this.cameraPitch) * pitchLerp;
        }

        if (!fp) {
            const hDist = this.cameraDistance * Math.cos(this.cameraPitch);
            const vDist = this.cameraDistance * Math.sin(this.cameraPitch);

            let cx = this.cameraTarget.x + Math.sin(this.cameraAngle) * hDist;
            let cz = this.cameraTarget.z + Math.cos(this.cameraAngle) * hDist;
            let cy = this.cameraTarget.y + vDist;

            // Подземелья: настоящие столкновения камеры со стенами/сводом пещеры и склепа
            // (в обычных локациях можно задать коробку cameraBounds)
            const dng = this.dungeon && this.dungeon.constrainCamera ? this.dungeon : null;
            const headPt = { x: this.cameraTarget.x, y: this.cameraTarget.y + 1.4, z: this.cameraTarget.z };
            const wantCam = { x: cx, y: cy, z: cz };
            const outdoor = !dng && this.terrain && !(this.location && this.location.isDungeon);
            if (dng) {
                dng.constrainCamera(wantCam, headPt);
                cx = wantCam.x; cy = wantCam.y; cz = wantCam.z;
            } else if (outdoor) {
                this.constrainCameraOutdoor(wantCam, headPt);
                cx = wantCam.x; cy = wantCam.y; cz = wantCam.z;
            } else if (this.location && this.location.cameraBounds) {
                const b = this.location.cameraBounds;
                if (typeof b.minX === 'number') cx = Math.max(b.minX, Math.min(b.maxX, cx));
                if (typeof b.minZ === 'number') cz = Math.max(b.minZ, Math.min(b.maxZ, cz));
                if (typeof b.minY === 'number') cy = Math.max(b.minY, Math.min(b.maxY, cy));
            }

            if (instant) {
                this.camera.position.set(cx, cy, cz);
            } else {
                // Быстрее подтягиваем камеру, если она упирается в стену (без «проезда» сквозь камень)
                if (!this._camLerpTmp) this._camLerpTmp = new THREE.Vector3();
                this.camera.position.lerp(this._camLerpTmp.set(cx, cy, cz), 0.12);
                if (dng || outdoor) {
                    const cp = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
                    if (dng) dng.constrainCamera(cp, headPt); else this.constrainCameraOutdoor(cp, headPt);
                    this.camera.position.set(cp.x, cp.y, cp.z);
                }
            }

            this.camera.lookAt(this.cameraTarget.x, this.cameraTarget.y + 1.2, this.cameraTarget.z);
        }

        // Keep sun shadow camera focused near character (snapped to shadow texel grid to prevent shadow edge shimmering)
        if (this.sunLight) {
            const d = Math.max(20, Math.min(46, this.cameraDistance * 1.05 + 4));
            const sc = this.sunLight.shadow.camera;
            if (Math.abs(sc.right - d) > 0.5) {
                sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d;
                sc.updateProjectionMatrix();
            }
            const mapW = (this.sunLight.shadow && this.sunLight.shadow.mapSize && this.sunLight.shadow.mapSize.width) || 1024;
            const snap = Math.max(0.05, (2 * d) / mapW);
            const sx = Math.round(this.cameraTarget.x / snap) * snap;
            const sz = Math.round(this.cameraTarget.z / snap) * snap;
            this.sunLight.target.position.set(sx, this.cameraTarget.y, sz);
            this.sunLight.position.set(sx + SUN_OFFSET.x, this.cameraTarget.y + SUN_OFFSET.y, sz + SUN_OFFSET.z);
            this.sunLight.target.updateMatrixWorld();
        }

        if (this.skyDome) {
            this.skyDome.position.set(this.camera.position.x, 0, this.camera.position.z);
        }
    }

    /**
     * Камера в открытых локациях: не вылетает за край мира, не уходит под рельеф (горный барьер по периметру,
     * склоны у водопада) и не залезает в крупные скальные модели (вход в грот). Деревья, кусты и прочие мелкие объекты
     * НЕ учитываются — камера по ним скользит, как раньше. Камера притягивается к герою вдоль своего луча,
     * направление взгляда и зум не меняются.
     */
    constrainCameraOutdoor(cam, head) {
        const t = this.terrain;
        if (!t) return cam;
        const dx = cam.x - head.x, dy = cam.y - head.y, dz = cam.z - head.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.5) return cam;
        let k = 1;

        // 1. Край мира (с запасом): дальше только пустота за горами
        const mg = 2.0;
        const hx = (t.halfX !== undefined ? t.halfX : (t.sizeX || 120) / 2) - mg;
        const hz = (t.halfZ !== undefined ? t.halfZ : (t.sizeZ || 120) / 2) - mg;
        if (dx > 0 && head.x + dx * k > hx) k = Math.min(k, Math.max(0, (hx - head.x) / dx));
        if (dx < 0 && head.x + dx * k < -hx) k = Math.min(k, Math.max(0, (-hx - head.x) / dx));
        if (dz > 0 && head.z + dz * k > hz) k = Math.min(k, Math.max(0, (hz - head.z) / dz));
        if (dz < 0 && head.z + dz * k < -hz) k = Math.min(k, Math.max(0, (-hz - head.z) / dz));

        const kBounds = k;

        // 2. Рельеф: камера не уходит в склон между героем и собой
        const N = 14;
        for (let i = 1; i <= N; i++) {
            const s = (i / N) * k;
            const py = head.y + dy * s;
            const gh = t.getHeightAt(head.x + dx * s, head.z + dz * s);
            if (py < gh + 0.5) { k = Math.min(k, Math.max(0, ((i - 1) / N) * k)); break; }
        }

        // 3. Крупные скальные модели (грот): луч от головы к камере
        // не прижимаем камеру вплотную к герою (рельеф); скалы — отдельно, ниже
        const kmin = Math.min(1, 2.5 / dist);
        if (k < 1) k = Math.min(kBounds, Math.max(k, kmin));

        const blockers = this._cameraBlockerModels();
        const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
        for (let i = 0; i < blockers.length; i++) {
            const d = this._modelRayLimit(blockers[i], head, dir, dist * k);
            if (d !== null) k = Math.min(k, Math.max((d - 0.4) / dist, 0.6 / dist));
        }
        cam.x = head.x + dx * k; cam.y = head.y + dy * k; cam.z = head.z + dz * k;
        const g = t.getHeightAt(cam.x, cam.z) + 0.6;
        if (cam.y < g) cam.y = g;
        return cam;
    }

    // Камера и крупные твёрдые объекты. Блокирует любой объект сцены, чья модель (THREE.Object3D)
    // попадает в список: модель водопада, грота или любой Object3D, добавленный через addCameraBlocker().
    // Координаты не зашиты — если объект переставить, коллизия переедет вместе с ним.
    _cameraBlockerModels() {
        const out = [];
        if (this.waterfall && this.waterfall.model) out.push(this.waterfall.model);
        if (this.grottos) this.grottos.forEach(g => { if (g.model) out.push(g.model); });
        if (this.cameraBlockers) this.cameraBlockers.forEach(o => { if (o) out.push(o); });
        return out;
    }

    // Регистрация любого другого крупного объекта как препятствия камеры (деревья/кусты не регистрируем).
    addCameraBlocker(obj) {
        if (!this.cameraBlockers) this.cameraBlockers = [];
        if (obj && !this.cameraBlockers.includes(obj)) this.cameraBlockers.push(obj);
    }

    // Расстояние от origin до ближайшей поверхности модели по лучу (двусторонне) или null.
    // Шаг 51: вместо перебора всех треугольников модели (скалы водопада ~40k, грот ~47k → ~2.4 мс на луч)
    // один раз строится сетка-индекс треугольников в мировых координатах; луч идёт по ячейкам сетки (3D DDA)
    // и проверяет только треугольники в них (обычно десятки–сотни). Точность прежняя — это та же геометрия.
    // Индекс пересобирается, если модель сдвинули/масштабировали.
    _modelRayLimit(model, origin, dir, maxDist) {
        const e = model.matrixWorld.elements;
        const key = e[12].toFixed(2) + ',' + e[13].toFixed(2) + ',' + e[14].toFixed(2) + ',' + e[0].toFixed(3) + ',' + e[5].toFixed(3) + ',' + e[2].toFixed(3);
        let c = model.userData._cb;
        if (!c || c.key !== key) {
            c = model.userData._cb = this._buildRayIndex(model);
            c.key = key;
        }
        if (!c.nTri) return null;
        return this._rayIndexHit(c, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist + 0.5);
    }

    _buildRayIndex(model) {
        model.updateWorldMatrix(true, true);
        const parts = [];
        let nTri = 0;
        const v = new THREE.Vector3();
        model.traverse((o) => {
            if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.attributes.position) return;
            const pos = o.geometry.attributes.position, idx = o.geometry.index;
            const wv = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
                wv[i * 3] = v.x; wv[i * 3 + 1] = v.y; wv[i * 3 + 2] = v.z;
            }
            const n = Math.floor((idx ? idx.count : pos.count) / 3);
            parts.push({ wv, idx, n });
            nTri += n;
        });
        const T = new Float32Array(nTri * 9);
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let w = 0;
        for (const p of parts) {
            for (let t = 0; t < p.n; t++) {
                for (let k = 0; k < 3; k++) {
                    const vi = p.idx ? p.idx.getX(t * 3 + k) : t * 3 + k;
                    const x = p.wv[vi * 3], y = p.wv[vi * 3 + 1], z = p.wv[vi * 3 + 2];
                    T[w++] = x; T[w++] = y; T[w++] = z;
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                }
            }
        }
        if (!nTri) return { nTri: 0 };
        const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
        const cs = Math.max(0.75, ext / 64);
        const nx = Math.max(1, Math.ceil((maxX - minX) / cs) + 1);
        const ny = Math.max(1, Math.ceil((maxY - minY) / cs) + 1);
        const nz = Math.max(1, Math.ceil((maxZ - minZ) / cs) + 1);
        const nCells = nx * ny * nz;
        const cellOf = (x, mn, n) => Math.max(0, Math.min(n - 1, Math.floor((x - mn) / cs)));
        const counts = new Uint32Array(nCells + 1);
        const range = new Int32Array(nTri * 6);
        for (let t = 0; t < nTri; t++) {
            const b = t * 9;
            const x0 = Math.min(T[b], T[b + 3], T[b + 6]), x1 = Math.max(T[b], T[b + 3], T[b + 6]);
            const y0 = Math.min(T[b + 1], T[b + 4], T[b + 7]), y1 = Math.max(T[b + 1], T[b + 4], T[b + 7]);
            const z0 = Math.min(T[b + 2], T[b + 5], T[b + 8]), z1 = Math.max(T[b + 2], T[b + 5], T[b + 8]);
            const r = t * 6;
            range[r] = cellOf(x0, minX, nx); range[r + 1] = cellOf(x1, minX, nx);
            range[r + 2] = cellOf(y0, minY, ny); range[r + 3] = cellOf(y1, minY, ny);
            range[r + 4] = cellOf(z0, minZ, nz); range[r + 5] = cellOf(z1, minZ, nz);
            for (let k = range[r + 4]; k <= range[r + 5]; k++)
                for (let j = range[r + 2]; j <= range[r + 3]; j++)
                    for (let i = range[r]; i <= range[r + 1]; i++) counts[(k * ny + j) * nx + i + 1]++;
        }
        for (let i = 0; i < nCells; i++) counts[i + 1] += counts[i];
        const start = counts;                       // start[cell]..start[cell+1]
        const fill = new Uint32Array(nCells);
        const items = new Uint32Array(start[nCells]);
        for (let t = 0; t < nTri; t++) {
            const r = t * 6;
            for (let k = range[r + 4]; k <= range[r + 5]; k++)
                for (let j = range[r + 2]; j <= range[r + 3]; j++)
                    for (let i = range[r]; i <= range[r + 1]; i++) {
                        const cell = (k * ny + j) * nx + i;
                        items[start[cell] + fill[cell]++] = t;
                    }
        }
        return {
            nTri, T, start, items, cs, nx, ny, nz,
            minX, minY, minZ, maxX: minX + nx * cs, maxY: minY + ny * cs, maxZ: minZ + nz * cs,
            stamp: new Uint32Array(nTri), query: 0
        };
    }

    // Ближайшее пересечение луча (dir — единичный) с треугольниками индекса на [0, maxT] или null.
    _rayIndexHit(c, ox, oy, oz, dx, dy, dz, maxT) {
        // отсечение по коробке сетки
        let t0 = 0, t1 = maxT;
        const slab = (o, d, mn, mx) => {
            if (Math.abs(d) < 1e-12) return o >= mn && o <= mx;
            let a = (mn - o) / d, b = (mx - o) / d;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a; if (b < t1) t1 = b;
            return t0 <= t1;
        };
        if (!slab(ox, dx, c.minX, c.maxX) || !slab(oy, dy, c.minY, c.maxY) || !slab(oz, dz, c.minZ, c.maxZ)) return null;
        const cs = c.cs, nx = c.nx, ny = c.ny, nz = c.nz, T = c.T;
        const ts = t0 + 1e-6;
        let i = Math.max(0, Math.min(nx - 1, Math.floor((ox + dx * ts - c.minX) / cs)));
        let j = Math.max(0, Math.min(ny - 1, Math.floor((oy + dy * ts - c.minY) / cs)));
        let k = Math.max(0, Math.min(nz - 1, Math.floor((oz + dz * ts - c.minZ) / cs)));
        const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
        const INF = Infinity;
        let tMx = Math.abs(dx) < 1e-12 ? INF : (c.minX + (i + (dx > 0 ? 1 : 0)) * cs - ox) / dx;
        let tMy = Math.abs(dy) < 1e-12 ? INF : (c.minY + (j + (dy > 0 ? 1 : 0)) * cs - oy) / dy;
        let tMz = Math.abs(dz) < 1e-12 ? INF : (c.minZ + (k + (dz > 0 ? 1 : 0)) * cs - oz) / dz;
        const tDx = Math.abs(dx) < 1e-12 ? INF : cs / Math.abs(dx);
        const tDy = Math.abs(dy) < 1e-12 ? INF : cs / Math.abs(dy);
        const tDz = Math.abs(dz) < 1e-12 ? INF : cs / Math.abs(dz);
        const q = ++c.query;
        if (q >= 0xfffffff0) { c.stamp.fill(0); c.query = 1; }
        const qq = c.query;
        let best = INF;
        for (let guard = 0; guard < 4096; guard++) {
            const cell = (k * ny + j) * nx + i;
            for (let p = c.start[cell], pe = c.start[cell + 1]; p < pe; p++) {
                const t = c.items[p];
                if (c.stamp[t] === qq) continue;
                c.stamp[t] = qq;
                const b = t * 9;
                const ax = T[b], ay = T[b + 1], az = T[b + 2];
                const e1x = T[b + 3] - ax, e1y = T[b + 4] - ay, e1z = T[b + 5] - az;
                const e2x = T[b + 6] - ax, e2y = T[b + 7] - ay, e2z = T[b + 8] - az;
                const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (det > -1e-12 && det < 1e-12) continue;
                const inv = 1 / det;
                const s0 = ox - ax, s1 = oy - ay, s2 = oz - az;
                const u = (s0 * px + s1 * py + s2 * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = s1 * e1z - s2 * e1y, qy = s2 * e1x - s0 * e1z, qz = s0 * e1y - s1 * e1x;
                const vv = (dx * qx + dy * qy + dz * qz) * inv;
                if (vv < 0 || u + vv > 1) continue;
                const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
                if (tt > 1e-6 && tt < best && tt <= maxT) best = tt;
            }
            const tExit = Math.min(tMx, tMy, tMz);
            if (best <= tExit || tExit > t1) break;
            if (tMx <= tMy && tMx <= tMz) { i += sx; if (i < 0 || i >= nx) break; tMx += tDx; }
            else if (tMy <= tMz) { j += sy; if (j < 0 || j >= ny) break; tMy += tDy; }
            else { k += sz; if (k < 0 || k >= nz) break; tMz += tDz; }
        }
        return best < INF ? best : null;
    }

    updateHUD() {
        if (this.coordsEl && this.character) {
            const p = this.character.position;
            const name = this.currentCharacterConfig ? this.currentCharacterConfig.name : '';
            const text = `${name ? name + '  ' : ''}X: ${p.x.toFixed(1)} | Z: ${p.z.toFixed(1)}`;
            if (this._hudCoordsText !== text) {
                this._hudCoordsText = text;
                this.coordsEl.textContent = text;
            }
        }

        // Update compass needle orientation (pointing North)
        const needle = this._compassNeedleEl || (this._compassNeedleEl = document.getElementById('compass-needle'));
        if (needle) {
            const degStr = (-(this.cameraAngle) * (180 / Math.PI)).toFixed(1);
            if (this._compassDegStr !== degStr) {
                this._compassDegStr = degStr;
                needle.style.transform = `rotate(${degStr}deg)`;
            }
        }
    }

    /**
     * FPS counter — off by default, remembered in localStorage (see the Settings
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
            const inf = this.renderer && this.renderer.info;
            const extra = inf ? ' | calls ' + inf.render.calls + ' | tri ' + Math.round(inf.render.triangles / 1000) + 'k' : '';
            const G = window.GFX;
            this.fpsEl.textContent = Math.round(this._fpsSmoothed) + ' FPS' + extra +
                (G ? ' | ' + G.tier + ' dpr ' + this.renderer.getPixelRatio() + ' cap ' + G.fpsCap : '');
        }
    }

    /**
     * Виньетка рисуется внутри WebGL (один полноэкранный треугольник поверх кадра), а не HTML-слоем
     * с mix-blend-mode: в Firefox композитинг HTML над WebGL-канвасом стоил ~13 пунктов GPU.
     * Отключение: GFX.vignette = false (профиль low) или ?novig=1 (если раскомментирован блок в gfx_profile.js).
     */
    createVignette() {
        this.vigScene = new THREE.Scene();
        this.vigCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mat = new THREE.ShaderMaterial({
            transparent: true, depthTest: false, depthWrite: false,
            vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: [
                'varying vec2 vUv;',
                'void main(){',
                '  vec2 d = (vUv - 0.5) * vec2(1.0, 0.85);',
                '  float r = length(d) * 1.45;',
                '  float a = smoothstep(0.55, 1.15, r);',
                '  vec3 col = mix(vec3(0.07, 0.055, 0.04), vec3(0.03, 0.024, 0.016), a);',
                '  gl_FragColor = vec4(col, a * 0.55);',
                '}'
            ].join('\n')
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        this.vignetteMesh = new THREE.Mesh(geo, mat);
        this.vignetteMesh.frustumCulled = false;
        this.vigScene.add(this.vignetteMesh);
    }

    /** Кадр: сцена + (опционально) виньетка поверх. Единая точка для всех renderer.render в animate(). */
    drawFrame() {
        this.renderer.render(this.scene, this.camera);
        const G = window.GFX;
        if (this.vignetteMesh && G && G.vignette !== false && !G.noVig) {
            const r = this.renderer;
            const info = r.info.autoReset;
            r.info.autoReset = false;            // без сброса счётчика: виньетка добавит +1 call/+1 tri
            r.autoClear = false;
            r.render(this.vigScene, this.vigCam);
            r.autoClear = true;
            r.info.autoReset = info;
        }
    }

    animate() {
        requestAnimationFrame(this.animate);

        // Лимит кадров (GFX.fpsCap, 0 = без лимита): без него на мониторах 120+ Гц GPU рисует 100+ FPS и висит на 80-95%.
        // Расписание: каждый показанный кадр сдвигает _nextFrameAt ровно на 1000/fpsCap, поэтому средний FPS равен лимиту
        // на любой частоте монитора (75/144/165 Гц и т.д.); допуск 3 мс только сглаживает дрожание rAF и не накапливается.
        // Пропущенный кадр не трогает clock, поэтому delta копится и скорость симуляции не меняется.
        if ((!this.isPaused || this.isCharacterSelectOpen) && window.GFX && window.GFX.fpsCap > 0) {
            const nowMs = performance.now();
            const minMs = 1000 / window.GFX.fpsCap;
            if (this._capMs !== minMs) { this._capMs = minMs; this._nextFrameAt = 0; }   // смена профиля — расписание заново
            if (nowMs < (this._nextFrameAt || 0) - 3) return;
            this._nextFrameAt = (nowMs > (this._nextFrameAt || 0) + minMs) ? nowMs + minMs : this._nextFrameAt + minMs;   // после паузы/лага — без «догоняющей» серии кадров
        }

        const delta = Math.min(this.clock.getDelta(), 0.1);
        this.updateFPS(delta);

        // LIVE 3D CHARACTER PREVIEW: updates idle animation in real time
        if (this.isCharacterSelectOpen) {
            if (this.csMixer) this.csMixer.update(delta);
            this.drawFrame();
            return;
        }

        // PAUSED: freeze all simulation (movement, animations, water, wind,
        // particles, markers, camera, timers). Only redraw the frozen frame
        // when the canvas was cleared (window resize).
        if (this.isPaused) {
            if (this.needsRender) {
                this.drawFrame();
                this.needsRender = false;
            }
            return;
        }
        this.needsRender = false;

        // LOADING A LOCATION: simulation frozen, just draw (the loading screen covers it)
        if (this.isTransitioning) {
            this.drawFrame();
            return;
        }

        this.simulate(delta);

        // Render scene
        this.drawFrame();
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
            this.updateDirectMove(delta);
            this.updateFpAim(delta);   // first person: direct movement (no-op in third person)
            this.character.update(delta);   // incl. the procedural swing / death pose overlay
        }
        if (this.combat) this.combat.update(delta);       // melee engagement, pending hits, HP regen
        if (this.hero) this.hero.update(delta);           // mana regeneration
        if (this.creatures) this.creatures.update(delta); // AI, animation, corpses, respawns
        if (this.harvest) this.harvest.update(delta);     // chips, shakes, falling trees, regrow
        if (this.water) {
            this.water.update(delta);
        }
        if (this.waterfall) {
            this.waterfall.update(delta);
        }
        if (this.grottos && this.grottos.length) {
            this.grottos.forEach(g => g.update(delta));
        }
        if (this.dungeon) {
            this.dungeon.update(delta, this.gameTime, this.character ? this.character.position : null);
        }
        if (this.environment) {
            this.environment.update(delta, this.character ? this.character.position : null);
        }
        if (this.worldObjects) this.worldObjects.update(delta); // auto-pickup on arrival
        if (this.building) this.building.update(delta);         // placement ghost, roof fade near/inside buildings
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
        this.updateDungeonPortals();
        this.updateExits(delta);

        // Update camera and HUD
        this.updateCameraPosition(false, delta);
        if (this.creatures && this.creatures.cullToCamera) this.creatures.cullToCamera(this.camera);   // существа вне кадра не рисуются
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
