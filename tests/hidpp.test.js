// The HID++ requests and the parsing of the replies, with reports recorded from a Logi Bolt receiver.
const Hidpp = await import('./addons/batterySources/hidpp.js');
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
const report = (...bytes) => {
    const padded = new Uint8Array(bytes[0] === Hidpp.LONG_REPORT ? 20 : 7);
    padded.set(bytes);
    return padded;
};

const ping = Hidpp.pingRequest(1);
check(hex(ping) === hex(report(0x11, 0x01, 0x00, 0x1a, 0x00, 0x00, 0x5a)), `the ping of device 1 (${hex(ping)})`);
const version = Hidpp.matchReply(ping, report(0x11, 0x01, 0x00, 0x1a, 0x04, 0x05, 0x5a));
check(version?.data && Hidpp.parseProtocolVersion(version.data).major === 4, `MX Keys answers with HID++ 4.5 (${JSON.stringify(version)})`);
check(Hidpp.matchReply(ping, report(0x11, 0x02, 0x00, 0x1a, 0x04, 0x05, 0x5a)) === null, 'the reply of another device is not the answer');
check(Hidpp.matchReply(ping, report(0x11, 0x01, 0x08, 0x00, 0x32, 0x04, 0x00)) === null, 'an event is not the answer');

const receiverPing = Hidpp.matchReply(Hidpp.pingRequest(Hidpp.RECEIVER_INDEX), report(0x10, 0xff, 0x8f, 0x00, 0x1a, 0x01, 0x00));
check(receiverPing?.error === 0x01, `the receiver answers the ping with a HID++ 1.0 error (${JSON.stringify(receiverPing)})`);
const asleep = Hidpp.matchReply(Hidpp.pingRequest(2), report(0x10, 0x02, 0x8f, 0x00, 0x1a, 0x09, 0x00));
check(asleep?.error === 0x09, `a device that is off answers with an error (${JSON.stringify(asleep)})`);

const getFeature = Hidpp.getFeatureRequest(1, Hidpp.Feature.UNIFIED_BATTERY);
check(hex(getFeature.slice(0, 6)) === '11 01 00 0a 10 04', `getFeature of UNIFIED_BATTERY (${hex(getFeature.slice(0, 6))})`);
const feature = Hidpp.matchReply(getFeature, report(0x11, 0x01, 0x00, 0x0a, 0x08, 0x00, 0x03));
check(feature?.data[0] === 8, 'UNIFIED_BATTERY is feature 8 of MX Keys');

const getRegister = Hidpp.getRegisterRequest(Hidpp.NOTIFICATIONS_REGISTER);
check(hex(getRegister) === '10 ff 81 00 00 00 00', `the notification flags are read with a short report (${hex(getRegister)})`);
const flags = Hidpp.matchReply(getRegister, report(0x10, 0xff, 0x81, 0x00, 0x00, 0x09, 0x00));
check(hex(flags.data) === '00 09 00', 'with wireless and software present set by Solaar');
const setRegister = Hidpp.setRegisterRequest(Hidpp.NOTIFICATIONS_REGISTER, 0x000100);
check(hex(setRegister) === '10 ff 80 00 00 01 00', `and written with a short report (${hex(setRegister)})`);

const unified = Hidpp.parseUnifiedBattery([50, 0x04, 0x00, 0x00]);
check(unified.percentage === 50 && unified.charge === Hidpp.ChargeState.DISCHARGING && !unified.low,
    `UNIFIED_BATTERY at 50% discharging (${JSON.stringify(unified)})`);
const levelOnly = Hidpp.parseUnifiedBattery([0, 0x02, 0x01, 0x01]);
check(levelOnly.percentage === 20 && levelOnly.charge === Hidpp.ChargeState.CHARGING && levelOnly.low,
    `a device with only a level, low and charging (${JSON.stringify(levelOnly)})`);
check(Hidpp.parseUnifiedBattery([100, 0x08, 0x03, 0x01]).charge === Hidpp.ChargeState.FULL, 'a full battery');

const status = Hidpp.parseBatteryStatus([0, 0, 0]);
check(status.percentage === null, 'BATTERY_STATUS with an unknown level');
check(Hidpp.parseBatteryStatus([8, 5, 0]).low, 'BATTERY_STATUS at 8% is low');

const voltages = [[4200, 100], [3811, 50], [3734, 25], [3500, 0], [3000, 0]]
    .map(([millivolts, percentage]) => [percentage, Hidpp.parseVoltage([millivolts >> 8, millivolts & 0xff, 0x00]).percentage]);
check(voltages.every(([expected, actual]) => expected === actual), `the voltages follow the curve of Solaar (${JSON.stringify(voltages)})`);
check(Hidpp.parseVoltage([0x0f, 0x00, 0x80]).charge === Hidpp.ChargeState.CHARGING &&
    Hidpp.parseVoltage([0x10, 0x5a, 0x81]).charge === Hidpp.ChargeState.FULL, 'charging and full by the voltage flags');

const linkDown = Hidpp.parseNotification(report(0x10, 0x02, 0x41, 0x10, 0x40, 0x82, 0x40));
check(linkDown?.type === 'connection' && !linkDown.linkUp && linkDown.deviceIndex === 2, `device 2 went off-line (${JSON.stringify(linkDown)})`);
check(Hidpp.parseNotification(report(0x10, 0x02, 0x41, 0x10, 0x00, 0x82, 0x40))?.linkUp, 'and came back');
check(Hidpp.parseNotification(report(0x10, 0x03, 0x40, 0x02, 0x00, 0x00, 0x00))?.type === 'unpaired', 'device 3 was unpaired');
const event = Hidpp.parseNotification(report(0x11, 0x01, 0x08, 0x00, 45, 0x04, 0x00, 0x00));
check(event?.type === 'event' && event.featureIndex === 8 && event.fn === 0 && event.data[0] === 45,
    `a battery event of feature 8 (${JSON.stringify(event)})`);
check(Hidpp.parseNotification(report(0x11, 0x01, 0x08, 0x1a, 45, 0x04, 0x00, 0x00)) === null, 'a reply to a request is not an event');

const nodes = Hidpp.listHidppNodes();
check(Array.isArray(nodes), `the nodes are listed (${nodes.map(node => node.path).join(', ') || 'none'})`);
