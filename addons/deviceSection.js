import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { setStreamVolume, toggleStreamMute } from './streamVolume.js';
import { vertical, createGroupTitle, BoxedList, ChoiceRow, createRow, createIconButton } from '../card.js';

const KINDS = {
    output: {
        defaultChangedSignal: 'default-sink-changed',
        addedSignal: 'output-added',
        removedSignal: 'output-removed',
        activeUpdateSignal: 'active-output-update',
        getDefaultStream: control => control.get_default_sink(),
        getStreams: control => control.get_sinks(),
        lookupDevice: (control, id) => control.lookup_output_id(id),
        changeDevice: (control, device) => control.change_output(device),
        getQuickSettingsSlider: () => Main.panel.statusArea.quickSettings?._volumeOutput?._output,
        icons: ['audio-volume-muted-symbolic', 'audio-volume-low-symbolic', 'audio-volume-medium-symbolic', 'audio-volume-high-symbolic'],
        getEmptyLabel: () => _('No output device'),
    },
    input: {
        defaultChangedSignal: 'default-source-changed',
        addedSignal: 'input-added',
        removedSignal: 'input-removed',
        activeUpdateSignal: 'active-input-update',
        getDefaultStream: control => control.get_default_source(),
        getStreams: control => control.get_sources(),
        lookupDevice: (control, id) => control.lookup_input_id(id),
        changeDevice: (control, device) => control.change_input(device),
        getQuickSettingsSlider: () => Main.panel.statusArea.quickSettings?._volumeInput?._input,
        icons: ['microphone-sensitivity-muted-symbolic', 'microphone-sensitivity-low-symbolic', 'microphone-sensitivity-medium-symbolic', 'microphone-sensitivity-high-symbolic'],
        getEmptyLabel: () => _('No input device'),
    },
};

// Boxed list with a device picker and a mute button and volume slider for the default output or input device.
export class DeviceSection {
    constructor(control, kind, title) {
        this._control = control;
        this._kind = KINDS[kind];
        this._stream = null;
        this._isSyncingUI = false;
        this._isSettingVolume = false;

        this.actor = new St.BoxLayout({ ...vertical() });
        this.title = createGroupTitle(title);
        this.actor.add_child(this.title);

        const list = new BoxedList();
        this.actor.add_child(list.actor);

        // Row with the name of the current device, opens the device list
        this._deviceRow = new ChoiceRow(list, _('Device'));

        // Mute button and volume slider
        this._muteButton = createIconButton(this._kind.icons[3]);
        this._muteButton.connect('clicked', this._toggleMute.bind(this));

        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', this._onVolumeChanged.bind(this));

        const volumeRow = createRow('gamebar-row-leading-button');
        volumeRow.add_child(this._muteButton);
        volumeRow.add_child(this._slider);
        list.addRow(volumeRow);

        // Disconnected automatically when the actor is destroyed.
        this._control.connectObject(
            this._kind.defaultChangedSignal, () => this._syncStream(),
            this._kind.addedSignal, () => this._syncDevices(),
            this._kind.removedSignal, () => this._syncDevices(),
            this._kind.activeUpdateSignal, () => this._syncDevices(),
            this.actor);
    }

    // Called every time the overlay opens
    sync() {
        this._deviceRow.setExpanded(false);
        this._syncStream();
    }

    // Follow the default stream, it changes when another device is selected.
    _syncStream() {
        this._stream?.disconnectObject(this.actor);
        this._stream = this._kind.getDefaultStream(this._control);
        this._stream?.connectObject(
            'notify::volume', () => this._syncUIFromStream(),
            'notify::is-muted', () => this._syncUIFromStream(),
            this.actor);

        this._muteButton.reactive = this._stream !== null;
        this._slider.reactive = this._stream !== null;

        this._syncUIFromStream();
        this._syncDevices();
    }

    _syncUIFromStream() {
        // The slider already shows the volume being set, and the stream still reports the old mute state.
        if (this._isSettingVolume) {
            return;
        }

        // A muted stream shows an empty slider, like the quick settings.
        const muted = !this._stream || this._stream.is_muted;
        this._isSyncingUI = true;
        this._slider.value = muted ? 0 : this._stream.volume / this._control.get_vol_max_norm();
        this._isSyncingUI = false;

        this._updateIcon();
    }

    _onVolumeChanged() {
        if (this._stream && !this._isSyncingUI) {
            this._isSettingVolume = true;
            setStreamVolume(this._control, this._stream, this._slider.value);
            this._isSettingVolume = false;
            this._updateIcon();
        }
    }

    _toggleMute() {
        if (this._stream) {
            toggleStreamMute(this._control, this._stream);
        }
    }

    _updateIcon() {
        const [muted, low, medium, high] = this._kind.icons;
        const volume = this._slider.value;
        const isMuted = !this._stream || this._stream.is_muted || volume <= 0;
        let iconName;
        if (isMuted) {
            iconName = muted;
        } else if (volume <= 0.3) {
            iconName = low;
        } else if (volume <= 0.7) {
            iconName = medium;
        } else {
            iconName = high;
        }
        /** @type {St.Icon} */ (this._muteButton.child).icon_name = iconName;
        if (isMuted) {
            this._muteButton.add_style_class_name('gamebar-dim');
        } else {
            this._muteButton.remove_style_class_name('gamebar-dim');
        }
    }

    _getDevices() {
        let ids;

        // Gvc only announces devices with signals that fired before this extension was enabled,
        // so take the list the quick settings menu built from them.
        const quickSettingsDevices = this._kind.getQuickSettingsSlider()?._deviceItems;
        if (quickSettingsDevices instanceof Map && quickSettingsDevices.size > 0) {
            ids = [...quickSettingsDevices.keys()];
        } else {
            // Fallback, misses the devices on inactive profiles.
            ids = this._kind.getStreams(this._control)
                .map(stream => this._control.lookup_device_from_stream(stream)?.get_id())
                .filter(id => id !== undefined);
            ids = [...new Set(ids)];
        }

        return ids
            .map(id => this._kind.lookupDevice(this._control, id))
            .filter(device => device !== null);
    }

    _getDeviceName(device) {
        const description = device.get_description();
        const origin = device.get_origin();
        return origin ? `${description} – ${origin}` : description;
    }

    _syncDevices() {
        const devices = this._getDevices();
        const activeId = this._stream ? this._control.lookup_device_from_stream(this._stream)?.get_id() : undefined;
        const activeDevice = devices.find(device => device.get_id() === activeId);

        if (activeDevice) {
            this._deviceRow.value = this._getDeviceName(activeDevice);
        } else {
            this._deviceRow.value = this._stream?.get_description() || this._kind.getEmptyLabel();
        }

        this._deviceRow.setChoices(devices.map(device => {
            const id = device.get_id();
            return {
                id,
                name: this._getDeviceName(device),
                gicon: device.get_gicon(),
                active: device === activeDevice,
                select: () => {
                    const selected = this._kind.lookupDevice(this._control, id);
                    if (selected) {
                        this._kind.changeDevice(this._control, selected);
                    }
                },
            };
        }));
    }
}
