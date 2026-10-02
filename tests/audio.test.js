// The Applications group of the Audio card follows the apps while the overlay is open.
const sound = gamebar._soundControls;
const rows = () => sound._volumeControl.get_sink_inputs().filter(stream => !stream.is_event_stream).length;
// Rows and the separators between them.
const shownRows = () => (sound._appVolumesList.actor.get_n_children() + 1) / 2;

await openOverlay();
const before = rows();
check(shownRows() === before || before === 0, `one row per app (${shownRows()} rows, ${before} streams)`);

const player = Gio.Subprocess.new(['pacat', '--raw', '--client-name=GameBar Test', '/dev/zero'], Gio.SubprocessFlags.NONE);
await sleep(1500);
check(rows() === before + 1 && shownRows() === before + 1, `an app that starts playing gets a row (${shownRows()} rows)`);
check(sound._appVolumesGroup.visible, 'and the group is shown');
await shot('audio', sound._addonContainer);

player.force_exit();
await sleep(1500);
check(shownRows() === before || before === 0, `and loses it when it stops (${before === 0 ? 0 : shownRows()} rows)`);
check(sound._appVolumesGroup.visible === before > 0, 'the group is hidden without apps');
