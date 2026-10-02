// The level bars of the Hardware card are filled to their percentage.
await openOverlay();
await sleep(1500);
const monitor = gamebar._systemMonitor;
const bar = monitor._memoryRow.level;
const fraction = bar._fill.width / bar.actor.width;
const shown = parseInt(monitor._memoryRow.usage.text) / 100;
check(bar.actor.width > 50 && Math.abs(fraction - shown) < 0.02, `the memory bar is filled to its percentage (${bar._fill.width} of ${bar.actor.width} px, ${monitor._memoryRow.usage.text})`);
check(bar._fill.height === bar.actor.height && bar.actor.height > 0, `and as high as the bar (${bar.actor.height} px)`);
await shot('hardware', monitor._addonContainer);
await shot('battery', gamebar._battery._addonContainer);
