/* exported PrompterPage */
// Teleprompter workspace: scrolls a script right under the top of the screen.
// Scripts are plain .txt files in ~/.local/share/rozan/scripts; "Edit
// scripts…" opens that folder. Voice-follow mode needs speech recognition,
// which GNOME does not provide, so only Scroll mode is available.
const { St, Clutter, Gio, GLib, Pango } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

const SCRIPTS_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'rozan', 'scripts']);
const FRAME_MS = 16;
const BASE_SPEED = 28; // pixels per second at 1.0x
const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const FONT_SIZES = [18, 22, 27];

const SAMPLE = `Welcome to the Rozan prompter.

Press Start and read along. The text scrolls at a steady pace; use the minus and plus buttons to change the speed, and the AA buttons to change the text size.

Scroll with the mouse wheel over the text to jump back or forward.

Add your own scripts as plain text files in the scripts folder. Choose Edit scripts from the menu at the top left to open it.`;

var PrompterPage = class PrompterPage {
    constructor(store) {
        this._store = store;
        this._speedIndex = store.get('prompterSpeed', 2);
        this._fontIndex = store.get('prompterFont', 0);
        this.locked = false;
        this.state = 'idle'; // idle | countdown | running | paused
        this._offset = 0;
        this._ensureScripts();
        this._scripts = this._listScripts();
        this._script = this._scripts.find(s => s.name === store.get('prompterScript')) ?? this._scripts[0];

        this.actor = new St.BoxLayout({ style_class: 'ln-prompter', vertical: true, x_expand: true, y_expand: true });
        this.actor.add_child(this._buildHeader());
        this.actor.add_child(this._buildStage());
        this.actor.add_child(this._buildFooter());
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._loadScript();
        this._sync();
    }

    // ---- scripts ------------------------------------------------------

    _ensureScripts() {
        GLib.mkdir_with_parents(SCRIPTS_DIR, 0o755);
        const dir = Gio.File.new_for_path(SCRIPTS_DIR);
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let any = false;
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            if (info.get_name().endsWith('.txt'))
                any = true;
        }
        children.close(null);
        if (!any)
            GLib.file_set_contents(GLib.build_filenamev([SCRIPTS_DIR, 'Welcome.txt']), SAMPLE);
    }

    _listScripts() {
        const dir = Gio.File.new_for_path(SCRIPTS_DIR);
        const list = [];
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            const name = info.get_name();
            if (name.endsWith('.txt'))
                list.push({ name: name.slice(0, -4), path: GLib.build_filenamev([SCRIPTS_DIR, name]) });
        }
        children.close(null);
        return list.sort((a, b) => a.name.localeCompare(b.name));
    }

    _loadScript() {
        let text = '';
        try {
            const [, bytes] = GLib.file_get_contents(this._script.path);
            text = new TextDecoder().decode(bytes);
        } catch (e) {
            text = 'Cannot read this script.';
        }
        this._text.text = text.trim();
        this._scriptLabel.text = this._script?.name ?? 'No script';
        this.reset();
    }

    _openScriptMenu() {
        this._scripts = this._listScripts();
        this._menu?.destroy();
        const menu = new PopupMenu.PopupMenu(this._scriptBtn, 0.0, St.Side.TOP);
        for (const s of this._scripts) {
            const item = menu.addAction(s.name, () => {
                this._script = s;
                this._store.set('prompterScript', s.name);
                this._loadScript();
            });
            if (s === this._script || s.name === this._script?.name)
                item.setOrnament(PopupMenu.Ornament.DOT);
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Edit scripts…', () => {
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(SCRIPTS_DIR).get_uri(), global.create_app_launch_context(0, -1));
        });
        Main.uiGroup.add_actor(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (m, open) => this.emit('busy', open || this.keepOpen));
        this._menu = menu;
        menu.open();
    }

    // ---- layout -------------------------------------------------------

    _buildHeader() {
        const header = new St.BoxLayout({ style_class: 'ln-prompter-header' });
        const content = new St.BoxLayout({ style_class: 'ln-pill-content' });
        content.add_child(new St.Icon({ icon_name: 'text-x-generic-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        this._scriptLabel = new St.Label({ style_class: 'ln-script-name', y_align: Clutter.ActorAlign.CENTER });
        content.add_child(this._scriptLabel);
        content.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        this._scriptBtn = new St.Button({ style_class: 'ln-script-btn', child: content });
        this._scriptBtn.connect('clicked', () => this._openScriptMenu());

        const modes = new St.BoxLayout({ style_class: 'ln-seg' });
        const scroll = new St.Button({ style_class: 'ln-seg-btn', checked: true });
        const sc = new St.BoxLayout({ style_class: 'ln-pill-content' });
        sc.add_child(new St.Icon({ icon_name: 'view-list-bullet-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        sc.add_child(new St.Label({ text: 'Scroll', y_align: Clutter.ActorAlign.CENTER }));
        scroll.child = sc;
        const voice = new St.Button({ style_class: 'ln-seg-btn', reactive: false, opacity: 110 });
        const vc = new St.BoxLayout({ style_class: 'ln-pill-content' });
        vc.add_child(new St.Icon({ icon_name: 'audio-input-microphone-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        vc.add_child(new St.Label({ text: 'Voice', y_align: Clutter.ActorAlign.CENTER }));
        voice.child = vc;
        modes.add_child(scroll);
        modes.add_child(voice);

        this._lockBtn = new St.Button({ style_class: 'ln-lock', child: new St.Icon({ icon_size: 13 }) });
        this._lockBtn.connect('clicked', () => {
            this.locked = !this.locked;
            this._sync();
        });

        header.add_child(this._scriptBtn);
        header.add_child(new St.Widget({ x_expand: true }));
        header.add_child(modes);
        header.add_child(this._lockBtn);
        return header;
    }

    _buildStage() {
        this._stage = new St.Widget({
            style_class: 'ln-prompter-stage',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._stage.connect('scroll-event', (a, e) => this._onScroll(e));

        // the scrolling text lives in a fixed-layout viewport so its y can be animated freely
        this._viewport = new St.Widget({ x_expand: true, y_expand: true });
        this._text = new St.Label({ style_class: 'ln-prompter-text' });
        this._text.clutter_text.line_wrap = true;
        this._text.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._viewport.add_child(this._text);
        this._viewport.connect('notify::width', () => this._layoutText());
        this._viewport.connect('notify::height', () => this._layoutText());

        this._idle = new St.BoxLayout({ vertical: true, style_class: 'ln-prompter-idle', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._idle.add_child(new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 14, style_class: 'ln-idle-icon', x_align: Clutter.ActorAlign.CENTER }));
        this._idle.add_child(new St.Label({ text: 'Press Start and read along', style_class: 'ln-idle-title', x_align: Clutter.ActorAlign.CENTER }));
        this._idle.add_child(new St.Label({ text: 'A 3-second countdown gives you time to get ready.', style_class: 'ln-idle-hint', x_align: Clutter.ActorAlign.CENTER }));

        this._countdown = new St.Label({ style_class: 'ln-countdown', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false });

        // reading-line marker and progress
        const marker = new St.Label({ text: '▸', style_class: 'ln-marker', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER });
        this._progress = new St.Widget({ style_class: 'ln-prompter-progress', x_expand: true });
        this._progressFill = new St.Widget({ style_class: 'ln-prompter-progress-fill', x: 0, y: 0, width: 0 });
        this._progress.add_child(this._progressFill);

        // progress sits at the bottom of a full-size column so it does not depend on bin alignment
        const bottom = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        bottom.add_child(new St.Widget({ x_expand: true, y_expand: true }));
        bottom.add_child(this._progress);

        for (const a of [this._viewport, this._idle, this._countdown, marker, bottom])
            this._stage.add_child(a);
        return this._stage;
    }

    _buildFooter() {
        const footer = new St.BoxLayout({ style_class: 'ln-prompter-footer' });
        const restart = new St.Button({ style_class: 'ln-round ln-round-gray', child: new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 12 }) });
        restart.connect('clicked', () => this.reset());

        this._startContent = new St.BoxLayout({ style_class: 'ln-pill-content' });
        this._startIcon = new St.Icon({ icon_size: 12, y_align: Clutter.ActorAlign.CENTER });
        this._startLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        this._startContent.add_child(this._startIcon);
        this._startContent.add_child(this._startLabel);
        this._startBtn = new St.Button({ style_class: 'ln-white-pill', child: this._startContent });
        this._startBtn.connect('clicked', () => this.toggle());

        const speed = this._stepper('speedometer-symbolic', () => this._setSpeed(-1), () => this._setSpeed(1));
        this._speedLabel = speed.label;
        const font = this._stepper(null, () => this._setFont(-1), () => this._setFont(1), 'AA');
        this._fontLabel = font.label;

        footer.add_child(restart);
        footer.add_child(this._startBtn);
        footer.add_child(new St.Widget({ x_expand: true }));
        footer.add_child(speed.box);
        footer.add_child(font.box);
        return footer;
    }

    _stepper(iconName, onMinus, onPlus, prefix) {
        const box = new St.BoxLayout({ style_class: 'ln-stepper' });
        const minus = new St.Button({ style_class: 'ln-step-btn', label: '−' });
        const plus = new St.Button({ style_class: 'ln-step-btn', label: '+' });
        minus.connect('clicked', onMinus);
        plus.connect('clicked', onPlus);
        const mid = new St.BoxLayout({ style_class: 'ln-pill-content', y_align: Clutter.ActorAlign.CENTER });
        if (iconName)
            mid.add_child(new St.Icon({ icon_name: 'preferences-system-time-symbolic', icon_size: 11, style_class: 'ln-step-icon', y_align: Clutter.ActorAlign.CENTER }));
        if (prefix)
            mid.add_child(new St.Label({ text: prefix, style_class: 'ln-step-prefix', y_align: Clutter.ActorAlign.CENTER }));
        const label = new St.Label({ style_class: 'ln-step-value', y_align: Clutter.ActorAlign.CENTER });
        mid.add_child(label);
        box.add_child(minus);
        box.add_child(mid);
        box.add_child(plus);
        return { box, label };
    }

    // ---- behaviour ----------------------------------------------------

    get keepOpen() {
        return this.locked || this.state !== 'idle';
    }

    _setSpeed(d) {
        this._speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, this._speedIndex + d));
        this._store.set('prompterSpeed', this._speedIndex);
        this._sync();
    }

    _setFont(d) {
        this._fontIndex = Math.max(0, Math.min(FONT_SIZES.length - 1, this._fontIndex + d));
        this._store.set('prompterFont', this._fontIndex);
        this._sync();
        this._layoutText();
    }

    _layoutText() {
        const w = this._viewport.width;
        if (w <= 0)
            return;
        this._text.width = w - 48;
        this._text.x = 24;
        this._applyOffset();
    }

    // The text starts just below the reading line and moves up as _offset grows.
    _applyOffset() {
        const h = this._viewport.height;
        this._text.y = Math.round(h * 0.35 - 12 - this._offset);
        const max = Math.max(1, this._text.height);
        this._progressFill.width = Math.round(this._progress.width * Math.min(1, this._offset / max));
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let dy = 0;
        if (dir === Clutter.ScrollDirection.UP)
            dy = -40;
        else if (dir === Clutter.ScrollDirection.DOWN)
            dy = 40;
        else if (dir === Clutter.ScrollDirection.SMOOTH)
            dy = event.get_scroll_delta()[1] * 20;
        if (this.state === 'idle' && dy !== 0)
            this.state = 'paused';
        this._offset = Math.max(0, Math.min(this._text.height, this._offset + dy));
        this._applyOffset();
        this._sync();
        return Clutter.EVENT_STOP;
    }

    toggle() {
        if (this.state === 'running' || this.state === 'countdown')
            this.pause();
        else
            this.start();
    }

    start() {
        this._stopTimers();
        if (this._offset >= this._text.height)
            this._offset = 0;
        let n = 3;
        this.state = 'countdown';
        this._countdown.text = String(n);
        this._sync();
        this._countId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            n--;
            if (n > 0) {
                this._countdown.text = String(n);
                return GLib.SOURCE_CONTINUE;
            }
            this._countId = 0;
            this._run();
            return GLib.SOURCE_REMOVE;
        });
    }

    _run() {
        this.state = 'running';
        let last = GLib.get_monotonic_time();
        this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            const now = GLib.get_monotonic_time();
            this._offset += (now - last) / 1e6 * BASE_SPEED * SPEEDS[this._speedIndex];
            last = now;
            if (this._offset >= this._text.height) {
                this._offset = this._text.height;
                this._applyOffset();
                this._frameId = 0;
                this.state = 'paused';
                this._sync();
                return GLib.SOURCE_REMOVE;
            }
            this._applyOffset();
            return GLib.SOURCE_CONTINUE;
        });
        this._sync();
    }

    pause() {
        this._stopTimers();
        this.state = 'paused';
        this._sync();
    }

    reset() {
        this._stopTimers();
        this.state = 'idle';
        this._offset = 0;
        this._applyOffset();
        this._sync();
    }

    _stopTimers() {
        for (const key of ['_countId', '_frameId']) {
            if (this[key]) {
                GLib.source_remove(this[key]);
                this[key] = 0;
            }
        }
    }

    _sync() {
        const s = this.state;
        this._idle.visible = s === 'idle';
        this._countdown.visible = s === 'countdown';
        this._viewport.visible = s === 'running' || s === 'paused';
        const running = s === 'running' || s === 'countdown';
        this._startIcon.icon_name = running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._startLabel.text = running ? 'Pause' : s === 'paused' ? 'Resume' : 'Start';
        this._speedLabel.text = `${SPEEDS[this._speedIndex].toFixed(SPEEDS[this._speedIndex] % 1 ? 2 : 1).replace(/0$/, '')}×`;
        this._fontLabel.text = `${this._fontIndex + 1}/${FONT_SIZES.length}`;
        this._text.style = `font-size: ${FONT_SIZES[this._fontIndex]}px;`;
        this._lockBtn.child.icon_name = this.locked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic';
        if (this.locked)
            this._lockBtn.add_style_pseudo_class('checked');
        else
            this._lockBtn.remove_style_pseudo_class('checked');
        this.emit('busy', this.keepOpen);
    }

    destroy() {
        this._stopTimers();
        this._menu?.destroy();
        this.actor.destroy();
    }
};
Signals.addSignalMethods(PrompterPage.prototype);
