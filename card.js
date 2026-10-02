import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Building blocks for the Adwaita style cards, see design/gnome-game-overlay-handoff.md.

// A card with an optional header bar. Children go into the returned body.
// With onClose the header bar gets a close button, like the window controls of Adwaita.
const createCard = (title, styleClass = '', onClose = null) => {
    const card = new St.BoxLayout({
        vertical: true,
        style_class: `gamebar-card ${styleClass}`,
        // Keeps the expanding rows from stretching the card over the whole overlay.
        x_expand: false,
        y_expand: false,
    });

    if (title) {
        const header = new St.BoxLayout({ style_class: 'gamebar-card-header' });
        // Keeps the title centred opposite the close button.
        header.add_child(new St.Widget({ style_class: 'gamebar-window-control' }));
        header.add_child(new St.Label({
            style_class: 'gamebar-card-title',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(onClose ? createCloseButton(onClose) : new St.Widget({ style_class: 'gamebar-window-control' }));
        card.add_child(header);
    }

    const body = new St.BoxLayout({
        vertical: true,
        style_class: title ? 'gamebar-card-body' : 'gamebar-card-body gamebar-card-body-headerless',
    });
    card.add_child(body);

    return { card, body };
};

// A 24px circle with a cross inside a 44px hit area.
const createCloseButton = (onClose) => {
    const button = new St.Button({
        style_class: 'gamebar-window-control',
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: _('Close'),
        child: new St.Bin({
            style_class: 'gamebar-window-control-circle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 12 }),
        }),
    });
    button.connect('clicked', onClose);
    return button;
};

const createGroupTitle = (text) => new St.Label({
    style_class: 'gamebar-group-title',
    text,
});

// Rounded group of rows with a separator between rows, like a list in GNOME Settings.
class BoxedList {
    constructor() {
        this.actor = new St.BoxLayout({
            vertical: true,
            style_class: 'gamebar-boxed-list',
        });
    }

    addRow(row) {
        if (this.actor.get_n_children() > 0) {
            this.actor.add_child(createSeparator());
        }
        this.actor.add_child(row);
    }

    clear() {
        this.actor.destroy_all_children();
    }

    get isEmpty() {
        return this.actor.get_n_children() === 0;
    }
}

const createSeparator = () => new St.Widget({
    style_class: 'gamebar-row-separator',
    x_expand: true,
});

const createRow = (styleClass = '') => new St.BoxLayout({
    style_class: `gamebar-row ${styleClass}`,
    x_expand: true,
});

// Label that shrinks with an ellipsis instead of widening the card.
const createLabel = (text, styleClass = '', props = {}) => {
    const label = new St.Label({
        style_class: styleClass,
        text,
        y_align: Clutter.ActorAlign.CENTER,
        ...props,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
};

// Bar showing a fraction in the accent colour, like the level bars of the design.
class LevelBar {
    constructor() {
        this._value = 0;
        this._fill = new St.Widget({ style_class: 'gamebar-level-bar-fill' });
        this.actor = new St.Widget({
            style_class: 'gamebar-level-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._fill);
        this.actor.connect('notify::width', () => this._sync());
        this.actor.connect('notify::height', () => this._sync());
    }

    set value(value) {
        this._value = Math.max(0, Math.min(value, 1));
        this._sync();
    }

    _sync() {
        this._fill.set_size(Math.round(this.actor.width * this._value), this.actor.height);
    }
}

// Flat circular button holding a symbolic icon.
const createIconButton = (iconName, styleClass = '') => new St.Button({
    style_class: `gamebar-icon-button ${styleClass}`,
    y_align: Clutter.ActorAlign.CENTER,
    child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
});

export { createCard, createGroupTitle, BoxedList, createSeparator, createRow, createLabel, LevelBar, createIconButton };
