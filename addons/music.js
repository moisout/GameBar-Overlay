import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, followCardSize, makeDraggable, setCardHidden } from '../cardPosition.js';
import { vertical, backgroundImageStyle, createCard, BoxedList, createRow, createLabel, createIconButton, TabBar } from '../card.js';
import { formatPlaybackTime, deleteOldFiles } from '../utils.js';

// Media players over MPRIS, like the media controls of the shell (js/ui/mpris.js).
// The shell's players have no position and their API differs between GNOME versions, so the card has its own proxies.
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
// Track id of a player without a track, SetPosition() needs a real one.
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

// Downloaded covers of earlier sessions are deleted after a day, in seconds.
const COVER_MAX_AGE = 24 * 60 * 60;

// The elapsed time is counted locally between the positions read from the player, see Player.position.
const PROGRESS_INTERVAL = 500;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames"><arg type="as" direction="out"/></method>
    <signal name="NameOwnerChanged">
      <arg type="s"/><arg type="s"/><arg type="s"/>
    </signal>
  </interface>
</node>`);

const MprisProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`);

const logError = (error) => {
    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.warn(`GameBar: ${error.message}`);
};

// MPRIS times are in microseconds.
const formatTime = (microseconds) => formatPlaybackTime(microseconds / 1000000);

// One media player. onChanged() is called after every change of its state.
class Player {
    constructor(busName, onChanged) {
        this.busName = busName;
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        // When it last started playing, the card shows the player that played last.
        this.lastActive = GLib.get_monotonic_time();
        // The position read from the player, when, and whether it was playing then. It moves on from there while playing.
        this._position = 0;
        this._positionTime = 0;
        this._positionPlaying = false;
        this._seekedId = 0;
        this._propertiesChangedId = 0;

        this._mpris = new MprisProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                logError(error);
                return;
            }
            this._onChanged();
        }, this._cancellable);

        this._player = new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                logError(error);
                return;
            }
            this._propertiesChangedId = proxy.connect('g-properties-changed', (proxy_, changed) => {
                const keys = Object.keys(changed.deepUnpack());
                if (keys.includes('PlaybackStatus')) {
                    // Until the new position arrives, it moves on from where it was when the status changed.
                    this._setPosition(this.position, false);
                    if (this.status === 'Playing') this.lastActive = GLib.get_monotonic_time();
                }
                // The player does not announce its position, it only changes on its own while playing.
                if (keys.some(key => ['PlaybackStatus', 'Metadata', 'Rate'].includes(key))) {
                    this.refreshPosition();
                }
                this._onChanged();
            });
            this._seekedId = proxy.connectSignal('Seeked', (proxy_, sender, [position]) => this._setPosition(position));
            this.refreshPosition();
            this._onChanged();
        }, this._cancellable);
    }

    get _metadata() {
        const metadata = this._player.Metadata ?? {};
        const unpacked = {};
        for (const key in metadata) {
            unpacked[key] = metadata[key].recursiveUnpack();
        }
        return unpacked;
    }

    get ready() {
        return this._player.g_name_owner !== null && this._player.PlaybackStatus !== null;
    }

    get status() {
        return this._player.PlaybackStatus;
    }

    get title() {
        const title = this._metadata['xesam:title'];
        return typeof title === 'string' && title ? title : _('Unknown title');
    }

    // Players send buggy metadata, see js/ui/mpris.js.
    get artists() {
        const artists = this._metadata['xesam:artist'];
        return Array.isArray(artists) ? artists.filter(artist => typeof artist === 'string' && artist) : [];
    }

    get coverUrl() {
        const url = this._metadata['mpris:artUrl'];
        return typeof url === 'string' ? url : '';
    }

    // In microseconds, 0 for streams and players that do not know it.
    get length() {
        const length = Number(this._metadata['mpris:length']);
        return Number.isFinite(length) && length > 0 ? length : 0;
    }

    get appName() {
        const desktopEntry = this._mpris.DesktopEntry;
        const app = desktopEntry ? Shell.AppSystem.get_default().lookup_app(`${desktopEntry}.desktop`) : null;
        return app?.get_name() ?? this._mpris.Identity ?? '';
    }

    get canGoNext() {
        return !!this._player.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._player.CanGoPrevious;
    }

    get canPlayPause() {
        return this.status === 'Playing' ? !!this._player.CanPause : !!this._player.CanPlay;
    }

    get canSeek() {
        return !!this._player.CanSeek && this.length > 0;
    }

    // The current position in microseconds.
    get position() {
        let position = this._position;
        if (this._positionPlaying) {
            position += (GLib.get_monotonic_time() - this._positionTime) * (this._player.Rate ?? 1);
        }
        return this.length > 0 ? Math.min(Math.max(position, 0), this.length) : Math.max(position, 0);
    }

    _setPosition(position, notify = true) {
        this._position = Number(position);
        this._positionTime = GLib.get_monotonic_time();
        this._positionPlaying = this.status === 'Playing';
        if (notify) this._onChanged();
    }

    // The proxy caches the position, it has to be read from the player.
    refreshPosition() {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Position']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                try {
                    this._setPosition(connection.call_finish(result).recursiveUnpack()[0]);
                } catch (e) {
                    // Players without a position are shown at the start.
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) this._setPosition(0);
                }
            });
    }

    playPause() {
        this._player.PlayPauseAsync().catch(logError);
    }

    next() {
        this._player.NextAsync().catch(logError);
    }

    previous() {
        this._player.PreviousAsync().catch(logError);
    }

    // Some players have no valid track id, they can only seek by an offset.
    seek(position) {
        const trackId = this._metadata['mpris:trackid'];
        if (typeof trackId === 'string' && trackId !== NO_TRACK && GLib.Variant.is_object_path(trackId)) {
            this._player.SetPositionAsync(trackId, Math.round(position)).catch(logError);
        } else {
            this._player.SeekAsync(Math.round(position - this.position)).catch(logError);
        }
        // Players do not always send Seeked.
        this._setPosition(position);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._seekedId) {
            this._player.disconnectSignal(this._seekedId);
            this._seekedId = 0;
        }
        if (this._propertiesChangedId) {
            this._player.disconnect(this._propertiesChangedId);
            this._propertiesChangedId = 0;
        }
    }
}

