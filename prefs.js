import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { listGpus, getGpuModel, readFile } from './utils.js';

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
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
        settings.bind('enter-animation', enterAnimationRow, 'selected', Gio.SettingsBindFlags.DEFAULT);

        enterAnimationRow.connect('notify::selected', () => {
            const selectedIndex = enterAnimationRow.selected;
            const selectedValue = enterAnimationRow.model.get_string(selectedIndex);
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
        settings.bind('exit-animation', exitAnimationRow, 'selected', Gio.SettingsBindFlags.DEFAULT);

        exitAnimationRow.connect('notify::selected', () => {
            const selectedIndex = exitAnimationRow.selected;
            const selectedValue = exitAnimationRow.model.get_string(selectedIndex);
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
            settings.reset('addon-positions');
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

        //Custom Keyboard keybinding
        const shortcutComboValues = [
            'Super',
            'Shift',
            'Control',
            'Alt'
        ];
        
        const shortcutCombo = new Adw.ComboRow({
            title: _('First key'),
            model: new Gtk.StringList({strings: shortcutComboValues}),
        });

        shortcutCombo.set_selected(shortcutComboValues.indexOf(settings.get_string("toggle-gamebar-1")));
        
        keyBindingGroup.add(shortcutCombo);
        settings.bind('toggle-gamebar-1', shortcutCombo, 'selected', Gio.SettingsBindFlags.DEFAULT);

        shortcutCombo.connect('notify::selected', () => {
            const selectedIndex = shortcutCombo.selected;
            const selectedValue = shortcutCombo.model.get_string(selectedIndex);
            settings.set_string('toggle-gamebar-1', selectedValue);
            updateToggleGameBar();
        });

        const shortkeysValues = [
            'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 
            'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
            '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
            'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
            'Escape', 'Tab', 'CapsLock', 'Space', 
            'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Pause', 'ScrollLock'
        ];

        const shortkeys = new Adw.ComboRow({
            title: _('Last key'),
            model: new Gtk.StringList({strings: shortkeysValues}),
        });

        shortkeys.set_selected(shortkeysValues.indexOf(settings.get_string("toggle-gamebar-2")));
        keyBindingGroup.add(shortkeys);
        settings.bind('toggle-gamebar-2', shortkeys, 'selected', Gio.SettingsBindFlags.DEFAULT);

        shortkeys.connect('notify::selected', () => {
            const selectedIndex = shortkeys.selected;
            const selectedValue = shortkeys.model.get_string(selectedIndex);
            settings.set_string('toggle-gamebar-2', selectedValue);
            updateToggleGameBar();
        });


        function updateToggleGameBar() {
            const key1 = settings.get_string('toggle-gamebar-1');
            const key2 = settings.get_string('toggle-gamebar-2');
        
            const newShortcut = [`<${key1}>${key2}`];
            
            settings.set_value('toggle-gamebar', new GLib.Variant('as', newShortcut));
        }        
 
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
        settings.bind('cpu-temperature-unit', temperatureUnitRow, 'selected', Gio.SettingsBindFlags.DEFAULT);

        temperatureUnitRow.connect('notify::selected', () => {
            const selectedIndex = temperatureUnitRow.selected;
            const selectedValue = temperatureUnitRow.model.get_string(selectedIndex);
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
            ['disk-monitoring', _('Disk'), _('Used and total space of the root filesystem')],
            ['network-monitoring', _('Network'), _('Download and upload rate')],
        ].forEach(([key, title, subtitle]) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            rowsGroup.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        });

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
            const selectedIndex = gpuRow.selected;
            const [selectedDevice] = gpuList[selectedIndex];
            settings.set_string('gpu-device', selectedDevice);
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
    }
}
