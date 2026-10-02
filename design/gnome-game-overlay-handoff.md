# GNOME Game Overlay — design handoff

Reference for implementing the overlay as a GNOME Shell extension. The visual source of truth is `overlay-mockup.dc.html` (beside this file) plus a PNG export of the artboard if present.

**How to use the mockup file.** It is an HTML/CSS mockup at 1920×1080, not Shell code. Read it for exact values and structure; do not port it literally. It does not render standalone in a browser (it needs the design tool's runtime), so treat it as text. All data in it (percentages, device names, times) is sample data; bracketed text like `[Track title]` is a placeholder.

## 1. Concept

A full-screen overlay toggled by a shortcut. It dims the desktop or game and shows floating cards the user can drag, pin and close. The GNOME top panel stays visible. A Dash-style bar at the bottom centre toggles each card on and off.

Cards: Audio, Battery, Capture, Gallery, Clock, Music, Discord, Hardware.

## 2. Design tokens

| Token | Value | Used for |
|---|---|---|
| Accent | `#3584e4` (user-configurable; follow the system accent if available) | Slider fill, level bars, sparklines, speaking ring |
| Destructive | `#c01c28` | Record button, Discord disconnect |
| Warning text/bar | `#ff938c` | Low battery |
| Card background | `#222226` | Every card |
| Card outline | 1px `rgba(255,255,255,0.09)` | Every card, the dash |
| Card shadow | `0 10px 30px rgba(0,0,0,0.5)` | Every card |
| Card radius | 15px | |
| Boxed list background | `rgba(255,255,255,0.08)`, radius 12px | Row groups inside cards |
| Row separator | 1px `rgba(255,255,255,0.08)` | Between rows, not above the first |
| Dash background | `#36363a`, radius 24px | Bottom bar |
| Dim layer | `rgba(8,9,12,0.62)` (configurable 0.30–0.90) | Behind cards |
| Text | `#ffffff` | |
| Secondary text | `#b5b5ba` | Subtitles, muted names, inactive tabs |
| Placeholder fill | `#3a3a40` / `#4d4d55` | Thumbnails, cover art, avatars |
| Hover fill | `rgba(255,255,255,0.10)` | Icon buttons |

Type: system UI font (Adwaita Sans, falling back to Cantarell). Base 15px. Card titles and group titles 15px bold. Subtitles 13px. Gallery captions 12px. Clock time 64px bold. Numbers use tabular figures.

Sizes: header bar 46px high. List row 50px min (64px for two-line rows). Icon buttons 44×44px, circular. Symbolic icons 16px; app icons 24px; dash icons 22px. Card body padding 0 12px 12px. Group title margin 14px 4px 8px.

## 3. Layout on a 1920×1080 screen

Default positions (cards are free-floating; these are only the initial placement):

| Column | x | Width | Cards, top to bottom |
|---|---|---|---|
| 1 | 40 | 400 | Audio, Battery |
| 2 | 480 | 520 | Capture, Gallery |
| 3 | 1040 | 400 | Clock, Music, Discord |
| 4 | 1480 | 400 | Hardware |

Columns start at y = 84. Vertical gap between cards 24px. Dash: bottom centre, 20px from the bottom edge.

## 4. Shared components

**Card.** Header bar with three slots: pin button (left), centred bold title, close button (right). The close button is the Adwaita window control: a 24px circle filled `rgba(255,255,255,0.10)` holding a 12px ×, inside a 44px hit area. The whole header bar is the drag handle. Body below.

**Boxed list.** Rounded group of rows with separators, optionally preceded by a bold group title. Matches the look of GNOME Settings.

**Slider.** 4px track, radius 2px, `rgba(255,255,255,0.20)`; filled part in accent; 18px white round knob with a small shadow. Same look as Quick Settings sliders.

**Mute button.** Flat circular icon button directly left of its slider. Muted state: the icon switches to the muted glyph, the icon and label turn secondary grey, the slider shows 0.

**Level bar.** 6px high, radius 3px, track `rgba(255,255,255,0.15)`, fill in accent (warning colour when low).

**Dash.** One 52×56px button per card, radius 14px, icon above a 5px white dot. The dot means the card is currently shown.

## 5. Cards

### Audio (400px)
Three groups:
- **Output:** row 1 is a device picker (label "Device" left, current device and a down arrow right). Row 2 is mute button + volume slider.
- **Microphone:** same two rows.
- **Applications:** one row per app playing audio. Row order: app icon (24px, no background or border), app name (fixed 68px column), mute button, volume slider.

### Battery (400px)
- First list, one 64px row: laptop icon, "This Device" with time remaining as subtitle, level bar, percentage.
- Group "Connected Devices": one row per device: device-type icon, name, level bar, percentage. Low battery adds a "Low battery" subtitle and the warning colour on both subtitle and bar.

### Capture (520px)
Two equal-width pill buttons (46px high, radius 23px, bold label with icon): "Take Screenshot" (neutral fill `rgba(255,255,255,0.10)`) and "Record Screen" (destructive fill).

Not designed yet: the recording-in-progress state (timer, stop button).

### Gallery (520px)
- Header bar: pin and "open captures folder" buttons on the left, title, close on the right.
- Tab bar directly under the header, styled like the tab bar in GNOME Files: three equal-width tabs (All, Screenshots, Recordings), 44px high, radius 9px. Selected tab: fill `rgba(255,255,255,0.11)`, white bold text. Unselected: secondary grey text, with a thin vertical separator between adjacent unselected tabs. No horizontal line between the tabs and the content.
- Content: 3-column grid, 8px column gap, 12px row gap. Each item is a 16:9 thumbnail (radius 8px) with a caption below: "Screenshot · time" or "Recording · duration · time".

### Clock (400px)
No header bar. Centred time (64px bold) with the date below in secondary grey. 20px padding top and bottom. The whole card is the drag handle; it has no pin or close button and is hidden only via the dash.

### Music (400px)
Generic player card, not tied to one app. A single boxed group containing:
- Row 1: 56px cover art (radius 8px), track title (bold) over "artist · player app" (subtitle), then previous / play-pause / next as flat circular buttons.
- Row 2: elapsed time, seek slider, total time.

Not designed yet: switching between several active players.

### Discord (400px)
- Group title: voice channel name, with the server name in secondary grey.
- List of members: 32px round avatar, name, status on the right. Speaking: 2px accent ring around the avatar and "Speaking". Muted: grey name, "Muted" and a muted-mic icon.
- Below, centred: three circular 44px buttons: mute, deafen (both neutral fill), disconnect (destructive fill).

### Hardware (400px)
One boxed list, five 64px rows:
- **CPU:** name with temperature subtitle, sparkline in accent, usage percentage (bold).
- **GPU:** name with temperature and VRAM subtitle, sparkline, usage percentage.
- **Memory:** name with "used of total" subtitle, level bar, percentage.
- **Disk:** same pattern as Memory.
- **Network:** name, then download and upload rates, each with an arrow icon.

## 6. Behaviour the mockup cannot show

- **Open/close:** a keyboard shortcut toggles the overlay; Esc closes it. The shortcut itself is not decided.
- **Dragging:** drag a card by its header bar (Clock: anywhere). Positions persist across sessions.
- **Pin:** intended meaning is "stay visible after the overlay closes". The pinned visual state and click-through behaviour are not designed yet.
- **Close:** hides the card; the dash dot for that card disappears. Clicking the dash button shows it again.
- **Mute buttons, tabs, media and call buttons:** all toggle; only the resting states listed above are drawn.

## 7. Translating to GNOME Shell

These are implementation suggestions from the designer, not verified against a specific Shell version. Check each against the Shell version the extension targets.

- **No HTML layout in Shell.** St's CSS subset has no grid and no flex `gap`. Build layouts from `St.BoxLayout` (with `spacing`) and `St.Widget` with a layout manager; the gallery grid needs a grid or flow layout manager.
- **Sliders:** use Shell's own `Slider` (`resource:///org/gnome/shell/ui/slider.js`) instead of restyling anything. It already has the Quick Settings look.
- **Device pickers:** the mockup uses HTML selects. In Shell, open a popup menu from the row.
- **Icons:** the SVG paths in the mockup are stand-ins. Use Adwaita symbolic icons by name (`St.Icon` with `icon_name`), and load app icons from each app's desktop entry.
- **Sparklines:** draw with `St.DrawingArea` and Cairo.
- **Accent colour:** prefer the system accent over a hard-coded blue where the Shell version exposes it.
- **Reuse Shell styles** where they match (quick-settings, popup-menu, dash classes) so the overlay follows theme changes.

Likely data sources, also to be verified:

| Card | Source to investigate |
|---|---|
| Audio | Shell's mixer control (Gvc), which exposes sinks, sources and per-app streams |
| Battery | UPower over D-Bus (includes connected peripherals that report battery) |
| Capture | Shell's built-in screenshot and screencast services |
| Gallery | The user's Screenshots and Screencasts folders |
| Music | MPRIS players on the session bus |
| Hardware | `/proc` and sysfs; GPU stats are vendor-specific |
| Discord | Discord's local RPC socket; voice-channel access may need an approved Discord application, so confirm feasibility first |

## 8. Open questions

1. Overlay shortcut.
2. Pinned-card appearance and click-through.
3. Recording-in-progress state on the Capture card.
4. Player switching on the Music card.
5. Whether the Discord card is feasible with the access Discord grants.
