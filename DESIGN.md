# Design

The overlay follows the GNOME Adwaita look. It has the Audio, Capture, Gallery, Clock, Hardware, Battery, Music, Discord and Settings cards, together with the dash at the bottom that shows and hides them.

This file records how the overlay looks and behaves, and why.

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

- **Audio** (440px, room for the names of the apps): groups Output, Input and Applications. Output and Input have a device row (opens the device list inside the card, with a check on the active device) and a row with the mute button and the volume slider. Applications starts with "System Sounds" like the volume levels of GNOME Settings, the volume of the event sounds with the name and the icon (`audio-x-generic`) Gvc gives it, followed by one row per app: icon, name, mute button, slider. The group is hidden without System Sounds and without an app playing audio.
- **Clock** (min 400px): no header bar, time and the date below it in secondary grey. The time size is the Font Size setting, 64px by default. The time follows the clock format of GNOME, 12 or 24 hours.
- **Capture** (520px): the pill buttons "Take Screenshot" and "Record Screen" (destructive). Both close the overlay first and wait until the overlay and its backdrop are gone, showing the overlay again in between cancels them. Both capture the monitor of the overlay right away:
  - The screenshot works like the Shift+Print key of the shell (`Shell.Screenshot.screenshot_stage_to_content()` and `captureScreenshot()` from `screenshot.js`), cropped to the monitor: saved to the screenshots folder and the clipboard, with the sound and the notification of the shell, without the pointer.
  - The recording goes through the screenshot UI of the shell, so the shell shows its recording indicator with the stop button and the notification. The screenshot UI has no API to record a monitor right away: its screen mode and the monitor are set on its private buttons, `_startScreencast()` reads the area before its first await, and the previous mode is restored right after. Without these internals the screenshot UI opens in screencast mode instead.
  - While a recording runs the record button turns into "Stop Recording". Without PipeWire or the GStreamer plugins the record button is disabled.
- **Gallery** (520px): the tabs All, Screenshots and Recordings below the header, and the six latest captures of the tab in rows of three (8px apart, rows 12px apart). A tile is the 16:9 thumbnail with radius 8px, an icon in the middle (a picture for screenshots, play for recordings), the time at the bottom left and the length of a recording at the bottom right. The time is the time today in the clock format of GNOME, "Yesterday", the day this year and the date before. Clicking a tile opens the capture in its app once the overlay is closed. The button on the left of the header opens the folder of the tab, All opens the folder of the newest capture. The card is hidden until it is shown from the dash.
  - The captures are read from the folders the shell saves to, `Pictures/Screenshots` and `Videos/Screencasts` with the folder names translated by the shell, every time the overlay opens.
  - Thumbnails come from the freedesktop thumbnail cache (`~/.cache/thumbnails`), so the ones of GNOME Files are used too. Missing ones and the lengths of recordings are made by `helpers/galleryThumbnailer.js`, a gjs process of its own: decoding in the shell would block it, and a broken file or codec could take it down. Screenshots are scaled with GdkPixbuf, recordings are opened with GStreamer for their length and a frame 10% in (at most 3 s), the first frame is often black. Thumbnails are x-large (512px) like the spec, sharp at 200%, with the URI and modification time of the file. Files it cannot read are not tried again until they change. A helper that takes longer than 30 seconds is ended.
  - Thumbnails are a background image, which follows the rounded corners. The time and length are on dark badges and the icon on a dark circle, readable on any thumbnail.
