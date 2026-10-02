import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gettext from 'gettext';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import { positionAddon, makeDraggable, setCardHidden } from '../cardPosition.js';
import { createCard, BoxedList, createRow, createLabel, createIconButton, TabBar } from '../card.js';
import { formatPlaybackTime } from '../utils.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// The latest captures shown in a tab, two rows of three like the design.
const ITEM_COUNT = 6;
const COLUMNS = 3;

// Thumbnails of the freedesktop thumbnail cache, the ones of GNOME Files are used too.
// The helper writes x-large ones, large ones are still sharp enough at 100%.
const THUMBNAIL_SIZES = ['x-large', 'large'];
const HELPER = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('helpers').get_child('galleryThumbnailer.js').get_path();

const logError = (error) => {
    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.warn(`GameBar: ${error.message}`);
};

// The folders the shell saves to (js/ui/screenshot.js and the screencast service), with the names translated by the shell.
const getScreenshotsFolder = () => GLib.build_filenamev([
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
    Gettext.dgettext('gnome-shell', 'Screenshots'),
]);
const getScreencastsFolder = () => GLib.build_filenamev([
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) || GLib.get_home_dir(),
    Gettext.dgettext('gnome-shell', 'Screencasts'),
]);

const getThumbnailPath = (uri, size) => GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'thumbnails', size, `${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1)}.png`,
]);

// A thumbnail at least as new as its file.
const findThumbnail = (item) => {
    for (const size of THUMBNAIL_SIZES) {
        const path = getThumbnailPath(item.uri, size);
        try {
            const info = Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_modification_date_time().to_unix() >= item.mtime) return path;
        } catch (e) {
            // No thumbnail of this size.
        }
    }
    return null;
};

// The newest images or videos of a folder, newest first. A missing folder has none.
const listCaptures = async (path, video, cancellable) => {
    const items = [];
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name,standard::content-type,standard::is-hidden,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
        for (let infos; (infos = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, cancellable)).length > 0;) {
            for (const info of infos) {
                const contentType = info.get_content_type() ?? '';
                if (info.get_is_hidden() || !contentType.startsWith(video ? 'video/' : 'image/')) continue;
                const file = enumerator.get_child(info);
                items.push({ path: file.get_path(), uri: file.get_uri(), mtime: info.get_modification_date_time().to_unix(), video });
            }
        }
        await enumerator.close_async(GLib.PRIORITY_LOW, null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) logError(e);
    }
    return items.sort((a, b) => b.mtime - a.mtime).slice(0, ITEM_COUNT);
};

// When a capture was taken: the time today, "Yesterday", the day this year and the date before.
const formatCaptureTime = (mtime, clockFormat) => {
    const date = GLib.DateTime.new_from_unix_local(mtime);
    const now = GLib.DateTime.new_now_local();
    const sameDay = (a, b) => a.get_year() === b.get_year() && a.get_day_of_year() === b.get_day_of_year();

    if (sameDay(date, now)) {
        return date.format(clockFormat === '12h' ? '%l:%M %p' : '%R').trim();
    }
    if (sameDay(date.add_days(1), now)) {
        return _('Yesterday');
    }
    return date.format(date.get_year() === now.get_year() ? '%e %b' : '%e %b %Y').trim();
};

