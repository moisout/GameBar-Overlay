import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import UPower from 'gi://UPowerGlib';
import * as Hidpp from './hidpp.js';

Gio._promisify(Gio.File.prototype, 'open_readwrite_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

// A device that does not answer in time is asleep or switched off, in ms.
const REQUEST_TIMEOUT = 2000;
// New receivers are looked for this often, in seconds.
const RESCAN_INTERVAL = 30;
// The batteries are read again this often in case an event was missed, in seconds.
const REFRESH_INTERVAL = 600;

const DEVICE_KINDS = {
    [Hidpp.DeviceType.KEYBOARD]: UPower.DeviceKind.KEYBOARD,
    [Hidpp.DeviceType.NUMPAD]: UPower.DeviceKind.KEYBOARD,
    [Hidpp.DeviceType.MOUSE]: UPower.DeviceKind.MOUSE,
    [Hidpp.DeviceType.TRACKBALL]: UPower.DeviceKind.MOUSE,
    [Hidpp.DeviceType.TRACKPAD]: UPower.DeviceKind.TOUCHPAD,
    [Hidpp.DeviceType.HEADSET]: UPower.DeviceKind.HEADSET,
    [Hidpp.DeviceType.GAMEPAD]: UPower.DeviceKind.GAMING_INPUT,
};

const DEVICE_STATES = {
    [Hidpp.ChargeState.DISCHARGING]: UPower.DeviceState.DISCHARGING,
    [Hidpp.ChargeState.CHARGING]: UPower.DeviceState.CHARGING,
    [Hidpp.ChargeState.FULL]: UPower.DeviceState.FULLY_CHARGED,
};

const isCancelled = (error) => error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

// One opened /dev/hidraw* node: sends one request at a time and matches the replies.
// Every other report goes to onReport(), a read error to onClosed().
export class HidppNode {
    constructor(path, long, onReport, onClosed) {
        this.path = path;
        this.reportId = long ? Hidpp.LONG_REPORT : Hidpp.SHORT_REPORT;
        this._onReport = onReport;
        this._onClosed = onClosed;
        this._cancellable = new Gio.Cancellable();
        this._stream = null;
        this._input = null;
        this._output = null;
        // { request, resolve, reject } waiting for their turn, and the one waiting for its reply.
        this._queue = [];
        this._pending = null;
        this._timeoutId = 0;
    }

    // The node is opened read and write once, the reads and writes poll it in the main loop.
    async open() {
        this._stream = await Gio.File.new_for_path(this.path).open_readwrite_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        const fd = this._stream.get_output_stream().get_fd();
        this._input = new GioUnix.InputStream({ fd, close_fd: false });
        this._output = new GioUnix.OutputStream({ fd, close_fd: false });
        this._readLoop();
    }

    async _readLoop() {
        try {
            for (;;) {
                const bytes = await this._input.read_bytes_async(64, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (bytes.get_size() === 0) throw new Error('end of stream');
                this._receive(bytes.toArray());
            }
        } catch (e) {
            if (!isCancelled(e)) this._onClosed(e);
        }
    }

    _receive(report) {
        const reply = this._pending && Hidpp.matchReply(this._pending.request, report);
        if (!reply) {
            this._onReport(report);
            return;
        }
        const { resolve, reject } = this._pending;
        this._finish();
        if (reply.error !== undefined) {
            reject(new Hidpp.HidppError(reply.error));
        } else {
            resolve(reply.data);
        }
    }

    // The data of the reply, rejects with a HidppError or after REQUEST_TIMEOUT.
    request(request) {
        return new Promise((resolve, reject) => {
            this._queue.push({ request, resolve, reject });
            this._sendNext();
        });
    }

    // Calls function `fn` of the feature at `featureIndex` of a device.
    call(deviceIndex, featureIndex, fn, params = []) {
        return this.request(Hidpp.featureRequest(deviceIndex, featureIndex, fn, params, this.reportId));
    }

    _sendNext() {
        if (this._pending || this._queue.length === 0 || !this._output) return;
        const pending = this._pending = this._queue.shift();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT, () => {
            this._timeoutId = 0;
            this._finish();
            pending.reject(new Error('timeout'));
            return GLib.SOURCE_REMOVE;
        });
        this._output.write_bytes_async(new GLib.Bytes(pending.request), GLib.PRIORITY_DEFAULT, this._cancellable).catch(e => {
            if (this._pending !== pending) return;
            this._finish();
            pending.reject(e);
        });
    }

    // Ends the request waiting for its reply and sends the next one.
    _finish() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._pending = null;
        this._sendNext();
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const cancelled = new Error('closed');
        [this._pending, ...this._queue].filter(Boolean).forEach(({ reject }) => reject(cancelled));
        this._pending = null;
        this._queue = [];
        this._output = null;
        this._input = null;
        try {
            this._stream?.close(null);
        } catch {
            // Already gone with the receiver.
        }
        this._stream = null;
    }
}

