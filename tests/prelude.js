        // Helpers for the scenarios of tests/run.sh, pasted into enable() in front of the scenario.
        const gamebar = this._gamebar;
        const settings = this._settings;
        const log = message => console.warn(`TEST: ${message}`);
        const sleep = ms => new Promise(resolve => imports.gi.GLib.timeout_add(0, ms, () => {
            resolve();
            return false;
        }));
        const check = (condition, message) => log(`${condition ? 'ok' : 'FAIL'} ${message}`);

        const seat = Clutter.get_default_backend().get_default_seat();
        const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const now = () => imports.gi.GLib.get_monotonic_time();

        // Absolute motion loses the y coordinate in the headless shell, so the pointer is steered with relative motion.
        const moveTo = async (x, y) => {
            for (let i = 0; i < 20; i++) {
                const [pointerX, pointerY] = global.get_pointer();
                if (Math.abs(pointerX - x) < 1 && Math.abs(pointerY - y) < 1) return;
                pointer.notify_relative_motion(now(), x - pointerX, y - pointerY);
                await sleep(30);
            }
            log(`FAIL the pointer did not reach ${x},${y}`);
        };

        // The centre of an actor on the stage, or the [x, y] given.
        const centre = target => {
            if (Array.isArray(target)) return target;
            const [x, y] = target.get_transformed_position();
            const [width, height] = target.get_transformed_size();
            return [Math.round(x + width / 2), Math.round(y + height / 2)];
        };

        const click = async (target, button = Clutter.BUTTON_PRIMARY) => {
            await moveTo(...centre(target));
            pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
            await sleep(50);
            pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
            await sleep(150);
        };

        // Presses on the target, moves by dx and dy in steps and lets go.
        const drag = async (target, dx, dy) => {
            const [x, y] = centre(target);
            await moveTo(x, y);
            pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await sleep(50);
            for (let step = 1; step <= 5; step++) {
                await moveTo(x + dx * step / 5, y + dy * step / 5);
            }
            pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await sleep(150);
        };

        // Scrolls with the pointer over the target, a positive number of notches scrolls down.
        const scroll = async (target, notches) => {
            await moveTo(...centre(target));
            for (let i = 0; i < Math.abs(notches); i++) {
                pointer.notify_discrete_scroll(now(), notches > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP,
                    Clutter.ScrollSource.WHEEL);
                await sleep(50);
            }
            await sleep(300);
        };

        // Keys held together by their symbols, like Clutter.KEY_Control_L, Clutter.KEY_k.
        const chord = async (...keyvals) => {
            for (const keyval of keyvals) {
                keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
                await sleep(50);
            }
            for (const keyval of keyvals.reverse()) {
                keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
                await sleep(50);
            }
            await sleep(150);
        };

        // A key by its symbol, like Clutter.KEY_Escape.
        const key = async keyval => {
            keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
            await sleep(50);
            keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
            await sleep(150);
        };

        // Screenshot of the stage, or of an actor with a margin around it, to tests/output/<name>.png.
        const shot = (name, actor = null, margin = 20) => new Promise(resolve => {
            const stream = Gio.File.new_for_path(`@OUTPUT@/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
            const finish = (screenshot, result, method) => {
                try {
                    screenshot[method](result);
                } catch (e) {
                    log(`FAIL screenshot ${name}: ${e.message}`);
                }
                stream.close(null);
                resolve();
            };
            const screenshot = new Shell.Screenshot();
            if (actor) {
                const [x, y] = actor.get_transformed_position();
                const [width, height] = actor.get_transformed_size();
                screenshot.screenshot_area(Math.max(0, x - margin), Math.max(0, y - margin), width + 2 * margin, height + 2 * margin,
                    stream, (source, result) => finish(source, result, 'screenshot_area_finish'));
            } else {
                screenshot.screenshot(false, stream, (source, result) => finish(source, result, 'screenshot_finish'));
            }
        });

        // Opens the overlay and waits for the enter animation.
        const openOverlay = async () => {
            gamebar._openOverlay();
            await sleep(settings.get_int('enter-animation-duration') + 300);
        };
        const closed = async () => {
            await sleep(settings.get_int('exit-animation-duration') + 300);
        };

        const runScenario = async scenario => {
            // The shell starts in the overview, which has a grab, and may show dialogs.
            await sleep(3000);
            Main.overview.hide();
            Main.layoutManager.modalDialogGroup.get_children().forEach(dialog => dialog.close());
            await sleep(1000);
            try {
                await scenario();
            } catch (e) {
                log(`FAIL ${e.message}\n${e.stack}`);
            }
            // Disabled like when the screen locks, what the extension leaves behind shows up in the log.
            this.disable();
            await sleep(500);
            log('DONE');
            global.context.terminate();
        };
