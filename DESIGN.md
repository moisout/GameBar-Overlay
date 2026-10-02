# Design

The overlay follows the GNOME Adwaita look. The design was made with claude.design and lives in `design/`:

- `design/gnome-game-overlay-handoff.md`: design tokens, layout and the description of every card.
- `design/overlay-mockup.dc.html`: the HTML/CSS mockup at 1920×1080. It needs the design tool's runtime and does not render in a browser, read it as text for exact values.

Implemented are the Audio, Capture, Gallery, Clock, Hardware, Battery and Music cards, together with the dash at the bottom that shows and hides them. The Discord card of the design is not implemented yet.

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
- **Capture** (520px): the pill buttons "Take Screenshot" and "Record Screen" (destructive). Both close the overlay first and wait until the overlay and its backdrop are gone, showing the overlay again in between cancels them. Both capture the monitor of the overlay right away:
  - The screenshot works like the Shift+Print key of the shell (`Shell.Screenshot.screenshot_stage_to_content()` and `captureScreenshot()` from `screenshot.js`), cropped to the monitor: saved to the screenshots folder and the clipboard, with the sound and the notification of the shell, without the pointer.
  - The recording goes through the screenshot UI of the shell, so the shell shows its recording indicator with the stop button and the notification. The screenshot UI has no API to record a monitor right away: its screen mode and the monitor are set on its private buttons, `_startScreencast()` reads the area before its first await, and the previous mode is restored right after. Without these internals the screenshot UI opens in screencast mode instead.
  - While a recording runs the record button turns into "Stop Recording", the design has no recording state. Without PipeWire or the GStreamer plugins the record button is disabled.
- **Gallery** (520px): the tabs All, Screenshots and Recordings below the header, and the six latest captures of the tab in rows of three (8px apart, rows 12px apart). A tile is the 16:9 thumbnail with radius 8px, an icon in the middle (a picture for screenshots, play for recordings), the time at the bottom left and the length of a recording at the bottom right. The time is the time today in the clock format of GNOME, "Yesterday", the day this year and the date before. Clicking a tile opens the capture in its app once the overlay is closed. The button on the left of the header opens the folder of the tab, All opens the folder of the newest capture.
  - The captures are read from the folders the shell saves to, `Pictures/Screenshots` and `Videos/Screencasts` with the folder names translated by the shell, every time the overlay opens.
  - Thumbnails come from the freedesktop thumbnail cache (`~/.cache/thumbnails`), so the ones of GNOME Files are used too. Missing ones and the lengths of recordings are made by `helpers/galleryThumbnailer.js`, a gjs process of its own: decoding in the shell would block it, and a broken file or codec could take it down. Screenshots are scaled with GdkPixbuf, recordings are opened with GStreamer for their length and a frame 10% in (at most 3 s), the first frame is often black. Thumbnails are x-large (512px) like the spec, sharp at 200%, with the URI and modification time of the file. Files it cannot read are not tried again until they change.
  - Thumbnails are a background image, which follows the rounded corners. The time and length are on dark badges and the icon on a dark circle, readable on any thumbnail.
- **Battery** (400px): "This Device" with the state as subtitle ("3 h 10 min remaining", "Fully charged", ...), a level bar and the percentage, from the UPower display device. Below it the group "Connected Devices": mice, headsets, controllers and other devices with a battery, with an icon for their type. A low battery (the warning level of UPower) shows "Low battery" and the bar in the warning colour `#ff938c`. Without any battery the card says so. UPower is read over D-Bus with proxies, the device lists of UPowerGlib are freed too early in GJS.
- **Music** (400px): one boxed group with the cover (56px, radius 8px), the title in bold over "artist · player app", and the previous, play/pause and next buttons. Below them the elapsed time, a seek slider and the length. The players are found over MPRIS on the session bus like the media controls of the shell, which has no position and whose API differs between GNOME versions, so the card has its own proxies:
  - The card shows the player that played last, playing players before paused ones. Stopped players have no track and are left out. Without a player the card says "Nothing playing".
  - With several players a tab bar below the header switches between them. The design leaves switching open, the tab bar is the one of the Gallery card (like GNOME Files): equal-width tabs, 44px high, radius 9px, the selected one filled `rgba(255,255,255,0.11)` and bold, a separator between two unselected tabs. Tabs are named after the app, players of the same app (two browser tabs) after their track, and stay in the order the players appeared. A picked player stays shown until it goes away or the overlay closes, then the card shows the player that played last again.
  - Players do not announce their position. It is read when the overlay opens, when the status or the track changes and on `Seeked`, and counted on between reads while playing.
  - Dragging the slider seeks once it is let go, with `SetPosition`, or with `Seek` for players without a valid track id. Streams have no length, their card has no slider. Buttons the player does not offer are greyed out.
  - Covers are a background image, which follows the rounded corners like the user avatars of the shell. `file://` covers are shown as they are, covers on the web (Spotify) are downloaded with libsoup to `~/.cache/gamebar-overlay@m0.is/covers`, keeping only the last one.
- **Hardware** (400px): one boxed list with these rows:
  - **CPU** and **GPU**: the temperature as subtitle, a sparkline of the usage of the last 30 seconds in the accent colour and the usage in bold. On amdgpu the GPU subtitle adds the VRAM in use (sysfs `mem_info_vram_used`). Without libgtop the CPU row only shows the install hint.
  - **Memory**: "used of total" in GiB, a level bar and the percentage. Used is total minus available from `/proc/meminfo`, like GNOME System Monitor.
  - **Disk**: the same for the root filesystem in GB. The percentage is used of the whole size like GNOME Settings, so it is a few points lower than `df`, which leaves out the space reserved for root.
  - **Network**: download and upload rate from `/proc/net/dev`, counting only interfaces with a device behind them. Loopback, VPN and container interfaces would count the same traffic twice.

