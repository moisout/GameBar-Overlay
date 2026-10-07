// The Settings card: the opacity of the pinned cards, resetting the positions and the preferences.
const card = id => gamebar._cards.find(other => other.id === id).addon._addonContainer;
const monitorKey = getMonitorKey(Main.layoutManager.primaryIndex);
const positions = () => settings.get_value('monitor-card-positions').deepUnpack()[monitorKey] ?? {};
const settingsCard = gamebar._settingsCard;
showAllCards();

await openOverlay();
const header = card('settings').get_first_child().get_first_child();
check(card('settings').visible && !(header.get_first_child().get_first_child() instanceof St.Button) &&
    header.get_last_child().get_first_child() instanceof St.Button, 'the Settings card has a close button and no pin button');
check(gamebar._dash._buttons.has('settings'), 'and a button in the dash');
await shot('settings', card('settings'));

// Dragging the slider to its end, like the other sliders the value follows the pointer.
const slider = settingsCard._opacitySlider;
const [sliderX, sliderY] = slider.get_transformed_position();
await moveTo(sliderX + slider.width / 2, sliderY + slider.height / 2);
pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
await sleep(50);
await moveTo(sliderX + slider.width + 20, sliderY + slider.height / 2);
pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
await sleep(150);
check(settings.get_int('pinned-cards-opacity') === 100 && settingsCard._opacityLabel.text === '100%',
    `the slider sets the opacity of the pinned cards (${settings.get_int('pinned-cards-opacity')})`);
settings.set_int('pinned-cards-opacity', 40);
await sleep(100);
check(Math.abs(slider.value - 30 / 90) < 0.001 && settingsCard._opacityLabel.text === '40%' &&
    settings.get_int('pinned-cards-opacity') === 40, 'and follows the setting');
settings.reset('pinned-cards-opacity');

check(!settingsCard._resetButton.reactive, 'reset is off without a dragged card');
const clock = card('clock');
const [clockX, clockY] = [clock.x, clock.y];
await drag(clock, -200, 300);
check(settingsCard._resetButton.reactive && 'clock' in positions(), 'and on once a card was dragged');
await click(settingsCard._resetButton);
await sleep(300);
check(Object.keys(positions()).length === 0 && clock.x === clockX && clock.y === clockY && !settingsCard._resetButton.reactive,
    `reset moves it back (${clock.x}, ${clock.y})`);

let opened = false;
settingsCard._openPreferences = () => {
    opened = !gamebar._overlay.visible;
};
await click(settingsCard._addonContainer.get_first_child().get_last_child().get_last_child());
await closed();
check(opened && !gamebar._isOpen, 'More Settings closes the overlay and opens the preferences');
