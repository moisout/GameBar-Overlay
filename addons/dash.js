import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { isCardHidden, setCardHidden, followCardSize } from '../cardPosition.js';
import { vertical } from '../card.js';

// Distance of the dash from the bottom edge of the monitor.
const BOTTOM_MARGIN = 20;

// Bar at the bottom centre with a button per card, like the dash of the overview.
// A dot below the icon shows that the card is shown, clicking the button shows or hides the card.
export class Dash {
    // cards: [{ id, name, iconName }] in the order of the buttons.
    constructor(overlay, primaryMonitor, cards) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._buttons = new Map();

        this._addonContainer = new St.BoxLayout({
            style_class: 'gamebar-dash',
            reactive: true,
        });

        cards.forEach(({ id, name, iconName }) => {
            const dot = new St.Widget({
                style_class: 'gamebar-dash-dot',
                x_align: Clutter.ActorAlign.CENTER,
            });

            const content = new St.BoxLayout({
                ...vertical(),
                style_class: 'gamebar-dash-button-content',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            content.add_child(new St.Icon({ icon_name: iconName, icon_size: 22 }));
            content.add_child(dot);

            const button = new St.Button({
                style_class: 'gamebar-dash-button',
                accessible_name: name,
                child: content,
            });
            button.connect('clicked', () => setCardHidden(id, !isCardHidden(id)));

            this._addonContainer.add_child(button);
            this._buttons.set(id, { button, dot });
        });

        // A click on the dash is not a click on the empty area of the overlay.
        // Only the release is stopped, a stopped press would cancel the click of the buttons.
        this._addonContainer.connect('button-release-event', () => Clutter.EVENT_STOP);

        this._overlay.add_child(this._addonContainer);

        followCardSize(this._addonContainer, () => this.set_addon_position());
    }

    // available: whether the card exists at all (the Hardware card does not without any row).
    sync(id, available, shown) {
        const entry = this._buttons.get(id);
        if (!entry) return;

        entry.button.visible = available;
        entry.dot.opacity = shown ? 255 : 0;
    }

    set_addon_position() {
        if (!this._primaryMonitor || !this._addonContainer) return;

        const [, , width, height] = this._addonContainer.get_preferred_size();
        // The margin is in pixels of the stylesheet, which the shell multiplies by its scale factor.
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._addonContainer.set_position(
            Math.round((this._primaryMonitor.width - width) / 2),
            this._primaryMonitor.height - height - BOTTOM_MARGIN * scaleFactor
        );
    }

    destroy() {
        this._addonContainer?.destroy();
        this._addonContainer = null;
        this._buttons.clear();
    }
}
