/**
 * Avelora — Playable Character Catalog
 *
 * Single source of truth for the 3 selectable characters: character-select
 * screen (main.js), the save system (save.js, keyed by `id`) and the
 * character controller (character.js, which reads `modelKey`/`animMap`/etc)
 * all read from here.
 *
 * animMap maps the controller's LOGICAL animation names ('idle', 'run') to
 * the actual clip names baked into that character's .glb — these differ per
 * character because each was rigged/animated separately in Mixamo.
 * `idleFallback: 'run'` means: if the 'idle' clip isn't present (e.g. Arissa
 * before her Idle animation was added), freeze on the first frame of the
 * 'run' clip instead of having no pose at all.
 *
 * `scale` compensates for models that weren't exported at the soldier's
 * real-world scale (1.0 = same as the soldier). Arissa/AzureArchmage came
 * from Meshy AI image-to-3D + Mixamo/FBX2glTF conversion, which does NOT
 * guarantee real-world scale like the soldier's purpose-built rig does.
 * AzureArchmage's export in particular measured ~1/95 scale (bone-chain
 * forward-kinematics height ~0.0185 units vs. the ~1.76 the other two
 * characters stand at) — 95.0 here is a computed correction, not a guess,
 * but still worth eyeballing in-game against the soldier/terrain.
 *
 * `facingOffset` (radians, default 0) corrects character.js's shared
 * heading formula (tuned for the soldier's own rig, whose local forward is
 * -Z) for a model whose rig faces the opposite way. Measured via forward
 * kinematics on the LeftFoot->LeftToeBase bone direction in each model's
 * bind pose: the soldier's toe points -Z, but Arissa's and AzureArchmage's
 * (both Mixamo mixamorig: rigs, unlike the soldier's custom one) point
 * +Z — so without this they walked/ran backwards (facing away from their
 * own direction of travel) whenever the player clicked to move.
 *
 * `handGrip` (optional) places a hand-held item (axe, staff — items with
 * `use.type: 'equip'`) in the right-hand bone: `position` in METERS and
 * `rotation` (Euler XYZ, radians), both in the hand bone's own frame. Item
 * models have their origin at the grip and the shaft along +Y (blade toward +X);
 * character.js setHandItem() cancels the bone's world scale so the item stays
 * real-size. Each rig's hand frame differs, so the values were derived per rig
 * from its idle pose: shaft through the fist toward the thumb side, tipped ~35°
 * down along the fingers, blade edge facing the character's forward direction;
 * position = ~8.5 cm from the wrist along the fingers (the middle of the fist).
 *
 * `maxHp` (default 100): health pool (combat.js; not persisted — full on load).
 * `swing` (optional): per-rig multipliers for the procedural melee swing
 * overlay (character.js SWING_KEYS) — { arm, forearm, spine, hand }, 1 = as
 * authored. The curve works in the character's world frame, so rigs only need
 * this if their idle pose makes the default look off.
 */
window.CHARACTER_CATALOG = [
    {
        id: 'warrior',
        name: 'Воин',
        className: 'Странствующий страж',
        icon: '⚔️',
        modelKey: 'soldier',
        animMap: { idle: 'Idle', run: 'Run' },
        idleFallback: 'run',
        hasTravelerGear: true,   // cloak + staff cosmetic attachment (soldier reskin only)
        hideNodes: ['vanguard_visor'],
        scale: 1.0,
        maxHp: 120,
        handGrip: { position: [-0.002, 0.083, 0.018], rotation: [1.436, -0.504, 1.15] }
    },
    {
        id: 'archer',
        name: 'Лучница',
        className: 'Арисса',
        icon: '🏹',
        modelKey: 'arissa',
        // 'Idle' will exist once we add it (see lib/3d/README.md); until then
        // idleFallback freezes on the first frame of 'Fast Run'.
        animMap: { idle: 'Idle', run: 'Fast Run' },
        idleFallback: 'run',
        hasTravelerGear: false,
        hideNodes: [],
        scale: 1.0,
        facingOffset: Math.PI,
        maxHp: 100,
        handGrip: { position: [0.022, 0.082, -0.004], rotation: [1.482, 0.4, -1.121] }
    },
    {
        id: 'mage',
        name: 'Маг',
        className: 'Азур Аркмаг',
        icon: '🔮',
        modelKey: 'azureArchmage',
        // Rebuilt from lib/mage/'s fresh Idle/Running/Walking/Sitting/Salute
        // exports (merged, root-motion-stripped on Running/Walking, decimated
        // ~183k -> 29,388 tris via gltf-transform simplify). Real clips now
        // exist for all of these, so idleFallback is no longer needed.
        // 'greeting' plays once after IDLE_GREETING_DELAY (character.js) of
        // standing still, then returns to idle.
        // ПРИМЕЧАНИЕ: attack намеренно не указываем в animMap, чтобы для ударов и рубки
        // использовался процедурный взмах оружием startSwing (рубка вперед-вниз лезвием),
        // а не карате-удар рукой/ногой из сырого клипа Meshy AI.
        animMap: { idle: 'Idle', run: 'Running', greeting: 'Greeting', cast: 'Cast' },
        hasTravelerGear: false,
        // Новый молодой боевой маг на родном Meshy AI biped скелете
        scale: 1.05,
        facingOffset: Math.PI,
        maxHp: 90,
        // Топор ориентирован лезвием вперед и вниз (Y = 1.5708 rad = 90 deg)
        handGrip: { position: [0.0, 0.08, 0.0], rotation: [0.0, 1.5708, 0.0] }
    }
];

window.getCharacterConfig = function (id) {
    return window.CHARACTER_CATALOG.find(c => c.id === id) || null;
};
