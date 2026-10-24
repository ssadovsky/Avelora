/**
 * Avelora Auto-Play System (js/auto_play.js)
 * Fully Data-Driven, autonomous gameplay assistant:
 * 1. Auto-Combat: Smart skill rotation (Shield -> AoE -> Nukes -> Spark), keeps distance, no melee stick rushes.
 * 2. Auto-Quest: Full autonomous lifecycle (Find -> Accept -> Hunt/Gather -> Turn In -> Next Quest).
 */
(function() {
    'use strict';

    class AveloraAutoPlay {
        constructor(game) {
            this.game = game;
            this.combatEnabled = false;
            this.questEnabled = false;

            // Combat throttling & state
            this._combatTimer = 0;

            // Quest throttling & state
            this._questTimer = 0;
            this._manualMovePauseUntil = 0;
            this._lastNavPoint = null;
            this._nextPathTime = 0;
            this._dialogCooldown = 0;

            // Cache DOM elements
            this.combatBtn = null;
            this.questBtn = null;

            this.initUI();
            this.initHotkeys();
        }

        // ---------------------------------------------------------------------
        // UI & Hotkeys
        // ---------------------------------------------------------------------
        initUI() {
            this.combatBtn = document.getElementById('auto-combat-btn');
            this.questBtn = document.getElementById('auto-quest-btn');
            const dock = document.getElementById('auto-actions-dock');

            const absorbPointer = (e) => {
                e.stopPropagation();
                window.__avelora_just_ui_tap = performance.now();
            };

            const targets = [dock, this.combatBtn, this.questBtn].filter(Boolean);
            const eventsToAbsorb = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'];

            targets.forEach(el => {
                eventsToAbsorb.forEach(evt => {
                    el.addEventListener(evt, absorbPointer, { passive: false });
                });
            });

            if (this.combatBtn) {
                this.combatBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.__avelora_just_ui_tap = performance.now();
                    this.toggleCombat();
                });
            }

            if (this.questBtn) {
                this.questBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.__avelora_just_ui_tap = performance.now();
                    this.toggleQuest();
                });
            }
        }

        initHotkeys() {
            window.addEventListener('keydown', (e) => {
                if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
                const g = this.game;
                if (!g || !g.isReady || g.isPaused) return;

                if (e.code === 'KeyZ') { // Z key
                    e.preventDefault();
                    this.toggleCombat();
                } else if (e.code === 'KeyX') { // X key
                    e.preventDefault();
                    this.toggleQuest();
                }
            });
        }

        toggleCombat(force) {
            this.combatEnabled = (force !== undefined) ? !!force : !this.combatEnabled;
            if (this.combatBtn) {
                this.combatBtn.classList.toggle('active', this.combatEnabled);
                const stateSpan = this.combatBtn.querySelector('.auto-action-state');
                if (stateSpan) stateSpan.textContent = this.combatEnabled ? 'ВКЛ' : 'ВЫКЛ';
            }
            if (this.game.ui && this.game.ui.floatText) {
                this.game.ui.floatText(this.combatEnabled ? 'Автобой: ВКЛ' : 'Автобой: ВЫКЛ', this.combatEnabled ? 'good' : 'info');
            }
        }

        toggleQuest(force) {
            this.questEnabled = (force !== undefined) ? !!force : !this.questEnabled;
            if (this.questBtn) {
                this.questBtn.classList.toggle('active', this.questEnabled);
                const stateSpan = this.questBtn.querySelector('.auto-action-state');
                if (stateSpan) stateSpan.textContent = this.questEnabled ? 'ВКЛ' : 'ВЫКЛ';
            }
            if (!this.questEnabled) {
                // Stop any active navigation
                if (this.game.character && this.game.character.isMoving) {
                    this.game.character.stopMovement();
                }
            }
            if (this.game.ui && this.game.ui.floatText) {
                this.game.ui.floatText(this.questEnabled ? 'Автоквест: ВКЛ' : 'Автоквест: ВЫКЛ', this.questEnabled ? 'good' : 'info');
            }
        }

        /** Called when user touches joystick, WASD or arrows to give manual control */
        onManualMove() {
            this._lastManualAt = Date.now();
            this._manualMovePauseUntil = this._lastManualAt + 3500;
        }

        // ---------------------------------------------------------------------
        // Main Loop Update
        // ---------------------------------------------------------------------
        update(delta) {
            const g = this.game;
            if (!g.isReady || g.isPaused || g.isTransitioning || !g.character) return;
            if (g.combat && g.combat.isDead) {
                if (this.combatEnabled) this.toggleCombat(false);
                if (this.questEnabled) this.toggleQuest(false);
                return;
            }

            // Hero starts a portal / recall by himself: the autopilot gets out of the way
            if (this.questEnabled && g.skills && g.skills.channel) {
                this.toggleQuest(false);
                return;
            }

            if (this.combatEnabled) this.updateCombat(delta);
            if (this.questEnabled) this.updateQuest(delta);
        }

        /** Enough mana for the skill (same cost formula the skill system pays). */
        canAfford(def) {
            const hero = this.game.hero;
            if (!hero) return true;
            const cost = typeof hero.skillManaCost === 'function' ? hero.skillManaCost(def) : (def.mana || 0);
            return !(cost > 0) || hero.mana + 1e-6 >= cost;
        }

        /**
         * Is this fight dangerous enough to spend a defensive buff?
         * Yes when: the hero is already hurt, the enemy is elite/boss, or the enemies around hit hard
         * enough to take a big bite of the current HP in a few blows. A lone weaker mob is not a reason.
         */
        isUnderThreat(tgt) {
            const g = this.game, cr = g.creatures, combat = g.combat, c = g.character;
            if (!combat || !cr || !c) return false;
            if (combat.hp < combat.maxHp * 0.6) return true;
            const foes = (cr.list || []).filter(rec => cr.isAlive(rec) && (rec.aggro || rec === tgt) && Math.hypot(rec.x - c.position.x, rec.z - c.position.z) <= 12.0);
            if (foes.some(rec => rec.rank && rec.rank !== 'normal')) return true;
            const pressure = foes.reduce((sum, rec) => {
                const d = rec.scaledDamage || [0, 0];
                return sum + (d[0] + d[1]) / 2;
            }, 0);
            return pressure * 5 >= combat.hp;   // about 5 blows from everyone together would kill
        }

        /** Id of the location the hero is in now (game.location is an object). */
        curLocId() {
            const l = this.game.location;
            return (l && l.id) || (typeof l === 'string' ? l : null);
        }

        // ---------------------------------------------------------------------
        // Skills Resolver
        // ---------------------------------------------------------------------
        getAvailableSkills() {
            const g = this.game;
            const skills = g.skills;
            const st = g.gameState;
            if (!skills) return [];

            const list = [];
            const seen = new Set();

            // 1. Hotbar skills (what player actually has equipped on slots 1..9)
            if (st && st.hotbar) {
                for (const slot of st.hotbar) {
                    if (slot && slot.type === 'skill' && !seen.has(slot.id)) {
                        seen.add(slot.id);
                        const def = skills.get(slot.id);
                        if (def) list.push(def);
                    }
                }
            }

            // 2. Class skills from forCharacter
            const charCfg = g.currentCharacterConfig || {};
            const classId = (st && st.classId) || charCfg.id || 'mage';
            try {
                const classSkills = skills.forCharacter ? skills.forCharacter(classId) : [];
                for (const def of classSkills) {
                    if (def && !seen.has(def.id)) {
                        seen.add(def.id);
                        list.push(def);
                    }
                }
            } catch (_) {}

            // 3. Fallback: query GAME_CONTENT.characters[classId].skills
            const gc = window.GAME_CONTENT;
            if (gc && gc.characters && gc.characters[classId] && gc.characters[classId].skills) {
                for (const sid of gc.characters[classId].skills) {
                    if (!seen.has(sid)) {
                        seen.add(sid);
                        const def = skills.get(sid);
                        if (def) list.push(def);
                    }
                }
            }

            return list;
        }

        // ---------------------------------------------------------------------
        // 1. AUTO-COMBAT ENGINE
        // ---------------------------------------------------------------------
        updateCombat(delta, customTarget = null) {
            const g = this.game;
            const ui = g.ui;
            if (ui && ((ui.isDialogOpen && ui.isDialogOpen()) || (ui.isChestOpen && ui.isChestOpen()))) return;

            this._combatTimer -= delta;
            if (this._combatTimer > 0) return;
            this._combatTimer = 0.15; // Evaluate combat decisions every 150ms

            // The player is steering by hand: never fight his controls
            if (!customTarget && Date.now() - (this._lastManualAt || 0) < 1200) return;

            const cr = g.creatures;
            const c = g.character;
            const skills = g.skills;
            const combat = g.combat;
            const hero = g.hero;
            if (!cr || !c || !combat) return;

            // Target Validation
            let tgt = customTarget || combat.selectedTarget;
            if (tgt && (!cr.isAlive(tgt) || tgt.state === 'return')) {
                combat.clearTarget();
                tgt = null;
            }

            // Target Acquisition:
            if (!tgt) {
                // Priority 1: Enemies currently aggressive/attacking the player
                const attackers = (cr.list || []).filter(rec => cr.isAlive(rec) && rec.aggro && (rec.state === 'chase' || rec.state === 'attack'));
                if (attackers.length > 0) {
                    attackers.sort((a, b) => Math.hypot(a.x - c.position.x, a.z - c.position.z) - Math.hypot(b.x - c.position.x, b.z - c.position.z));
                    tgt = attackers[0];
                    combat.selectTarget(tgt);
                } else {
                    // Priority 2: If hunting specific quest target
                    const huntType = this.getHuntCreatureType();
                    if (huntType) {
                        const huntCandidates = (cr.list || []).filter(rec => cr.isAlive(rec) && rec.type === huntType && Math.hypot(rec.x - c.position.x, rec.z - c.position.z) <= 24.0);
                        if (huntCandidates.length > 0) {
                            huntCandidates.sort((a, b) => Math.hypot(a.x - c.position.x, a.z - c.position.z) - Math.hypot(b.x - c.position.x, b.z - c.position.z));
                            tgt = huntCandidates[0];
                            combat.selectTarget(tgt);
                        }
                    }
                    // Priority 3: Only naturally aggressive enemies (def.behavior === 'aggressive')
                    // DO NOT attack neutral/yellow passive mobs unless already aggroed above!
                    if (!tgt) {
                        const hostiles = (cr.list || []).filter(rec => cr.isAlive(rec) && rec.def && rec.def.behavior === 'aggressive' && Math.hypot(rec.x - c.position.x, rec.z - c.position.z) <= 18.0);
                        if (hostiles.length > 0) {
                            hostiles.sort((a, b) => Math.hypot(a.x - c.position.x, a.z - c.position.z) - Math.hypot(b.x - c.position.x, b.z - c.position.z));
                            tgt = hostiles[0];
                            combat.selectTarget(tgt);
                        }
                    }
                }
            }

            // If no target around -> IDLE mode. Conserve mana, do not cast in the air!
            if (!tgt) return;

            const dist = Math.hypot(tgt.x - c.position.x, tgt.z - c.position.z);
            const allSkills = this.getAvailableSkills();
            const w = combat.weapon ? combat.weapon() : null;
            const isRanged = (w && (w.style === 'bow' || w.style === 'staff')) || allSkills.some(s => s.type === 'projectile' || s.type === 'strike');
            const maxCastRange = 16.0;

            // Out of range: autobattle never drags the hero around (the quest autopilot walks by itself)
            if (dist > maxCastRange) return;

            // Wait if currently casting or channeling
            if (skills && (skills.casting || skills.channel)) return;

            // 1. Defensive Buff / Shield (Metadata: s.type === 'buff')
            const buffSkill = allSkills.find(s => s.type === 'buff' && skills.cooldownRemaining(s.id) === 0 && this.canAfford(s));
            if (buffSkill && hero && this.isUnderThreat(tgt)) {
                const buffId = (buffSkill.buff && buffSkill.buff.id) ? buffSkill.buff.id : buffSkill.id;
                if (!hero.hasEffect(buffId)) {
                    if (skills.activate(buffSkill.id) === 'ok') return;
                }
            }

            // 2. Crowd Control / AoE: type nova (around hero) / rain (on the target area).
            //    Used only when it will really hit several enemies that are fighting us.
            const foes = (cr.list || []).filter(rec => cr.isAlive(rec) && (rec.aggro || rec === tgt));
            const around = (x, z, r) => foes.filter(rec => Math.hypot(rec.x - x, rec.z - z) <= r).length;
            for (const s of allSkills) {
                if (skills.cooldownRemaining(s.id) > 0 || !this.canAfford(s)) continue;
                if (s.type === 'nova' && around(c.position.x, c.position.z, s.radius || 6.0) >= 2) {
                    if (skills.activate(s.id) === 'ok') return;
                } else if (s.type === 'rain' && dist <= ((s.range || 16) + 2) && around(tgt.x, tgt.z, s.radius || 5.0) >= 3) {
                    if (skills.activate(s.id) === 'ok') return;
                }
            }

            // Movement skills (blink / dash) are deliberately NOT used by autobattle:
            // they jump along the hero's facing, i.e. straight into the enemy he is looking at.

            // 4. Single-target attacks (projectile / strike / melee), longest cooldown first:
            //    the shortest-cooldown spell naturally becomes the filler.
            const attacks = allSkills.filter(s => (s.type === 'strike' || s.type === 'projectile' || s.type === 'melee') && dist <= ((s.range || 16) + 2));
            attacks.sort((a, b) => (b.cooldown || 0) - (a.cooldown || 0));
            for (const attack of attacks) {
                if (skills.cooldownRemaining(attack.id) === 0 && this.canAfford(attack)) {
                    if (skills.activate(attack.id) === 'ok') return;
                }
            }

            // 5. Nothing to cast right now: plain weapon attack (a staff / bow shoots its bolt).
            const hasRangedSkills = allSkills.some(s => s.type === 'strike' || s.type === 'projectile');
            if (!hasRangedSkills) {
                combat.performBasicAttack();   // melee hero: walks up and swings
                return;
            }
            // Ranged hero: attack only when the target is already within weapon reach (never walk toward it),
            // and do not restart an attack that is already running on this target.
            const wpn = combat.weapon ? combat.weapon() : null;
            const reach = (wpn && wpn.range) || 2;
            const edge = dist - ((tgt.def && tgt.def.hitRadius) || 0.4);
            const eng = combat.engagement;
            if (edge <= reach && !(eng && eng.rec === tgt)) combat.attackCreature(tgt);
        }

        // ---------------------------------------------------------------------
        // 2. AUTO-QUEST ENGINE
        // ---------------------------------------------------------------------
        updateQuest(delta) {
            const g = this.game;
            const st = g.gameState;
            if (!st) return;

            // User steering override: if user manually moves, pause auto-navigation
            if (Date.now() < this._manualMovePauseUntil) return;

            this._questTimer -= delta;
            if (this._questTimer > 0) return;
            this._questTimer = 0.20; // Check quest progress every 200ms

            const gc = window.GAME_CONTENT;
            const allQuests = (gc && gc.quests) || {};

            // 1. Find currently active quest
            let activeQuestDef = null;
            for (const [qid, status] of Object.entries(st.quests || {})) {
                if (status === 'active' && allQuests[qid]) {
                    activeQuestDef = allQuests[qid];
                    break;
                }
            }

            // 2. If NO active quest: find and accept the next available quest!
            if (!activeQuestDef) {
                activeQuestDef = this.findNextEligibleQuest();
                if (!activeQuestDef) {
                    // All quests are finished!
                    this.toggleQuest(false);
                    if (g.ui && g.ui.floatText) g.ui.floatText('Все доступные задания выполнены!', 'good');
                    return;
                }
                this.executeTakeQuest(activeQuestDef);
                return;
            }

            // 3. We have an active quest: check if ready to turn in
            const ready = this.isQuestReady(activeQuestDef);
            if (ready) {
                this.executeTurnInQuest(activeQuestDef);
            } else {
                this.executeQuestObjective(activeQuestDef, delta);
            }
        }

        /** Checks if active quest objectives are fulfilled using dialog.js questProgress */
        isQuestReady(qDef) {
            const ui = this.game.ui;
            if (ui && ui.dialog && typeof ui.dialog.questProgress === 'function') {
                const prog = ui.dialog.questProgress(qDef);
                return !!(prog && prog.ready);
            }
            // Fallback manual check
            const st = this.game.gameState;
            if (!st || !qDef || !qDef.objective) return false;
            const obj = qDef.objective;
            if (obj.type === 'kill') {
                return (st.questKills && st.questKills[qDef.id]) >= (obj.count || 1);
            } else if (obj.type === 'gather' || obj.type === 'collect') {
                return (st.inventory ? st.inventory.count(obj.item) : 0) >= (obj.count || 1);
            }
            return false;
        }

        /** Returns the creature type needed for current active kill quest (or null) */
        getHuntCreatureType() {
            const st = this.game.gameState;
            const allQuests = (window.GAME_CONTENT && window.GAME_CONTENT.quests) || {};
            for (const [qid, status] of Object.entries(st.quests || {})) {
                if (status === 'active' && allQuests[qid]) {
                    const qDef = allQuests[qid];
                    if (qDef.objective && qDef.objective.type === 'kill' && !this.isQuestReady(qDef)) {
                        return qDef.objective.creature;
                    }
                }
            }
            return null;
        }

        /** Moves to NPC, opens dialog, and accepts quest */
        executeTakeQuest(qDef) {
            const giverId = qDef.giver;
            const npcInfo = this.findNpcLocation(giverId);
            if (!npcInfo) return;

            const g = this.game;
            // If NPC is on another location, path to exit portal
            if (npcInfo.locId !== this.curLocId()) {
                this.navigateToLocation(npcInfo.locId);
                return;
            }

            const c = g.character;
            const dist = Math.hypot(npcInfo.x - c.position.x, npcInfo.z - c.position.z);
            if (dist > 3.4) {
                // Navigate to an approach point 1.6m from NPC so target is outside obstacle
                const angle = Math.atan2(c.position.z - npcInfo.z, c.position.x - npcInfo.x);
                const ax = npcInfo.x + Math.cos(angle) * 1.6;
                const az = npcInfo.z + Math.sin(angle) * 1.6;
                this.navigateTowards(ax, az);
            } else {
                c.stopMovement();
                c.faceTowards(npcInfo.x, npcInfo.z);
                this.interactNpc(giverId, 'questAccept', qDef.id);
            }
        }

        /** Moves to NPC, opens dialog, and turns in quest */
        executeTurnInQuest(qDef) {
            const turnInNpcId = qDef.turnInNpc || qDef.giver;
            const npcInfo = this.findNpcLocation(turnInNpcId);
            if (!npcInfo) return;

            const g = this.game;
            if (npcInfo.locId !== this.curLocId()) {
                this.navigateToLocation(npcInfo.locId);
                return;
            }

            const c = g.character;
            const dist = Math.hypot(npcInfo.x - c.position.x, npcInfo.z - c.position.z);
            if (dist > 3.4) {
                const angle = Math.atan2(c.position.z - npcInfo.z, c.position.x - npcInfo.x);
                const ax = npcInfo.x + Math.cos(angle) * 1.6;
                const az = npcInfo.z + Math.sin(angle) * 1.6;
                this.navigateTowards(ax, az);
            } else {
                c.stopMovement();
                c.faceTowards(npcInfo.x, npcInfo.z);
                this.interactNpc(turnInNpcId, 'questTurnIn', qDef.id);
            }
        }

        /** Executes quest objectives (kill or gather) */
        executeQuestObjective(qDef, delta) {
            const obj = qDef.objective;
            const g = this.game;
            const c = g.character;

            if (obj.type === 'kill') {
                const cr = g.creatures;
                // Find nearest alive target of needed type
                const aliveList = (cr.list || []).filter(rec => cr.isAlive(rec) && rec.type === obj.creature);
                if (aliveList.length > 0) {
                    aliveList.sort((a, b) => Math.hypot(a.x - c.position.x, a.z - c.position.z) - Math.hypot(b.x - c.position.x, b.z - c.position.z));
                    const targetMob = aliveList[0];
                    const dist = Math.hypot(targetMob.x - c.position.x, targetMob.z - c.position.z);

                    if (dist > 14.0) {
                        this.navigateTowards(targetMob.x, targetMob.z);
                    } else {
                        // In spell range: stop and engage via combat rotation!
                        c.stopMovement();
                        g.combat.selectTarget(targetMob);
                        this.updateCombat(delta, targetMob);
                    }
                } else {
                    // No live creature of this type here -> walk to their grounds (maybe via another location)
                    const spawnPos = this.findCreatureSpawnPosition(obj.creature);
                    if (spawnPos) {
                        this.navigateTowards(spawnPos.x, spawnPos.z);
                    } else {
                        const loc = this.findCreatureLocation(obj.creature);
                        if (loc && loc !== this.curLocId()) this.navigateToLocation(loc);
                    }
                }
            } else {
                // Objective types the autopilot cannot do yet (gathering, crafting, building...): hand control back
                this.toggleQuest(false);
                if (g.ui && g.ui.floatText) g.ui.floatText('Автоквест: «' + qDef.name + '» нужно выполнить вручную', 'warn');
            }
        }

        /** Interacts with NPC dialog to accept or complete a quest */
        interactNpc(npcId, action, questId) {
            const now = Date.now();
            if (now < this._dialogCooldown) return;
            this._dialogCooldown = now + 800;

            const g = this.game;
            const ui = g.ui;
            const dialog = ui && ui.dialog;
            const npcObj = this.findNpcInstance(npcId);

            if (action === 'questAccept') {
                if (dialog) {
                    if (!dialog.panel || !dialog.panel.classList.contains('open')) {
                        if (npcObj) ui.openDialog(npcObj);
                    }
                    dialog.choose({ action: 'questAccept', quest: questId });
                }
                // Direct guarantee: activate quest in gameState so the hero proceeds immediately
                if (g.gameState && g.gameState.questStatus(questId) !== 'active') {
                    g.gameState.startQuest(questId);
                    if (ui && ui.floatText) ui.floatText('Новое задание', 'good');
                    if (dialog && dialog.updateTracker) dialog.updateTracker();
                }
                if (dialog && dialog.close) {
                    setTimeout(() => dialog.close(), 350);
                }
            } else if (action === 'questTurnIn') {
                if (dialog) {
                    if (!dialog.panel || !dialog.panel.classList.contains('open')) {
                        if (npcObj) ui.openDialog(npcObj);
                    }
                    dialog.choose({ action: 'questTurnIn', quest: questId });
                    setTimeout(() => {
                        if (dialog.mode === 'reward') dialog.choose({ action: 'close' });
                        else dialog.close();
                    }, 400);
                }
            }
        }

        // ---------------------------------------------------------------------
        // 3. NAVIGATION & DATA LOOKUPS
        // ---------------------------------------------------------------------
        navigateTowards(tx, tz) {
            const g = this.game;
            const c = g.character;
            if (!c || !g.pathfinder) return;

            const now = Date.now();
            if (this._lastNavPoint && Math.hypot(this._lastNavPoint.x - tx, this._lastNavPoint.z - tz) < 2.5 && now < this._nextPathTime) {
                return;
            }
            this._nextPathTime = now + 1200;
            this._lastNavPoint = { x: tx, z: tz };

            const path = g.pathfinder.findPath(c.position, { x: tx, z: tz });
            if (path && path.length > 0) {
                c.setPath(path);
            }
        }

        /** First exit of the current location on the shortest route to targetLoc (BFS over LOCATIONS[*].exits). */
        navigateToLocation(targetLoc) {
            const locs = window.LOCATIONS || {};
            const from = this.curLocId();
            if (!from || !locs[from] || from === targetLoc) return;
            const prev = { [from]: null };
            const queue = [from];
            while (queue.length) {
                const cur = queue.shift();
                if (cur === targetLoc) break;
                for (const ex of ((locs[cur] && locs[cur].exits) || [])) {
                    if (ex.to && !(ex.to in prev) && locs[ex.to]) { prev[ex.to] = { from: cur, ex }; queue.push(ex.to); }
                }
            }
            if (!(targetLoc in prev)) return;
            let step = prev[targetLoc];
            while (step && step.from !== from) step = prev[step.from];
            if (step && step.ex) this.navigateTowards(step.ex.x, step.ex.z);
        }

        findNpcLocation(npcId) {
            const locs = window.LOCATIONS || {};
            const gc = window.GAME_CONTENT;
            for (const [locId, locDef] of Object.entries(locs)) {
                for (const p of (locDef.props || [])) {
                    const propDef = gc && gc.props && gc.props[p.prop];
                    if (propDef && propDef.npc === npcId) {
                        return { locId, x: p.x, z: p.z, propId: p.id };
                    }
                }
            }
            return null;
        }

        findNpcInstance(npcId) {
            const wo = this.game.worldObjects;
            if (wo && wo.props) {
                for (const p of wo.props) {
                    if (p.npc && p.npc.id === npcId) return p.npc;
                }
            }
            return (window.GAME_CONTENT && window.GAME_CONTENT.npcs && window.GAME_CONTENT.npcs[npcId]) || null;
        }

        findCreatureSpawnPosition(type) {
            const locDef = window.LOCATIONS && window.LOCATIONS[this.curLocId()];
            const match = locDef && (locDef.creatures || []).find(sp => sp.type === type);
            return match ? { x: match.x, z: match.z } : null;
        }

        /** Location id whose creature list contains the type (current location first). */
        findCreatureLocation(type) {
            const locs = window.LOCATIONS || {};
            const cur = this.curLocId();
            if (locs[cur] && (locs[cur].creatures || []).some(sp => sp.type === type)) return cur;
            for (const [id, def] of Object.entries(locs)) {
                if ((def.creatures || []).some(sp => sp.type === type)) return id;
            }
            return null;
        }

        findNextEligibleQuest() {
            const st = this.game.gameState;
            const gc = window.GAME_CONTENT;
            const allQuests = (gc && gc.quests) || {};
            const curLoc = this.curLocId();
            const dialog = this.game.ui && this.game.ui.dialog;

            const candidates = [];
            for (const [qid, q] of Object.entries(allQuests)) {
                if (st.quests && (st.quests[qid] === 'done' || st.quests[qid] === 'active')) continue;

                // Use dialog's questAvailable logic (handles both array and string requires)
                const available = dialog ? dialog.questAvailable(q) : this._checkRequires(q, st);
                if (!available) continue;

                const npcLoc = this.findNpcLocation(q.giver);
                candidates.push({ qid, def: q, npcLoc });
            }

            if (candidates.length === 0) return null;

            // Sort: 1) Same location first, 2) Lowest level
            candidates.sort((a, b) => {
                const aSameLoc = (a.npcLoc && a.npcLoc.locId === curLoc) ? 0 : 1;
                const bSameLoc = (b.npcLoc && b.npcLoc.locId === curLoc) ? 0 : 1;
                if (aSameLoc !== bSameLoc) return aSameLoc - bSameLoc;
                return (a.def.level || 1) - (b.def.level || 1);
            });

            return candidates[0].def;
        }

        _checkRequires(q, st) {
            if (!q.requires) return true;
            if (Array.isArray(q.requires)) {
                return q.requires.every(req => st.questStatus(req) === 'done');
            }
            return st.questStatus(q.requires) === 'done';
        }
    }

    window.AveloraAutoPlay = AveloraAutoPlay;
})();
