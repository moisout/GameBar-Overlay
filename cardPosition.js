import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Both per monitor, by its connector.
const POSITIONS_KEY = 'monitor-card-positions';
// Cards closed with their close button or the dash stay closed until they are shown from the dash again.
const HIDDEN_KEY = 'monitor-hidden-cards';
// Cards that stay on the monitor while the overlay is closed.
const PINNED_KEY = 'monitor-pinned-cards';

// Default layout from the design (design/gnome-game-overlay-handoff.md): columns of stacked cards, centred on the monitor.
// A monitor too narrow for a layout gets the next one, the first one fits 1920px.
const LAYOUTS = [
    [['sound', 'battery'], ['capture', 'gallery'], ['clock', 'music', 'discord'], ['system-monitor']],
    [['sound', 'battery', 'music', 'discord'], ['clock', 'capture', 'gallery'], ['system-monitor']],
    [['sound', 'battery', 'music', 'discord'], ['clock', 'capture', 'gallery', 'system-monitor']],
];
// Width of the cards in the design, a column is as wide as its widest card.
const CARD_WIDTHS = {
    'sound': 440,
    'battery': 440,
    'capture': 520,
    'gallery': 520,
};
const DEFAULT_CARD_WIDTH = 400;
const COLUMN_GAP = 32;
const CARD_GAP = 24;
const LAYOUT_TOP = 84;

// The sizes above are in pixels of the stylesheet, which the shell multiplies by its scale factor.
const getScaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// The cards of the overlay placed so far, the cards below a card in its column follow its height.
const cardElements = new Map();
// The pin buttons of the cards of the overlay and their card.
const pinButtons = new Map();

let position_settings = null;
// The monitor the overlay is on, the positions and closed cards are the ones of this monitor.
let monitorKey = null;

const set_position_settings = (settings) => {
    position_settings = settings;
};

