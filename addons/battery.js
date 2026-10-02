import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import UPower from 'gi://UPowerGlib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable } from '../cardPosition.js';
import { vertical, createCard, createGroupTitle, BoxedList, createRow, createLabel, LevelBar } from '../card.js';

// UPower over D-Bus like the shell, the device lists of UPowerGlib are freed too early in GJS.
// UPowerGlib is only used for its enums.
const BUS_NAME = 'org.freedesktop.UPower';
const OBJECT_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices"><arg name="devices" type="ao" direction="out"/></method>
    <signal name="DeviceAdded"><arg name="device" type="o"/></signal>
    <signal name="DeviceRemoved"><arg name="device" type="o"/></signal>
  </interface>
</node>`);

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="TimeToFull" type="x" access="read"/>
    <property name="WarningLevel" type="u" access="read"/>
    <property name="Model" type="s" access="read"/>
    <property name="Vendor" type="s" access="read"/>
  </interface>
</node>`);

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

const LOW_LEVELS = [UPower.DeviceLevel.LOW, UPower.DeviceLevel.CRITICAL, UPower.DeviceLevel.ACTION];

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

// Keeps the battery of the computer and the connected devices up to date.
// onChanged() is called after every change, also before the first devices arrive.
class BatteryModel {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._devices = new Map();
        this._displayDevice = null;
        this._upower = null;
        this._changedId = 0;
        // { proxy, id, dbusSignal } of every connection, for destroy()
        this._connections = [];

        this._displayDevice = this._createDevice(DISPLAY_DEVICE_PATH);
        this._upower = new UPowerProxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.warn(`GameBar: ${error.message}`);
                return;
            }
            for (const [name, handler] of [['DeviceAdded', path => this._addDevice(path)], ['DeviceRemoved', path => this._removeDevice(path)]]) {
                const id = proxy.connectSignal(name, (proxy_, sender, [path]) => handler(path));
                this._connections.push({ proxy, id, dbusSignal: true });
            }
            this._upower.EnumerateDevicesAsync()
                .then(([paths]) => paths.forEach(path => this._addDevice(path)))
                .catch(e => console.warn(`GameBar: ${e.message}`));
        }, this._cancellable);
    }

    _createDevice(path) {
        return new DeviceProxy(Gio.DBus.system, BUS_NAME, path, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.warn(`GameBar: ${error.message}`);
                return;
            }
            this._connections.push({ proxy, id: proxy.connect('g-properties-changed', () => this._queueChanged()), dbusSignal: false });
            this._queueChanged();
        }, this._cancellable);
    }

    _addDevice(path) {
        if (this._devices.has(path)) return;
        this._devices.set(path, this._createDevice(path));
    }

    _removeDevice(path) {
        const proxy = this._devices.get(path);
        this._devices.delete(path);
        this._disconnect(proxy);
        this._queueChanged();
    }

    _disconnect(proxy) {
        this._connections = this._connections.filter(connection => {
            if (connection.proxy !== proxy) return true;
            if (connection.dbusSignal) {
                proxy.disconnectSignal(connection.id);
            } else {
                proxy.disconnect(connection.id);
            }
            return false;
        });
    }

    // Several properties change at once, update the card once.
    _queueChanged() {
        if (this._changedId) return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    static _read(proxy) {
        return {
            kind: proxy.Type,
            percentage: proxy.Percentage,
            state: proxy.State,
            timeToEmpty: proxy.TimeToEmpty,
            timeToFull: proxy.TimeToFull,
            low: LOW_LEVELS.includes(proxy.WarningLevel),
            name: proxy.Model || proxy.Vendor || _('Device'),
        };
    }

    // The battery of the computer, null on a computer without one.
    get computer() {
        const proxy = this._displayDevice;
        if (!proxy?.IsPresent || proxy.Type !== UPower.DeviceKind.BATTERY) return null;
        return BatteryModel._read(proxy);
    }

    // Mice, headsets, controllers and other devices with a battery, sorted by name.
    get connectedDevices() {
        return [...this._devices.values()]
            .filter(proxy => proxy.Type !== null && !proxy.PowerSupply && proxy.IsPresent &&
                proxy.Type !== UPower.DeviceKind.LINE_POWER && proxy.Type !== UPower.DeviceKind.UNKNOWN)
            .map(proxy => BatteryModel._read(proxy))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    destroy() {
        this._cancellable.cancel();
        [...new Set(this._connections.map(connection => connection.proxy))].forEach(proxy => this._disconnect(proxy));
        if (this._changedId) {
            GLib.Source.remove(this._changedId);
            this._changedId = 0;
        }
        this._devices.clear();
        this._displayDevice = null;
        this._upower = null;
    }
}

export class Battery {
    constructor(overlay, monitor, { pinKey = null } = {}) {
        this._overlay = overlay;
        // The monitor of a pinned card, which has no header bar and stays while the overlay is closed.
        this._pinKey = pinKey;
        this._monitor = monitor;
        this._addonContainer = null;
        this._body = null;
        this._model = new BatteryModel(() => this._sync());
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
                const subtitle = device.low ? _('Low battery') : '';
                list.addRow(this._createDeviceRow(DEVICE_ICONS[device.kind] ?? 'battery-symbolic', device.name, subtitle, device));
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
        this._model?.destroy();
        this._model = null;
    }
}
