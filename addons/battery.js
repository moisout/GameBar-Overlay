import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import UPower from 'gi://UPowerGlib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable } from '../cardPosition.js';
import { vertical, createCard, createGroupTitle, BoxedList, createRow, createLabel, LevelBar } from '../card.js';
import { UPowerSource } from './batterySources/upower.js';
import { LogitechSource } from './batterySources/logitech.js';

// The sources of the batteries, each turned on by its setting. Their devices are listed in this order.
const SOURCES = [
    { id: 'upower', key: 'battery-source-upower', Source: UPowerSource },
    { id: 'logitech', key: 'battery-source-logitech', Source: LogitechSource },
];
export const BATTERY_KEYS = SOURCES.map(source => source.key);

const DEVICE_ICONS = {
    [UPower.DeviceKind.MOUSE]: 'input-mouse-symbolic',
    [UPower.DeviceKind.KEYBOARD]: 'input-keyboard-symbolic',
    [UPower.DeviceKind.HEADSET]: 'audio-headset-symbolic',
    [UPower.DeviceKind.HEADPHONES]: 'audio-headphones-symbolic',
    [UPower.DeviceKind.SPEAKERS]: 'audio-speakers-symbolic',
    [UPower.DeviceKind.GAMING_INPUT]: 'input-gaming-symbolic',
    [UPower.DeviceKind.PHONE]: 'phone-symbolic',
    [UPower.DeviceKind.TABLET]: 'input-tablet-symbolic',
    [UPower.DeviceKind.PEN]: 'input-tablet-symbolic',
    [UPower.DeviceKind.TOUCHPAD]: 'input-touchpad-symbolic',
    [UPower.DeviceKind.COMPUTER]: 'computer-symbolic',
    [UPower.DeviceKind.CAMERA]: 'camera-photo-symbolic',
};

// "3 h 10 min"
const formatDuration = (seconds) => {
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return hours > 0 ? _('%d h %d min').format(hours, minutes % 60) : _('%d min').format(minutes);
};

// The state of the battery of the computer, like the power settings of GNOME.
const describeState = (device) => {
    switch (device.state) {
    case UPower.DeviceState.CHARGING:
        return device.timeToFull > 0 ? _('%s until full').format(formatDuration(device.timeToFull)) : _('Charging');
    case UPower.DeviceState.DISCHARGING:
        return device.timeToEmpty > 0 ? _('%s remaining').format(formatDuration(device.timeToEmpty)) : _('Estimating…');
    case UPower.DeviceState.FULLY_CHARGED:
        return _('Fully charged');
    case UPower.DeviceState.PENDING_CHARGE:
    case UPower.DeviceState.PENDING_DISCHARGE:
        return _('Not charging');
    default:
        return '';
    }
};

const CHARGING_STATES = [UPower.DeviceState.CHARGING, UPower.DeviceState.FULLY_CHARGED];

// The state of a connected device, most devices do not know how long their battery lasts.
const describeDevice = (device) => {
    switch (device.state) {
    case UPower.DeviceState.CHARGING:
        return _('Charging');
    case UPower.DeviceState.FULLY_CHARGED:
        return _('Fully charged');
    default:
        return device.low ? _('Low battery') : '';
    }
};

// The battery of the computer and the connected devices from the turned on sources, shared by every Battery card.
// Emits 'changed' after every change, once for several changes at once.
export class BatteryModel extends Signals.EventEmitter {
    constructor() {
        super();
        // Source by id, of the turned on sources
        this._sources = new Map();
        this._changedId = 0;
    }

    // Turns the sources on and off: { upower: true, logitech: false }.
    setEnabled(enabled) {
        for (const { id, Source } of SOURCES) {
            const source = this._sources.get(id);
            if (enabled[id] && !source) {
                this._sources.set(id, new Source(() => this._queueChanged()));
            } else if (!enabled[id] && source) {
                source.destroy();
                this._sources.delete(id);
            }
        }
        this._queueChanged();
    }

    updateSettings(settings) {
        this.setEnabled(Object.fromEntries(SOURCES.map(({ id, key }) => [id, settings.get_boolean(key)])));
    }