// Keeps the list of media players up to date. onChanged() is called after every change, once per main loop iteration.
class MusicModel {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._players = new Map();
        this._changedId = 0;
        this._nameOwnerChangedId = 0;

        this._dbus = new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus', '/org/freedesktop/DBus', (proxy, error) => {
            if (error) {
                logError(error);
                return;
            }
            this._nameOwnerChangedId = proxy.connectSignal('NameOwnerChanged', (proxy_, sender, [name, oldOwner, newOwner]) => {
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (oldOwner) this._removePlayer(name);
                if (newOwner) this._addPlayer(name);
            });
            proxy.ListNamesAsync()
                .then(([names]) => names.filter(name => name.startsWith(MPRIS_PREFIX)).forEach(name => this._addPlayer(name)))
                .catch(logError);
        }, this._cancellable);
    }

    _addPlayer(busName) {
        if (this._players.has(busName)) return;
        this._players.set(busName, new Player(busName, () => this._queueChanged()));
    }

    _removePlayer(busName) {
        this._players.get(busName)?.destroy();
        this._players.delete(busName);
        this._queueChanged();
    }

    _queueChanged() {
        if (this._changedId) return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The players with a track, in the order they appeared. Stopped players have no track.
    get players() {
        return [...this._players.values()].filter(player => player.ready && ['Playing', 'Paused'].includes(player.status));
    }

    // The player the card shows unless another one is picked: the one that played last, playing players first.
    get current() {
        const players = this.players;
        players.sort((a, b) => (b.status === 'Playing') - (a.status === 'Playing') || b.lastActive - a.lastActive);
        return players[0] ?? null;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._nameOwnerChangedId) {
            this._dbus.disconnectSignal(this._nameOwnerChangedId);
            this._nameOwnerChangedId = 0;
        }
        if (this._changedId) {
            GLib.Source.remove(this._changedId);
            this._changedId = 0;
        }
        this._players.forEach(player => player.destroy());
        this._players.clear();
        this._dbus = null;
    }
}

// Turns the cover URL of a player into a local file the stylesheet can show.
// Covers on the web (Spotify) are downloaded to the cache, only the last one is kept.
class CoverCache {
    constructor() {
        this._directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gamebar-overlay@m0.is', 'covers']);
        this._session = null;
        this._cancellable = null;
        this._downloaded = null;
        // The last cover of earlier sessions, which nobody remembers.
        deleteOldFiles(this._directory, COVER_MAX_AGE);
    }

    // callback(path) with the file of the cover, or null without one. A new call cancels the previous one.
    load(url, callback) {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();

        if (url.startsWith('file://')) {
            const path = Gio.File.new_for_uri(url).get_path();
            callback(path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null);
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
            this._download(url, this._cancellable, callback);
        } else {
            callback(null);
        }
    }

    _download(url, cancellable, callback) {
        const path = GLib.build_filenamev([this._directory, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1)]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._keep(path);
            callback(path);
            return;
        }

