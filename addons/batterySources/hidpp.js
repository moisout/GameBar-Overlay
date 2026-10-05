import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// HID++, the protocol of Logitech receivers and devices, as far as the Battery card needs it.
// No shell imports: the preferences use the discovery too.
// The values follow Solaar (logitech_receiver), which reads the same devices.

export const SHORT_REPORT = 0x10;
export const LONG_REPORT = 0x11;
const REPORT_LENGTHS = { [SHORT_REPORT]: 7, [LONG_REPORT]: 20 };

// The device index of the receiver itself, and of a device connected by cable or Bluetooth.
export const RECEIVER_INDEX = 0xff;
// The paired devices of a receiver, Bolt and Unifying receivers have up to six.
export const MAX_SLOTS = 6;

// Ours in every HID++ 2.0 request, a reply carries it back. Events have 0.
export const SOFTWARE_ID = 0x0a;

export const Feature = {
    ROOT: 0x0000,
    DEVICE_NAME: 0x0005,
    BATTERY_STATUS: 0x1000,
    BATTERY_VOLTAGE: 0x1001,
    UNIFIED_BATTERY: 0x1004,
};

// The battery features in the order they are tried.
export const BATTERY_FEATURES = [Feature.UNIFIED_BATTERY, Feature.BATTERY_STATUS, Feature.BATTERY_VOLTAGE];

// HID++ 1.0 messages of the receiver.
const ERROR_10 = 0x8f;
const ERROR_20 = 0xff;
const SET_REGISTER = 0x80;
const GET_REGISTER = 0x81;
export const Notification = {
    // Address 0x02: the device was unpaired.
    DISCONNECT: 0x40,
    // The link of a paired device came up or went down.
    CONNECTION: 0x41,
};
const UNPAIRED = 0x02;
const LINK_DOWN = 0x40;

// The receiver tells about devices going on and off-line with this notification flag.
export const NOTIFICATIONS_REGISTER = 0x00;
export const WIRELESS_NOTIFICATIONS = 0x000100;

// getDeviceType of DEVICE_NAME.
export const DeviceType = {
    KEYBOARD: 0,
    REMOTE_CONTROL: 1,
    NUMPAD: 2,
    MOUSE: 3,
    TRACKPAD: 4,
    TRACKBALL: 5,
    PRESENTER: 6,
    RECEIVER: 7,
    HEADSET: 8,
    GAMEPAD: 12,
};

export const ChargeState = {
    UNKNOWN: 0,
    DISCHARGING: 1,
    CHARGING: 2,
    FULL: 3,
};

export class HidppError extends Error {
    constructor(code) {
        super(`HID++ error 0x${code.toString(16).padStart(2, '0')}`);
        this.code = code;
    }
}

// A report of the given type, padded to its length.
const frame = (reportId, bytes) => {
    const report = new Uint8Array(REPORT_LENGTHS[reportId]);
    report.set(bytes.slice(0, report.length));
    return report;
};

// Calls function `fn` of the feature at `featureIndex` of a HID++ 2.0 device.
export const featureRequest = (deviceIndex, featureIndex, fn, params = [], reportId = LONG_REPORT) =>
    frame(reportId, [reportId, deviceIndex, featureIndex, (fn << 4) | SOFTWARE_ID, ...params]);

// The protocol version of the device, a receiver answers it with a HID++ 1.0 error.
// The last byte is echoed back.
export const pingRequest = (deviceIndex, reportId = LONG_REPORT) => featureRequest(deviceIndex, 0, 1, [0, 0, 0x5a], reportId);

// The index of a feature on the device, 0 if the device does not have it.
export const getFeatureRequest = (deviceIndex, feature, reportId = LONG_REPORT) =>
    featureRequest(deviceIndex, 0, 0, [feature >> 8, feature & 0xff], reportId);

export const getRegisterRequest = (register) => frame(SHORT_REPORT, [SHORT_REPORT, RECEIVER_INDEX, GET_REGISTER, register]);

