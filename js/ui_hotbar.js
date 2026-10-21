/**
 * Avelora — Hotbar, inventory panel, skills panel, drag & drop, floating texts
 *
 * DOM lives in index.html (#skill-bar slots, #inventory-panel, #skills-panel,
 * #item-tooltip, #drag-ghost); this module fills and drives it from the current
 * character's state (game_state.js). Nothing here pauses the game.
 *
 * HOTBAR RULES (the bar is for ACTIONS):
 *   - 10 slots, keys 1..9,0 (physical e.code Digit1..Digit0 — any keyboard
 *     layout) or click/tap on the slot.
 *   - skills: always allowed (only the character's own).
 *   - items: only if the def has a non-null `use` (tools/consumables). Materials
 *     are rejected with a red flash + "Нельзя: у предмета нет действия".
 *   - an item slot is a BINDING by item id, not a copy: shows the total count in
 *     the bag, greys out when the character no longer has it.
 *   - use.type 'equip' toggles holding the item in the right hand.
 *
 * DRAG & DROP uses POINTER events (mouse AND touch — HTML5 DnD doesn't work on
 * touch screens): skills panel -> slot, bag -> slot, bag -> bag (swap/merge),
 * slot -> slot (swap), slot -> anywhere off the bar (clear), bag cell -> the
 * game WORLD (released outside every panel/HUD element: the whole stack is
 * dropped at the character's feet as a ground pile — world_objects.js
 * dropFromInventory; dropping the equipped item unequips it). Draggable elements
 * have `touch-action: none` so the browser doesn't turn the gesture into a
 * scroll; main.js ignores touches/clicks that start on these elements (UI_SELECTOR).
 */
