import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

const POSITIONS_KEY = 'addon-positions';
// Cards closed with their close button or the dash stay closed until they are shown from the dash again.
const HIDDEN_KEY = 'hidden-cards';

// Default layout from the design (design/gnome-game-overlay-handoff.md): columns of stacked cards, centred on the monitor.
// A monitor too narrow for a layout gets the next one, the first one fits 1920px.
const LAYOUTS = [
    [['sound', 'battery'], ['capture'], ['clock'], ['system-monitor']],
    [['sound', 'battery'], ['clock', 'capture'], ['system-monitor']],
    [['sound', 'battery'], ['clock', 'capture', 'system-monitor']],
];
// Width of the cards in the design, a column is as wide as its widest card.
const CARD_WIDTHS = {
    'capture': 520,
};
const DEFAULT_CARD_WIDTH = 400;
const COLUMN_GAP = 40;
const CARD_GAP = 24;
const LAYOUT_TOP = 84;

// The cards placed so far, the cards below a card in its column follow its height.
const cardElements = new Map();

let position_settings = null;

const set_position_settings = (settings) => {
    position_settings = settings;
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const getCustomPositions = () => {
    return position_settings?.get_value(POSITIONS_KEY).deepUnpack() ?? {};
};

// Pass a null position to go back to the preset position of the addon.
const saveCustomPosition = (id, position) => {
    if (!position_settings) return;

    const positions = getCustomPositions();
    if (position) {
        positions[id] = position;
    } else if (id in positions) {
        delete positions[id];
    } else {
        return;
    }
    position_settings.set_value(POSITIONS_KEY, new GLib.Variant('a{s(dd)}', positions));
};

const getColumnWidth = (column) => Math.max(...column.map(id => CARD_WIDTHS[id] ?? DEFAULT_CARD_WIDTH));

const getLayoutWidth = (layout) => {
    return layout.reduce((width, column) => width + getColumnWidth(column), 0) + COLUMN_GAP * (layout.length - 1);
};

const getLayout = (primaryMonitor) => {
    return LAYOUTS.find(layout => getLayoutWidth(layout) + 2 * COLUMN_GAP <= primaryMonitor.width) ?? LAYOUTS[LAYOUTS.length - 1];
};

const getDefaultPosition = (primaryMonitor, id) => {
    const layout = getLayout(primaryMonitor);
    const columnIndex = layout.findIndex(column => column.includes(id));
    if (columnIndex === -1) return [COLUMN_GAP, LAYOUT_TOP];

    let x = (primaryMonitor.width - getLayoutWidth(layout)) / 2;
    for (const column of layout.slice(0, columnIndex)) {
        x += getColumnWidth(column) + COLUMN_GAP;
    }

    let y = LAYOUT_TOP;
    const customPositions = getCustomPositions();
    for (const other of layout[columnIndex]) {
        if (other === id) break;

        // Closed, dragged away and missing cards leave no gap.
        const element = cardElements.get(other);
        if (!element?.visible || customPositions[other]) continue;
        y += element.get_preferred_size()[3] + CARD_GAP;
    }
    return [x, y];
};

const isCardHidden = (id) => {
    return position_settings?.get_strv(HIDDEN_KEY).includes(id) ?? false;
};

const setCardHidden = (id, hidden) => {
    if (!position_settings || isCardHidden(id) === hidden) return;

    const hiddenCards = position_settings.get_strv(HIDDEN_KEY).filter(other => other !== id);
    if (hidden) {
        hiddenCards.push(id);
    }
    position_settings.set_strv(HIDDEN_KEY, hiddenCards);
};

const placeCard = (primaryMonitor, element, id) => {
    if (element._dragging) return;

    const [, , width, height] = element.get_preferred_size();
    const custom = getCustomPositions()[id];
    let x, y;
    if (custom) {
        // Positions are saved as fractions of the monitor size, so they survive a resolution change.
        x = custom[0] * primaryMonitor.width;
        y = custom[1] * primaryMonitor.height;
    } else {
        [x, y] = getDefaultPosition(primaryMonitor, id);
    }

    element.set_position(
        clamp(Math.round(x), 1, primaryMonitor.width - width), // x >= 1, an actor at 0,0 is shown in the centre of the screen.
        clamp(Math.round(y), 0, primaryMonitor.height - height)
    );
};

// Place an addon at its dragged position if it has one, or at its place in the default layout otherwise.
// The cards below it in its column move along, they depend on its height.
const positionAddon = (primaryMonitor, element, id) => {
    if (!primaryMonitor || !element) return;

    if (cardElements.get(id) !== element) {
        cardElements.set(id, element);
        element.connect('destroy', () => {
            if (cardElements.get(id) === element) cardElements.delete(id);
        });
    }

    placeCard(primaryMonitor, element, id);

    const column = getLayout(primaryMonitor).find(other => other.includes(id)) ?? [];
    for (const below of column.slice(column.indexOf(id) + 1)) {
        const belowElement = cardElements.get(below);
        if (belowElement) placeCard(primaryMonitor, belowElement, below);
    }
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

export { set_position_settings, saveCustomPosition, isCardHidden, setCardHidden, positionAddon, makeDraggable };