export const setRegisterRequest = (register, value) =>
    frame(SHORT_REPORT, [SHORT_REPORT, RECEIVER_INDEX, SET_REGISTER, register, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);

// The answer to a request: { data } with the bytes after the header, { error } with the error code, or null if the report
// answers something else. Replies can come in a short or a long report, whatever the request was.
export const matchReply = (request, report) => {
    if (report.length < 7 || report[1] !== request[1]) return null;
    if (report[2] === request[2] && report[3] === request[3]) return { data: report.slice(4) };
    if ((report[2] === ERROR_10 || report[2] === ERROR_20) && report[3] === request[2] && report[4] === request[3])
        return { error: report[5] };
    return null;
};

// A report nobody asked for: the connection notifications of a receiver and the events of the features of a device.
//   { type: 'connection', deviceIndex, linkUp } | { type: 'unpaired', deviceIndex }
//   { type: 'event', deviceIndex, featureIndex, fn, data }
export const parseNotification = (report) => {
    if (report.length < 7 || (report[0] !== SHORT_REPORT && report[0] !== LONG_REPORT)) return null;
    const [, deviceIndex, subId, address] = report;
    if (subId === Notification.CONNECTION)
        return { type: 'connection', deviceIndex, linkUp: !(report[4] & LINK_DOWN) };
    if (subId === Notification.DISCONNECT && address === UNPAIRED)
        return { type: 'unpaired', deviceIndex };
    // HID++ 1.0 notifications and replies have a sub ID of 0x40 or more, features have a lower index.
    if (subId > 0 && subId < Notification.DISCONNECT && (address & 0x0f) === 0)
        return { type: 'event', deviceIndex, featureIndex: subId, fn: address >> 4, data: report.slice(4) };
    return null;
};

export const parseProtocolVersion = (data) => ({ major: data[0], minor: data[1] });

// Solaar's estimate for the voltage of a lithium battery, in mV and percent.
const VOLTAGE_CURVE = [
    [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60], [3811, 50], [3778, 40],
    [3751, 30], [3717, 20], [3671, 10], [3646, 5], [3579, 2], [3500, 0],
];

export const voltageToPercentage = (millivolts) => {
    if (millivolts >= VOLTAGE_CURVE[0][0]) return VOLTAGE_CURVE[0][1];
    for (let i = 1; i < VOLTAGE_CURVE.length; i++) {
        const [lowVoltage, lowPercentage] = VOLTAGE_CURVE[i];
        const [highVoltage, highPercentage] = VOLTAGE_CURVE[i - 1];
        if (millivolts >= lowVoltage)
            return Math.round(lowPercentage + (highPercentage - lowPercentage) * (millivolts - lowVoltage) / (highVoltage - lowVoltage));
    }
    return 0;
};

// A battery below this is low, when the device does not say so itself.
const LOW_PERCENTAGE = 10;

// The battery from get_status of UNIFIED_BATTERY or its event: { percentage, charge, low }.
// Devices without a percentage only have a level, Solaar shows them as these percentages.
const UNIFIED_LEVELS = [[8, 90], [4, 50], [2, 20], [1, 5]];
const UNIFIED_CHARGE = [ChargeState.DISCHARGING, ChargeState.CHARGING, ChargeState.CHARGING, ChargeState.FULL];

export const parseUnifiedBattery = (data) => {
    const [stateOfCharge, level, status] = data;
    const percentage = stateOfCharge || (UNIFIED_LEVELS.find(([flag]) => level & flag)?.[1] ?? null);
    return { percentage, charge: UNIFIED_CHARGE[status] ?? ChargeState.UNKNOWN, low: (level & 0x03) !== 0 };
};

// The battery from BATTERY_STATUS. A level of 0 is unknown.
const STATUS_CHARGE = [ChargeState.DISCHARGING, ChargeState.CHARGING, ChargeState.CHARGING, ChargeState.FULL, ChargeState.CHARGING];

export const parseBatteryStatus = (data) => {
    const [level, , status] = data;
    return {
        percentage: level || null,
        charge: STATUS_CHARGE[status] ?? ChargeState.UNKNOWN,
        low: level > 0 && level <= LOW_PERCENTAGE,
    };
};

// The battery from BATTERY_VOLTAGE: the voltage in mV and flags, bit 7 for an external power source.
export const parseVoltage = (data) => {
    const millivolts = (data[0] << 8) | data[1];
    const flags = data[2];
    const percentage = voltageToPercentage(millivolts);
    let charge = ChargeState.DISCHARGING;
    if (flags & 0x80)
        charge = (flags & 0x03) === 1 ? ChargeState.FULL : ChargeState.CHARGING;
    return { percentage, charge, low: percentage <= LOW_PERCENTAGE || (flags & 0x20) !== 0 };
};

export const BATTERY_PARSERS = {
    [Feature.UNIFIED_BATTERY]: parseUnifiedBattery,
    [Feature.BATTERY_STATUS]: parseBatteryStatus,
    [Feature.BATTERY_VOLTAGE]: parseVoltage,
};

// The function that returns the battery: get_status is function 1 of UNIFIED_BATTERY, function 0 of the others.
export const BATTERY_FUNCTIONS = {
    [Feature.UNIFIED_BATTERY]: 1,
    [Feature.BATTERY_STATUS]: 0,
    [Feature.BATTERY_VOLTAGE]: 0,
};

const LOGITECH_VENDOR = 0x046d;
// Drivers of the kernel that already report the battery of the device to UPower.
const KERNEL_DRIVERS = ['logitech-hidpp-device'];

const contains = (bytes, sequence) => bytes.some((_, i) => sequence.every((byte, j) => bytes[i + j] === byte));

const readBytes = (path) => {
    try {
        return GLib.file_get_contents(path)[1];
    } catch {
        return null;
    }
};

// The /dev/hidraw* nodes of Logitech receivers and devices that speak HID++:
// [{ path, product, long, canAccess }], long if they take long reports.
// Nodes of devices the kernel driver handles are left out, UPower has those.
export const listHidppNodes = () => {
    const nodes = [];
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path('/sys/class/hidraw').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return nodes;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const uevent = readBytes(`/sys/class/hidraw/${name}/device/uevent`);
        if (!uevent) continue;
        const fields = Object.fromEntries(new TextDecoder().decode(uevent).split('\n').map(line => line.split('=')));
        // HID_ID=0003:0000046D:0000C548, the bus, the vendor and the product.
        const [, vendor, product] = (fields.HID_ID ?? '').split(':').map(part => parseInt(part, 16));
        if (vendor !== LOGITECH_VENDOR || KERNEL_DRIVERS.includes(fields.DRIVER)) continue;

        // The HID++ collection: the vendor usage page 0xFF00 with report 0x10 or 0x11.
        const descriptor = readBytes(`/sys/class/hidraw/${name}/device/report_descriptor`);
        if (!descriptor || !contains(descriptor, [0x06, 0x00, 0xff])) continue;
        const long = contains(descriptor, [0x85, LONG_REPORT]);
        if (!long && !contains(descriptor, [0x85, SHORT_REPORT])) continue;

        const path = `/dev/${name}`;
        let canAccess = false;
        try {
            const access = Gio.File.new_for_path(path).query_info('access::can-read,access::can-write', Gio.FileQueryInfoFlags.NONE, null);
            canAccess = access.get_attribute_boolean('access::can-read') && access.get_attribute_boolean('access::can-write');
        } catch {
            // Gone in the meantime.
            continue;
        }
        nodes.push({ path, product, long, canAccess });
    }
    return nodes.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
};