- **Battery** (440px): "This Device" with the state as subtitle ("3 h 10 min remaining", "Fully charged", ...), a level bar and the percentage, from the UPower display device. Below it the group "Connected Devices": mice, headsets, controllers and other devices with a battery, with an icon for their type. A low battery (the warning level of UPower) shows "Low battery" and the bar in the warning colour `#ff938c`. A device that is charging shows "Charging" or "Fully charged" instead, without the warning: its battery is being taken care of. Without any battery the card says so.
  - The batteries come from sources in `addons/batterySources/`, each turned on in the preferences (Battery page). UPower is on by default, the others are off. One `BatteryModel` reads them for the card and its pinned copies, so a receiver is opened once.
  - **UPower** (`upower.js`): the computer and the devices the system knows. Read over D-Bus with proxies, the device lists of UPowerGlib are freed too early in GJS.
  - **Logitech Receivers** (`logitech.js`, protocol in `hidpp.js`): mice and keyboards on Logitech receivers, read over HID++ 2.0 on `/dev/hidraw*` like Solaar does. The kernel has no driver for the Logi Bolt receiver (support was merged for 7.3 and reverted before the release), so its devices never reach UPower. The source pings the receiver's slots, finds UNIFIED_BATTERY, BATTERY_STATUS or BATTERY_VOLTAGE, and follows the battery events and the connection notifications of the receiver (it turns them on in register 0x00 if Solaar has not). A device that goes to sleep keeps its last level, one that never answered since the start is not listed. The node is opened once and read with a pollable stream in the main loop, every request has a 2 s timeout. New receivers are looked for every 30 s, the batteries read again every 10 minutes. Nodes of devices the kernel driver handles (`logitech-hidpp-device`) are skipped. Opening a node needs the udev rule of Solaar, the preferences warn without it. Solaar can run at the same time, requests carry a software ID of their own.
  - A device already listed by an earlier source is left out by its name: the kernel names a Logitech device in UPower with its HID++ name.
  - `tests/hidppProbe.js` prints the Logitech devices without the shell: `gjs -m tests/hidppProbe.js`.
- **Music** (400px): one boxed group with the cover (56px, radius 8px), the title in bold over "artist · player app", and the previous, play/pause and next buttons. Below them the elapsed time, a seek slider and the length. The players are found over MPRIS on the session bus like the media controls of the shell, which has no position and whose API differs between GNOME versions, so the card has its own proxies:
  - The card shows the player that played last, playing players before paused ones. Stopped players have no track and are left out. Without a player the card says "Nothing playing".
  - With several players a tab bar below the header switches between them. The tab bar is the one of the Gallery card (like GNOME Files): equal-width tabs, 44px high, radius 9px, the selected one filled `rgba(255,255,255,0.11)` and bold, a separator between two unselected tabs. Tabs are named after the app, players of the same app (two browser tabs) after their track, and stay in the order the players appeared. A picked player stays shown until it goes away or the overlay closes, then the card shows the player that played last again.
  - Players do not announce their position. It is read when the overlay opens, when the status or the track changes and on `Seeked`, and counted on between reads while playing.
  - Dragging the slider seeks once it is let go, with `SetPosition`, or with `Seek` for players without a valid track id. Streams have no length, their card has no slider. Buttons the player does not offer are greyed out.
  - Covers are a background image, which follows the rounded corners like the user avatars of the shell. `file://` covers are shown as they are, covers on the web (Spotify) are downloaded with libsoup to `~/.cache/gamebar-overlay@m0.is/covers`, keeping only the last one. The last one of an earlier session is deleted after a day.
