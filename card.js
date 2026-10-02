import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Building blocks for the Adwaita style cards, see design/gnome-game-overlay-handoff.md.

// Properties of a vertical or horizontal St.BoxLayout. Its vertical property is deprecated since GNOME 48,
// older versions have no orientation.
const HAS_ORIENTATION = St.BoxLayout.find_property('orientation') !== null;
const vertical = (isVertical = true) => {
    if (!HAS_ORIENTATION) return { vertical: isVertical };
    return { orientation: isVertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL };
};

// A card with an optional header bar. Children go into the returned body.
// With onClose the header bar gets a close button, like the window controls of Adwaita.
// leading is an actor for the slot on the left of the header bar, like a button of the card.
const createCard = (title, styleClass = '', onClose = null, leading = null) => {
    const card = new St.BoxLayout({
        ...vertical(),
        style_class: `gamebar-card ${styleClass}`,
        // Keeps the expanding rows from stretching the card over the whole overlay.
        x_expand: false,
        y_expand: false,
    });

    if (title) {
        const header = new St.BoxLayout({ style_class: 'gamebar-card-header' });
        // The empty slot keeps the title centred opposite the close button.
        header.add_child(leading
            ? new St.Bin({ style_class: 'gamebar-window-control', child: leading })
            : new St.Widget({ style_class: 'gamebar-window-control' }));
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
        ...vertical(),
        style_class: title ? 'gamebar-card-body' : 'gamebar-card-body gamebar-card-body-headerless',
    });
    card.add_child(body);

    return { card, body };
};

// A 24px circle with a cross inside a 44px hit area.
// The icon is 16px like in the Adwaita window controls, the cross of the icon is only half its size.
const createCloseButton = (onClose) => {
    const button = new St.Button({
        style_class: 'gamebar-window-control',
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: _('Close'),
        child: new St.Bin({
            style_class: 'gamebar-window-control-circle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }),
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
            ...vertical(),
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

// Tab bar below the header bar, like the tab bar of GNOME Files and of the Gallery card of the design.
// The tabs are equally wide, a separator is only shown between two unselected tabs.
// The body below gets more padding while the tab bar is shown.
class TabBar {
    constructor(card, body, onSelected) {
        this._body = body;
        this._onSelected = onSelected;
        this._tabs = [];
        this._key = null;
        this._selected = null;

        this.actor = new St.BoxLayout({ style_class: 'gamebar-tabs', x_expand: true });
        this.actor.layout_manager.homogeneous = true;
        card.insert_child_below(this.actor, body);
        this.visible = true;
    }

    set visible(visible) {
        this.actor.visible = visible;
        if (visible) {
            this._body.add_style_class_name('gamebar-card-body-tabbed');
        } else {
            this._body.remove_style_class_name('gamebar-card-body-tabbed');
        }
    }

    // tabs: [{ id, name }]. Only rebuilt when they change, a tab being clicked is not destroyed under the pointer.
    setTabs(tabs) {
        const key = JSON.stringify(tabs.map(({ id, name }) => [id, name]));
        if (key === this._key) return;
        this._key = key;

        this.actor.destroy_all_children();
        this._tabs = tabs.map(({ id, name }, index) => {
            // The separator before the tab is part of its cell, so it does not count as a tab of its own.
            const cell = new St.BoxLayout({ x_expand: true });
            const separator = new St.Widget({ style_class: 'gamebar-tab-separator', y_align: Clutter.ActorAlign.CENTER });
            separator.visible = index > 0;
            cell.add_child(separator);

            const button = new St.Button({
                style_class: 'gamebar-tab',
                x_expand: true,
                child: createLabel(name, '', { x_align: Clutter.ActorAlign.CENTER }),
            });
            button.connect('clicked', () => this._onSelected(id));
            cell.add_child(button);

            this.actor.add_child(cell);
            return { id, button, separator };
        });
        this.selected = this._selected;
    }

    set selected(id) {
        this._selected = id;
        this._tabs.forEach(({ id: tabId, button, separator }, index) => {
            const selected = tabId === id;
            if (selected) {
                button.add_style_class_name('gamebar-tab-selected');
            } else {
                button.remove_style_class_name('gamebar-tab-selected');
            }
            separator.opacity = selected || this._tabs[index - 1]?.id === id ? 0 : 255;
        });
    }
}

// Gives the fill of a level bar its fraction of the bar. Sizing the fill once the bar has its width would
// ask for a new layout in the middle of the layout, which Clutter warns about.
const LevelLayout = GObject.registerClass(
class LevelLayout extends Clutter.LayoutManager {
    _init() {
        super._init();
        this._value = 0;
    }

    set value(value) {
        this._value = value;
        this.layout_changed();
    }

    // The size of the bar comes from the stylesheet and the row.
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const fill = container.get_first_child();
        if (!fill) return;

        const fillBox = new Clutter.ActorBox();
        fillBox.set_origin(box.x1, box.y1);
        fillBox.set_size(Math.round(box.get_width() * this._value), box.get_height());
        fill.allocate(fillBox);
    }
});

// Bar showing a fraction in the accent colour, like the level bars of the design.
class LevelBar {
    constructor() {
        this._layout = new LevelLayout();
        this._fill = new St.Widget({ style_class: 'gamebar-level-bar-fill' });
        this.actor = new St.Widget({
            style_class: 'gamebar-level-bar',
            layout_manager: this._layout,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._fill);
    }

    set value(value) {
        this._layout.value = Math.max(0, Math.min(value, 1));
    }

    // A low battery, for example.
    set warning(warning) {
        if (warning) {
            this._fill.add_style_class_name('gamebar-level-bar-fill-warning');
        } else {
            this._fill.remove_style_class_name('gamebar-level-bar-fill-warning');
        }
    }
}

// Style showing an image file as the background of an actor. A background image follows the rounded corners,
// like the user avatars of the shell.
const backgroundImageStyle = (path) => {
    const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `background-image: url("${escaped}"); background-size: cover;`;
};

// Large rounded button with an icon and a bold label, like the pill buttons of Adwaita.
const createPillButton = (iconName, text, styleClass = '') => {
    const icon = new St.Icon({ icon_name: iconName, icon_size: 16 });
    const label = new St.Label({ text, y_align: Clutter.ActorAlign.CENTER });

    const content = new St.BoxLayout({
        style_class: 'gamebar-pill-button-content',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    content.add_child(icon);
    content.add_child(label);

    const button = new St.Button({
        style_class: `gamebar-pill-button ${styleClass}`,
        child: content,
        x_expand: true,
    });
    return { button, icon, label };
};

// Flat circular button holding a symbolic icon.
const createIconButton = (iconName, styleClass = '') => new St.Button({
    style_class: `gamebar-icon-button ${styleClass}`,
    y_align: Clutter.ActorAlign.CENTER,
    child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
});

export { vertical, backgroundImageStyle, createCard, createGroupTitle, BoxedList, createSeparator, createRow, createLabel, TabBar, LevelBar, createPillButton, createIconButton };
