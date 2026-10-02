# Design

The overlay follows the GNOME Adwaita look. The design was made with claude.design and lives in `design/`:

- `design/gnome-game-overlay-handoff.md`: design tokens, layout and the description of every card.
- `design/overlay-mockup.dc.html`: the HTML/CSS mockup at 1920×1080. It needs the design tool's runtime and does not render in a browser, read it as text for exact values.

The design has more cards (Battery, Capture, Gallery, Music, Discord) and a dash at the bottom to show and hide cards. Only the cards the extension already had are implemented: Audio, Clock and Hardware.

This file records where the implementation follows the design, where it departs from it and why.

## Cards

All cards are built from the helpers in `card.js` and styled in `stylesheet.css`:

| Part | Value |
|---|---|
| Card | `#222226`, radius 15px, 1px outline `rgba(255,255,255,0.09)`, font size 15px |
| Header bar | 46px high, bold centred title |
| Body padding | `0 12px 12px` (headerless cards: `20px 12px`) |
| Group title | bold, margin `14px 4px 8px`, the first group of a card `4px` on top |
| Boxed list | `rgba(255,255,255,0.08)`, radius 12px |
| Row | min height 50px (64px for two-line rows), padding `0 12px`, spacing 10px |
| Secondary text | `#b5b5ba`, subtitles 13px |
| Numbers | tabular figures (`font-feature-settings: "tnum"`) |

- **Audio** (400px): groups Output, Input and Applications. Output and Input have a device row (opens the device list inside the card, with a check on the active device) and a row with the mute button and the volume slider. Applications has one row per app: icon, name, mute button, slider. The group is hidden when no app plays audio.
- **Clock** (min 400px): no header bar, time and the date below it in secondary grey. The time size is the Font Size setting, 64px by default.
- **Hardware** (400px): one row per CPU and GPU with the temperature as subtitle, a sparkline of the usage of the last 30 seconds in the accent colour and the usage in bold. Without libgtop the CPU row only shows the install hint.

## Departures from the design

- **Group names "Output" and "Input"** instead of "Output" and "Microphone", so both groups are named the same way.
- **Card shadow** `0 2px 4px 0 rgba(0,0,0,0.2)` instead of the design's `0 10px 30px rgba(0,0,0,0.5)`. The design's shadow is far heavier than anything in GNOME. The value is the one of the shell popup menus and Quick Settings. For comparison, libadwaita windows use three centred layers (`0 0 14px 5px` 15%, `0 0 5px 2px` 10%, 1px 5%), which St cannot draw since it supports only one shadow.
- **Row separators** in the card background `#222226` instead of the design's lighter `rgba(255,255,255,0.08)`. GNOME lists show the background between the rows.
- **Mute buttons** are 28×28 (6px padding around a 16px icon), the size of the Quick Settings slider buttons, instead of the design's 44×44.
- **No pin and no close button on the cards.** Without the dash there is no way to show a closed card again, and pinning is not designed yet.
- **No overlay close button.** The overlay closes with Esc, the shortcut, the top bar indicator and a click on an empty area, which is now on by default.
- **No Memory, Disk and Network rows** on the Hardware card yet.
- **Sparklines start empty** each time the overlay opens. Linux keeps no usage history, so the extension only samples while the overlay is open. Sampling in the background would be cheap for the CPU and sysfs GPUs, but `nvidia-smi` is spawned synchronously and would block the shell every second.
- **Device picker** opens inside the card instead of as a popup menu.

## Layout

Cards start in the column layout of the design (`cardPosition.js`):

| Column | Width | Cards |
|---|---|---|
| 1 | 400 | Audio |
| 2 | 520 | (kept free for Capture and Gallery) |
| 3 | 400 | Clock |
| 4 | 400 | Hardware |

Columns are 40px apart and the grid is centred on the monitor, at y = 84. On 1920×1080 this gives the design's x positions 40, 480, 1040 and 1480. On monitors too narrow for the grid the free column is dropped (1280px fits the three cards exactly).

Cards can still be dragged anywhere. Dragged positions are saved as fractions of the monitor size, the Reset button in the preferences moves the cards back to the column layout.

## Behaviour matched to GNOME Shell

Volume and mute follow the Quick Settings sliders (`js/ui/status/volume.js`), in `addons/streamVolume.js`:

- Dragging a slider to 0 mutes the stream, dragging it up unmutes it. A muted stream shows an empty slider and a grey icon and name.
- Clicking the mute button of a stream muted at volume 0 unmutes it at 25%.
- Setting the volume makes the stream notify while it still reports the old mute state. The rows ignore the stream while they set the volume themselves, otherwise the slider jumps back to 0 and that jump is taken as a drag to 0.

Apps without an icon get the symbolic `application-x-executable-symbolic`, app icons are 24px.

## Accent colour

The sliders are the shell's own `Slider` and follow the accent colour. The sparklines are drawn in the text colour of `.gamebar-sparkline`, which is `-st-accent-color` on GNOME 47 and newer and falls back to Adwaita blue `#3584e4` on GNOME 46.

## St pitfalls

- **`x_expand` propagates to the parents.** The expanding rows stretched the cards over the whole overlay, the cards set `x_expand: false` explicitly.
- **Negative margins break `St.BoxLayout`.** The design's `margin-left: -10px` on a leading button gave its siblings broken widths, the row has a smaller left padding instead.
- **`y_align: CENTER` on a `Slider`** gives it no height, the sliders fill the row.
- **`Clutter.cairo_set_source_color` is gone** on GNOME 50, set the colour with `cr.setSourceRGBA()` from the theme node colour.
- **No grid, flex gap or multiple shadows** in St CSS. Layouts are `St.BoxLayout`s with `spacing`.
- **`:first-child`** cannot reach the first group title of a card since every title is the first child of its group, the first title gets its own class.

## Settings removed

These settings were removed together with their rows in the preferences:

- Overlay Opening Monitor and Show App Description (were already unused).
- Padding and the Position of every addon (replaced by the column layout).
- Icon Size (app icons are 24px) and Icon Type (the fallback icon is always symbolic).

The schema defaults changed to match the design: overlay background `rgba(8,9,12,0.62)`, clock size 64, close on empty area click on.

## Testing without logging out

The screenshots for this work came from a headless shell in an isolated home directory, with a copy of the extension that opens the overlay and takes a screenshot:

```sh
export HOME=<scratch>/home XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
export GSETTINGS_BACKEND=keyfile
gsettings set org.gnome.shell enabled-extensions "['gamebar-overlay@dekotale.github.io']"
gsettings set org.gnome.shell disable-extension-version-validation true
dbus-run-session -- gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11
```

Copy the extension to `$HOME/.local/share/gnome-shell/extensions/` first. A `pacat --raw /dev/zero` stream gives the Applications group a silent app to show.
