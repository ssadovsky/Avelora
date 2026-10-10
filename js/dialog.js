/**
 * Avelora — NPC dialog, shop and gold (AveloraDialog)
 *
 * Opened by world_objects.js (activate) when the player reaches an NPC prop (prop.json `"npc": "<id>"`,
 * NPC data in content/npcs/<id>/npc.json):
 *   { id, name, title, start, dialog: { <node>: { text, options: [{ text, next | action }] } },
 *     shop: { buy: [{ item, price? }], sell: true } }
 * Option actions: "close", "shop" (opens the buy/sell list). An item's price is its `value`
 * (item.json); selling pays half (min 1).
 * Also awards gold for killed creatures: creature.json `"gold": [min, max]` (window 'game:creatureKilled').
 * Gold itself is a counter in the character state (state.gold), shown under the bag grid.
 */
(function () {
    'use strict';

    const SELL_RATE = 0.5;

    function makeIconEl(def) {
        const el = document.createElement('div');
        el.className = 'dlg-icon';
        if (def && def.iconData) {
            const img = document.createElement('img');
            img.src = def.iconData; img.alt = '';
            el.appendChild(img);
        }
        return el;
    }

    class AveloraDialog {
        constructor(game, ui) {
            this.game = game;
            this.ui = ui;
            this.panel = document.getElementById('dialog-panel');
            this.npc = null;
            this.nodeId = null;
            this.mode = 'talk';      // 'talk' | 'buy' | 'sell'
            if (this.panel) {
                this.portrait = this.panel.querySelector('.dlg-portrait');
                this.nameEl = this.panel.querySelector('.dlg-name');
                this.titleEl = this.panel.querySelector('.dlg-title');
                this.body = this.panel.querySelector('.dlg-body');
                const close = this.panel.querySelector('.dlg-close');
                if (close) close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.close();
                });
            }
            this.goldEl = document.getElementById('gold-amount');
            this.tracker = document.createElement('div');
            this.tracker.id = 'quest-tracker';
            ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup'].forEach(evt => {
                this.tracker.addEventListener(evt, (e) => e.stopPropagation());
            });
            document.body.appendChild(this.tracker);
            window.addEventListener('game:creatureKilled', (e) => this.onKilled(e.detail));
        }

        get state() { return this.game.gameState; }
        isOpen() { return !!this.npc; }
        isShopOpen() { return !!this.npc && this.mode !== 'talk' && !!(this.npc.shop && this.npc.shop.sell); }

        /** Price this NPC pays for one piece of an item (0 = not for sale). */
        sellPriceOf(itemId) {
            const def = window.AveloraItems.get(itemId);
            if (def && def.sellPrice > 0) return Math.floor(def.sellPrice);
            return def && def.value > 0 ? Math.max(1, Math.floor(def.value * SELL_RATE)) : 0;
        }

        /** Sell straight from a bag cell (item card button / drag onto the shop window). */
        sellFromBag(index, all) {
            const st = this.state;
            const c = st && st.inventory.cells[index];
            if (!c) return;
            const price = this.sellPriceOf(c.item);
            if (!price) { this.ui.floatText('Это не продаётся', 'warn'); return; }
            this.sell(c.item, price, all ? c.count : 1);
        }

        // -----------------------------------------------------------
        open(npc) {
            if (!this.panel || !npc) return;
            this.npc = npc;
            this.nodeId = npc.start || 'start';
            this.mode = 'talk';
            if (this.nameEl) this.nameEl.textContent = npc.name || '';
            if (this.titleEl) this.titleEl.textContent = npc.title || '';
            if (this.portrait) {
                this.portrait.innerHTML = '';
                if (npc.iconData) {
                    const img = document.createElement('img');
                    img.src = npc.iconData; img.alt = npc.name || '';
                    this.portrait.appendChild(img);
                }
            }
            this.panel.classList.add('open');
            this.panel.classList.remove('shop-mode');
            this.panel.setAttribute('aria-hidden', 'false');
            this.render();
        }

        close() {
            this.npc = null;
            this.mode = 'talk';
            this.nodeId = null;
            if (this.panel) {
                if (document.activeElement && this.panel.contains(document.activeElement)) {
                    try { document.activeElement.blur(); } catch (_) {}
                }
                this.panel.classList.remove('open', 'shop-mode');
                this.panel.setAttribute('aria-hidden', 'true');
            }
            if (this.game.worldObjects && this.game.worldObjects.openContainer) {
                this.game.worldObjects.openContainer = null;
            }
            if (this.game.setInventoryOpen) {
                this.game.setInventoryOpen(false);
            }
        }

        /** Called on every state change (ui.renderAll): keep gold / shop lists current. */
        refresh() {
            const st = this.state;
            if (this.goldEl) this.goldEl.textContent = String(st ? st.gold : 0);
            this.updateTracker();
            if (this.npc && this.mode !== 'talk') this.render();
        }

        // -----------------------------------------------------------
        render() {
            if (!this.npc || !this.body) return;
            this.body.innerHTML = '';
            if (this.panel) {
                this.panel.classList.toggle('shop-mode', this.mode !== 'talk');
            }
            if (this.mode === 'talk') this.renderTalk();
            else if (this.mode === 'teach') this.renderTeach();
            else this.renderShop();
        }

        // -----------------------------------------------------------
        // Quests (content/quests/<id>/quest.json), offered by npc.quests = [ids]
        // -----------------------------------------------------------
        questDef(id) { return (window.GAME_CONTENT && window.GAME_CONTENT.quests && window.GAME_CONTENT.quests[id]) || null; }
        questProgress(q) {
            const o = q.objective || {}, st = this.state;
            let have = 0;
            if (st && o.type === 'collect') have = st.inventory.count(o.item);
            else if (st && o.type === 'kill') have = st.questKills[q.id] || 0;
            return { have: Math.min(have, o.count || 0), need: o.count || 0, ready: have >= (o.count || 0) };
        }

        /** Short objective line for the tracker: "Папоротник: 3/10", "Радужный барсук: 2/5". */
        questLabel(q, p) {
            const o = q.objective || {};
            const defs = window.GAME_CONTENT || {};
            const name = o.type === 'kill'
                ? (((defs.creatures || {})[o.creature]) || {}).name || o.creature
                : (window.AveloraItems.get(o.item) || {}).name || o.item;
            return `${name}: ${p.have}/${p.need}`;
        }

        questAvailable(q) {
            const st = this.state;
            return !!st && (!q.requires || st.questStatus(q.requires) === 'done');
        }

        /** game:creatureKilled — counts kills for active kill quests; a quest may kill a creature for good. */
        questKilled(detail) {
            const st = this.state, defs = (window.GAME_CONTENT && window.GAME_CONTENT.quests) || {};
            if (!st || !detail) return;
            Object.keys(defs).forEach(id => {
                const q = defs[id], o = q.objective || {};
                if (st.questStatus(id) !== 'active' || o.type !== 'kill' || o.creature !== detail.type) return;
                if (o.creatureId && o.creatureId !== detail.id) return;
                if ((st.questKills[id] || 0) < (o.count || 1)) st.addQuestKill(id);
                if (o.slayForGood && this.game.location) st.slay(this.game.location.id, detail.id);
                this.ui.floatText(this.questLabel(q, this.questProgress(q)), 'info', 0.6);
            });
        }

        updateTracker() {
            if (!this.tracker) return;
            const st = this.state;
            const lines = [];
            let hasReady = false;
            if (st) Object.keys(st.quests || {}).forEach(id => {
                if (st.quests[id] !== 'active') return;
                const q = this.questDef(id);
                if (!q) return;
                const p = this.questProgress(q);
                if (p.ready) hasReady = true;
                lines.push(`<div class="qt-row${p.ready ? ' ready' : ''}"><b>${q.name}</b><span>${p.ready ? 'Вернись к ' + (this.giverName(q) || 'заказчику') : this.questLabel(q, p)}</span></div>`);
            });
            if (lines.length) {
                const iconChar = hasReady ? '?' : '!';
                this.tracker.innerHTML = `<div class="qt-btn-icon${hasReady ? ' ready' : ''}" title="Задания">${iconChar}</div><div class="qt-content"><div class="qt-title"><span>Задания</span><span class="qt-toggle" title="Свернуть задания">▸</span></div><div class="qt-list">${lines.join('')}</div></div>`;
                this.tracker.style.display = 'flex';

                // Click when collapsed expands the tracker
                this.tracker.onclick = (e) => {
                    if (this.tracker.classList.contains('collapsed')) {
                        e.stopPropagation();
                        this.tracker.classList.remove('collapsed');
                    }
                };

                // Click on header / toggle button collapses tracker
                const title = this.tracker.querySelector('.qt-title');
                if (title) {
                    title.onclick = (e) => {
                        e.stopPropagation();
                        this.tracker.classList.add('collapsed');
                    };
                }

                // Click on quest list opens full quests log
                const list = this.tracker.querySelector('.qt-list');
                if (list) {
                    list.onclick = (e) => {
                        e.stopPropagation();
                        const ui = this.ui || (this.game && this.game.ui) || window.AveloraHotbar;
                        if (ui && ui.toggleQuests) {
                            ui.toggleQuests();
                        } else {
                            const qp = document.getElementById('quests-panel');
                            if (qp) {
                                qp.classList.toggle('open');
                                if (ui && ui.updateQuestsProgress) ui.updateQuestsProgress();
                            }
                        }
                    };
                }
            } else {
                this.tracker.innerHTML = '';
                this.tracker.style.display = 'none';
            }
        }

        giverName(q) {
            const n = window.GAME_CONTENT && window.GAME_CONTENT.npcs && window.GAME_CONTENT.npcs[q.giver];
            return n ? n.name : '';
        }

        questNode(id) {
            const q = this.questDef(id), st = this.state;
            if (!q || !st) return { text: '…', options: [{ text: 'Назад', next: 'start' }] };
            const status = st.questStatus(id), d = q.dialog || {};
            if (!status) return { text: d.offer, options: [{ text: d.accept, action: 'questAccept', quest: id }, { text: d.decline || 'Позже', next: 'start' }] };
            const p = this.questProgress(q);
            if (status === 'active' && p.ready) return { text: d.ready || d.progress, options: [{ text: d.turnIn || 'Сдать', action: 'questTurnIn', quest: id }, { text: 'Назад', next: 'start' }] };
            if (status === 'active') return { text: d.progress, options: [{ text: 'Назад', next: 'start' }] };
            return { text: d.done, options: [{ text: 'Назад', next: 'start' }] };
        }

        renderTalk() {
            let node = (this.npc.dialog || {})[this.nodeId];
            if (this.nodeId && this.nodeId.indexOf('quest:') === 0) node = this.questNode(this.nodeId.slice(6));
            else if (node && this.nodeId === (this.npc.start || 'start') && this.npc.quests) {
                // quest entries go first in the start menu
                const extra = [];
                this.npc.quests.forEach(qid => {
                    const q = this.questDef(qid), st = this.state;
                    if (!q || !st || !this.questAvailable(q)) return;
                    const status = st.questStatus(qid);
                    if (status === 'done') return;
                    const p = this.questProgress(q);
                    extra.push({ text: q.name + (status === 'active' ? (p.ready ? ' — сдать' : ` (${p.have}/${p.need})`) : ''), next: 'quest:' + qid, quest: true, ready: p.ready });
                });
                node = Object.assign({}, node, { options: extra.concat(node.options || []) });
            }
            const text = document.createElement('div');
            text.className = 'dlg-text';
            text.textContent = node ? node.text : '…';
            this.body.appendChild(text);
            const opts = document.createElement('div');
            opts.className = 'dlg-options';
            ((node && node.options) || [{ text: 'До встречи', action: 'close' }]).forEach(o => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dlg-opt' + (o.action === 'shop' ? ' shop' : '') + (o.quest ? ' quest' : '');
                b.textContent = (o.action === 'shop' ? '[Торговля] ' : o.action === 'teach' ? '[Обучение] ' : o.quest ? '[Задание] ' : '') + o.text;
                b.addEventListener('click', (e) => { e.stopPropagation(); this.choose(o); });
                opts.appendChild(b);
            });
            this.body.appendChild(opts);
        }

        choose(o) {
            if (o.action === 'close') {
                this.close();
            } else if (o.action === 'questAccept') {
                if (this.state.startQuest(o.quest)) this.ui.floatText('Новое задание', 'good');
                this.nodeId = this.npc.start || 'start';
                this.render();
            } else if (o.action === 'questTurnIn') {
                const q = this.questDef(o.quest), st = this.state;
                if (q && st && st.questStatus(o.quest) === 'active' && this.questProgress(q).ready) {
                    if (q.objective.type === 'collect') st.inventory.remove(q.objective.item, q.objective.count);
                    if (q.reward && q.reward.gold) st.addGold(q.reward.gold);
                    if (q.reward && q.reward.xp && this.game.hero) this.game.hero.addXp(q.reward.xp);
                    this.giveClassRewards(q);
                    st.completeQuest(o.quest);
                    this.ui.floatText('Задание выполнено' + (q.reward && q.reward.gold ? ` · +${q.reward.gold} зол.` : ''), 'good');
                }
                this.nodeId = this.npc.start || 'start';
                this.render();
            } else if (o.action === 'teach') {
                this.mode = 'teach';
                this.render();
            } else if (o.action === 'shop') {
                this.mode = 'buy';
                this.game.setInventoryOpen(true);
                this.render();
            } else if (o.next) {
                this.nodeId = o.next;
                this.render();
            }
        }

        /** reward.classItems = { <characterId>: [{item, count}] } — e.g. the first weapon (staff for the mage, bow for the archer). */
        giveClassRewards(q) {
            const ci = q.reward && q.reward.classItems;
            const cfg = this.game.currentCharacterConfig, st = this.state;
            const list = ci && cfg && ci[cfg.id];
            if (!list || !st || !st.inventory) return;
            const defs = window.AveloraItems;
            list.forEach(r => {
                const added = st.inventory.add(r.item, r.count || 1);
                const def = defs ? defs.get(r.item) : null;
                const name = def ? def.name : r.item;
                if (added > 0) this.ui.floatText(`Получено: ${name}`, 'loot', 0.4);
                if (added < (r.count || 1) && this.game.worldObjects && this.game.character) {
                    const c = this.game.character;
                    this.game.worldObjects.addDrop(r.item, (r.count || 1) - added, c.position.x, c.position.z);
                    this.ui.floatText('Сумка полна — награда брошена на землю', 'warn', 0.8);
                }
            });
        }

        // -----------------------------------------------------------
        // Shop
        // -----------------------------------------------------------
        // -----------------------------------------------------------
        // Teaching: the skills of the current character that it has not learned yet
        // -----------------------------------------------------------
        renderTeach() {
            const st = this.state;
            const cfg = this.game.currentCharacterConfig;
            const basePrice = (this.npc.teach && this.npc.teach.price !== undefined) ? this.npc.teach.price : 1;
            const tabs = document.createElement('div');
            tabs.className = 'dlg-tabs';
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'dlg-tab back';
            back.textContent = '← Назад';
            back.addEventListener('click', (e) => {
                e.stopPropagation();
                this.mode = 'talk';
                this.nodeId = this.npc.start || 'start';
                this.render();
            });
            const gold = document.createElement('div');
            gold.className = 'dlg-gold';
            gold.innerHTML = '<span class="coin"></span> ' + (st ? st.gold : 0);
            tabs.append(back, gold);
            this.body.appendChild(tabs);

            const list = document.createElement('div');
            list.className = 'dlg-list';
            const heroLevel = this.game.hero ? this.game.hero.level : 1;
            const lvlOf = (sid) => { const d = this.game.skills && this.game.skills.get(sid); return (d && d.requiresLevel) || 1; };
            const ids = ((window.AveloraState && cfg) ? window.AveloraState.skillCatalog(cfg.id) : []).slice()
                .sort((a, b) => lvlOf(a) - lvlOf(b));
            ids.forEach(id => {
                const def = this.game.skills ? this.game.skills.get(id) : null;
                if (!def) return;
                const known = !!st && st.knowsSkill(id);
                if (known) return; // learned skills disappear from the teach list
                const need = def.requiresLevel || 1;
                const locked = heroLevel < need;
                const price = (def.price !== undefined) ? def.price : basePrice;
                const row = document.createElement('div');
                row.className = 'dlg-row' + (locked ? ' locked' : '');
                row.appendChild(makeIconEl(def));
                const n = document.createElement('div');
                n.className = 'dlg-row-name';
                n.innerHTML = '';
                const t = document.createElement('div'); t.textContent = def.name;
                const d = document.createElement('div'); d.className = 'dlg-row-desc'; d.textContent = def.description || '';
                n.append(t, d);
                row.appendChild(n);
                if (known) {
                    const k = document.createElement('div');
                    k.className = 'dlg-row-price';
                    k.textContent = 'Изучено';
                    row.appendChild(k);
                } else {
                    const p = document.createElement('div');
                    p.className = 'dlg-row-price';
                    p.innerHTML = locked ? `<span class="dlg-lvl">с ${need}-го ур.</span>` : `<span class="coin"></span> ${price}`;
                    const b = document.createElement('button');
                    b.type = 'button';
                    const canBuy = !locked && st && st.gold >= price;
                    b.className = 'dlg-buy' + (canBuy ? '' : ' disabled');
                    b.textContent = locked ? 'Закрыто' : 'Изучить';
                    b.disabled = !canBuy;
                    if (locked) b.title = `Нужен ${need}-й уровень (у вас ${heroLevel}-й)`;
                    b.addEventListener('click', (e) => { e.stopPropagation(); this.learn(id, price); });
                    row.append(p, b);
                }
                list.appendChild(row);
            });
            if (!list.children.length) {
                const e = document.createElement('div');
                e.className = 'dlg-empty';
                e.textContent = 'Ты уже знаешь всё, чему я могу тебя научить.';
                list.appendChild(e);
            }
            this.body.appendChild(list);
        }

        learn(skillId, price) {
            const st = this.state;
            if (!st || st.knowsSkill(skillId)) return;
            const sdef = this.game.skills ? this.game.skills.get(skillId) : null;
            const need = (sdef && sdef.requiresLevel) || 1;
            if (this.game.hero && this.game.hero.level < need) { this.ui.floatText(`Нужен ${need}-й уровень`, 'warn'); return; }
            if (!st.spendGold(price)) { this.ui.floatText('Не хватает золота', 'warn'); return; }
            st.learnSkill(skillId);
            const def = this.game.skills ? this.game.skills.get(skillId) : null;
            this.ui.floatText(`Изучено: ${def ? def.name : skillId}`, 'loot');
        }

        renderShop() {
            const st = this.state;
            const shop = this.npc.shop || {};
            const tabs = document.createElement('div');
            tabs.className = 'dlg-tabs';
            [['buy', 'Купить'], ['sell', 'Продать']].forEach(([m, label]) => {
                if (m === 'sell' && !shop.sell) return;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dlg-tab' + (this.mode === m ? ' active' : '');
                b.textContent = label;
                b.addEventListener('click', (e) => { e.stopPropagation(); this.mode = m; this.render(); });
                tabs.appendChild(b);
            });
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'dlg-tab back';
            back.textContent = '← Назад';
            back.addEventListener('click', (e) => {
                e.stopPropagation();
                this.mode = 'talk';
                this.nodeId = this.npc.start || 'start';
                if (this.game.setInventoryOpen) this.game.setInventoryOpen(false);
                this.render();
            });
            tabs.appendChild(back);
            const gold = document.createElement('div');
            gold.className = 'dlg-gold';
            gold.innerHTML = '<span class="coin"></span> ' + (st ? st.gold : 0);
            tabs.appendChild(gold);
            this.body.appendChild(tabs);

            const list = document.createElement('div');
            list.className = 'dlg-list';
            if (this.mode === 'buy') {
                (shop.buy || []).forEach(g => {
                    const def = window.AveloraItems.get(g.item);
                    if (!def) return;
                    const price = g.price !== undefined ? g.price : (def.value || 1);
                    this.addRow(list, def, def.name, `${price}`, 'Купить', !!st && st.gold >= price, () => this.buy(def.id, price));
                });
            } else {
                const seen = new Set();
                const inv = st ? st.inventory : null;
                (inv ? inv.cells : []).forEach(c => {
                    if (!c || seen.has(c.item)) return;
                    seen.add(c.item);
                    const def = window.AveloraItems.get(c.item);
                    if (!def || !(def.value > 0)) return;
                    const price = this.sellPriceOf(c.item);
                    const have = inv.count(c.item);
                    this.addRow(list, def, `${def.name} ×${have}`, `${price}`, 'Продать', true, () => this.sell(c.item, price, 1),
                        have > 1 ? { label: 'Все', fn: () => this.sell(c.item, price, have) } : null);
                });
                if (!list.children.length) {
                    const e = document.createElement('div');
                    e.className = 'dlg-empty';
                    e.textContent = 'Нечего продать';
                    list.appendChild(e);
                }
            }
            this.body.appendChild(list);
        }

        addRow(list, def, label, price, btnLabel, enabled, fn, extra) {
            const row = document.createElement('div');
            row.className = 'dlg-row';
            row.appendChild(makeIconEl(def));
            const n = document.createElement('div');
            n.className = 'dlg-row-name';
            n.textContent = label;
            const p = document.createElement('div');
            p.className = 'dlg-row-price';
            p.innerHTML = `<span class="coin"></span> ${price}`;
            row.append(n, p);
            const mk = (txt, f, en) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dlg-buy' + (en ? '' : ' disabled');
                b.textContent = txt;
                b.disabled = !en;
                b.addEventListener('click', (e) => { e.stopPropagation(); f(); });
                return b;
            };
            row.appendChild(mk(btnLabel, fn, enabled));
            if (extra) row.appendChild(mk(extra.label, extra.fn, true));
            list.appendChild(row);
        }

        buy(itemId, price) {
            const st = this.state;
            if (!st) return;
            if (st.inventory.spaceFor(itemId) < 1) { this.ui.floatText('В сумке нет места', 'warn'); return; }
            if (!st.spendGold(price)) { this.ui.floatText('Не хватает золота', 'warn'); return; }
            st.inventory.add(itemId, 1);
            const def = window.AveloraItems.get(itemId);
            this.ui.floatText(`Куплено: ${def ? def.name : itemId}`, 'loot');
        }

        sell(itemId, price, count) {
            const st = this.state;
            if (!st) return;
            const n = st.inventory.remove(itemId, count);
            if (n <= 0) return;
            st.addGold(n * price);
            this.ui.floatText(`+${n * price} золота`, 'gain');
        }

        // -----------------------------------------------------------
        // Gold from kills
        // -----------------------------------------------------------
        onKilled(detail) {
            const st = this.state;
            if (!st || !detail) return;
            this.questKilled(detail);
            const defs = (window.GAME_CONTENT && window.GAME_CONTENT.creatures) || {};
            const def = defs[detail.type];
            if (!def || !Array.isArray(def.gold)) return;
            const lo = Math.max(0, Math.floor(def.gold[0] || 0)), hi = Math.max(lo, Math.floor(def.gold[1] || lo));
            const n = lo + Math.floor(Math.random() * (hi - lo + 1));
            if (n <= 0) return;
            st.addGold(n);
            this.ui.floatText(`+${n} золота`, 'gain', 0.3);
        }
    }

    window.AveloraDialog = AveloraDialog;
})();
