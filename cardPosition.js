import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { getPositionStyle } from './utils.js';

const POSITIONS_KEY = 'addon-positions';

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

// Place an addon at its dragged position if it has one, or at its preset position otherwise.
const positionAddon = (primaryMonitor, position, element, id) => {
    if (!primaryMonitor || !element || element._dragging) return;

    const custom = getCustomPositions()[id];
    if (!custom) {
        const position_style = getPositionStyle(primaryMonitor, position, element);
        element.set_position(position_style.x, position_style.y);
        return;
    }

    // Positions are saved as fractions of the monitor size, so they survive a resolution change.
    const [, , width, height] = element.get_preferred_size();
    element.set_position(
        clamp(Math.round(custom[0] * primaryMonitor.width), 1, primaryMonitor.width - width), // x >= 1, see the 0,0 bug in getPositionStyle.
        clamp(Math.round(custom[1] * primaryMonitor.height), 0, primaryMonitor.height - height)
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
