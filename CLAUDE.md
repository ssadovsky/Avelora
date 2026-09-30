# CLAUDE.md - Avelora Project Context & Guidelines

## 1. Project Overview & Core Philosophy
**Avelora** (forked from the LakeLand prototype) is a 3D Diablo-style medieval lakeside/coastal RPG experience built with **Three.js**.
The game is completely standalone, highly optimized, and follows strict serverless architecture.

---

## 2. THE GOLDEN RULE (CRITICAL - DO NOT VIOLATE)
### 🚨 STRICT SERVERLESS EXECUTION (`file://`)
- The game **MUST** launch by simply double-clicking `Avelora.html` from local disk in ANY browser (Chrome, Edge, Firefox).
- **NEVER** use `fetch()`, `XMLHttpRequest` to local files, or standard `GLTFLoader.load('path.glb')`.
- All binary assets (3D models, textures, heightmaps) **MUST** be loaded as **Base64 Data URLs** via `js/assets_data.js`.
- **NEVER** require the user to run `python -m http.server`, `node server.js`, or any local web server.

---

## 2b. Testing policy (saves the user's usage limit — follow it)
- **Big automated tests are NOT run by default.** The headless-browser suites in
  `temp_work/tests/` (`e2e.py` — 22 checks, several minutes; plus focused scripts) are run
  ONLY when: the user reports a bug, a change touches the systems a suite covers in a risky
  way (save format, input routing, location lifecycle), or the user asks for it.
- **Default after a change = a quick smoke check**: load `Avelora.html` once, start one
  character, confirm no console errors, 1–2 screenshots of what changed. That's it.
- Work in **small steps**; after each step report and wait for the user's go-ahead
  (the user watches the usage limit and approves the next step).
- Tests use headless Chromium (Playwright, swiftshader) against a copy of the game;
  `AVELORA_URL` overrides the page URL, `AVELORA_SHOTS` the screenshot folder.

## 3. Visual & Aesthetic Standards (MAX REALISM)
1. **NO Low-Poly / Blocky / Minecraft aesthetics**:
   - Do NOT use plain procedural primitives (e.g. `ConeGeometry` for trees, colored spheres for bushes).
   - Vegetation uses realistic alpha-cutout textures with cross-quad geometries (`+` or `*`) or decimated realistic GLB models.
2. **Terrain Realism**:
   - Smooth rolling meadow heights (0.3m to 1.8m), natural shoreline slope.
   - PBR multi-texture splatting (sandy beach, lush meadow, rocky slope cliffs).
   - Analytical continuous normals from Simplex noise (NO faceted polygon quads).
3. **Vegetation & Reeds**:
   - Rendered using `THREE.InstancedMesh` for 60+ FPS in 1-2 draw calls.
   - Dynamic vertex shader wind sway using `onBeforeCompile`.
4. **Characters & 3D Standards (Golden Mean / Золотая середина)**:
   - **Target Devices**: Modern smartphones (Samsung Galaxy S20, S21 Ultra, S25) and PC. Old devices like Galaxy S10 are dropped and not targeted.
   - **Character Polycount**: ~50k–60k triangles (AzureArchmage set to ~58k polys). Full PBR textures, colors, roughness, and metalness must be preserved. Do not override materials with dull warrior settings.
   - **Creatures Budget**:
     - Boars: ~35k–45k triangles
     - Fawns: ~25k–30k triangles
     - Small creatures (Rats): ~12k–18k triangles
   - **Mage (AzureArchmage) Rig & Build Rules (Preventing Backwards Running)**:
     - **CRITICAL**: The base Mixamo Agree_Gesture pose has `mixamorig:Hips` rotated ~ -16.1° in yaw. In `temp_work/build_perfect_mage.py`, Hips yaw **MUST** be zeroed out to 0.0° (`clean_hips_q = Euler((hips_eul.x, 0.0, hips_eul.z))`). Missing this causes the sideways-movement backwards running bug when blending Idle and Running!
     - In `characters.js`: Mage uses `facingOffset: Math.PI` and `cast: 'Cast'`.
     - **Idle Posture**: Natural upright stance, slight Spine1 pitch correction (-4°), Head pitch (-17°) and yaw (-3.5°) for a level forward gaze, soft chest breathing (60 frames). No backwards arching ("штырь" is forbidden).
     - **Cast Action**: Strictly dedicated `Cast` animation (right arm raises to shoulder level, 24 frames). Never use `Skill_01` or `Skill_03` for casting.
     - **Pipeline**: Build via `& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python temp_work/build_perfect_mage.py`, then run `python temp_work/build_assets.py`.

---

## 4. Architecture & File Structure

