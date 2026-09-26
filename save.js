/**
 * Avelora — Per-character local save system
 *
 * One localStorage entry per character (CHARACTER_CATALOG.id), so each of
 * the 3 playable characters keeps their own independent progress.
 *
 * A save is only ever trusted after `isValidSave()` passes: right schema
 * version, known character id, a location id that still exists in
 * window.LOCATIONS, and finite coordinates. Anything else (corrupted JSON,
 * an old schema from before a breaking change, a location that got renamed
 * or removed) is treated as "no save" rather than crashing or spawning the
 * player somewhere broken — see CLAUDE.md "не глючит" requirement.
 *
 * Bump SAVE_VERSION whenever the save shape changes incompatibly; old saves
 * then fail validation cleanly instead of being partially trusted.
 */
(function () {
    'use strict';

    const SAVE_VERSION = 1;
    const KEY_PREFIX = 'avelora_save_';

    function keyFor(characterId) {
        return KEY_PREFIX + characterId;
    }

    function isValidSave(data, characterId) {
        if (!data || typeof data !== 'object') return false;
        if (data.version !== SAVE_VERSION) return false;
        if (data.characterId !== characterId) return false;
        if (typeof data.locationId !== 'string' || !window.LOCATIONS || !window.LOCATIONS[data.locationId]) return false;
        if (!Number.isFinite(data.x) || !Number.isFinite(data.z) || !Number.isFinite(data.r)) return false;
        return true;
    }

    function loadSave(characterId) {
        let raw;
        try {
            raw = window.localStorage.getItem(keyFor(characterId));
        } catch (e) {
            console.warn('[Avelora] localStorage unavailable, saves disabled', e);
            return null;
        }
        if (!raw) return null;
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.warn('[Avelora] save for "' + characterId + '" is corrupt JSON, ignoring');
            return null;
        }
        if (!isValidSave(data, characterId)) {
            console.warn('[Avelora] save for "' + characterId + '" failed validation, ignoring');
            return null;
        }
        return data;
    }

    function writeSave(characterId, progress) {
        const data = {
            version: SAVE_VERSION,
            characterId: characterId,
            locationId: progress.locationId,
            x: progress.x,
            z: progress.z,
            r: progress.r,
            savedAt: Date.now()
        };
        try {
            window.localStorage.setItem(keyFor(characterId), JSON.stringify(data));
        } catch (e) {
            console.warn('[Avelora] could not write save for "' + characterId + '"', e);
        }
    }

    /**
     * "Начать заново": removes the position save AND the separate per-character
     * game state (inventory/hotbar/pickups — game_state.js, `avelora_state_<id>`).
     * The key is spelled out here too so it's cleared even if game_state.js
     * failed to load.
     */
    function deleteSave(characterId) {
        try {
            window.localStorage.removeItem(keyFor(characterId));
            window.localStorage.removeItem('avelora_state_' + characterId);
        } catch (e) { /* ignore */ }
    }

    /** { character, save } for every catalog entry that has a VALID save. */
    function listValidSaves() {
        const catalog = window.CHARACTER_CATALOG || [];
        const out = [];
        catalog.forEach(character => {
            const save = loadSave(character.id);
            if (save) out.push({ character, save });
        });
        return out;
    }

    window.AveloraSave = { SAVE_VERSION, loadSave, writeSave, deleteSave, listValidSaves };
})();
