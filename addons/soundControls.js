import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import Gio from 'gi://Gio';
import { positionAddon, makeDraggable, setCardHidden } from '../cardPosition.js';
import { DeviceSection } from './deviceSection.js';
import { setStreamVolume, toggleStreamMute } from './streamVolume.js';
import { createCard, createGroupTitle, BoxedList, createRow, createLabel, createIconButton } from '../card.js';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

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
        //Listeners:
        this._widthChangeId = null;
        this._heightChangeId = null;
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

        // Add the addon container to the overlay
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'sound');

        //Add the listeners for change width and height:

        this._widthChangeId = this._addonContainer.connect('notify::width', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
              this.set_addon_position();
              return GLib.SOURCE_REMOVE;
            });
          });
        
          this._heightChangeId = this._addonContainer.connect('notify::height', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
              this.set_addon_position();
              return GLib.SOURCE_REMOVE;
            });
          });
    }

    set_addon_position(){
        positionAddon(this._primaryMonitor, this._addonContainer, 'sound');
      }

    // Update all volume controls
    updateVolumeControls() {
        this._outputSection.sync();
        this._inputSection.sync();

        // Clear existing app volume controls
        this._appVolumesList.clear();

        // Get all audio streams (for app-specific volumes), skipping event streams
        this._volumeControl.get_sink_inputs()
            .filter(inputStream => !inputStream.is_event_stream)
            .forEach(inputStream => this._appVolumesList.addRow(this._createAppVolumeControl(inputStream)));

        this._appVolumesGroup.visible = !this._appVolumesList.isEmpty;
    }

    // Create a volume control for a specific app
    _getAppIcon(stream) {
        let icon = null;
        // Check if the stream has an icon saved in system icons:
        icon = this._getAppInfoIconFromStreamName(stream);
        if (icon) return icon;

        let iconName = stream.get_icon_name();
        if (iconName && iconName != 'application-x-executable') {
            icon = new Gio.ThemedIcon({ name: iconName});
            if (icon) return icon;
        }

        // Return generic if no icon found, symbolic like the other icons of the card:
        return new Gio.ThemedIcon({ name: 'application-x-executable-symbolic' });
    }
    
    _getAppInfoIconFromStreamName(stream) {
        const cleanString = (str) => {
            if (!str) return '';
            return str.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, '')
                .replace(/browser|player|viewer/g, '');
        };
    
        const calculateMatchScore = (str1, str2) => {
            const clean1 = cleanString(str1);
            const clean2 = cleanString(str2);
            if (clean1 === clean2) return 100;
            if (clean1.includes(clean2)) return 75;
            if (clean2.includes(clean1)) return 75;
            return 0;
        };
    
        const streamName = cleanString(stream.get_name());
        const streamIconName = cleanString(stream.get_icon_name());
        const allApps = Gio.AppInfo.get_all();
    
        let bestMatch = {
            app: null,
            score: 0
        };
    
        for (let app of allApps) {
            const appName = cleanString(app.get_display_name());
            const appId = cleanString(app.get_id());
    
            if (appName && streamName && stream.get_name()) {
                const nameScore = Math.max(
                    calculateMatchScore(appName, streamName),
                    calculateMatchScore(appId, streamName),
                    calculateMatchScore(appName, streamIconName),
                    calculateMatchScore(appId, streamIconName)
                );
    
                if (nameScore > bestMatch.score) {
                    bestMatch = {
                        app: app,
                        score: nameScore
                    };
                }
            }
        }
    
        if (bestMatch.app) {
            return bestMatch.app.get_icon();
        }
    
        return null;
    }
    
    // Create a volume control for a specific app
    _createAppVolumeControl(stream) {
        let row = createRow('gamebar-app-row');

        // Create an icon for the app
        let appIcon = new St.Icon({
            gicon: this._getAppIcon(stream),
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
        if(this._heightChangeId){
            this._addonContainer.disconnect(this._heightChangeId);
            this._heightChangeId = null;
        }
  
        if(this._widthChangeId){
            this._addonContainer.disconnect(this._widthChangeId);
            this._widthChangeId = null;
        }

        if (this._addonContainer) {
            this._addonContainer.destroy();
            this._addonContainer = null;
        }

        this._outputSection = null;
        this._inputSection = null;
        this._appVolumesGroup = null;
        this._appVolumesList = null;
        this._volumeControl = null;
    }
}