    _queueChanged() {
        if (this._changedId) return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    _turnedOn() {
        return SOURCES.map(({ id }) => this._sources.get(id)).filter(Boolean);
    }

    // The battery of the computer, null on a computer without one.
    get computer() {
        return this._turnedOn().map(source => source.computer).find(Boolean) ?? null;
    }

    // Mice, headsets, controllers and other devices with a battery, sorted by name.
    // A device already listed by an earlier source is left out: the kernel names a Logitech device in UPower like HID++.
    get connectedDevices() {
        const devices = [];
        const listed = new Set();
        const key = device => device.name.toLowerCase();
        for (const source of this._turnedOn()) {
            const added = source.devices.map(device => ({ ...device, name: device.name || _('Device') }))
                .filter(device => !listed.has(key(device)));
            devices.push(...added);
            added.forEach(device => listed.add(key(device)));
        }
        return devices.sort((a, b) => a.name.localeCompare(b.name));
    }

    destroy() {
        this._sources.forEach(source => source.destroy());
        this._sources.clear();
        if (this._changedId) {
            GLib.Source.remove(this._changedId);
            this._changedId = 0;
        }
        this.disconnectAll();
    }
}

export class Battery {
    // model: the BatteryModel of the extension.
    constructor(overlay, monitor, model, { pinKey = null } = {}) {
        this._overlay = overlay;
        // The monitor of a pinned card, which has no header bar and stays while the overlay is closed.
        this._pinKey = pinKey;
        this._monitor = monitor;
        this._addonContainer = null;
        this._body = null;
        this._model = model;
        this._changedId = model.connect('changed', () => this._sync());
        this._createBatteryWidget();
    }

    _createBatteryWidget() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(this._pinKey ? null : _('Battery'), 'gamebar-battery-card', 'battery');
        this._body = body;
        this._sync();

        this._addonContainer.add_child(card);
        this._overlay.add_child(this._addonContainer);
        if (!this._pinKey) makeDraggable(this._addonContainer, 'battery');

        followCardSize(this._addonContainer, () => this.set_addon_position());
    }

    _sync() {
        if (!this._body) return;
        this.render(this._model.computer, this._model.connectedDevices);
    }

    // Separate from the model, so it can be shown with any devices.
    render(computer, connectedDevices) {
        this._body.destroy_all_children();

        if (computer) {
            const list = new BoxedList();
            list.addRow(this._createDeviceRow('computer-symbolic', _('This Device'), describeState(computer), computer));
            this._body.add_child(list.actor);
        }

        if (connectedDevices.length > 0) {
            const title = createGroupTitle(_('Connected Devices'));
            if (!computer) {
                title.add_style_class_name('gamebar-group-title-first');
            }
            this._body.add_child(title);

            const list = new BoxedList();
            connectedDevices.forEach(device => {
                // A low battery that is charging is no longer a warning.
                const charging = CHARGING_STATES.includes(device.state);
                const shown = { ...device, low: device.low && !charging };
                list.addRow(this._createDeviceRow(DEVICE_ICONS[device.kind] ?? 'battery-symbolic', device.name,
                    describeDevice(shown), shown));
            });
            this._body.add_child(list.actor);
        }

        if (!computer && connectedDevices.length === 0) {
            const list = new BoxedList();
            const row = createRow();
            row.add_child(createLabel(_('No devices with a battery'), 'gamebar-dim', { x_expand: true }));
            list.addRow(row);
            this._body.add_child(list.actor);
        }
    }

    // Icon, name with an optional subtitle, level bar and percentage.
    _createDeviceRow(iconName, name, subtitle, device) {
        const row = createRow(subtitle ? 'gamebar-stat-row' : '');
        row.add_child(new St.Icon({ icon_name: iconName, icon_size: 16, y_align: Clutter.ActorAlign.CENTER }));

        const info = new St.BoxLayout({
            ...vertical(),
            style_class: 'gamebar-battery-info',
            y_align: Clutter.ActorAlign.CENTER,
        });
        info.add_child(createLabel(name));
        if (subtitle) {
            const subtitleLabel = createLabel(subtitle, 'gamebar-subtitle gamebar-numeric');
            if (device.low) {
                subtitleLabel.add_style_class_name('gamebar-warning');
            }
            info.add_child(subtitleLabel);
        }
        row.add_child(info);

        const level = new LevelBar();
        level.value = device.percentage / 100;
        level.warning = device.low;
        row.add_child(level.actor);

        row.add_child(createLabel(`${Math.round(device.percentage)}%`, 'gamebar-battery-percentage gamebar-numeric'));
        return row;
    }

    set_addon_position() {
        positionAddon(this._monitor, this._addonContainer, 'battery', this._pinKey);
    }

    _destroyWidget() {
        this._addonContainer?.destroy();
        this._addonContainer = null;
        this._body = null;
    }

    destroy() {
        this._destroyWidget();
        this._model?.disconnect(this._changedId);
        this._model = null;
    }
}