### 🎮 Runtime Files
These files are executed directly by the browser when opening `Avelora.html`:
- `Avelora.html` — Entry point, Diablo HUD (transparent coords readout, compass button, skill bar: ☰ menu button, 10 hotbar slots, skills 📖 button (inline SVG, hidden for characters without skills), inventory 🎒 button last; inventory & skills panels, item tooltip, drag ghost, HP bar), Escape pause menu (with control hints), canvas, and script tags.
- `js/` — Game engine scripts, data bundles, and configs:
  - `js/assets_data.js` — All binary models and textures serialized as Base64 strings in `window.GAME_ASSETS` (incl. `content/` models under keys like `'items/stone'`).
  - `js/content_data.js` — **Generated** from `content/**` by `temp_work/build_assets.py`: `window.GAME_CONTENT = {items, props, skills, characters}`. Never edit by hand — see §7b.
  - `js/world_data.js` — **Level Design Registry**. `window.LOCATIONS`: every location (terrain, water, spawns, exits, groups, decorations).
  - `js/location_groups.js` — **Prefab groups** (`forest`, `reeds`, `rocks`, `meadow`). Expands a one-line group config into individual, seeded, terrain-aware objects (`expandLocationObjects()`).
  - `js/terrain.js` — Procedural PBR terrain with analytical normals, multi-layer texturing, and support for `lake`, `coast`, and `island` water bodies.
  - `js/water.js` — Photorealistic `THREE.Water` surface with Gerstner waves, sun reflection, and dynamic shore foam.
  - `js/character.js` — Player controller, GLTF skeletal animation blending (idle/walk/run), movement interpolation.
  - `js/characters.js` — Character catalog and rig configuration.
  - `js/pathfinding.js` — A* navigation grid with obstacle radius registration and raycast string-pulling line-of-sight smoothing.
  - `js/environment.js` — Instanced foliage manager (reeds, grass, flowers, shrubs, boulders, 3D trees).
  - `js/items.js` — Item registry over `GAME_CONTENT.items` (`AveloraItems`), 32-cell `Inventory` model.
  - `js/game_state.js` — Per-character persistent state (`AveloraState.load(charId)` → `CharacterState`).
  - `js/world_objects.js` — Per-location item piles (`pickups`) and static `props`.
  - `js/skills.js` — Skill registry/casting/cooldowns (`AveloraSkillSystem`).
  - `js/creatures.js` — Creatures: spawn, skinned clone, AI, damage, death/respawn.
  - `js/harvest.js` — Tree chopping: hits, fall, stump, ground drops, regrow.
  - `js/combat.js` — Player HP / death & respawn / melee engagement.
  - `js/ui_hotbar.js` — Hotbar, inventory & skills panels, drag & drop, tooltips.
  - `js/main.js` — Engine loop, game clock & pause, location lifecycle, camera controller.
  - `js/manifest.json` & `js/twa-manifest.json` — PWA and TWA configuration files.
  - `js/sw.js` — Service worker for offline caching.
- `js/lib/` — Standalone vendor scripts (`three.min.js`, `GLTFLoader.js`, `Water.js`, `simplex-noise.js`, `OrbitControls.js`).
- `models/` — Game-ready 3D models (`models/characters/`, `models/buildings/`, `models/environment/`).
- `content/` — Modular data of items / props / skills / creatures (§7b, `content/README.md` in Russian). Bundled into `js/content_data.js` and `js/assets_data.js` by `temp_work/build_assets.py`.

### 🛠️ Developer & Offline Tools (`temp_work/`)
Python scripts and intermediate files are **NEVER** run by the browser. They are offline developer utilities run via terminal.
*(See detailed reference in [`temp_work/README.md`](temp_work/README.md))*:
- `temp_work/build_assets.py` — **Master Asset Bundler**: converts `.glb` models and textures to Base64 in `js/assets_data.js`, and bundles `content/**` into `js/content_data.js`.
- `temp_work/build_perfect_mage.py` — Blender pipeline for assembling AzureArchmage model and animations.
- `temp_work/optimize_tree_model.py` — **GLB Compressor**: downsizes high-res scans.
- `temp_work/lib/` — Exchange folder for raw user-downloaded ZIP archives, scans and materials for processing.

---

## 5. Level Design & Customization — legacy single-location notes (see docs/world_data_help.txt and §7 for the current multi-location system)
To modify or create locations, **only edit `js/world_data.js`**:

### Water Body Configurations:
1. **Sea Coast** (Ocean covering one entire side of the map):
```javascript
waterBody: {
    type: 'coast',
    side: 'west',      // 'west' | 'east' | 'north' | 'south'
    shoreLine: -10.0,  // X or Z coordinate of shore
    depth: -2.2,       // Ocean depth
    beachWidth: 14.0   // Gentle sandy slope width
}
```
2. **Lake Basin** (Fractal enclosed lake):
```javascript
waterBody: {
    type: 'lake',
    x: -14.0, z: 2.0,
    radius: 24.0,
    depth: -1.6
}
```
3. **Island** (Surrounded by water):
```javascript
waterBody: {
    type: 'island',
    radius: 35.0,
    depth: -2.5,
    beachWidth: 12.0
}
```
4. **Dry Land / No Water**:
```javascript
waterBody: {
    type: 'none'
}
```

