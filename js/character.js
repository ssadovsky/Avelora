/**
 * Medieval Character Controller: loads any of CHARACTER_CATALOG's models
 * (characters.js), with per-character animation-name mapping & optional
 * cosmetic gear attachment (soldier's cloak+staff only). Smooth animation
 * blending & path tracking are shared across all characters.
 */
// Seconds of standing idle before a "greeting" gesture plays (only for
// characters whose animMap defines a 'greeting' clip, e.g. the mage's wave).
const IDLE_GREETING_DELAY = 30;

/**
 * Procedural melee SWING (none of the rigs has an attack clip). Applied AFTER
 * mixer.update() as extra rotations on top of whatever clip is playing:
 * spine twist/lean + right shoulder/arm/forearm/hand. Every rotation is
 * expressed in the CHARACTER's world frame (forward / right / up) and converted
 * into each bone's local frame, so the same curve works on the warrior's rig
 * and on the Mixamo rigs regardless of their bone-axis conventions.
 * Keys: [u (0..1 of the swing), degrees]; wind-up -> strike -> recover.
 *   armPitch  + = upper arm swings forward/up (about the character's right axis)
 *   armOut    + = upper arm lifts outward (away from the body)
 *   forearm   + = elbow flexes (about the right axis)
 *   hand      + = wrist cocks back
 *   spineYaw  + = torso turns left (negative = right shoulder back = wind-up)
 *   spinePitch+ = torso leans back
 * Per-rig multipliers: characters.js `swing: { arm, forearm, spine, hand }`.
 */
const SWING_KEYS = {
    armPitch:   [[0, 0], [0.42, 150], [0.58, 30], [1, 0]],
    armOut:     [[0, 0], [0.42, 20], [0.58, 6], [1, 0]],
    forearm:    [[0, 0], [0.42, 80], [0.58, 8], [1, 0]],
    hand:       [[0, 0], [0.42, 25], [0.58, -25], [1, 0]],
    spineYaw:   [[0, 0], [0.42, -24], [0.58, 16], [1, 0]],
    spinePitch: [[0, 0], [0.42, 9], [0.58, -13], [1, 0]]
};
// STAFF thrust (weapon.style 'staff'): the arm reaches out horizontally (elbow slightly bent) and the
// hand is counter-rotated so the staff stays upright all the time; a short lightning zap leaves the tip.
const STAFF_KEYS = {
    armPitch:   [[0, 0], [0.3, 86], [0.78, 86], [1, 0]],
    forearm:    [[0, 0], [0.3, 28], [0.78, 28], [1, 0]],
    spineYaw:   [[0, 0], [0.3, -6], [0.55, 4], [1, 0]],
    spinePitch: [[0, 0], [0.3, -4], [0.78, -4], [1, 0]]
};
// Fraction of the swing at which the weapon connects (end of the strike).
const SWING_HIT_FRAC = 0.55;
const DEG = Math.PI / 180;

/** Keyframe value at u: smoothstep between keys (the strike segment accelerates: ease-in). */
function swingKey(keys, u) {
    if (u <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (u <= b[0]) {
            let t = (u - a[0]) / (b[0] - a[0]);
            // wind-up->strike segment: accelerate into the hit
            t = a[0] === 0.42 ? t * t : t * t * (3 - 2 * t);
            return a[1] + (b[1] - a[1]) * t;
        }
    }
    return keys[keys.length - 1][1];
}