- **Discord** (400px): the voice channel in bold with its server in secondary grey as group title, and a boxed list of its members: the avatar (32px, round), the name and the state on the right. A speaking member has a 2px ring in the accent colour around the avatar, a muted one a grey name and the crossed out microphone, a deafened one also the crossed out headphones. Below the list, centred, the 44px buttons mute, deafen and disconnect, 16px apart.
  - The data comes from the local RPC server of the Discord client, a WebSocket on `127.0.0.1:6463` (up to 6472 with several clients). Only the official client has it, Vesktop and other clients with arRPC have no voice RPC.
  - The voice commands need an OAuth token with the `rpc` scope, which Discord only grants to approved applications. The card authorises as Discord's own StreamKit Overlay (client ID `207646673902501888`), like the [Discover](https://github.com/trigg/Discover) overlay: the client accepts that ID from the origin `https://streamkit.discord.com`, and `https://streamkit.discord.com/overlay/token` exchanges the code for a token without a client secret. Discord could close this way at any time, the sanctioned one is an application of one's own, which every user would have to create in the developer portal.
  - Until the user allowed the access the card says "Not connected" with a Connect button. The prompt is in the window of Discord, so the button closes the overlay and the card stays connected for up to two minutes until it is answered. The token is kept in the GNOME Keyring (libsecret, schema `is.m0.GameBarOverlay.Discord`). It runs out after a week, Discord then gives out a new one without asking.
  - The card is only connected while the overlay is open and the card is shown. A mute set over RPC stays after disconnecting (tested with Discord 1.0.160, the documentation says voice settings are reset). The last channel and members stay on the card while disconnected, so it does not flicker when the overlay opens.
  - The list shows 5 members and a "Show more" row, which expands it to 15, followed by "+N more". A single member more is shown instead of the row that would stand for it. Opening the overlay starts with the short list again. The members are in the order Discord sends them.
  - A port that accepts the connection and does not answer is given up after 2 seconds, a client that does not greet after 5, and a keyring that does not answer after 3: the card then offers to connect, and the token lasts until the shell restarts. Messages may be 8 MiB, a stage channel with hundreds of listeners is larger than the default of 128 KiB.
  - Without a voice channel the card says "Not in a voice channel" and keeps the mute and deafen buttons, which Discord also offers outside a call. Without a running client it says "Discord is not running".
  - Avatars are a background image like the covers of the Music card, downloaded from the Discord CDN (64px, the first frame of animated ones) to `~/.cache/gamebar-overlay@m0.is/avatars` and deleted after 30 days. Until an avatar is there, and for members without one, the first letter of the name is shown. Avatars set for a single server are not part of the RPC.
- **Hardware** (400px): one boxed list with these rows:
  - **CPU** and **GPU**: the temperature as subtitle, a sparkline of the usage of the last 30 seconds in the accent colour and the usage in bold. Without libgtop the CPU row only shows the install hint. What the GPU row shows depends on the driver:
    - amdgpu: usage (`gpu_busy_percent`), temperature (hwmon) and the VRAM in use (`mem_info_vram_used`), all from sysfs.
    - Nvidia: usage, temperature and VRAM from one `nvidia-smi --loop=1` that prints a line a second, the row shows the last one. Waiting for a single run would block the shell, and starting it every second costs more than the reading. Not tested on an Nvidia GPU.
    - Intel (i915, xe) and nouveau: only the temperature where the GPU has a sensor, integrated Intel GPUs have none. Their usage is not in sysfs, the row shows "-". Not tested on these GPUs.
  - **Memory**: "used of total" in GiB, a level bar and the percentage. Used is total minus available from `/proc/meminfo`, like GNOME System Monitor.
  - **Disk**: the same for the filesystem of the home folder in GB, on image based systems the root filesystem is a small read-only image. The percentage is used of the whole size like GNOME Settings, so it is a few points lower than `df`, which leaves out the space reserved for root.
  - **Network**: download and upload rate from `/proc/net/dev`, counting only interfaces with a device behind them. Loopback, VPN and container interfaces would count the same traffic twice.
- **Settings** (400px): the settings changed while playing, the others stay in the preferences window. A boxed list with Pinned Card Opacity, a slider from 10% to 100% like the preferences with the percentage on the right, and "Reset Card Positions", a row that is a button like the button rows of Adwaita. Reset moves the cards of the monitor of the overlay back, the positions are saved per monitor, and is greyed out while no card there was dragged. Below the list the pill button "More Settings…" closes the overlay and opens the preferences window, which would open behind it. The card has a close button and no pin button, a pinned card could not be used. It is below the Hardware card and hidden until it is shown from the dash, its dash button is the `preferences-system-symbolic` of the icon theme.

## Choices