> 🌊 **Hydrology & Water Table Rule (Puddles & Shallows)**:
> The water plane sits horizontally at **`Y = 0.0`**. Any terrain depression where elevation dips below `Y = 0.0` naturally causes water to peek out through the ground, creating natural puddles, ponds, and marshy hollows (which also get automatically darkened by the wet-soil GLSL shader for `Y < 0.25`).
> - To make a location completely dry, keep terrain elevation above `Y = 0.15` or set `waterBody: { type: 'none' }`.
> - To intentionally create puddles or wetlands, let terrain valleys dip below `Y = 0.0`.


### Adding Objects:
Add `{ x, z, s, r }` to the corresponding array in `decorations`:
- `x, z`: Horizontal map coordinates (meters).
- `s`: Scale (e.g. `1.0` = 100%).
- `r`: Rotation around vertical Y axis (radians).
- *Height Y is calculated automatically by the terrain engine.*

To add groups quickly:
```javascript
grass: [
    ...createCluster(centerX, centerZ, radius, count, scaleMin, scaleMax),
    { x: 10, z: 5, s: 1.2, r: 0.5 }
]
```

---

## 6. How to Add New 3D Models or Textures
1. Keep models game-ready (< 2–3 MB, reasonable polygon count).
2. Place `.glb` or `.jpg`/`.png` in `temp_work/temp_models/` or `temp_work/temp_tex/`.
3. Add the file path to `models` or `textures` dictionary in `temp_work/build_assets.py`.
4. Run:
   ```powershell
   cd temp_work
   python build_assets.py
   ```
5. `assets_data.js` in project root will be updated automatically.
6. Reference in code using `window.GAME_ASSETS.models.<id>` or `window.GAME_ASSETS.textures.<id>`.

---

## 7. Locations, Transitions & Prefab Groups

Full player-facing guide: `docs/world_data_help.txt`. Summary for future coding work:

- **One session, many locations.** `AveloraGame` owns the renderer, camera, character, sun and
  the single `LakesideWater` instance for the whole session. Everything specific to a location
  (terrain mesh, nav grid, foliage, exit markers) lives under `this.locationRoot`
  (a `THREE.Group`) and is fully disposed (`teardownLocation()`: geometries, materials, textures)
  before the next one is built. `changeLocation(targetId, spawnId)` shows the loading screen,
  tears down, rebuilds, teleports the character, then fades the loading screen out.
- **`window.LOCATIONS[id]`** is the single source of truth; `window.CURRENT_LOCATION` is kept in
  sync for old code that still reads it, but new code should prefer `game.location`.
- **Start location**: `window.START_LOCATION` in `world_data.js`, overridable for testing with
  `index.html#locationId`.
- **Exits** (`location.exits[]`): a glowing ring + world-space label (`#world-labels` div,
  projected every frame in `updateWorldLabels()`). Crossing one (having been outside it first —
  `armed` flag prevents an instant re-trigger right after arrival) calls `changeLocation`.
- **Spawns** (`location.spawns{}`): named arrival points; an exit's `spawn` field picks one on the
  target location. `resolveSpawn()` falls back to `spawns.default`, then legacy `playerSpawn`.
- **Groups** (`location.groups[]`, expanded by `location_groups.js`): `forest` / `reeds` / `rocks`
  / `fernPatch` / `meadow` presets scatter objects with a seeded PRNG (`mulberry32`), respecting the terrain
  surface (land / shallow water / shore) and avoiding `exits`, `spawns` and `clearings`. Every
  generated object gets an id (`"<groupId>.<kind><n>"`) so it can be targeted individually later.
  Prefer groups over hand-placed `decorations` for anything larger than a handful of objects —
  a hand-drawn ring of reeds around a lake (what the LakeLand prototype did) looks artificial;
  `reeds` clumps do not.