// Mice and keyboards on Logitech receivers, and Logitech devices connected by cable or Bluetooth that the kernel does
// not handle, read over HID++ like Solaar does. A Logi Bolt receiver has no kernel driver.
export class LogitechSource {
    constructor(onChanged) {
        this._onChanged = onChanged;
        // { node, devices: Map of device index to { name, type, battery: { feature, index }, status } } by path
        this._receivers = new Map();
        // Paths that could not be opened, warned once.
        this._warned = new Set();
        this._destroyed = false;
        this._rescan();
        this._rescanId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, RESCAN_INTERVAL, () => {
            this._rescan();
            return GLib.SOURCE_CONTINUE;
        });
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_INTERVAL, () => {
            this._receivers.forEach(receiver => receiver.devices.forEach((device, index) => this._readBattery(receiver, index)));
            return GLib.SOURCE_CONTINUE;
        });
    }

    get computer() {
        return null;
    }

    // The devices whose battery was read once, the last level stays while they sleep. The name may be missing.
    get devices() {
        return [...this._receivers.values()].flatMap(receiver => [...receiver.devices.values()])
            .filter(device => device.status && device.status.percentage !== null)
            .map(device => ({
                kind: DEVICE_KINDS[device.type] ?? UPower.DeviceKind.UNKNOWN,
                name: device.name,
                percentage: device.status.percentage,
                state: DEVICE_STATES[device.status.charge] ?? UPower.DeviceState.UNKNOWN,
                low: device.status.low,
            }));
    }

    _warn(path, message) {
        if (this._warned.has(path)) return;
        this._warned.add(path);
        console.warn(`GameBar: ${path}: ${message}`);
    }

    _rescan() {
        for (const { path, long, canAccess } of Hidpp.listHidppNodes()) {
            if (this._receivers.has(path)) continue;
            if (!canAccess) {
                this._warn(path, 'no access to the Logitech receiver, the udev rule of Solaar gives it');
                continue;
            }
            this._addReceiver(path, long);
        }
    }

    async _addReceiver(path, long) {
        const receiver = { devices: new Map(), node: null };
        receiver.node = new HidppNode(path, long, report => this._onReport(receiver, report), () => this._removeReceiver(path));
        this._receivers.set(path, receiver);
        try {
            await receiver.node.open();
            // A receiver answers the ping with a HID++ 1.0 error, a device with its protocol version.
            const isReceiver = await receiver.node.request(Hidpp.pingRequest(Hidpp.RECEIVER_INDEX, receiver.node.reportId))
                .then(() => false, e => {
                    if (e instanceof Hidpp.HidppError) return true;
                    throw e;
                });
            if (!isReceiver) {
                await this._probe(receiver, Hidpp.RECEIVER_INDEX);
                return;
            }
            await this._enableConnectionNotifications(receiver);
            for (let index = 1; index <= Hidpp.MAX_SLOTS && !this._destroyed; index++) {
                await this._probe(receiver, index);
            }
        } catch (e) {
            // Unplugged while it was probed.
            if (this._destroyed || isCancelled(e) || this._receivers.get(path) !== receiver) return;
            this._warn(path, e.message);
            // Tried again at the next rescan.
            this._removeReceiver(path);
        }
    }

    _removeReceiver(path) {
        const receiver = this._receivers.get(path);
        if (!receiver) return;
        this._receivers.delete(path);
        receiver.node.destroy();
        if (receiver.devices.size > 0) this._onChanged();
    }

    // The receiver tells when a device goes on or off-line, Solaar turns this on too. The other flags are kept.
    async _enableConnectionNotifications(receiver) {
        try {
            const data = await receiver.node.request(Hidpp.getRegisterRequest(Hidpp.NOTIFICATIONS_REGISTER));
            const flags = (data[0] << 16) | (data[1] << 8) | data[2];
            if (flags & Hidpp.WIRELESS_NOTIFICATIONS) return;
            await receiver.node.request(Hidpp.setRegisterRequest(Hidpp.NOTIFICATIONS_REGISTER, flags | Hidpp.WIRELESS_NOTIFICATIONS));
        } catch (e) {
            if (e instanceof Hidpp.HidppError) {
                // Without them the batteries are still refreshed every REFRESH_INTERVAL.
                this._warn(receiver.node.path, `no connection notifications (${e.message})`);
            } else {
                throw e;
            }
        }
    }

    // Name, type and battery feature of the device at `index`, then its battery.
    // A device that does not answer is not paired, asleep or switched off. A known one keeps its last level.
    async _probe(receiver, index) {
        const node = receiver.node;
        try {
            const { major } = Hidpp.parseProtocolVersion(await node.request(Hidpp.pingRequest(index, node.reportId)));
            // HID++ 1.0 devices are older than the battery features.
            if (major < 2) return;

            const featureIndex = async feature => (await node.request(Hidpp.getFeatureRequest(index, feature, node.reportId)))[0];
            let battery = null;
            for (const feature of Hidpp.BATTERY_FEATURES) {
                const batteryIndex = await featureIndex(feature);
                if (batteryIndex) {
                    battery = { feature, index: batteryIndex };
                    break;
                }
            }
            if (!battery) return;

            const known = receiver.devices.get(index);
            const device = known ?? { name: null, type: null, battery, status: null };
            device.battery = battery;
            if (!known) {
                const nameIndex = await featureIndex(Hidpp.Feature.DEVICE_NAME);
                if (nameIndex) {
                    device.name = await this._readName(node, index, nameIndex);
                    device.type = (await node.call(index, nameIndex, 2))[0];
                }
                receiver.devices.set(index, device);
            }
            await this._readBattery(receiver, index);
        } catch (e) {
            if (this._destroyed || isCancelled(e) || e instanceof Hidpp.HidppError || e.message === 'timeout') return;
            throw e;
        }
    }

    // getDeviceNameCount, then getDeviceName from each offset until the name is complete.
    async _readName(node, index, nameIndex) {
        const length = (await node.call(index, nameIndex, 0))[0];
        const bytes = [];
        while (bytes.length < length) {
            const chunk = await node.call(index, nameIndex, 1, [bytes.length]);
            const part = [...chunk].slice(0, length - bytes.length);
            if (part.length === 0 || part.every(byte => byte === 0)) break;
            bytes.push(...part);
        }
        return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, '').trim();
    }

    async _readBattery(receiver, index) {
        const device = receiver.devices.get(index);
        if (!device) return;
        const { feature, index: featureIndex } = device.battery;
        try {
            const data = await receiver.node.call(index, featureIndex, Hidpp.BATTERY_FUNCTIONS[feature]);
            this._setStatus(device, Hidpp.BATTERY_PARSERS[feature](data));
        } catch {
            // Asleep, the last level stays.
        }
    }

    _setStatus(device, status) {
        const old = device.status;
        device.status = status;
        if (!old || old.percentage !== status.percentage || old.charge !== status.charge || old.low !== status.low)
            this._onChanged();
    }

    _onReport(receiver, report) {
        const notification = Hidpp.parseNotification(report);
        if (!notification) return;
        const { type, deviceIndex } = notification;
        const device = receiver.devices.get(deviceIndex);

        if (type === 'connection') {
            // Waking up may change the level, a new device is probed.
            if (notification.linkUp) this._probe(receiver, deviceIndex).catch(e => this._warn(receiver.node.path, e.message));
        } else if (type === 'unpaired') {
            if (receiver.devices.delete(deviceIndex)) this._onChanged();
        } else if (device && notification.featureIndex === device.battery.index && notification.fn === 0) {
            // The battery events of all three features have the layout of their status reply.
            this._setStatus(device, Hidpp.BATTERY_PARSERS[device.battery.feature](notification.data));
        }
    }

    destroy() {
        this._destroyed = true;
        GLib.Source.remove(this._rescanId);
        GLib.Source.remove(this._refreshId);
        this._receivers.forEach(receiver => receiver.node.destroy());
        this._receivers.clear();
    }
}