- **Card shadow** `0 2px 4px 0 rgba(0,0,0,0.2)`, the one of the shell popup menus and Quick Settings. Heavier shadows look out of place in GNOME. libadwaita windows use three centred layers (`0 0 14px 5px` 15%, `0 0 5px 2px` 10%, 1px 5%), which St cannot draw since it supports only one shadow.
- **Row separators** are the card background `#222226`, GNOME lists show the background between the rows.
- **Mute and media buttons** are 28×28 (6px padding around a 16px icon), the size of the Quick Settings slider buttons.
- **Pin button** shows an outline pin until the card is pinned, then the filled pin on a filled circle like a pressed toggle button. Icon themes have no outline pin, so pins are shipped for Adwaita and Papirus, whichever `view-pin-symbolic` comes from: Papirus-Dark and the other variants have the pin of Papirus. Adwaita's outline (`icons/gamebar-pin-outline-symbolic.svg`) is its pin inset like its outline icons, which have 2px walls: its "not starred" star is its star inset by 2px. The pin is narrower than the star, so the walls are 2px on the flat top and bottom, which stay on the pixel grid, and 1.5px on the slanted sides of its neck. Papirus' pin is slanted, it gets an upright pin and its outline in the style of Papirus instead (`icons/gamebar-pin-papirus-symbolic.svg`, `icons/gamebar-pin-outline-papirus-symbolic.svg`), drawn on a 24px grid. Other themes show their own pin, dimmed to 35% like the "not starred" star of Papirus. The Clock has no header bar, its pin button is in its top left corner while the pointer is over the card or it is pinned.
- **No overlay close button.** The overlay closes with Esc, the shortcut, the top bar indicator and a click on an empty area, which is on by default.
- **Network arrows** are the Adwaita `go-down` and `go-up` chevrons. Adwaita has no plain arrows, and its `network-receive` and `network-transmit` icons are horizontal arrow pairs.
- **Sparklines are filled when the overlay opens.** Linux keeps no usage history, so `addons/hardwareSampler.js` samples the CPU and GPU usage once a second while the extension is on, for the card in the overlay and its pinned cards together. It must not cost a game anything:
  - In the background only the usage is read: `/proc/stat` through libgtop and `gpu_busy_percent` of amdgpu, or the last line of `nvidia-smi`. A sample takes well under a millisecond (about 70 µs on a Ryzen with amdgpu) and nothing is drawn, the sparklines are only repainted while a card is shown. The temperatures, the VRAM, memory, disk and network are only read while a card is shown.
  - The timer counts in whole seconds (`timeout_add_seconds`), so its wakeups are bundled with the other ones of the shell.
  - A GPU that may power down when it is idle (`power/control` is `auto`, a laptop GPU) is not read in the background: every read wakes it or starts its idle timeout anew, it would never power down. Its sparkline starts when a card is shown, like before. nvidia-smi only runs in the background for a GPU that does not power down, and ends when the card is no longer shown otherwise.
  - Intel and nouveau GPUs have no usage, nothing is read for them in the background.
- **Device picker** opens inside the card, not as a popup menu.
- **Discord states** are shown without "Speaking" and "Muted" texts: the ring is enough for speaking, muted and deafened are icons, a deafened member has both. A deafened member and the active deafen button show the crossed out headphones of the icon theme (`audio-volume-muted-headphones`, Papirus has them). Adwaita has none, themes without them get `icons/gamebar-headphones-disabled-symbolic.svg`: Adwaita's `audio-headphones` crossed out like its `microphone-disabled`. Active mute and deafen buttons switch to the muted glyph in secondary grey, like the mute buttons of the Audio card.
- **Disconnect icon** is `call-stop` of the icon theme, so it matches the other icons. Themes without it get the receiver of Adwaita's, shipped in `icons/`. The button has the neutral fill of mute and deafen, not a destructive red: themes like Papirus colour their `call-stop` red, which hardly shows on a red button.
- **Icons shipped in `icons/`** are only fallbacks for icon themes that lack the icon (`fallback_gicon` of `St.Icon`), except the outline pins, which no icon theme has.
- **Dash icon of Discord** is the Adwaita headset, Adwaita has no Discord icon and the logo is a trademark.
- **Close cross** is the 16px `window-close-symbolic` icon of the libadwaita window controls. Adwaita's cross takes only half the icon, at 12px it would be a tiny 6px.

## Dash and closing cards

The dash (`addons/dash.js`) sits at the bottom centre, 20px from the edge: `#36363a`, radius 24px, padding 8px, a 52×52 button per card with a 22px icon and a 5px dot that shows the card is shown. Clicking a button shows or hides its card. The dash is not draggable.

Every card with a header bar has the Adwaita window control in it: a 24px circle filled `rgba(255,255,255,0.10)` with the 16px `window-close-symbolic` icon in a 44px hit area. The Clock has no header bar and is only hidden from the dash.

