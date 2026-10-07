//Imports:
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { set_position_settings, setCardMonitor, POSITIONS_KEY, HIDDEN_KEY, PINNED_KEY, isCardHidden, isCardPinned, syncPinButtons, findCard } from './cardPosition.js';
import { PinnedCards } from './pinnedCards.js';
import { PinTransition } from './pinTransition.js';
import { getMonitorKey } from './utils.js';

//Addon Imports:
import {Clock} from './addons/clock.js';
import {SoundControls} from './addons/soundControls.js';
import {SystemMonitor} from './addons/systemMonitor.js';
import {HardwareSampler} from './addons/hardwareSampler.js';
import {Dash} from './addons/dash.js';
import {Capture} from './addons/capture.js';
import {Battery, BatteryModel, BATTERY_KEYS} from './addons/battery.js';
import {Music} from './addons/music.js';
import {Gallery} from './addons/gallery.js';
import {Discord, DiscordPinned} from './addons/discord.js';
import {SettingsCard} from './addons/settings.js';
//TODO:: weather addon
//TODO:: brightness addon

// The settings of the Clock and the Hardware card, changing one recreates the card.
const CLOCK_KEYS = ['clock-addon-font-size', 'clock-addon-show-seconds'];
// The settings of what the sampler of the Hardware card reads, changing one starts its sparklines anew.
const SAMPLER_KEYS = ['cpu-monitoring', 'gpu-monitoring', 'gpu-device'];
const SYSTEM_MONITOR_KEYS = ['cpu-temperature-unit', 'gpu-device', 'gpu-monitoring', 'cpu-monitoring', 'memory-monitoring',
    'disk-monitoring', 'network-monitoring'];

// Closing a card or showing it again from the dash.
const CARD_TOGGLE_DURATION = 200;
const CARD_TOGGLE_SCALE = 0.9;

// Fly In and Fly Out: the cards start this much bigger, as if they were in front of the screen.
const FLY_SCALE = 1.3;
// Part of the animation duration the innermost card waits for the outer ones.
const FLY_STAGGER = 0.2;

