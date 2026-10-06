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
            this.state = null;
            this.floats = [];
            this.drag = null;          // active press/drag
            this.skillsOpen = false;
            this.heroOpen = false;
            this.questsOpen = false;
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
            this.setupCraftingTabs();
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
                slot.append(icon, cd, count, key);
                slot._icon = icon; slot._cd = cd; slot._count = count;
                if (i === 0) {
                    const frame = document.createElement('span');
                    frame.className = 'slot0-medal-frame';
                    const frameTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.slot0Frame;
                    if (frameTex) frame.style.backgroundImage = `url("${frameTex}")`;
                    slot.appendChild(frame);
                    slot._frame = frame;
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
            const has = this.characterSkills().length > 0;
            if (this.skillsBtn) this.skillsBtn.style.display = has ? '' : 'none';
            if (!has) this.setSkillsOpen(false);
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
                slot.classList.remove('missing', 'is-skill', 'is-item', 'is-basic-attack', 'equipped');
                slot.classList.toggle('empty', !e);
                this.cdCache[i] = -1;
                slot._cd.style.background = '';
                if (!e) {
                    // Slot 0 (central attack button): defaults to weapon in hand attack!
                    if (i === 0) {
                        slot.classList.remove('empty');
                        slot.classList.add('is-basic-attack');
                        if (slot._frame && !slot._frame.style.backgroundImage) {
                            const frameTex = window.GAME_ASSETS && window.GAME_ASSETS.textures && window.GAME_ASSETS.textures.slot0Frame;
                            if (frameTex) slot._frame.style.backgroundImage = `url("${frameTex}")`;
                        }
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
                    if (n > 1 || (def && def.stackMax > 1)) slot._count.textContent = n > 0 ? String(n) : '';
                    if (this.state.equippedSlotOf(e.id)) slot.classList.add('equipped');
                }
            });
        }

        renderSkills() {
            if (!this.skillsList) return;
            this.skillsList.innerHTML = '';
            this.characterSkills().forEach(def => {
                const row = document.createElement('div');
                row.className = 'skill-entry';
                row.dataset.skill = def.id;
                const iconWrap = document.createElement('div');
                iconWrap.className = 'skill-entry-icon';
                iconWrap.appendChild(makeIcon(def));
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
                meta.textContent = def.type === 'teleport'
                    ? `Каст ${def.castTime || 0} с · Перезарядка ${def.cooldown || 0} с`
                    : `Перезарядка ${def.cooldown || 0} с · Дальность ${def.range || 0} м` + (def.mana ? ` · Мана ${def.mana}` : '');
                text.append(name, desc, meta);
                row.append(iconWrap, text);
                this.skillsList.appendChild(row);
            });
        }

        setupCraftingTabs() {
            this.tabBtnInv = document.getElementById('tab-btn-inv');
            this.tabBtnCraft = document.getElementById('tab-btn-craft');
            this.tabContentInv = document.getElementById('inventory-tab-content');
            this.tabContentCraft = document.getElementById('crafting-tab-content');
            this.craftingList = document.getElementById('crafting-recipe-list');

            if (this.tabBtnInv && this.tabBtnCraft) {
                this.tabBtnInv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.switchInventoryTab('inv');
                });
                this.tabBtnCraft.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.switchInventoryTab('craft');
                });
            }
            this.switchInventoryTab('inv');
        }

        switchInventoryTab(tab) {
            this.currentTab = tab;
            if (this.tabBtnInv) this.tabBtnInv.classList.toggle('active', tab === 'inv');
            if (this.tabBtnCraft) this.tabBtnCraft.classList.toggle('active', tab === 'craft');
            if (this.tabContentInv) {
                this.tabContentInv.classList.toggle('hidden', tab !== 'inv');
                this.tabContentInv.style.display = (tab === 'inv') ? '' : 'none';
            }
            if (this.tabContentCraft) {
                this.tabContentCraft.classList.toggle('hidden', tab !== 'craft');
                this.tabContentCraft.style.display = (tab === 'craft') ? '' : 'none';
            }
            this.hideTooltip();
            if (tab === 'craft') {
                this.renderCrafting();
            } else {
                this.renderInventory();
            }
        }

        renderCrafting() {
            if (!this.craftingList) return;
            this.craftingList.innerHTML = '';
            const recipes = (window.GAME_CONTENT && window.GAME_CONTENT.recipes) || {};
            const recipeIds = Object.keys(recipes);
            if (!recipeIds.length) {
                const empty = document.createElement('div');
                empty.className = 'crafting-empty';
                empty.textContent = 'Нет доступных рецептов';
                this.craftingList.appendChild(empty);
                return;
            }

            const inv = this.state ? this.state.inventory : null;

            recipeIds.forEach(id => {
                const rec = recipes[id];
                const card = document.createElement('div');
                card.className = 'crafting-card';

                const resItemDef = window.AveloraItems.get(rec.result.item);
                const iconDef = rec.iconData ? rec : resItemDef;

                const topRow = document.createElement('div');
                topRow.className = 'crafting-card-top';

                const iconWrap = document.createElement('div');
                iconWrap.className = 'crafting-card-icon';
                iconWrap.appendChild(makeIcon(iconDef));

                const infoWrap = document.createElement('div');
                infoWrap.className = 'crafting-card-info';
                const title = document.createElement('div');
                title.className = 'crafting-card-title';
                title.textContent = rec.name || (resItemDef ? resItemDef.name : id);
                const desc = document.createElement('div');
                desc.className = 'crafting-card-desc';
                desc.textContent = rec.description || (resItemDef ? resItemDef.description : '');
                infoWrap.append(title, desc);

                topRow.append(iconWrap, infoWrap);

                const ingContainer = document.createElement('div');
                ingContainer.className = 'crafting-ingredients';

                let canCraft = true;
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
                    ingIcon.className = 'crafting-ing-icon';
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
                const mkBtn = (txt, title, fn) => {
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'craft-qty-btn'; b.textContent = txt; b.title = title;
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
                this.craftingList.appendChild(card);
            });
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
            if (open && !this.characterSkills().length) open = false;
            this.skillsOpen = open;
            this.setPanelAria(this.skillsPanel, open);
            if (this.skillsBtn) this.skillsBtn.classList.toggle('active', open);
            this.layoutPanels();
            if (!open) this.hideTooltip();
        }

        /** Desktop: skills panel sits left of the inventory when both are open (unless user dragged it manually). */
        layoutPanels() {
            if (this.skillsPanel && !this.skillsPanel.dataset.dragged) {
                this.skillsPanel.classList.toggle('beside-inventory', !!this.game.isInventoryOpen);
            }
        }

        setupDraggablePanels() {
            this.makePanelDraggable(this.invPanel, '.inventory-header');
            this.makePanelDraggable(this.skillsPanel, '.inventory-header');
            this.makePanelDraggable(this.chestPanel, '.inventory-header');
            this.makePanelDraggable(this.heroPanel, '.panel-header');
            this.makePanelDraggable(this.questsPanel, '.panel-header');
            if (this.dialog && this.dialog.panel) {
                this.makePanelDraggable(this.dialog.panel, '.dlg-side');
            }

            window.addEventListener('resize', () => {
                this.clampPanelInsideViewport(this.invPanel);
                this.clampPanelInsideViewport(this.skillsPanel);
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
                    `<div class="hero-attr-row"><span>${names[k]}</span><span><b>${fmt(tot[k])}</b>${gear[k] ? `<i>+${fmt(gear[k])}</i>` : ''}</span></div>`).join('');
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
            setText('hero-stat-time', `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`);
        }

        /** Equipment slots of the hero panel: only the weapon slot is live for now; the rest wait for gear. */
        renderDoll() {
            const grid = document.getElementById('doll-grid');
            if (!grid) return;
            const st = this.state;
            const SLOT_NAMES = { head: 'Голова', cloak: 'Плащ', body: 'Тело', hands: 'Перчатки', ring: 'Кольцо', weapon: 'Оружие', feet: 'Сапоги' };
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
                    el.title = `${def.name} — нажмите, чтобы снять (уйдёт в сумку)`;
                    el.onclick = (e) => { e.stopPropagation(); this.unequip(key); };
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
            }
        }

        updateQuestsProgress() {
            const listEl = document.getElementById('quests-list');
            if (!listEl) return;
            const st = this.state, dlg = this.dialog;
            const quests = [];
            if (st && dlg) {
                const ids = Object.keys(st.quests || {});
                // active first, finished after
                ids.sort((x, y) => (st.quests[x] === 'active' ? 0 : 1) - (st.quests[y] === 'active' ? 0 : 1));
                ids.forEach(id => {
                    const q = dlg.questDef(id);
                    if (!q) return;
                    const done = st.quests[id] === 'done';
                    const p = dlg.questProgress(q);
                    quests.push({
                        title: q.name, desc: q.summary || '', completed: done,
                        badge: done ? 'Завершено' : (p.ready ? 'Вернись к ' + (dlg.giverName(q) || 'заказчику') : dlg.questLabel(q, p))
                    });
                });
            }
            if (!quests.length) quests.push({ title: 'Пока заданий нет', desc: 'Поговорите с Лираэль у водопада — у неё найдётся работа.', completed: false, badge: '—' });

            listEl.innerHTML = '';
            quests.forEach(q => {
                const card = document.createElement('div');
                card.className = `quest-card ${q.completed ? 'completed' : ''}`;
                card.innerHTML = `
                    <div class="quest-card-header">
                        <div class="quest-card-title">${q.title}</div>
                        <span class="quest-status-badge">${q.badge}</span>
                    </div>
                    <div class="quest-card-desc">${q.desc}</div>
                `;
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
                if (i === 0 && this.game.combat) {
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
            if (cb.hp >= cb.maxHp) {
                this.floatText('Здоровье уже полно', 'warn');
                return false;
            }
            const amount = (def.use && def.use.amount) || 50;
            const healed = Math.min(amount, cb.maxHp - cb.hp);
            cb.heal(amount);
            st.inventory.remove(itemId, 1);
            this.floatText(`+${healed} Здоровье`, 'heal');
            const c = this.game.character;
            if (c) {
                this.floatAt(`+${healed}`, 'heal', c.position.x, c.position.y + 1.8, c.position.z);
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

        /** "Броня +3 · Сила +1 · …" line of an item (armor / stats), or ''. */
        itemStatsLine(def) {
            if (!def) return '';
            const nm = (window.AVELORA_PROGRESSION && window.AVELORA_PROGRESSION.statNames) || {};
            const parts = [];
            if (def.armor) parts.push(`Броня +${def.armor}`);
            if (def.stats) ['str', 'dex', 'int'].forEach(k => { if (def.stats[k]) parts.push(`${nm[k] || k} +${def.stats[k]}`); });
            if (def.weapon && def.weapon.damage) parts.push(`Урон ${def.weapon.damage[0]}–${def.weapon.damage[1]}`);
            return parts.join(' · ');
        }

        /** Bag -> right hand. Returns true on success. */
        equip(itemId) {
            const st = this.state, def = window.AveloraItems.get(itemId);
            if (!st || !def) return false;
            const lack = this.unmetRequirement(def);
            if (lack) { this.floatText(lack, 'warn'); return false; }
            const res = st.equipFromBag(itemId);
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
                c.setHandItem(obj);
            });
        }

        // -----------------------------------------------------------
        // Tooltip (#item-tooltip)
        // -----------------------------------------------------------
        showTooltipFor(el, kind, id, count) {
            if (!this.tooltip) return;
            let def = null, meta = '';
            if (kind === 'skill') {
                def = this.game.skills.get(id);
                if (def) meta = `Перезарядка ${def.cooldown || 0} с · Дальность ${def.range || 0} м` + (def.mana ? ` · Мана ${def.mana}` : '');
            } else {
                def = window.AveloraItems.get(id);
                if (def) {
                    const n = this.state ? this.state.inventory.count(id) : 0;
                    meta = count !== undefined ? `Количество: ${count}` : `В сумке: ${n}`;
                    if (!def.use) meta += ' · материал';
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
            const sl = kind === 'skill' ? '' : this.itemStatsLine(def);
            if (sl) { const sd = document.createElement('div'); sd.className = 'tt-req'; sd.style.color = '#a9d68c'; sd.textContent = sl; this.tooltip.appendChild(sd); }
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

        placeTooltip(el) {
            const t = this.tooltip;
            t.classList.remove('hidden');
            const r = el.getBoundingClientRect();
            const tw = t.offsetWidth, th = t.offsetHeight;
            let x = r.left + r.width / 2 - tw / 2;
            x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
            let y = r.top - th - 8;
            if (y < 6) y = r.bottom + 8;
            if (y + th > window.innerHeight - 6) y = Math.max(6, window.innerHeight - th - 6);
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
            const m = document.createElement('div');
            m.className = 'tt-meta';
            m.textContent = `Количество: ${src.count} · ${def.use ? (def.use.type === 'equip' ? 'снаряжение' : 'действие') : 'материал'}`;

            this.tooltip.append(header, d, m);
            const sl = this.itemStatsLine(def);
            if (sl) { const sd = document.createElement('div'); sd.className = 'tt-req'; sd.style.color = '#a9d68c'; sd.textContent = sl; this.tooltip.appendChild(sd); }
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
            document.body.appendChild(el);
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
        // Per-frame (game time): cooldown sweeps + floating texts
        // -----------------------------------------------------------
        update(delta) {
            this.updateFloats(delta);
            this.updateAutoPotion(delta);
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
            return null;
        }

        showSourceTooltip(src) {
            if (src.kind === 'inv' || src.kind === 'chest') this.showTooltipFor(src.el, 'item', src.item, src.count);
            else if (src.kind === 'skill') this.showTooltipFor(src.el, 'skill', src.id);
            else if (src.kind === 'slot' && src.entry) this.showTooltipFor(src.el, src.entry.type === 'skill' ? 'skill' : 'item', src.entry.id);
        }

        sourceIconDef(src) {
            if (src.kind === 'inv' || src.kind === 'chest') return window.AveloraItems.get(src.item);
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
            this.drag = {
                src,
                x: e.clientX,
                y: e.clientY,
                pointerId: e.pointerId,
                pointerType: e.pointerType,
                active: false,
                over: null,
                shiftKey: !!e.shiftKey,
                ctrlKey: !!e.ctrlKey,
                captureEl: e.target
            };
            e.preventDefault();
            try {
                if (e.target && e.target.setPointerCapture) {
                    e.target.setPointerCapture(e.pointerId);
                }
            } catch (_) {}
        }

        onPointerMove(e) {
            const d = this.drag;
            if (!d || e.pointerId !== d.pointerId) return;
            if (!d.active) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
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
                    // Tap on a skill in the skills panel: assign to first empty hotbar slot
                    if (this.state) {
                        const hb = this.state.hotbar;
                        const existingIdx = hb.findIndex(e => e && e.type === 'skill' && e.id === d.src.id);
                        if (existingIdx >= 0) {
                            this.showMessageAt(d.src.el, `Навык уже на панели (слот ${existingIdx + 1})`);
                        } else {
                            // Find first empty slot among active combat slots
                            let targetSlot = hb.findIndex((e, idx) => idx < 6 && !e);
                            if (targetSlot < 0) targetSlot = hb.findIndex(e => !e);
                            if (targetSlot >= 0) {
                                this.state.setHotbar(targetSlot, { type: 'skill', id: d.src.id });
                                const skillDef = this.game.skills ? this.game.skills.get(d.src.id) : null;
                                const lab = (this.game.skills && skillDef) ? this.game.skills.labelOf(skillDef) : { name: d.src.id };
                                this.floatText(`${lab.name} добавлен в слот ${targetSlot + 1}`, 'good');
                            } else {
                                this.showMessageAt(d.src.el, 'Боевая панель заполнена (перетащите для замены)');
                            }
                        }
                    }
                    this.showSourceTooltip(d.src);
                    clearTimeout(this.tooltipTimer);
                    this.tooltipTimer = setTimeout(() => this.hideTooltip(), 2000);
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
                return window.AveloraItems.isEquippable(src.item) && this.dollSlotOf(src.item) === tgt.slot;
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
                if (src.kind === 'inv' && window.AveloraItems.isEquippable(src.item) && this.dollSlotOf(src.item) === tgt.slot) this.equip(src.item);
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
            const sel = window.AVELORA_UI_SELECTOR || '#skill-bar, #inventory-panel, #chest-panel, #dialog-panel, #skills-panel, #quantity-modal, #item-tooltip';
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
