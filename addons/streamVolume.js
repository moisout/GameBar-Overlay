// Volume and mute handling of the quick settings sliders (gnome-shell js/ui/status/volume.js).

// Volume a stream muted at volume 0 gets back when it is unmuted.
const UNMUTE_DEFAULT_VOLUME = 0.25;

// Dragging the slider to 0 mutes the stream, dragging it up unmutes it.
const setStreamVolume = (control, stream, value) => {
    const volume = value * control.get_vol_max_norm();
    // Setting the volume notifies the slider, which shows 0 while the stream is muted, so read the state first.
    const prevMuted = stream.is_muted;
    let volumeChanged;
    if (volume < 1) {
        volumeChanged = stream.set_volume(0);
        if (!prevMuted) {
            stream.change_is_muted(true);
        }
    } else {
        volumeChanged = stream.set_volume(volume);
        if (prevMuted) {
            stream.change_is_muted(false);
        }
    }
    if (volumeChanged) {
        stream.push_volume();
    }
};

const toggleStreamMute = (control, stream) => {
    const isMuted = stream.is_muted;
    if (isMuted && stream.volume === 0) {
        stream.volume = UNMUTE_DEFAULT_VOLUME * control.get_vol_max_norm();
        stream.push_volume();
    }
    stream.change_is_muted(!isMuted);
};

export { setStreamVolume, toggleStreamMute };
