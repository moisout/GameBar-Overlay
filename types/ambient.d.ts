// The modules GJS and GNOME Shell provide, for the type check of the JavaScript (npm run check).
import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
import '@girs/upowerglib-1.0/ambient';
import '@girs/soup-3.0/ambient';
import '@girs/gtop-2.0/ambient';
import '@girs/gst-1.0/ambient';
import '@girs/secret-1/ambient';
import '@girs/gdkpixbuf-2.0/ambient';

// The properties the cards animate.
type AnimatedProperty = 'opacity' | 'x' | 'y' | 'width' | 'height' | 'scale_x' | 'scale_y' | 'translation_x' |
    'translation_y' | 'rotation_angle_z';

declare module '@girs/clutter-18/clutter-18' {
    export namespace Clutter {
        interface Actor {
            // The types only know the camelCase names. ease() of the shell finds the transitions of the properties by
            // their names with the underscores turned into dashes, the names have to be written with underscores.
            ease(params: {
                duration?: number;
                delay?: number;
                mode?: AnimationMode;
                onComplete?: () => void;
                onStopped?: (isFinished: boolean) => void;
            } & Partial<Record<AnimatedProperty, number>>): void;
        }
    }
}
