// Prints the Logitech devices the Battery card would show, without the shell:
//
//   gjs -m tests/hidppProbe.js [seconds]
//
// Runs the Logitech source for a while (10 s by default) and prints the devices every time they change.
import GLib from 'gi://GLib';
import { listHidppNodes } from '../addons/batterySources/hidpp.js';
import { LogitechSource } from '../addons/batterySources/logitech.js';

const seconds = parseInt(ARGV[0] ?? '10');
const loop = new GLib.MainLoop(null, false);

for (const node of listHidppNodes())
    print(`${node.path}: product ${node.product.toString(16).padStart(4, '0')}, ${node.long ? 'long' : 'short'} reports, ${node.canAccess ? 'accessible' : 'no access'}`);

const source = new LogitechSource(() => {
    print(`${(GLib.get_monotonic_time() / 1e6).toFixed(1)} s:`);
    for (const device of source.devices)
        print(`  ${device.name}: ${device.percentage}%, kind ${device.kind}, state ${device.state}${device.low ? ', low' : ''}`);
});

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
    source.destroy();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