        this._session ??= new Soup.Session();
        const message = Soup.Message.new('GET', url);
        if (!message) {
            callback(null);
            return;
        }
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
            let bytes;
            try {
                bytes = session.send_and_read_finish(result);
            } catch (e) {
                logError(e);
                if (!cancellable.is_cancelled()) callback(null);
                return;
            }
            if (message.get_status() !== Soup.Status.OK) {
                callback(null);
                return;
            }

            GLib.mkdir_with_parents(this._directory, 0o700);
            const file = Gio.File.new_for_path(path);
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable, (file_, writeResult) => {
                try {
                    file.replace_contents_finish(writeResult);
                } catch (e) {
                    logError(e);
                    if (!cancellable.is_cancelled()) callback(null);
                    return;
                }
                this._keep(path);
                callback(path);
            });
        });
    }

    // Deletes the cover downloaded before.
    _keep(path) {
        if (this._downloaded && this._downloaded !== path) {
            Gio.File.new_for_path(this._downloaded).delete_async(GLib.PRIORITY_LOW, null, (file, result) => {
                try {
                    file.delete_finish(result);
                } catch (e) {
                    logError(e);
                }
            });
        }
        this._downloaded = path;
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
    }
}

export class Music {
    constructor(overlay, monitor) {
        this._overlay = overlay;
        this._monitor = monitor;
        this._addonContainer = null;
        this._visibilityChangedId = null;
        this._timeoutId = null;
        // The bus name of the player picked in the tab bar, null for the one that played last.
        this._selectedBusName = null;
        this._covers = new CoverCache();
        this._model = new MusicModel(() => this._sync());
        this._createMusicWidget();
    }

    _createMusicWidget() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const { card, body } = createCard(_('Music'), 'gamebar-music-card', () => setCardHidden('music', true));

        // With several players a tab bar below the header switches between them.
        this._tabBar = new TabBar(card, body, busName => {
            const player = this._model.players.find(other => other.busName === busName);
            if (player) this._selectPlayer(player);
        });

        // Without a player the card says so, like the Battery card without a battery.
        this._emptyList = new BoxedList();
        const emptyRow = createRow();
        emptyRow.add_child(createLabel(_('Nothing playing'), 'gamebar-dim', { x_expand: true }));
        this._emptyList.addRow(emptyRow);
        body.add_child(this._emptyList.actor);

        this._playerList = new BoxedList();
        this._playerList.actor.add_style_class_name('gamebar-music-player');
        this._playerList.actor.add_child(this._createTrackRow());
        this._playerList.actor.add_child(this._createProgressRow());
        body.add_child(this._playerList.actor);

        this._coverUrl = null;
        this._sync();

