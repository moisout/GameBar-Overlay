// Taking a screenshot from the Capture card, and finding it on the Gallery card.
const capture = gamebar._capture;
const gallery = gamebar._gallery;
await openOverlay();

// The screenshot button is the first one of the card body.
const screenshotButton = capture._addonContainer.get_first_child().get_last_child().get_first_child();
await click(screenshotButton);
await closed();
check(!gamebar._isOpen && !gamebar._overlay.visible, 'the screenshot button closes the overlay');
await sleep(2500);

await openOverlay();
await sleep(3000);
const screenshots = gallery._library.getItems('screenshots');
check(screenshots.length === 1, `one screenshot is saved (${screenshots.map(item => item.path).join(', ')})`);
const tiles = gallery._grid.get_first_child()?.get_children().filter(child => child instanceof St.Button) ?? [];
check(tiles.length === 1, `the Gallery card shows it (${tiles.length} tiles)`);
check(tiles[0]?.style?.includes('background-image'), 'with a thumbnail');
await shot('gallery', gallery._addonContainer);