const setCardMonitor = (key) => {
    monitorKey = key;
    syncPinButtons();
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const getCustomPositions = (key = monitorKey) => {
    return position_settings?.get_value(POSITIONS_KEY).deepUnpack()[key] ?? {};
};

// Pass a null position to go back to the preset position of the addon.
const saveCustomPosition = (id, position) => {
    if (!position_settings) return;

    const monitors = position_settings.get_value(POSITIONS_KEY).deepUnpack();
    const positions = monitors[monitorKey] ?? {};
    if (position) {
        positions[id] = position;
    } else if (id in positions) {
        delete positions[id];
    } else {
        return;
    }
    monitors[monitorKey] = positions;
    position_settings.set_value(POSITIONS_KEY, new GLib.Variant('a{sa{s(dd)}}', monitors));
};

const getColumnWidth = (column) => Math.max(...column.map(id => CARD_WIDTHS[id] ?? DEFAULT_CARD_WIDTH)) * getScaleFactor();

const getLayoutWidth = (layout) => {
    return layout.reduce((width, column) => width + getColumnWidth(column), 0) + COLUMN_GAP * getScaleFactor() * (layout.length - 1);
};

const getLayout = (monitor) => {
    const margin = COLUMN_GAP * getScaleFactor();
    return LAYOUTS.find(layout => getLayoutWidth(layout) + 2 * margin <= monitor.width) ?? LAYOUTS[LAYOUTS.length - 1];
};

const getDefaultPosition = (monitor, id, key) => {
    const scaleFactor = getScaleFactor();
    const layout = getLayout(monitor);
    const columnIndex = layout.findIndex(column => column.includes(id));
    if (columnIndex === -1) return [COLUMN_GAP * scaleFactor, LAYOUT_TOP * scaleFactor];

    let x = (monitor.width - getLayoutWidth(layout)) / 2;
    for (const column of layout.slice(0, columnIndex)) {
        x += getColumnWidth(column) + COLUMN_GAP * scaleFactor;
    }

    let y = LAYOUT_TOP * scaleFactor;
    const customPositions = getCustomPositions(key);
    for (const other of layout[columnIndex]) {
        if (other === id) break;

        // Closed, dragged away and missing cards leave no gap. A pinned card is where its card is in the overlay, the
        // closed cards of another monitor than the one of the overlay are only in the setting.
        const element = cardElements.get(other);
        const shown = key === monitorKey ? element?.visible : element && !isCardHidden(other, key);
        if (!shown || customPositions[other]) continue;
        y += element.get_preferred_size()[3] + CARD_GAP * scaleFactor;
    }
    return [x, y];
};

// Whether a card was dragged on the monitor of the overlay.
const hasCustomPositions = () => Object.keys(getCustomPositions()).length > 0;

// Every card of the monitor of the overlay back to its place in the default layout.
const resetCustomPositions = () => {
    if (!position_settings || !hasCustomPositions()) return;

    const monitors = position_settings.get_value(POSITIONS_KEY).deepUnpack();
    delete monitors[monitorKey];
    position_settings.set_value(POSITIONS_KEY, new GLib.Variant('a{sa{s(dd)}}', monitors));
};

const getHiddenCards = () => {
    return position_settings?.get_value(HIDDEN_KEY).deepUnpack() ?? {};
};

const isCardHidden = (id, key = monitorKey) => {
    return getHiddenCards()[key]?.includes(id) ?? false;
};

const setCardHidden = (id, hidden) => {
    if (!position_settings || isCardHidden(id) === hidden) return;

    const monitors = getHiddenCards();
    const hiddenCards = (monitors[monitorKey] ?? []).filter(other => other !== id);
    if (hidden) {
        hiddenCards.push(id);
    }
    monitors[monitorKey] = hiddenCards;
    position_settings.set_value(HIDDEN_KEY, new GLib.Variant('a{sas}', monitors));
};

// The pinned cards by monitor.
const getPinnedCards = () => {
    return position_settings?.get_value(PINNED_KEY).deepUnpack() ?? {};
};

const isCardPinned = (id, key = monitorKey) => {
    return getPinnedCards()[key]?.includes(id) ?? false;
};

const setCardPinned = (id, pinned) => {
    if (!position_settings || isCardPinned(id) === pinned) return;

    const monitors = getPinnedCards();
    const pinnedCards = (monitors[monitorKey] ?? []).filter(other => other !== id);
    if (pinned) {
        pinnedCards.push(id);
    }
    monitors[monitorKey] = pinnedCards;
    position_settings.set_value(PINNED_KEY, new GLib.Variant('a{sas}', monitors));
};

// The pin buttons show whether their card is pinned on the monitor of the overlay.
const trackPinButton = (id, button) => {
    pinButtons.set(button, id);
    button.connect('destroy', () => pinButtons.delete(button));
    button.checked = isCardPinned(id);
};

const syncPinButtons = () => {
    pinButtons.forEach((id, button) => {
        button.checked = isCardPinned(id);
    });
};

// The card in the container of an addon, the pinned Discord card is not one.
const findCard = (element) => element?.get_children().find(child => child.has_style_class_name('gamebar-card')) ?? null;

// How far below the top of a card its content starts: below the header bar, at the tab bar or the padding of the body.
const getContentTop = (card) => {
    let top = 0;
    for (const child of card.get_children()) {
        if (!child.visible) continue;
        if (child.has_style_class_name('gamebar-card-body')) return top + child.get_theme_node().get_padding(St.Side.TOP);
        if (!child.has_style_class_name('gamebar-card-header')) return top;
        top += child.get_preferred_height(-1)[1];
    }
    return top;
};

// A pinned card has no header bar, it is lower than its card in the overlay by as much. Their content is in the same
// place and they end at the same bottom, so the card of the overlay fades in and out over it without a jump.
const getPinOffset = (id, element) => {
    const card = findCard(cardElements.get(id));
    const pinnedCard = findCard(element);
    if (!card || !pinnedCard) return 0;
    return getContentTop(card) - getContentTop(pinnedCard);
};

// offset moves a pinned card down from the place of its card.
const placeCard = (monitor, element, id, key = monitorKey, offset = 0) => {
    if (element._dragging) return;

    const [, , width, height] = element.get_preferred_size();
    const custom = getCustomPositions(key)[id];
    let x, y;
    if (custom) {
        // Positions are saved as fractions of the monitor size, so they survive a resolution change.
        x = custom[0] * monitor.width;
        y = custom[1] * monitor.height;
    } else {
        [x, y] = getDefaultPosition(monitor, id, key);
    }
    y += offset;

    element.set_position(
        clamp(Math.round(x), 1, monitor.width - width), // x >= 1, an actor at 0,0 is shown in the centre of the screen.
        clamp(Math.round(y), 0, monitor.height - height)
    );
};

const trackElement = (elements, id, element) => {
    if (elements.get(id) === element) return;

    elements.set(id, element);
    element.connect('destroy', () => {
        if (elements.get(id) === element) elements.delete(id);
    });
};

// Place an addon at its dragged position if it has one, or at its place in the default layout otherwise.
// The cards below it in its column move along, they depend on its height.
// pinKey is the monitor of a pinned card, which is placed where its card is in the overlay on that monitor, with its
// content where the content of that card is.
const positionAddon = (monitor, element, id, pinKey = null) => {
    if (!monitor || !element) return;

    if (pinKey !== null) {
        placeCard(monitor, element, id, pinKey, getPinOffset(id, element));
        return;
    }

    trackElement(cardElements, id, element);
    placeCard(monitor, element, id);

    const column = getLayout(monitor).find(other => other.includes(id)) ?? [];
    for (const below of column.slice(column.indexOf(id) + 1)) {
        const belowElement = cardElements.get(below);
        if (belowElement) placeCard(monitor, belowElement, below);
    }
};

// Calls reposition() once the size of a card changed, when the layout is done. The idle is removed with the card.
const followCardSize = (element, reposition) => {
    let idleId = 0;
    const queue = () => {
        if (idleId) return;
        idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            idleId = 0;
            reposition();
            return GLib.SOURCE_REMOVE;
        });
    };

    element.connect('notify::width', queue);
    element.connect('notify::height', queue);
    element.connect('destroy', () => {
        if (idleId) {
            GLib.Source.remove(idleId);
            idleId = 0;
        }
    });
};