- Closed cards are saved for the monitor of the overlay in the `monitor-hidden-cards` setting and stay closed across sessions, like dragged positions. A card closed on one monitor is still shown on the others.
- Closing and showing a card while the overlay is open fades and scales it (200ms, from 90%).
- The enter and exit animations only move the shown cards that are not pinned.
- The Hardware card does not exist without any row, the dash then has no button for it.
- Clicks on the dash do not count as clicks on the empty area.

## Opening and closing

- The overlay is modal while it is open, like the overview (`Main.pushModal`): the keys go to the overlay, the shortcuts of the shell and the Super key do nothing, and a game loses its pointer lock until the overlay closes. The grab also keeps fullscreen windows from bypassing the compositor. Only the shortcut of the overlay is allowed in its mode.
- The overlay and its backdrop are in the UI group of the shell, above the windows and the top bar and below the dialogs of the shell. A keyring or polkit prompt appears above the overlay.
- It does not open on top of a dialog of the shell. An open overview is closed first.
- A click on the empty area only closes the overlay when it was pressed there too. The top bar button opens the overlay on the press (a click gesture that recognizes on press on GNOME 50), and the release of that click came to the overlay, which covers the top bar, for a quick click and for one held until the overlay was there.
- The overlay takes no clicks during its exit animation, a click on the top bar button below it opens the overlay again.
- Whether the overlay is open is a flag of its own, the actor stays visible until the exit animation ends. Toggling during the exit animation opens the overlay again.
- The overlay is hidden when the fade of the backdrop stops, which takes as long as the cards move. The cards cannot tell: a card recreated or shown during the animation never finishes it.
- Disabling the extension (the shell does that when the screen locks) and a change of the monitors close an open overlay and release the grab.

## Pinned cards

A pinned card stays on its monitor while the overlay is closed, over the desktop and over games, like the pinned widgets of the Xbox Game Bar. The pin button is in the header bar of every card, left of the title.

- Pinned cards are saved per monitor in `monitor-pinned-cards`. A closed card is not shown pinned.
- Every monitor with a pinned card has a layer above the windows and below the top bar, the overview, notifications and the overlay (`pinnedCards.js`). The layer and its children are never picked, the pointer goes to the window below: a game keeps its clicks and its pointer lock. To use a pinned card, open the overlay.
- The layer of the monitor of the overlay is hidden while the overlay is shown, its cards are in the overlay. The layers of the other monitors stay.
- The enter and exit animations leave the pinned cards where they are, they grow into their cards in the overlay and back (`pinTransition.js`). Both cards are drawn on one frame that resizes from one card to the other, the header bar of the card of the overlay shows as the top edge of the frame moves over it, and its content fades in over the content of the pinned card. Both are faded together from the opacity of the pinned cards. While they grow both cards are in the overlay, above the backdrop: the pinned card keeps the style of the pin layer and is not picked. Opening or closing the overlay again in the middle turns them around. The layer is hidden once they have grown, closing shows it right away.
- The pinned Discord card is no card, its card in the overlay fades in and out over it instead.
- The Hardware card in the overlay and its pinned cards show the samples of one sampler.
- A pinned card is the card built a second time for its monitor, `createPinned` of its entry in `extension.js`. It updates itself while its layer is shown, like the card of the overlay while the overlay is shown: the Hardware card reads its rows, the Discord card is connected. By default it is the card without its header bar, at the place of the card in the overlay on that monitor. It is lower by the header bar, so its content is where the content of the card in the overlay is and both end at the same bottom.
- The Discord card has its own pinned card, like the overlay of Discord on Windows: the members of the voice channel as avatars with the name on a dark tag, a green ring (`#23a55a`) around who is speaking and the muted and deafened icons in red (`#f23f43`). It shows nothing outside a voice channel. It has a connection of its own to Discord.
- Pinned Card Opacity in the preferences fades the pinned cards, 100% by default. Every pinned card is faded as a whole, in an offscreen buffer of its own (`AUTOMATIC_FOR_OPACITY`), otherwise its rows and its fill would show through each other.
- The pinned cards are hidden for a screenshot of the Capture card and while a recording runs.
- While a layer is shown, unredirect is off: a fullscreen window that bypasses the compositor would cover the pinned cards. Games are then always composited, which can cost some latency. Not tested with a fullscreen game.