class MedievalCharacter {
    constructor(scene, terrain, characterConfig, onLoaded) {
        this.scene = scene;
        this.terrain = terrain;
        this.config = characterConfig || window.getCharacterConfig('warrior');
        this.onLoaded = onLoaded;

        this.mesh = null;
        this.mixer = null;
        this.actions = {};
        this.currentAction = null;

        const spawn = (window.CURRENT_LOCATION && window.CURRENT_LOCATION.playerSpawn) || { x: 15, z: 8 };
        this.position = new THREE.Vector3(spawn.x, 0, spawn.z);
        this.position.y = this.terrain.getHeightAt(this.position.x, this.position.z);
        // facingOffset corrects for a rig whose local forward is +Z instead of
        // the soldier's -Z (see characters.js). target/currentRotation stay in
        // a character-independent "design" domain (same numbers mean the same
        // world-facing direction for every character, matching how spawn.r in
        // world_data.js and saved-progress 'r' are authored/persisted) — the
        // offset is applied only where currentRotation is written onto the
        // actual mesh (see mesh.rotation.y assignments below and in teleport()).
        this.facingOffset = this.config.facingOffset || 0;
        this.targetRotation = Math.PI;
        this.currentRotation = Math.PI;

        this.path = [];
        this.currentWaypointIdx = 0;
        this.moveSpeed = 4.8; // m/s
        this.isMoving = false;

        // Idle "greeting" gesture: after standing still for IDLE_GREETING_DELAY
        // seconds, play the character's greeting clip once (if it has one via
        // animMap.greeting) then return to normal idle. Timer runs on game
        // time (delta), so it naturally pauses with the rest of gameplay.
        this.idleTimer = 0;
        this.isGreeting = false;
        this.isCasting = false;
        this.isAttacking = false;
        // Held channel (skills.js home_recall): the cast clip is frozen at its peak pose until
        // stopChannel(); any movement / attack / death ends it (skills.js polls this flag).
        this.isChanneling = false;
        this.channelAction = null;
        this.greetingMixerListener = null;

        // Turn-in-place (e.g. casting a skill toward a target while standing):
        // currentRotation normally only eases while walking; faceTowards() sets
        // isTurning so update() keeps easing toward targetRotation when idle.
        this.isTurning = false;

        // Right-hand bone + hand-held item (items.js/ui_hotbar.js equip). The
        // item is parented to the bone; `handItemPending` holds an item that was
        // equipped before the model finished loading.
        this.rightHandBone = null;
        this.handItem = null;
        this.handItemPending = null;
        this.travelerStaff = null; // warrior's cosmetic staff — hidden while a real item is held

        // Procedural swing overlay (combat.js / harvest.js) — see SWING_KEYS
        this.swing = null;          // { t, d } seconds
        this.swingBones = null;     // { spine: [..], shoulder, arm, forearm, hand } (resolved on load)
        this.overlaySaved = [];     // [{ bone, q }] quaternions before the overlay (restored next frame)
        // Death fall (combat.js): seconds since the fall started, -1 = alive
        this.deathT = -1;
        this._q1 = new THREE.Quaternion();
        this._q2 = new THREE.Quaternion();
        this._q3 = new THREE.Quaternion();
        this._axis = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3(0, 1, 0);

        this.init();
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

    init() {
        const loader = new THREE.GLTFLoader();
        const modelKey = this.config.modelKey;
        const b64 = window.GAME_ASSETS.models[modelKey];
        if (!b64) {
            console.error(`[Avelora] no model "${modelKey}" in GAME_ASSETS for character "${this.config.id}"`);
            return;
        }
        const buffer = this.base64ToArrayBuffer(b64);

        loader.parse(buffer, '', (gltf) => {
            this.mesh = gltf.scene;

            // Character scale & initial orientation
            const s = this.config.scale || 1.0;
            this.mesh.scale.set(s, s, s);
            this.mesh.position.copy(this.position);

            const hideNodes = this.config.hideNodes || [];
            this.mesh.traverse(child => {
                if (hideNodes.includes(child.name)) {
                    child.visible = false;
                }
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    if (child.material) {
                        // Только воину задаем принудительную матовость; у мага и Ариссы сохраняем родной PBR
                        if (this.config.id === 'warrior') {
                            child.material.roughness = 0.8;
                            child.material.metalness = 0.05;
                        }
                    }
                }
            });

            // Cosmetic traveler gear (cloak + staff) — soldier reskin only;
            // Arissa/AzureArchmage already come with their own gear baked in.
            if (this.config.hasTravelerGear) {
                this.attachMedievalTravelerGear();
            }

            // Setup Animation Mixer
            this.mixer = new THREE.AnimationMixer(this.mesh);
            gltf.animations.forEach(clip => {
                const action = this.mixer.clipAction(clip);
                this.actions[clip.name] = action;
            });

            // When one-shot gestures (greeting, cast, attack) finish, cross-fade back to idle (or run if moving).
            this.mixer.addEventListener('finished', (e) => {
                if (this.isGreeting && e.action === this.actions[(this.config.animMap || {}).greeting]) {
                    this.isGreeting = false;
                    this.idleTimer = 0;
                    if (!this.isMoving) this.fadeToLogical('idle', 0.35);
                }
                if (this.isCasting && e.action === this.actions[(this.config.animMap || {}).cast]) {
                    this.isCasting = false;
                    this.idleTimer = 0;
                    if (!this.isMoving) this.fadeToLogical('idle', 0.25);
                    else this.fadeToLogical('run', 0.2);
                }
                if (this.isAttacking && e.action === this.actions[(this.config.animMap || {}).attack]) {
                    this.isAttacking = false;
                    this.idleTimer = 0;
                    if (!this.isMoving) this.fadeToLogical('idle', 0.25);
                    else this.fadeToLogical('run', 0.2);
                }
            });

            // Start in Idle (or a frozen frame of the run clip if no Idle yet)
            const idleAction = this.resolveAction('idle');
            if (idleAction) {
                this.currentAction = idleAction;
                idleAction.reset().play();
            } else {
                const runAction = this.resolveAction('run');
                if (runAction) {
                    runAction.reset().play();
                    runAction.paused = true;
                    this.currentAction = runAction;
                }
            }

            this.scene.add(this.mesh);

            this.rightHandBone = this.findRightHandBone();
            this.swingBones = this.findSwingBones();
            if (this.handItemPending) {
                const pending = this.handItemPending;
                this.handItemPending = null;
                this.setHandItem(pending);
            }

            if (this.onLoaded) {
                this.onLoaded(this);
            }
        });
    }

    /** Logical name ('idle' | 'run') -> THREE.AnimationAction, with idleFallback support. Null if nothing usable. */
    resolveAction(logicalName) {
        const map = this.config.animMap || {};
        const wanted = map[logicalName];
        if (wanted && this.actions[wanted]) return this.actions[wanted];

        if (logicalName === 'idle' && this.config.idleFallback) {
            const fallback = map[this.config.idleFallback];
            if (fallback && this.actions[fallback]) return this.actions[fallback];
        }
        return null;
    }

