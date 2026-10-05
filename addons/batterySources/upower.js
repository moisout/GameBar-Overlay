import Gio from 'gi://Gio';
import UPower from 'gi://UPowerGlib';

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

const LOW_LEVELS = [UPower.DeviceLevel.LOW, UPower.DeviceLevel.CRITICAL, UPower.DeviceLevel.ACTION];

// The battery of the computer and the devices the system knows, from UPower.
// onChanged() is called after every change of a property.
export class UPowerSource {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._devices = new Map();
        this._displayDevice = null;
        this._upower = null;
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
            this._connections.push({ proxy, id: proxy.connect('g-properties-changed', () => this._onChanged()), dbusSignal: false });
            this._onChanged();
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
        this._onChanged();
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

    static _read(proxy) {
        return {
            kind: proxy.Type,
            percentage: proxy.Percentage,
            state: proxy.State,
            timeToEmpty: proxy.TimeToEmpty,
            timeToFull: proxy.TimeToFull,
            low: LOW_LEVELS.includes(proxy.WarningLevel),
            name: proxy.Model || proxy.Vendor,
        };
    }

    // The battery of the computer, null on a computer without one.
    get computer() {
        const proxy = this._displayDevice;
        if (!proxy?.IsPresent || proxy.Type !== UPower.DeviceKind.BATTERY) return null;
        return UPowerSource._read(proxy);
    }

    // Mice, headsets, controllers and other devices with a battery.
    get devices() {
        return [...this._devices.values()]
            .filter(proxy => proxy.Type !== null && !proxy.PowerSupply && proxy.IsPresent &&
                proxy.Type !== UPower.DeviceKind.LINE_POWER && proxy.Type !== UPower.DeviceKind.UNKNOWN)
            .map(proxy => UPowerSource._read(proxy));
    }

    destroy() {
        this._cancellable.cancel();
        [...new Set(this._connections.map(connection => connection.proxy))].forEach(proxy => this._disconnect(proxy));
        this._devices.clear();
        this._displayDevice = null;
        this._upower = null;
    }
}
