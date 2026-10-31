/* exported FocusTimer */
// Focus/Break countdown timer. When a period ends it plays the theme's
// "alarm-clock-elapsed" sound (if enabled), shows a notification and switches
// to the other mode, ready to start.
const { GLib } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;

const TICK_MS = 250;
const MIN_MINUTES = 1;
const MAX_MINUTES = 120;

var FocusTimer = class FocusTimer {
    constructor(store) {
        this._store = store;
        this.durations = Object.assign({ focus: 25, break: 5 }, store.get('timerDurations', {}));
        this.sound = store.get('timerSound', true);
        this.mode = 'focus';
        this.state = 'idle'; // idle | running | paused
        this.remainingMs = this.durations.focus * 60000;
        this._tickId = 0;
        this._lastSecond = null;
    }

    get minutes() {
        return this.durations[this.mode];
    }

    get display() {
        const total = Math.max(0, Math.ceil(this.remainingMs / 1000));
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    setMode(mode) {
        if (mode === this.mode)
            return;
        this._stopTicking();
        this.mode = mode;
        this.state = 'idle';
        this.remainingMs = this.minutes * 60000;
        this.emit('changed');
    }

    setMinutes(minutes) {
        minutes = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(minutes)));
        if (minutes === this.durations[this.mode])
            return;
        this.durations[this.mode] = minutes;
        this._store.set('timerDurations', this.durations);
        if (this.state === 'idle')
            this.remainingMs = minutes * 60000;
        this.emit('changed');
    }

    toggleSound() {
        this.sound = !this.sound;
        this._store.set('timerSound', this.sound);
        this.emit('changed');
    }

    toggle() {
        if (this.state === 'running')
            this.pause();
        else
            this.start();
    }

    start() {
        this._endAt = Date.now() + this.remainingMs;
        this.state = 'running';
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => this._tick());
        this.emit('changed');
    }

    pause() {
        this.remainingMs = Math.max(0, this._endAt - Date.now());
        this._stopTicking();
        this.state = 'paused';
        this.emit('changed');
    }

    reset() {
        this._stopTicking();
        this.state = 'idle';
        this.remainingMs = this.minutes * 60000;
        this.emit('changed');
    }

    _tick() {
        this.remainingMs = this._endAt - Date.now();
        if (this.remainingMs <= 0) {
            this._finish();
            return GLib.SOURCE_REMOVE;
        }
        const second = Math.ceil(this.remainingMs / 1000);
        if (second !== this._lastSecond) {
            this._lastSecond = second;
            this.emit('changed');
        }
        return GLib.SOURCE_CONTINUE;
    }

    _finish() {
        this._tickId = 0;
        const finished = this.mode;
        if (this.sound)
            global.display.get_sound_player().play_from_theme('alarm-clock-elapsed', 'Timer finished', null);
        Main.notify(finished === 'focus' ? 'Focus session done' : 'Break is over',
            finished === 'focus' ? 'Time for a break.' : 'Ready for another focus session?');
        this.mode = finished === 'focus' ? 'break' : 'focus';
        this.state = 'idle';
        this.remainingMs = this.minutes * 60000;
        this.emit('finished', finished);
        this.emit('changed');
    }

    _stopTicking() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._stopTicking();
        this.disconnectAll();
    }
};
Signals.addSignalMethods(FocusTimer.prototype);
