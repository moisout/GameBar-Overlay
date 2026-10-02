// The clock follows the clock format of GNOME.
const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
await openOverlay();
const time = () => gamebar._clock._timeLabel.text;
check(/^\d\d:\d\d$/.test(time()), `24 hours by default (${time()})`);
interfaceSettings.set_string('clock-format', '12h');
await sleep(1200);
check(/^\d?\d:\d\d [AP]M$/i.test(time()), `12 hours with the setting (${time()})`);
settings.set_boolean('clock-addon-show-seconds', true);
await sleep(1200);
check(/^\d?\d:\d\d:\d\d [AP]M$/i.test(time()), `with seconds (${time()})`);
await shot('clock', gamebar._clock._addonContainer);
