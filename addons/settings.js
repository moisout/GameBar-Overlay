import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable, hasCustomPositions, resetCustomPositions, POSITIONS_KEY } from '../cardPosition.js';
import { createCard, BoxedList, createRow, createLabel, createPillButton } from '../card.js';

const OPACITY_KEY = 'pinned-cards-opacity';
// The range of the Pinned Card Opacity of the preferences, in percent.
const MIN_OPACITY = 10;
const MAX_OPACITY = 100;

// The settings changed while playing. The others are in the preferences, which open once the overlay is closed.
export class SettingsCard {
    // runWithOverlayClosed(callback) closes the overlay first, the preferences window would open behind it.
    constructor(overlay, monitor, runWithOverlayClosed) {
        this._overlay = overlay;
        this._monitor = monitor;
        this._runWithOverlayClosed = runWithOverlayClosed;
        this._settings = null;
        this._addonContainer = null;
        this._createSettingsWidget();
    }

    _createSettingsWidget() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        // Settings cannot be pinned, the pinned card could not be used.
        const { card, body } = createCard(_('Settings'), 'gamebar-settings-card', 'settings', null, { pinnable: false });
        body.add_style_class_name('gamebar-settings-body');
        const list = new BoxedList();
        body.add_child(list.actor);

        const opacityRow = createRow();
        opacityRow.add_child(createLabel(_('Pinned Card Opacity')));
        this._opacitySlider = new Slider(0);
        this._opacitySlider.x_expand = true;
        this._opacitySlider.accessible_name = _('Pinned Card Opacity');
        this._opacitySlider.connect('notify::value', () => {
            // Only whole percents are saved, a drag would save every pixel.
            this._settings?.set_int(OPACITY_KEY,
                Math.round(MIN_OPACITY + this._opacitySlider.value * (MAX_OPACITY - MIN_OPACITY)));
        });
        opacityRow.add_child(this._opacitySlider);
        this._opacityLabel = createLabel('', 'gamebar-stat-usage gamebar-numeric');
        opacityRow.add_child(this._opacityLabel);
        list.addRow(opacityRow);

        // A row that is a button, like the button rows of Adwaita.
        const resetRow = createRow();
        resetRow.add_child(createLabel(_('Reset Card Positions'), '', { x_expand: true, x_align: Clutter.ActorAlign.CENTER }));
        this._resetButton = new St.Button({
            style_class: 'gamebar-row-button gamebar-settings-reset-row',
            child: resetRow,
            x_expand: true,
        });
        this._resetButton.connect('clicked', () => resetCustomPositions());
        list.addRow(this._resetButton);

        const more = createPillButton('preferences-system-symbolic', _('More Settings…'));
        more.button.connect('clicked', () => this._runWithOverlayClosed(() => this._openPreferences()));
        body.add_child(more.button);

        this._addonContainer.add_child(card);
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'settings');

        followCardSize(this._addonContainer, () => this.set_addon_position());
    }

    _openPreferences() {
        Extension.lookupByURL(import.meta.url)?.openPreferences();
    }

    _updateSettings(settings) {
        this._settings?.disconnectObject(this._addonContainer);
        this._settings = settings;
        settings.connectObject(
            `changed::${OPACITY_KEY}`, () => this._syncOpacity(),
            // Positions are per monitor, reset moves the cards of the monitor of the overlay.
            `changed::${POSITIONS_KEY}`, () => this._syncReset(),
            this._addonContainer);
        // The cards may have been dragged on another monitor than the one the overlay opens on.
        this._overlay.connectObject('notify::visible', () => this._syncReset(), this._addonContainer);
        this._syncOpacity();
        this._syncReset();
    }

    _syncOpacity() {
        const percent = this._settings.get_int(OPACITY_KEY);
        this._opacityLabel.text = `${percent}%`;
        // Setting the value saves it, it is only set when it shows another percent. A drag is in between two.
        const value = (percent - MIN_OPACITY) / (MAX_OPACITY - MIN_OPACITY);
        if (Math.round(MIN_OPACITY + this._opacitySlider.value * (MAX_OPACITY - MIN_OPACITY)) !== percent) {
            this._opacitySlider.value = Math.max(0, Math.min(value, 1));
        }
    }

    // Without a dragged card there is nothing to reset.
    _syncReset() {
        this._resetButton.reactive = hasCustomPositions();
        this._resetButton.opacity = this._resetButton.reactive ? 255 : 128;
    }

    set_addon_position() {
        positionAddon(this._monitor, this._addonContainer, 'settings');
    }

    destroy() {
        // Also disconnects from the settings and the overlay.
        this._addonContainer?.destroy();
        this._addonContainer = null;
        this._settings = null;
    }
}
