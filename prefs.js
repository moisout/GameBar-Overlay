import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { listGpus, getGpuModel, readFile } from './utils.js';
import { listHidppNodes } from './addons/batterySources/hidpp.js';

export default class Preferences extends ExtensionPreferences {
    // Async since GNOME 47, it does not wait for anything.
    async fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.gamebar-overlay');

        // General Page
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'dialog-information-symbolic',
        });
        window.add(generalPage);

        // Appearance Group
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Configure the appearance of the extension'),
        });
        generalPage.add(appearanceGroup);

        // Show Indicator
        const showIndicatorRow = new Adw.SwitchRow({
            title: _('Show Indicator'),
            subtitle: _('Shows the GameBar Overlay indicator in the Top-Bar'),
        });
        appearanceGroup.add(showIndicatorRow);
        settings.bind('show-indicator', showIndicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        //Background color

        const colorButton = new Gtk.ColorButton();

        colorButton.use_alpha = true;

        const color = new Gdk.RGBA();
        color.parse(settings.get_string('overlay-background-color'));
        colorButton.set_rgba(color);

        colorButton.connect('color-set', () => {
            const newColor = colorButton.get_rgba().to_string();
            settings.set_string('overlay-background-color', newColor);
        });

        const overlayBackgroundColorRow = new Adw.ActionRow({
            title: _('Overlay background color'),
            activatable_widget: colorButton
        });


        overlayBackgroundColorRow.add_suffix(colorButton);
        appearanceGroup.add(overlayBackgroundColorRow);

        const pinnedOpacityRow = new Adw.SpinRow({
            title: _('Pinned Card Opacity'),
            subtitle: _('Opacity of the cards pinned over the windows, in percent'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        appearanceGroup.add(pinnedOpacityRow);
        settings.bind('pinned-cards-opacity', pinnedOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Animations
        const enterAnimationValues = ['None', 'Fade', 'Slide', 'Fly In'];
        const exitAnimationValues = ['None', 'Fade', 'Slide', 'Fly Out'];

        // Enter Animation
        const enterAnimationRow = new Adw.ComboRow({
            title: _('Enter Animation'),
            subtitle: _('Select the animation type to show when opening the overlay'),
            model: new Gtk.StringList({strings: enterAnimationValues}),
        });

        if (enterAnimationValues.indexOf(settings.get_string("enter-animation")) === -1) {
            settings.set_string("enter-animation", "None");
        }

        enterAnimationRow.set_selected(enterAnimationValues.indexOf(settings.get_string("enter-animation")));
        appearanceGroup.add(enterAnimationRow);

        enterAnimationRow.connect('notify::selected', () => {
            const selectedIndex = enterAnimationRow.selected;
            const selectedValue = enterAnimationValues[selectedIndex];
            settings.set_string('enter-animation', selectedValue);
        });

        // Enter Animation Duration
        const enterAnimationDurationRow = new Adw.SpinRow({
            title: _('Enter Animation Duration'),
            subtitle: _('Duration of the enter animation in milliseconds'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 5000,
                step_increment: 50,
                page_increment: 100,
            }),
        });
        appearanceGroup.add(enterAnimationDurationRow);
        settings.bind('enter-animation-duration', enterAnimationDurationRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Exit Animation
        const exitAnimationRow = new Adw.ComboRow({
            title: _('Exit Animation'),
            subtitle: _('Select the animation type to show when closing the overlay'),
            model: new Gtk.StringList({strings: exitAnimationValues}),
        });

        if (exitAnimationValues.indexOf(settings.get_string("exit-animation")) === -1) {
            settings.set_string("exit-animation", "None");
        }

        exitAnimationRow.set_selected(exitAnimationValues.indexOf(settings.get_string("exit-animation")));
        appearanceGroup.add(exitAnimationRow);

        exitAnimationRow.connect('notify::selected', () => {
            const selectedIndex = exitAnimationRow.selected;
            const selectedValue = exitAnimationValues[selectedIndex];
            settings.set_string('exit-animation', selectedValue);
        });

        // Exit Animation Duration
        const exitAnimationDurationRow = new Adw.SpinRow({
            title: _('Exit Animation Duration'),
            subtitle: _('Duration of the exit animation in milliseconds'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 5000,
                step_increment: 50,
                page_increment: 100,
            }),
        });
        appearanceGroup.add(exitAnimationDurationRow);
        settings.bind('exit-animation-duration', exitAnimationDurationRow, 'value', Gio.SettingsBindFlags.DEFAULT);



        // Behavior Group
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('Configure the behavior of the overlay'),
        }); 
        generalPage.add(behaviorGroup);

        // Close on Empty Area Click
        const emptyAreaCloseRow = new Adw.SwitchRow({
            title: _('Close on Empty Area Click'),
            subtitle: _('Close the overlay by clicking on an empty area'),
        });
        behaviorGroup.add(emptyAreaCloseRow);
        settings.bind('overlay-empty-area-close', emptyAreaCloseRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Reset dragged addon positions
        const resetPositionsButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });

        resetPositionsButton.connect('clicked', () => {
            settings.reset('monitor-card-positions');
        });

        const resetPositionsRow = new Adw.ActionRow({
            title: _('Addon Positions'),
            subtitle: _('Drag an addon in the overlay to move it. Reset moves every addon back to its default position'),
            activatable_widget: resetPositionsButton
        });

        resetPositionsRow.add_suffix(resetPositionsButton);
        behaviorGroup.add(resetPositionsRow);

        //Keybinding group

        const keyBindingGroup = new Adw.PreferencesGroup({
            title: _('Keybinding'),
            description: _('Configure the keybinding of the overlay'),
        }); 
        generalPage.add(keyBindingGroup);

        // The row records the next key combination pressed, like the shortcut rows of GNOME Settings.
        // The shortcuts of the shell are not held back while recording, the shell would ask for permission first.
        // They would clash with the overlay anyway.
        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const shortcutRow = new Adw.ActionRow({
            title: _('Shortcut'),
            activatable: true,
        });
        shortcutRow.add_suffix(shortcutLabel);
        keyBindingGroup.add(shortcutRow);

        const hint = _('Click to change it');
        const syncShortcut = () => {
            shortcutLabel.accelerator = settings.get_strv('toggle-gamebar')[0] ?? '';
            shortcutRow.subtitle = hint;
        };
        settings.connect('changed::toggle-gamebar', syncShortcut);
        syncShortcut();

        let keyController = null;
        const stopRecording = () => {
            if (!keyController) return;
            window.remove_controller(keyController);
            keyController = null;
            syncShortcut();
        };

        shortcutRow.connect('activated', () => {
            if (keyController) {
                stopRecording();
                return;
            }

            shortcutRow.subtitle = _('Press the new shortcut. Esc cancels, Backspace disables the shortcut');

            keyController = new Gtk.EventControllerKey({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
            keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
                const modifiers = state & Gtk.accelerator_get_default_mod_mask();
                const key = Gdk.keyval_to_lower(keyval);

                if (!modifiers && key === Gdk.KEY_Escape) {
                    stopRecording();
                } else if (!modifiers && key === Gdk.KEY_BackSpace) {
                    settings.set_strv('toggle-gamebar', []);
                    stopRecording();
                } else if (Gtk.accelerator_valid(key, modifiers)) {
                    // A key alone or with Shift would be taken from every app.
                    if (modifiers & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK)) {
                        settings.set_strv('toggle-gamebar', [Gtk.accelerator_name(key, modifiers)]);
                        stopRecording();
                    } else {
                        shortcutRow.subtitle = _('The shortcut needs Ctrl, Alt or Super');
                    }
                }
                // A modifier on its own is not a shortcut yet.
                return Gdk.EVENT_STOP;
            });
            window.add_controller(keyController);
        });
        window.connect('close-request', () => {
            stopRecording();
            return false;
        });

        // Clock Addon Page
        const clockPage = new Adw.PreferencesPage({
            title: _('Clock Addon'),
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(clockPage);

        const clockGroup = new Adw.PreferencesGroup({
            title: _('Clock Settings'),
            description: _('Configure the clock addon'),
        });
        clockPage.add(clockGroup);

        // Show Seconds
        const showSecondsRow = new Adw.SwitchRow({
            title: _('Show Seconds'),
            subtitle: _('Show seconds in the clock addon'),
        });
        clockGroup.add(showSecondsRow);
        settings.bind('clock-addon-show-seconds', showSecondsRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Font Size
        const fontSizeRow = new Adw.SpinRow({
            title: _('Font Size'),
            subtitle: _('Font size for the clock'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        clockGroup.add(fontSizeRow);
        settings.bind('clock-addon-font-size', fontSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // System Monitor addon page
        const monitorPage = new Adw.PreferencesPage({
            title: _('System Monitor'),
            icon_name: 'computer-symbolic',
        });
        window.add(monitorPage);

        const cpuGroup = new Adw.PreferencesGroup({
            title: _('System Monitor Settings'),
            description: _('Configure the System Monitor'),
        });
        monitorPage.add(cpuGroup);

        // Temperature Unit
        const temperatureUnitValues = ['C', 'F'];
        const temperatureUnitRow = new Adw.ComboRow({
            title: _('Temperature Unit'),
            subtitle: _('Select the temperature unit (Celsius or Fahrenheit)'),
            model: new Gtk.StringList({ strings: temperatureUnitValues }),
        });
        temperatureUnitRow.set_selected(temperatureUnitValues.indexOf(settings.get_string('cpu-temperature-unit')));
        cpuGroup.add(temperatureUnitRow);

        temperatureUnitRow.connect('notify::selected', () => {
            const selectedIndex = temperatureUnitRow.selected;
            const selectedValue = temperatureUnitValues[selectedIndex];
            settings.set_string('cpu-temperature-unit', selectedValue);
        });
    
        // Rows of the Hardware card, the GPU row is toggled in the GPU settings
        const rowsGroup = new Adw.PreferencesGroup({
            title: _('Rows'),
            description: _('Choose what the Hardware card shows'),
        });
        monitorPage.add(rowsGroup);

        [
            ['cpu-monitoring', _('CPU'), _('Usage and temperature')],
            ['memory-monitoring', _('Memory'), _('Used and total memory')],
            ['disk-monitoring', _('Disk'), _('Used and total space of the filesystem of the home folder')],
            ['network-monitoring', _('Network'), _('Download and upload rate')],
        ].forEach(([key, title, subtitle]) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            rowsGroup.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        });

        // Sampling while the overlay is closed, for people who want nothing to run while they play.
        const chartsGroup = new Adw.PreferencesGroup({ title: _('Charts') });
        monitorPage.add(chartsGroup);
        const backgroundRow = new Adw.SwitchRow({
            title: _('Sample in the Background'),
            subtitle: _('Keep the CPU and GPU usage while the overlay is closed, so the charts are filled when it opens'),
        });
        chartsGroup.add(backgroundRow);
        settings.bind('hardware-background-sampling', backgroundRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // GPU settings
        const gpuGroup = new Adw.PreferencesGroup({
            title: _('GPU Settings'),
            description: _('Configure the GPU monitor'),
        });
        monitorPage.add(gpuGroup);
        
        // Toggle GPU monitoring
        const gpuMonitoringRow = new Adw.SwitchRow({
            title: _('GPU Monitoring'),
            subtitle: _('Toggle GPU stats in the system monitor addon'),
        });

        gpuGroup.add(gpuMonitoringRow);
        settings.bind('gpu-monitoring', gpuMonitoringRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // GPU selector
        const gpuModel = new Gtk.StringList();
        const gpuList = listGpus();
        gpuList.forEach(([id]) => {
            gpuModel.append(getGpuModel(id));
        });

        const gpuRow = new Adw.ComboRow({
            title: _('GPU'),
            subtitle: _('Select which GPU to monitor'),
            model: gpuModel,
        });

        const currentGpu = settings.get_string('gpu-device');
        const index = gpuList.findIndex(([id]) => id === currentGpu);
        gpuRow.set_selected(index >= 0 ? index : 0);

        gpuRow.connect('notify::selected', () => {
            const selected = gpuList[gpuRow.selected];
            if (selected) {
                settings.set_string('gpu-device', selected[0]);
            }
        });
        gpuGroup.add(gpuRow);

        // Display a warning if hwdata is missing.
        if (readFile("/usr/share/hwdata/pci.ids") === null) {
            const hwdataRow = new Adw.ActionRow({
                title: _("'hwdata' not installed: can't get GPU name!")
            });

            const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
            const icon = new Gtk.Image({ iconName: "dialog-warning-symbolic" });
            icon.set_margin_end(10);
            box.append(icon);
            hwdataRow.add_prefix(box)
            gpuGroup.add(hwdataRow);
        }

        // Battery addon page
        const batteryPage = new Adw.PreferencesPage({
            title: _('Battery'),
            icon_name: 'battery-symbolic',
        });
        window.add(batteryPage);

        const sourcesGroup = new Adw.PreferencesGroup({
            title: _('Sources'),
            description: _('Choose where the Battery card reads the batteries from'),
        });
        batteryPage.add(sourcesGroup);

        [
            ['battery-source-upower', _('UPower'), _('The battery of this computer and the devices the system knows')],
            ['battery-source-logitech', _('Logitech Receivers'),
                _('Mice and keyboards on a Logi Bolt or Unifying receiver, read like Solaar does')],
        ].forEach(([key, title, subtitle]) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            sourcesGroup.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        });

        // A receiver needs the udev rule of Solaar, without it only root can open it.
        if (listHidppNodes().some(node => !node.canAccess)) {
            const accessRow = new Adw.ActionRow({
                title: _('No access to the Logitech receiver'),
                subtitle: _('Install Solaar or its udev rule 42-logitech-unify-permissions.rules, then plug the receiver in again'),
            });
            accessRow.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
            sourcesGroup.add(accessRow);
        }
    }
}
