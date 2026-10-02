// Thumbnails and durations for the Gallery card, run as its own gjs process so a broken file or codec cannot
// take the shell down and decoding does not block it.
//
// gjs -m galleryThumbnailer.js '[{"path", "uri", "mtime", "video", "thumbnail"}, ...]'
// thumbnail is the file to write the thumbnail to, or null when it already has one.
// Prints one JSON line per file: {"path", "thumbnail": true when written, "duration": seconds or null}.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

// x-large thumbnails of the freedesktop thumbnail spec, sharp on the tiles at 200%.
const SIZE = 512;
// How long a video may take to open or to seek.
const TIMEOUT = 5;

let Gst = null;
try {
    Gst = (await import('gi://Gst?version=1.0')).default;
    Gst.init(null);
} catch (e) {
    // Without GStreamer recordings get no thumbnail and no duration.
}

const scaleDown = (pixbuf) => {
    const scale = Math.min(1, SIZE / Math.max(pixbuf.width, pixbuf.height));
    if (scale === 1) return pixbuf;
    return pixbuf.scale_simple(Math.max(1, Math.round(pixbuf.width * scale)), Math.max(1, Math.round(pixbuf.height * scale)),
        GdkPixbuf.InterpType.BILINEAR);
};

// Like the thumbnailers of GNOME: with the URI and modification time of the file, written to a temporary file first.
const saveThumbnail = (pixbuf, item) => {
    GLib.mkdir_with_parents(GLib.path_get_dirname(item.thumbnail), 0o700);
    const temporary = `${item.thumbnail}.${new Gio.Credentials().get_unix_pid()}.tmp`;
    scaleDown(pixbuf).savev(temporary, 'png', ['tEXt::Thumb::URI', 'tEXt::Thumb::MTime'], [item.uri, String(item.mtime)]);
    Gio.File.new_for_path(temporary).move(Gio.File.new_for_path(item.thumbnail), Gio.FileCopyFlags.OVERWRITE, null, null);
};

// The length of a video and, if wanted, a frame a little into it, the first frame is often black.
const readVideo = (item) => {
    if (!Gst) return { duration: null, pixbuf: null };

    const playbin = Gst.ElementFactory.make('playbin', null);
    playbin.uri = item.uri;
    // Video only, nothing is played.
    playbin.flags = 1;
    playbin.video_sink = Gst.ElementFactory.make('fakesink', null);
    playbin.audio_sink = Gst.ElementFactory.make('fakesink', null);

    try {
        playbin.set_state(Gst.State.PAUSED);
        if (playbin.get_state(TIMEOUT * Gst.SECOND)[0] === Gst.StateChangeReturn.FAILURE) {
            return { duration: null, pixbuf: null };
        }

        const [hasDuration, duration] = playbin.query_duration(Gst.Format.TIME);
        let pixbuf = null;
        if (item.thumbnail) {
            const position = hasDuration ? Math.min(duration / 10, 3 * Gst.SECOND) : 0;
            playbin.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE, position);
            playbin.get_state(TIMEOUT * Gst.SECOND);

            const sample = playbin.emit('convert-sample', Gst.Caps.from_string('image/png'));
            const buffer = sample?.get_buffer();
            if (buffer) {
                const [mapped, info] = buffer.map(Gst.MapFlags.READ);
                if (mapped) {
                    const bytes = GLib.Bytes.new(info.data);
                    buffer.unmap(info);
                    pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
                }
            }
        }
        return { duration: hasDuration ? duration / Gst.SECOND : null, pixbuf };
    } finally {
        playbin.set_state(Gst.State.NULL);
    }
};

for (const item of JSON.parse(ARGV[0] ?? '[]')) {
    const result = { path: item.path, thumbnail: false, duration: null };
    try {
        let pixbuf = null;
        if (item.video) {
            ({ duration: result.duration, pixbuf } = readVideo(item));
        } else if (item.thumbnail) {
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(item.path, SIZE, SIZE, true);
        }
        if (pixbuf && item.thumbnail) {
            saveThumbnail(pixbuf, item);
            result.thumbnail = true;
        }
    } catch (e) {
        printerr(`${item.path}: ${e.message}`);
    }
    print(JSON.stringify(result));
}