## Departures from the design

- **Group names "Output" and "Input"** instead of "Output" and "Microphone", so both groups are named the same way.
- **Card shadow** `0 2px 4px 0 rgba(0,0,0,0.2)` instead of the design's `0 10px 30px rgba(0,0,0,0.5)`. The design's shadow is far heavier than anything in GNOME. The value is the one of the shell popup menus and Quick Settings. For comparison, libadwaita windows use three centred layers (`0 0 14px 5px` 15%, `0 0 5px 2px` 10%, 1px 5%), which St cannot draw since it supports only one shadow.
- **Row separators** in the card background `#222226` instead of the design's lighter `rgba(255,255,255,0.08)`. GNOME lists show the background between the rows.
- **Mute and media buttons** are 28×28 (6px padding around a 16px icon), the size of the Quick Settings slider buttons, instead of the design's 44×44.
- **No pin button on the cards.** Pinning is not designed yet, the slot opposite the close button stays empty so the title stays centred.
- **No overlay close button.** The overlay closes with Esc, the shortcut, the top bar indicator and a click on an empty area, which is now on by default.
- **No VRAM on Nvidia GPUs.** It would need `nvidia-smi`, which is spawned synchronously (see the sparklines below). Intel GPUs have no VRAM of their own.
- **Network arrows** are the Adwaita `go-down` and `go-up` chevrons. Adwaita has no plain arrows, and its `network-receive` and `network-transmit` icons are horizontal arrow pairs.
- **Sparklines start empty** each time the overlay opens. Linux keeps no usage history, so the extension only samples while the overlay is open. Sampling in the background would be cheap for the CPU and sysfs GPUs, but `nvidia-smi` is spawned synchronously and would block the shell every second.
- **Device picker** opens inside the card instead of as a popup menu.
- **Player tabs** on the Music card, the design has no way to switch between players yet.
- **Gallery tiles** show the type as an icon in the middle and the time and length on the thumbnail, instead of a caption like "Recording · 0:42 · 21:31" below it.
- **Dash buttons** are square, 52×52 instead of the design's 52×56.
- **Close cross** is the 16px `window-close-symbolic` icon of the libadwaita window controls instead of the design's 12px icon. Adwaita's cross takes only half the icon, at 12px it was a tiny 6px.

## Dash and closing cards

The dash (`addons/dash.js`) sits at the bottom centre, 20px from the edge: `#36363a`, radius 24px, padding 8px, a 52×52 button per card with a 22px icon and a 5px dot that shows the card is shown. Clicking a button shows or hides its card. The dash is not draggable.

Audio and Hardware have the Adwaita window control in their header bar: a 24px circle filled `rgba(255,255,255,0.10)` with the 16px `window-close-symbolic` icon in a 44px hit area. The Clock has no header bar and is only hidden from the dash, as in the design.

- Closed cards are saved in the `hidden-cards` setting and stay closed across sessions, like dragged positions.
- Closing and showing a card while the overlay is open fades and scales it (200ms, from 90%).
- The enter and exit animations only move the shown cards. The overlay hides once every animated card has faded out, and the transition of a hidden actor might never finish.
- The Hardware card does not exist without any row, the dash then has no button for it.
- Clicks on the dash do not count as clicks on the empty area.

## Layout

Cards start in the column layout of the design (`cardPosition.js`):

| Column | Width | Cards, top to bottom |
|---|---|---|
| 1 | 400 | Audio, Battery |
| 2 | 520 | Capture, Gallery |
| 3 | 400 | Clock, Music |
| 4 | 400 | Hardware |

Columns are 40px apart and the grid is centred on the monitor, at y = 84. The cards of a column are stacked 24px apart, closed, dragged away and missing cards leave no gap, and the cards below a card move along when its height changes. On 1920×1080 this gives the design's x positions 40, 480, 1040 and 1480.

Monitors too narrow for the four columns get fewer:

| Monitor width | Columns |
|---|---|
| 1920 and more | Audio, Battery · Capture, Gallery · Clock, Music · Hardware |
| 1480 to 1919 | Audio, Battery, Music · Clock, Capture, Gallery · Hardware |
| below 1480 | Audio, Battery, Music · Clock, Capture, Gallery, Hardware |

On 1280×800 not every card fits above the dash, the bottom of the Hardware card reaches behind it. The dash is always kept above the cards.

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
- **Stopping `button-press-event` on a parent cancels the click of the buttons inside.** On GNOME 50 `St.Button` recognises clicks with a gesture, and a press stopped further up never completes it. Cards and the dash only stop the release, which keeps a click on them from counting as a click on the empty area.
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
gsettings set org.gnome.shell enabled-extensions "['gamebar-overlay@m0.is']"
gsettings set org.gnome.shell disable-extension-version-validation true
dbus-run-session -- gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11
```

Copy the extension to `$HOME/.local/share/gnome-shell/extensions/` first. Export the variables before `dbus-run-session`: services started by D-Bus, like the screen recorder of the shell, take their home from the D-Bus daemon and would otherwise save to the real home. Real clicks can be tested with a virtual pointer from `Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)`. Its absolute motion loses the y coordinate in the headless shell, so steer it with relative motion and check `global.get_pointer()`. Hide the overview first, it grabs the input. A `pacat --raw /dev/zero` stream gives the Applications group a silent app to show.
