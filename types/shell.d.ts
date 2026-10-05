// Modules of the shell its types do not have yet. Without imports, so the modules are declared and not augmented.

declare module 'resource:///org/gnome/shell/ui/screenshot.js' {
    export function captureScreenshot(texture: import('@girs/cogl-18').default.Texture, geometry: number[] | null,
        scale: number, cursor: object | null): Promise<void>;
}