(function () {
    'use strict';

    const DRAG_THRESHOLD = 6;      // px before a press becomes a drag
    const FLOAT_LIFE = 1.5;        // seconds (game time) a floating "+5 Камень" lives
    const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

    function hueOf(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
        return h % 360;
    }

    /** One-line stats of a skill for the skills panel / tooltip, by skill type. */
    function skillMeta(def, hero) {
        const cd = `Перезарядка ${def.cooldown || 0} с`;
        const cost = hero && typeof hero.skillManaCost === 'function' ? hero.skillManaCost(def) : (def.mana || 0);
        const mana = cost ? ` · Мана ${cost}` : (def.mana ? ` · Мана ${def.mana}` : '');
        const kb = (def.knockback && def.knockback.distance) ? ` · Отбрасывание ${def.knockback.distance} м` : '';
        const stun = (def.stun && def.stun.duration) ? ` · Оглушение ${def.stun.duration} с` : '';
        if (def.type === 'teleport') return `Каст ${def.castTime || 0} с · ${cd}`;
        if (def.type === 'nova') return `${cd} · Радиус ${(def.vfx && def.vfx.impactRadius) || 0} м` + kb + stun + mana;
        if (def.type === 'rain') return `${cd} · Дальность ${def.range || 0} м · Радиус ${(def.rain && def.rain.radius) || 0} м` + kb + stun + mana;
        if (def.type === 'buff') return cd + (def.buff && def.buff.duration ? ` · Длительность ${def.buff.duration} с` : '') + mana;
        const slow = (def.slow && def.slow.factor < 1) ? ` · Замедление −${Math.round((1 - def.slow.factor) * 100)} % на ${def.slow.duration} с` : '';
        return `${cd} · Дальность ${def.range || 0} м` + slow + kb + stun + mana;
    }

    /** Icon element for an item/skill def: its icon.png, or a styled first-letter tile. */
    function makeIcon(def) {
        if (def && def.iconData) {
            const img = document.createElement('img');
            img.className = 'ui-icon';
            img.src = def.iconData;
            img.alt = '';
            img.draggable = false;
            return img;
        }
        const el = document.createElement('span');
        el.className = 'ui-icon icon-fallback';
        const name = (def && (def.name || def.id)) || '?';
        el.textContent = name.charAt(0).toUpperCase();
        const h = hueOf((def && def.id) || name);
        el.style.background = `radial-gradient(circle at 35% 30%, hsl(${h},32%,34%) 0%, hsl(${h},30%,16%) 100%)`;
        return el;
    }

    class AveloraHotbarUI {
        constructor(game) {
            this.game = game;
            window.AveloraHotbar = this;
            this.state = null;
            this.floats = [];
            this.drag = null;          // active press/drag
            this.skillsOpen = false;
            this.heroOpen = false;
            this.questsOpen = false;
            this.questTab = 'active';
            this.microMenuOpen = false;
            this.cdCache = new Array(10).fill(-1);
            this.tooltipTimer = null;
            this._v = new THREE.Vector3();

            this.bar = document.getElementById('skill-bar');
            this.slots = Array.from(document.querySelectorAll('#skill-bar .skill-slot:not(.hud-btn)')).slice(0, 10);
            this.invPanel = document.getElementById('inventory-panel');
            this.invGrid = this.invPanel ? this.invPanel.querySelector('.inventory-grid') : null;
            this.chestPanel = document.getElementById('chest-panel');
            this.chestGrid = this.chestPanel ? this.chestPanel.querySelector('.chest-grid') : null;
            this.chestTitle = document.getElementById('chest-title');
            this.chestInv = null;      // Inventory of the open chest (game_state.chestInventory)
            this.chestCells = [];
            this.invEmpty = this.invPanel ? this.invPanel.querySelector('.inventory-empty') : null;
            this.invBtn = document.getElementById('inventory-btn');
            this.skillsBtn = document.getElementById('skills-btn');
            this.skillsPanel = document.getElementById('skills-panel');
            this.skillsList = document.getElementById('skills-list');
            this.tooltip = document.getElementById('item-tooltip');
            this.ghost = document.getElementById('drag-ghost');
            this.labelsEl = document.getElementById('world-labels');
            this.quantityModal = document.getElementById('quantity-modal');

            this.microToggleBtn = document.getElementById('micromenu-toggle-btn');
            this.microDock = document.getElementById('micromenu-dock');
            this.heroBtn = document.getElementById('hero-btn');
            this.questsBtn = document.getElementById('quests-btn');
            this.heroPanel = document.getElementById('hero-panel');
            this.questsPanel = document.getElementById('quests-panel');
            this.heroCloseBtn = document.getElementById('hero-panel-close');
            this.questsCloseBtn = document.getElementById('quests-panel-close');

            this.potionBtn = document.getElementById('potion-btn');
            this.potionModal = document.getElementById('potion-modal');
            this.potionModalClose = document.getElementById('potion-modal-close');
            this.potionCloseBtn = document.getElementById('potion-close-btn');
            this.potionDrinkBtn = document.getElementById('potion-drink-btn');
            this.potionAutoToggle = document.getElementById('potion-auto-toggle');
            this.potionThresholdSlider = document.getElementById('potion-threshold-slider');
            this.potionThresholdVal = document.getElementById('potion-threshold-val');
            this.potionChoiceGrid = document.getElementById('potion-choice-grid');
            this.potionPresets = Array.from(document.querySelectorAll('.potion-pct-preset'));
            this.potionOpen = false;
            this.autoPotion = { enabled: false, threshold: 40, itemId: 'potion_health_small' };
            this._autoPotionCooldown = 0;
            this.loadAutoPotionSettings();

            this.buildSlots();
            this.buildInventoryCells();
            this.setupCraftingPanel();
            this.setupQuantityModal();
            this.setupMicroMenu();
            this.setupHeroModal();
            this.setupQuestsModal();
            this.setupPotionSlot();
            this.setupPotionModal();
            this.setupChest();
            this.dialog = window.AveloraDialog ? new window.AveloraDialog(game, this) : null;
            window.addEventListener('game:location', () => { if (this.state) this.renderSkills(); }); // skill names depend on the location
            this.setupEvents();
            this.setupDraggablePanels();
        }

        // -----------------------------------------------------------
        // DOM scaffolding
        // -----------------------------------------------------------
        buildSlots() {
            this.slots.forEach((slot, i) => {
                slot.classList.add('hotbar-slot', 'empty');
                slot.dataset.slot = String(i);
                slot.innerHTML = '';
                const icon = document.createElement('span'); icon.className = 'slot-icon';
                const cd = document.createElement('span'); cd.className = 'slot-cd';
                const count = document.createElement('span'); count.className = 'slot-count';
                const key = document.createElement('span'); key.className = 'slot-key'; key.textContent = KEY_LABELS[i];
                const dot = document.createElement('span'); dot.className = 'slot-range-dot';
                slot.append(icon, cd, count, key, dot);
                slot._icon = icon; slot._cd = cd; slot._count = count; slot._key = key; slot._rangeDot = dot;
                slot._outOfRange = false;
                if (i === 0) {
                    const medalFrame = document.createElement('span');
                    medalFrame.className = 'slot0-medal-frame';
                    const medalTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.slot0Frame;
                    if (medalTex) medalFrame.style.backgroundImage = `url("${medalTex}")`;
                    slot.appendChild(medalFrame);

                    const combatFrame = document.createElement('span');
                    combatFrame.className = 'slot-combat-frame slot0-pc-frame';
                    const combatTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.btnCombatFrame;
                    if (combatTex) combatFrame.style.backgroundImage = `url("${combatTex}")`;
                    slot.appendChild(combatFrame);
                    slot._frame = combatFrame;
                } else if (i >= 1 && i <= 4) {
                    const frame = document.createElement('span');
                    frame.className = 'slot-combat-frame';
                    const frameTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.btnCombatFrame;
                    if (frameTex) frame.style.backgroundImage = `url("${frameTex}")`;
                    slot.appendChild(frame);
                    slot._frame = frame;
                } else if (i === 5 || i === 6) {
                    const frame = document.createElement('span');
                    frame.className = 'slot-utility-frame';
                    const frameTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.btnUtilityFrame;
                    if (frameTex) frame.style.backgroundImage = `url("${frameTex}")`;
                    slot.appendChild(frame);
                    slot._frame = frame;
                }
            });
        }

        buildInventoryCells() {
            if (!this.invGrid) return;
            this.invGrid.innerHTML = '';
            this.cells = [];
            for (let i = 0; i < window.AveloraItems.INVENTORY_SIZE; i++) {
                const c = document.createElement('div');
                c.className = 'inventory-cell';
                c.dataset.cell = String(i);
                this.invGrid.appendChild(c);
                this.cells.push(c);
            }
        }


        // -----------------------------------------------------------
        // Chest panel (world_objects.js openChest/closeChest)
        // -----------------------------------------------------------
        setupChest() {
            const btn = document.getElementById('chest-close');
            if (btn) btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.game.worldObjects) this.game.worldObjects.closeChest(); else this.closeChest();
            });
        }

        isChestOpen() { return !!this.chestInv; }

        // NPC dialog / shop window (dialog.js)
        isDialogOpen() { return !!(this.dialog && this.dialog.isOpen()); }
        openDialog(npc) { if (this.dialog) this.dialog.open(npc); }
        closeDialog() { if (this.dialog) this.dialog.close(); }

        openChest(title, inv) {
            if (!this.chestPanel || !this.chestGrid) return;
            this.chestInv = inv;
            if (this.chestTitle) this.chestTitle.textContent = title || 'Сундук';
            this.chestGrid.innerHTML = '';
            this.chestCells = [];
            for (let i = 0; i < inv.cells.length; i++) {
                const c = document.createElement('div');
                c.className = 'chest-cell';
                c.dataset.cell = String(i);
                this.chestGrid.appendChild(c);
                this.chestCells.push(c);
            }
            this.setPanelAria(this.chestPanel, true);
            this.game.setInventoryOpen(true); // bag opens next to the chest
            if (this.switchInventoryTab) this.switchInventoryTab('inv');
            this.renderChest();
        }

        closeChest() {
            this.chestInv = null;
            this.cancelDrag();
            this.setPanelAria(this.chestPanel, false);
            this.hideTooltip();
        }

        renderChest() {
            if (!this.chestInv) return;
            this.chestCells.forEach((cell, i) => {
                const c = this.chestInv.cells[i];
                cell.innerHTML = '';
                cell.classList.toggle('filled', !!c);
                if (!c) return;
                cell.appendChild(makeIcon(window.AveloraItems.get(c.item)));
                if (c.count > 1) {
                    const b = document.createElement('span');
                    b.className = 'cell-count';
                    b.textContent = String(c.count);
                    cell.appendChild(b);
                }
            });
        }

        /** Moves/merges/swaps one cell between two inventories (bag <-> chest or inside one). */
        transferCell(from, fi, to, ti) {
            const Items = window.AveloraItems;
            if (from === to) return from.move(fi, ti);
            const a = from.cells[fi], b = to.cells[ti];
            if (!a) return false;
            if (b && b.item === a.item) {
                const k = Math.min(a.count, Items.stackMax(a.item) - b.count);
                if (k > 0) {
                    b.count += k; a.count -= k;
                    if (a.count <= 0) from.cells[fi] = null;
                } else { from.cells[fi] = b; to.cells[ti] = a; }
            } else {
                from.cells[fi] = b; to.cells[ti] = a;
            }
            this.afterTransfer(from, to);
            return true;
        }

        /** Whole stack of one cell into the first place that fits in the other inventory. */
        quickMove(from, fi, to) {
            const a = from.cells[fi];
            if (!a) return;
            const n = Math.min(a.count, to.spaceFor(a.item));
            if (n <= 0) {
                this.floatText(to === this.chestInv ? 'Сундук полон' : 'Сумка полна', 'warn');
                return;
            }
            a.count -= n;
            if (a.count <= 0) from.cells[fi] = null;
            to.add(a.item, n);
            this.afterTransfer(from, to);
        }

        afterTransfer(from, to) {
            const st = this.state;
            from.changed();
            if (to !== from) to.changed();
        }

        // -----------------------------------------------------------
        // Character binding
        // -----------------------------------------------------------
        /** Called by main.js whenever a (new) character's state is loaded. */
        bindCharacter(state) {
            this.state = state;
            if (state) state.onChange(() => this.renderAll());
            this.cancelDrag();
            this.clearFloats();
            this.closeDialog();
            this.closeChest();
            if (this.game && this.game.setInventoryOpen) this.game.setInventoryOpen(false);
            if (this.skillsBtn) this.skillsBtn.style.display = '';
            this.updatePlayerPortrait();
            this.renderAll();
        }

        characterSkills() {
            const cfg = this.game.currentCharacterConfig;
            return (cfg && this.game.skills) ? this.game.skills.forCharacter(cfg.id) : [];
        }

        renderAll() {
            this.renderInventory();
            if (this.dialog) this.dialog.refresh();
            if (this.heroOpen) this.updateHeroStats();
            if (this.questsOpen) this.updateQuestsProgress();
            this.renderChest();
            this.renderHotbar();
            this.renderSkills();
            this.renderCrafting();
            this.updatePotionSlot();
            if (this.potionOpen) this.updatePotionModal();
        }

        renderInventory() {
            if (!this.cells) return;
            const inv = this.state ? this.state.inventory : null;
            let any = false;
            this.cells.forEach((cell, i) => {
                const c = inv ? inv.cells[i] : null;
                cell.innerHTML = '';
                cell.classList.toggle('filled', !!c);
                cell.classList.remove('equipped');   // (an item in the hand is not in the bag)
                if (!c) return;
                any = true;
                const def = window.AveloraItems.get(c.item);
                cell.appendChild(makeIcon(def));
                if (c.count > 1) {
                    const b = document.createElement('span');
                    b.className = 'cell-count';
                    b.textContent = String(c.count);
                    cell.appendChild(b);
                }
            });
            if (this.invEmpty) this.invEmpty.style.display = any ? 'none' : '';
        }

        renderHotbar() {
            const hb = this.state ? this.state.hotbar : [];
            this.slots.forEach((slot, i) => {
                const e = hb[i] || null;
                slot._icon.innerHTML = '';
                slot._count.textContent = '';
                slot.classList.remove('missing', 'is-skill', 'is-item', 'is-basic-attack', 'equipped', 'out-of-range');
                slot._outOfRange = false;
                slot.classList.toggle('empty', !e);
                this.cdCache[i] = -1;
                slot._cd.style.background = '';
                if (!e) {
                    // Touch UI fan: central button (Slot 0) defaults to weapon in hand or fists
                    const isTouchUi = document.body && document.body.classList.contains('touch-ui');
                    if (i === 0 && isTouchUi) {
                        slot.classList.remove('empty');
                        slot.classList.add('is-basic-attack');
                        const eqId = this.state && this.state.equipped && this.state.equipped.right;
                        const def = eqId ? window.AveloraItems.get(eqId) : null;
                        if (def) {
                            slot._icon.appendChild(makeIcon(def));
                        } else {
                            const fistTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.fistIcon;
                            if (fistTex) {
                                const img = document.createElement('img');
                                img.className = 'ui-icon icon-fist-img';
                                img.src = fistTex;
                                img.alt = 'Кулачный бой';
                                img.draggable = false;
                                slot._icon.appendChild(img);
                            } else {
                                const icon = document.createElement('span');
                                icon.className = 'icon-basic-attack';
                                icon.textContent = '👊';
                                slot._icon.appendChild(icon);
                            }
                        }
                    }
                    return;
                }
                if (e.type === 'skill') {
                    slot.classList.add('is-skill');
                    slot._icon.appendChild(makeIcon(this.game.skills.get(e.id)));
                } else {
                    slot.classList.add('is-item');
                    const def = window.AveloraItems.get(e.id);
                    slot._icon.appendChild(makeIcon(def));
                    const n = this.state.ownedCount(e.id);   // bag + hand
                    if (n <= 0) slot.classList.add('missing');
                    slot._count.textContent = n > 1 ? String(n) : '';
                    if (this.state.equippedSlotOf(e.id)) slot.classList.add('equipped');
                }
            });
        }

        /** Skills panel: accordion by def.category (skill.json). */
        renderSkills() {
            if (!this.skillsList) return;
            this.skillsList.innerHTML = '';
            const GROUPS = [['attack', 'Атака'], ['defense', 'Защита'], ['travel', 'Перемещение'], ['other', 'Прочее']];
            const byGroup = {};
            this.characterSkills().forEach(def => {
                const k = GROUPS.some(g => g[0] === def.category) ? def.category : 'other';
                (byGroup[k] = byGroup[k] || []).push(def);
            });
            // All three main groups are always listed (an empty one says so); "Прочее" only when something lands there
            const shown = GROUPS.filter(g => byGroup[g[0]] || g[0] !== 'other');
            const hasAttack = shown.some(g => g[0] === 'attack' && byGroup['attack'] && byGroup['attack'].length);
            const firstFull = shown.find(g => byGroup[g[0]]);
            if (!this.skillsOpenGroup || !shown.some(g => g[0] === this.skillsOpenGroup)) {
                this.skillsOpenGroup = hasAttack ? 'attack' : (firstFull ? firstFull[0] : 'attack');
            }
            shown.forEach(([key, title]) => {
                const sec = document.createElement('div');
                sec.className = 'skill-group' + (this.skillsOpenGroup === key ? ' open' : '');
                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'skill-group-head';
                head.setAttribute('aria-expanded', this.skillsOpenGroup === key ? 'true' : 'false');
                head.innerHTML = '<span class="skill-group-chev">▸</span><span class="skill-group-title"></span><span class="skill-group-count"></span>';
                head.querySelector('.skill-group-title').textContent = title;
                head.querySelector('.skill-group-count').textContent = String((byGroup[key] || []).length);
                head.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !sec.classList.contains('open');
                    this.skillsOpenGroup = open ? key : null;
                    this.skillsList.querySelectorAll('.skill-group').forEach(s => {
                        s.classList.remove('open');
                        s.querySelector('.skill-group-head').setAttribute('aria-expanded', 'false');
                    });
                    if (open) { sec.classList.add('open'); head.setAttribute('aria-expanded', 'true'); }
                });
                const body = document.createElement('div');
                body.className = 'skill-group-body';
                sec.append(head, body);
                this.skillsList.appendChild(sec);
                if (!byGroup[key]) {
                    const empty = document.createElement('div');
                    empty.className = 'skill-group-empty';
                    empty.textContent = 'Пока нет навыков';
                    body.appendChild(empty);
                } else byGroup[key].forEach(def => body.appendChild(this.skillEntryEl(def)));
            });
        }

        skillEntryEl(def) {
            {
                const row = document.createElement('div');
                row.className = 'skill-entry';
                row.dataset.skill = def.id;
                const iconWrap = document.createElement('div');
                iconWrap.className = 'skill-entry-icon';
                iconWrap.appendChild(makeIcon(def));
                const cd = document.createElement('span');
                cd.className = 'slot-cd';
                iconWrap.appendChild(cd);
                row._cd = cd;
                const text = document.createElement('div');
                text.className = 'skill-entry-text';
                const name = document.createElement('div');
                name.className = 'skill-entry-name';
                const lab = this.game.skills.labelOf(def);
                name.textContent = lab.name;
                const desc = document.createElement('div');
                desc.className = 'skill-entry-desc';
                desc.textContent = lab.description || '';
                const meta = document.createElement('div');
                meta.className = 'skill-entry-meta';
                meta.textContent = skillMeta(def, this.game.hero);
                const sl = this.skillStatsLine(def);
                if (sl) {
                    const dmgEl = document.createElement('div');
                    dmgEl.className = 'skill-entry-meta';
                    dmgEl.style.color = '#a9d68c';
                    dmgEl.style.fontWeight = '600';
                    dmgEl.textContent = sl;
                    text.append(name, desc, meta, dmgEl);
                } else {
                    text.append(name, desc, meta);
                }
                row.append(iconWrap, text);
                return row;
            }
        }

        setupCraftingPanel() {
            this.craftingPanel = document.getElementById('crafting-panel');
            this.craftingClose = document.getElementById('crafting-close');
            this.craftMenuBtn = document.getElementById('craft-btn');
            this.heroCraftBtn = document.getElementById('hero-open-craft-btn');
            this.invCraftBtn = document.getElementById('inv-open-craft-btn');
            this.craftingList = document.getElementById('crafting-recipe-list');
            this.craftingOpen = false;
            this.craftOpenGroup = 'potions';

            if (this.craftingPanel) {
                ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach(evt => {
                    this.craftingPanel.addEventListener(evt, (e) => {
                        e.stopPropagation();
                    });
                });
            }

            if (this.craftingClose) {
                this.craftingClose.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setCraftingOpen(false);
                });
            }
            if (this.craftMenuBtn) {
                this.craftMenuBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeMicroMenu();
                    if (this.inputAllowed()) this.toggleCrafting();
                });
            }
            if (this.heroCraftBtn) {
                this.heroCraftBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setCraftingOpen(true);
                });
            }
            if (this.invCraftBtn) {
                this.invCraftBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleCrafting();
                });
            }
        }

        isCraftingOpen() { return this.craftingOpen; }

        toggleCrafting() { this.setCraftingOpen(!this.craftingOpen); }

        setCraftingOpen(open) {
            this.craftingOpen = !!open;
            this.setPanelAria(this.craftingPanel, this.craftingOpen);
            if (this.craftMenuBtn) this.craftMenuBtn.classList.toggle('active', this.craftingOpen);
            if (this.invCraftBtn) this.invCraftBtn.classList.toggle('active', this.craftingOpen);
            if (this.craftingOpen) {
                if (!this.craftOpenGroup) this.craftOpenGroup = 'potions';
                this.renderCrafting();
            }
            this.layoutPanels();
            if (!this.craftingOpen) this.hideTooltip();
        }

        renderCrafting() {
            if (!this.craftingList) return;
            this.craftingList.innerHTML = '';
            const allRecipes = (window.GAME_CONTENT && window.GAME_CONTENT.recipes) || {};
            const st = this.state;

            // Только изученные персонажем рецепты (на старте все изъяты)
            const knownIds = Object.keys(allRecipes).filter(id => st && st.knowsRecipe(id));

            if (!knownIds.length) {
                const empty = document.createElement('div');
                empty.className = 'crafting-empty';
                empty.innerHTML = 'Пока нет изученных рецептов.<div style="font-size:0.75rem; color:#8f9c9b; margin-top:6px;">Обучитесь алхимии и ремеслу у жителей долины.</div>';
                this.craftingList.appendChild(empty);
                return;
            }

            const CRAFT_GROUPS = [
                ['potions', 'Зелья'],
                ['equipment', 'Экипировка'],
                ['materials', 'Материалы'],
                ['other', 'Прочее']
            ];

            const byGroup = {};
            knownIds.forEach(id => {
                const rec = allRecipes[id];
                const resItem = window.AveloraItems.get(rec.result.item);
                let g = 'other';
                if (rec.category === 'alchemy') g = 'potions';
                else if (['tailoring', 'equipment', 'armor', 'jewelry'].includes(rec.category) || (resItem && resItem.use && resItem.use.type === 'equip')) g = 'equipment';
                else if (['carpentry', 'materials', 'refining'].includes(rec.category) || (resItem && resItem.category === 'material')) g = 'materials';
                (byGroup[g] = byGroup[g] || []).push(id);
            });

            // Показываем группы
            const shown = CRAFT_GROUPS.filter(g => byGroup[g[0]] || g[0] !== 'other');
            const firstFull = shown.find(g => byGroup[g[0]]);
            const hasPotions = shown.some(g => g[0] === 'potions');
            if (!this.craftOpenGroup || !shown.some(g => g[0] === this.craftOpenGroup)) {
                this.craftOpenGroup = hasPotions ? 'potions' : (firstFull ? firstFull[0] : 'potions');
            }

            shown.forEach(([key, title]) => {
                const sec = document.createElement('div');
                sec.className = 'skill-group craft-group' + (this.craftOpenGroup === key ? ' open' : '');

                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'skill-group-head craft-group-head';
                head.setAttribute('aria-expanded', this.craftOpenGroup === key ? 'true' : 'false');
                head.innerHTML = '<span class="skill-group-chev">▸</span><span class="skill-group-title"></span><span class="skill-group-count"></span>';
                head.querySelector('.skill-group-title').textContent = title;
                head.querySelector('.skill-group-count').textContent = String((byGroup[key] || []).length);

                head.addEventListener('click', () => {
                    const open = !sec.classList.contains('open');
                    this.craftOpenGroup = open ? key : null;
                    this.craftingList.querySelectorAll('.craft-group').forEach(s => {
                        s.classList.remove('open');
                        s.querySelector('.craft-group-head').setAttribute('aria-expanded', 'false');
                    });
                    if (open) {
                        sec.classList.add('open');
                        head.setAttribute('aria-expanded', 'true');
                    }
                });

                const body = document.createElement('div');
                body.className = 'skill-group-body craft-group-body';
                sec.append(head, body);
                this.craftingList.appendChild(sec);

                const idsInGroup = byGroup[key] || [];
                if (!idsInGroup.length) {
                    const empty = document.createElement('div');
                    empty.className = 'skill-group-empty';
                    empty.textContent = 'Пока нет изученных рецептов';
                    body.appendChild(empty);
                } else {
                    idsInGroup.forEach(id => {
                        body.appendChild(this.craftCardEl(id, allRecipes[id]));
                    });
                }
            });
        }

        craftCardEl(id, rec) {
            const inv = this.state ? this.state.inventory : null;
            const card = document.createElement('div');
            card.className = 'crafting-card';

            const resItemDef = window.AveloraItems.get(rec.result.item);
            const iconDef = rec.iconData ? rec : resItemDef;

            const topRow = document.createElement('div');
            topRow.className = 'crafting-card-top';

            const iconWrap = document.createElement('div');
            iconWrap.className = 'crafting-card-icon craft-tip';
            iconWrap.dataset.item = rec.result.item;
            iconWrap.appendChild(makeIcon(iconDef));

            const infoWrap = document.createElement('div');
            infoWrap.className = 'crafting-card-info';
            const title = document.createElement('div');
            title.className = 'crafting-card-title craft-tip';
            title.dataset.item = rec.result.item;
            title.textContent = rec.name || (resItemDef ? resItemDef.name : id);
            const desc = document.createElement('div');
            desc.className = 'crafting-card-desc';
            desc.textContent = rec.description || (resItemDef ? resItemDef.description : '');
            infoWrap.append(title, desc);
            const stn = this.stationInfo(rec);
            if (stn) {
                const sl = document.createElement('div');
                sl.className = 'crafting-station ' + (stn.near ? 'near' : 'far');
                sl.textContent = stn.near ? `✓ ${stn.name} рядом` : `Нужна: ${stn.name} — подойдите к ней`;
                infoWrap.appendChild(sl);
            }

            topRow.append(iconWrap, infoWrap);

            const ingContainer = document.createElement('div');
            ingContainer.className = 'crafting-ingredients';

            let canCraft = !stn || stn.near;
            const ingredients = rec.ingredients || [];
            const maxQty = this.maxCraftable(rec);
            if (!this.craftQty) this.craftQty = {};
            const qty = Math.max(1, Math.min(this.craftQty[id] || 1, Math.max(1, maxQty)));
            this.craftQty[id] = qty;
            ingredients.forEach(ing => {
                const have = inv ? inv.count(ing.item) : 0;
                const need = ing.count * qty;
                if (have < need) canCraft = false;

                const itemDef = window.AveloraItems.get(ing.item);
                const name = itemDef ? itemDef.name : ing.item;

                const ingRow = document.createElement('div');
                ingRow.className = `crafting-ingredient-row ${have >= need ? 'has-enough' : 'not-enough'}`;

                const ingIcon = document.createElement('span');
                ingIcon.className = 'crafting-ing-icon craft-tip';
                ingIcon.dataset.item = ing.item;
                ingIcon.appendChild(makeIcon(itemDef));

                const ingName = document.createElement('span');
                ingName.className = 'crafting-ing-name';
                ingName.textContent = name;

                const ingCount = document.createElement('span');
                ingCount.className = 'crafting-ing-count';
                ingCount.textContent = `${have} / ${need}`;

                ingRow.append(ingIcon, ingName, ingCount);
                ingContainer.appendChild(ingRow);
            });

            const btnRow = document.createElement('div');
            btnRow.className = 'crafting-btn-row';

            const craftBtn = document.createElement('button');
            craftBtn.type = 'button';
            craftBtn.className = `craft-action-btn ${canCraft ? 'ready' : 'disabled'}`;
            craftBtn.textContent = '⚒';
            craftBtn.title = qty > 1 ? `Создать ×${qty}` : 'Создать';
            craftBtn.setAttribute('aria-label', craftBtn.title);
            craftBtn.disabled = !canCraft;

            craftBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.craftRecipe(id, qty);
            });

            // Quantity picker: craft a whole batch with one click
            const qtyBox = document.createElement('div');
            qtyBox.className = 'craft-qty';
            const mkBtn = (txt, tTitle, fn) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = 'craft-qty-btn'; b.textContent = txt; b.title = tTitle;
                b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
                return b;
            };
            const setQty = (v) => {
                this.craftQty[id] = Math.max(1, Math.min(Math.max(1, maxQty), v));
                this.renderCrafting();
            };
            const qInput = document.createElement('input');
            qInput.type = 'number'; qInput.className = 'craft-qty-input';
            qInput.min = '1'; qInput.max = String(Math.max(1, maxQty)); qInput.value = String(qty);
            qInput.addEventListener('click', (e) => e.stopPropagation());
            qInput.addEventListener('change', () => setQty(parseInt(qInput.value, 10) || 1));
            qtyBox.append(
                mkBtn('−', 'Меньше', () => setQty(qty - 1)),
                qInput,
                mkBtn('+', 'Больше', () => setQty(qty + 1)),
                mkBtn('Макс', 'Сколько хватает материалов', () => setQty(maxQty))
            );

            btnRow.append(qtyBox, craftBtn);
            card.append(topRow, ingContainer, btnRow);
            return card;
        }

        /** Recipe with a `station` (e.g. planks -> sawmill): { name, near } or null when no station is needed. */
        stationInfo(rec) {
            if (!rec || !rec.station) return null;
            const types = window.AveloraBuildingTypes || {};
            const def = types[rec.station];
            const b = this.game && this.game.building;
            return { name: def ? def.name : rec.station, near: !!(b && b.stationNear && b.stationNear(rec.station)) };
        }

        /** How many times a recipe can be crafted right now (materials and bag space). */
        maxCraftable(rec) {
            const inv = this.state ? this.state.inventory : null;
            if (!inv) return 0;
            let n = Infinity;
            (rec.ingredients || []).forEach(ing => { n = Math.min(n, Math.floor(inv.count(ing.item) / Math.max(1, ing.count))); });
            const resCount = rec.result.count || 1;
            n = Math.min(n, Math.floor(inv.spaceFor(rec.result.item) / resCount));
            return Number.isFinite(n) ? Math.max(0, n) : 0;
        }

        craftRecipe(recipeId, times) {
            const recipes = (window.GAME_CONTENT && window.GAME_CONTENT.recipes) || {};
            const rec = recipes[recipeId];
            const st = this.state;
            if (!rec || !st || !st.inventory) return;

            const stn = this.stationInfo(rec);
            if (stn && !stn.near) {
                this.floatText(`Нужна: ${stn.name} рядом`, 'warn');
                this.renderCrafting();
                return;
            }
            const ingredients = rec.ingredients || [];
            const n = Math.max(1, Math.floor(times || 1));
            for (const ing of ingredients) {
                if (st.inventory.count(ing.item) < ing.count * n) {
                    this.floatText('Недостаточно материалов', 'warn');
                    return;
                }
            }

            const resItem = rec.result.item;
            const resCount = (rec.result.count || 1) * n;
            if (st.inventory.spaceFor(resItem) < resCount) {
                this.floatText('В сумке нет места', 'warn');
                return;
            }

            for (const ing of ingredients) {
                st.inventory.remove(ing.item, ing.count * n);
            }

            st.inventory.add(resItem, resCount);
            st.save();

            if (resItem === 'potion_health_small' || recipeId === 'potion_health_small') {
                if (st.setQuestFlag) {
                    st.setQuestFlag('potion_health_small_crafted', true);
                }
                if (this.game && this.game.dialog && this.game.dialog.updateTracker) {
                    this.game.dialog.updateTracker();
                }
                if (this.updateQuestsProgress) this.updateQuestsProgress();
            }

            const resDef = window.AveloraItems.get(resItem);
            const resName = resDef ? resDef.name : resItem;
            this.floatText(resCount > 1 ? `Создано: ${resName} ×${resCount}` : `Создано: ${resName}`, 'loot');
            this.pulseInventory();

            this.renderInventory();
            this.renderCrafting();
        }

        // -----------------------------------------------------------
        // Panels
        // -----------------------------------------------------------
        setPanelAria(panel, open) {
            if (!panel) return;
            if (!open && document.activeElement && panel.contains(document.activeElement)) {
                try { document.activeElement.blur(); } catch (_) {}
            }
            panel.classList.toggle('open', !!open);
            panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        }

        isSkillsOpen() { return this.skillsOpen; }

        toggleSkills() { this.setSkillsOpen(!this.skillsOpen); }

        setSkillsOpen(open) {
            this.skillsOpen = open;
            this.setPanelAria(this.skillsPanel, open);
            if (this.skillsBtn) this.skillsBtn.classList.toggle('active', open);
            if (open) {
                if (!this.skillsOpenGroup) this.skillsOpenGroup = 'attack';
                this.renderSkills();
            }
            this.layoutPanels();
            if (!open) this.hideTooltip();
        }

        /** Desktop: skills panel sits left of the inventory when both are open (unless user dragged it manually). */
        layoutPanels() {
            const hasInv = !!this.game.isInventoryOpen;
            if (this.skillsPanel && !this.skillsPanel.dataset.dragged) {
                this.skillsPanel.classList.toggle('beside-inventory', hasInv);
            }
            if (this.craftingPanel && !this.craftingPanel.dataset.dragged) {
                this.craftingPanel.classList.toggle('beside-inventory', hasInv);
            }
        }

        setupDraggablePanels() {
            this.makePanelDraggable(this.invPanel, '.inventory-header');
            this.makePanelDraggable(this.skillsPanel, '.inventory-header');
            this.makePanelDraggable(this.craftingPanel, '.inventory-header');
            this.makePanelDraggable(this.chestPanel, '.inventory-header');
            this.makePanelDraggable(this.heroPanel, '.panel-header');
            this.makePanelDraggable(this.questsPanel, '.panel-header');
            if (this.dialog && this.dialog.panel) {
                this.makePanelDraggable(this.dialog.panel, '.dlg-side, .dlg-text');
            }

            window.addEventListener('resize', () => {
                this.clampPanelInsideViewport(this.invPanel);
                this.clampPanelInsideViewport(this.skillsPanel);
                this.clampPanelInsideViewport(this.craftingPanel);
                this.clampPanelInsideViewport(this.chestPanel);
                this.clampPanelInsideViewport(this.heroPanel);
                this.clampPanelInsideViewport(this.questsPanel);
                if (this.dialog && this.dialog.panel) this.clampPanelInsideViewport(this.dialog.panel);
            });
        }

        /** Makes any modal/window panel freely draggable by its header on both mouse and touch. */
        makePanelDraggable(panel, handleSelector = '.inventory-header') {
            if (!panel) return;
            const handle = panel.querySelector(handleSelector);
            if (!handle) return;

            // Clicking anywhere on the window elevates it above other windows
            panel.addEventListener('pointerdown', () => {
                AveloraHotbarUI.topZ = Math.max(AveloraHotbarUI.topZ || 200, 200) + 1;
                panel.style.zIndex = String(AveloraHotbarUI.topZ);
            });

            let isDragging = false;
            let startPointerX = 0, startPointerY = 0;
            let startPanelX = 0, startPanelY = 0;
            let panelW = 0, panelH = 0;

            const onPointerDown = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                // Don't drag if clicking buttons, tabs, inputs, or interactive controls
                if (e.target.closest('button, input, select, textarea, .tab-btn, .inv-tab-btn, a, [role="button"], .interactive')) return;

                AveloraHotbarUI.topZ = Math.max(AveloraHotbarUI.topZ || 200, 200) + 1;
                panel.style.zIndex = String(AveloraHotbarUI.topZ);

                isDragging = true;
                panel.dataset.dragged = '1';
                startPointerX = e.clientX;
                startPointerY = e.clientY;

                const rect = panel.getBoundingClientRect();
                startPanelX = rect.left;
                startPanelY = rect.top;
                panelW = rect.width;
                panelH = rect.height;

                panel.style.left = `${startPanelX}px`;
                panel.style.top = `${startPanelY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.transform = 'none';

                panel.classList.add('panel-is-dragging');
                document.body.classList.add('ui-dragging');

                try {
                    handle.setPointerCapture(e.pointerId);
                } catch (_) {}

                e.preventDefault();
            };

            const onPointerMove = (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startPointerX;
                const dy = e.clientY - startPointerY;

                const margin = 8;
                const maxLeft = Math.max(margin, window.innerWidth - panelW - margin);
                const maxTop = Math.max(margin, window.innerHeight - panelH - margin);
                const newX = Math.max(margin, Math.min(maxLeft, startPanelX + dx));
                const newY = Math.max(margin, Math.min(maxTop, startPanelY + dy));

                panel.style.left = `${newX}px`;
                panel.style.top = `${newY}px`;
            };

            const onPointerUp = (e) => {
                if (!isDragging) return;
                isDragging = false;
                panel.classList.remove('panel-is-dragging');
                document.body.classList.remove('ui-dragging');
                try {
                    handle.releasePointerCapture(e.pointerId);
                } catch (_) {}
            };

            handle.addEventListener('pointerdown', onPointerDown);
            handle.addEventListener('pointermove', onPointerMove);
            handle.addEventListener('pointerup', onPointerUp);
            handle.addEventListener('pointercancel', onPointerUp);
        }

        clampPanelInsideViewport(panel) {
            if (!panel || !panel.style.left || panel.style.left === 'auto') return;
            const rect = panel.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const margin = 8;
            const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
            const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
            const curLeft = parseFloat(panel.style.left) || rect.left;
            const curTop = parseFloat(panel.style.top) || rect.top;
            const newLeft = Math.max(margin, Math.min(maxLeft, curLeft));
            const newTop = Math.max(margin, Math.min(maxTop, curTop));
            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
        }

        pulseInventory() {
            if (!this.invBtn) return;
            this.invBtn.classList.remove('pulse');
            void this.invBtn.offsetWidth; // restart the CSS animation
            this.invBtn.classList.add('pulse');
        }

        // -----------------------------------------------------------
        // Health Potion Slot & Auto-Use System
        // -----------------------------------------------------------
        loadAutoPotionSettings() {
            try {
                const raw = localStorage.getItem('avelora_auto_potion');
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        if (typeof parsed.enabled === 'boolean') this.autoPotion.enabled = parsed.enabled;
                        if (typeof parsed.threshold === 'number' && parsed.threshold >= 10 && parsed.threshold <= 90) {
                            this.autoPotion.threshold = parsed.threshold;
                        }
                        if (parsed.itemId === 'potion_health_small' || parsed.itemId === 'potion_health_large') {
                            this.autoPotion.itemId = parsed.itemId;
                        }
                    }
                }
            } catch (err) {
                console.warn('[Avelora] failed to load auto-potion settings', err);
            }
        }

        saveAutoPotionSettings() {
            try {
                localStorage.setItem('avelora_auto_potion', JSON.stringify(this.autoPotion));
            } catch (err) {
                console.warn('[Avelora] failed to save auto-potion settings', err);
            }
        }

        setupPotionSlot() {
            if (this.potionBtn) {
                const frame = document.createElement('span');
                frame.className = 'slot-heal-frame';
                const frameTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.btnHealFrame;
                if (frameTex) frame.style.backgroundImage = `url("${frameTex}")`;
                this.potionBtn.appendChild(frame);
                this.potionBtn._frame = frame;

                this.potionBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.inputAllowed()) {
                        this.togglePotionModal();
                    }
                });
            }
        }

        setupPotionModal() {
            if (this.potionModalClose) {
                this.potionModalClose.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closePotionModal();
                });
            }
            if (this.potionCloseBtn) {
                this.potionCloseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closePotionModal();
                });
            }
            if (this.potionDrinkBtn) {
                this.potionDrinkBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.drinkSelectedPotion();
                    this.updatePotionModal();
                });
            }
            if (this.potionAutoToggle) {
                this.potionAutoToggle.addEventListener('change', (e) => {
                    this.autoPotion.enabled = !!e.target.checked;
                    this.saveAutoPotionSettings();
                    this.updatePotionSlot();
                });
            }
            if (this.potionThresholdSlider) {
                this.potionThresholdSlider.addEventListener('input', (e) => {
                    this.autoPotion.threshold = parseInt(e.target.value, 10);
                    if (this.potionThresholdVal) this.potionThresholdVal.textContent = `${this.autoPotion.threshold}%`;
                    this.saveAutoPotionSettings();
                });
            }
            if (this.potionPresets && this.potionPresets.length) {
                this.potionPresets.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const pct = parseInt(btn.dataset.pct, 10);
                        this.autoPotion.threshold = pct;
                        if (this.potionThresholdSlider) this.potionThresholdSlider.value = String(pct);
                        if (this.potionThresholdVal) this.potionThresholdVal.textContent = `${pct}%`;
                        this.saveAutoPotionSettings();
                    });
                });
            }
            if (this.potionModal) {
                this.potionModal.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
            }
            document.addEventListener('click', (e) => {
                if (this.potionOpen && !e.target.closest('#potion-modal') && !e.target.closest('#potion-btn')) {
                    this.closePotionModal();
                }
            });
        }

        isPotionOpen() {
            return this.potionOpen;
        }

        togglePotionModal() {
            if (this.potionOpen) this.closePotionModal();
            else this.openPotionModal();
        }

        openPotionModal() {
            this.potionOpen = true;
            this.setPanelAria(this.potionModal, true);
            if (this.microMenuOpen) this.closeMicroMenu();
            this.updatePotionModal();
        }

        closePotionModal() {
            this.potionOpen = false;
            this.setPanelAria(this.potionModal, false);
        }

        updatePotionSlot() {
            if (!this.potionBtn) return;
            const st = this.state;
            const itemId = this.autoPotion.itemId || 'potion_health_small';
            let count = st ? st.inventory.count(itemId) : 0;

            // If selected potion count is 0, check if character has the other health potion
            if (count === 0 && st) {
                const altId = itemId === 'potion_health_small' ? 'potion_health_large' : 'potion_health_small';
                const altCount = st.inventory.count(altId);
                if (altCount > 0) {
                    this.autoPotion.itemId = altId;
                    this.saveAutoPotionSettings();
                    count = altCount;
                }
            }

            const activeId = this.autoPotion.itemId;
            const def = window.AveloraItems ? window.AveloraItems.get(activeId) : null;
            const iconSpan = this.potionBtn.querySelector('.potion-slot-icon');
            const countSpan = this.potionBtn.querySelector('.potion-slot-count');
            const badgeSpan = this.potionBtn.querySelector('.potion-auto-badge');

            if (count > 0 && def) {
                this.potionBtn.classList.remove('empty-potion');
                if (iconSpan) {
                    iconSpan.innerHTML = '';
                    iconSpan.appendChild(makeIcon(def));
                }
                if (countSpan) countSpan.textContent = count > 1 ? count : '';
                this.potionBtn.title = `${def.name} (${count} шт.) — нажмите для настройки`;
            } else {
                this.potionBtn.classList.add('empty-potion');
                if (iconSpan) iconSpan.innerHTML = '';
                if (countSpan) countSpan.textContent = '';
                this.potionBtn.title = 'Зелье здоровья (пусто) — нажмите для настройки';
            }

            if (badgeSpan) {
                badgeSpan.classList.toggle('hidden', !this.autoPotion.enabled);
            }
        }

        updatePotionModal() {
            const st = this.state;
            const cb = this.game.combat;

            if (this.potionAutoToggle) {
                this.potionAutoToggle.checked = !!this.autoPotion.enabled;
            }
            if (this.potionThresholdSlider) {
                this.potionThresholdSlider.value = String(this.autoPotion.threshold);
            }
            if (this.potionThresholdVal) {
                this.potionThresholdVal.textContent = `${this.autoPotion.threshold}%`;
            }

            if (this.potionChoiceGrid) {
                this.potionChoiceGrid.innerHTML = '';
                const potionIds = ['potion_health_small', 'potion_health_large'];
                potionIds.forEach(id => {
                    const def = window.AveloraItems ? window.AveloraItems.get(id) : null;
                    if (!def) return;
                    const count = st ? st.inventory.count(id) : 0;
                    const isSelected = id === this.autoPotion.itemId;
                    const healAmount = (def.use && def.use.amount) || 50;

                    const card = document.createElement('div');
                    card.className = `potion-choice-card ${isSelected ? 'selected' : ''}`;
                    card.dataset.id = id;

                    const iconDiv = document.createElement('div');
                    iconDiv.className = 'potion-choice-icon';
                    iconDiv.appendChild(makeIcon(def));

                    const infoDiv = document.createElement('div');
                    infoDiv.className = 'potion-choice-info';
                    infoDiv.innerHTML = `
                        <div class="potion-choice-name">${def.name}</div>
                        <div class="potion-choice-desc">+${healAmount} HP • ${count > 0 ? `В наличии: ${count} шт.` : '<span style="color:#b38a7a">Нет в сумке</span>'}</div>
                    `;

                    const countDiv = document.createElement('div');
                    countDiv.className = 'potion-choice-count';
                    countDiv.textContent = count > 0 ? `×${count}` : '0';

                    card.append(iconDiv, infoDiv, countDiv);

                    card.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.autoPotion.itemId = id;
                        this.saveAutoPotionSettings();
                        this.updatePotionSlot();
                        this.updatePotionModal();
                    });

                    this.potionChoiceGrid.appendChild(card);
                });
            }

            // Drink button state
            if (this.potionDrinkBtn) {
                const count = st ? st.inventory.count(this.autoPotion.itemId) : 0;
                const isDead = cb && cb.isDead;
                const isFull = cb && cb.hp >= cb.maxHp;
                const canDrink = count > 0 && !isDead && !isFull;
                this.potionDrinkBtn.disabled = !canDrink;
                this.potionDrinkBtn.style.opacity = canDrink ? '1' : '0.5';
                this.potionDrinkBtn.style.cursor = canDrink ? 'pointer' : 'not-allowed';
            }
        }

        drinkSelectedPotion() {
            if (!this.inputAllowed()) return false;
            const st = this.state;
            const itemId = this.autoPotion.itemId || 'potion_health_small';
            let count = st ? st.inventory.count(itemId) : 0;
            let targetId = itemId;

            if (count <= 0 && st) {
                const altId = itemId === 'potion_health_small' ? 'potion_health_large' : 'potion_health_small';
                if (st.inventory.count(altId) > 0) {
                    targetId = altId;
                    this.autoPotion.itemId = altId;
                    this.saveAutoPotionSettings();
                }
            }

            const success = this.consumeHeal(targetId);
            this.updatePotionSlot();
            if (this.potionBtn) {
                this.flashSlot(this.potionBtn, success ? 'pressed' : 'shake');
            }
            return success;
        }

        updateAutoPotion(delta) {
            if (this._autoPotionCooldown > 0) this._autoPotionCooldown -= delta;
            if (!this.autoPotion.enabled || !this.inputAllowed()) return;
            if (this._autoPotionCooldown > 0) return;

            const cb = this.game.combat;
            if (!cb || cb.isDead || cb.maxHp <= 0) return;

            const curHp = typeof cb.hp === 'number' ? cb.hp : (typeof cb.currentHp === 'number' ? cb.currentHp : cb.maxHp);
            const hpPct = (curHp / cb.maxHp) * 100;
            if (hpPct <= this.autoPotion.threshold) {
                const st = this.state;
                if (!st) return;

                let itemId = this.autoPotion.itemId || 'potion_health_small';
                if (st.inventory.count(itemId) <= 0) {
                    const altId = itemId === 'potion_health_small' ? 'potion_health_large' : 'potion_health_small';
                    if (st.inventory.count(altId) > 0) {
                        itemId = altId;
                        this.autoPotion.itemId = altId;
                        this.saveAutoPotionSettings();
                    }
                }

                if (st.inventory.count(itemId) > 0) {
                    const drank = this.consumeHeal(itemId);
                    if (drank) {
                        this._autoPotionCooldown = 2.0; // 2 seconds cooldown between auto heals
                        this.updatePotionSlot();
                        if (this.potionBtn) this.flashSlot(this.potionBtn, 'pressed');
                    }
                }
            }
        }

        // -----------------------------------------------------------
        // Micro-Menu (Slide-up Dock Bar)
        // -----------------------------------------------------------
        setupMicroMenu() {
            // events hooked in setupEvents
        }

        isMicroMenuOpen() {
            return this.microMenuOpen;
        }

        toggleMicroMenu() {
            if (this.microMenuOpen) this.closeMicroMenu();
            else this.openMicroMenu();
        }

        openMicroMenu() {
            this.microMenuOpen = true;
            if (this.microToggleBtn) this.microToggleBtn.classList.add('open');
            if (this.microDock) {
                this.microDock.classList.remove('hidden');
                void this.microDock.offsetWidth;
                this.microDock.classList.add('open');
            }
        }

        closeMicroMenu() {
            this.microMenuOpen = false;
            if (this.microToggleBtn) this.microToggleBtn.classList.remove('open');
            if (this.microDock) {
                this.microDock.classList.remove('open');
                setTimeout(() => {
                    if (!this.microMenuOpen && this.microDock) this.microDock.classList.add('hidden');
                }, 180);
            }
        }

        // -----------------------------------------------------------
        // Hero Modal (C key)
        // -----------------------------------------------------------
        setupHeroModal() {
            if (this.heroCloseBtn) {
                this.heroCloseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setHeroOpen(false);
                });
            }
            if (this.heroPanel) {
                this.heroPanel.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
            }
            const portraitBtn = document.getElementById('player-portrait-btn');
            if (portraitBtn) {
                portraitBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleHero();
                });
                portraitBtn.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                });
                portraitBtn.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                }, { passive: true });
                portraitBtn.addEventListener('touchend', (e) => {
                    e.stopPropagation();
                }, { passive: true });
            }
            this.updatePlayerPortrait();
        }

        updatePlayerPortrait() {
            const portraitImg = document.getElementById('player-portrait-img');
            if (!portraitImg) return;
            const cfg = (this.game && this.game.currentCharacterConfig) ||
                        (window.AveloraSave && window.AveloraSave.getLastActiveCharacterConfig && window.AveloraSave.getLastActiveCharacterConfig()) || null;
            const textures = (window.GAME_ASSETS && window.GAME_ASSETS.textures) || {};
            const key = (cfg && (cfg.portrait || `heroPortrait_${cfg.id}`)) || 'heroPortrait';
            const tex = textures[key] || (cfg && textures[`heroPortrait_${cfg.id}`]) || textures.heroPortrait || '';
            if (tex) {
                portraitImg.style.backgroundImage = `url("${tex}")`;
            }
        }

        isHeroOpen() {
            return this.heroOpen;
        }

        toggleHero() {
            this.setHeroOpen(!this.heroOpen);
        }

        setHeroOpen(open) {
            this.heroOpen = open;
            this.setPanelAria(this.heroPanel, open);
            if (open) {
                this.updateHeroStats();
                if (this.questsOpen) this.setQuestsOpen(false);
            }
        }

        /** Redraws the hero panel if it is open (called on every state change / level-up). */
        refreshHero() { if (this.heroOpen) this.updateHeroStats(); }

        updateHeroStats() {
            const g = this.game;
            const st = this.state;
            const hero = g.hero;
            const cfg = g.currentCharacterConfig || {};
            const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

            setText('hero-name', cfg.name || 'Герой');
            setText('hero-class', cfg.className || '');
            setText('hero-avatar', cfg.icon || '🧙');
            setText('hero-level', 'Ур. ' + (hero ? hero.level : 1));

            // Experience
            const xpFill = document.getElementById('hero-xp-fill');
            if (hero) {
                const p = hero.progress();
                setText('hero-xp-val', p.max ? 'максимум' : `${p.have} / ${p.need}`);
                if (xpFill) xpFill.style.width = (p.frac * 100).toFixed(1) + '%';
            }

            // HP
            const cb = g.combat;
            const maxHp = cb ? Math.round(cb.maxHp || 100) : 100;
            const curHp = cb ? Math.max(0, Math.round(cb.hp)) : maxHp;
            setText('hero-hp-val', `${curHp} / ${maxHp}`);
            const hpFill = document.getElementById('hero-hp-fill');
            if (hpFill) hpFill.style.width = `${Math.max(0, Math.min(100, (curHp / maxHp) * 100))}%`;

            // Mana
            if (hero) {
                setText('hero-mana-val', `${Math.floor(hero.mana)} / ${hero.maxMana}`);
                const mf = document.getElementById('hero-mana-fill');
                if (mf) mf.style.width = (hero.maxMana > 0 ? Math.max(0, Math.min(1, hero.mana / hero.maxMana)) * 100 : 0).toFixed(1) + '%';
            }

            // Attributes: total, with the gear bonus in green
            const attrs = document.getElementById('hero-attrs');
            if (attrs && hero && window.AVELORA_PROGRESSION) {
                const names = window.AVELORA_PROGRESSION.statNames, tot = hero.stats(), gear = hero.gearStats();
                const fmt = (v) => Math.floor(v + 1e-9);
                attrs.innerHTML = ['str', 'dex', 'int'].map(k =>
                    `<div class="hero-attr-row"><span>${names[k]}</span><span><b>${fmt(tot[k])}</b>${gear[k] ? `<i>(+${fmt(gear[k])})</i>` : ''}</span></div>`).join('');
            }

            // Weapon, damage, spell power, mana regen
            const eqId = st && st.equipped && st.equipped.right;
            const eqDef = eqId ? window.AveloraItems.get(eqId) : null;
            const w = window.AveloraItems.weaponOf(eqId);
            const mult = hero ? hero.meleeMult(w) : 1;
            setText('hero-stat-weapon', eqDef ? eqDef.name : 'Кулаки');
            setText('hero-stat-dps', `${Math.max(1, Math.round(w.damage[0] * mult))}–${Math.max(1, Math.round(w.damage[1] * mult))}`);
            if (hero) {
                const sm = hero.skillMult({ damage: { type: 'lightning' } }), pm = hero.skillMult({ damage: { type: 'physical' } });
                setText('hero-stat-spell', `маг. +${Math.round((sm - 1) * 100)}% · физ. +${Math.round((pm - 1) * 100)}%`);
                setText('hero-stat-regen', `${hero.manaRegen.toFixed(1)} / с`);
                setText('hero-stat-armor', `${Math.round(hero.armor() * 10) / 10} (−${Math.round(hero.mitigation() * 100)}% урона)`);
                setText('hero-stat-dodge', `${Math.round(hero.dodge() * 100)}%`);
            }

            this.renderDoll();

            // Location
            const locObj = g.location;
            setText('hero-stat-loc', (locObj && locObj.name) || 'Долина');

            // Time played
            const sec = Math.floor(st && st.playTime ? st.playTime : 0);
            const hrs = Math.floor(sec / 3600);
            const mins = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const timeStr = hrs > 0
                ? `${hrs} ч ${mins} мин`
                : (mins > 0 ? `${mins} мин ${s} с` : `${s} с`);
            setText('hero-stat-time', timeStr);
            const timeEl = document.getElementById('hero-stat-time');
            if (timeEl) timeEl.title = `${hrs} ч ${mins} мин ${s} с (${sec} сек)`;
        }

        /** Equipment slots of the hero panel: only the weapon slot is live for now; the rest wait for gear. */
        renderDoll() {
            const grid = document.getElementById('doll-grid');
            if (!grid) return;
            const st = this.state;
            const SLOT_NAMES = { head: 'Голова', cloak: 'Плащ', body: 'Тело', hands: 'Перчатки', ring: 'Кольцо', ring2: 'Кольцо', weapon: 'Оружие', feet: 'Сапоги' };
            grid.querySelectorAll('.doll-slot').forEach(el => {
                const slot = el.dataset.slot;
                const key = slot === 'weapon' ? 'right' : slot;
                const itemId = st && st.equipped ? st.equipped[key] : null;
                const def = itemId ? window.AveloraItems.get(itemId) : null;
                const shownKey = def ? itemId : '';
                if (el._shown === shownKey) return;
                el._shown = shownKey;
                el.querySelectorAll('.ui-icon').forEach(n => n.remove());
                el.classList.toggle('filled', !!def);
                if (def) {
                    el.insertBefore(makeIcon(def), el.firstChild);
                    el.removeAttribute('title');
                    el.onclick = (e) => { e.stopPropagation(); this.hideTooltip(); this.unequip(key); };
                } else {
                    el.title = `${SLOT_NAMES[slot] || slot}: пусто`;
                    el.onclick = null;
                }
            });
        }

        // -----------------------------------------------------------
        // Quests Journal Modal (L key)
        // -----------------------------------------------------------
        setupQuestsModal() {
            if (this.questsCloseBtn) {
                this.questsCloseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setQuestsOpen(false);
                });
            }
            if (this.questsPanel) {
                this.questsPanel.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
                const tabBtns = this.questsPanel.querySelectorAll('.quest-tab-btn');
                tabBtns.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.hideTooltip();
                        const tab = btn.dataset.tab;
                        if (tab && this.questTab !== tab) {
                            this.questTab = tab;
                            this.updateQuestsProgress();
                        }
                    });
                });
            }
        }

        isQuestsOpen() {
            return this.questsOpen;
        }

        toggleQuests() {
            this.setQuestsOpen(!this.questsOpen);
        }

        setQuestsOpen(open) {
            this.questsOpen = open;
            this.setPanelAria(this.questsPanel, open);
            if (open) {
                this.updateQuestsProgress();
                if (this.heroOpen) this.setHeroOpen(false);
            } else {
                this.hideTooltip();
            }
        }

        showQuestRewardTooltip(el, q) {
            if (!this.tooltip || !q) return;
            this.tooltip.innerHTML = '';
            this.tooltip.classList.remove('warn', 'interactive');

            const header = document.createElement('div');
            header.className = 'tt-name';
            header.textContent = q.title;
            this.tooltip.appendChild(header);

            const badge = document.createElement('div');
            badge.className = 'tt-meta';
            if (q.completed) {
                badge.style.color = '#81c784';
                badge.textContent = '✓ Завершено · Награда получена';
            } else {
                badge.textContent = q.badge;
            }
            this.tooltip.appendChild(badge);

            const rw = q.reward;
            if (rw && (rw.gold || rw.xp || (rw.items && rw.items.length))) {
                const rwTitle = document.createElement('div');
                rwTitle.style.fontSize = '0.74rem';
                rwTitle.style.color = '#efcf7a';
                rwTitle.style.fontWeight = '600';
                rwTitle.style.textTransform = 'uppercase';
                rwTitle.style.letterSpacing = '0.04em';
                rwTitle.style.marginTop = '6px';
                rwTitle.textContent = 'Награда за задание:';
                this.tooltip.appendChild(rwTitle);

                const rwBox = document.createElement('div');
                rwBox.style.display = 'flex';
                rwBox.style.flexDirection = 'column';
                rwBox.style.gap = '3px';
                rwBox.style.marginTop = '3px';

                if (rw.xp) {
                    const xpRow = document.createElement('div');
                    xpRow.style.fontSize = '0.8rem';
                    xpRow.style.color = '#9cdcfe';
                    xpRow.textContent = `⭐ +${rw.xp} опыта`;
                    rwBox.appendChild(xpRow);
                }
                if (rw.gold) {
                    const gRow = document.createElement('div');
                    gRow.style.fontSize = '0.8rem';
                    gRow.style.color = '#efcf7a';
                    gRow.innerHTML = `<span class="coin"></span> +${rw.gold} монет`;
                    rwBox.appendChild(gRow);
                }
                if (rw.items && rw.items.length) {
                    rw.items.forEach(it => {
                        const def = window.AveloraItems && window.AveloraItems.get(it.item);
                        const iRow = document.createElement('div');
                        iRow.style.fontSize = '0.8rem';
                        iRow.style.color = '#f1e2c8';
                        const countTxt = it.count > 1 ? ` ×${it.count}` : '';
                        const name = def ? def.name : it.item;
                        iRow.innerHTML = `🎁 <b>${name}</b>${countTxt}`;
                        rwBox.appendChild(iRow);

                        if (def && def.description) {
                            const descRow = document.createElement('div');
                            descRow.style.fontSize = '0.72rem';
                            descRow.style.color = '#a2aba9';
                            descRow.style.fontStyle = 'italic';
                            descRow.style.paddingLeft = '18px';
                            descRow.textContent = def.description;
                            rwBox.appendChild(descRow);
                        }
                        const rLines = this.itemStatsLines(def);
                        rLines.forEach(l => {
                            const statRow = document.createElement('div');
                            statRow.style.fontSize = '0.72rem';
                            statRow.style.color = '#a9d68c';
                            statRow.style.paddingLeft = '18px';
                            statRow.textContent = l;
                            rwBox.appendChild(statRow);
                        });
                    });
                }
                this.tooltip.appendChild(rwBox);
            } else {
                const noRw = document.createElement('div');
                noRw.className = 'tt-desc';
                noRw.style.marginTop = '4px';
                noRw.textContent = q.completed ? 'Награда за это задание уже получена.' : 'Особая награда не предусмотрена.';
                this.tooltip.appendChild(noRw);
            }

            this.placeTooltip(el);
        }

        updateQuestsProgress() {
            const listEl = document.getElementById('quests-list');
            if (!listEl) return;
            const st = this.state, dlg = this.dialog;
            const activeQuests = [];
            const completedQuests = [];

            if (st && dlg) {
                const ids = Object.keys(st.quests || {});
                ids.forEach(id => {
                    const q = dlg.questDef(id);
                    if (!q) return;
                    const done = st.quests[id] === 'done';
                    const p = dlg.questProgress(q);
                    const rw = dlg.getQuestRewards ? dlg.getQuestRewards(q) : { gold: 0, xp: 0, items: [] };
                    const qItem = {
                        id,
                        title: q.name,
                        desc: q.summary || '',
                        completed: done,
                        badge: done ? 'Завершено' : (p.ready ? 'К сдаче' : (dlg.questBadge ? dlg.questBadge(q, p) : dlg.questLabel(q, p))),
                        reward: rw
                    };
                    if (done) {
                        completedQuests.push(qItem);
                    } else {
                        activeQuests.push(qItem);
                    }
                });
            }

            // Update tab badges & active states
            const countActiveEl = document.getElementById('quest-tab-count-active');
            const countCompletedEl = document.getElementById('quest-tab-count-completed');
            if (countActiveEl) countActiveEl.textContent = activeQuests.length;
            if (countCompletedEl) countCompletedEl.textContent = completedQuests.length;

            if (this.questsPanel) {
                const tabBtns = this.questsPanel.querySelectorAll('.quest-tab-btn');
                tabBtns.forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tab === this.questTab);
                });
            }

            const currentList = this.questTab === 'completed' ? completedQuests : activeQuests;

            listEl.innerHTML = '';
            if (!currentList.length) {
                const empty = document.createElement('div');
                empty.className = 'quest-list-empty';
                if (this.questTab === 'completed') {
                    empty.innerHTML = `
                        <div class="quest-empty-title">Завершённых заданий пока нет</div>
                        <div class="quest-empty-desc">Выполненные поручения будут сохранены здесь в летописи.</div>
                    `;
                } else {
                    empty.innerHTML = `
                        <div class="quest-empty-title">Нет активных заданий</div>
                        <div class="quest-empty-desc">Поговорите с Лираэль у водопада или жителями — у них найдётся работа.</div>
                    `;
                }
                listEl.appendChild(empty);
                return;
            }

            currentList.forEach(q => {
                const card = document.createElement('div');
                card.className = `quest-card ${q.completed ? 'completed' : ''}`;
                let rwHtml = '';
                if (q.reward && (q.reward.gold || q.reward.xp || (q.reward.items && q.reward.items.length))) {
                    const parts = [];
                    if (q.reward.gold) parts.push(`<span class="coin"></span> +${q.reward.gold}`);
                    if (q.reward.xp) parts.push(`⭐ +${q.reward.xp} опыта`);
                    if (q.reward.items && q.reward.items.length) {
                        const itemNames = q.reward.items.map(it => {
                            const def = window.AveloraItems && window.AveloraItems.get(it.item);
                            return (def ? def.name : it.item) + (it.count > 1 ? ` x${it.count}` : '');
                        }).join(', ');
                        parts.push(`🎁 ${itemNames}`);
                    }
                    rwHtml = `<div class="quest-card-reward"><span class="quest-reward-label">Награда:</span> ${parts.join(' • ')}</div>`;
                }
                card.innerHTML = `
                    <div class="quest-card-header">
                        <div class="quest-card-title">${q.title}</div>
                        <div class="quest-card-actions">
                            <span class="quest-status-badge">${q.badge}</span>
                            ${(!q.completed && q.id) ? `<button type="button" class="quest-abandon-btn" data-quest="${q.id}" title="Отказаться от задания">Отменить</button>` : ''}
                        </div>
                    </div>
                    <div class="quest-card-desc">${q.desc}</div>
                    ${rwHtml}
                `;

                const abandonBtn = card.querySelector('.quest-abandon-btn');
                if (abandonBtn) {
                    abandonBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.hideTooltip();
                        if (dlg && dlg.abandonQuest) dlg.abandonQuest(q.id);
                    });
                }
                listEl.appendChild(card);
            });
        }

        // -----------------------------------------------------------
        // Activation
        // -----------------------------------------------------------
        inputAllowed() {
            const g = this.game;
            if (!g.isReady || g.isPaused || g.isTransitioning || !this.state) return false;
            if (g.combat && g.combat.isDead) return false; // "Вы погибли": no actions until respawn
            const cs = document.getElementById('character-select-overlay');
            if (cs && !cs.classList.contains('hidden')) return false;
            return true;
        }

        activateSlot(i) {
            if (!this.inputAllowed()) return;
            const e = this.state.hotbar[i];
            const slot = this.slots[i];
            if (!e) {
                const isTouchUi = document.body && document.body.classList.contains('touch-ui');
                if (i === 0 && isTouchUi && this.game.combat) {
                    this.game.combat.performBasicAttack();
                    this.flashSlot(slot, 'pressed');
                }
                return;
            }
            if (e.type === 'skill') {
                const res = this.game.skills.activate(e.id);
                if (res === 'ok') this.flashSlot(slot, 'pressed');
                else this.flashSlot(slot, 'shake');
                return;
            }
            const def = window.AveloraItems.get(e.id);
            if (!def || this.state.ownedCount(e.id) <= 0) { this.flashSlot(slot, 'shake'); return; }
            if (def.use && def.use.type === 'equip') {
                this.toggleEquip(e.id);
                this.flashSlot(slot, 'pressed');
            } else if (def.use && def.use.type === 'heal') {
                if (this.consumeHeal(e.id)) {
                    this.flashSlot(slot, 'pressed');
                } else {
                    this.flashSlot(slot, 'shake');
                }
            } else {
                this.flashSlot(slot, 'shake'); // other use types: not implemented yet
            }
        }

        flashSlot(slot, cls) {
            if (!slot) return;
            slot.classList.remove('pressed', 'shake', 'reject');
            void slot.offsetWidth;
            slot.classList.add(cls);
        }

        consumeHeal(itemId) {
            const st = this.state;
            const def = window.AveloraItems.get(itemId);
            if (!st || !def || !this.game.combat) return false;
            if (st.inventory.count(itemId) <= 0) {
                this.floatText('Зелье закончилось', 'warn');
                return false;
            }
            const cb = this.game.combat;
            if (cb.isDead) return false;

            const trialQuestActive = st.questStatus('potion_trial') === 'active' && !st.getQuestFlag('potion_health_small_drank');
            if (cb.hp >= cb.maxHp && !trialQuestActive) {
                this.floatText('Здоровье уже полно', 'warn');
                return false;
            }
            const amount = (def.use && def.use.amount) || 50;
            const healed = Math.min(amount, Math.max(0, cb.maxHp - cb.hp));
            if (healed > 0) cb.heal(amount);
            st.inventory.remove(itemId, 1);
            if (healed > 0) {
                this.floatText(`+${healed} Здоровье`, 'heal');
                const c = this.game.character;
                if (c) {
                    this.floatAt(`+${healed}`, 'heal', c.position.x, c.position.y + 1.8, c.position.z);
                }
            } else {
                this.floatText('Зелье выпито', 'heal');
            }

            if (itemId === 'potion_health_small' || itemId === 'potion_health_large') {
                if (st.setQuestFlag) {
                    st.setQuestFlag('potion_health_small_drank', true);
                }
                if (this.game && this.game.dialog && this.game.dialog.updateTracker) {
                    this.game.dialog.updateTracker();
                }
                if (this.updateQuestsProgress) this.updateQuestsProgress();
            }

            this.renderInventory();
            this.renderHotbar();
            return true;
        }

        // -----------------------------------------------------------
        // Equipment (right hand)
        // -----------------------------------------------------------
        /**
         * Hotbar / hand toggle for an equippable item: in the hand -> back to the bag;
         * otherwise take it from the bag into the hand (the old hand item goes to the bag).
         */
        toggleEquip(itemId) {
            const st = this.state;
            if (!st || !window.AveloraItems.get(itemId)) return false;
            const slot = st.equippedSlotOf(itemId);
            if (slot) return this.unequip(slot);
            return this.equip(itemId);
        }

        /** Hero-panel slot id (data-slot) an item belongs to: 'weapon' for the hand, else head/cloak/body/hands/ring/feet. */
        dollSlotOf(itemId) {
            const s = window.AveloraItems.equipSlot(itemId);
            return s === 'right' ? 'weapon' : s;
        }

        /** Can item be equipped into this specific hero-panel doll slot? */
        canEquipInDollSlot(itemId, dollSlot) {
            const rawSlot = window.AveloraItems.equipSlot(itemId);
            if (rawSlot === 'right') return dollSlot === 'weapon';
            if (rawSlot === 'ring') return dollSlot === 'ring' || dollSlot === 'ring2';
            return rawSlot === dollSlot;
        }

        /** Array of lines for item stats: main first (damage / armor / tool action), then stat bonuses. */
        itemStatsLines(def) {
            if (!def) return [];
            const nm = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.statNames) || {};
            const lines = [];
            if (def.weapon && def.weapon.damage) {
                lines.push(`Урон ${def.weapon.damage[0]}–${def.weapon.damage[1]}`);
            } else if (def.armor) {
                lines.push(`Броня +${def.armor}`);
            }
            if (def.weapon && def.weapon.chop > 0) lines.push('Рубит деревья');
            if (def.weapon && def.weapon.mine > 0) lines.push('Добывает руду');
            if (def.stats) {
                ['str', 'dex', 'int'].forEach(k => {
                    if (def.stats[k]) lines.push(`${nm[k] || k} +${def.stats[k]}`);
                });
            }
            return lines;
        }

        /** "Броня +3 · Сила +1 · …" line of an item (armor / stats), or ''. */
        itemStatsLine(def) {
            return this.itemStatsLines(def).join(' · ');
        }

        /** "Урон 21–29 (огонь) · бонус +15%" line of a skill, taking hero stat bonuses into account. */
        skillStatsLine(def) {
            if (!def || !def.damage) return '';
            const dmg = def.damage;
            const hero = this.game && this.game.hero;
            const mult = hero && typeof hero.skillMult === 'function' ? hero.skillMult(def) : 1;
            const curMin = Math.max(1, Math.round((dmg.min || 0) * mult));
            const curMax = Math.max(1, Math.round((dmg.max || 0) * mult));

            const TYPE_NAMES = {
                fire: 'огонь',
                lightning: 'молния',
                ice: 'холод',
                physical: 'физ.'
            };
            const typeStr = TYPE_NAMES[dmg.type] ? ` (${TYPE_NAMES[dmg.type]})` : '';
            const bonusPct = Math.round((mult - 1) * 100);

            if (bonusPct > 0) {
                return `Урон ${curMin}–${curMax}${typeStr} · бонус +${bonusPct}%`;
            } else {
                return `Урон ${curMin}–${curMax}${typeStr}`;
            }
        }

        /** Damage multiplier the hero would get from this weapon (stat scaling differs for staff / bow / melee). */
        weaponMult(w) {
            const h = this.game.hero;
            if (!w || !h || !h.state) return 1;
            if (w.style === 'staff') return h.skillMult({ damage: { type: 'lightning' } });
            if (w.style === 'bow') return h.skillMult({ damage: { type: 'physical' } });
            return h.meleeMult(w);
        }

        /** Rows { cls: 'up'|'down'|'same', text } comparing `def` (candidate) with `cur` (worn in the same slot). */
        compareRows(def, cur) {
            const rows = [];
            const nm = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.statNames) || {};
            const fmt = v => String(Math.round(v * 10) / 10);
            const add = (label, a, b, higherBetter, unit) => {
                if (!a && !b) return;
                const d = a - b, same = Math.abs(d) < 1e-9;
                const cls = same ? 'same' : ((d > 0) === (higherBetter !== false) ? 'up' : 'down');
                const u = unit || '';
                rows.push({ cls, text: `${label}: ${fmt(b)}${u} → ${fmt(a)}${u}` + (same ? '' : ` (${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}${u})`) });
            };
            add('Броня', def.armor || 0, cur.armor || 0);
            ['str', 'dex', 'int'].forEach(k => add(nm[k] || k, (def.stats && def.stats[k]) || 0, (cur.stats && cur.stats[k]) || 0));
            if (def.weapon || cur.weapon) {
                const eff = w => (w && w.damage) ? (w.damage[0] + w.damage[1]) / 2 * this.weaponMult(w) : 0;
                add('Средний урон (с характеристиками)', eff(def.weapon), eff(cur.weapon));
                if (def.weapon && cur.weapon) {
                    add('Дальность', def.weapon.range || 0, cur.weapon.range || 0, true, ' м');
                    add('Перезарядка', def.weapon.cooldown || 0, cur.weapon.cooldown || 0, false, ' с');
                }
            }
            return rows;
        }

        /**
         * Tooltip of an item with a comparison against what is worn in the same slot
         * (quest reward / tool windows in dialog.js). Not interactive; hideTooltip() closes it.
         */
        showCompareTooltip(el, itemId) {
            if (!this.tooltip) return;
            const Items = window.AveloraItems, def = Items.get(itemId), st = this.state;
            if (!def) return;
            const t = this.tooltip;
            t.innerHTML = '';
            t.classList.remove('warn', 'interactive');
            const mk = (cls, txt, color) => { const d = document.createElement('div'); d.className = cls; d.textContent = txt; if (color) d.style.color = color; t.appendChild(d); return d; };
            const SLOT = { right: 'правая рука', head: 'голова', cloak: 'плащ', body: 'тело', hands: 'руки', ring: 'кольцо', feet: 'ноги' };
            const equippable = Items.isEquippable(itemId);
            mk('tt-name', def.name);
            mk('tt-desc', def.description || '');
            mk('tt-meta', equippable ? `снаряжение · ${SLOT[Items.equipSlot(itemId)] || ''}` : (def.use ? 'действие' : 'материал'));
            const slLines = this.itemStatsLines(def);
            slLines.forEach(l => mk('tt-req', l, '#a9d68c'));
            if (def.requires) {
                const rq = def.requires, nm = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.statNames) || {};
                const parts = [];
                if (rq.level) parts.push(`${rq.level}-й уровень`);
                ['str', 'dex', 'int'].forEach(k => { if (rq[k]) parts.push(`${nm[k] || k} ${rq[k]}`); });
                mk('tt-req' + (this.unmetRequirement(def) ? ' bad' : ''), 'Требуется: ' + parts.join(', '));
            }
            if (equippable && st) {
                const slot = Items.equipSlot(itemId);
                if (slot === 'ring') {
                    const r1 = st.equipped.ring, r2 = st.equipped.ring2;
                    if (r1 === itemId || r2 === itemId) {
                        mk('tt-cmp-head', 'Сейчас надето');
                    } else if (!r1 || !r2) {
                        mk('tt-cmp-head', 'Есть свободный слот под кольцо');
                    } else {
                        const cur = Items.get(r1);
                        mk('tt-cmp-head', `Заменит: ${cur ? cur.name : r1}`);
                        if (cur) this.compareRows(def, cur).forEach(r => mk('tt-cmp ' + r.cls, r.text));
                    }
                } else {
                    const curId = st.equipped[slot];
                    if (curId === itemId) mk('tt-cmp-head', 'Сейчас надето');
                    else if (!curId) mk('tt-cmp-head', 'Слот свободен — это будет первая вещь');
                    else {
                        const cur = Items.get(curId);
                        mk('tt-cmp-head', `Сейчас надето: ${cur ? cur.name : curId}`);
                        if (cur) this.compareRows(def, cur).forEach(r => mk('tt-cmp ' + r.cls, r.text));
                    }
                }
            }
            this.placeTooltip(el);
        }

        /** Bag -> right hand or specific equipment slot. Returns true on success. */
        equip(itemId, targetSlot) {
            const st = this.state, def = window.AveloraItems.get(itemId);
            if (!st || !def) return false;
            const lack = this.unmetRequirement(def);
            if (lack) { this.floatText(lack, 'warn'); return false; }
            const res = st.equipFromBag(itemId, targetSlot);
            if (res === 'full') { this.floatText('Сумка полна: некуда убрать то, что в руке', 'warn'); return false; }
            if (res !== 'ok') { this.floatText('Этого нет в сумке', 'warn'); return false; }
            this.applyEquipment();
            this.floatText(window.AveloraItems.equipSlot(itemId) === 'right' ? `${def.name} в руке` : `${def.name}: надето`, 'info');
            this.renderAll && this.renderAll();
            return true;
        }

        /** Right hand -> bag. */
        unequip(slot) {
            slot = slot || 'right';
            const st = this.state;
            if (!st || !st.equipped[slot]) return false;
            const def = window.AveloraItems.get(st.equipped[slot]);
            const res = st.unequipToBag(slot);
            if (res === 'full') { this.floatText('Сумка полна: нельзя снять', 'warn'); return false; }
            if (res !== 'ok') return false;
            this.applyEquipment();
            this.floatText(`${def ? def.name : 'Предмет'}: убран в сумку`, 'info');
            this.renderAll && this.renderAll();
            return true;
        }

        /** item.json `requires: { level, str, dex, int }` -> message of the first unmet condition, or null. */
        unmetRequirement(def) {
            const rq = def && def.requires, h = this.game.hero;
            if (!rq || !h) return null;
            if (rq.level && h.level < rq.level) return `Нужен ${rq.level}-й уровень`;
            const names = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.statNames) || {};
            const st = h.stats();
            for (const k of ['str', 'dex', 'int']) {
                if (rq[k] && st[k] < rq[k]) return `Нужно: ${names[k] || k} ${rq[k]}`;
            }
            return null;
        }

        /** Makes the character's hand match state.equipped (on load, character switch, toggle). */
        applyEquipment() {
            const c = this.game.character;
            if (!c || !this.state) return;
            if (this.game.hero && this.game.hero.state) { this.game.hero.refresh(false); this.game.hero.renderBars(true); }   // worn gear changes stats / max HP
            const itemId = this.state.equipped.right;
            const token = (this._equipToken = (this._equipToken || 0) + 1);
            if (!itemId) { c.setHandItem(null); return; }
            const def = window.AveloraItems.get(itemId);
            window.AveloraItems.parseModel(def && def.modelKey, (scene) => {
                // A newer equip request or another character won the race: discard this one
                if (token !== this._equipToken || c !== this.game.character) {
                    if (scene && window.MedievalCharacter) window.MedievalCharacter.disposeObject(scene);
                    return;
                }
                const variants = window.AveloraItems.splitVariants(scene);
                let obj = variants[0] || window.AveloraItems.makeFallback('held', itemId);
                window.AveloraItems.setShadows(obj, true, false);
                // Optional per-item pose on top of the character's grip (item.json `hold`):
                // the grip frame suits a carried tool (shaft forward-down, like the axe);
                // a staff is rotated upright with `hold.rotation`.
                let hold = def && def.hold;
                const cid = this.game.currentCharacterConfig && this.game.currentCharacterConfig.id;
                if (hold && cid && hold[cid]) hold = hold[cid];   // per-character pose (different hand grips)
                if (hold && (hold.rotation || hold.position)) {
                    const g = new THREE.Group();
                    g.add(obj);
                    const r = hold.rotation || [0, 0, 0], pp = hold.position || [0, 0, 0];
                    g.rotation.set(r[0] || 0, r[1] || 0, r[2] || 0);
                    g.position.set(pp[0] || 0, pp[1] || 0, pp[2] || 0);
                    obj = g;
                }
                if (def && def.weapon && def.weapon.style === 'staff') { obj.userData = obj.userData || {}; obj.userData.upright = true; }
                if (def && def.glow !== undefined) { obj.userData = obj.userData || {}; obj.userData.glow = def.glow; }   // item.json glow: false | {color, y}
                c.setHandItem(obj);
            });
        }

        // -----------------------------------------------------------
        // Tooltip (#item-tooltip)
        // -----------------------------------------------------------
        showTooltipFor(el, kind, id, count, isDoll) {
            if (!this.tooltip) return;
            let def = null, meta = '';
            if (kind === 'skill') {
                def = this.game.skills.get(id);
                if (def) meta = skillMeta(def, this.game.hero);
            } else {
                def = window.AveloraItems.get(id);
                if (def) {
                    const n = this.state ? this.state.inventory.count(id) : 0;
                    const countStr = (count !== undefined && count > 1) ? `Количество: ${count}` : (count === undefined && n > 1 ? `В сумке: ${n}` : '');
                    const typeStr = def.use ? (def.use.type === 'equip' ? (isDoll ? 'снаряжение (надето)' : 'снаряжение') : 'действие') : 'материал';
                    meta = countStr ? `${countStr} · ${typeStr}` : typeStr;
                }
            }
            if (!def) return;
            this.tooltip.innerHTML = '';
            this.tooltip.classList.remove('warn');
            const lab = kind === 'skill' ? this.game.skills.labelOf(def) : def;
            const n = document.createElement('div'); n.className = 'tt-name'; n.textContent = lab.name;
            const d = document.createElement('div'); d.className = 'tt-desc'; d.textContent = lab.description || '';
            const m = document.createElement('div'); m.className = 'tt-meta'; m.textContent = meta;
            this.tooltip.append(n, d, m);
            if (kind === 'skill') {
                const sl = this.skillStatsLine(def);
                if (sl) { const sd = document.createElement('div'); sd.className = 'tt-req'; sd.style.color = '#a9d68c'; sd.textContent = sl; this.tooltip.appendChild(sd); }
            } else {
                const slLines = this.itemStatsLines(def);
                slLines.forEach(l => {
                    const sd = document.createElement('div');
                    sd.className = 'tt-req';
                    sd.style.color = '#a9d68c';
                    sd.textContent = l;
                    this.tooltip.appendChild(sd);
                });
                if (isDoll) {
                    const unequipDiv = document.createElement('div');
                    unequipDiv.className = 'tt-hint';
                    unequipDiv.style.color = '#e0a96d';
                    unequipDiv.style.marginTop = '4px';
                    unequipDiv.style.fontSize = '12px';
                    unequipDiv.textContent = 'Нажмите, чтобы снять (уйдёт в сумку)';
                    this.tooltip.appendChild(unequipDiv);
                }
            }
            this.placeTooltip(el);
        }

        showMessageAt(el, text) {
            if (!this.tooltip) return;
            this.tooltip.innerHTML = '';
            this.tooltip.classList.add('warn');
            const n = document.createElement('div'); n.className = 'tt-name'; n.textContent = text;
            this.tooltip.appendChild(n);
            this.placeTooltip(el);
            clearTimeout(this.tooltipTimer); // UI-only timer (not gameplay) — fine to use real time
            this.tooltipTimer = setTimeout(() => this.hideTooltip(), 1800);
        }

        placeTooltip(el, side) {
            const t = this.tooltip;
            t.classList.remove('hidden');
            const r = el.getBoundingClientRect();
            const tw = t.offsetWidth, th = t.offsetHeight;
            let x, y;
            if (side === 'left' || (el.closest && el.closest('#quest-tracker'))) {
                x = r.left - tw - 12;
                if (x < 6) x = r.right + 12;
                y = r.top + r.height / 2 - th / 2;
                y = Math.max(6, Math.min(window.innerHeight - th - 6, y));
            } else {
                x = r.left + r.width / 2 - tw / 2;
                x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
                y = r.top - th - 8;
                if (y < 6) y = r.bottom + 8;
                if (y + th > window.innerHeight - 6) y = Math.max(6, window.innerHeight - th - 6);
            }
            t.style.left = `${x}px`;
            t.style.top = `${y}px`;
        }

        hideTooltip() {
            if (this.tooltip) {
                this.tooltip.classList.add('hidden');
                this.tooltip.classList.remove('interactive');
            }
        }

        /**
         * Interactive item card shown on tap (mobile) or click (desktop) on an inventory cell.
         * Contains description and actionable buttons: Equip/Unequip, Split stack, Drop.
         */
        showItemCard(src) {
            if (!this.tooltip) return;
            const def = window.AveloraItems.get(src.item);
            if (!def) return;
            const st = this.state;
            const isEquipped = false;   // an item in the hand is not in the bag, so a bag card always offers "Надеть"

            this.tooltip.innerHTML = '';
            this.tooltip.classList.remove('warn');
            this.tooltip.classList.add('interactive');

            const header = document.createElement('div');
            header.className = 'tt-header';

            const n = document.createElement('div');
            n.className = 'tt-name';
            n.textContent = def.name;

            const btnClose = document.createElement('button');
            btnClose.type = 'button';
            btnClose.className = 'tt-close';
            btnClose.textContent = '×';
            btnClose.title = 'Закрыть';
            btnClose.setAttribute('aria-label', 'Закрыть карточку');
            btnClose.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideTooltip();
            });

            header.append(n, btnClose);

            const d = document.createElement('div');
            d.className = 'tt-desc';
            d.textContent = def.description || '';
            const typeStr = def.use ? (def.use.type === 'equip' ? 'снаряжение' : 'действие') : 'материал';
            const m = document.createElement('div');
            m.className = 'tt-meta';
            m.textContent = src.count > 1 ? `Количество: ${src.count} · ${typeStr}` : typeStr;

            this.tooltip.append(header, d, m);
            const slLines = this.itemStatsLines(def);
            slLines.forEach(l => {
                const sd = document.createElement('div');
                sd.className = 'tt-req';
                sd.style.color = '#a9d68c';
                sd.textContent = l;
                this.tooltip.appendChild(sd);
            });
            if (def.requires) {
                const lack = this.unmetRequirement(def), rq = def.requires, nm = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.statNames) || {};
                const parts = [];
                if (rq.level) parts.push(`${rq.level}-й уровень`);
                ['str', 'dex', 'int'].forEach(k => { if (rq[k]) parts.push(`${nm[k] || k} ${rq[k]}`); });
                const r = document.createElement('div');
                r.className = 'tt-req' + (lack ? ' bad' : '');
                r.textContent = 'Требуется: ' + parts.join(', ');
                this.tooltip.appendChild(r);
            }

            // Action buttons row (tap on mobile or click on PC)
            const actions = document.createElement('div');
            actions.className = 'tt-actions';

            if (def.use && def.use.type === 'equip') {
                const btnEquip = document.createElement('button');
                btnEquip.className = 'tt-btn';
                btnEquip.textContent = isEquipped ? 'Снять' : 'Надеть';
                btnEquip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideTooltip();
                    this.equip(src.item);
                });
                actions.appendChild(btnEquip);
            }

            if (def.use && def.use.type === 'heal') {
                const btnDrink = document.createElement('button');
                btnDrink.className = 'tt-btn primary';
                btnDrink.textContent = 'Выпить';
                btnDrink.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideTooltip();
                    this.consumeHeal(src.item);
                });
                actions.appendChild(btnDrink);
            }

            const shopOpen = !!(this.dialog && this.dialog.isShopOpen()); // trading: no split / drop in the card
            if (src.count > 1 && !shopOpen) {
                const btnSplit = document.createElement('button');
                btnSplit.className = 'tt-btn';
                btnSplit.textContent = '✂ Разделить';
                btnSplit.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideTooltip();
                    const emptyIdx = st.inventory.firstEmpty();
                    if (emptyIdx < 0) {
                        this.showMessageAt(src.el, 'Нет свободных ячеек в сумке');
                        return;
                    }
                    this.openQuantityModal({
                        mode: 'split',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count - 1,
                        initial: Math.floor(src.count / 2),
                        onConfirm: (count) => {
                            st.inventory.split(src.index, -1, count);
                        }
                    });
                });
                actions.appendChild(btnSplit);
            }

            if (this.dialog && this.dialog.isShopOpen()) {
                const price = this.dialog.sellPriceOf(src.item);
                if (price > 0) {
                    const mkSell = (label, all) => {
                        const b = document.createElement('button');
                        b.className = 'tt-btn primary';
                        b.textContent = label;
                        b.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.hideTooltip();
                            this.dialog.sellFromBag(src.index, all);
                        });
                        actions.appendChild(b);
                    };
                    mkSell(`Продать за ${price}`, false);
                    if (src.count > 1) mkSell(`Продать все (${price * src.count})`, true);
                }
            }

            if (this.chestInv) {
                // Chest is open: "Выбросить" would drop the stack on the ground — offer the chest instead
                const btnPut = document.createElement('button');
                btnPut.className = 'tt-btn primary';
                btnPut.textContent = '⇲ В сундук';
                btnPut.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideTooltip();
                    if (this.chestInv && st) this.quickMove(st.inventory, src.index, this.chestInv);
                });
                actions.appendChild(btnPut);
            }

            const btnDrop = document.createElement('button');
            btnDrop.className = 'tt-btn drop';
            btnDrop.textContent = '⏏ Выбросить';
            btnDrop.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideTooltip();
                if (src.count === 1) {
                    this.game.worldObjects.dropFromInventory(src.index);
                } else {
                    this.openQuantityModal({
                        mode: 'drop',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count,
                        initial: src.count,
                        onConfirm: (count) => {
                            this.game.worldObjects.dropFromInventory(src.index, count);
                        }
                    });
                }
            });
            if (!shopOpen) actions.appendChild(btnDrop);

            this.tooltip.appendChild(actions);
            this.placeTooltip(src.el);
        }

        setupQuantityModal() {
            if (!this.quantityModal) return;
            this.qmTitle = document.getElementById('quantity-modal-title');
            this.qmIcon = document.getElementById('quantity-item-icon');
            this.qmName = document.getElementById('quantity-item-name');
            this.qmDesc = document.getElementById('quantity-item-desc');
            this.qmInput = document.getElementById('quantity-input');
            this.qmSlider = document.getElementById('quantity-slider');
            this.qmDec = document.getElementById('quantity-dec');
            this.qmInc = document.getElementById('quantity-inc');
            this.qmConfirm = document.getElementById('quantity-confirm');
            this.qmCancel = document.getElementById('quantity-cancel');
            this.qmClose = document.getElementById('quantity-modal-close');
            this.qmPresets = Array.from(this.quantityModal.querySelectorAll('.quantity-preset-btn'));

            const updateVal = (v) => {
                const min = parseInt(this.qmInput.min, 10) || 1;
                const max = parseInt(this.qmInput.max, 10) || 1;
                let val = Math.max(min, Math.min(max, parseInt(v, 10) || min));
                this.qmInput.value = String(val);
                this.qmSlider.value = String(val);
            };

            if (this.qmSlider) this.qmSlider.addEventListener('input', () => updateVal(this.qmSlider.value));
            if (this.qmInput) this.qmInput.addEventListener('input', () => updateVal(this.qmInput.value));
            if (this.qmDec) this.qmDec.addEventListener('click', () => updateVal((parseInt(this.qmInput.value, 10) || 1) - 1));
            if (this.qmInc) this.qmInc.addEventListener('click', () => updateVal((parseInt(this.qmInput.value, 10) || 1) + 1));

            this.qmPresets.forEach(btn => {
                btn.addEventListener('click', () => {
                    const preset = btn.dataset.preset;
                    const max = parseInt(this.qmInput.max, 10) || 1;
                    if (preset === '1') updateVal(1);
                    else if (preset === 'half') updateVal(Math.max(1, Math.floor(max / 2)));
                    else if (preset === 'all') updateVal(max);
                });
            });

            const close = () => {
                this.quantityModal.classList.add('hidden');
                if (this._qmCallbackCancel) this._qmCallbackCancel();
                this._qmCallbackConfirm = null;
                this._qmCallbackCancel = null;
            };

            const confirm = () => {
                const count = parseInt(this.qmInput.value, 10) || 1;
                this.quantityModal.classList.add('hidden');
                if (this._qmCallbackConfirm) this._qmCallbackConfirm(count);
                this._qmCallbackConfirm = null;
                this._qmCallbackCancel = null;
            };

            if (this.qmCancel) this.qmCancel.addEventListener('click', close);
            if (this.qmClose) this.qmClose.addEventListener('click', close);
            if (this.qmConfirm) this.qmConfirm.addEventListener('click', confirm);
            this.quantityModal.addEventListener('click', (e) => {
                if (e.target === this.quantityModal) close();
            });

            window.addEventListener('keydown', (e) => {
                if (this.quantityModal && !this.quantityModal.classList.contains('hidden')) {
                    if (e.code === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        confirm();
                    } else if (e.code === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        close();
                    }
                }
            });
        }

        openQuantityModal({ mode, item, totalCount, max, initial, onConfirm, onCancel }) {
            if (!this.quantityModal) return;
            this.hideTooltip();
            const def = window.AveloraItems.get(item);
            this._qmCallbackConfirm = onConfirm;
            this._qmCallbackCancel = onCancel;

            if (this.qmTitle) this.qmTitle.textContent = mode === 'drop' ? 'Выбросить предмет' : 'Разделить стек';
            if (this.qmConfirm) {
                this.qmConfirm.textContent = mode === 'drop' ? 'Выбросить' : 'Разделить';
                this.qmConfirm.className = `quantity-btn confirm ${mode === 'drop' ? 'drop' : ''}`;
            }
            if (this.qmName) this.qmName.textContent = def ? def.name : item;
            if (this.qmDesc) this.qmDesc.textContent = `В ячейке: ${totalCount} шт.`;

            if (this.qmIcon) {
                this.qmIcon.innerHTML = '';
                this.qmIcon.appendChild(makeIcon(def));
            }

            const min = 1;
            const maxVal = Math.max(1, max);
            const initVal = Math.max(min, Math.min(maxVal, initial !== undefined ? initial : maxVal));

            if (this.qmInput) {
                this.qmInput.min = String(min);
                this.qmInput.max = String(maxVal);
                this.qmInput.value = String(initVal);
            }

            if (this.qmSlider) {
                this.qmSlider.min = String(min);
                this.qmSlider.max = String(maxVal);
                this.qmSlider.value = String(initVal);
            }

            this.quantityModal.classList.remove('hidden');
            if (this.qmInput) {
                this.qmInput.focus();
                this.qmInput.select();
            }
        }

        // -----------------------------------------------------------
        // Floating texts ("+5 Камень", "Сумка полна") above the character
        // -----------------------------------------------------------
        floatText(text, kind, delay) {
            if (!this.labelsEl) return;
            const el = document.createElement('div');
            el.className = `float-text ${kind || ''}`;
            el.textContent = text;
            el.style.display = 'none';
            this.labelsEl.appendChild(el);
            const stack = this.floats.filter(f => f.age < 0.5).length;
            this.floats.push({ el, age: -(delay || 0), stack });
        }

        /**
         * Floating text anchored to a WORLD point (damage numbers over a creature,
         * "−7" over the player): rises ~0.9 m and fades, like floatText().
         */
        floatAt(text, kind, x, y, z) {
            if (!this.labelsEl) return;
            const el = document.createElement('div');
            el.className = `float-text ${kind || ''}`;
            el.textContent = text;
            el.style.display = 'none';
            this.labelsEl.appendChild(el);
            // Small random sideways jitter so rapid numbers don't stack exactly
            this.floats.push({ el, age: 0, stack: 0, anchor: { x: x + (Math.random() - 0.5) * 0.35, y, z } });
            if (this.floats.length > 40) { const f = this.floats.shift(); f.el.remove(); }
        }

        /** "+1 Мясо" rising over the BAG button (loot that went straight into the bag). */
        bagFloat(text, delay) {
            if (!this.invBtn) { this.floatText(text, 'gain', delay); return; }
            const r = this.invBtn.getBoundingClientRect();
            const n = (this._bagFloats = (this._bagFloats || 0) + 1);
            const el = document.createElement('div');
            el.className = 'bag-float';
            el.textContent = text;
            el.style.left = (r.left + r.width / 2) + 'px';
            el.style.top = (r.top - 6 - ((n - 1) % 4) * 22) + 'px';
            el.style.animationDelay = (delay || 0) + 's';
            (document.getElementById('game-ui') || document.body).appendChild(el);
            el.addEventListener('animationend', () => { el.remove(); this._bagFloats = Math.max(0, (this._bagFloats || 1) - 1); });
        }

        clearFloats() {
            this.floats.forEach(f => f.el.remove());
            this.floats.length = 0;
        }

        updateFloats(delta) {
            if (!this.floats.length) return;
            const c = this.game.character;
            const w = window.innerWidth, h = window.innerHeight;
            for (let i = this.floats.length - 1; i >= 0; i--) {
                const f = this.floats[i];
                f.age += delta;
                if (f.age >= FLOAT_LIFE || !c) { f.el.remove(); this.floats.splice(i, 1); continue; }
                if (f.age < 0) continue;
                const t = f.age / FLOAT_LIFE;
                // First person: the hero is not on screen, so texts "over the hero" (xp, equipped, "-7" ...)
                // float up from just under the crosshair instead of from a point behind the camera
                if (this.game.viewMode === 'first' && (!f.anchor || Math.hypot(f.anchor.x - c.position.x, f.anchor.z - c.position.z) < 2.5)) {
                    f.el.style.display = 'block';
                    f.el.style.opacity = String(t < 0.15 ? t / 0.15 : t > 0.65 ? (1 - t) / 0.35 : 1);
                    const py = h * 0.6 - t * 46 - f.stack * 26;
                    f.el.style.transform = `translate(-50%, -100%) translate(${(w / 2 + (f.anchor ? 70 + (f.anchor.x - c.position.x) * 120 : 0)).toFixed(1)}px, ${py.toFixed(1)}px)`;
                    continue;
                }
                if (f.anchor) this._v.set(f.anchor.x, f.anchor.y + t * 0.9, f.anchor.z).project(this.game.camera);
                else this._v.set(c.position.x, c.position.y + 2.15 + t * 0.9 + f.stack * 0.32, c.position.z).project(this.game.camera);
                if (this._v.z >= 1) { f.el.style.display = 'none'; continue; }
                f.el.style.display = 'block';
                f.el.style.opacity = String(t < 0.15 ? t / 0.15 : t > 0.65 ? (1 - t) / 0.35 : 1);
                f.el.style.transform = `translate(-50%, -100%) translate(${((this._v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - this._v.y) / 2 * h).toFixed(1)}px)`;
            }
        }

        // -----------------------------------------------------------
        // Range indicator: red dot & red hotkey when target is out of range
        // Throttled to ~120ms (8 Hz), 0 CPU overhead, dirty-checked
        // -----------------------------------------------------------
        updateRangeIndicators(delta) {
            this._rangeTimer = (this._rangeTimer || 0) - delta;
            if (this._rangeTimer > 0) return;
            this._rangeTimer = 0.12;

            const target = (this.game.combat && this.game.combat.selectedTarget) || null;
            const cr = this.game.creatures;
            const isTargetAlive = target && cr && cr.isAlive(target);

            if (!isTargetAlive) {
                if (this._hasOutOfRangeSlots) {
                    for (let i = 0; i < this.slots.length; i++) {
                        const s = this.slots[i];
                        if (s._outOfRange) {
                            s._outOfRange = false;
                            s.classList.remove('out-of-range');
                        }
                    }
                    this._hasOutOfRangeSlots = false;
                }
                return;
            }

            const c = this.game.character;
            if (!c || !c.position) return;

            const dist = Math.hypot(target.x - c.position.x, target.z - c.position.z);
            const hitR = (target.def && target.def.hitRadius) || 0.4;
            const edgeDist = Math.max(0, dist - hitR);
            const hb = this.state ? this.state.hotbar : [];
            let hasAny = false;

            for (let i = 0; i < this.slots.length; i++) {
                const slot = this.slots[i];
                const e = hb[i];
                let outOfRange = false;

                if (e && e.type === 'skill') {
                    const def = this.game.skills ? this.game.skills.get(e.id) : null;
                    if (def && (def.type === 'projectile' || def.type === 'rain' || def.type === 'strike')) {
                        const maxRange = (def.range || 12) + 2;
                        outOfRange = dist > maxRange;
                    }
                } else if (i === 0 && (slot.classList.contains('is-basic-attack') || (!e && document.body && document.body.classList.contains('touch-ui')))) {
                    const w = this.game.combat ? this.game.combat.weapon() : null;
                    const wRange = (w && w.range) ? w.range : 2.5;
                    outOfRange = edgeDist > wRange;
                }

                if (slot._outOfRange !== outOfRange) {
                    slot._outOfRange = outOfRange;
                    slot.classList.toggle('out-of-range', outOfRange);
                }
                if (outOfRange) hasAny = true;
            }

            this._hasOutOfRangeSlots = hasAny;
        }

        // -----------------------------------------------------------
        // Per-frame (game time): cooldown sweeps + floating texts
        // -----------------------------------------------------------
        update(delta) {
            this.updateFloats(delta);
            this.updateAutoPotion(delta);
            this.updateRangeIndicators(delta);
            if (this.heroOpen && (this._heroT = (this._heroT || 0) + delta) >= 0.4) { this._heroT = 0; this.updateHeroStats(); }
            if (!this.state) return;
            const hb = this.state.hotbar;
            for (let i = 0; i < this.slots.length; i++) {
                const e = hb[i];
                if (!e || e.type !== 'skill') continue;
                const frac = this.game.skills.cooldownFraction(e.id);
                const q = Math.round(frac * 120); // quantized: only touch the DOM when the sweep visibly moves
                if (q === this.cdCache[i]) continue;
                this.cdCache[i] = q;
                const slot = this.slots[i];
                slot.classList.toggle('cooling', q > 0);
                // Classic clockwise sweep (WoW/Diablo): the uncovered part starts at
                // 12 o'clock and grows CLOCKWISE; the dark remainder is the arc from
                // the sweep edge to 12 o'clock.
                const edge = ((1 - frac) * 360).toFixed(1);
                slot._cd.style.background = q > 0
                    ? `conic-gradient(rgba(6,8,10,0) ${edge}deg, rgba(6,8,10,0.78) ${edge}deg)`
                    : '';
            }
            // Skills panel cooldown sweeps
            if (this.skillsOpen && this.skillsList && this.game.skills) {
                const entries = this.skillsList.querySelectorAll('.skill-entry');
                for (let i = 0; i < entries.length; i++) {
                    const row = entries[i];
                    const id = row.dataset.skill;
                    if (!id || !row._cd) continue;
                    const frac = this.game.skills.cooldownFraction(id);
                    const q = Math.round(frac * 120);
                    if (q === row._cdCache) continue;
                    row._cdCache = q;
                    row.classList.toggle('cooling', q > 0);
                    const edge = ((1 - frac) * 360).toFixed(1);
                    row._cd.style.background = q > 0
                        ? `conic-gradient(rgba(6,8,10,0) ${edge}deg, rgba(6,8,10,0.78) ${edge}deg)`
                        : '';
                }
            }
        }

        // -----------------------------------------------------------
        // Input: keys, pointer drag & drop
        // -----------------------------------------------------------
        setupEvents() {
            window.addEventListener('keydown', (e) => {
                if (e.repeat) return;
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
                const m = /^Digit([0-9])$/.exec(e.code);
                if (m) {
                    const d = parseInt(m[1], 10);
                    this.activateSlot(d === 0 ? 9 : d - 1);
                } else if (e.code === 'KeyK') { // physical key: works in RU layout too (Л)
                    if (this.inputAllowed()) this.toggleSkills();
                } else if (e.code === 'KeyC') { // physical key: works in RU layout too (С)
                    if (this.inputAllowed()) this.toggleHero();
                } else if (e.code === 'KeyL') { // physical key: works in RU layout too (Д)
                    if (this.inputAllowed()) this.toggleQuests();
                } else if (e.code === 'KeyN') { // physical key: works in RU layout too (Т): Ремесло
                    if (this.inputAllowed()) this.toggleCrafting();
                }
            });

            if (this.skillsBtn) {
                this.skillsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeMicroMenu();
                    if (this.inputAllowed()) this.toggleSkills();
                });
            }
            const skillsClose = document.getElementById('skills-close');
            if (skillsClose) {
                skillsClose.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setSkillsOpen(false);
                });
            }

            if (this.microToggleBtn) {
                this.microToggleBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleMicroMenu();
                });
            }
            if (this.heroBtn) {
                this.heroBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeMicroMenu();
                    if (this.inputAllowed()) this.toggleHero();
                });
            }
            if (this.questsBtn) {
                this.questsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeMicroMenu();
                    if (this.inputAllowed()) this.toggleQuests();
                });
            }
            document.addEventListener('click', (e) => {
                if (this.microMenuOpen && !e.target.closest('.micromenu-container')) {
                    this.closeMicroMenu();
                }
            });

            // Press on any drag source (delegated)
            document.addEventListener('pointerdown', (e) => {
                if (this.tooltip && this.tooltip.classList.contains('interactive')) {
                    if (!this.tooltip.contains(e.target) && !e.target.closest('.inventory-cell')) {
                        this.hideTooltip();
                    }
                }
                this.onPointerDown(e);
            });
            window.addEventListener('pointermove', (e) => this.onPointerMove(e));
            window.addEventListener('pointerup', (e) => this.onPointerUp(e));
            window.addEventListener('pointercancel', (e) => {
                if (this.drag && (!e || e.pointerId === this.drag.pointerId)) this.cancelDrag();
            });

            // Hover tooltips (mouse only)
            document.addEventListener('pointerover', (e) => {
                if (e.pointerType !== 'mouse' || this.drag) return;
                if (this.tooltip && this.tooltip.classList.contains('interactive')) return;
                const src = this.sourceFromEl(e.target);
                if (src) this.showSourceTooltip(src);
            });
            document.addEventListener('pointerout', (e) => {
                if (e.pointerType !== 'mouse') return;
                if (this.tooltip && this.tooltip.classList.contains('interactive')) return;
                const src = this.sourceFromEl(e.target);
                if (src && !(e.relatedTarget && src.el.contains(e.relatedTarget)) && !(this.tooltip && this.tooltip.classList.contains('warn'))) this.hideTooltip();
            });

            // Double click on a bag item that can be worn/held -> take it into the hand
            document.addEventListener('dblclick', (e) => {
                const cell = e.target && e.target.closest && e.target.closest('.inventory-cell');
                if (!cell || !this.state || this.chestInv) return;
                const c = this.state.inventory.cells[parseInt(cell.dataset.cell, 10)];
                if (c && window.AveloraItems.isEquippable(c.item)) { this.hideTooltip(); this.equip(c.item); }
            });

            window.addEventListener('game:pause', () => { this.cancelDrag(); this.hideTooltip(); });
        }

        /** Which draggable thing (if any) an element belongs to. */
        sourceFromEl(target) {
            if (!target || !target.closest) return null;
            const doll = target.closest('.doll-slot');
            if (doll && this.state && this.state.equipped) {
                const slot = doll.dataset.slot;
                const key = slot === 'weapon' ? 'right' : slot;
                const itemId = this.state.equipped[key];
                return itemId ? { kind: 'doll', slot: key, item: itemId, el: doll } : null;
            }
            const slot = target.closest('.hotbar-slot');
            if (slot && this.state) {
                const i = parseInt(slot.dataset.slot, 10);
                const e = this.state.hotbar[i];
                return { kind: 'slot', index: i, entry: e, el: slot };
            }
            const ccell = target.closest('.chest-cell');
            if (ccell && this.chestInv) {
                const i = parseInt(ccell.dataset.cell, 10);
                const c = this.chestInv.cells[i];
                return c ? { kind: 'chest', index: i, item: c.item, count: c.count, el: ccell } : null;
            }
            const cell = target.closest('.inventory-cell');
            if (cell && this.state) {
                const i = parseInt(cell.dataset.cell, 10);
                const c = this.state.inventory.cells[i];
                return c ? { kind: 'inv', index: i, item: c.item, count: c.count, el: cell } : null;
            }
            const skill = target.closest('.skill-entry');
            if (skill) return { kind: 'skill', id: skill.dataset.skill, el: skill };
            const craftTip = target.closest('.craft-tip');
            if (craftTip && craftTip.dataset.item) return { kind: 'craft', item: craftTip.dataset.item, el: craftTip };
            return null;
        }

        showSourceTooltip(src) {
            if (src.kind === 'inv' || src.kind === 'chest') this.showTooltipFor(src.el, 'item', src.item, src.count);
            else if (src.kind === 'doll') this.showTooltipFor(src.el, 'item', src.item, undefined, true);
            else if (src.kind === 'skill') this.showTooltipFor(src.el, 'skill', src.id);
            else if (src.kind === 'craft') this.showTooltipFor(src.el, 'item', src.item);
            else if (src.kind === 'slot' && src.entry) this.showTooltipFor(src.el, src.entry.type === 'skill' ? 'skill' : 'item', src.entry.id);
        }

        sourceIconDef(src) {
            if (src.kind === 'inv' || src.kind === 'chest' || src.kind === 'doll') return window.AveloraItems.get(src.item);
            if (src.kind === 'skill') return this.game.skills.get(src.id);
            if (src.kind === 'slot' && src.entry) {
                return src.entry.type === 'skill' ? this.game.skills.get(src.entry.id) : window.AveloraItems.get(src.entry.id);
            }
            return null;
        }

        onPointerDown(e) {
            if (e.button !== undefined && e.button !== 0) return;
            if (!this.inputAllowed()) return;
            const src = this.sourceFromEl(e.target);
            if (!src) return;
            if (src.kind === 'doll') return; // Don't drag from doll; click unequips it
            const isTouchSkill = e.pointerType !== 'mouse' && src.kind === 'skill';
            this.drag = {
                src,
                x: e.clientX,
                y: e.clientY,
                lastX: e.clientX,
                lastY: e.clientY,
                pointerId: e.pointerId,
                pointerType: e.pointerType,
                active: false,
                scrolling: false,
                over: null,
                shiftKey: !!e.shiftKey,
                ctrlKey: !!e.ctrlKey,
                captureEl: e.target
            };
            if (!isTouchSkill) {
                e.preventDefault();
                try {
                    if (e.target && e.target.setPointerCapture) {
                        e.target.setPointerCapture(e.pointerId);
                    }
                } catch (_) {}
            }
        }

        onPointerMove(e) {
            const d = this.drag;
            if (!d || e.pointerId !== d.pointerId) return;
            if (!d.active) {
                // На сенсорных экранах отличаем вертикальный скролл от перетаскивания
                if (d.pointerType !== 'mouse' && d.src.kind === 'skill') {
                    const dx = e.clientX - d.x;
                    const dy = e.clientY - d.y;
                    const absDx = Math.abs(dx);
                    const absDy = Math.abs(dy);

                    // Если движение вертикальное: это плавный скролл списка навыков!
                    if (d.scrolling || (absDy > absDx && absDy > 3)) {
                        d.scrolling = true;
                        if (this.skillsList) {
                            const stepY = d.lastY - e.clientY;
                            if (Math.abs(stepY) > 0.5) this.skillsList.scrollTop += stepY;
                        }
                        d.lastY = e.clientY;
                        d.lastX = e.clientX;
                        return;
                    }

                    // Для начала перетаскивания (DnD) жест направлен вбок (в сторону панели)
                    if (absDx < DRAG_THRESHOLD || absDx < absDy + 4) return;
                } else {
                    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
                }

                // Only real things can be dragged (an empty slot is just a click target)
                if (d.src.kind === 'slot' && !d.src.entry) { this.drag = null; return; }
                // On touch screens, lock dragging skills/items directly OFF the hotbar unless the skills panel is open
                // (prevents accidentally throwing away bound skills during combat/running).
                if (d.pointerType !== 'mouse' && d.src.kind === 'slot' && !this.skillsOpen) {
                    this.drag = null;
                    return;
                }
                d.active = true;
                this.hideTooltip();
                try {
                    if (d.captureEl && d.captureEl.setPointerCapture) {
                        d.captureEl.setPointerCapture(d.pointerId);
                    }
                } catch (_) {}
                this.startGhost(d.src);
                document.body.classList.add('ui-dragging');
            }
            this.moveGhost(e.clientX, e.clientY);
            this.updateDropHighlight(e.clientX, e.clientY);
        }

        onPointerUp(e) {
            const d = this.drag;
            if (!d || e.pointerId !== d.pointerId) return;
            if (d.captureEl) {
                try { d.captureEl.releasePointerCapture(d.pointerId); } catch (_) {}
            }
            this.drag = null;
            if (d.scrolling) {
                // Был скролл списка пальцем — не запускаем tap-to-equip
                return;
            }
            if (!d.active) {
                // Plain tap/click
                if (d.src.kind === 'slot') {
                    this.activateSlot(d.src.index);
                } else if (d.src.kind === 'chest') {
                    if (this.state) this.quickMove(this.chestInv, d.src.index, this.state.inventory);
                } else if (d.src.kind === 'inv') {
                    if (this.chestInv && this.state && (e.ctrlKey || e.metaKey)) {
                        this.quickMove(this.state.inventory, d.src.index, this.chestInv);
                        return;
                    }
                    if (e.shiftKey && d.src.count > 1) {
                        // Desktop Shift+Click on stack -> instant split dialog!
                        const emptyIdx = this.state ? this.state.inventory.firstEmpty() : -1;
                        if (emptyIdx < 0) {
                            this.showMessageAt(d.src.el, 'Нет свободных ячеек в сумке');
                            return;
                        }
                        this.openQuantityModal({
                            mode: 'split',
                            item: d.src.item,
                            totalCount: d.src.count,
                            max: d.src.count - 1,
                            initial: Math.floor(d.src.count / 2),
                            onConfirm: (count) => {
                                if (this.state) this.state.inventory.split(d.src.index, -1, count);
                            }
                        });
                        return;
                    }
                    this.showItemCard(d.src);
                } else if (d.src.kind === 'skill') {
                    // Activate skill directly from the skills panel
                    const skillId = d.src.id;
                    if (this.game.skills) {
                        const res = this.game.skills.activate(skillId);
                        if (res === 'ok') {
                            this.flashSlot(d.src.el, 'pressed');
                        } else if (res === 'cooldown') {
                            this.flashSlot(d.src.el, 'shake');
                            const cd = Math.ceil(this.game.skills.cooldownRemaining(skillId));
                            this.showMessageAt(d.src.el, `Перезарядка (${cd} с)`);
                        } else if (res === 'no_mana') {
                            this.flashSlot(d.src.el, 'shake');
                            this.showMessageAt(d.src.el, 'Недостаточно маны');
                        } else if (res === 'busy') {
                            this.flashSlot(d.src.el, 'shake');
                            this.showMessageAt(d.src.el, 'Персонаж занят');
                        } else if (res === 'unavailable') {
                            this.flashSlot(d.src.el, 'shake');
                        }
                    }
                    this.showSourceTooltip(d.src);
                    clearTimeout(this.tooltipTimer);
                    this.tooltipTimer = setTimeout(() => this.hideTooltip(), 1500);
                } else if (d.pointerType !== 'mouse') {
                    // Touch: no hover, so a tap shows the tooltip for a moment
                    this.showSourceTooltip(d.src);
                    clearTimeout(this.tooltipTimer);
                    this.tooltipTimer = setTimeout(() => this.hideTooltip(), 2500);
                }
                return;
            }
            d.shiftKey = e.shiftKey || d.shiftKey;
            d.ctrlKey = e.ctrlKey || d.ctrlKey;
            this.finishDrag(d, e.clientX, e.clientY);
        }

        cancelDrag() {
            if (this.drag) {
                if (this.drag.captureEl) {
                    try { this.drag.captureEl.releasePointerCapture(this.drag.pointerId); } catch (_) {}
                }
                if (this.drag.active) this.endDragVisuals();
            }
            this.drag = null;
        }

        startGhost(src) {
            if (!this.ghost) return;
            this.ghost.innerHTML = '';
            this.ghost.appendChild(makeIcon(this.sourceIconDef(src)));
            this.ghost.classList.remove('hidden');
            if (src.el) src.el.classList.add('drag-source');
        }

        moveGhost(x, y) {
            if (this.ghost) this.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        }

        endDragVisuals() {
            if (this.ghost) this.ghost.classList.add('hidden');
            document.body.classList.remove('ui-dragging');
            document.querySelectorAll('.drop-ok, .drop-bad, .drag-source').forEach(el => el.classList.remove('drop-ok', 'drop-bad', 'drag-source'));
        }

        targetAt(x, y) {
            const el = document.elementFromPoint(x, y);
            if (!el || !el.closest) return null;
            const slot = el.closest('.hotbar-slot');
            if (slot) return { kind: 'slot', index: parseInt(slot.dataset.slot, 10), el: slot };
            const cc = el.closest('.chest-cell');
            if (cc && this.chestInv) return { kind: 'chest', index: parseInt(cc.dataset.cell, 10), el: cc };
            const cell = el.closest('.inventory-cell');
            if (cell) return { kind: 'inv', index: parseInt(cell.dataset.cell, 10), el: cell };
            const doll = el.closest('.doll-slot');
            if (doll) return { kind: 'doll', slot: doll.dataset.slot, el: doll };
            if (el.closest('#skill-bar')) return { kind: 'bar', el: null };
            return null;
        }

        /** Can src be dropped on target? true | false (invalid, red) | null (not a target at all). */
        dropVerdict(src, tgt) {
            if (!tgt || !tgt.el) return null;
            if (tgt.kind === 'slot') {
                if (src.kind === 'skill' || src.kind === 'slot') return true;
                if (src.kind === 'inv') return window.AveloraItems.canHotbar(src.item);
            }
            if (tgt.kind === 'doll') {
                if (src.kind !== 'inv') return null;
                return window.AveloraItems.isEquippable(src.item) && this.canEquipInDollSlot(src.item, tgt.slot);
            }
            if (tgt.kind === 'inv') return (src.kind === 'inv' || src.kind === 'chest') ? true : null;
            if (tgt.kind === 'chest') return (src.kind === 'inv' || src.kind === 'chest') ? true : null;
            return null;
        }

        updateDropHighlight(x, y) {
            const d = this.drag;
            const tgt = this.targetAt(x, y);
            const key = tgt && tgt.el ? tgt.el : null;
            if (d.over === key) return;
            if (d.over) d.over.classList.remove('drop-ok', 'drop-bad');
            d.over = key;
            const v = this.dropVerdict(d.src, tgt);
            if (key && v !== null) key.classList.add(v ? 'drop-ok' : 'drop-bad');
        }

        finishDrag(d, x, y) {
            this.endDragVisuals();
            const src = d.src;
            const tgt = this.targetAt(x, y);
            const st = this.state;
            if (!st) return;

            if (tgt && tgt.kind === 'doll') {
                // bag item dragged onto the dressing-room: weapon slot takes equippable items
                if (src.kind === 'inv' && window.AveloraItems.isEquippable(src.item) && this.canEquipInDollSlot(src.item, tgt.slot)) this.equip(src.item, tgt.slot === 'weapon' ? 'right' : tgt.slot);
                else if (src.kind === 'inv') this.showMessageAt(tgt.el, 'Сюда это не надеть');
                return;
            }
            if (tgt && tgt.kind === 'slot') {
                if (src.kind === 'skill') {
                    this.bindSlot(tgt.index, { type: 'skill', id: src.id });
                } else if (src.kind === 'inv') {
                    if (window.AveloraItems.canHotbar(src.item)) {
                        this.bindSlot(tgt.index, { type: 'item', id: src.item });
                    } else {
                        this.flashSlot(tgt.el, 'reject');
                        this.showMessageAt(tgt.el, 'Нельзя: у предмета нет действия');
                    }
                } else if (src.kind === 'slot') {
                    st.swapHotbar(src.index, tgt.index);
                }
                return;
            }
            if (tgt && (tgt.kind === 'chest' || tgt.kind === 'inv') && (src.kind === 'chest' || (src.kind === 'inv' && tgt.kind === 'chest') || (src.kind === 'chest' && tgt.kind === 'inv'))) {
                const fromInv = src.kind === 'chest' ? this.chestInv : st.inventory;
                const toInv = tgt.kind === 'chest' ? this.chestInv : st.inventory;
                if (fromInv && toInv) this.transferCell(fromInv, src.index, toInv, tgt.index);
                return;
            }
            if (tgt && tgt.kind === 'inv' && src.kind === 'inv') {
                if (d.shiftKey && src.count > 1 && src.index !== tgt.index) {
                    // Shift-drag in backpack: split onto this specific target cell!
                    this.openQuantityModal({
                        mode: 'split',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count - 1,
                        initial: Math.floor(src.count / 2),
                        onConfirm: (count) => {
                            st.inventory.split(src.index, tgt.index, count);
                        }
                    });
                    return;
                }
                st.inventory.move(src.index, tgt.index);
                return;
            }
            // Dropped a hotbar binding anywhere off the bar -> clear it
            if (src.kind === 'chest') return;
            if (src.kind === 'slot' && !(tgt && tgt.kind === 'bar')) {
                st.setHotbar(src.index, null);
                return;
            }
            // Bag cell dropped onto the open shop window -> sell the whole stack
            if (src.kind === 'inv' && this.dialog && this.dialog.isShopOpen()) {
                const el = document.elementFromPoint(x, y);
                if (el && el.closest && el.closest('#dialog-panel')) { this.dialog.sellFromBag(src.index, true); return; }
            }
            // Bag cell released over the game world (not over any panel/HUD) -> drop the stack there
            if (src.kind === 'inv' && !tgt && this.isOverWorld(x, y) && this.game.worldObjects) {
                if (src.count <= 1 || d.shiftKey) {
                    // Single item or Shift-drag: drop entire stack immediately!
                    this.game.worldObjects.dropFromInventory(src.index);
                } else if (d.ctrlKey) {
                    // Ctrl-drag on PC: drop exactly 1 item!
                    this.game.worldObjects.dropFromInventory(src.index, 1);
                } else {
                    // Open drop quantity modal!
                    this.openQuantityModal({
                        mode: 'drop',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count,
                        initial: src.count,
                        onConfirm: (count) => {
                            this.game.worldObjects.dropFromInventory(src.index, count);
                        }
                    });
                }
                return;
            }
        }

        /** True when (x, y) is over the 3D world, not over any HUD element / panel (main.js UI_SELECTOR). */
        isOverWorld(x, y) {
            if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const sel = window.AVELORA_UI_SELECTOR || '#skill-bar, #inventory-panel, #chest-panel, #dialog-panel, #skills-panel, #crafting-panel, #quantity-modal, #item-tooltip';
            return !(el.closest && el.closest(sel));
        }

        /** Binds a slot; the same skill/item bound elsewhere moves here (keeps the bar tidy). */
        bindSlot(index, entry) {
            const st = this.state;
            st.hotbar.forEach((e, i) => {
                if (i !== index && e && e.type === entry.type && e.id === entry.id) st.hotbar[i] = null;
            });
            st.setHotbar(index, entry); // saves + re-renders
            this.flashSlot(this.slots[index], 'pressed');
        }
    }

    window.AveloraHotbarUI = AveloraHotbarUI;
})();
