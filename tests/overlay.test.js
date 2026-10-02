// Opening and closing the overlay, the dash, closing and dragging cards.
const card = id => gamebar._cards.find(other => other.id === id).addon._addonContainer;
const state = () => `open=${gamebar._isOpen} visible=${gamebar._overlay.visible} modal=${Main.modalCount}`;

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
await click(musicButton);
await sleep(400);
check(!card('music').visible && settings.get_strv('hidden-cards').includes('music'), 'the dash button hides the Music card');
await click(musicButton);
await sleep(400);
check(card('music').visible && !settings.get_strv('hidden-cards').includes('music'), 'and shows it again');

// The close button is the last child of the header bar.
const closeButton = card('battery').get_first_child().get_first_child().get_last_child();
await click(closeButton);
await sleep(400);
check(!card('battery').visible, 'the close button hides the Battery card');
settings.reset('hidden-cards');
await sleep(400);

const clock = card('clock');
const [startX, startY] = [clock.x, clock.y];
await drag(clock, -200, 300);
check(Math.abs(clock.x - (startX - 200)) < 3 && Math.abs(clock.y - (startY + 300)) < 3,
    `dragging moves the Clock card (${clock.x - startX}, ${clock.y - startY})`);
check('clock' in settings.get_value('addon-positions').deepUnpack(), 'and saves its position');
check(gamebar._isOpen, 'and does not close the overlay');
await shot('dragged');

gamebar._toggleOverlay();
await closed();
check(!gamebar._overlay.visible && Main.modalCount === 0, `the shortcut closes it (${state()})`);