        this._addonContainer.add_child(card);
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'music');

        followCardSize(this._addonContainer, () => this.set_addon_position());

        // The elapsed time only moves while the overlay is open.
        // Opening the overlay shows the player that played last again.
        this._visibilityChangedId = this._overlay.connect('notify::visible', () => {
            if (this._overlay.visible) {
                this._startProgress();
            } else {
                this._stopProgress();
                this._selectedBusName = null;
                this._sync();
            }
        });
        if (this._overlay.visible) {
            this._startProgress();
        }
    }

    // Cover, title over "artist · player app", previous, play/pause and next.
    _createTrackRow() {
        const row = new St.BoxLayout({ style_class: 'gamebar-music-track', x_expand: true });

        this._coverIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 24 });
        this._cover = new St.Bin({
            style_class: 'gamebar-music-cover',
            y_align: Clutter.ActorAlign.CENTER,
            child: this._coverIcon,
        });
        row.add_child(this._cover);

        const info = new St.BoxLayout({
            ...vertical(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = createLabel('', 'gamebar-music-title');
        this._subtitleLabel = createLabel('', 'gamebar-subtitle');
        info.add_child(this._titleLabel);
        info.add_child(this._subtitleLabel);
        row.add_child(info);

        const controls = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this._previousButton = createIconButton('media-skip-backward-symbolic');
        this._previousButton.accessible_name = _('Previous Track');
        this._previousButton.connect('clicked', () => this._shownPlayer?.previous());
        this._playPauseButton = createIconButton('media-playback-start-symbolic');
        this._playPauseButton.connect('clicked', () => this._shownPlayer?.playPause());
        this._nextButton = createIconButton('media-skip-forward-symbolic');
        this._nextButton.accessible_name = _('Next Track');
        this._nextButton.connect('clicked', () => this._shownPlayer?.next());
        [this._previousButton, this._playPauseButton, this._nextButton].forEach(button => controls.add_child(button));
        row.add_child(controls);

        return row;
    }

    // Elapsed time, seek slider and length.
    _createProgressRow() {
        this._progressRow = new St.BoxLayout({ style_class: 'gamebar-music-progress', x_expand: true });

        this._elapsedLabel = createLabel('', 'gamebar-subtitle gamebar-numeric');
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = _('Playback Position');
        this._lengthLabel = createLabel('', 'gamebar-subtitle gamebar-numeric');

        this._dragging = false;
        this._syncingSlider = false;
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        // Seeks once the slider is let go, the elapsed time follows the slider until then.
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._seekToSlider();
        });
        this._slider.connect('notify::value', () => {
            if (this._syncingSlider) return;
            if (this._dragging) {
                const player = this._shownPlayer;
                if (player) this._elapsedLabel.text = formatTime(this._slider.value * player.length);
            } else {
                // Scrolling or the keyboard.
                this._seekToSlider();
            }
        });

        this._progressRow.add_child(this._elapsedLabel);
        this._progressRow.add_child(this._slider);
        this._progressRow.add_child(this._lengthLabel);
        return this._progressRow;
    }

    get _shownPlayer() {
        if (!this._model) return null;
        return this._model.players.find(player => player.busName === this._selectedBusName) ?? this._model.current;
    }

    _selectPlayer(player) {
        this._selectedBusName = player.busName;
        player.refreshPosition();
        this._sync();
    }

    // One tab per player, named after its app. Players of the same app, like two browser tabs, are named after their track.
    _syncTabs(shownPlayer) {
        const players = shownPlayer ? this._model.players : [];
        const appNames = players.map(player => player.appName);
        const names = players.map((player, index) =>
            appNames[index] && appNames.indexOf(appNames[index]) === appNames.lastIndexOf(appNames[index]) ? appNames[index] : player.title);

        this._tabBar.visible = players.length > 1;
        this._tabBar.setTabs(players.map((player, index) => ({ id: player.busName, name: names[index] })));
        this._tabBar.selected = shownPlayer?.busName ?? null;
    }

    _seekToSlider() {
        const player = this._shownPlayer;
        if (player?.canSeek) player.seek(this._slider.value * player.length);
    }

    _sync() {
        if (!this._addonContainer) return;

        const player = this._shownPlayer;
        this._syncTabs(player);
        this._emptyList.actor.visible = !player;
        this._playerList.actor.visible = !!player;
        if (!player) {
            this._setCover('');
            return;
        }

        this._titleLabel.text = player.title;
        this._subtitleLabel.text = [player.artists.join(', '), player.appName].filter(text => text).join(' · ');
        this._setCover(player.coverUrl);

        const playing = player.status === 'Playing';
        this._playPauseButton.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playPauseButton.accessible_name = playing ? _('Pause') : _('Play');
        this._playPauseButton.reactive = player.canPlayPause;
        this._previousButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;

        // Streams have no length to show progress in.
        this._progressRow.visible = player.length > 0;
        this._slider.reactive = player.canSeek;
        this._lengthLabel.text = formatTime(player.length);
        this._syncProgress();
    }

    _syncProgress() {
        const player = this._shownPlayer;
        if (!player || player.length <= 0 || this._dragging) return;

        const position = player.position;
        this._elapsedLabel.text = formatTime(position);
        this._syncingSlider = true;
        this._slider.value = position / player.length;
        this._syncingSlider = false;
    }

    _setCover(url) {
        if (url === this._coverUrl) return;
        this._coverUrl = url;

        const showCover = (path) => {
            if (!this._cover) return;
            this._cover.style = path ? backgroundImageStyle(path) : null;
            this._coverIcon.visible = !path;
        };
        showCover(null);
        if (url) this._covers.load(url, showCover);
    }

    _startProgress() {
        // The player only tells its position when asked.
        this._shownPlayer?.refreshPosition();
        if (this._timeoutId) return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_INTERVAL, () => {
            this._syncProgress();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopProgress() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    set_addon_position() {
        positionAddon(this._monitor, this._addonContainer, 'music');
    }

    _destroyWidget() {
        this._stopProgress();

        if (this._visibilityChangedId) {
            this._overlay.disconnect(this._visibilityChangedId);
            this._visibilityChangedId = null;
        }

        this._addonContainer?.destroy();
        this._addonContainer = null;
        this._tabBar = null;
        this._cover = null;
        this._coverIcon = null;
    }

    destroy() {
        this._destroyWidget();
        this._model?.destroy();
        this._model = null;
        this._covers?.destroy();
        this._covers = null;
    }
}
