// The overlay opens on the monitor of the game, with the positions and closed cards of that monitor.
// Needs two monitors: MONITORS="1920x1080 1280x800" tests/run.sh tests/monitors.test.js
const monitors = Main.layoutManager.monitors;
if (monitors.length < 2) {
    check(false, `two monitors, there are ${monitors.length}`);
    return;
}
const card = id => gamebar._cards.find(other => other.id === id).addon._addonContainer;
const keys = monitors.map(monitor => getMonitorKey(monitor.index));
check(keys[0] !== keys[1], `the monitors have their own keys (${keys.join(', ')})`);
const on = index => gamebar._overlay.x === monitors[index].x && gamebar._overlay.width === monitors[index].width;
const hiddenCards = index => settings.get_value('monitor-hidden-cards').deepUnpack()[keys[index]] ?? [];
const positions = index => settings.get_value('monitor-card-positions').deepUnpack()[keys[index]] ?? {};
const centreOf = index => [monitors[index].x + monitors[index].width / 2, monitors[index].y + monitors[index].height / 2];
const close = async () => {
    gamebar._toggleOverlay();
    await closed();
};

// The headless shell has no windows, the focused window is faked.
global.display.get_focus_window = () => ({ get_monitor: () => 1 });
await moveTo(...centreOf(0));
await openOverlay();
check(on(1), 'the overlay opens on the monitor of the focused window');
await close();
delete global.display.get_focus_window;

await moveTo(...centreOf(1));
await openOverlay();
check(on(1), 'without a focused window it opens on the monitor of the pointer');
await click(gamebar._dash._buttons.get('music').button);
await sleep(400);
check(!card('music').visible && hiddenCards(1).includes('music') && !hiddenCards(0).includes('music'),
    'closing a card closes it on this monitor');
const clock = card('clock');
const [startX, startY] = [clock.x, clock.y];
await drag(clock, -100, 100);
check('clock' in positions(1) && !('clock' in positions(0)), 'a dragged card is saved for this monitor');
const [draggedX, draggedY] = [clock.x, clock.y];
await shot('monitor-1');
await close();

await moveTo(...centreOf(0));
await openOverlay();
check(on(0), 'on the other monitor');
check(card('music').visible, 'the card closed on the first monitor is shown');
await shot('monitor-0');
await close();

await moveTo(...centreOf(1));
await openOverlay();
check(on(1) && !card('music').visible, 'back on the first monitor the card is closed again');
check(clock.x === draggedX && clock.y === draggedY && (clock.x !== startX || clock.y !== startY),
    `and the dragged card is where it was dragged (${clock.x}, ${clock.y})`);
await close();
