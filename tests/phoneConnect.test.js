// The Phone Connect source of the Battery card, against a fake service on a connection of its own.
const { Gio, GLib } = imports.gi;
const card = gamebar._battery;
const model = gamebar._batteryModel;
const texts = actor => actor instanceof St.Label ? [actor.text] : actor.get_children().flatMap(texts);
const shown = () => texts(card._body);
const after = name => shown()[shown().indexOf(name) + 1];

const PHONE_XML = `
<node>
  <interface name="com.m0is.PhoneConnect.Phone">
    <property name="DeviceId" type="s" access="read"/>
    <property name="Name" type="s" access="read"/>
    <property name="Model" type="s" access="read"/>
    <property name="Status" type="a{sv}" access="read"/>
    <property name="LastClipboard" type="(st)" access="read"/>
  </interface>
</node>`;
const status = (level, charging) => ({
    ...(level === null ? {} : { BatteryLevel: new GLib.Variant('y', level) }),
    Charging: new GLib.Variant('b', charging),
});

const connection = Gio.DBusConnection.new_for_address_sync(
    Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null),
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
const manager = Gio.DBusObjectManagerServer.new('/com/m0is/PhoneConnect');
const phones = {};
const addPhone = (id, name, model, level, charging) => {
    const phone = { DeviceId: id, Name: name, Model: model, Status: status(level, charging), LastClipboard: ['', 0] };
    phone.exported = Gio.DBusExportedObject.wrapJSObject(PHONE_XML, phone);
    const object = Gio.DBusObjectSkeleton.new(`/com/m0is/PhoneConnect/phones/${id}`);
    object.add_interface(phone.exported);
    manager.export(object);
    phones[id] = phone;
};
const setStatus = (id, level, charging) => {
    phones[id].Status = status(level, charging);
    phones[id].exported.emit_property_changed('Status', new GLib.Variant('a{sv}', phones[id].Status));
};
addPhone('19B5AD50237C', 'OnePlus 13', 'OnePlus CPH2653', 81, false);
addPhone('0A0B0C0D0E0F', '', 'OPPO CPH2659', 12, false);
addPhone('FFEEDDCCBBAA', 'Find X8', '', null, false);
manager.set_connection(connection);

check(!model._sources.has('phone-connect'), 'Phone Connect is off by default');
settings.set_boolean('battery-source-upower', false);
settings.set_boolean('battery-source-phone-connect', true);
await sleep(500);
check(model._sources.has('phone-connect'), 'turning it on starts it');
check(shown().includes('No devices with a battery'), `without the service there are no phones (${shown().join(', ')})`);

const ownerId = Gio.bus_own_name_on_connection(connection, 'com.m0is.PhoneConnect.Daemon', Gio.BusNameOwnerFlags.NONE, null, null);
await sleep(800);
check(after('OnePlus 13') === '81%', `the phone is listed once the service is there (${shown().join(', ')})`);
check(shown().includes('OPPO CPH2659') && shown().includes('Low battery'), 'a phone without a name is named after its model and is low at 12%');
check(!shown().includes('Find X8'), 'a phone that has not told its level is not listed');

let redrawn = 0;
const changedId = model.connect('changed', () => redrawn++);
phones['19B5AD50237C'].LastClipboard = ['hello', 1];
phones['19B5AD50237C'].exported.emit_property_changed('LastClipboard', new GLib.Variant('(st)', ['hello', 1]));
await sleep(500);
check(redrawn === 0, `a change other than the battery does not redraw the card (${redrawn})`);

setStatus('0A0B0C0D0E0F', 13, true);
setStatus('FFEEDDCCBBAA', 100, true);
await sleep(500);
check(redrawn === 1, `a burst of changes redraws the card once (${redrawn})`);
model.disconnect(changedId);
check(after('OPPO CPH2659') === 'Charging' && !shown().includes('Low battery'), `a charging phone is not low (${after('OPPO CPH2659')})`);
check(after('Find X8') === 'Fully charged' && shown().includes('100%'), `a phone charging at 100% is full (${after('Find X8')})`);

await openOverlay();
await shot('battery-phone-connect', card._addonContainer);

manager.unexport('/com/m0is/PhoneConnect/phones/FFEEDDCCBBAA');
await sleep(500);
check(!shown().includes('Find X8'), 'a phone that disconnects goes away');

Gio.bus_unown_name(ownerId);
await sleep(500);
check(shown().includes('No devices with a battery'), `the phones go away with the service (${shown().join(', ')})`);
connection.close_sync(null);