    attachMedievalTravelerGear() {
        // Find skeleton bones for attaching props
        let spineBone = null;
        let rightHandBone = null;

        this.mesh.traverse(child => {
            if (child.isBone) {
                if (child.name.includes('Spine2') || child.name.includes('Spine1')) {
                    spineBone = child;
                } else if (child.name.includes('RightHand') && !child.name.includes('Thumb') && !child.name.includes('Index')) {
                    rightHandBone = child;
                }
            }
        });

        // Traveler's Cloak / Cape
        const capeGeo = new THREE.PlaneGeometry(0.55, 1.1, 4, 8);
        capeGeo.translate(0, -0.55, 0); // Origin at shoulders
        const capeMat = new THREE.MeshStandardMaterial({
            color: 0x362b24, // Weathered dark peat brown wool
            roughness: 0.9,
            metalness: 0.05,
            side: THREE.DoubleSide
        });

        // Dynamic cape sway in vertex shader
        capeMat.onBeforeCompile = (shader) => {
            shader.uniforms.uSpeed = { value: 0 };
            shader.uniforms.uTime = { value: 0 };
            this.capeSpeedUniform = shader.uniforms.uSpeed;
            this.capeTimeUniform = shader.uniforms.uTime;
            shader.vertexShader = `
                uniform float uSpeed;
                uniform float uTime;
                ${shader.vertexShader}
            `;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                float sway = sin(uTime * 6.0 + position.y * 3.0) * (0.05 + uSpeed * 0.15) * (-position.y);
                transformed.z += (0.08 + uSpeed * 0.22) * (-position.y) + sway;
                `
            );
        };

        const capeMesh = new THREE.Mesh(capeGeo, capeMat);
        capeMesh.castShadow = true;
        // Model faces local -Z (rotation = atan2(dx, dz) + PI), so the back is +Z
        capeMesh.position.set(0, 1.35, 0.15); // Upper back
        this.mesh.add(capeMesh);
        this.capeMesh = capeMesh;

        // Traveler's Wooden Walking Staff
        const staffGeo = new THREE.CylinderGeometry(0.025, 0.035, 1.95, 8);
        staffGeo.translate(0, 0.45, 0);
        const staffMat = new THREE.MeshStandardMaterial({
            color: 0x4a3728, // Dark oiled ash wood
            roughness: 0.85
        });
        const staffMesh = new THREE.Mesh(staffGeo, staffMat);
        staffMesh.castShadow = true;
        staffMesh.rotation.x = Math.PI / 12;

        if (rightHandBone) {
            rightHandBone.add(staffMesh);
            staffMesh.position.set(0.05, 0.0, 0.0);
        } else {
            staffMesh.position.set(0.35, 0.9, 0.1);
            this.mesh.add(staffMesh);
        }
        this.travelerStaff = staffMesh;
    }

    /** The rig's right-hand bone (Mixamo `mixamorig:RightHand` / `mixamorigRightHand`, or any '...RightHand'). */
    findRightHandBone() {
        let best = null;
        if (!this.mesh) return null;
        this.mesh.traverse(o => {
            if (!o.isBone || best) return;
            if (/RightHand$/.test(o.name)) best = o;
        });
        if (!best) {
            this.mesh.traverse(o => {
                if (!best && o.isBone && o.name.includes('RightHand') && !/Thumb|Index|Middle|Ring|Pinky/.test(o.name)) best = o;
            });
        }
        return best;
    }

    /** First bone whose (sanitized) name ends with `suffix` (e.g. 'RightForeArm'). */
    findBone(suffix) {
        let best = null;
        if (!this.mesh) return null;
        const re = new RegExp(suffix + '$');
        this.mesh.traverse(o => { if (!best && o.isBone && re.test(o.name)) best = o; });
        return best;
    }

    /** Bones used by the procedural swing; missing ones are simply skipped. */
    findSwingBones() {
        let spine = [this.findBone('Spine1'), this.findBone('Spine2')].filter(Boolean);
        if (!spine.length) spine = [this.findBone('Spine')].filter(Boolean);
        const b = {
            spine,
            shoulder: this.findBone('RightShoulder'),
            arm: this.findBone('RightArm'),
            forearm: this.findBone('RightForeArm'),
            hand: this.rightHandBone
        };
        b.all = spine.concat([b.shoulder, b.arm, b.forearm, b.hand]).filter(Boolean); // pre-built: no per-frame arrays
        return b;
    }

    /** Starts one procedural weapon swing lasting `duration` s (restarts if one is running). */
    startSwing(duration, style) {
        this._endChannel();
        this.swing = { t: 0, d: Math.max(0.25, duration || 0.8), style: style || null };
        this.idleTimer = 0;
        if (this.isGreeting) {
            this.isGreeting = false;
            this.fadeToLogical('idle', 0.15);
        }
    }

    /** Plays the character's 'cast' animation clip if available, otherwise falls back to procedural startSwing. */
    playCast(duration = 0.6) {
        this.idleTimer = 0;
        if (this.isGreeting) {
            this.isGreeting = false;
        }
        const castAction = this.resolveAction('cast');
        if (castAction && this.currentAction) {
            this.isCasting = true;
            castAction.reset();
            castAction.setLoop(THREE.LoopOnce, 1);
            castAction.clampWhenFinished = true;
            const clipDur = castAction.getClip().duration || 1.0;
            castAction.timeScale = Math.max(0.6, Math.min(2.5, clipDur / Math.max(0.2, duration)));
            castAction.fadeIn(0.12).play();
            if (this.currentAction !== castAction) {
                this.currentAction.fadeOut(0.12);
            }
            this.currentAction = castAction;
        } else {
            this.startSwing(duration);
        }
    }

    /**
     * Long held cast (home_recall, several seconds): plays the 'cast' clip up to its peak pose
     * (config.channelHoldTime, s) and HOLDS it until stopChannel(); characters without a cast
     * clip simply keep standing in idle. Movement, attacks, swings and death end it.
     */
    startChannel() {
        this.idleTimer = 0;
        this.isGreeting = false;
        this.isChanneling = true;
        this.channelAction = null;
        const castAction = this.resolveAction('cast');
        if (castAction && this.currentAction) {
            castAction.reset();
            castAction.paused = false;
            castAction.setLoop(THREE.LoopOnce, 1);
            castAction.clampWhenFinished = true;
            castAction.timeScale = 1;
            castAction.fadeIn(0.2).play();
            if (this.currentAction !== castAction) this.currentAction.fadeOut(0.2);
            this.currentAction = castAction;
            this.channelAction = castAction;
        }
    }

    /** Ends the channel WITHOUT choosing the next animation (callers that start their own one). */
    _endChannel() {
        if (!this.isChanneling) return;
        this.isChanneling = false;
        if (this.channelAction) { this.channelAction.paused = false; this.channelAction = null; }
    }

    /** Ends the channel and lowers the arm back to idle. */
    stopChannel() {
        if (!this.isChanneling) return;
        this._endChannel();
        if (!this.isMoving && this.deathT < 0) this.fadeToLogical('idle', 0.3);
    }

    /** Plays the character's 'attack' animation clip if available, otherwise falls back to procedural startSwing. */
    playAttack(duration = 0.8, style) {
        if (style === 'staff') { this.startSwing(duration, 'staff'); return; }
        this._endChannel();
        this.idleTimer = 0;
        if (this.isGreeting) {
            this.isGreeting = false;
        }
        const attackAction = this.resolveAction('attack');
        if (attackAction && this.currentAction) {
            this.isAttacking = true;
            attackAction.reset();
            attackAction.setLoop(THREE.LoopOnce, 1);
            attackAction.clampWhenFinished = true;
            const clipDur = attackAction.getClip().duration || 1.0;
            attackAction.timeScale = Math.max(0.6, Math.min(2.5, clipDur / Math.max(0.2, duration)));
            attackAction.fadeIn(0.1).play();
            if (this.currentAction !== attackAction) {
                this.currentAction.fadeOut(0.1);
            }
            this.currentAction = attackAction;
        } else {
            this.startSwing(duration);
        }
    }

    get isSwinging() { return !!this.swing || this.isAttacking; }

    /** Fraction of a swing at which the hit lands (combat.js schedules damage with it). */
    static get SWING_HIT_FRAC() { return SWING_HIT_FRAC; }

    /** Rotate `bone` by `angle` about a WORLD axis (pivot = the bone itself). */
    rotateBoneWorld(bone, axis, angle) {
        if (!bone || !bone.parent || Math.abs(angle) < 1e-5) return;
        const qp = this._q1, qw = this._q2;
        bone.parent.getWorldQuaternion(qp);
        qw.setFromAxisAngle(axis, angle);
        // local = parent^-1 * world * parent
        this._q3.copy(qp).invert();
        qw.premultiply(this._q3).multiply(qp);
        bone.quaternion.premultiply(qw);
    }

    saveOverlayBone(bone) {
        if (!bone) return;
        const slot = this.overlaySaved.find(e => e.bone === bone);
        if (slot) { slot.q.copy(bone.quaternion); slot.used = true; }
        else this.overlaySaved.push({ bone, q: bone.quaternion.clone(), used: true });
    }

    /** Undo last frame's overlay (a bone without an animation track would otherwise accumulate it). */
    restoreOverlay() {
        for (let i = 0; i < this.overlaySaved.length; i++) {
            const e = this.overlaySaved[i];
            if (e.used) { e.bone.quaternion.copy(e.q); e.used = false; }
        }
    }

    applySwingOverlay(delta) {
        const sw = this.swing;
        const b = this.swingBones;
        if (!sw || !b || !this.mesh) return;
        sw.t += delta;
        const u = sw.t / sw.d;
        if (u >= 1) { this.swing = null; return; }
        if (sw.style === 'staff') { this.applyStaffOverlay(u); return; }
        const k = this.config.swing || {};
        const kArm = k.arm !== undefined ? k.arm : 1, kFore = k.forearm !== undefined ? k.forearm : 1;
        const kSpine = k.spine !== undefined ? k.spine : 1, kHand = k.hand !== undefined ? k.hand : 1;

        this.mesh.updateMatrixWorld(true);
        for (let i = 0; i < b.all.length; i++) this.saveOverlayBone(b.all[i]);

        // Character frame (design heading: rotation = atan2(dx,dz)+PI -> forward = (-sin r, -cos r))
        const r = this.currentRotation;
        const yaw = swingKey(SWING_KEYS.spineYaw, u) * DEG * kSpine;
        const pitch = swingKey(SWING_KEYS.spinePitch, u) * DEG * kSpine;
        this._fwd.set(-Math.sin(r), 0, -Math.cos(r));
        this._right.set(Math.cos(r), 0, -Math.sin(r));
        const n = b.spine.length || 1;
        for (let i = 0; i < b.spine.length; i++) {
            this.rotateBoneWorld(b.spine[i], this._up, yaw / n);
            this.rotateBoneWorld(b.spine[i], this._right, pitch / n);
        }
        // The arm works in the twisted torso's frame
        this._fwd.applyAxisAngle(this._up, yaw);
        this._right.applyAxisAngle(this._up, yaw);

        const armPitch = swingKey(SWING_KEYS.armPitch, u) * DEG * kArm;
        const armOut = swingKey(SWING_KEYS.armOut, u) * DEG * kArm;
        this.rotateBoneWorld(b.shoulder, this._right, armPitch * 0.12);
        this.rotateBoneWorld(b.arm, this._right, armPitch * 0.88);
        // + about forward would swing a hanging arm inward (to the left) -> outward is negative
        this.rotateBoneWorld(b.arm, this._fwd, -armOut);
        this.rotateBoneWorld(b.forearm, this._right, swingKey(SWING_KEYS.forearm, u) * DEG * kFore);
        this.rotateBoneWorld(b.hand, this._right, swingKey(SWING_KEYS.hand, u) * DEG * kHand);
    }

    /** Walking/running with a staff: the run clip pumps the arm, so the staff is held (nearly) upright instead. */
    applyCarryUpright(delta) {
        const it = this.handItem, b = this.rightHandBone;
        const obj = it && it.children[0];
        if (!obj || !obj.userData || !obj.userData.upright || !b || !b.parent) { this.carryW = 0; return; }
        const want = this.isMoving && !this.swing && !this.isCasting && !this.isChanneling && !this.isAttacking && this.deathT < 0;
        this.carryW = (this.carryW || 0) + ((want ? 1 : 0) - (this.carryW || 0)) * Math.min(1, delta * 10);
        if (this.carryW < 0.01) return;
        this.mesh.updateMatrixWorld(true);
        this.saveOverlayBone(b);
        const qO = this._q1, qd = this._q2, qb = this._q3;
        obj.getWorldQuaternion(qO);
        const shaft = this._cv1 || (this._cv1 = new THREE.Vector3());
        const want_d = this._cv2 || (this._cv2 = new THREE.Vector3());
        shaft.set(0, 1, 0).applyQuaternion(qO);
        const r = this.currentRotation, tilt = 6 * DEG;   // top slightly forward
        want_d.set(-Math.sin(r) * Math.sin(tilt), Math.cos(tilt), -Math.cos(r) * Math.sin(tilt));
        const full = this._q4 || (this._q4 = new THREE.Quaternion());
        full.setFromUnitVectors(shaft, want_d);
        qd.identity().slerp(full, this.carryW);
        b.getWorldQuaternion(qb);
        qb.premultiply(qd);
        b.parent.getWorldQuaternion(qO);
        b.quaternion.copy(qO).invert().multiply(qb);
    }

    /** Staff thrust: arm out forward, hand counter-rotated so the staff keeps its upright pose. */
    applyStaffOverlay(u) {
        const b = this.swingBones;
        this.mesh.updateMatrixWorld(true);
        for (let i = 0; i < b.all.length; i++) this.saveOverlayBone(b.all[i]);
        const keep = this._q4 || (this._q4 = new THREE.Quaternion());
        if (b.hand) b.hand.getWorldQuaternion(keep);
        const r = this.currentRotation;
        this._fwd.set(-Math.sin(r), 0, -Math.cos(r));
        this._right.set(Math.cos(r), 0, -Math.sin(r));
        const yaw = swingKey(STAFF_KEYS.spineYaw, u) * DEG, pitch = swingKey(STAFF_KEYS.spinePitch, u) * DEG;
        const n = b.spine.length || 1;
        for (let i = 0; i < b.spine.length; i++) {
            this.rotateBoneWorld(b.spine[i], this._up, yaw / n);
            this.rotateBoneWorld(b.spine[i], this._right, pitch / n);
        }
        this._fwd.applyAxisAngle(this._up, yaw);
        this._right.applyAxisAngle(this._up, yaw);
        const ap = swingKey(STAFF_KEYS.armPitch, u) * DEG;
        this.rotateBoneWorld(b.shoulder, this._right, ap * 0.12);
        this.rotateBoneWorld(b.arm, this._right, ap * 0.88);
        this.rotateBoneWorld(b.forearm, this._right, swingKey(STAFF_KEYS.forearm, u) * DEG);
        if (b.hand && b.hand.parent) { // wrist: back to the pre-swing world orientation (staff stays vertical)
            const qp = this._q1;
            b.hand.parent.getWorldQuaternion(qp);
            b.hand.quaternion.copy(qp).invert().multiply(keep);
        }
    }

    /** Small lightning zap from the staff crystal toward (x, z); lives ~0.22 s. */
    staffZap(tx, tz) {
        if (!this.handItem || !this.scene) return;
        if (!this._zapBox) this._zapBox = new THREE.Box3();
        this.scene.updateMatrixWorld(true);
        const bb = this._zapBox.setFromObject(this.handItem);
        if (bb.isEmpty()) return;
        const tip = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y - 0.05, (bb.min.z + bb.max.z) / 2);
        const end = new THREE.Vector3(tx, this.terrain ? this.terrain.getHeightAt(tx, tz) + 0.7 : tip.y - 0.4, tz);
        const dir = end.clone().sub(tip);
        const len = dir.length();
        if (len > 2.4) end.copy(tip).addScaledVector(dir, 2.4 / len);
        const SEG = 7, BOLTS = 3;
        const arr = new Float32Array(BOLTS * SEG * 2 * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.LineBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
        const lines = new THREE.LineSegments(geo, mat);
        lines.frustumCulled = false;
        this.scene.add(lines);
        const fx = { lines, geo, mat, tip, end, age: 0, next: 0, SEG, BOLTS };
        (this.zaps || (this.zaps = [])).push(fx);
        this._zapJitter(fx);
    }

    _zapJitter(fx) {
        const a = fx.geo.attributes.position.array, { tip, end, SEG, BOLTS } = fx;
        let o = 0;
        for (let k = 0; k < BOLTS; k++) {
            let px = tip.x, py = tip.y, pz = tip.z;
            for (let i = 1; i <= SEG; i++) {
                const t = i / SEG, j = i === SEG ? 0 : 0.16 * (1 - t * 0.4);
                const nx = tip.x + (end.x - tip.x) * t + (Math.random() - 0.5) * j;
                const ny = tip.y + (end.y - tip.y) * t + (Math.random() - 0.5) * j;
                const nz = tip.z + (end.z - tip.z) * t + (Math.random() - 0.5) * j;
                a[o++] = px; a[o++] = py; a[o++] = pz; a[o++] = nx; a[o++] = ny; a[o++] = nz;
                px = nx; py = ny; pz = nz;
            }
        }
        fx.geo.attributes.position.needsUpdate = true;
    }

    updateZaps(delta) {
        const z = this.zaps;
        if (!z || !z.length) return;
        for (let i = z.length - 1; i >= 0; i--) {
            const f = z[i];
            f.age += delta; f.next -= delta;
            if (f.next <= 0) { f.next = 0.04; this._zapJitter(f); }
            f.mat.opacity = Math.max(0, 1 - f.age / 0.22);
            if (f.age >= 0.22) {
                this.scene.remove(f.lines); f.geo.dispose(); f.mat.dispose(); z.splice(i, 1);
            }
        }
    }

    // ---------------------------------------------------------------
    // Death fall (no death clip on any rig): tip over backwards around
    // the feet with an accelerating fall + tiny bounce, then lie still.
    // ---------------------------------------------------------------
    startDeathFall() {
        this._endChannel();
        this.deathT = 0;
        this.swing = null;
        this.isCasting = false;
        this.isAttacking = false;
        if (this.isMoving) this.stopMovement();
        this.isTurning = false;
        this.isGreeting = false;
    }

    resetDeathPose() {
        this.deathT = -1;
        // rotation.set(0, y, 0), НЕ quaternion.setFromAxisAngle: кватернион с углом > 90° раскладывается
        // в Euler (PI, PI - y, PI), и дальнейшие rotation.y = ... зеркалят модель («бег задом/боком»).
        if (this.mesh) this.mesh.rotation.set(0, this.currentRotation + this.facingOffset, 0);
    }

    get isDeadPose() { return this.deathT >= 0; }

    applyDeathPose(delta) {
        this.deathT += delta;
        const FALL = 0.75;
        let a;
        if (this.deathT < FALL) {
            const t = this.deathT / FALL;
            a = t * t * 84;                      // accelerating
        } else {
            const t = Math.min(1, (this.deathT - FALL) / 0.35);
            a = 84 - Math.sin(t * Math.PI) * 7 * (1 - t * 0.5); // small bounce
        }
        const rad = a * DEG;
        const r = this.currentRotation;
        this._right.set(Math.cos(r), 0, -Math.sin(r));
        // Yaw first, then tip about the (world) right axis: + tips the head backwards
        this._q1.setFromAxisAngle(this._up, r + this.facingOffset);
        this._q2.setFromAxisAngle(this._right, rad);
        this.mesh.quaternion.copy(this._q1).premultiply(this._q2);
        // Lift a little so the back doesn't sink through the ground when lying
        this.mesh.position.y = this.position.y + Math.sin(rad) * 0.14;
    }

    /** World position of the right hand (skill projectiles start here). False if the rig has no such bone. */
    getRightHandWorldPosition(out) {
        if (!this.rightHandBone) return false;
        this.rightHandBone.getWorldPosition(out);
        return true;
    }

    /**
     * Puts `object` (an item model with its origin at the grip, shaft along +Y)
     * into the right hand, or clears the hand with null. The previous item is
     * detached and disposed.
     *
     * Scale: the hand bone's WORLD scale is compensated so the item keeps its
     * real-world size — characters.js `scale` can be ~93 (AzureArchmage) and
     * FBX-derived rigs may carry 0.01 bone scales; dividing by the bone's world
     * scale undoes whatever the chain accumulates.
     * Orientation/offset: characters.js `handGrip: { position:[x,y,z] (meters,
     * in the hand's frame), rotation:[x,y,z] (radians, Euler XYZ) }` per rig.
     */
    setHandItem(object) {
        if (!this.mesh) { // model still loading — attach when it arrives
            if (this.handItemPending && this.handItemPending !== object) MedievalCharacter.disposeObject(this.handItemPending);
            this.handItemPending = object;
            return;
        }
        if (this.handItem) {
            if (this.handItem.parent) this.handItem.parent.remove(this.handItem);
            MedievalCharacter.disposeObject(this.handItem);
            this.handItem = null;
        }
        if (this.travelerStaff) this.travelerStaff.visible = !object;
        if (!object) return;

        const bone = this.rightHandBone;
        const grip = this.config.handGrip || {};
        const holder = new THREE.Group();
        holder.name = 'hand-item';
        holder.add(object);
        if (bone) {
            this.mesh.updateMatrixWorld(true);
            const ws = new THREE.Vector3();
            bone.getWorldScale(ws);
            holder.scale.set(1 / (ws.x || 1), 1 / (ws.y || 1), 1 / (ws.z || 1));
            const gp = grip.position || [0, 0, 0];
            // Offset is authored in meters: convert into the bone's (scaled) local space
            holder.position.set(gp[0] / (ws.x || 1), gp[1] / (ws.y || 1), gp[2] / (ws.z || 1));
            const gr = grip.rotation || [0, 0, 0];
            holder.rotation.set(gr[0], gr[1], gr[2]);
            bone.add(holder);
        } else {
            // No hand bone: carry it at the side (still real size: undo the root scale)
            const s = this.config.scale || 1;
            holder.scale.setScalar(1 / s);
            holder.position.set(0.3 / s, 0.9 / s, 0);
            this.mesh.add(holder);
        }
        this.handItem = holder;
    }

    static disposeObject(obj) {
        if (!obj) return;
        const geos = new Set(), mats = new Set();
        obj.traverse(o => {
            if (o.geometry) geos.add(o.geometry);
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
        });
        mats.forEach(m => {
            Object.keys(m).forEach(k => { if (m[k] && m[k].isTexture) m[k].dispose(); });
            m.dispose();
        });
        geos.forEach(g => g.dispose());
    }

    /**
     * Turn (smoothly, in place) to face a world point — used when casting.
     * Also interrupts the idle greeting gesture and resets its timer.
     */
    faceTowards(x, z) {
        const dx = x - this.position.x, dz = z - this.position.z;
        if (dx * dx + dz * dz < 1e-6) return;
        this.targetRotation = Math.atan2(dx, dz) + Math.PI;
        if (!this.isMoving) this.isTurning = true; // при движении поворот идёт через ветку isMoving
        this.idleTimer = 0;
        if (this.isGreeting) {
            this.isGreeting = false;
            this.fadeToLogical('idle', 0.2);
        }
    }

    // Location change: new terrain + spawn point
    setTerrain(terrain) {
        this.terrain = terrain;
    }

    teleport(x, z, rotation) {
        this.path = [];
        this.currentWaypointIdx = 0;
        if (this.isMoving) this.stopMovement();
        this.position.set(x, this.terrain.getHeightAt(x, z), z);
        if (rotation !== undefined) {
            this.currentRotation = rotation;
            this.targetRotation = rotation;
        }
        if (this.mesh) {
            this.mesh.position.copy(this.position);
            this.mesh.rotation.set(0, this.currentRotation + this.facingOffset, 0); // x/z всегда 0 — см. resetDeathPose()
        }
    }

    setPath(waypoints) {
        if (!waypoints || waypoints.length === 0) return;
        this._endChannel();
        this.path = waypoints;
        this.currentWaypointIdx = 0;
        this.isMoving = true;
        this.isTurning = false;
        this.idleTimer = 0;
        this.isGreeting = false;
        if (this.isCasting) {
            this.isCasting = false;
            const castAction = this.resolveAction('cast');
            if (castAction) castAction.fadeOut(0.15);
        }
        if (this.isAttacking) {
            this.isAttacking = false;
            const attackAction = this.resolveAction('attack');
            if (attackAction) attackAction.fadeOut(0.15);
        }
        this.fadeToLogical('run', 0.2);
    }

    stopMovement() {
        this.isMoving = false;
        this.path = [];
        this.currentWaypointIdx = 0;
        this.idleTimer = 0;
        this.fadeToLogical('idle', 0.25);
    }

    /** Plays the character's 'greeting' clip once (if it has one), then returns to idle. */
    playGreeting() {
        const greetingAction = this.resolveAction('greeting');
        if (!greetingAction || !this.currentAction) return;

        this.isGreeting = true;
        greetingAction.reset();
        greetingAction.setLoop(THREE.LoopOnce, 1);
        greetingAction.clampWhenFinished = true;
        greetingAction.fadeIn(0.25).play();
        this.currentAction.fadeOut(0.25);
        this.currentAction = greetingAction;
    }

    /** Cross-fade to the action for a logical name ('idle' | 'run'), honoring idleFallback. */
    fadeToLogical(logicalName, duration = 0.2) {
        const nextAction = this.resolveAction(logicalName);
        if (!nextAction || nextAction === this.currentAction) return;

        nextAction.paused = false;
        nextAction.reset().fadeIn(duration).play();
        if (this.currentAction) {
            this.currentAction.fadeOut(duration);
        }
        this.currentAction = nextAction;
    }

    update(delta) {
        this.restoreOverlay();
        if (this.mixer) {
            this.mixer.update(delta);
        }
        if (this.isChanneling && this.channelAction && !this.channelAction.paused) {
            const hold = this.config.channelHoldTime !== undefined ? this.config.channelHoldTime : 0.4;
            if (this.channelAction.time >= hold) { this.channelAction.time = hold; this.channelAction.paused = true; }
        }

        // Dead: no movement/turning; lie down procedurally (combat.js respawns)
        if (this.deathT >= 0) {
            this.position.y = this.terrain.getHeightAt(this.position.x, this.position.z);
            if (this.mesh) {
                this.mesh.position.copy(this.position);
                this.applyDeathPose(delta);
            }
            return;
        }

        // Idle "greeting" gesture (e.g. the mage's wave) after standing still
        // for a while — only for characters with a mapped 'greeting' clip.
        if (!this.isMoving && !this.isGreeting && (this.config.animMap || {}).greeting) {
            this.idleTimer += delta;
            if (this.idleTimer >= IDLE_GREETING_DELAY) {
                this.playGreeting();
            }
        }

        if (this.isMoving && this.path.length > 0 && this.currentWaypointIdx < this.path.length) {
            const targetPt = this.path[this.currentWaypointIdx];
            const dx = targetPt.x - this.position.x;
            const dz = targetPt.z - this.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < 0.35) {
                // Waypoint reached
                this.currentWaypointIdx++;
                if (this.currentWaypointIdx >= this.path.length) {
                    this.stopMovement();
                    return;
                }
            } else {
                // =========================================================================
                // !!! ВНИМАНИЕ: СТРОГО ЗАПРЕЩЕНО МЕНЯТЬ ЭТИ СТРОКИ И ЛОГИКУ ДВИЖЕНИЯ/ПОВОРОТА !!!
                // Любые изменения этой формулы (this.targetRotation = Math.atan2(dx, dz) + Math.PI)
                // или сглаживания currentRotation приводят к критическому багу «бега задом» у персонажей!
                // Поправка ориентации моделей настраивается ИСКЛЮЧИТЕЛЬНО через facingOffset в js/characters.js!
                // =========================================================================
                this.targetRotation = Math.atan2(dx, dz) + Math.PI;
                // Angular shortest path
                let diff = this.targetRotation - this.currentRotation;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;

                // Энергичный и четкий поворот лицом к направлению движения
                const turnSpeed = 24.0;
                this.currentRotation += diff * Math.min(1.0, turnSpeed * delta);

                // Движение строго к цели по вектору вейпоинта
                const moveDist = Math.min(dist, this.moveSpeed * delta);
                this.position.x += (dx / dist) * moveDist;
                this.position.z += (dz / dist) * moveDist;
            }
        }

        // Turning in place toward a skill target (faster than the walking ease)
        if (!this.isMoving && this.isTurning) {
            let diff = this.targetRotation - this.currentRotation;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            if (Math.abs(diff) < 0.01) {
                this.currentRotation = this.targetRotation;
                this.isTurning = false;
            } else {
                this.currentRotation += diff * Math.min(1.0, 22.0 * delta);
            }
        }

        // Stick character to terrain surface
        const groundHeight = this.terrain.getHeightAt(this.position.x, this.position.z);
        this.position.y = groundHeight;

        if (this.mesh) {
            this.mesh.position.copy(this.position);
            // !!! НЕ ТРОГАТЬ: расчет рыскания меша жестко привязан к currentRotation и facingOffset !!!
            this.mesh.rotation.set(0, this.currentRotation + this.facingOffset, 0); // x/z всегда 0 — см. resetDeathPose()
            if (this.swing) this.applySwingOverlay(delta);
            this.applyCarryUpright(delta);
        }
        if (this.zaps && this.zaps.length) this.updateZaps(delta);

        // Cape sway clock (game time: freezes on pause)
        if (this.capeTimeUniform) {
            this.capeTimeUniform.value += delta;
        }

        // Update cape movement speed
        if (this.capeSpeedUniform) {
            const targetSpeed = this.isMoving ? 1.0 : 0.0;
            this.capeSpeedUniform.value += (targetSpeed - this.capeSpeedUniform.value) * 8.0 * delta;
        }
    }

    /** Releases the mesh/materials/mixer — call when switching to a different character. */
    dispose() {
        if (this.handItemPending) { MedievalCharacter.disposeObject(this.handItemPending); this.handItemPending = null; }
        this.handItem = null; // lives under the bone -> disposed with the mesh below
        this.rightHandBone = null;
        if (this.mixer) {
            this.mixer.stopAllAction();
            this.mixer = null;
        }
        if (this.mesh) {
            const geos = new Set();
            const mats = new Set();
            this.mesh.traverse(o => {
                if (o.geometry) geos.add(o.geometry);
                if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
            });
            mats.forEach(m => {
                Object.keys(m).forEach(k => { if (m[k] && m[k].isTexture) m[k].dispose(); });
                m.dispose();
            });
            geos.forEach(g => g.dispose());
            this.scene.remove(this.mesh);
            this.mesh = null;
        }
        this.actions = {};
        this.currentAction = null;
    }
}

window.MedievalCharacter = MedievalCharacter;
