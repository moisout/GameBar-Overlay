// The preferences window, opened in the headless shell, and its shortcut row.
Main.extensionManager.openExtensionPrefs(this.uuid, '', {});
await sleep(5000);
const window = global.get_window_actors().map(actor => actor.meta_window).find(metaWindow => metaWindow.get_title() !== null);
check(!!window, `the preferences window opens (${window?.get_title()})`);

// The shortcut row is the last one of the first page, at the bottom of the window once scrolled down.
const frame = window.get_frame_rect();
const shortcutRow = [frame.x + frame.width / 2 - 60, frame.y + frame.height - 50];
await scroll([frame.x + frame.width / 2, frame.y + frame.height / 2], 8);
const shortcut = () => settings.get_strv('toggle-gamebar').join(' ');

await click(shortcutRow);
await chord(Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_k);
await sleep(500);
check(shortcut() === '<Control><Alt>k', `Ctrl+Alt+K is recorded (${shortcut()})`);

await click(shortcutRow);
await key(Clutter.KEY_k);
await shot('prefs-refused');
await sleep(300);
check(shortcut() === '<Control><Alt>k', `a key without a modifier is refused (${shortcut()})`);
await key(Clutter.KEY_Escape);

await click(shortcutRow);
await chord(Clutter.KEY_Super_L, Clutter.KEY_j);
await sleep(500);
check(shortcut() === '<Super>j', `Super+J is recorded (${shortcut()})`);

await chord(Clutter.KEY_Super_L, Clutter.KEY_j);
await sleep(800);
check(gamebar._isOpen, 'the recorded shortcut opens the overlay');
await chord(Clutter.KEY_Super_L, Clutter.KEY_j);
await closed();
check(!gamebar._isOpen, 'and closes it');

await click(shortcutRow);
await key(Clutter.KEY_BackSpace);
await sleep(500);
check(shortcut() === '', `Backspace disables the shortcut (${shortcut()})`);
await shot('prefs');
