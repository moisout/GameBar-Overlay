import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import { positionAddon, followCardSize, makeDraggable, setCardHidden } from '../cardPosition.js';
import { DeviceSection } from './deviceSection.js';
import { setStreamVolume, toggleStreamMute } from './streamVolume.js';
import { readFile } from '../utils.js';
import { vertical, createCard, createGroupTitle, BoxedList, createRow, createLabel, createIconButton } from '../card.js';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Icon names streams have when their app did not set one.
const GENERIC_ICONS = ['application-x-executable', 'applications-multimedia', 'audio-card', 'audio'];

// Seconds until a pactl that does not answer is ended.
const PACTL_TIMEOUT = 5;
// A stream often belongs to a helper process, the window to one of its parents.
const MAX_PARENTS = 4;

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const normalize = (name) => name?.trim().toLowerCase() ?? '';

const getParentPid = (pid) => {
    // The name of the program is in brackets and may contain spaces and brackets itself.
    const stat = readFile(`/proc/${pid}/stat`);
    return stat ? parseInt(stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[1]) : 0;
};

export class SoundControls {
    constructor(overlay, monitor) {
        this._overlay = overlay;
        this._monitor = monitor;
        this._volumeControl = Volume.getMixerControl();
        this._outputSection = null;
        this._inputSection = null;
        this._appVolumesGroup = null;
        this._appVolumesList = null;
        this._addonContainer = null;
        this._appStreamIds = null;
        this._appsByName = null;
        this._appRows = null;
        this._streamProperties = null;
        this._pactl = null;
        this._cancellable = null;
    }

    // Create the main volume controls
    _createVolumeControls() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        this._cancellable = new Gio.Cancellable();

        const { card, body } = createCard(_('Audio'), 'gamebar-audio-card', () => setCardHidden('sound', true));

        // Create the output and input device controls
        this._outputSection = new DeviceSection(this._volumeControl, 'output', _('Output'));
        this._inputSection = new DeviceSection(this._volumeControl, 'input', _('Input'));
        // The first group sits closer to the header bar.
        this._outputSection.title.add_style_class_name('gamebar-group-title-first');

        // Create a group for app-specific volume controls, hidden while no app plays audio
        this._appVolumesGroup = new St.BoxLayout({ ...vertical() });
        this._appVolumesList = new BoxedList();
        this._appVolumesGroup.add_child(createGroupTitle(_('Applications')));
        this._appVolumesGroup.add_child(this._appVolumesList.actor);

        body.add_child(this._outputSection.actor);
        body.add_child(this._inputSection.actor);
        body.add_child(this._appVolumesGroup);

        this._addonContainer.add_child(card);

        // Apps start and stop playing while the overlay is open. Disconnected when the card is destroyed.
        this._volumeControl.connectObject(
            'stream-added', () => this._syncApps(),
            'stream-removed', () => this._syncApps(),
            this._addonContainer);

        // Add the addon container to the overlay
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'sound');

