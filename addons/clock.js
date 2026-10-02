import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import { positionAddon, followCardSize, makeDraggable } from '../cardPosition.js';
import { createCard, createPinButton } from '../card.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class Clock {
  constructor(overlay, monitor, { pinKey = null } = {}) {
    this._overlay = overlay;
    // The monitor of a pinned card, which has no header bar and stays while the overlay is closed.
    this._pinKey = pinKey;
    this._monitor = monitor;
    this._timeLabel = null;
    this._dateLabel = null;
    this._timeoutId = null;
    this._addonContainer = null;
    this._visibilityChangedId = null;
    // The clock format of GNOME, 12 or 24 hours.
    this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
  }

  _createClockWidget() {
    // Create a label to display the time
    this._timeLabel = new St.Label({
      style_class: 'gamebar-time',
      text: '',
      x_align: Clutter.ActorAlign.CENTER,
    });

    this._timeLabel.set_style(`
      font-size: ${this._clockFontSize}px;
    `);

    // Create a label to display the date below the time
    this._dateLabel = new St.Label({
      style_class: 'gamebar-date',
      text: '',
      x_align: Clutter.ActorAlign.CENTER,
    });

    // The clock card has no header bar, the whole card is the drag handle.
    const { card, body } = createCard(null, 'gamebar-clock-card');
    body.add_child(this._timeLabel);
    body.add_child(this._dateLabel);

    // Create a box layout to hold the card and position it
    this._addonContainer = new St.Widget({
      layout_manager: new Clutter.BinLayout()
    });

    // Add the card to the box
    this._addonContainer.add_child(card);

    // Without a header bar the pin button is in the corner, while the pointer is over the card or it is pinned.
    if (!this._pinKey) {
      const pinButton = createPinButton('clock');
      pinButton.add_style_class_name('gamebar-clock-pin');
      // A BinLayout only aligns children that expand, the expansion would stretch the card over the overlay.
      Object.assign(pinButton, { x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START });
      Object.assign(this._addonContainer, { x_expand: false, y_expand: false });
      this._addonContainer.track_hover = true;
      const syncPinButton = () => {
        pinButton.opacity = this._addonContainer.hover || pinButton.checked ? 255 : 0;
      };
      this._addonContainer.connect('notify::hover', syncPinButton);
      pinButton.connect('notify::checked', syncPinButton);
      syncPinButton();
      this._addonContainer.add_child(pinButton);
    }

    // Add the box to the overlay
    this._overlay.add_child(this._addonContainer);
    if (!this._pinKey) makeDraggable(this._addonContainer, 'clock');

    followCardSize(this._addonContainer, () => this.set_addon_position());

    // Connect to overlay visibility changes
    this._visibilityChangedId = this._overlay.connect('notify::visible', () => {
      if (this._overlay.visible) {
        this._startClock();
      } else {
        this._stopClock();
      }
    });

    // Initial update if overlay is visible
    if (this._overlay.visible) {
      this._startClock();
    }
  }

  _startClock() {
    // Initial update
    this._updateClock();

    // Start the timer only if it's not already running
    if (!this._timeoutId) {
      this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        this._updateClock();
        return GLib.SOURCE_CONTINUE;
      });
    }
  }

  _stopClock() {
    // Remove the timeout if it exists
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }
  }

  set_addon_position() {
    positionAddon(this._monitor, this._addonContainer, 'clock', this._pinKey);
  }

  _updateClock() {
    // Only update if the overlay is visible
    if (!this._overlay.visible) {
      return false;
    }

    // Get the current local time
    let now = GLib.DateTime.new_now_local();

    // Format the time based on settings, "9:41 PM" or "21:41"
    const seconds = this._showSeconds ? ':%S' : '';
    const twelveHours = this._interfaceSettings.get_string('clock-format') === '12h';
    let time = now.format(twelveHours ? `%l:%M${seconds} %p` : `%H:%M${seconds}`).trim();

    // Update the clock widget with the new time
    this._timeLabel.set_text(time);
    this._dateLabel.set_text(now.format(_('%A, %-d %B')));

    return true;
  }

  _updateSettings(settings) {
    this._clockFontSize = settings.get_int('clock-addon-font-size');
    this._showSeconds = settings.get_boolean('clock-addon-show-seconds');

    // Recreate the widget with new settings
    this._stopClock();
    this.destroy();
    this._createClockWidget();
  }

  destroy() {
    // Stop the clock updates
    this._stopClock();

    // Disconnect all signals
    if (this._visibilityChangedId) {
      this._overlay.disconnect(this._visibilityChangedId);
      this._visibilityChangedId = null;
    }

    // Remove the clock widget from the overlay
    if (this._addonContainer) {
      this._addonContainer.destroy();
      this._addonContainer = null;
    }

    // Cleanup
    this._timeLabel = null;
    this._dateLabel = null;
  }
}