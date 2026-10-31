/* exported SystemMonitor */
// Samples CPU usage (from /proc/stat) and memory use (from /proc/meminfo) every
// two seconds, and battery charge every minute, keeping a short history for the charts.
const { GLib } = imports.gi;
const Signals = imports.signals;

const SAMPLE_S = 2;
const BATTERY_EVERY = 30; // samples, i.e. once a minute
const HISTORY = 40;

function readFile(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(bytes) : '';
}

var SystemMonitor = class SystemMonitor {
    constructor(battery) {
        this._battery = battery;
        this.cpu = [];
        this.memory = [];
        this.batteryHistory = [];
        this._prev = null;
        this._count = 0;
        this._sample();
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAMPLE_S, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _push(list, value) {
        list.push(value);
        if (list.length > HISTORY)
            list.shift();
    }

    _sample() {
        try {
            const fields = readFile('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
            const idle = fields[3] + (fields[4] || 0);
            const total = fields.reduce((a, b) => a + b, 0);
            if (this._prev) {
                const dt = total - this._prev.total;
                const di = idle - this._prev.idle;
                if (dt > 0)
                    this._push(this.cpu, Math.round(100 * (1 - di / dt)));
            }
            this._prev = { idle, total };

            const mem = {};
            for (const line of readFile('/proc/meminfo').split('\n')) {
                const m = line.match(/^(\w+):\s+(\d+)/);
                if (m)
                    mem[m[1]] = Number(m[2]);
            }
            if (mem.MemTotal)
                this._push(this.memory, Math.round(100 * (1 - mem.MemAvailable / mem.MemTotal)));
        } catch (e) {
            logError(e, 'linux-notch: system sample failed');
        }

        if (this._battery.present && (this._count % BATTERY_EVERY === 0 || this.batteryHistory.length === 0))
            this._push(this.batteryHistory, this._battery.percent);
        this._count++;
        this.emit('changed');
    }

    destroy() {
        GLib.source_remove(this._id);
        this.disconnectAll();
    }
};
Signals.addSignalMethods(SystemMonitor.prototype);
