import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Both per monitor, by its connector.
const POSITIONS_KEY = 'monitor-card-positions';
// Cards closed with their close button or the dash stay closed until they are shown from the dash again.
const HIDDEN_KEY = 'monitor-hidden-cards';

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

// The cards placed so far, the cards below a card in its column follow its height.
const cardElements = new Map();

let position_settings = null;
// The monitor the overlay is on, the positions and closed cards are the ones of this monitor.
let monitorKey = null;

const set_position_settings = (settings) => {
    position_settings = settings;
};

const setCardMonitor = (key) => {
    monitorKey = key;
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const getCustomPositions = () => {
    return position_settings?.get_value(POSITIONS_KEY).deepUnpack()[monitorKey] ?? {};
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

const getDefaultPosition = (monitor, id) => {
    const scaleFactor = getScaleFactor();
    const layout = getLayout(monitor);
    const columnIndex = layout.findIndex(column => column.includes(id));
    if (columnIndex === -1) return [COLUMN_GAP * scaleFactor, LAYOUT_TOP * scaleFactor];

    let x = (monitor.width - getLayoutWidth(layout)) / 2;
    for (const column of layout.slice(0, columnIndex)) {
        x += getColumnWidth(column) + COLUMN_GAP * scaleFactor;
    }

    let y = LAYOUT_TOP * scaleFactor;
    const customPositions = getCustomPositions();
    for (const other of layout[columnIndex]) {
        if (other === id) break;

        // Closed, dragged away and missing cards leave no gap.
        const element = cardElements.get(other);
        if (!element?.visible || customPositions[other]) continue;
        y += element.get_preferred_size()[3] + CARD_GAP * scaleFactor;
    }
    return [x, y];
};

const getHiddenCards = () => {
    return position_settings?.get_value(HIDDEN_KEY).deepUnpack() ?? {};
};

const isCardHidden = (id) => {
    return getHiddenCards()[monitorKey]?.includes(id) ?? false;
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

const placeCard = (monitor, element, id) => {
    if (element._dragging) return;

    const [, , width, height] = element.get_preferred_size();
    const custom = getCustomPositions()[id];
    let x, y;
    if (custom) {
        // Positions are saved as fractions of the monitor size, so they survive a resolution change.
        x = custom[0] * monitor.width;
        y = custom[1] * monitor.height;
    } else {
        [x, y] = getDefaultPosition(monitor, id);
    }

    element.set_position(
        clamp(Math.round(x), 1, monitor.width - width), // x >= 1, an actor at 0,0 is shown in the centre of the screen.
        clamp(Math.round(y), 0, monitor.height - height)
    );
};

// Place an addon at its dragged position if it has one, or at its place in the default layout otherwise.
// The cards below it in its column move along, they depend on its height.
const positionAddon = (monitor, element, id) => {
    if (!monitor || !element) return;

    if (cardElements.get(id) !== element) {
        cardElements.set(id, element);
        element.connect('destroy', () => {
            if (cardElements.get(id) === element) cardElements.delete(id);
        });
    }

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

export { set_position_settings, setCardMonitor, POSITIONS_KEY, HIDDEN_KEY, saveCustomPosition, isCardHidden, setCardHidden, positionAddon, followCardSize, makeDraggable };
