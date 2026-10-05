// The sources of the Battery card: turned on and off by their settings, and their devices listed once.
const UPowerGlib = (await import('gi://UPowerGlib')).default;
const model = gamebar._batteryModel;
const card = gamebar._battery;
const container = card._addonContainer;
const texts = actor => actor instanceof St.Label ? [actor.text] : actor.get_children().flatMap(texts);
const shown = () => texts(card._body);

check(model._sources.has('upower') && !model._sources.has('logitech'), `UPower is on and Logitech off by default (${[...model._sources.keys()]})`);

settings.set_boolean('battery-source-upower', false);
await sleep(300);
check(model._sources.size === 0, 'turning UPower off stops it');
check(shown().includes('No devices with a battery'), `the card says there is no battery (${shown().join(', ')})`);

settings.set_boolean('battery-source-upower', true);
await sleep(1000);
check(model._sources.has('upower'), 'turning it on again starts it');
check(card._addonContainer === container, 'the card is not built again');

// Sources with devices, the keyboard is in both.
model._sources.forEach(source => source.destroy());
model._sources.clear();
const device = (name, kind, percentage, low = false, state = UPowerGlib.DeviceState.DISCHARGING) => ({ name, kind, percentage, low, state });
model._sources.set('upower', {
    computer: null,
    devices: [device('MX Keys for Business', UPowerGlib.DeviceKind.KEYBOARD, 50)],
    destroy() {},
});
model._sources.set('logitech', {
    computer: null,
    devices: [
        device('MX KEYS for Business', UPowerGlib.DeviceKind.KEYBOARD, 50),
        device('LIFT VERTICAL ERGONOMIC MOUSE', UPowerGlib.DeviceKind.MOUSE, 8, true),
        device('', UPowerGlib.DeviceKind.UNKNOWN, 30),
        device('MX Master 3S', UPowerGlib.DeviceKind.MOUSE, 9, true, UPowerGlib.DeviceState.CHARGING),
        device('PRO X Wireless', UPowerGlib.DeviceKind.HEADSET, 100, false, UPowerGlib.DeviceState.FULLY_CHARGED),
    ],
    destroy() {},
});
model._queueChanged();
await sleep(300);
const labels = shown();
check(labels.filter(text => text.toLowerCase() === 'mx keys for business').length === 1, `a device in two sources is listed once (${labels.join(', ')})`);
check(labels.includes('LIFT VERTICAL ERGONOMIC MOUSE') && labels.includes('8%') && labels.includes('Low battery'), 'the mouse of the second source is low');
check(labels.includes('Device') && labels.includes('30%'), 'a device without a name is called Device');
const after = name => labels[labels.indexOf(name) + 1];
check(after('MX Master 3S') === 'Charging' && labels.filter(text => text === 'Low battery').length === 1,
    `a low device that is charging says so instead of low (${after('MX Master 3S')})`);
check(after('PRO X Wireless') === 'Fully charged', `a full device says so (${after('PRO X Wireless')})`);
await openOverlay();
await shot('battery-sources', card._addonContainer);
