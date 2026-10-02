# GameBar Overlay

A fullscreen overlay widget for GNOME that displays useful information, audio controls and more.

> [!CAUTION]
> This is an AI-assisted fork of [dekotale/GameBar-Overlay](https://github.com/dekotale/GameBar-Overlay). Large parts of it were written with the help of an AI coding assistant. Use it at your own risk.

> [!WARNING]
> This extension supports GNOME 46 to 50, although it is possible to install it on other GNOME versions, please note that you do so at your own risk.

## Features

- Fullscreen overlay for quick access to essential information, styled after GNOME Adwaita
- Audio controls: output and input device switching, volume and mute for the devices and every app
- CPU/GPU usage and temperature monitor, memory, disk and network
- Instant screenshot and screen recording of the monitor, saved and shown like GNOME's own
- Battery of the computer and of connected devices like mice, headsets and controllers
- A dash to show and hide the cards
- Cards can be dragged anywhere on the overlay
- Fly In, Fade and Slide animations

See [DESIGN.md](DESIGN.md) for the design and the decisions behind it.

## Installation

Just clone the repo into `~/.local/share/gnome-shell/extensions/gamebar-overlay@m0.is` and enable the extension via GNOME Extensions app or similar.

## Dependencies
Installing these packages is optional, but they will provide additional functionality to this extension.  

- `libgtop` - required for the System Monitor addon.
   - On Ubuntu and derivatives, you also need the package `gir1.2-gtop-2.0` (see [issue #29](https://github.com/dekotale/GameBar-Overlay/issues/29)).
- `hwdata` - needed to read your GPU name.

## Usage

Open the Overlay by clicking the top-bar button or by pressing `Super + G`. Close it the same way, with `Esc` or by clicking on an empty area.

## Functionalities and addons

- [x] Show actual time
- [x] Volume control
- [x] Make configuration of the extension
- [x] CPU usage and temperature addon
- [x] GPU usage and temperature addon
- [x] Screenshot addon
- [ ] Weather addon
- [x] Battery addon
- [ ] Brightness addon

## Known issues

- When change the primary monitor to a diferent resolution monitor, the overlay size do not update properly until GNOME reboots.
- Minor visual glitches may occur during the exit animation if the empty area is clicked repeatedly and rapidly while "Exit on Empty Area Click" is enabled. This is due to overlapping animation triggers.

## Contributing

Contributions are welcome! Here's how you can help:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Translations

1. Copy `po/gamebar-overlay@m0.is.pot` into the new `.po` translation file. Example: `en.po`
2. Use a po editor software or text editor to translate all the strings into the new language.
3. Compile the Translation (MO file):  You need to compile your `.po` file into a binary `.mo` file.  You *can* do this using the `gnome-extensions` tool, but it's **much easier** with a PO editor, which usually has a "Compile to MO" option.  If you *must* use the command line, do the following:
    * Run: `gnome-extensions pack --podir=po gamebar-overlay@m0.is`
    * This creates a `.zip` file.  Extract the `locale` folder from the `.zip`.
    * Merge the extracted `locale` folder with the `locale` folder in your *local copy* of the extension's repository.  Ensure the new language directory (e.g., `locale/es/LC_MESSAGES/`) and the `.mo` file (e.g., `locale/es/LC_MESSAGES/gamebar-overlay@m0.is.mo`) are in the correct place.  *Make sure the directory structure is correct.*
4. Create a branch called: `translation_{language}`, add the files and do the commits.
5. Submit the pull request and await approval.


## Credits

GameBar Overlay was originally created by [Dekotale](https://github.com/dekotale), with contributions from [awumii](https://github.com/awumii) and [Shipment22](https://github.com/Shipment22). This fork is maintained by [moisout](https://github.com/moisout).

This fork is not affiliated with or endorsed by the original author. Please report problems with it in [this repository](https://github.com/moisout/GameBar-Overlay/issues), not in the original one.

## License

This project is licensed under the [MIT License](LICENSE).
