/* exported DownloadsMonitor */
// Watches the Downloads folder for browser temp files (Firefox .part, Chromium
// .crdownload and similar) to show download progress. Only names and sizes are read.
const { Gio, GLib } = imports.gi;
const Signals = imports.signals;

const TEMP_RE = /\.(part|crdownload|download|partial|opdownload)$/i;
const POLL_MS = 1000;

function finalName(tempName) {
    return tempName.replace(TEMP_RE, '');
}

var DownloadsMonitor = class DownloadsMonitor {
    constructor() {
        const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ||
            GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        this._dir = Gio.File.new_for_path(path);
        this._active = new Map(); // temp basename -> { name, size }
        this._pollId = 0;

        try {
            this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (m, file, other, type) => this._onEvent(file, other, type));
        } catch (e) {
            log(`rozan: cannot watch ${path}: ${e.message}`);
            this._monitor = null;
        }
    }

    // The most recently started active download, or null.
    get current() {
        let last = null;
        for (const d of this._active.values())
            last = d;
        return last;
    }

    _onEvent(file, other, type) {
        const name = file.get_basename();
        const E = Gio.FileMonitorEvent;
        switch (type) {
        case E.CREATED:
        case E.MOVED_IN:
            if (TEMP_RE.test(name))
                this._start(name);
            break;
        case E.DELETED:
        case E.MOVED_OUT:
            if (this._active.has(name))
                this._finish(name, finalName(name));
            break;
        case E.RENAMED: {
            const newName = other?.get_basename();
            if (!this._active.has(name)) {
                if (newName && TEMP_RE.test(newName))
                    this._start(newName);
                break;
            }
            if (newName && TEMP_RE.test(newName)) {
                // e.g. Chromium "Unconfirmed 123.crdownload" -> "file.zip.crdownload"
                const entry = this._active.get(name);
                this._active.delete(name);
                entry.name = finalName(newName);
                this._active.set(newName, entry);
                this.emit('changed');
            } else {
                this._finish(name, newName ?? finalName(name));
            }
            break;
        }
        }
    }

    _start(tempName) {
        if (this._active.has(tempName))
            return;
        this._active.set(tempName, { name: finalName(tempName), size: 0 });
        this._ensurePolling();
        this.emit('changed');
    }

    _finish(tempName, name) {
        this._active.delete(tempName);
        // Wait a moment: browsers delete the temp file and create the final one in two steps.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            const done = this._dir.get_child(name).query_exists(null);
            this.emit('changed');
            if (done)
                this.emit('finished', name);
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensurePolling() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (this._active.size === 0) {
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            for (const [tempName, entry] of this._active) {
                try {
                    const info = this._dir.get_child(tempName).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                    entry.size = info.get_size();
                } catch (e) {
                    // The file can vanish between the event and the poll.
                }
            }
            this.emit('changed');
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._pollId)
            GLib.source_remove(this._pollId);
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        this._active.clear();
        this.disconnectAll();
    }
};
Signals.addSignalMethods(DownloadsMonitor.prototype);