- **Terrain is now per-location**: `size`, `seed` (SimplexNoise seed — different seed = different
  hills), `baseHeight` (raise it for small ponds so they don't create stray puddles nearby) and
  `waterBody` all come from `location.terrain`. The visible mesh extends `border` (default 28 m)
  past `size` so the camera never sees the world's edge; keep exits/spawns inside `size`.
- **`water.js`** creates ONE `THREE.Water` (with its own reflection render target) for the whole
  session; `setLocation()` only resizes/repositions its plane and swaps the foam mesh.
  `waterBody.type: 'none'` hides it, skipping the reflection render pass entirely — use it for
  locations that don't need water rather than a huge `depth`.

### ⚙️ Performance notes (target: mid-range phones, e.g. Galaxy S10)
- **Frustum culling matters a lot here.** `InstancedMesh` in the bundled three.js r128 defaults
  `frustumCulled = false` (its default bounding sphere ignores per-instance transforms), so
  without help EVERY chunk of grass/reeds/trees is drawn every frame regardless of camera
  direction. `environment.js` gives each chunk's `InstancedMesh` a real bounding sphere
  (covering all its instances) and turns `frustumCulled` back on — this alone cut rendered
  triangles by roughly half at default zoom in both shipped locations. Keep `ENV_CHUNK_SIZE`
  (20 m) small enough that culling has something to cull, but not so small that chunk/draw-call
  overhead dominates.
- **The shadow map camera tracks zoom** (`main.js`, `updateCameraPosition`): its ortho box grows
  with `cameraDistance` instead of always covering the maximum zoom-out. Zoomed in, this shrinks
  the shadow pass's object count and sharpens shadows for free.
- **The water reflection pass is the single most expensive thing on screen** (it re-renders the
  visible scene into a 512×512 render target every frame). It's created once per session, not per
  location; `waterBody.type: 'none'` is the only way to skip it.
- **`assets_data.js` is ~19 MB and loads entirely up front**, for every location. Adding a new
  model/texture grows the load time of every location, not just the one that uses it. Keep new
  assets small (§6) and prefer reusing existing models via `groups`/`decorations` over adding new
  ones for minor variety.
- No FPS numbers are recorded here — they haven't been measured on real hardware. Re-measure on a
  real mid-range Android device (not just desktop swiftshader) before trusting any number.
- **Alpha-cutout foliage should not cast shadows** (fixed 2026-09-24 for `reeds`/`ferns`,
  matching `grass`/`dandelions` which already had this): the shadow depth pass can't skip
  the fragment shader on `alphaTest`-enabled material (no early-z), so every blade/leaf pays
  full per-fragment shadow cost for a shadow that reads as near-nothing on thin cross-quad
  geometry anyway. `environment.js`'s `buildInstanced(kind, parts, items, placeFn, opts)`
  takes `{ castShadow: false }` per foliage kind for this. This was reported as `lakeLand`
  specifically dropping to ~39 fps on a desktop GTX 1080 right after entering (same with
  every character, ruling out any one character's model) — `lakeLand` has ~290 reed
  instances across 7 reed groups vs. `forestEdge`'s single 60-instance group, so it was
  paying this cost far harder than the other shipped location. This alone brought it from
  ~39 to ~63 fps, but a further drop was still reported specifically whenever the lake was
  in camera view (not away from it) — pointing at the water reflection pass, not shadows.
- **Dense/cheap-to-skip foliage is also excluded from the water reflection render**
  (`reflect: false` opt, same `buildInstanced` call, 2026-09-24): `THREE.Water`
  (`lib_js/Water.js`, vendor code, not modified) renders the ENTIRE visible scene a SECOND
  time from an internal mirror camera every frame the water is on screen — so anything
  skipped there is pure win with no vendor-file edit needed. The trick is `THREE.Layers`:
  the mirror camera is a bare `new THREE.PerspectiveCamera()` we never touch, so it only
  ever sees the default layer 0. `buildInstanced(..., { reflect: false })` puts that kind's
  InstancedMesh on layer 1 ONLY (`mesh.layers.set(1)`) instead of the default — invisible to
  the mirror camera, but the main game camera and the hover raycaster both explicitly
  `layers.enable(1)` (`main.js`, alongside their default layer 0), so normal viewing and
  hovering reeds/ferns (they're in `HOVER_KINDS`) still work exactly as before. Currently
  applied to reeds/grass/ferns/dandelions — the exact same kinds that already got
  `castShadow: false` above, for the same reason: a wave-distorted reflection of hundreds of
  individual blades/petals reads as noise, so it isn't worth doubling that many draws for.
  Trees/shrubs/boulders stay reflected (far fewer instances, and a real reflected trunk/rock
  actually reads as one). If a NEW instanced foliage kind is added later and turns out to be
  similarly dense, consider the same two opts rather than assuming it's cheap by default.
  If a location still runs slow after this, profile before guessing further — don't assume
  it's the same cause a third time; get real numbers (the FPS counter, §7 above, or a
  browser's GPU/perf profiler) rather than reasoning from code alone.
- **FPS counter** (2026-09-24): a Settings toggle in the pause menu shows a live FPS readout
  bottom-left (`#fps-counter`, `AveloraGame.updateFPS()`). Off by default and intentionally
  **not persisted** — every load/reload starts with it off, per explicit product decision, not an
  oversight; don't wire it into `save.js` or localStorage. It's computed from the real
  `requestAnimationFrame` delta and — unlike gameplay timers — deliberately keeps updating while
  paused, since it measures the render loop itself, not game simulation (same "bookkeeping, not
  gameplay" exemption from the Date.now()/setTimeout ban as `AUTOSAVE_INTERVAL_MS`).

## 7b. Items, inventory, hotbar & skills

**Data lives in `content/`, engine code in the root JS files.** Full field reference and
"how to add" steps (Russian, for the level/content designer): `content/README.md`.

- **Folders**: `content/items/<id>/item.json`, `content/props/<id>/prop.json`,
  `content/skills/<id>/skill.json` (+ optional `model.glb`, `icon.png`; `preview.png` is
  ignored), `content/characters/<charId>/skills.json` (`{"skills": [...]}` — no file = no
  skills, skills button hidden). Folder name = `id`. After ANY edit run
  `python temp_work/build_assets.py` (file:// can't fetch JSON → it's bundled into
  `content_data.js`; models go to `assets_data.js` as `'<category>/<id>'`).
- **Missing assets never break the game**: no model → small neutral fallback mesh
  (`AveloraItems.makeFallback`), no icon → first-letter tile (`ui_hotbar.js makeIcon`).
- **Model conventions**: glTF +Y up, meters; top-level `variant_0..N`; ground items/props
  origin bottom-center (logs along X); hand-held items origin at the grip, shaft +Y, blade +X.

### Persistence (`game_state.js`)
- Separate key **`avelora_state_<charId>`** = `{version:1, characterId, inventory: Array(32)
  of {item,count}|null, hotbar: Array(10) of {type:'skill'|'item', id}|null,
  pickupsTaken: {<locationId>: {<pickupId>: takenCount}}, equipped: {right: itemId|null}}`.
  The position save (`save.js`, `avelora_save_<id>`, v1, 20 s heartbeat) is untouched —
  old saves keep working; a save without a state key = empty bag, all pickups present.
- **Write-on-change**: `CharacterState.save()` runs immediately after every mutation
  (pickup, bag/hotbar rearrange, equip) + once on `beforeunload`. No timer. Mutate through
  `state.inventory.*` / `setHotbar` / `swapHotbar` / `setEquipped` / `addTaken`+`save()`.
- **Load never crashes**: corrupt/unknown version → empty; sanitized (unknown items/skills
  dropped, counts clamped to `stackMax`, foreign skills removed from the bar, `equipped`
  only if still carried). `deleteSave()` ("Начать заново") also removes the state key; if that
  character is live, `gameState.discard()` stops the in-memory copy from being re-saved.
  Character switch: `startGame()` saves the outgoing state, loads the incoming one.

### Pickups & props (`world_data.js` → `world_objects.js`)
- `pickups: [{id, item, count, x, z, y?, r?, rotation?}]` — displayed = count − taken (per
  character, by `id` — renaming an id respawns it). Piles show ≤8 models laid out by
  `item.ground.pile` (`heap` / `stack` / `single`), seeded by the pickup id. `y` = height
  above ground, `rotation` = Euler for a single item (e.g. the axe stuck in the stump).
- Hover → `#object-tooltip` "Камень ×5" (invisible generous hit-cylinder per pile). Click →
  pathfind there, auto-pickup within 1.6 m (`PICKUP_RANGE`); clicking elsewhere cancels.
  Full bag → partial pickup + "Сумка полна". Floating "+N name" text, bag button pulses.
- `props: [{id, prop, x, z, r?, s?}]` — static model + nav obstacle
  (`max(prop.obstacle·s, 0.55)`: nav cells are 0.75 m). Groups (`location_groups.js`)
  keep grass/trees off pickups and props.
- **Ground drops** (dynamic piles): state `ground: {<loc>: [{uid, item, count, x, z, r}]}`
  (optional field, v1 saves load as empty). Dragging a bag cell and releasing it over the WORLD
  (outside every `UI_SELECTOR` element) drops the whole stack ~0.85 m in front of the character
  on walkable ground (`dropFromInventory`); the equipped item gets unequipped, hotbar bindings
  stay (greyed). Same-item drops within 0.8 m merge (3 m once a location has 40+ piles).
  `addDrop(item, count, x, z)` is the API for future loot/tree drops. Pile ids `ground:<uid>`.
- Everything is under `locationRoot`; `WorldObjects.dispose()` also frees the templates.

### Hotbar (`ui_hotbar.js`)
- 10 slots, `e.code` Digit1..Digit0 (any layout) or click/tap; ignored while paused / not
  ready / char-select open / typing. **Only actions**: skills always; items only with a
  non-null `use` — materials are rejected (red flash + "Нельзя: у предмета нет действия").
- Item slot = binding by id: shows total count, greyed out when the character has none.
  `use.type: 'equip'` toggles the item in the right hand (`character.setHandItem()`:
  parented to the `…RightHand` bone, bone world scale cancelled so it stays real-size,
  per-rig `handGrip {position (m), rotation}` in `characters.js` = a "carry a tool" frame
  (shaft through the fist, tipped forward-down, blade forward); optional per-item
  `item.json hold {rotation, position}` on top of it (the staff uses it to stand upright);
  warrior's cosmetic staff hides while something is held). `equipped` persists and is re-applied on load.
- Drag & drop uses **pointer events** (HTML5 DnD doesn't work on touch): skills panel →
  slot, bag → slot, bag → bag (swap/merge), slot → slot (swap), slot → off the bar (clear).
  Draggables have `touch-action: none`; all these elements are in `UI_SELECTOR` so they never
  cause ground clicks/touch-walks. Same binding dropped elsewhere moves (no duplicates).
- Skills panel (`K`, book button left of the bag) and inventory (`I`) can both be open:
  side by side on desktop, stacked (top/bottom) on phones. Escape closes them first.

### Skills (`skills.js`)
- Skill behaviour is written once per `type`, parameterised by `skill.json`. `projectile`:
  aim = terrain point under the last **world** mouse position (`game.lastPointer`, not
  updated over HUD), clamped to `range`; after touch input / no hit → straight ahead at
  full range. Cooldown on game time (starts at activation; during cooldown the slot shakes).
  `castTime`: character stops and turns (`character.faceTowards()`, in-place turning), then
  the projectile leaves the right-hand bone. Impact on reaching the point, range, terrain,
  or trees/boulders/shrubs/props (cylinder tests). Fires `window` **`game:skillImpact`**
  `{skillId, point, radius, damage, amount}` — the hook for future enemies (`damage` unused yet).
- **VFX**: canvas-generated textures (once), pooled sprites/points/lines (6 projectiles,
  6 impacts, 360 sparks); per-frame path allocates nothing; no runtime lights. Trail and
  sparks are two `THREE.Points` draw calls (tiny custom shader, per-point size/RGBA).
  Additive light washes out on the bright meadow, so every effect has a dark NORMAL-blended
  underlay (halo behind the projectile, scorch under the impact) — keep that when adding
  skills. Shaders are pre-compiled (`prewarm()`) when a character with skills starts.
  Frozen on pause (only `update(delta)` moves anything); `clearAll()` on location change /
  character switch.

### Adding things (short version — details in `content/README.md`)
- **Item**: `content/items/<id>/item.json` (+model/icon) → build → place via `pickups`.
- **Skill**: `content/skills/<id>/skill.json` with an existing `type` → add its id to
  `content/characters/<charId>/skills.json` → build. A new `type` needs a branch in
  `AveloraSkillSystem.activate()` (+ its own update/VFX).
- **Prop**: `content/props/<id>/prop.json` + `model.glb` → build → `props` in `world_data.js`.
- New runtime files must also go into `sw.js` `ASSETS_TO_CACHE`.

## 7c. Player health, death & melee (`combat.js`)
- **HP**: `characters.js maxHp` (warrior 120, archer 100, mage 90), NOT persisted (full on load /
  character switch / respawn). `#hp-bar` = trough + `#hp-fill` + `#hp-text` "75 / 120"; red
  `#damage-vignette` flash on every hit (+ faint pulse under 30 %); regen 5 %/s after 6 s without
  dealing or taking damage. API: `game.combat.damagePlayer(n, source)`, `heal(n)`.
- **Death**: procedural fall (`character.startDeathFall()`, no rig has a death clip) → "Вы погибли"
  (`#death-overlay`) → respawn at the location's DEFAULT spawn with full HP after ~2.9 s (game
  timers, frozen on pause). Input, exits and the hotbar are ignored while dead.
- **Melee**: weapon = right-hand item's `item.json weapon {damage:[min,max], range, cooldown, chop?}`
  via `AveloraItems.weaponOf()`, or `BARE_HANDS` (1–3, 1.2 m, 0.9 s). `combat.engage(target)` with
  `{kind, label, isValid(), x(), z(), radius, range(w), onHit(w)}` walks into reach (re-paths while
  the target moves), faces it and swings every `cooldown` until it's invalid or the player clicks
  elsewhere (`combat.cancel()` in `handleGroundClick`). Creatures (`attackCreature`) and trees
  (harvest) plug in through this interface — see TODO.md steps 3–4.
- **Swing**: procedural overlay after `mixer.update` (`character.js SWING_KEYS`, applied in the
  character's WORLD frame so one curve fits all rigs; per-rig multipliers `characters.js swing`).
  Hit lands at `SWING_HIT_FRAC` (55 %). Overlay rotations are restored every frame before the mixer.
- **Tests/debug**: `game.debugAdvance(seconds)` fast-forwards the simulation (headless GPUs are
  slow); `temp_work/tests/combat_smoke.py`.

## 7d. Tree harvesting (`harvest.js`, `content/nodes/tree/node.json`)
- Click a tree with a `weapon.chop` item in the right hand → `combat.engage()` walks to the trunk
  and swings; every hit: wood chips (pooled Points) + a damped shake of that instance
  (`environment.setObjectTransform`). After `hits` (5) the tree FALLS away from the player
  (temporary one-instance copy, accelerating fall + bounce, then sinks/frees), the instance is
  hidden (`setObjectVisible`, bumps `environment.version` → Spark stops colliding), a stump prop
  (`worldObjects.addProp`, id `stump:<treeId>`) appears and the `drops` land as ground piles
  (`worldObjects.addDrop`) along the trunk. Without a chop tool: tooltip "Дерево — нужен топор в
  руке", click just walks there.
- Persistence: state `felled[loc][treeId] = playTime`; `playTime` (played seconds, main.js
  `simulate()`) is the regrow clock. On location build felled trees stay hidden until
  `regrowMinutes` passed; live check every few game seconds → scale-in regrow, stump removed.
  Partial hits are not persisted. Debug: `game.debugAddPlayTime(sec)`;
  test `temp_work/tests/chop_smoke.py`.

## 7e. Creatures (`creatures.js`, `content/creatures/<id>/creature.json`)
- Spawns: `world_data.js` location `creatures: [{id, type, x, z, r?}]` (currently 4 rats in
  forestEdge). Model parsed once per type per location, cloned per spawn with a skinned clone
  (skeleton rebound; materials cloned per instance for the red hit flash). Clips crossfade:
  Idle/Walk/Run/Attack/Hit/Death; missing model/clips → procedural fallback.
- AI: idle/wander (walkSpeed, around home) → `aggressive` aggroes within `aggroRadius`,
  `retaliate` only after being damaged → chase (runSpeed; nav-grid LOS steering or A* re-path)
  → attack (damage at ~45 % of the Attack clip via `combat.damagePlayer`) → leash back home
  (full heal) beyond `leashRadius` or when the player dies (`combat.respawn` → `resetAll()`).
- Damage: melee via `combat.attackCreature(rec)` (click priority creature > pile > tree >
  ground); Spark via `game:skillImpact` splash + direct hit (`hitTest`). Floating numbers, DOM HP
  bar over the creature while damaged/hovered, tooltip = name.
- Death: Death clip → corpse ~8 s → sinks → removed; persisted `killed[loc][id] = playTime`,
  respawn after `respawnMinutes` of played time (live check + on location build).
- Test: `temp_work/tests/rat_smoke.py`.

## 8. Controls
- **Left Mouse Button (LMB)**: Click/hold to move with A* pathfinding and obstacle avoidance.
- **Right Mouse Button (RMB)**: Drag to rotate camera around the character.
- **Mouse Wheel**: Zoom in / out. Camera elevation (pitch) eases along with zoom
  (2026-09-24) — flatter/lower angle (`pitchZoomedIn`, 25°) when fully zoomed in,
  back to the classic top-down Diablo angle (`pitchZoomedOut`, ~50°, the original
  fixed value) when fully zoomed out, interpolated linearly by distance. The ease
  itself is frame-rate-independent exponential smoothing (`pitchEaseRate`, real
  `delta` passed into `updateCameraPosition()`) rather than a fixed per-frame lerp
  factor, so it reaches the target in the same wall-clock time regardless of FPS —
  no snapping. Same behavior on mobile pinch-zoom, since both drive the shared
  `cameraDistance`.
- **Compass Button (Top Right)**: Click to smoothly reset camera orientation to North (Google Maps style).
- **Mobile Touch**: 1-finger tap/drag to walk, 2-finger pinch to zoom, 2-finger drag to rotate.
- **I key / 🎒 button (last slot of skill bar)**: Toggle inventory panel (32 cells, drag to rearrange; does not pause the game). Escape closes it first if open.
- **K key / 📖 button (left of the bag, only for characters with skills)**: Toggle skills panel.
- **1…9, 0 / tap on a hotbar slot**: Use the bound skill/item (see §7b). Drag skills/usable items onto the bar; drag a slot off the bar to clear it.
- **Click/tap an item pile**: Walk there and pick it up.
- **Escape / ☰ button (first slot of skill bar)**: Pause menu — Продолжить / Выбор персонажа / Настройки / Управление. "Управление" and "Настройки" are buttons that open their own small popup within the pause overlay (`#pause-panel-controls` / `#pause-panel-settings`, toggled via `AveloraGame.showPausePanel('main'|'controls'|'settings')`) rather than being inlined, to keep the main pause panel short; Escape backs out of a popup to the main panel first, then closes pause on a second press. Control hints live ONLY in the "Управление" popup — there is no on-screen hint banner. "Настройки" currently has one item: an FPS-counter toggle (see §7).

### ⏸️ Pause & Game Time Rule (for combat, cooldowns, buffs, spawns)
- While paused, `animate()` in `main.js` skips ALL simulation updates (character, mixer animations, water, wind, particles, click markers, camera, timers) and does not re-render (except once after a resize).
- All gameplay logic MUST advance only via the `delta` passed from `animate()` or via `game.gameTime`.
- **NEVER** use `Date.now()`, `performance.now()`, `setTimeout` or `setInterval` for gameplay timing — they keep ticking during pause. Use `game.setGameTimeout(cb, seconds)` / `game.clearGameTimeout(id)` instead.
- Shader time uniforms must be accumulated from `delta` (see `water.js`, `environment.js`), not from wall-clock time.
- New input handlers must ignore input when `game.isPaused` is true. UI elements that should not trigger ground clicks go into `UI_SELECTOR` in `main.js`.
- Systems can listen to `window` events `game:pause` / `game:resume`.

---

## 8b. Third-party UI assets
- Inventory button icon: replaced (2026-09-24) with the user's own photo of a
  leather satchel (source: `lib/JiUj2.jpg` — an earlier `lib/OQKU1.jpg` pick
  was swapped out the same day for being too dark, no license/attribution
  needed either way). Cropped to the bag, padded to a square on black,
  resized to 256×256, brightness/contrast nudged up slightly so it still
  reads at 38px on the dark skill bar, and recompressed as JPEG q88 (~18 KB)
  — inlined as a base64 `<img>` in `index.html`'s `#inventory-btn` (was the
  "Backpack" icon by Delapouite, game-icons.net, CC BY 3.0 — no longer used,
  no attribution owed).

## 9. Roadmap & Architecture: Cloud Save & Multiplayer (Planned)

### 💾 A. Local-First Cloud Save (Firebase Firestore + localStorage)
**Philosophy**: Zero-cost, 100% offline-first reliability. No background socket spam every 5 seconds. Cloud operations happen strictly **on conscious demand** by the player.

1. **Storage Tier 1 (Primary / Offline)**:
   - All gameplay states (player coordinates `{x, z}`, active location ID, stats, inventory) are saved instantly into `localStorage` (`avelora_save_state`).
   - Enables instant loading, zero latency, and full functionality in offline / `file://` mode.
2. **Storage Tier 2 (On-Demand Cloud Sync via Firebase Firestore)**:
   - Uses free Google Firebase Spark Plan (20,000 writes/day, 50,000 reads/day).
   - **"Save to Cloud" (Облачный сейв)**:
     - Player clicks button in menu.
     - Takes state from `localStorage`, adds UTC timestamp, and writes to Firestore document: `saves/{user_uuid}`.
   - **"Load from Cloud" (Облачная загрузка)**:
     - Player clicks button (or inputs their save code / account token).
     - Fetches document from Firestore.
     - **Crucial**: Overwrites local `localStorage` with fetched data, then hot-reloads player position and world state.
   - **Identity**: Anonymous Auth (UID generated and stored locally) or simple 6-digit sync code for transferring saves between PC and phone.

### 🌐 B. Cooperative Multiplayer for 2–5 Players (WebRTC / PeerJS)
- **Technology**: Peer-to-Peer DataChannels via `PeerJS` (free public signaling).
- **No dedicated server required**: Host creates room with short code (e.g. `LAKE-42`), up to 4 guests connect directly.
- **Data payload**: Coordinates `{x, z, r, anim}` transmitted P2P 20 times/sec with minimal latency.


### Character yaw rule (root cause of "running backwards/sideways", fixed 2026-09-30)
- NEVER set the character's yaw via `mesh.quaternion.setFromAxisAngle(...)` and then keep writing `mesh.rotation.y = ...`. A yaw > 90° decomposes into Euler (PI, PI - y, PI); later writes to `.rotation.y` alone leave x/z = PI and MIRROR the model (effective yaw = PI - y) -> backwards/sideways running that depended on the saved heading at load (`combat.bindCharacter()` -> `resetDeathPose()`).
- Always use `mesh.rotation.set(0, currentRotation + facingOffset, 0)` (character.js update/teleport/resetDeathPose). Only `applyDeathPose()` may use quaternions (tilt), and `resetDeathPose()` clears it.
- The earlier "Hips yaw -16°" and `cos(diff)` explanations were misdiagnoses of this bug.
