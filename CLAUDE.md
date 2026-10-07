# GameBar Overlay

A GNOME Shell extension (GNOME 46 to 50) that shows an Xbox Game Bar like overlay of cards. Plain ES modules, no build step.
A fork of Dekotale's GameBar-Overlay, keep the credits in the README.

## Layout

- `extension.js`: the overlay, its enter and exit animations and the list of cards.
- `card.js`: the Adwaita style building blocks of the cards. `cardPosition.js`: the default layout, dragged positions, closed and pinned cards, all per monitor.
- `addons/`: one card per file. A card built with a `pinKey` is its pinned copy, without a header bar (`pinnedCards.js`, `pinTransition.js`).
- `prefs.js`: the preferences window, GTK4 and libadwaita in a process of its own, it cannot share widgets with the shell.

## Testing

`npm install` once, then `npm run check` type-checks the JavaScript with the `@girs` types of GNOME 50 (`tsconfig.json`, `types/`). It must pass with no errors. Code for older GNOME versions gets a `@ts-expect-error` that says which version, gaps in the types are filled in `types/`.

`tests/run.sh tests/<name>.test.js` runs a scenario in a headless gnome-shell with a home of its own, `MONITORS="1920x1080 1280x800"` for several monitors. Screenshots go to `tests/output/`. The shell uses the default icon theme of the system.

## Conventions

- `DESIGN.md` records how the overlay looks and behaves, and why. Update it with every change of behaviour, the README feature list too.
- After changing the schema run `glib-compile-schemas schemas/`, `gschemas.compiled` is committed.
- Comments say why, in plain sentences. Commits: a short imperative subject and a body in prose that says what changes for the user.