## Monitors

- The overlay covers one monitor: the one of the focused window when it opens, the game, or the one of the pointer when no window has the focus. The other monitors stay as they are. The Capture card captures the monitor of the overlay.
- Every monitor has its own card positions and closed cards. A monitor is known by its connector (`DP-1`, `eDP-1`), which stays the same across sessions unlike its index. A monitor plugged into another port is a new monitor. GNOME 49 and newer list the connectors of the monitors (`Meta.MonitorManager.get_logical_monitors()`), GNOME 46 to 48 do not: there the connectors are read from `/sys/class/drm` and matched with `get_monitor_for_connector()`. That path is not tested.
- A monitor without saved positions starts in the default layout, with every card shown except Gallery, Discord and Settings.

## Layout

Every card has a place of its own in the default layout (`cardPosition.js`), it does not follow the other cards. Cards stacked in columns moved whenever a card above them was dragged away, closed or grew, now nothing but the card itself moves. On 1920×1080:

| Card | x | y | Width | Usual height |
|---|---|---|---|---|
| Audio | 32 | 84 | 440 | 485 |
| Battery | 32 | 690 | 440 | 125 |
| Capture | 504 | 84 | 520 | 110 |
| Gallery | 504 | 218 | 520 | 300 |
| Clock | 1056 | 84 | 400 | 150 |
| Music | 1056 | 275 | 400 | 200 |
| Discord | 1056 | 515 | 400 | 300 |
| Hardware | 1488 | 84 | 400 | 380 |
| Settings | 1488 | 490 | 400 | 220 |

The usual height is the height of a card in common use: Audio with four apps, Gallery full, Music playing, Hardware with every row. The places leave room for that, so a card has to grow well beyond it to reach the card below. Gallery, Discord and Settings are hidden by default, a monitor without closed cards saved has those three closed.

A monitor larger than 1920×1080 gets the layout as it is, centred across and 84px from the top. On a smaller one the space each card leaves is shrunk along the side that is too small: a card that is 32px from the left edge stays there, one that ends 32px from the right edge stays there, and the ones in between are spread out in proportion. Vertically the layout lies between 84px from the top and 110px from the bottom, above the dash. The cards keep their size, so on a small monitor like 1280×800 they overlap. The dash is always kept above the cards.

Cards can still be dragged anywhere. Dragged positions are saved for the monitor in `monitor-card-positions`, as fractions of its size. The Reset button in the Settings card moves the cards of the monitor of the overlay back to the default layout, the one in the preferences the cards of every monitor.

## Behaviour matched to GNOME Shell

Volume and mute follow the Quick Settings sliders (`js/ui/status/volume.js`), in `addons/streamVolume.js`:

- Dragging a slider to 0 mutes the stream, dragging it up unmutes it. A muted stream shows an empty slider and a grey icon and name.
- Clicking the mute button of a stream muted at volume 0 unmutes it at 25%.
- Setting the volume makes the stream notify while it still reports the old mute state. The rows ignore the stream while they set the volume themselves, otherwise the slider jumps back to 0 and that jump is taken as a drag to 0.

The Applications group follows the apps while the overlay is open (`stream-added` and `stream-removed` of the mixer).

Many apps name their stream after their audio library (Discord is "WEBRTC VoiceEngine", many games "FMOD Ex App"), and Gvc passes on nothing else. PulseAudio also knows the process of a stream, which `pactl --format=json list sink-inputs` tells. It runs as a process of its own when the apps change, the rows are shown right away and get their app once it answered. The app of a stream is, in this order:

- the app with the app id of the stream, if the app set one (for sandboxed apps the one of the portal),
- the app with a window of the process of the stream or of one of its four parents, the stream often belongs to a helper process. Not for sandboxed apps, their process id is the one inside the sandbox,
- the installed app with exactly the name of the program or of the stream (its name, desktop file or program).

