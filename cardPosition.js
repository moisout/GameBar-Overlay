import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

const POSITIONS_KEY = 'addon-positions';

// Default layout from the design (design/gnome-game-overlay-handoff.md): columns of cards, centred on the monitor.
// The second column is kept free for the capture and gallery cards of the design.
const COLUMN_WIDTHS = [400, 520, 400, 400];
const COLUMN_GAP = 40;
const LAYOUT_TOP = 84;
const DEFAULT_COLUMNS = {
    'sound': 0,
    'clock': 2,
    'system-monitor': 3,
};

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

const getLayoutWidth = (columns) => {
    return columns.reduce((width, column) => width + COLUMN_WIDTHS[column], 0) + COLUMN_GAP * (columns.length - 1);
};

const getDefaultPosition = (primaryMonitor, id) => {
    let columns = COLUMN_WIDTHS.map((width, column) => column);
    // On narrow monitors the free columns make room for the cards.
    if (getLayoutWidth(columns) + 2 * COLUMN_GAP > primaryMonitor.width) {
        columns = columns.filter(column => Object.values(DEFAULT_COLUMNS).includes(column));
    }

    const column = DEFAULT_COLUMNS[id];
    const columnsBefore = columns.filter(other => other < column);
    let x = (primaryMonitor.width - getLayoutWidth(columns)) / 2;
    if (columnsBefore.length > 0) {
        x += getLayoutWidth(columnsBefore) + COLUMN_GAP;
    }
    return [x, LAYOUT_TOP];
};

// Place an addon at its dragged position if it has one, or at its place in the default layout otherwise.
const positionAddon = (primaryMonitor, element, id) => {
    if (!primaryMonitor || !element || element._dragging) return;

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

export { set_position_settings, saveCustomPosition, positionAddon, makeDraggable };
