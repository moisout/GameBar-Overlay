import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isCardHidden, isCardPinned } from './cardPosition.js';
import { getMonitorKey } from './utils.js';

// A layer over the windows of a monitor that is never picked, with all its children. The pointer goes to the window
// below it, a game keeps its clicks and its pointer lock.
const PinLayer = GObject.registerClass(
class PinLayer extends St.Widget {
    vfunc_pick() {}
});

// A fullscreen window that bypasses the compositor would cover the pinned cards. GNOME 48 moved the call.
const setUnredirect = (enabled) => {
    if (global.compositor?.disable_unredirect) {
        enabled ? global.compositor.enable_unredirect() : global.compositor.disable_unredirect();
    } else {
        enabled ? Meta.enable_unredirect_for_display(global.display) : Meta.disable_unredirect_for_display(global.display);
    }
};

// The pinned cards of every monitor, shown while the overlay is not on that monitor. Every pinned card is built a
// second time, by createPinned of its card, and updates itself while its layer is shown.
export class PinnedCards {
    // cards: [{ id, createPinned(layer, monitor, pinKey) }]. overlay: the actor of the overlay.
    constructor(cards, overlay) {
        this._cards = cards;
        this._overlay = overlay;
        // { layer, index, addons } of every monitor with a pinned card.
        this._layers = [];
        this._overlayMonitorIndex = -1;
        this._hidingCount = 0;
        this._unredirectDisabled = false;

        this._overlay.connectObject('notify::visible', () => this._syncVisibility(), this);
        Main.screenshotUI.connectObject('notify::screencast-in-progress', () => this._syncVisibility(), this);
    }

    // The monitor the overlay is on, its pinned cards are in the overlay while it is shown.
    set overlayMonitorIndex(index) {
        this._overlayMonitorIndex = index;
        this._syncVisibility();
    }

    rebuild() {
        this._destroyLayers();

        for (const monitor of Main.layoutManager.monitors) {
            const key = getMonitorKey(monitor.index);
            const cards = this._cards.filter(({ id }) => isCardPinned(id, key) && !isCardHidden(id, key));
            if (cards.length === 0) continue;

            const layer = new PinLayer({ style_class: 'gamebar-pin-layer', visible: false });
            layer.set_position(monitor.x, monitor.y);
            layer.set_size(monitor.width, monitor.height);
            // Above the windows, below the top bar, the overview, notifications and the overlay.
            Main.layoutManager.uiGroup.insert_child_above(layer, global.window_group);

            const entry = { layer, index: monitor.index, addons: [] };
            this._layers.push(entry);
            entry.addons = cards.map(card => card.createPinned(layer, monitor, key));
        }
        this._syncVisibility();
    }

    reposition() {
        this._layers.forEach(({ addons }) => addons.forEach(addon => addon.set_addon_position()));
    }

    // Hides the pinned cards until run() is done, so they are not in a screenshot.
    async hideWhile(run) {
        this._hidingCount++;
        this._syncVisibility();
        try {
            return await run();
        } finally {
            this._hidingCount--;
            this._syncVisibility();
        }
    }

    _syncVisibility() {
        const capturing = this._hidingCount > 0 || Main.screenshotUI.screencast_in_progress;
        this._layers.forEach(({ layer, index }) => {
            layer.visible = !capturing && !(this._overlay.visible && index === this._overlayMonitorIndex);
        });

        const shown = this._layers.some(({ layer }) => layer.visible);
        if (shown !== this._unredirectDisabled) {
            this._unredirectDisabled = shown;
            setUnredirect(!shown);
        }
    }

    _destroyLayers() {
        this._layers.forEach(({ layer, addons }) => {
            addons.forEach(addon => addon.destroy());
            layer.destroy();
        });
        this._layers = [];
    }

    destroy() {
        this._overlay.disconnectObject(this);
        Main.screenshotUI.disconnectObject(this);
        this._destroyLayers();
        if (this._unredirectDisabled) {
            this._unredirectDisabled = false;
            setUnredirect(true);
        }
    }
}
