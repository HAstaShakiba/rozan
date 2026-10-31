/* exported Store */
// Small JSON state file (~/.local/share/rozan/state.json) for to-dos and
// timer settings. Writes are debounced; everything stays on this machine.
const { Gio, GLib } = imports.gi;

const DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'rozan']);
const PATH = GLib.build_filenamev([DIR, 'state.json']);
const SAVE_DELAY_MS = 500;

var Store = class Store {
    constructor() {
        this.data = {};
        try {
            const [ok, bytes] = GLib.file_get_contents(PATH);
            if (ok)
                this.data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
                log(`rozan: cannot read ${PATH}: ${e.message}`);
        }
        this._saveId = 0;
    }

    get(key, fallback) {
        return key in this.data ? this.data[key] : fallback;
    }

    set(key, value) {
        this.data[key] = value;
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        try {
            GLib.mkdir_with_parents(DIR, 0o700);
            const file = Gio.File.new_for_path(PATH);
            file.replace_contents(new TextEncoder().encode(JSON.stringify(this.data, null, 1)),
                null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e, 'rozan: cannot save state');
        }
    }

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this.flush();
        }
    }
};