// A pinned card growing into its card in the overlay and back.
const PIN_TRANSITION_MODE = Clutter.AnimationMode.EASE_IN_OUT_CUBIC;

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

        // Whether the overlay is open. It is still visible for a moment after it was closed, until the exit animation ends.
        this._isOpen = false;
        this._modalGrab = null;

        // Toggle the overlay when the GameBar panel button is clicked.
        // On GNOME 50 the panel button has a click gesture that claims the press, so 'button-press-event' is never emitted.
        if (this._clickGesture) {
            this._clickGesture.connect('recognize', () => this._toggleOverlay());
        } else {
            this.connect('button-press-event', this._toggleOverlay.bind(this));
        }

    }

    /**
     * Creates the overlay widget and adds instances of addons.
     * The overlay covers one monitor, the one of the game when it opens, and starts on the primary monitor.
     */
    _createOverlay() {
        let monitor = Main.layoutManager.primaryMonitor;

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


        this._updateOverlayGeometry(monitor);

        // Create instances of addons and pass the overlay widget and the monitor
        this._clock = new Clock(this._overlay, monitor); // Clock addon
        this._soundControls = new SoundControls(this._overlay, monitor); // Sound controls addon
        // The CPU and GPU usage is sampled once for the card and its pinned copies, also while the overlay is closed.
        this._hardwareSampler = new HardwareSampler();
        this._systemMonitor = new SystemMonitor(this._overlay, monitor, this._hardwareSampler); // System Monitor stats addon
        // The pinned cards are hidden for a screenshot, a recording hides them while it runs.
        this._capture = new Capture(this._overlay, monitor,
            callback => this._runWithOverlayClosed(() => this._pins.hideWhile(callback))); // Screenshot and screencast buttons
        // The batteries are read once for the card and its pinned copies.
        this._batteryModel = new BatteryModel();
        this._battery = new Battery(this._overlay, monitor, this._batteryModel); // Battery of the computer and connected devices
        this._music = new Music(this._overlay, monitor); // Controls of the media player that played last
        this._gallery = new Gallery(this._overlay, monitor, callback => this._runWithOverlayClosed(callback)); // The latest screenshots and recordings
        this._discord = new Discord(this._overlay, monitor, callback => this._runWithOverlayClosed(callback)); // The voice channel of Discord
        this._settingsCard = new SettingsCard(this._overlay, monitor, callback => this._runWithOverlayClosed(callback)); // Pinned card opacity and positions

        // A pinned card is the card built again for the monitor it is pinned on, without a header bar.
        // Its buttons are never clicked, the pointer goes to the windows below the pinned cards.
        const pinned = (Addon, ...args) => (layer, pinMonitor, pinKey) => new Addon(layer, pinMonitor, ...args, { pinKey });
        const pinnedWithSettings = (Addon, ...extra) => (...args) => {
            const addon = pinned(Addon, ...extra)(...args);
            addon._updateSettings(this._settings);
            return addon;
        };
        const noOverlay = () => {};

        // The cards the dash shows and hides, in the order of its buttons
        this._cards = [
            { id: 'sound', name: _('Audio'), iconName: 'audio-volume-high-symbolic', addon: this._soundControls,
                createPinned: pinnedWithSettings(SoundControls) },
            { id: 'capture', name: _('Capture'), iconName: 'camera-photo-symbolic', addon: this._capture,
                createPinned: pinned(Capture, noOverlay) },
            { id: 'gallery', name: _('Gallery'), iconName: 'image-x-generic-symbolic', addon: this._gallery,
                createPinned: pinned(Gallery, noOverlay) },
            { id: 'clock', name: _('Clock'), iconName: 'preferences-system-time-symbolic', addon: this._clock,
                createPinned: pinnedWithSettings(Clock) },
            { id: 'system-monitor', name: _('Hardware'), iconName: 'computer-symbolic', addon: this._systemMonitor,
                createPinned: pinnedWithSettings(SystemMonitor, this._hardwareSampler) },
            { id: 'battery', name: _('Battery'), iconName: 'battery-symbolic', addon: this._battery,
                createPinned: pinned(Battery, this._batteryModel) },
            { id: 'music', name: _('Music'), iconName: 'audio-x-generic-symbolic', addon: this._music,
                createPinned: pinned(Music) },
            { id: 'discord', name: _('Discord'), iconName: 'audio-headset-symbolic', addon: this._discord,
                createPinned: (layer, pinMonitor, pinKey) => new DiscordPinned(layer, pinMonitor, { pinKey }) },
            { id: 'settings', name: _('Settings'), iconName: 'preferences-system-symbolic', addon: this._settingsCard,
                createPinned: null },
        ];
        this._pins = new PinnedCards(this._cards);
        // The pinned cards growing into their cards in the overlay and back, by the id of the card.
        this._pinTransitions = new Map();
        // Cards fading out after being closed, they are still visible until the animation ends.
        this._hidingCards = new Set();
        this._dash = new Dash(this._overlay, monitor, this._cards);

        // Above the windows and the top bar, below the dialogs of the shell: a keyring or polkit prompt stays usable.
        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.insert_child_below(this._backdrop, Main.layoutManager.modalDialogGroup);
        uiGroup.insert_child_above(this._overlay, this._backdrop);

        // The monitor of the overlay may be gone, it is placed again when it opens.
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            //TODO:: fix bug: when change to a diferent resolution monitor, the size wont update properly
            this._closeOverlay(false);
            // The overlay may be in its exit animation.
            this._endPinTransitions();
            this._updateOverlayGeometry(Main.layoutManager.primaryMonitor);
            this._pins.rebuild();
        });

        // The cards and the gaps between them grow with the scale factor of the shell.
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleFactorChangedId = this._themeContext.connect('notify::scale-factor', () => {
            this._positionCards();
            this._dash.set_addon_position();
            this._pins.reposition();
        });

        // Close the overlay when clicking on an empty area, the cards stop the clicks on them.
        // Only a click pressed on the overlay counts: the top bar button opens it on the press, and the release of
        // that click can come to the overlay, which covers the top bar.
        this._overlay.connect('button-press-event', () => {
            this._pressedOnOverlay = true;
            return Clutter.EVENT_PROPAGATE;
        });
        this._overlay.connect('button-release-event', () => {
            const pressedOnOverlay = this._pressedOnOverlay;
            this._pressedOnOverlay = false;
            if (this._emptyAreaClose && pressedOnOverlay) {
                this._closeOverlay();
            }
        });

        // Connect to 'key-press-event' signal to close the overlay when ESC key is clicked
        this._overlay.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeOverlay();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Moves the overlay to a monitor, with the card positions and closed cards of that monitor.
    _updateOverlayGeometry(monitor) {
        // The shell can start without a monitor, 'monitors-changed' calls this again once there is one.
        if (!monitor) return;

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);

        this._backdrop.set_position(monitor.x, monitor.y);
        this._backdrop.set_size(monitor.width, monitor.height);

        setCardMonitor(getMonitorKey(monitor.index));

        // The addons keep the monitor they were created with, which is null if the shell had no monitor yet.
        [...(this._cards ?? []).map(card => card.addon), this._dash].forEach(addon => {
            if (!addon) return;
            addon._monitor = monitor;
            addon.set_addon_position();
        });

    }

    _toggleOverlay() {
        if (this._isOpen) {
            this._closeOverlay();
        } else {
            this._openOverlay();
        }
    }

    _openOverlay() {
        // The shell may have had no monitor when the overlay was created, so size it for the current one.
        if (this._isOpen || !Main.layoutManager.primaryMonitor) return;
        // Not on top of a dialog of the shell or the lock screen.
        if (![Shell.ActionMode.NORMAL, Shell.ActionMode.OVERVIEW].includes(Main.actionMode)) return;

        // The overview has a grab of its own.
        if (Main.overview.visible) {
            Main.overview.hide();
        }

        this._isOpen = true;
        this._pressedOnOverlay = false;
        this._overlay.reactive = true;
        const monitor = this._getGameMonitor();
        this._updateOverlayGeometry(monitor);
        this._pins.overlayMonitorIndex = monitor.index;
        this._showOverlayWithAnimation();
        this._clock._updateClock();
        this._soundControls.updateVolumeControls();

        // Modal like the overview: the keys go to the overlay and the shortcuts of the shell are off, a game loses
        // its pointer lock. It also keeps fullscreen windows from bypassing the compositor, which would hide the overlay.
        const grab = Main.pushModal(this._overlay, { actionMode: Shell.ActionMode.SYSTEM_MODAL });
        this._modalGrab = grab;
        // Up to GNOME 49 a grab can fail, another client may hold the keyboard on X11.
        // @ts-expect-error GrabState is gone since GNOME 50, the types are the ones of GNOME 50.
        if (grab.get_seat_state && (grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            this._closeOverlay(false);
        }
    }

    // The monitor of the focused window, the game, or the one of the pointer without a focused window.
    _getGameMonitor() {
        const { monitors, currentMonitor, primaryMonitor } = Main.layoutManager;
        const index = global.display.get_focus_window()?.get_monitor() ?? -1;
        return monitors[index] ?? currentMonitor ?? primaryMonitor;
    }

    // Also called when the extension is disabled or the monitors change while the overlay is open.
    _closeOverlay(animate = true) {
        if (!this._isOpen) return;
        this._isOpen = false;
        // During the exit animation a click goes to what is below, like the top bar button that opens it again.
        this._overlay.reactive = false;
        // The pinned cards are back right away, their cards in the overlay fade out over them.
        this._pins.overlayShown = false;

        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }

        if (animate) {
            this._hideOverlayWithAnimation();
        } else {
            this._endPinTransitions();
            this._backdrop.remove_all_transitions();
            this._backdrop.hide();
            this._overlay.hide();
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
                // The pinned cards stay until they have grown into their cards in the overlay.
                onComplete: () => {
                    this._endPinTransitions();
                    this._pins.overlayShown = true;
                },
            });
            this._animatePinnedCards(true, animationDuration);
        } else {
            this._endPinTransitions();
            this._backdrop.set_opacity(255);
            this._pins.overlayShown = true;
        }

        if (animationType === 'Fade') {
            this._getMovingChildren().forEach(child => {
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
            this._getMovingChildren().forEach(child => {

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

        const cards = this._getMovingChildren().map(child => {
            const offsetX = child.x + child.width / 2 - centerX;
            const offsetY = child.y + child.height / 2 - centerY;
            return {
                child,
                translationX: offsetX * (FLY_SCALE - 1),
                translationY: offsetY * (FLY_SCALE - 1),
                distance: Math.hypot(offsetX, offsetY),
                closeness: 0,
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

        const animationType = this._exitAnimation;
        const animationDuration = this._exitAnimationDuration;

        // The backdrop fades for as long as the cards move, the overlay is hidden with it. The cards cannot tell when
        // they are done: a card recreated or shown during the animation never finishes it.
        if (animationType !== 'None') {
            this._backdrop.ease({
                opacity: 0,
                duration: animationDuration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    // Stopped by opening the overlay again.
                    if (this._isOpen) return;
                    this._endPinTransitions();
                    this._backdrop?.hide();
                    this._overlay?.hide();
                },
            });
            this._animatePinnedCards(false, animationDuration);
        } else {
            this._endPinTransitions();
            this._backdrop.hide();
        }

        if (animationType === 'Fade') {
            this._getMovingChildren().forEach(child => {
                child.ease({
                    opacity: 0,
                    scale_x: 0.8,
                    scale_y: 0.8,
                    duration: animationDuration,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
            });
        } else if (animationType === 'Slide') {
            this._getMovingChildren().forEach(child => {
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

        this._closeOverlay();
        waitForHidden(this._overlay, () => waitForHidden(this._backdrop, callback));
    }

    // The children the animations move, closed cards are hidden and left alone. Pinned cards stay where they are.
    _getMovingChildren() {
        const pinned = [...this._getPinnedCards().map(({ addon }) => addon._addonContainer), ...this._getPinTransitionGroups()];
        return this._overlay.get_children().filter(child => child.visible && !pinned.includes(child));
    }

    // The cards of the overlay that are pinned on its monitor, they are at the place of their pinned card.
    // A card fading out after being closed has no pinned card anymore.
    _getPinnedCards() {
        return this._cards.filter(({ id, addon }) => addon._addonContainer?.visible && isCardPinned(id) && !this._hidingCards.has(id));
    }

    _getPinTransitionGroups() {
        return [...this._pinTransitions.values()].map(transition => transition.group);
    }

    // The pinned cards do not move with the other cards, they grow into their cards in the overlay and back.
    // A transition that runs goes on from where it is. The pinned Discord card is no card, its card in the overlay
    // fades in and out over it.
    _animatePinnedCards(open, duration) {
        this._getPinnedCards().forEach(({ id, addon }) => {
            let transition = this._pinTransitions.get(id);
            const pinned = this._pins.getPinned(id);
            if (!transition && findCard(addon._addonContainer) && findCard(pinned?._addonContainer)) {
                // The card that just started goes on where the other one is, like a Hardware card with its samples.
                const [from, to] = open ? [pinned, addon] : [addon, pinned];
                to.continueFrom?.(from);
                transition = new PinTransition(this._overlay, addon, pinned, open ? 0 : 1);
                this._pinTransitions.set(id, transition);
            }

            if (transition) {
                transition.animate(open ? 1 : 0, duration, PIN_TRANSITION_MODE);
                return;
            }

            const container = addon._addonContainer;
            if (open) container.set_opacity(0);
            container.ease({
                opacity: open ? 255 : 0,
                duration,
                mode: open ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_IN_QUAD,
            });
        });
    }

    // Puts the cards of the transitions back where they were.
    _endPinTransitions() {
        this._pinTransitions.forEach(transition => transition.end());
        this._pinTransitions.clear();
    }

    // Show the cards that are not closed and update the dots of the dash.
    _syncCardVisibility(animate) {
        animate &&= this._isOpen;

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
                        container.set_opacity(255);
                        container.set_scale(1, 1);
                        container.set_translation(0, 0, 0);
                    },
                });
            }
        });

    }

    _resetOverlayChildren() {
        if (!this._overlay) return;

        // A pinned card growing back into its pinned card turns around.
        const groups = this._getPinTransitionGroups();
        this._overlay.get_children().filter(child => !groups.includes(child)).forEach(child => {
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
        // A setting can recreate or move the cards of a transition.
        this._endPinTransitions();

        // A dragged addon is already in place.
        if (key === POSITIONS_KEY) {
            this._positionCards();
            this._pins.reposition();
            return;
        }

        if (key === PINNED_KEY) {
            syncPinButtons();
            this._pins.rebuild();
            return;
        }

        // Closing a card or showing it from the dash only changes which cards are visible.
        if (key === HIDDEN_KEY) {
            this._syncCardVisibility(true);
            this._pins.rebuild();
            return;
        }

        // Only the card a setting belongs to is recreated, recreating every card makes them flicker.
        if (CLOCK_KEYS.includes(key)) {
            this._clock._updateSettings(settings);
            this._onCardsRecreated();
            this._pins.rebuild();
        } else if (SYSTEM_MONITOR_KEYS.includes(key)) {
            if (SAMPLER_KEYS.includes(key)) this._hardwareSampler.updateSettings(settings);
            this._systemMonitor._updateSettings(settings);
            this._onCardsRecreated();
            this._pins.rebuild();
        } else if (BATTERY_KEYS.includes(key)) {
            // The Battery cards update themselves.
            this._batteryModel.updateSettings(settings);
        } else {
            this._updateOverlaySettings(settings);
        }
    }

    // The cards that depend on settings are created here, the other ones in their constructor.
    _updateSettings(settings) {
        set_position_settings(settings);

        this._clock._updateSettings(settings);
        this._soundControls._updateSettings(settings);
        this._hardwareSampler.updateSettings(settings);
        this._systemMonitor._updateSettings(settings);
        this._batteryModel.updateSettings(settings);
        this._settingsCard._updateSettings(settings);
        this._onCardsRecreated();
        this._updateOverlaySettings(settings);
        this._pins.rebuild();
    }

    // New cards start visible and on top of the dash.
    _onCardsRecreated() {
        this._syncCardVisibility(false);
        this._overlay.set_child_above_sibling(this._dash._addonContainer, null);
    }

    _updateOverlaySettings(settings) {
        this._emptyAreaClose = settings.get_boolean('overlay-empty-area-close');
        this._enterAnimation = settings.get_string('enter-animation');
        this._enterAnimationDuration = settings.get_int('enter-animation-duration');
        this._exitAnimation = settings.get_string('exit-animation');
        this._exitAnimationDuration = settings.get_int('exit-animation-duration');
        this._backdrop.style = `background-color: ${settings.get_string('overlay-background-color')}`;
        this._pins.opacity = settings.get_int('pinned-cards-opacity');
    }

    /**
     * Destroys the GameBar extension.
     * This method is called when the extension is disabled or being removed.
     * It destroys the clock addon and calls the parent class's destroy method.
     */
    destroy() {
        this._closeOverlay(false);
        this._endPinTransitions();
        this._pins?.destroy();
        this._pins = null;

        // Call the addon destroy:
        this._clock?.destroy();
        this._clock = null;
        this._soundControls?.destroy();
        this._soundControls = null;
        this._systemMonitor?.destroy();
        this._systemMonitor = null;
        this._hardwareSampler?.destroy();
        this._hardwareSampler = null;
        this._capture?.destroy();
        this._capture = null;
        this._battery?.destroy();
        this._battery = null;
        this._batteryModel?.destroy();
        this._batteryModel = null;
        this._music?.destroy();
        this._music = null;
        this._gallery?.destroy();
        this._gallery = null;
        this._discord?.destroy();
        this._discord = null;
        this._settingsCard?.destroy();
        this._settingsCard = null;
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
            // SYSTEM_MODAL is the mode of the open overlay, the shortcut closes it too.
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.SYSTEM_MODAL,
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
