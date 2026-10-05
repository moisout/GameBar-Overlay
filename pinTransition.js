import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { findCard } from './cardPosition.js';
import { PinLayer } from './pinnedCards.js';

// Part of the transition the content of one card takes to fade in over the content of the other.
const CONTENT_FADE = 0.6;

const clamp = value => Math.max(0, Math.min(value, 1));

// Holds a pinned card and its card in the overlay while the overlay opens or closes.
// progress is 0 where the pinned card shows, 1 where the card of the overlay shows.
const PinTransitionGroup = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', '', '', GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class PinTransitionGroup extends St.Widget {
    get progress() {
        return this._progress ?? 0;
    }

    set progress(progress) {
        if (this._progress === progress) return;
        this._progress = progress;
        this.notify('progress');
    }
});

// A pinned card that grows into its card in the overlay, and back. Both cards are drawn on one frame that resizes
// from one card to the other, the header bar of the card of the overlay comes in with the top edge of the frame and
// its content fades in over the content of the pinned card. Both are faded as a whole, from the opacity of the
// pinned cards.
// The cards are moved into the group of the transition in the overlay, end() puts them back.
export class PinTransition {
    // card and pinned: the addons of the card of the overlay and of its pinned card, both with a card.
    constructor(overlay, card, pinned, progress) {
        this._overlay = overlay;
        this._card = card._addonContainer;
        this._pinned = pinned._addonContainer;
        this._layer = this._pinned.get_parent();
        this._pinnedIndex = this._layer.get_children().indexOf(this._pinned);
        this._pinnedOpacity = this._pinned.opacity;
        this._cardRedirect = this._card.offscreen_redirect;
        this._destroyed = new Set();

        this.group = new PinTransitionGroup({ x_expand: true, y_expand: true, progress });
        this.group.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;
        this._frame = new St.Widget({ style_class: 'gamebar-card' });
        // The pinned card keeps the style of the pin layer, and is not picked like in it.
        this._pinnedLayer = new PinLayer({ style_class: 'gamebar-pin-layer' });
        this._pinnedLayer.set_size(overlay.width, overlay.height);

        overlay.insert_child_above(this.group, this._card);
        this.group.add_child(this._frame);
        this.group.add_child(this._pinnedLayer);
        this._layer.remove_child(this._pinned);
        this._pinnedLayer.add_child(this._pinned);
        overlay.remove_child(this._card);
        this.group.add_child(this._card);

        // The frame is the background of both.
        [this._card, this._pinned].forEach(container => findCard(container).add_style_class_name('gamebar-card-bare'));
        this._card.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;

        // A card recreated by a setting is not put back.
        [this._card, this._pinned].forEach(container => container.connectObject('destroy', () => {
            this._destroyed.add(container);
            this.end();
        }, this));

        this.group.connect('notify::progress', () => this._update());
        this._update();
    }

    // To 1 to show the card of the overlay, to 0 for the pinned card. Continues from where it is.
    animate(progress, duration, mode) {
        this.group.ease_property('progress', progress, { duration, mode });
    }

    // The place and size of the card in a container, from its preferred size: a card that is not shown keeps the
    // allocation it had when it was.
    _getRect(container) {
        const [, , width, height] = findCard(container).get_preferred_size();
        return [container.x, container.y, width, height];
    }

    _update() {
        const progress = this.group.progress;
        const from = this._getRect(this._pinned);
        const to = this._getRect(this._card);
        const [x, y, width, height] = from.map((value, index) => value + (to[index] - value) * progress);

        this._frame.set_position(x, y);
        this._frame.set_size(width, height);
        // The header bar of the card of the overlay is outside the pinned card, it shows as the frame grows over it.
        this._card.set_clip(x - this._card.x, y - this._card.y, width, height);
        // The content of one card fades in before the other one fades out, where they are the same nothing changes.
        this._card.opacity = Math.round(255 * clamp(progress / CONTENT_FADE));
        this._pinned.opacity = Math.round(255 * clamp((1 - progress) / CONTENT_FADE));
        this.group.opacity = Math.round(this._pinnedOpacity + (255 - this._pinnedOpacity) * progress);
    }

    // Puts the cards back where they were, also in the middle of the transition.
    end() {
        if (this._ended) return;
        this._ended = true;

        this.group.remove_all_transitions();
        [this._card, this._pinned].forEach(container => container.disconnectObject(this));

        if (!this._destroyed.has(this._card)) {
            findCard(this._card)?.remove_style_class_name('gamebar-card-bare');
            this._card.remove_clip();
            this._card.opacity = 255;
            this._card.offscreen_redirect = this._cardRedirect;
            this.group.remove_child(this._card);
            this._overlay.insert_child_below(this._card, this.group);
        }

        if (!this._destroyed.has(this._pinned)) {
            findCard(this._pinned)?.remove_style_class_name('gamebar-card-bare');
            this._pinned.opacity = this._pinnedOpacity;
            this._pinnedLayer.remove_child(this._pinned);
            this._layer.insert_child_at_index(this._pinned, this._pinnedIndex);
        }

        this.group.destroy();
    }
}
