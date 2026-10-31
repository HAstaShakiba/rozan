/* exported NookPage */
// The "Nook" home workspace, laid out like NotchNook's: a mini music player,
// CPU and battery (or memory) tiles with history charts, the Focus/Break timer
// with its minute ruler, and a to-do list.
const { St, Clutter, GLib, Pango } = imports.gi;
const Cairo = imports.cairo;
const Signals = imports.signals;
const Main = imports.ui.main;

const ORANGE = [1, 0.62, 0.04];
const GREEN = [0.45, 0.85, 0.55];
const YELLOW = [1, 0.8, 0.35];
const BLUE = [0.39, 0.82, 1];

const RULER_SPACING = 11;   // pixels per minute
const RULER_HALF_SPAN = 10; // minutes visible on each side of the value

function ellipsize(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

function separator() {
    return new St.Widget({ style_class: 'ln-nook-sep', y_expand: true });
}

// History chart: a line with a fading fill below it. Values are 0..100.
function drawChart(area, values, [r, g, b]) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (values.length > 0) {
        const pts = values.length === 1 ? [values[0], values[0]] : values;
        const step = w / (pts.length - 1);
        const y = v => h - 2 - (Math.max(0, Math.min(100, v)) / 100) * (h - 4);
        const tracePath = () => {
            cr.moveTo(0, y(pts[0]));
            pts.forEach((v, i) => cr.lineTo(i * step, y(v)));
        };

        tracePath();
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, 0, 0, h);
        fill.addColorStopRGBA(0, r, g, b, 0.35);
        fill.addColorStopRGBA(1, r, g, b, 0.02);
        cr.setSource(fill);
        cr.fill();

        tracePath();
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(1.6);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();
    }
    cr.$dispose();
}

class Tile {
    constructor(iconName, color) {
        this._color = color;
        this._values = [];
        this.actor = new St.BoxLayout({ style_class: 'ln-tile', vertical: true });
        const head = new St.BoxLayout({ style_class: 'ln-tile-head' });
        this._icon = new St.Icon({ icon_name: iconName, icon_size: 13, style_class: 'ln-tile-icon', y_align: Clutter.ActorAlign.CENTER });
        this._value = new St.Label({
            style_class: 'ln-tile-value',
            style: `color: rgb(${color.map(c => Math.round(c * 255)).join(',')});`,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        head.add_child(this._icon);
        head.add_child(this._value);
        this._chart = new St.DrawingArea({ style_class: 'ln-tile-chart', x_expand: true, y_expand: true });
        this._chart.connect('repaint', area => drawChart(area, this._values, this._color));
        this.actor.add_child(head);
        this.actor.add_child(new St.Widget({ style_class: 'ln-tile-rule' }));
        this.actor.add_child(this._chart);
    }

    update(iconName, values) {
        this._icon.icon_name = iconName;
        this._values = values;
        this._value.text = values.length ? `${values[values.length - 1]}%` : '–';
        this._chart.queue_repaint();
    }
}

// Horizontal minute ruler centered on the current value; scroll or drag to change it.
class Ruler {
    constructor(timer) {
        this._timer = timer;
        this.actor = new St.DrawingArea({ style_class: 'ln-ruler', reactive: true, x_expand: true });
        this.actor.connect('repaint', area => this._draw(area));
        this.actor.connect('scroll-event', (a, e) => this._onScroll(e));
        this.actor.connect('button-press-event', (a, e) => this._onPress(e));
        this._acc = 0;
    }

    refresh() {
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const value = this._timer.minutes;
        const cx = w / 2;
        const tickTop = 18, tickBottom = h - 9;

        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(10);
        for (let m = value - RULER_HALF_SPAN; m <= value + RULER_HALF_SPAN; m++) {
            if (m < 0)
                continue;
            const x = Math.round(cx + (m - value) * RULER_SPACING) + 0.5;
            // fade towards the edges
            const fade = 1 - Math.abs(m - value) / (RULER_HALF_SPAN + 1);
            if (m === value) {
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.setLineWidth(2.5);
                cr.moveTo(x, tickTop - 2);
                cr.lineTo(x, tickBottom);
            } else if (m < value) {
                cr.setSourceRGBA(...ORANGE, 0.35 + 0.6 * fade);
                cr.setLineWidth(1.6);
                cr.moveTo(x, tickTop + 3);
                cr.lineTo(x, tickBottom - 2);
            } else {
                cr.setSourceRGBA(1, 1, 1, 0.12 + 0.2 * fade);
                cr.setLineWidth(1.6);
                cr.moveTo(x, tickTop + 3);
                cr.lineTo(x, tickBottom - 2);
            }
            cr.stroke();

            if (m % 5 === 0) {
                const text = String(m);
                const ext = cr.textExtents(text);
                cr.setSourceRGBA(1, 1, 1, m === value ? 1 : 0.25 + 0.3 * fade);
                cr.moveTo(x - ext.width / 2 - ext.xBearing, 11);
                cr.showText(text);
            }
        }
        // marker under the current value
        cr.setSourceRGBA(...ORANGE, 1);
        cr.moveTo(cx - 5, h);
        cr.lineTo(cx + 5, h);
        cr.lineTo(cx, h - 6);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }

    _onScroll(event) {
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            this._acc += Math.abs(dx) > Math.abs(dy) ? dx : dy;
            delta = Math.trunc(this._acc);
            this._acc -= delta;
            break;
        }
        }
        if (delta)
            this._timer.setMinutes(this._timer.minutes + delta);
        return Clutter.EVENT_STOP;
    }

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [startX] = event.get_coords();
        const startValue = this._timer.minutes;
        this._captureId = global.stage.connect('captured-event', (stage, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                const [x] = ev.get_coords();
                // dragging left reveals larger values, like moving a physical tape
                this._timer.setMinutes(startValue - Math.round((x - startX) / RULER_SPACING));
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                global.stage.disconnect(this._captureId);
                this._captureId = 0;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._captureId)
            global.stage.disconnect(this._captureId);
    }
}

