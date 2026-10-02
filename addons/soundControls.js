import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import { positionAddon, followCardSize, makeDraggable, setCardHidden } from '../cardPosition.js';
import { DeviceSection } from './deviceSection.js';
import { setStreamVolume, toggleStreamMute } from './streamVolume.js';
import { createCard, createGroupTitle, BoxedList, createRow, createLabel, createIconButton } from '../card.js';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Icon names streams have when their app did not set one.
const GENERIC_ICONS = ['application-x-executable', 'applications-multimedia', 'audio-card', 'audio'];

const normalize = (name) => name?.trim().toLowerCase() ?? '';

export class SoundControls {
    constructor(overlay, primaryMonitor) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._volumeControl = Volume.getMixerControl();
        this._outputSection = null;
        this._inputSection = null;
        this._appVolumesGroup = null;
        this._appVolumesList = null;
        this._addonContainer = null;
        this._appStreamIds = null;
        this._appsByName = null;
    }

    // Create the main volume controls
    _createVolumeControls() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(_('Audio'), 'gamebar-audio-card', () => setCardHidden('sound', true));

        // Create the output and input device controls
        this._outputSection = new DeviceSection(this._volumeControl, 'output', _('Output'));
        this._inputSection = new DeviceSection(this._volumeControl, 'input', _('Input'));
        // The first group sits closer to the header bar.
        this._outputSection.title.add_style_class_name('gamebar-group-title-first');

        // Create a group for app-specific volume controls, hidden while no app plays audio
        this._appVolumesGroup = new St.BoxLayout({ vertical: true });
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
        positionAddon(this._primaryMonitor, this._addonContainer, 'sound');
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

    // One row per app playing audio, without the event sounds. Only rebuilt when the apps change,
    // a row being dragged is not destroyed by a volume change.
    _syncApps() {
        if (!this._appVolumesList || !this._overlay.visible) return;

        const streams = this._volumeControl.get_sink_inputs().filter(stream => !stream.is_event_stream);
        const ids = streams.map(stream => stream.id).join(',');
        if (ids === this._appStreamIds) return;
        this._appStreamIds = ids;

        this._appVolumesList.clear();
        streams.forEach(stream => this._appVolumesList.addRow(this._createAppVolumeControl(stream)));
        this._appVolumesGroup.visible = streams.length > 0;
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

    // PulseAudio does not tell which app a stream belongs to. In this order: the app id, if the app set one,
    // the installed app with exactly the name of the stream, and the icon the app set. Guessing from parts
    // of the name gave apps the icon of another one.
    _getAppIcon(stream) {
        const id = stream.get_application_id();
        const app = id ? Shell.AppSystem.get_default().lookup_app(`${id}.desktop`) : null;
        if (app) return app.get_icon();

        const namedApp = this._getAppsByName().get(normalize(stream.get_name()));
        if (namedApp?.get_icon()) return namedApp.get_icon();

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
            gicon: this._getAppIcon(stream),
            // The icon theme may not have the icon an app names.
            fallback_icon_name: 'application-x-executable-symbolic',
            icon_size: 24,
            y_align: Clutter.ActorAlign.CENTER
        });

        let label = createLabel(stream.get_name() || stream.get_description(), 'gamebar-app-name');

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
        if (this._addonContainer) {
            this._addonContainer.destroy();
            this._addonContainer = null;
        }

        this._outputSection = null;
        this._inputSection = null;
        this._appVolumesGroup = null;
        this._appVolumesList = null;
        this._appsByName = null;
        this._volumeControl = null;
    }
}