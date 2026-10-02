import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {captureScreenshot} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable, setCardHidden } from '../cardPosition.js';
import { vertical, createCard, createPillButton } from '../card.js';

// Screencast mode of the screenshot UI of the shell (UIMode in js/ui/screenshot.js, not exported).
const SCREENCAST_MODE = 1;

// Screenshot of the monitor of the overlay, like the Shift+Print key of the shell:
// saved to the screenshots folder and the clipboard, with the sound and notification of the shell.
const takeScreenshot = async () => {
    const shooter = new Shell.Screenshot();
    const [content, scale] = await shooter.screenshot_stage_to_content();
    const monitor = Main.layoutManager.primaryMonitor;
    await captureScreenshot(content.get_texture(),
        [monitor.x * scale, monitor.y * scale, monitor.width * scale, monitor.height * scale], scale, null);
};

// Records the monitor of the overlay right away. It goes through the screenshot UI, so the shell shows its recording
// indicator with the stop button and the notification. The screenshot UI has no API for this, its screen mode is set by
// hand and restored afterwards. Should its internals change, the screenshot UI opens in screencast mode instead.
const startScreencast = () => {
    const ui = Main.screenshotUI;
    const modeButtons = [ui._selectionButton, ui._screenButton, ui._windowButton];
    if (typeof ui._startScreencast !== 'function' || modeButtons.includes(undefined) || !ui._screenSelectors) {
        ui.open(SCREENCAST_MODE).catch(e => logError(e, 'GameBar: Failed to open the screen recording UI'));
        return;
    }

    const checkedButton = modeButtons.find(button => button.checked);
    const checkedSelector = ui._screenSelectors.find(selector => selector.checked);

    ui._selectionButton.checked = false;
    ui._windowButton.checked = false;
    ui._screenButton.checked = true;
    ui._screenSelectors.forEach((selector, index) => {
        selector.checked = index === Main.layoutManager.primaryIndex;
    });

    // The recording area is read before the first await, so it is called right away.
    try {
        ui._startScreencast()?.catch?.(e => logError(e, 'GameBar: Failed to start the screen recording'));
    } catch (e) {
        logError(e, 'GameBar: Failed to start the screen recording');
    }

    if (checkedButton) {
        checkedButton.checked = true;
    }
    if (checkedSelector) {
        ui._screenSelectors.forEach(selector => {
            selector.checked = selector === checkedSelector;
        });
    }
};

// Takes a screenshot or starts a recording of the monitor right away.
export class Capture {
    // runWithOverlayClosed(callback) closes the overlay first, so it is not in the screenshot or recording.
    constructor(overlay, primaryMonitor, runWithOverlayClosed) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._runWithOverlayClosed = runWithOverlayClosed;
        this._addonContainer = null;
        this._createCaptureWidget();
    }

    _createCaptureWidget() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(_('Capture'), 'gamebar-capture-card', () => setCardHidden('capture', true));
        body.add_style_class_name('gamebar-capture-body');
        // Both buttons as wide as the wider one.
        Object.assign(body, vertical(false));
        body.layout_manager.homogeneous = true;

        const screenshot = createPillButton('camera-photo-symbolic', _('Take Screenshot'));
        screenshot.button.connect('clicked', () => this._runWithOverlayClosed(() => {
            takeScreenshot().catch(e => logError(e, 'GameBar: Failed to take a screenshot'));
        }));
        body.add_child(screenshot.button);

        this._record = createPillButton('media-record-symbolic', _('Record Screen'), 'gamebar-pill-button-destructive');
        this._record.button.connect('clicked', () => {
            if (Main.screenshotUI.screencast_in_progress) {
                Main.screenshotUI.stopScreencast();
            } else {
                this._runWithOverlayClosed(startScreencast);
            }
        });
        body.add_child(this._record.button);

        // The design has no recording state yet, the button stops a running recording.
        Main.screenshotUI.connectObject('notify::screencast-in-progress', () => this._syncRecordButton(), this._addonContainer);
        // Whether the shell can record is only known once its recorder answered.
        this._overlay.connectObject('notify::visible', () => this._syncRecordButton(), this._addonContainer);
        this._syncRecordButton();

        this._addonContainer.add_child(card);
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'capture');

        followCardSize(this._addonContainer, () => this.set_addon_position());
    }

    _syncRecordButton() {
        const recording = Main.screenshotUI.screencast_in_progress;
        this._record.icon.icon_name = recording ? 'media-playback-stop-symbolic' : 'media-record-symbolic';
        this._record.label.text = recording ? _('Stop Recording') : _('Record Screen');

        // Without PipeWire or the GStreamer plugins the shell cannot record.
        const supported = Main.screenshotUI._screencastSupported ?? true;
        this._record.button.reactive = supported || recording;
        this._record.button.opacity = this._record.button.reactive ? 255 : 128;
    }

    set_addon_position() {
        positionAddon(this._primaryMonitor, this._addonContainer, 'capture');
    }

    destroy() {
        // Also disconnects from the screenshot UI.
        this._addonContainer?.destroy();
        this._addonContainer = null;
        this._record = null;
    }
}
