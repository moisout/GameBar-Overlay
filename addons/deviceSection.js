import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

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

// Mute button, volume slider and device selector for the default output or input device.
export class DeviceSection {
    constructor(control, kind, iconSize) {
        this._control = control;
        this._kind = KINDS[kind];
        this._stream = null;
        this._isSyncingUI = false;
        // Long device names are ellipsized to the width of the icon and slider row instead of widening the card.
        this._deviceStyle = `max-width: ${iconSize + 10 + 300 - 20}px;`;

        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: false, // Keeps the expanding labels from stretching the card over the whole overlay.
            style_class: 'gamebar-device-section'
        });

        // Mute button and volume slider
        let volumePanel = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER
        });

        this._muteButton = new St.Button({
            child: new St.Icon({
                icon_name: this._kind.icons[3],
                style_class: 'gamebar-volume-icon',
                icon_size: iconSize
            })
        });
        this._muteButton.connect('clicked', this._toggleMute.bind(this));

        this._slider = new Slider(0);
        this._slider.set_style('width: 300px;');
        this._slider.connect('notify::value', this._onVolumeChanged.bind(this));

        volumePanel.add_child(this._muteButton);
        volumePanel.add_child(this._slider);

        // Button with the name of the current device, opens the device list
        this._deviceLabel = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._deviceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._arrow = new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 16
        });

        let deviceBox = new St.BoxLayout({ vertical: false, x_expand: true });
        deviceBox.add_child(this._deviceLabel);
        deviceBox.add_child(this._arrow);

        this._deviceButton = new St.Button({
            style_class: 'gamebar-device-button',
            style: this._deviceStyle,
            child: deviceBox,
            x_expand: true
        });
        this._deviceButton.connect('clicked', () => this._setExpanded(!this._deviceList.visible));

        this._deviceList = new St.BoxLayout({
            vertical: true,
            style_class: 'gamebar-device-list',
            visible: false
        });

        this.actor.add_child(volumePanel);
        this.actor.add_child(this._deviceButton);
        this.actor.add_child(this._deviceList);

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
        this._setExpanded(false);
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
        this._isSyncingUI = true;
        this._slider.value = this._stream ? this._stream.volume / this._control.get_vol_max_norm() : 0;
        this._isSyncingUI = false;

        this._updateIcon();
    }

    _onVolumeChanged() {
        if (this._stream && !this._isSyncingUI) {
            this._stream.volume = this._slider.value * this._control.get_vol_max_norm();
            this._stream.push_volume();
            this._updateIcon();
        }
    }

    _toggleMute() {
        if (this._stream) {
            this._stream.change_is_muted(!this._stream.is_muted);
        }
    }

    _updateIcon() {
        const [muted, low, medium, high] = this._kind.icons;
        const volume = this._slider.value;
        let iconName;
        if (!this._stream || this._stream.is_muted || volume <= 0) {
            iconName = muted;
        } else if (volume <= 0.3) {
            iconName = low;
        } else if (volume <= 0.7) {
            iconName = medium;
        } else {
            iconName = high;
        }
        this._muteButton.child.icon_name = iconName;
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
            this._deviceLabel.text = this._getDeviceName(activeDevice);
        } else {
            this._deviceLabel.text = this._stream?.get_description() || this._kind.getEmptyLabel();
        }

        this._deviceList.destroy_all_children();
        devices.forEach(device => {
            let icon = new St.Icon({
                style_class: 'gamebar-device-item-icon',
                gicon: device.get_gicon(),
                fallback_icon_name: 'audio-card-symbolic',
                icon_size: 16
            });

            let label = new St.Label({
                text: this._getDeviceName(device),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            let itemBox = new St.BoxLayout({ vertical: false, x_expand: true });
            itemBox.add_child(icon);
            itemBox.add_child(label);

            let item = new St.Button({
                style_class: 'gamebar-device-item',
                style: this._deviceStyle,
                child: itemBox,
                x_expand: true
            });
            if (device === activeDevice) {
                item.add_style_pseudo_class('checked');
            }

            const id = device.get_id();
            item.connect('clicked', () => {
                const selected = this._kind.lookupDevice(this._control, id);
                if (selected) {
                    this._kind.changeDevice(this._control, selected);
                }
                this._setExpanded(false);
            });

            this._deviceList.add_child(item);
        });

        // Nothing to choose from with a single device
        const canChoose = devices.length > 1;
        this._deviceButton.reactive = canChoose;
        this._arrow.visible = canChoose;
        if (!canChoose) {
            this._setExpanded(false);
        }
    }

    _setExpanded(expanded) {
        this._deviceList.visible = expanded;
        this._arrow.icon_name = expanded ? 'pan-up-symbolic' : 'pan-down-symbolic';
    }
}