// Let the user move an addon around the overlay by dragging any non-interactive part of it.
const makeDraggable = (element, id) => {
    let grab = null;
    let offset = null;
    let moved = false;

    const endDrag = () => {
        grab?.dismiss();
        grab = null;
        element._dragging = false;
    };

    element.reactive = true;

    element.connect('button-press-event', (actor, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
            return Clutter.EVENT_STOP;
        }

        // Buttons and sliders inside the card do not stop the press, and a grab would cancel their click.
        for (let target = global.stage.get_event_actor(event); target && target !== element; target = target.get_parent()) {
            if (target.reactive) {
                return Clutter.EVENT_PROPAGATE;
            }
        }

        const [x, y] = event.get_coords();
        offset = [x - element.x, y - element.y];
        moved = false;
        element._dragging = true;
        // Without a grab a fast pointer leaves the card and the drag stalls.
        grab = global.stage.grab(element);
        return Clutter.EVENT_STOP;
    });

    element.connect('motion-event', (actor, event) => {
        if (!grab) {
            return Clutter.EVENT_PROPAGATE;
        }

        const parent = element.get_parent();
        const [x, y] = event.get_coords();
        element.set_position(
            clamp(x - offset[0], 1, parent.width - element.width),
            clamp(y - offset[1], 0, parent.height - element.height)
        );
        moved = true;
        return Clutter.EVENT_STOP;
    });

    // Always stopped, so a click on a card never counts as a click on the empty area.
    element.connect('button-release-event', () => {
        if (grab) {
            const parent = element.get_parent();
            endDrag();
            if (moved) {
                saveCustomPosition(id, [element.x / parent.width, element.y / parent.height]);
            }
        }
        return Clutter.EVENT_STOP;
    });

    element.connect('destroy', endDrag);
};

export { set_position_settings, setCardMonitor, POSITIONS_KEY, HIDDEN_KEY, PINNED_KEY, saveCustomPosition, hasCustomPositions,
    resetCustomPositions, isCardHidden, setCardHidden,
    isCardPinned, setCardPinned, trackPinButton, syncPinButtons, positionAddon, followCardSize, makeDraggable, findCard };
