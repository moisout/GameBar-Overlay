import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import UPower from 'gi://UPowerGlib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

// The Phone Connect service (phone-connect-daemon) on the session bus. Every connected phone is an object with the
// Phone interface, they come and go through the ObjectManager of the service.
const SERVICE = 'com.m0is.PhoneConnect.Daemon';
const PATH = '/com/m0is/PhoneConnect';
const PHONE = 'com.m0is.PhoneConnect.Phone';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';

// The phone has no warning level of its own, this is the one of UPower (PercentageLow).
const LOW_PERCENTAGE = 20;
// Changes come in bursts, one read answers them all, in ms.
const REFRESH_DELAY = 100;

const describe = (phone) => {
    const { BatteryLevel: percentage, Charging: charging } = phone.Status ?? {};
    let state = UPower.DeviceState.UNKNOWN;
    if (charging === true) {
        state = percentage >= 100 ? UPower.DeviceState.FULLY_CHARGED : UPower.DeviceState.CHARGING;
    } else if (charging === false) {
        state = UPower.DeviceState.DISCHARGING;
    }
    return {
        kind: UPower.DeviceKind.PHONE,
        name: phone.Name || phone.Model || '',
        percentage,
        state,
        low: percentage <= LOW_PERCENTAGE,
    };
};

// OPPO and OnePlus phones connected to Phone Connect, which tells their battery level and whether they charge.
// The service is never started from here, without it there are no phones.
export class PhoneConnectSource {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._devices = [];
        this._refreshId = 0;
        // A read that a newer one or the service going away overtook is dropped.
        this._generation = 0;

        // The phone objects change for the clipboard and the screen too, the devices are compared before onChanged().
        this._signalId = this._bus.signal_subscribe(SERVICE, null, null, null, null, Gio.DBusSignalFlags.NONE,
            (bus, sender, path, iface, signal, parameters) => {
                if (iface === OBJECT_MANAGER || (iface === PROPERTIES && parameters.get_child_value(0).unpack() === PHONE))
                    this._queueRefresh();
            });
        this._watchId = Gio.bus_watch_name_on_connection(this._bus, SERVICE, Gio.BusNameWatcherFlags.NONE,
            () => this._queueRefresh(),
            () => {
                this._generation++;
                this._setDevices([]);
            });
    }

    get computer() {
        return null;
    }

    // The connected phones that told their battery level.
    get devices() {
        return this._devices;
    }

    _queueRefresh() {
        if (this._refreshId) return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const generation = ++this._generation;
        // The interfaces with their properties by object path.
        /** @type {Record<string, Record<string, any>>} */
        let objects;
        try {
            const reply = await this._bus.call(SERVICE, PATH, OBJECT_MANAGER, 'GetManagedObjects', null, null,
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable);
            objects = /** @type {Record<string, Record<string, any>>} */ (reply.get_child_value(0).recursiveUnpack());
        } catch (e) {
            // Gone meanwhile, the name watch says so.
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.debug(`GameBar: Phone Connect: ${e.message}`);
            return;
        }
        if (generation !== this._generation) return;

        this._setDevices(Object.values(objects)
            .map(interfaces => interfaces[PHONE])
            .filter(phone => typeof phone?.Status?.BatteryLevel === 'number')
            .map(describe));
    }

    _setDevices(devices) {
        if (JSON.stringify(devices) === JSON.stringify(this._devices)) return;
        this._devices = devices;
        this._onChanged();
    }

    destroy() {
        this._cancellable.cancel();
        this._bus.signal_unsubscribe(this._signalId);
        Gio.bus_unwatch_name(this._watchId);
        if (this._refreshId) {
            GLib.Source.remove(this._refreshId);
            this._refreshId = 0;
        }
        this._devices = [];
    }
}
