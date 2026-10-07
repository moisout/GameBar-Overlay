// Opening and closing the overlay, the dash, closing and dragging cards.
const card = id => gamebar._cards.find(other => other.id === id).addon._addonContainer;
const state = () => `open=${gamebar._isOpen} visible=${gamebar._overlay.visible} modal=${Main.modalCount}`;
const monitorKey = getMonitorKey(Main.layoutManager.primaryIndex);
const hiddenCards = () => settings.get_value('monitor-hidden-cards').deepUnpack()[monitorKey] ?? [];
// The places of the other cards, which must not move when a card is dragged, closed or shown.
const places = except => gamebar._cards.filter(({ id, addon }) => id !== except && addon._addonContainer?.visible)
    .map(({ id, addon }) => `${id} ${addon._addonContainer.x},${addon._addonContainer.y}`).join(' ');

check(hiddenCards().length === 0 && !card('gallery').visible && !card('discord').visible && !card('settings').visible &&
    card('music').visible, 'the Gallery, Discord and Settings cards are hidden by default');

await openOverlay();
check(gamebar._isOpen && gamebar._overlay.visible && Main.modalCount === 1, `the overlay opens (${state()})`);
await shot('overlay');

await key(Clutter.KEY_Escape);
await closed();
check(!gamebar._isOpen && !gamebar._overlay.visible && Main.modalCount === 0, `Esc closes it (${state()})`);

await openOverlay();
// Right of the dash and below the Hardware card.
await click([1700, 1000]);
await closed();
check(!gamebar._overlay.visible, `a click on an empty area closes it (${state()})`);

await openOverlay();
await click(card('music'));
check(gamebar._isOpen, 'a click on a card does not close it');

const musicButton = gamebar._dash._buttons.get('music').button;
const beforeHiding = places('music');
await click(musicButton);
await sleep(400);
check(!card('music').visible && hiddenCards().includes('music'), 'the dash button hides the Music card');
check(places('music') === beforeHiding, 'and the other cards stay where they are');
await click(musicButton);
await sleep(400);
check(card('music').visible && !hiddenCards().includes('music') && hiddenCards().includes('discord'),
    'and shows it again, Discord stays hidden');

// The close button is the last child of the header bar.
const closeButton = card('battery').get_first_child().get_first_child().get_last_child();
await click(closeButton);
await sleep(400);
check(!card('battery').visible, 'the close button hides the Battery card');
settings.reset('monitor-hidden-cards');
await sleep(400);

const clock = card('clock');
const [startX, startY] = [clock.x, clock.y];
const beforeDrag = places('clock');
await drag(clock, -200, 300);
check(places('clock') === beforeDrag, 'dragging a card leaves the other cards where they are');
check(Math.abs(clock.x - (startX - 200)) < 3 && Math.abs(clock.y - (startY + 300)) < 3,
    `dragging moves the Clock card (${clock.x - startX}, ${clock.y - startY})`);
check('clock' in (settings.get_value('monitor-card-positions').deepUnpack()[monitorKey] ?? {}), `and saves its position for ${monitorKey}`);
check(gamebar._isOpen, 'and does not close the overlay');
await shot('dragged');

gamebar._toggleOverlay();
await closed();
check(!gamebar._overlay.visible && Main.modalCount === 0, `the shortcut closes it (${state()})`);

// The button opens the overlay on the press, the release of the same click is not a click on the empty area.
// It came to the overlay for a quick click and for one held until the overlay was there.
for (const hold of [0, 300, 700]) {
    await moveTo(...centre(gamebar));
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(hold);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(settings.get_int('enter-animation-duration') + 300);
    check(gamebar._isOpen, `a click held ${hold} ms on the top bar button opens the overlay (${state()})`);
    await key(Clutter.KEY_Escape);
    await closed();
}

// During the exit animation the click goes to the top bar button below the overlay.
await openOverlay();
gamebar._toggleOverlay();
await sleep(100);
await click(gamebar);
await sleep(settings.get_int('enter-animation-duration') + 300);
check(gamebar._isOpen, `a click on the top bar button during the exit animation opens it again (${state()})`);
await key(Clutter.KEY_Escape);
await closed();
