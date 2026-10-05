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

// The pinned card stays during the exit and enter animations and grows into its card in the overlay and back.
// The card in the overlay does not move, it shows inside a frame between the pinned card and itself.
const inPlace = () => hardware.x === overlayX && hardware.y === overlayY && hardware.translation_x === 0 &&
    hardware.translation_y === 0 && hardware.scale_x === 1;
const growing = () => {
    const transition = gamebar._pinTransitions.get('system-monitor');
    const pinnedCard = pins.getPinned('system-monitor')._addonContainer;
    const frame = transition?._frame;
    return frame && pinnedCard.get_parent().get_parent() === transition.group && frame.y > hardware.y &&
        frame.y < pinnedCard.y && Math.abs(frame.y + frame.height - pinnedCard.y - pinnedCard.height) < 0.5 && hardware.has_clip;
};
// Sampled where the content of one card is clearly fading over the other, the transition eases in and out.
gamebar._toggleOverlay();
await sleep(settings.get_int('exit-animation-duration') * 2 / 3);
check(pins._layers[0].layer.visible, 'its pinned card shows during the exit animation');
check(inPlace() && growing() && hardware.opacity > 0 && hardware.opacity < 255,
    `and its card in the overlay shrinks into it in place (opacity ${hardware.opacity})`);
await closed();
check(gamebar._pinTransitions.size === 0 && hardware.get_parent() === gamebar._overlay && !hardware.has_clip &&
    pins.getPinned('system-monitor')._addonContainer.get_parent() === pins._layers[0].layer, 'and both are put back');
gamebar._openOverlay();
await sleep(settings.get_int('enter-animation-duration') / 3);
check(pins._layers[0].layer.visible, 'its pinned card shows during the enter animation');
check(inPlace() && growing() && hardware.opacity > 0 && hardware.opacity < 255,
    `and grows into its card in the overlay (opacity ${hardware.opacity})`);
await sleep(settings.get_int('enter-animation-duration') * 2 / 3 + 300);
check(!pins._layers[0].layer.visible && hardware.opacity === 255 && gamebar._pinTransitions.size === 0 &&
    hardware.get_parent() === gamebar._overlay, 'it is hidden once it has grown');
await close();

const { layer, addons } = pins._layers[0];
const pinned = addons[0]._addonContainer;
check(layer.visible && pinned.visible, 'and shown once the overlay is closed');
// The first row of the body, of the card in the overlay and of the pinned card.
const firstRow = container => container.get_first_child().get_last_child().get_first_child();
const [, rowY] = firstRow(hardware).get_transformed_position();
const [, pinnedRowY] = firstRow(pinned).get_transformed_position();
check(pinned.x === overlayX && pinnedRowY === rowY && pinned.y + pinned.height === overlayY + hardware.height,
    `where the card is in the overlay, with the content in the same place (${pinned.x}, ${pinnedRowY}, ${rowY})`);
await sleep(1500);
check(addons[0]._cpuRow?.usage.text !== '', `and it updates (CPU ${addons[0]._cpuRow?.usage.text})`);
const [x, y] = centre(pinned);
const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
check(!layer.contains(picked), `the pointer goes through it (${picked})`);
await shot('pinned-hardware', pinned);

settings.set_int('pinned-cards-opacity', 60);
await sleep(300);
check(pinned.opacity === 153, `the opacity setting fades it (${pinned.opacity})`);
await shot('pinned-hardware-faded', pinned);
settings.reset('pinned-cards-opacity');

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
