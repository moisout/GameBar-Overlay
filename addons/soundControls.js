import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import Gio from 'gi://Gio';
import { positionAddon, makeDraggable } from '../cardPosition.js';
import { DeviceSection } from './deviceSection.js';
import GLib from 'gi://GLib';

export class SoundControls {
    constructor(overlay, primaryMonitor) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._volumeControl = Volume.getMixerControl();
        this._outputSection = null;
        this._inputSection = null;
        this._appVolumesContainer = null;
        this._appVolumesBox = null;
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

        // Create a container for all volume controls
        this._appVolumesContainer = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style_class: 'gamebar-volume-container-global'
        });

        // Create the output and input device controls
        this._outputSection = new DeviceSection(this._volumeControl, 'output', this._icon_Size);
        this._inputSection = new DeviceSection(this._volumeControl, 'input', this._icon_Size);

        // Create a box for app-specific volume controls
        this._appVolumesBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        this._appVolumesContainer.add_child(this._outputSection.actor);
        this._appVolumesContainer.add_child(this._inputSection.actor);
        this._appVolumesContainer.add_child(this._appVolumesBox);

        this._addonContainer.add_child(this._appVolumesContainer)

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
        positionAddon(this._primaryMonitor, this._position, this._addonContainer, 'sound');
      }

    // Update all volume controls
    updateVolumeControls() {
        this._outputSection.sync();
        this._inputSection.sync();

        // Clear existing app volume controls
        this._appVolumesBox.destroy_all_children();
        
        // Get all audio streams (for app-specific volumes)
        let sinkInputs = this._volumeControl.get_sink_inputs();
        
        // Create volume controls for each app
        sinkInputs.forEach((inputStream, index) => {
            if (inputStream.is_event_stream) {
                return; // Skip event streams
            }
        
            // Create a box for label and volumeBox
            let labelBox = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START
            });
        
            // Create a label for the app name
            let label = new St.Label({
                text: inputStream.get_name() || inputStream.get_description(),
                y_align: Clutter.ActorAlign.CENTER
            });

            // Add the separator for only first item
            if (index == 0) {
                labelBox.add_child(new St.DrawingArea({
                    style_class: 'separator',
                    x_expand: true,
                }));
            }
        
            label.style_class = 'gamebar-app-volume-label';
            labelBox.add_child(label);
            labelBox.add_child(this._createAppVolumeControl(inputStream));
        
            // Add the separator except for the last item
            if (index < sinkInputs.length - 1) {
                labelBox.add_child(new St.DrawingArea({
                    style_class: 'separator',
                    x_expand: true,
                }));
            }
        
            this._appVolumesBox.add_child(labelBox);
        });        
    }

    // Create a volume control for a specific app
    _getAppIcon(stream) {
        let icon = null;
        let iconType = (this._iconType === 'Symbolic' ? '-symbolic' : '');
        
        // TODO:: Search for symbolic icons

        // Check if the stream has an icon saved in system icons:
        icon = this._getAppInfoIconFromStreamName(stream);
        if (icon) return icon;

        let iconName = stream.get_icon_name();
        if (iconName && iconName != 'application-x-executable') {
            icon = new Gio.ThemedIcon({ name: iconName});
            if (icon) return icon;
        }

        // Return generic if no icon found:
        return new Gio.ThemedIcon({ name: 'application-x-executable'+iconType });
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
        let container = new St.BoxLayout({
            style_class: 'gamebar-app-volume-control',
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER
        });
    
        let icon = this._getAppIcon(stream);
    
        // Create an icon for the app
        let APPicon = new St.Icon({
            style_class: 'gamebar-app-volume-icon',
            gicon: icon,
            icon_size: this._icon_Size
        });
    
        // Create a volume slider for the app
        let slider = new Slider(stream.volume / this._volumeControl.get_vol_max_norm());
        slider.set_style('width: 300px;'); //TODO:: make configurable

        let isSyncing = false;

        slider.connect('notify::value', () => {
            if (!isSyncing) {
                stream.volume = slider.value * this._volumeControl.get_vol_max_norm();
                stream.push_volume();
            }
        });

        let streamVolId = stream.connect('notify::volume', () => {
            isSyncing = true;
            slider.value = stream.volume / this._volumeControl.get_vol_max_norm();
            isSyncing = false;
        });

        container.connect('destroy', () => {
            if (streamVolId) {
                stream.disconnect(streamVolId);
            }
        });

    
        // Add all elements to the container
        container.add_child(APPicon);
        container.add_child(slider);
    
        return container;
    }
    

    _updateSettings(settings) {
        this._icon_Size = settings.get_int('sound-controls-icon-size');
        this._showAppDesc = settings.get_boolean('sound-controls-show-app-description');
        this._iconType = settings.get_string('sound-icon-type');
        this._position = settings.get_string('sound-addon-position');
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
        this._appVolumesBox = null;
        this._volumeControl = null;
        this._appVolumesContainer = null;
    }
}