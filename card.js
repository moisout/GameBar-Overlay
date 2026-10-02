import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

// Building blocks for the Adwaita style cards, see design/gnome-game-overlay-handoff.md.

// A card with an optional header bar. Children go into the returned body.
const createCard = (title, styleClass = '') => {
    const card = new St.BoxLayout({
        vertical: true,
        style_class: `gamebar-card ${styleClass}`,
        // Keeps the expanding rows from stretching the card over the whole overlay.
        x_expand: false,
        y_expand: false,
    });

    if (title) {
        const header = new St.BoxLayout({ style_class: 'gamebar-card-header' });
        header.add_child(new St.Label({
            style_class: 'gamebar-card-title',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        card.add_child(header);
    }

    const body = new St.BoxLayout({
        vertical: true,
        style_class: title ? 'gamebar-card-body' : 'gamebar-card-body gamebar-card-body-headerless',
    });
    card.add_child(body);

    return { card, body };
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