The row shows the name and the icon of the app. Without an app, or without `pactl`, it shows the name of the stream and the icon name the stream set, or the symbolic `application-x-executable-symbolic`. Guessing from parts of the name gave apps the icon of another one. App icons are 24px, the name has 108px.

## Accent colour

The sliders are the shell's own `Slider` and follow the accent colour. The sparklines are drawn in the text colour of `.gamebar-sparkline`, which is `-st-accent-color` on GNOME 47 and newer and falls back to Adwaita blue `#3584e4` on GNOME 46.

## St pitfalls

- **`x_expand` propagates to the parents.** The expanding rows stretched the cards over the whole overlay, the cards set `x_expand: false` explicitly.
- **Negative margins break `St.BoxLayout`.** A `margin-left: -10px` on a leading button gave its siblings broken widths, the row has a smaller left padding instead.
- **`y_align: CENTER` on a `Slider`** gives it no height, the sliders fill the row.
- **`Clutter.cairo_set_source_color` is gone** on GNOME 50, set the colour with `cr.setSourceRGBA()` from the theme node colour.
- **`St.BoxLayout.vertical` is deprecated** since GNOME 48, which has `orientation` instead. `vertical()` in `card.js` gives the property the shell has.
- **No grid, flex gap or multiple shadows** in St CSS. Layouts are `St.BoxLayout`s with `spacing`.
- **A `box-shadow` with spread is clipped** at the edges of its actor. The ring of a speaking member is the border of a bin around the avatar.
- **Sizing an actor when another one gets its size** (in `notify::width`) asks for a new layout in the middle of the layout, and Clutter warns that the actors need an allocation. The fill of a level bar is sized by a layout manager instead.
- **Stopping `button-press-event` on a parent cancels the click of the buttons inside.** On GNOME 50 `St.Button` recognises clicks with a gesture, and a press stopped further up never completes it. Cards and the dash only stop the release, which keeps a click on them from counting as a click on the empty area.
- **`:first-child`** cannot reach the first group title of a card since every title is the first child of its group, the first title gets its own class.

## Settings removed

These settings were removed together with their rows in the preferences:

- Overlay Opening Monitor and Show App Description (were already unused).
- Padding and the Position of every addon (replaced by the default layout).
- Icon Size (app icons are 24px) and Icon Type (the fallback icon is always symbolic).
- `hidden-cards` and `addon-positions`, replaced by `monitor-hidden-cards` and `monitor-card-positions` with an entry per monitor. Cards closed or dragged before start in the default layout again.
- First key and Last key of the shortcut. The Shortcut row records any combination with Ctrl, Alt or Super instead, several of the keys in the old list had names the shell does not know. The shortcuts of the shell still work while it records, holding them back makes the shell ask for permission.

The schema defaults changed: overlay background `rgba(8,9,12,0.62)`, clock size 64, close on empty area click on.

## Testing without logging out

`tests/run.sh` runs a scenario against the extension in a headless shell with a home directory of its own:

```sh
tests/run.sh tests/overlay.test.js
```

- A scenario is JavaScript that runs at the end of `enable()` of a copy of the extension, with the helpers of `tests/prelude.js`: `click(actor)`, `drag(actor, dx, dy)` and `key(keyval)` with a virtual pointer and keyboard, `shot(name, actor)` for a screenshot in `tests/output`, `check(condition, message)`, `openOverlay()` and `sleep(ms)`.
- `tests/pins.test.js` pins cards and checks that the pointer goes through them.
- `MONITORS="1920x1080 1280x800"` starts the shell with a virtual monitor of each size, `tests/monitors.test.js` needs two.
- It prints one line per check and exits with 1 if a check failed. The log of the shell is in `tests/output/shell.log`.
- At the end the extension is disabled, what it leaves behind shows up in the log.
- The absolute motion of a virtual pointer loses the y coordinate in the headless shell, the helpers steer it with relative motion.
- The variables of the home directory are exported before `dbus-run-session`: services started by D-Bus, like the screen recorder of the shell, take their home from the D-Bus daemon and would otherwise save to the real home.
- The isolated session has no keyring and no captures. The Discord client of the real session is reachable, its token is not. A `pacat --raw /dev/zero` stream gives the Applications group a silent app to show.
