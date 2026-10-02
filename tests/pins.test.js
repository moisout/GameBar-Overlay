// Pinning cards: they stay on the monitor while the overlay is closed and the pointer goes through them.
const card = id => gamebar._cards.find(other => other.id === id).addon._addonContainer;
const monitorKey = getMonitorKey(Main.layoutManager.primaryIndex);
const pinnedCards = () => settings.get_value('monitor-pinned-cards').deepUnpack()[monitorKey] ?? [];
const pins = gamebar._pins;
// The pin button is the first child of the start of the header bar.
const pinButton = id => card(id).get_first_child().get_first_child().get_first_child().get_first_child();
const close = async () => {
    gamebar._toggleOverlay();
    await closed();
};

await openOverlay();
const hardware = card('system-monitor');
const [overlayX, overlayY] = [hardware.x, hardware.y];
await click(pinButton('system-monitor'));
await sleep(300);
check(pinnedCards().includes('system-monitor') && pinButton('system-monitor').checked, 'the pin button pins the Hardware card');
check(pins._layers.length === 1 && !pins._layers[0].layer.visible, 'its pinned card is hidden while the overlay is open');
await close();

const { layer, addons } = pins._layers[0];
const pinned = addons[0]._addonContainer;
check(layer.visible && pinned.visible, 'and shown once the overlay is closed');
check(pinned.x === overlayX && pinned.y === overlayY, `where the card is in the overlay (${pinned.x}, ${pinned.y})`);
await sleep(1500);
check(addons[0]._cpuRow?.usage.text !== '', `and it updates (CPU ${addons[0]._cpuRow?.usage.text})`);
const [x, y] = centre(pinned);
const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
check(!layer.contains(picked), `the pointer goes through it (${picked})`);
await shot('pinned-hardware', pinned);

await pins.hideWhile(async () => check(!layer.visible, 'a screenshot hides it'));
check(layer.visible, 'and shows it again');

// The Clock has no header bar, its pin button shows up in its corner.
await openOverlay();
await moveTo(...centre(card('clock')));
await sleep(200);
const clockPin = card('clock').get_last_child();
check(clockPin.opacity === 255, 'the pin button of the Clock shows while the pointer is over it');
await click(clockPin);
await sleep(300);
check(pinnedCards().includes('clock'), 'and pins it');

await click(pinButton('discord'));
await sleep(300);
await close();

// The Discord client of the real session has no token here, its members are faked.
const discord = pins._layers[0].addons.find(addon => addon._client);
const client = discord._client;
client.connect = () => {};
const fake = {
    state: 'ready',
    channel: { name: 'General', guildName: 'Test' },
    members: [
        { id: '1', name: 'Maurice', avatarUrl: '', avatarKey: '1', speaking: true, muted: false, deafened: false },
        { id: '2', name: 'Alex', avatarUrl: '', avatarKey: '2', speaking: false, muted: true, deafened: false },
        { id: '3', name: 'Sam', avatarUrl: '', avatarKey: '3', speaking: false, muted: true, deafened: true },
    ],
};
for (const [name, value] of Object.entries(fake)) {
    Object.defineProperty(client, name, { get: () => value, set: () => {}, configurable: true });
}
discord._sync();
await sleep(300);
check(discord._addonContainer.visible && discord._addonContainer.get_n_children() === 3, 'the pinned Discord card lists the members');
await shot('pinned');

await openOverlay();
for (const id of ['system-monitor', 'discord']) await click(pinButton(id));
await click(card('clock').get_last_child());
await sleep(300);
check(pinnedCards().length === 0 && pins._layers.length === 0, 'unpinning removes the pinned cards');
await close();
