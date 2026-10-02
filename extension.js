//Imports:
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { set_position_settings, isCardHidden } from './cardPosition.js';

//Addon Imports:
import {Clock} from './addons/clock.js';
import {SoundControls} from './addons/soundControls.js';
import {SystemMonitor} from './addons/systemMonitor.js';
import {Dash} from './addons/dash.js';
import {Capture} from './addons/capture.js';
import {Battery} from './addons/battery.js';
import {Music} from './addons/music.js';
import {Gallery} from './addons/gallery.js';
//TODO:: weather addon
//TODO:: brightness addon

function isGnome48OrNewer() {
    let version = Config.PACKAGE_VERSION.split('.').map(Number);
    return version[0] >= 48;
}
const MUTTER_SCHEMA = 'org.gnome.mutter';

// Closing a card or showing it again from the dash.
const CARD_TOGGLE_DURATION = 200;
const CARD_TOGGLE_SCALE = 0.9;

// Fly In and Fly Out: the cards start this much bigger, as if they were in front of the screen.
const FLY_SCALE = 1.3;
// Part of the animation duration the innermost card waits for the outer ones.
const FLY_STAGGER = 0.2;

const GameBar = GObject.registerClass(
class GameBar extends PanelMenu.Button {
    /**
     * Initializes a new instance of the GameBar class.
     * This constructor is called when a new instance of the class is created.
     * It initializes the properties and calls the necessary methods to set up the GameBar panel button.
     */
    _init() {
        // Call the parent class's _init method to initialize the instance
        super._init(0.0, 'GameBar');

        // Create a new St.Icon widget with the input-gaming-symbolic icon and add it as a child to the GameBar panel button
        this._icon = new St.Icon({
            icon_name: 'input-gaming-symbolic', // Set the icon name to 'input-gaming-symbolic'
            style_class: 'system-status-icon' // Add the 'system-status-icon' style class to the icon
        });
        this.add_child(this._icon);

        // Call the _createOverlay method to create the overlay widget and addons
        this._createOverlay();

        // Toggle the overlay when the GameBar panel button is clicked.
        // On GNOME 50 the panel button has a click gesture that claims the press, so 'button-press-event' is never emitted.
        if (this._clickGesture) {
            this._clickGesture.connect('recognize', () => this._toggleOverlay());
        } else {
            this.connect('button-press-event', this._toggleOverlay.bind(this));
        }

        this._mutterSettings = new Gio.Settings({'schema': MUTTER_SCHEMA});
        this._ignoreOverlayKeyChangedEvent = false;
    }

    /**
     * Creates the overlay widget and adds instances of addons.
     * The overlay widget is positioned and sized to cover the primary monitor.
     * The addons are instantiated with the overlay widget and the primary monitor.
     * The overlay widget is added to the layout manager to affect the input region.
     */
    _createOverlay() {
        // Get the primary monitor
        let primaryMonitor = Main.layoutManager.primaryMonitor;

        // The darkened background is a separate actor so it can fade independently of the addons.
        this._backdrop = new St.Widget({
            visible: false, // Start hidden
        });

        // Create the overlay widget
        this._overlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'gamebar-overlay', // CSS class for styling
            reactive: true, // Enable reactive handling of events
            can_focus: true, // Enable focus handling
            x_expand: true, // Expand horizontally to fill the width of the parent
            y_expand: true, // Expand vertically to fill the height of the parent
            visible: false, // Start hidden
        });


        this._updateOverlayGeometry(Main.layoutManager.primaryMonitor);

        // Create instances of addons and pass the overlay widget and the primary monitor
        this._clock = new Clock(this._overlay, primaryMonitor); // Clock addon
        this._soundControls = new SoundControls(this._overlay, primaryMonitor); // Sound controls addon
        this._systemMonitor = new SystemMonitor(this._overlay, primaryMonitor); // System Monitor stats addon
        this._capture = new Capture(this._overlay, primaryMonitor, callback => this._runWithOverlayClosed(callback)); // Screenshot and screencast buttons
        this._battery = new Battery(this._overlay, primaryMonitor); // Battery of the computer and connected devices
        this._music = new Music(this._overlay, primaryMonitor); // Controls of the media player that played last
        this._gallery = new Gallery(this._overlay, primaryMonitor, callback => this._runWithOverlayClosed(callback)); // The latest screenshots and recordings

        // The cards the dash shows and hides, in the order of its buttons
        this._cards = [
            { id: 'sound', name: _('Audio'), iconName: 'audio-volume-high-symbolic', addon: this._soundControls },
            { id: 'capture', name: _('Capture'), iconName: 'camera-photo-symbolic', addon: this._capture },
            { id: 'gallery', name: _('Gallery'), iconName: 'image-x-generic-symbolic', addon: this._gallery },
            { id: 'clock', name: _('Clock'), iconName: 'preferences-system-time-symbolic', addon: this._clock },
            { id: 'system-monitor', name: _('Hardware'), iconName: 'computer-symbolic', addon: this._systemMonitor },
            { id: 'battery', name: _('Battery'), iconName: 'battery-symbolic', addon: this._battery },
            { id: 'music', name: _('Music'), iconName: 'audio-x-generic-symbolic', addon: this._music },
        ];
        // Cards fading out after being closed, they are still visible until the animation ends.
        this._hidingCards = new Set();
        this._dash = new Dash(this._overlay, primaryMonitor, this._cards);

        // Add the overlay widget to the global stage to affect the input region.
        global.stage.add_child(this._backdrop);
        global.stage.add_child(this._overlay);

        // Connect to 'monitors-changed' signal to update overlay position and size
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            //TODO:: fix bug: when change to a diferent resolution monitor, the size wont update properly
            this._updateOverlayGeometry(Main.layoutManager.primaryMonitor);
        });

        // The cards and the gaps between them grow with the scale factor of the shell.
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleFactorChangedId = this._themeContext.connect('notify::scale-factor', () => {
            this._positionCards();
            this._dash.set_addon_position();
        });

        // Close the overlay when clicking on an empty area, the cards stop the clicks on them
        this._overlay.connect('button-release-event', () => {
            if (this._emptyAreaClose && this._overlay.visible) {
                this._toggleOverlay();
            }
        });

        // Connect to 'key-press-event' signal to close the overlay when ESC key is clicked
        this._overlay.connect('key-press-event', (actor, event) => {
            if (this._overlay.visible && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._toggleOverlay(); 
            }
        });
    }

    //Update overlay geometry
    _updateOverlayGeometry(primaryMonitor) {
        // The shell can start without a monitor, 'monitors-changed' calls this again once there is one.
        if (!primaryMonitor) return;

        this._overlay.set_position(primaryMonitor.x, primaryMonitor.y);
        this._overlay.set_size(primaryMonitor.width, primaryMonitor.height);
        this._overlay.hide();

        this._backdrop.set_position(primaryMonitor.x, primaryMonitor.y);
        this._backdrop.set_size(primaryMonitor.width, primaryMonitor.height);
        this._backdrop.hide();

        // The addons keep the monitor they were created with, which is null if the shell had no monitor yet.
        [...(this._cards ?? []).map(card => card.addon), this._dash].forEach(addon => {
            if (!addon) return;
            addon._primaryMonitor = primaryMonitor;
            addon.set_addon_position();
        });

    }

    _overrideOverlayKey() {
        if (!this._overlay.visible){
            return;
        }

        this.defaultOverlayKeyID = GObject.signal_handler_find(global.display, { signalId: 'overlay-key' });

        if (!this.defaultOverlayKeyID) {
            return;
        }

        GObject.signal_handler_block(global.display, this.defaultOverlayKeyID);

        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.ALL);
    }

    _restoreOverlayKey() {
        if (this.defaultOverlayKeyID) {
            GObject.signal_handler_unblock(global.display, this.defaultOverlayKeyID);
            this.defaultOverlayKeyID = null;
        }

        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }


    /**
     * Toggles the visibility of the overlay widget.
     * If the overlay is visible, it is hidden.
     * If the overlay is hidden, it is shown and the clock and volume controls are updated.
     */
    _toggleOverlay() {
        // Check if the overlay is visible
        if (this._overlay.visible) {
            // Unset key focus
            global.stage.set_key_focus(null);
            // If visible, hide the overlay
            this._hideOverlayWithAnimation();  // Use animation-based hiding

            // Enable unredirect back when the overlay is closed.
            if (isGnome48OrNewer()){
                // Enable unredirect for GNOME 48 and above.
                global.compositor.enable_unredirect();
            }else{
                // Enable unredirect for GNOME 47 and below.
                Meta.enable_unredirect_for_display(global.display);
            }

            //When this overlay is not visible, restore the default GNOME overlay toggle key
            this._restoreOverlayKey();

        } else {
            // The shell may have had no monitor when the overlay was created, so size it for the current one.
            if (!Main.layoutManager.primaryMonitor) return;
            this._updateOverlayGeometry(Main.layoutManager.primaryMonitor);

            // Disable unredirect before showing the overlay to prevent fullscreen windows from obstructing the overlay.
            if (isGnome48OrNewer()){
                // Enable unredirect for GNOME 48 and above.
                global.compositor.disable_unredirect();
            }else{
                // Disable unredirect for GNOME 47 and below.
                Meta.disable_unredirect_for_display(global.display);
            }

            // If not visible, show the overlay and update the clock and volume controls
            this._showOverlayWithAnimation();
            this._clock._updateClock();
            this._soundControls.updateVolumeControls();

            // Grab key focus
            global.stage.set_key_focus(this._overlay);

            //Override the GNOME-default overlay toggle key when this overlay is visible
            this._overrideOverlayKey();
        }
    }


    _showOverlayWithAnimation() {
        if (!this._overlay) return;

        // Reset all children to default state before showing
        this._resetOverlayChildren();
        // A card closed during an exit animation may still be visible.
        this._syncCardVisibility(false);

        this._overlay.show();

        const animationType = this._enterAnimation;
        const animationDuration = this._enterAnimationDuration;

        this._backdrop.remove_all_transitions();
        this._backdrop.show();
        if (animationType !== 'None') {
            this._backdrop.set_opacity(0);
            this._backdrop.ease({
                opacity: 255,
                duration: animationDuration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._backdrop.set_opacity(255);
        }

        if (animationType === 'Fade') {
            this._getShownChildren().forEach(child => {
                child.set_opacity(0);
                child.set_scale(0.8, 0.8);

                child.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    duration: animationDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
        } else if (animationType === 'Slide') {
            this._getShownChildren().forEach(child => {

                // Determine slide direction and initial position
                if (child.y < this._overlay.height / 3) {
                    child.set_translation(0, -child.height, 0);
                } else if (child.y > this._overlay.height * 2 / 3) {
                    child.set_translation(0, this._overlay.height, 0);
                } else if (child.x < this._overlay.width / 3) {
                    child.set_translation(-child.width, 0, 0);
                } else if (child.x > this._overlay.width * 2 / 3) {
                    child.set_translation(this._overlay.width, 0, 0);
                } else {
                    child.set_translation(0, -child.height, 0);
                }

                child.ease({
                    translation_x: 0,
                    translation_y: 0,
                    opacity: 255,
                    duration: animationDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
        } else if (animationType === 'Fly In') {
            // The outer cards land first.
            this._getFlyAnimations().forEach(({child, translationX, translationY, closeness}) => {
                child.set_opacity(0);
                child.set_scale(FLY_SCALE, FLY_SCALE);
                child.set_translation(translationX, translationY, 0);

                child.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    translation_x: 0,
                    translation_y: 0,
                    delay: closeness * FLY_STAGGER * animationDuration,
                    duration: (1 - FLY_STAGGER) * animationDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
        }
    }

    /**
     * Where every card starts for Fly In, and ends for Fly Out.
     * A card is scaled around the centre of the screen, so cards further out start further out,
     * like the app icons when unlocking an iPhone.
     * closeness is 0 for the outermost card and 1 for the innermost one.
     */
    _getFlyAnimations() {
        const centerX = this._overlay.width / 2;
        const centerY = this._overlay.height / 2;

        const cards = this._getShownChildren().map(child => {
            const offsetX = child.x + child.width / 2 - centerX;
            const offsetY = child.y + child.height / 2 - centerY;
            return {
                child,
                translationX: offsetX * (FLY_SCALE - 1),
                translationY: offsetY * (FLY_SCALE - 1),
                distance: Math.hypot(offsetX, offsetY),
            };
        });

        const maxDistance = Math.max(...cards.map(card => card.distance));
        const minDistance = Math.min(...cards.map(card => card.distance));
        cards.forEach(card => {
            card.closeness = maxDistance > minDistance ? (maxDistance - card.distance) / (maxDistance - minDistance) : 0;
        });
        return cards;
    }


    _hideOverlayWithAnimation() {
        if (!this._overlay) return;
        global.stage.set_key_focus(null);

        const animationType = this._exitAnimation;
        const animationDuration = this._exitAnimationDuration;

        if (animationType !== 'None') {
            this._backdrop.ease({
                opacity: 0,
                duration: animationDuration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._backdrop?.hide(),
            });
        } else {
            this._backdrop.hide();
        }

        if (animationType === 'Fade') {
            this._getShownChildren().forEach(child => {
                child.ease({
                    opacity: 0,
                    scale_x: 0.8,
                    scale_y: 0.8,
                    duration: animationDuration,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (this._overlay && this._getShownChildren().every(c => c.opacity === 0)) {
                            this._overlay.hide();
                        }
                    }
                });
            });
        } else if (animationType === 'Slide') {
            this._getShownChildren().forEach(child => {
                let translationX = 0;
                let translationY = 0;

                if (child.y < this._overlay.height / 3) {
                    translationY = -child.height;
                } else if (child.y > this._overlay.height * 2 / 3) {
                    translationY = this._overlay.height;
                } else if (child.x < this._overlay.width / 3) {
                    translationX = -child.width;
                } else if (child.x > this._overlay.width * 2 / 3) {
                    translationX = this._overlay.width;
                } else {
                    translationY = -child.height;
                }

                child.ease({
                    opacity: 0,
                    translation_x: translationX,
                    translation_y: translationY,
                    duration: animationDuration,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                    onComplete: () => {
                        if (this._overlay && this._getShownChildren().every(c => c.opacity === 0)) {
                            this._overlay.hide();
                        }
                    }
                });
            });
        } else if (animationType === 'Fly Out') {
            // The reverse of Fly In, the inner cards leave first.
            this._getFlyAnimations().forEach(({child, translationX, translationY, closeness}) => {
                child.set_pivot_point(0.5, 0.5);
                child.ease({
                    opacity: 0,
                    scale_x: FLY_SCALE,
                    scale_y: FLY_SCALE,
                    translation_x: translationX,
                    translation_y: translationY,
                    delay: (1 - closeness) * FLY_STAGGER * animationDuration,
                    duration: (1 - FLY_STAGGER) * animationDuration,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                    onComplete: () => {
                        if (this._overlay && this._getShownChildren().every(c => c.opacity === 0)) {
                            this._overlay.hide();
                        }
                    }
                });
            });
        } else { // None
            this._overlay.hide();
        }
    }

    _positionCards() {
        this._cards.forEach(({ addon }) => addon.set_addon_position());
    }

    // Closes the overlay and runs callback once the overlay and its backdrop are gone, so they are not in a screenshot.
    // Showing the overlay again before that cancels it.
    _runWithOverlayClosed(callback) {
        const waitForHidden = (actor, next) => {
            if (!actor.visible) {
                next();
                return;
            }
            const visibleChangedId = actor.connect('notify::visible', () => {
                actor.disconnect(visibleChangedId);
                if (!actor.visible) next();
            });
        };

        if (this._overlay.visible) {
            this._toggleOverlay();
        }
        waitForHidden(this._overlay, () => waitForHidden(this._backdrop, callback));
    }

    // The children the animations move, closed cards are hidden and left alone.
    _getShownChildren() {
        return this._overlay.get_children().filter(child => child.visible);
    }

    // Show the cards that are not closed and update the dots of the dash.
    _syncCardVisibility(animate) {
        animate &&= this._overlay.visible;

        this._cards.forEach(({ id, addon }) => {
            const container = addon._addonContainer;
            const shown = !isCardHidden(id);
            this._dash.sync(id, container !== null, shown);
            if (!container) return;

            const isShown = container.visible && !this._hidingCards.has(id);
            if (isShown === shown && animate) return;

            container.remove_all_transitions();
            this._hidingCards.delete(id);

            if (!animate) {
                container.visible = shown;
                return;
            }

            // Continue from where a running animation of the card is.
            container.set_pivot_point(0.5, 0.5);
            if (shown) {
                if (!container.visible) {
                    container.set_opacity(0);
                    container.set_scale(CARD_TOGGLE_SCALE, CARD_TOGGLE_SCALE);
                    container.show();
                }
                container.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    translation_x: 0,
                    translation_y: 0,
                    duration: CARD_TOGGLE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._hidingCards.add(id);
                container.ease({
                    opacity: 0,
                    scale_x: CARD_TOGGLE_SCALE,
                    scale_y: CARD_TOGGLE_SCALE,
                    duration: CARD_TOGGLE_DURATION,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        this._hidingCards.delete(id);
                        container.hide();
                        // The cards below it in its column move up.
                        this._positionCards();
                        container.set_opacity(255);
                        container.set_scale(1, 1);
                        container.set_translation(0, 0, 0);
                    },
                });
            }
        });

        // Cards in a column stack, they move when a card above them is shown or hidden.
        this._positionCards();
    }

    _resetOverlayChildren() {
        if (!this._overlay) return;

        this._overlay.get_children().forEach(child => {
            // A delayed card of a running exit animation would hide the overlay again.
            child.remove_all_transitions();
            child.set_opacity(255);
            child.set_scale(1, 1);
            child.set_pivot_point(0.5, 0.5);
            child.set_translation(0, 0, 0);
        });
    }


    /**
     * Loads the settings
     */
    _loadSettings(settings) {
        // Store the settings object
        this._settings = settings;

        // Update the settings of the addons with the new settings
        this._updateSettings(settings);
    }

    // Called when any settings has changed
    _onSettingsChanged(settings, key) {
        // A dragged addon is already in place, recreating every addon would only make them flicker.
        if (key === 'addon-positions') {
            this._positionCards();
            return;
        }

        // Closing a card or showing it from the dash only changes which cards are visible.
        if (key === 'hidden-cards') {
            this._syncCardVisibility(true);
            return;
        }

        //load the new settings:
        this._loadSettings(settings);
    }

    _updateSettings(settings) {
        set_position_settings(settings);

        //Update addons settings
        this._clock._updateSettings(settings);
        this._soundControls._updateSettings(settings);
        this._systemMonitor._updateSettings(settings);
        this._capture._updateSettings(settings);
        this._battery._updateSettings(settings);
        this._music._updateSettings(settings);
        this._gallery._updateSettings(settings);
        // The addons recreate their cards, which start visible and on top of the dash.
        this._syncCardVisibility(false);
        this._overlay.set_child_above_sibling(this._dash._addonContainer, null);
        this._emptyAreaClose = settings.get_boolean('overlay-empty-area-close');
        this._enterAnimation = settings.get_string('enter-animation');
        this._enterAnimationDuration = settings.get_int('enter-animation-duration');
        this._exitAnimation = settings.get_string('exit-animation');
        this._exitAnimationDuration = settings.get_int('exit-animation-duration');

        //Update overlay settings

        // TODO:: Overlay config styles
        const backgroundColor = settings.get_string('overlay-background-color');
        this._backdrop.style = `background-color: ${backgroundColor}`

    }

    /**
     * Destroys the GameBar extension.
     * This method is called when the extension is disabled or being removed.
     * It destroys the clock addon and calls the parent class's destroy method.
     */
    destroy() {
        // Call the addon destroy:
        this._clock?.destroy();
        this._clock = null;
        this._soundControls?.destroy();
        this._soundControls = null;
        this._systemMonitor?.destroy();
        this._systemMonitor = null;
        this._capture?.destroy();
        this._capture = null;
        this._battery?.destroy();
        this._battery = null;
        this._music?.destroy();
        this._music = null;
        this._gallery?.destroy();
        this._gallery = null;
        this._dash?.destroy();
        this._dash = null;
        this._cards = null;

        //Destroy overlay:
        this._overlay?.destroy();
        this._overlay = null;
        this._backdrop?.destroy();
        this._backdrop = null;
        set_position_settings(null);

        //Destroy other variables:
        this._icon?.destroy();
        this._icon = null;
        this._settings = null;

        //Destroy the signals:
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._scaleFactorChangedId) {
            this._themeContext.disconnect(this._scaleFactorChangedId);
            this._scaleFactorChangedId = null;
        }
        this._themeContext = null;

        // Call the parent class's destroy method
        super.destroy();
    }
});

export default class GameBarExtension extends Extension {
    /**
     * Enables the extension by adding the GameBar panel button and keybinding.
     * The keybinding allows the user to toggle the visibility of the overlay widget.
     */
    enable() {
        // Get the extension settings in a variable
        this._settings = this.getSettings('org.gnome.shell.extensions.gamebar-overlay');

        // Create a new instance of the GameBar class
        this._gamebar = new GameBar();

        // Add the GameBar panel button to the status area
        Main.panel.addToStatusArea(this.uuid, this._gamebar);

        this._settings.bind('show-indicator', this._gamebar, 'visible',
            Gio.SettingsBindFlags.DEFAULT);

        // Add a keybinding to toggle the visibility of the overlay widget
        this._addKeybinding();

        this._keybindId = this._settings.connect('changed::toggle-gamebar', () => {
            Main.wm.removeKeybinding('toggle-gamebar');
            this._addKeybinding();
        });

        // Connect to setting changes
        this._settingsChangedId = this._settings.connect('changed', this._gamebar._onSettingsChanged.bind(this._gamebar));

        // Initial load of settings
        this._gamebar._loadSettings(this._settings);
    }

    _addKeybinding() {
        Main.wm.addKeybinding(
            'toggle-gamebar',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._gamebar._toggleOverlay();
            }
        );
    }

    /**
     * Disables the extension by removing the keybinding and destroying the status area button.
     */
    disable() {
        // If the button exists, destroy it
        if (this._gamebar) {
            this._gamebar?.destroy();
            this._gamebar = null;
        }

        // Remove the keybinding
        Main.wm.removeKeybinding('toggle-gamebar');

        // Set the extension settings to null
        if (this._keybindId) {
            this._settings.disconnect(this._keybindId);
            this._keybindId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._settings = null;
    }
}