var NookPage = class NookPage {
    constructor({ timer, store, sysmon, battery, onPlayPause, onNext, onPrevious }) {
        this._timer = timer;
        this._store = store;
        this._sysmon = sysmon;
        this._battery = battery;
        this._todos = store.get('todos', []);
        this._grab = null;

        this.actor = new St.BoxLayout({ style_class: 'ln-nook', x_expand: true, y_expand: true });
        this.actor.add_child(this._buildMusic(onPlayPause, onNext, onPrevious));
        this.actor.add_child(separator());
        this.actor.add_child(this._buildTiles());
        this.actor.add_child(separator());
        this.actor.add_child(this._buildTimer());
        this.actor.add_child(separator());
        this.actor.add_child(this._buildTodos());

        this._timerId = timer.connect('changed', () => this._syncTimer());
        this._sysmonId = sysmon.connect('changed', () => {
            if (this.actor.mapped)
                this._syncTiles();
        });
        this.actor.connect('notify::mapped', () => {
            if (this.actor.mapped)
                this._syncTiles();
        });
        this._syncTimer();
        this._syncTiles();
        this._renderTodos();
    }

    // ---- music --------------------------------------------------------

    _buildMusic(onPlayPause, onNext, onPrevious) {
        const box = new St.BoxLayout({ style_class: 'ln-nook-music', y_align: Clutter.ActorAlign.CENTER });
        const holder = new St.Widget({ width: 100, height: 100 });
        this._art = new St.Bin({ style_class: 'ln-nook-art', x: 0, y: 0 });
        this._artIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 32 });
        this._art.child = this._artIcon;
        this._badge = new St.Icon({ style_class: 'ln-badge', icon_size: 28, x: 70, y: 70, visible: false });
        holder.add_child(this._art);
        holder.add_child(this._badge);

        const info = new St.BoxLayout({ vertical: true, style_class: 'ln-nook-info', y_align: Clutter.ActorAlign.CENTER });
        this._title = ellipsize(new St.Label({ style_class: 'ln-nook-title', text: 'Nothing playing' }));
        this._album = ellipsize(new St.Label({ style_class: 'ln-nook-album' }));
        this._artist = ellipsize(new St.Label({ style_class: 'ln-nook-artist' }));
        const controls = new St.BoxLayout({ style_class: 'ln-nook-controls' });
        const mk = (icon, cb) => {
            const b = new St.Button({ style_class: 'ln-nook-btn', child: new St.Icon({ icon_name: icon, icon_size: 16 }) });
            b.connect('clicked', cb);
            controls.add_child(b);
            return b;
        };
        mk('media-seek-backward-symbolic', onPrevious);
        this._play = mk('media-playback-start-symbolic', onPlayPause);
        mk('media-seek-forward-symbolic', onNext);
        for (const w of [this._title, this._album, this._artist, controls])
            info.add_child(w);

        box.add_child(holder);
        box.add_child(info);
        return box;
    }

    setPlayer(player, appIcon) {
        this._title.text = player ? player.title : 'Nothing playing';
        this._album.text = player ? player.metadata['xesam:album'] ?? '' : '';
        this._album.visible = this._album.text !== '';
        this._artist.text = player ? player.artist || player.sourceName : '';
        this._play.child.icon_name = player?.isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._badge.gicon = appIcon;
        this._badge.visible = Boolean(player && appIcon);
    }

    setArt(uri) {
        this._art.style = uri ? `background-image: url("${uri}");` : null;
        this._art.child = uri ? null : this._artIcon;
    }

    // ---- tiles --------------------------------------------------------

    _buildTiles() {
        const box = new St.BoxLayout({ style_class: 'ln-tiles', y_align: Clutter.ActorAlign.CENTER });
        this._cpuTile = new Tile('computer-symbolic', GREEN);
        this._secondTile = new Tile('battery-full-symbolic', YELLOW);
        box.add_child(this._cpuTile.actor);
        box.add_child(this._secondTile.actor);
        return box;
    }

    _syncTiles() {
        this._cpuTile.update('computer-symbolic', this._sysmon.cpu);
        if (this._battery.present) {
            this._secondTile._color = YELLOW;
            this._secondTile._value.style = 'color: rgb(255,204,89);';
            this._secondTile.update(this._battery.iconName, this._sysmon.batteryHistory);
        } else {
            this._secondTile._color = BLUE;
            this._secondTile._value.style = 'color: rgb(100,210,255);';
            this._secondTile.update('drive-harddisk-solidstate-symbolic', this._sysmon.memory);
        }
    }

    // ---- timer --------------------------------------------------------

    _buildTimer() {
        const box = new St.BoxLayout({ style_class: 'ln-timer', vertical: true, y_align: Clutter.ActorAlign.CENTER });

        const modes = new St.BoxLayout({ style_class: 'ln-timer-modes', x_align: Clutter.ActorAlign.CENTER });
        this._focusBtn = new St.Button({ style_class: 'ln-mode', label: 'Focus' });
        this._breakBtn = new St.Button({ style_class: 'ln-mode', label: 'Break' });
        this._focusBtn.connect('clicked', () => this._timer.setMode('focus'));
        this._breakBtn.connect('clicked', () => this._timer.setMode('break'));
        modes.add_child(this._focusBtn);
        modes.add_child(this._breakBtn);

        this._ruler = new Ruler(this._timer);

        const row = new St.BoxLayout({ style_class: 'ln-timer-row' });
        this._startBtn = new St.Button({ style_class: 'ln-start', label: 'Start Timer' });
        this._startBtn.connect('clicked', () => this._timer.toggle());
        this._soundBtn = new St.Button({ style_class: 'ln-round', child: new St.Icon({ icon_size: 14 }) });
        this._soundBtn.connect('clicked', () => this._timer.toggleSound());
        const resetBtn = new St.Button({ style_class: 'ln-round ln-round-gray', child: new St.Icon({ icon_name: 'alarm-symbolic', icon_size: 14 }) });
        resetBtn.connect('clicked', () => this._timer.reset());
        this._time = new St.Label({ style_class: 'ln-time', y_align: Clutter.ActorAlign.CENTER });
        for (const w of [this._startBtn, this._soundBtn, resetBtn, this._time])
            row.add_child(w);

        box.add_child(modes);
        box.add_child(this._ruler.actor);
        box.add_child(row);
        return box;
    }

    _syncTimer() {
        const t = this._timer;
        this._focusBtn.checked = t.mode === 'focus';
        this._breakBtn.checked = t.mode === 'break';
        this._startBtn.label = t.state === 'running' ? 'Pause' : t.state === 'paused' ? 'Resume' : 'Start Timer';
        this._soundBtn.child.icon_name = t.sound ? 'audio-volume-high-symbolic' : 'audio-volume-muted-symbolic';
        this._time.text = t.display;
        this._ruler.refresh();
    }

    // ---- to-dos -------------------------------------------------------

    _buildTodos() {
        const box = new St.BoxLayout({ style_class: 'ln-todos', vertical: true, x_expand: true });
        const head = new St.BoxLayout({ style_class: 'ln-todos-head' });
        head.add_child(new St.Label({ text: 'To-dos', style_class: 'ln-todos-title', x_expand: true }));
        this._todoCount = new St.Label({ style_class: 'ln-todos-count' });
        head.add_child(this._todoCount);

        this._todoList = new St.BoxLayout({ vertical: true, style_class: 'ln-todo-list' });
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scroll.add_actor(this._todoList);

        this._addBtn = new St.Button({ style_class: 'ln-add', x_align: Clutter.ActorAlign.START });
        const addContent = new St.BoxLayout({ style_class: 'ln-add-content' });
        addContent.add_child(new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        addContent.add_child(new St.Label({ text: 'Add a task', y_align: Clutter.ActorAlign.CENTER }));
        this._addBtn.child = addContent;
        this._addBtn.connect('clicked', () => this._beginAdd());

        this._entry = new St.Entry({ style_class: 'ln-add-entry', hint_text: 'New task', can_focus: true, visible: false, x_expand: true });
        this._entry.clutter_text.connect('activate', () => this._endAdd(true));
        this._entry.clutter_text.connect('key-press-event', (a, e) => {
            if (e.get_key_symbol() === Clutter.KEY_Escape) {
                this._endAdd(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        box.add_child(head);
        box.add_child(scroll);
        box.add_child(this._addBtn);
        box.add_child(this._entry);
        return box;
    }

    _renderTodos() {
        this._todoList.destroy_all_children();
        for (const todo of this._todos) {
            const row = new St.Button({ style_class: 'ln-todo', x_expand: true, button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE });
            const content = new St.BoxLayout({ style_class: 'ln-todo-content', x_expand: true });
            const check = new St.Bin({ style_class: 'ln-check', y_align: Clutter.ActorAlign.CENTER });
            if (todo.done) {
                check.add_style_class_name('done');
                check.child = new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 10 });
            }
            const label = ellipsize(new St.Label({ text: todo.text, style_class: 'ln-todo-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
            if (todo.done) {
                label.add_style_class_name('done');
                label.clutter_text.set_markup(`<s>${GLib.markup_escape_text(todo.text, -1)}</s>`);
            }
            content.add_child(check);
            content.add_child(label);
            row.child = content;
            // left click toggles, right click deletes
            row.connect('clicked', (b, button) => {
                if (button === 3)
                    this._todos = this._todos.filter(t => t !== todo);
                else
                    todo.done = !todo.done;
                this._saveTodos();
            });
            this._todoList.add_child(row);
        }
        this._todoCount.text = String(this._todos.filter(t => !t.done).length);
    }

    _saveTodos() {
        this._store.set('todos', this._todos);
        this._renderTodos();
    }

    // Typing needs a keyboard grab: chrome actors do not get key events otherwise.
    _beginAdd() {
        if (this._grab)
            return;
        this._addBtn.visible = false;
        this._entry.visible = true;
        this._entry.text = '';
        this._grab = Main.pushModal(this.actor);
        global.stage.set_key_focus(this._entry.clutter_text);
        // A click outside the entry finishes editing.
        this._outsideId = global.stage.connect('captured-event', (stage, ev) => {
            if (ev.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const source = ev.get_source();
            if (source && this._entry.contains(source))
                return Clutter.EVENT_PROPAGATE;
            this._endAdd(true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.emit('editing', true);
    }

    _endAdd(commit) {
        if (!this._grab)
            return;
        const text = this._entry.text.trim();
        global.stage.disconnect(this._outsideId);
        this._outsideId = 0;
        Main.popModal(this._grab);
        this._grab = null;
        this._entry.visible = false;
        this._addBtn.visible = true;
        if (commit && text) {
            this._todos.push({ text, done: false });
            this._saveTodos();
        }
        this.emit('editing', false);
    }

    destroy() {
        this._endAdd(false);
        this._ruler.destroy();
        this._timer.disconnect(this._timerId);
        this._sysmon.disconnect(this._sysmonId);
        this.actor.destroy();
    }
};
Signals.addSignalMethods(NookPage.prototype);