followCardSize(this._addonContainer, () => this.set_addon_position());
    }

    set_addon_position(){
        positionAddon(this._monitor, this._addonContainer, 'sound');
      }

    // Called every time the overlay opens
    updateVolumeControls() {
        this._outputSection.sync();
        this._inputSection.sync();

        // Apps may have been installed since.
        this._appsByName = null;
        this._appStreamIds = null;
        this._syncApps();
    }

    // "System Sounds" like in GNOME Settings, then one row per app playing audio. The event sounds themselves
    // are left out, they follow the volume of System Sounds. Only rebuilt when the apps change, a row being
    // dragged is not destroyed by a volume change.
    _syncApps() {
        if (!this._appVolumesList || !this._overlay.visible) return;

        const apps = this._volumeControl.get_sink_inputs().filter(stream => !stream.is_event_stream);
        const systemSounds = this._volumeControl.get_event_sink_input();
        const streams = systemSounds ? [systemSounds, ...apps] : apps;
        const ids = streams.map(stream => stream.id).join(',');
        if (ids === this._appStreamIds) return;
        this._appStreamIds = ids;

        this._appVolumesList.clear();
        this._appRows = new Map();
        streams.forEach(stream => this._appVolumesList.addRow(this._createAppVolumeControl(stream)));
        this._appVolumesGroup.visible = streams.length > 0;
        if (apps.length > 0) this._readStreamProperties();
    }

    // Gvc only passes on the name a stream gives itself, which is the one of its audio library for many apps
    // (Discord is "WEBRTC VoiceEngine"). PulseAudio also knows the process, pactl tells it. The rows are shown
    // right away and get their app once pactl answered.
    async _readStreamProperties() {
        if (this._pactl || !GLib.find_program_in_path('pactl')) return;

        const ids = this._appStreamIds;
        let pactl;
        try {
            pactl = Gio.Subprocess.new(['pactl', '--format=json', 'list', 'sink-inputs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e);
            return;
        }
        this._pactl = pactl;
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PACTL_TIMEOUT, () => {
            pactl.force_exit();
            return GLib.SOURCE_CONTINUE;
        });

        try {
            const [stdout] = await pactl.communicate_utf8_async(null, this._cancellable);
            this._streamProperties = new Map(JSON.parse(stdout).map(input => [input.index, input.properties ?? {}]));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) logError(e);
            return;
        } finally {
            GLib.source_remove(timeoutId);
            if (this._pactl === pactl) this._pactl = null;
        }
        if (!this._appRows) return;

        this._appRows.forEach(row => this._syncAppRow(row));
        // The apps changed while pactl ran.
        if (ids !== this._appStreamIds) this._readStreamProperties();
    }

    _syncAppRow({ stream, appIcon, label }) {
        // Not a stream of an app, Gvc gives it the name and the icon GNOME Settings shows.
        if (stream === this._volumeControl.get_event_sink_input()) {
            appIcon.gicon = stream.get_gicon();
            label.text = stream.get_name();
            return;
        }

        const app = this._getApp(stream);
        appIcon.gicon = this._getAppIcon(stream, app);
        label.text = app?.get_name() || stream.get_name() || stream.get_description();
    }

    // The installed apps by their name, the name of their desktop file and of their program.
    _getAppsByName() {
        if (!this._appsByName) {
            this._appsByName = new Map();
            for (const app of Shell.AppSystem.get_default().get_installed()) {
                const id = app.get_id()?.replace(/\.desktop$/, '');
                const executable = app.get_executable();
                [app.get_name(), id, id?.split('.').pop(), executable ? GLib.path_get_basename(executable) : null]
                    .map(normalize)
                    .filter(name => name && !this._appsByName.has(name))
                    .forEach(name => this._appsByName.set(name, app));
            }
        }
        return this._appsByName;
    }

    // The app of a stream. In this order: the app id, if the app set one, the app with a window of the process
    // of the stream or of one of its parents, and the installed app with exactly the name of the program or of
    // the stream. Guessing from parts of the name gave apps the icon of another one.
    _getApp(stream) {
        const properties = this._streamProperties?.get(stream.index) ?? {};
        const sandboxed = 'pipewire.access.portal.app_id' in properties;

        const id = stream.get_application_id() || properties['pipewire.access.portal.app_id'];
        const app = id ? Shell.AppSystem.get_default().lookup_app(`${id}.desktop`) : null;
        if (app) return app;

        // The process id of a sandboxed app is the one inside its sandbox.
        let pid = sandboxed ? 0 : parseInt(properties['application.process.id']);
        for (let i = 0; i <= MAX_PARENTS && pid > 1; i++) {
            const windowApp = Shell.WindowTracker.get_default().get_app_from_pid(pid);
            if (windowApp) return windowApp;
            pid = getParentPid(pid);
        }

        const apps = this._getAppsByName();
        return apps.get(normalize(properties['application.process.binary'])) ?? apps.get(normalize(stream.get_name())) ?? null;
    }

    // The icon of the app, or the one the stream names.
    _getAppIcon(stream, app) {
        if (app?.get_icon()) return app.get_icon();

        const iconName = stream.get_icon_name();
        if (iconName && !GENERIC_ICONS.includes(iconName)) {
            return new Gio.ThemedIcon({ name: iconName });
        }

        // Symbolic like the other icons of the card.
        return new Gio.ThemedIcon({ name: 'application-x-executable-symbolic' });
    }

    // Create a volume control for a specific app
    _createAppVolumeControl(stream) {
        let row = createRow('gamebar-app-row');

        // Create an icon for the app
        let appIcon = new St.Icon({
            // The icon theme may not have the icon an app names.
            fallback_icon_name: 'application-x-executable-symbolic',
            icon_size: 24,
            y_align: Clutter.ActorAlign.CENTER
        });

        let label = createLabel('', 'gamebar-app-name');

        const appRow = { stream, appIcon, label };
        this._appRows.set(stream.id, appRow);
        this._syncAppRow(appRow);

        let muteButton = createIconButton('audio-volume-high-symbolic');
        muteButton.connect('clicked', () => toggleStreamMute(this._volumeControl, stream));

        // Create a volume slider for the app
        let slider = new Slider(0);
        slider.x_expand = true;

        let isSyncing = false;
        let isSettingVolume = false;

        // A muted app shows an empty slider and a grey name, like the quick settings.
        const syncFromStream = () => {
            // The slider already shows the volume being set, and the stream still reports the old mute state.
            if (isSettingVolume) {
                return;
            }

            isSyncing = true;
            slider.value = stream.is_muted ? 0 : stream.volume / this._volumeControl.get_vol_max_norm();
            isSyncing = false;

            const muted = stream.is_muted || slider.value <= 0;
            muteButton.child.icon_name = muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
            [muteButton, label].forEach(actor => {
                if (muted) {
                    actor.add_style_class_name('gamebar-dim');
                } else {
                    actor.remove_style_class_name('gamebar-dim');
                }
            });
        };

        slider.connect('notify::value', () => {
            if (!isSyncing) {
                isSettingVolume = true;
                setStreamVolume(this._volumeControl, stream, slider.value);
                isSettingVolume = false;
            }
        });

        // Disconnected automatically when the row is destroyed.
        stream.connectObject(
            'notify::volume', syncFromStream,
            'notify::is-muted', syncFromStream,
            row);
        syncFromStream();

        // Add all elements to the row
        row.add_child(appIcon);
        row.add_child(label);
        row.add_child(muteButton);
        row.add_child(slider);

        return row;
    }

    _updateSettings(settings) {
        this.destroy();
        this._volumeControl = Volume.getMixerControl();
        this._createVolumeControls();
        this.updateVolumeControls();
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._pactl = null;

        if (this._addonContainer) {
            this._addonContainer.destroy();
            this._addonContainer = null;
        }

        this._outputSection = null;
        this._inputSection = null;
        this._appVolumesGroup = null;
        this._appVolumesList = null;
        this._appRows = null;
        this._streamProperties = null;
        this._appsByName = null;
        this._volumeControl = null;
    }
}