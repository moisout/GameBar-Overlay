import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { setStreamVolume, toggleStreamMute } from './streamVolume.js';
import { vertical, createGroupTitle, BoxedList, createSeparator, createRow, createLabel, createIconButton } from '../card.js';

// Expanding the device list animates like a submenu of the shell (js/ui/popupMenu.js).
const EXPAND_DURATION = 250;

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
        this._expanded = false;

        this.actor = new St.BoxLayout({ ...vertical() });
        this.title = createGroupTitle(title);
        this.actor.add_child(this.title);

        const list = new BoxedList();
        this.actor.add_child(list.actor);

        // Row with the name of the current device, opens the device list
        this._deviceLabel = createLabel('', 'gamebar-device-name', {
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });

        this._arrow = new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        });

        const deviceRow = createRow();
        deviceRow.add_child(new St.Label({ text: _('Device'), y_align: Clutter.ActorAlign.CENTER }));
        deviceRow.add_child(this._deviceLabel);
        deviceRow.add_child(this._arrow);

        this._deviceButton = new St.Button({
            style_class: 'gamebar-row-button gamebar-device-row',
            child: deviceRow,
            x_expand: true
        });
        this._deviceButton.connect('clicked', () => this._setExpanded(!this._expanded, true));
        list.addRow(this._deviceButton);

        // Every item adds its own separator, so the hidden list leaves no double line.
        this._deviceList = new St.BoxLayout({
            ...vertical(),
            visible: false,
            clip_to_allocation: true // Hides the items that do not fit yet while the list grows.
        });
        list.actor.add_child(this._deviceList);

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
            this._deviceLabel.text = this._getDeviceName(activeDevice);
        } else {
            this._deviceLabel.text = this._stream?.get_description() || this._kind.getEmptyLabel();
        }

        this._deviceList.destroy_all_children();
        devices.forEach(device => {
            let icon = new St.Icon({
                gicon: device.get_gicon(),
                fallback_icon_name: 'audio-card-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER
            });

            let label = createLabel(this._getDeviceName(device), '', { x_expand: true });

            let check = new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                opacity: device === activeDevice ? 255 : 0
            });

            let itemRow = createRow();
            itemRow.add_child(icon);
            itemRow.add_child(label);
            itemRow.add_child(check);

            let item = new St.Button({
                style_class: 'gamebar-row-button',
                child: itemRow,
                x_expand: true
            });

            const id = device.get_id();
            item.connect('clicked', () => {
                const selected = this._kind.lookupDevice(this._control, id);
                if (selected) {
                    this._kind.changeDevice(this._control, selected);
                }
                this._setExpanded(false, true);
            });

            this._deviceList.add_child(createSeparator());
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

    _setExpanded(expanded, animate = false) {
        this._expanded = expanded;

        // Continue from where a running animation is, it stops at its current height.
        this._deviceList.remove_all_transitions();
        this._arrow.remove_all_transitions();

        const duration = animate ? EXPAND_DURATION : 0;
        const mode = Clutter.AnimationMode.EASE_OUT_EXPO;

        if (expanded) {
            const startHeight = this._deviceList.visible ? this._deviceList.height : 0;
            this._deviceList.show();
            this._deviceList.set_height(-1);
            const [, naturalHeight] = this._deviceList.get_preferred_height(-1);
            this._deviceList.height = startHeight;
            this._deviceList.ease({
                height: naturalHeight,
                duration,
                mode,
                onComplete: () => this._deviceList.set_height(-1),
            });
        } else {
            this._deviceList.ease({
                height: 0,
                duration,
                mode,
                onComplete: () => {
                    this._deviceList.hide();
                    this._deviceList.set_height(-1);
                },
            });
        }

        // The down arrow turns to point up.
        this._arrow.ease({
            rotation_angle_z: expanded ? 180 : 0,
            duration,
            mode,
        });
    }
}