// The latest screenshots and recordings with their thumbnails and the lengths of the recordings.
// onChanged() is called when they change.
class CaptureLibrary {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._screenshots = [];
        this._recordings = [];
        // Lengths of recordings in seconds and files the helper could not read, by path and modification time.
        this._durations = new Map();
        this._failed = new Set();
        this._helper = null;
        this._helperPending = false;
    }

    // tab: 'all', 'screenshots' or 'recordings'
    getItems(tab) {
        const items = tab === 'screenshots' ? this._screenshots
            : tab === 'recordings' ? this._recordings
                : [...this._screenshots, ...this._recordings].sort((a, b) => b.mtime - a.mtime).slice(0, ITEM_COUNT);
        return items.map(item => ({
            ...item,
            thumbnail: findThumbnail(item),
            duration: this._durations.get(`${item.path}:${item.mtime}`) ?? null,
        }));
    }

    // The folder for the open captures button, All opens the folder of the newest capture.
    getFolder(tab) {
        const newest = this.getItems('all')[0];
        const folder = tab === 'recordings' || (tab === 'all' && newest?.video) ? getScreencastsFolder() : getScreenshotsFolder();
        // Before the first capture the folder does not exist yet.
        return GLib.file_test(folder, GLib.FileTest.IS_DIR) ? folder : GLib.path_get_dirname(folder);
    }

    // With details the missing thumbnails and lengths are made, which only matters while the overlay is open.
    async refresh(details) {
        const [screenshots, recordings] = await Promise.all([
            listCaptures(getScreenshotsFolder(), false, this._cancellable),
            listCaptures(getScreencastsFolder(), true, this._cancellable),
        ]);
        if (this._cancellable.is_cancelled()) return;
        this._screenshots = screenshots;
        this._recordings = recordings;
        this._onChanged();
        if (details) this._readDetails();
    }

    // Runs the helper for the shown captures without a thumbnail or length, one helper at a time.
    _readDetails() {
        if (this._helper) {
            this._helperPending = true;
            return;
        }

        const key = item => `${item.path}:${item.mtime}`;
        const items = [...this._screenshots, ...this._recordings]
            .filter(item => !this._failed.has(key(item)))
            .map(item => ({ ...item, thumbnail: findThumbnail(item) ? null : getThumbnailPath(item.uri, THUMBNAIL_SIZES[0]) }))
            .filter(item => item.thumbnail || (item.video && !this._durations.has(key(item))));
        if (items.length === 0 || !GLib.find_program_in_path('gjs')) return;

        try {
            this._helper = Gio.Subprocess.new(['gjs', '-m', HELPER, JSON.stringify(items)], Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            logError(e);
            return;
        }
        const helper = this._helper;
        helper.communicate_utf8_async(null, this._cancellable).then(([stdout]) => {
            const results = new Map((stdout ?? '').split('\n').filter(line => line).map(line => {
                const result = JSON.parse(line);
                return [result.path, result];
            }));
            items.forEach(item => {
                const result = results.get(item.path);
                if (result?.duration !== null && result?.duration !== undefined) {
                    this._durations.set(key(item), result.duration);
                }
                // Not tried again until the file changes.
                if (!result || (item.thumbnail && !result.thumbnail) || (item.video && result.duration === null)) {
                    this._failed.add(key(item));
                }
            });
            this._onChanged();
        }).catch(logError).finally(() => {
            if (this._helper !== helper) return;
            this._helper = null;
            if (this._helperPending) {
                this._helperPending = false;
                this._readDetails();
            }
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._helper?.force_exit();
        this._helper = null;
    }
}

export class Gallery {
    // runWithOverlayClosed(callback) closes the overlay first, so the opened file or folder is not behind it.
    constructor(overlay, primaryMonitor, runWithOverlayClosed) {
        this._overlay = overlay;
        this._primaryMonitor = primaryMonitor;
        this._runWithOverlayClosed = runWithOverlayClosed;
        this._addonContainer = null;
        this._widthChangeId = null;
        this._heightChangeId = null;
        this._visibilityChangedId = null;
        this._tab = 'all';
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._library = new CaptureLibrary(() => this._render());
        this._createGalleryWidget();
        // The card has its size before the overlay opens for the first time.
        this._library.refresh(false).catch(logError);
    }

    _createGalleryWidget() {
        this._addonContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout()
        });

        const folderButton = createIconButton('folder-open-symbolic');
        folderButton.accessible_name = _('Open Captures Folder');
        folderButton.x_align = Clutter.ActorAlign.CENTER;
        folderButton.connect('clicked', () => this._open(this._library.getFolder(this._tab)));

        const { card, body } = createCard(_('Gallery'), 'gamebar-gallery-card', () => setCardHidden('gallery', true), folderButton);

        const tabs = [
            { id: 'all', name: _('All') },
            { id: 'screenshots', name: _('Screenshots') },
            { id: 'recordings', name: _('Recordings') },
        ];
        this._tabBar = new TabBar(card, body, id => {
            this._tab = id;
            this._tabBar.selected = id;
            this._render();
        });
        this._tabBar.setTabs(tabs);
        this._tabBar.selected = this._tab;

        this._emptyLabel = createLabel('', 'gamebar-dim', { x_expand: true });
        this._emptyList = new BoxedList();
        const emptyRow = createRow();
        emptyRow.add_child(this._emptyLabel);
        this._emptyList.addRow(emptyRow);
        body.add_child(this._emptyList.actor);

        this._grid = new St.BoxLayout({ vertical: true, style_class: 'gamebar-gallery-grid', x_expand: true });
        body.add_child(this._grid);
        this._render();

        this._addonContainer.add_child(card);
        this._overlay.add_child(this._addonContainer);
        makeDraggable(this._addonContainer, 'gallery');

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

        // New captures are taken while the overlay is closed, it looks again every time it opens.
        this._visibilityChangedId = this._overlay.connect('notify::visible', () => {
            if (this._overlay.visible) this._library.refresh(true).catch(logError);
        });
        if (this._overlay.visible) this._library.refresh(true).catch(logError);
    }

    _render() {
        if (!this._grid || !this._library) return;

        const items = this._library.getItems(this._tab);
        this._emptyList.actor.visible = items.length === 0;
        this._emptyLabel.text = this._tab === 'screenshots' ? _('No screenshots yet')
            : this._tab === 'recordings' ? _('No recordings yet') : _('No screenshots or recordings yet');

        // Rows of three, a row that is not full keeps the width of the tiles.
        this._grid.destroy_all_children();
        this._grid.visible = items.length > 0;
        const clockFormat = this._interfaceSettings.get_string('clock-format');
        for (let start = 0; start < items.length; start += COLUMNS) {
            const row = new St.BoxLayout({ style_class: 'gamebar-gallery-row', x_expand: true });
            row.layout_manager.homogeneous = true;
            for (let index = start; index < start + COLUMNS; index++) {
                row.add_child(items[index] ? this._createTile(items[index], clockFormat) : new St.Widget({ x_expand: true }));
            }
            this._grid.add_child(row);
        }
    }

    // Thumbnail with an icon in the middle, the time at the bottom left and the length of a recording at the bottom right.
    // The bin layout only aligns children that expand.
    _createTile(item, clockFormat) {
        const content = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });

        content.add_child(new St.Bin({
            style_class: 'gamebar-thumb-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: item.video ? 'media-playback-start-symbolic' : 'image-x-generic-symbolic',
                icon_size: 16,
            }),
        }));

        content.add_child(new St.Label({
            style_class: 'gamebar-thumb-badge gamebar-numeric',
            text: formatCaptureTime(item.mtime, clockFormat),
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        }));

        if (item.video && item.duration !== null) {
            content.add_child(new St.Label({
                style_class: 'gamebar-thumb-badge gamebar-numeric',
                text: formatPlaybackTime(item.duration),
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
            }));
        }

        const tile = new St.Button({
            style_class: 'gamebar-thumb',
            x_expand: true,
            accessible_name: GLib.path_get_basename(item.path),
            child: content,
        });
        if (item.thumbnail) {
            // A background image follows the rounded corners, like the cover of the Music card.
            const escaped = item.thumbnail.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            tile.style = `background-image: url("${escaped}"); background-size: cover;`;
        }
        tile.connect('clicked', () => this._open(item.path));
        return tile;
    }

    // Opens a capture or a folder in its app once the overlay is closed.
    _open(path) {
        this._runWithOverlayClosed(() => {
            try {
                Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), global.create_app_launch_context(0, -1));
            } catch (e) {
                logError(e);
            }
        });
    }

    set_addon_position() {
        positionAddon(this._primaryMonitor, this._addonContainer, 'gallery');
    }

    _updateSettings(settings) {
        this._destroyWidget();
        this._createGalleryWidget();
    }

    _destroyWidget() {
        if (this._visibilityChangedId) {
            this._overlay.disconnect(this._visibilityChangedId);
            this._visibilityChangedId = null;
        }

        if (this._heightChangeId) {
            this._addonContainer.disconnect(this._heightChangeId);
            this._heightChangeId = null;
        }

        if (this._widthChangeId) {
            this._addonContainer.disconnect(this._widthChangeId);
            this._widthChangeId = null;
        }

        this._addonContainer?.destroy();
        this._addonContainer = null;
        this._grid = null;
        this._tabBar = null;
    }

    destroy() {
        this._destroyWidget();
        this._library?.destroy();
        this._library = null;
        this._interfaceSettings = null;
    }
}
