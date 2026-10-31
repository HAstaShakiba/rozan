/* exported Notch */
// The notch: a black shape hanging from the top center of the primary monitor,
// styled after NotchNook's "Classic" look (concave "ears" where it meets the top
// bar, rounded bottom corners, a floating tab pill underneath when open).
//
// Collapsed, it shows one "live activity" at a time, in this priority order:
//   1. transient: volume/brightness HUD, battery plug/unplug or low, finished download
//   1b. Focus/Break timer while running or paused
//   2. meeting starting within 10 minutes (or started under 5 minutes ago)
//   3. download in progress
//   4. music playing (album art + equalizer)
//   5. idle (clock)
//
// Hover, click or scroll down opens it. Each workspace (Nook, Music, Calendar) has its
// own size; switching tabs animates between them.
const { St, Clutter, GLib, Gio, GObject, Graphene, Pango, Shell } = imports.gi;
const Cairo = imports.cairo;
const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { MprisManager } = Me.imports.mpris;
const { loadArt } = Me.imports.art;
const { CalendarFeed, CalendarPage } = Me.imports.calendar;
const { BatteryMonitor } = Me.imports.battery;
const { DownloadsMonitor } = Me.imports.downloads;
const { Store } = Me.imports.store;
const { FocusTimer } = Me.imports.timer;
const { SystemMonitor } = Me.imports.sysmon;
const { NookPage } = Me.imports.nook;
const { TrayPage } = Me.imports.tray;
const { PrompterPage } = Me.imports.prompter;
const { AgentsFeed, AgentsPage } = Me.imports.agents;

const EAR = 10; // radius of the concave corners joining the top bar
const COLLAPSED_WIDTH = { idle: 100, music: 140, activity: 190, hud: 150 };
// Body sizes of each workspace, excluding the top bar height (added at runtime).
const PAGE_SIZE = {
    nook: [1080, 150],
    music: [500, 158],
    calendar: [700, 262],
    tray: [560, 124],
    prompter: [660, 236],
    agents: [620, 172],
};
// Liquid Glass: translucent tint over a blurred copy of what is behind the notch.
const GLASS_TINT = [0.06, 0.06, 0.09, 0.42];
const CORNER = { collapsed: 12, expanded: 30 }; // must match border-radius in the stylesheet
const TAB_GAP = 10;
const LEVEL_WIDTH = 60;

const HOVER_OPEN_MS = 120;   // brief delay so passing the pointer across the top does not open it
const OUTSIDE_POLL_MS = 40; // pointer-button poll that catches clicks on app windows
const SCROLL_THRESHOLD = 1.5; // accumulated smooth-scroll units before a gesture fires
const SCROLL_COOLDOWN_MS = 450;
const POSITION_POLL_MS = 1000;
const EQ_FRAME_MS = 180;
const HUD_MS = 1500;
const EVENT_MS = 3000;
const ACTIVITY_REFRESH_S = 15;

function formatBytes(n) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function ellipsize(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

// A concave corner piece: a square with a quarter circle cut out of its outer bottom corner.
function makeEar(side, colorFn) {
    const ear = new St.DrawingArea({ width: EAR, height: EAR });
    ear.connect('repaint', area => {
        const cr = area.get_context();
        cr.setSourceRGBA(...colorFn());
        if (side === 'left') {
            cr.moveTo(0, 0);
            cr.lineTo(EAR, 0);
            cr.lineTo(EAR, EAR);
            cr.arcNegative(0, EAR, EAR, 0, -Math.PI / 2);
        } else {
            cr.moveTo(EAR, 0);
            cr.lineTo(0, 0);
            cr.lineTo(0, EAR);
            cr.arc(EAR, EAR, EAR, Math.PI, 1.5 * Math.PI);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    });
    return ear;
}

// Liquid Glass backdrop. Shell.BlurEffect only blurs rectangles, and blurring several small
// strips to fake the rounded bottom corners leaves dark seams (each strip is blurred on its own,
// so its edges darken). Instead one rectangle is blurred and its painting is clipped to the
// rounded shape with a one-pixel-row region clip. Cogl region clips are in window coordinates,
// so the local rows are mapped through the framebuffer's modelview, projection and viewport.
const RoundedBlur = GObject.registerClass(
class RoundedBlur extends St.Widget {
    _init(params) {
        super._init(params);
        this._radius = 0;
        this._blur = new St.Widget();
        this._blur.add_effect(new Shell.BlurEffect({ mode: Shell.BlurMode.BACKGROUND, brightness: 0.75, sigma: 24 }));
        this.add_child(this._blur);
    }

    setShape(width, height, radius) {
        this._radius = Math.max(0, Math.min(radius, height, width / 2));
        this._blur.set_position(0, 0);
        this._blur.set_size(width, height);
        this.queue_redraw();
    }

    vfunc_paint(paintContext) {
        const fb = paintContext.get_framebuffer();
        const region = this._radius > 0 ? this._clipRegion(fb) : null;
        if (region)
            fb.push_region_clip(region);
        super.vfunc_paint(paintContext);
        if (region)
            fb.pop_clip();
    }

    _clipRegion(fb) {
        const mv = fb.get_modelview_matrix();
        const proj = fb.get_projection_matrix();
        const vx = fb.get_viewport_x(), vy = fb.get_viewport_y();
        const vw = fb.get_viewport_width(), vh = fb.get_viewport_height();
        const toWindow = (x, y) => {
            const v = new Graphene.Vec4();
            v.init(x, y, 0, 1);
            const c = proj.transform_vec4(mv.transform_vec4(v));
            const w = c.get_w();
            return [
                Math.round(vx + (c.get_x() / w + 1) / 2 * vw),
                Math.round(vy + (1 - c.get_y() / w) / 2 * vh),
            ];
        };
        const region = new Cairo.Region();
        const add = (x, y, width, height) => {
            const [x0, y0] = toWindow(x, y);
            const [x1, y1] = toWindow(x + width, y + height);
            if (x1 > x0 && y1 > y0)
                region.unionRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        };
        const w = this._blur.width, h = this._blur.height, r = this._radius;
        add(0, 0, w, h - r);
        for (let i = 0; i < r; i++) {
            const dy = i + 0.5; // row center, measured from the corner circle's center
            const inset = r - Math.sqrt(r * r - dy * dy);
            add(inset, h - r + i, w - 2 * inset, 1);
        }
        return region;
    }
});

// A row of small bars that bounce while music plays.
class Equalizer {
    constructor(count, maxHeight, styleClass) {
        this._maxHeight = maxHeight;
        this.actor = new St.BoxLayout({ style_class: styleClass, y_align: Clutter.ActorAlign.CENTER });
        this._bars = [];
        for (let i = 0; i < count; i++) {
            const bar = new St.Widget({ style_class: 'ln-eq-bar', y_align: Clutter.ActorAlign.CENTER, height: 3 });
            this.actor.add_child(bar);
            this._bars.push(bar);
        }
    }

    set running(run) {
        if (run && !this._id) {
            this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_FRAME_MS, () => {
                for (const bar of this._bars) {
                    bar.ease({
                        height: 3 + Math.round(Math.random() * (this._maxHeight - 3)),
                        duration: EQ_FRAME_MS - 10,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!run && this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
            for (const bar of this._bars) {
                bar.remove_all_transitions();
                bar.height = 3;
            }
        }
    }

    destroy() {
        this.running = false;
    }
}

var Notch = class Notch {
    constructor() {
        this._timeouts = new Map();
        this._expanded = false;
        this._page = 'nook';
        this._busy = new Set(); // pages that need the notch to stay open
        this._player = null;
        this._artUrl = undefined;
        this._positionUs = 0;
        this._lengthUs = 0;
        this._scrubbing = false;
        this._scrubFrac = 0;
        this._captureId = 0;
        this._scroll = { dx: 0, dy: 0, last: 0, fired: 0 };
        this._transient = null;
        this._collapsedWidth = COLLAPSED_WIDTH.idle;
        this._activityKind = 'idle';
        this._clockText = '';
        this._tick = 0;

        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._calendar = new CalendarFeed();
        this._battery = new BatteryMonitor();
        this._downloads = new DownloadsMonitor();
        this._mpris = new MprisManager();
        this._store = new Store();
        this._timer = new FocusTimer(this._store);
        this._sysmon = new SystemMonitor(this._battery);
        this._agents = new AgentsFeed();
        this._style = this._store.get('style', 'classic');

        // Outer actor: transparent, holds the two ears and the black body between them.
        this.actor = new St.Widget({ name: 'linuxNotch', reactive: true, track_hover: true });
        const earColor = () => (this._style === 'glass' ? GLASS_TINT : [0, 0, 0, 1]);
        this._earLeft = makeEar('left', earColor);
        this._earRight = makeEar('right', earColor);
        this._body = new St.Widget({
            style_class: 'ln-notch',
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
            x: EAR,
        });
        // Glass backdrop: blurred copy of what is behind the body, clipped to its rounded shape.
        this._backdrop = new RoundedBlur({ x_expand: true, y_expand: true, visible: false });
        this._body.add_child(this._backdrop);
        this._body.connect('notify::width', () => this._layoutBackdrop());
        this._body.connect('notify::height', () => this._layoutBackdrop());
        this.actor.add_child(this._earLeft);
        this.actor.add_child(this._body);
        this.actor.add_child(this._earRight);

        this._buildCollapsed();
        this._buildExpanded();
        this._body.add_child(this._collapsed);
        this._body.add_child(this._expandedBox);
        this._buildTabBar();

        Main.layoutManager.addTopChrome(this.actor, { affectsInputRegion: true, trackFullscreen: true });
        // Not fullscreen-tracked: that would toggle its visibility behind our back.
        // It is only shown while the notch is open, which cannot happen over fullscreen windows.
        Main.layoutManager.addTopChrome(this._tabBar, { affectsInputRegion: true });

        this.actor.connect('notify::hover', () => this._onHover());
        this._tabBar.connect('notify::hover', () => this._onHover());
        this.actor.connect('button-release-event', (actor, event) => {
            if (!this._expanded && event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._setExpanded(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('scroll-event', (actor, event) => this._onScroll(event));
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._relayout(false));

        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            if (++this._tick % ACTIVITY_REFRESH_S === 0)
                this._renderCollapsed();
            return GLib.SOURCE_CONTINUE;
        });
        this._updateClock();

        this._mprisId = this._mpris.connect('changed', () => this._syncPlayer());
        this._calendarId = this._calendar.connect('changed', () => this._renderCollapsed());
        this._downloadsId = this._downloads.connect('changed', () => this._renderCollapsed());
        this._downloadDoneId = this._downloads.connect('finished', (m, name) => this._showTransient({
            kind: 'download-done', width: COLLAPSED_WIDTH.activity, iconName: 'folder-download-symbolic',
            text: name, right: 'label', rightText: 'Done',
        }, EVENT_MS));
        this._batteryId = this._battery.connect('event', (b, text) => this._showTransient({
            kind: 'battery', width: COLLAPSED_WIDTH.hud, iconName: b.iconName,
            text, right: 'label', rightText: `${b.percent}%`,
        }, EVENT_MS));

        this._timerId = this._timer.connect('changed', () => this._renderCollapsed());
        this._busyIds = [
            [this._nookPage, this._nookPage.connect('editing', (p, on) => this._setBusy('nook', on))],
            [this._trayPage, this._trayPage.connect('busy', (p, on) => this._setBusy('tray', on))],
            [this._prompterPage, this._prompterPage.connect('busy', (p, on) => this._setBusy('prompter', on))],
        ];
        this._agentsId = this._agents.connect('changed', () => this._renderCollapsed());
        this._tabBar.connect('button-release-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._setStyle(this._style === 'glass' ? 'classic' : 'glass');
            return Clutter.EVENT_STOP;
        });
        this._applyStyle();

        this._patchOsd();
        this._syncPlayer();
        this._selectPage('nook');
        this._relayout(false);
    }

    get _barHeight() {
        return Main.panel.height || Main.panel.get_preferred_height(-1)[1] || 32;
    }

    // ---- construction -------------------------------------------------

    _buildCollapsed() {
        this._collapsed = new St.BoxLayout({ style_class: 'ln-collapsed', x_expand: true, y_expand: true });

        this._leftArt = new St.Bin({ style_class: 'ln-mini-art', y_align: Clutter.ActorAlign.CENTER });
        this._leftArtIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 12 });
        this._leftIcon = new St.Icon({ style_class: 'ln-mini-icon', icon_size: 16, y_align: Clutter.ActorAlign.CENTER });

        this._center = ellipsize(new St.Label({
            style_class: 'ln-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._miniEq = new Equalizer(3, 14, 'ln-eq');

        this._level = new St.Widget({ style_class: 'ln-level', width: LEVEL_WIDTH, y_align: Clutter.ActorAlign.CENTER });
        this._levelFill = new St.Widget({ style_class: 'ln-level-fill', x: 0, y: 0, width: 0 });
        this._level.add_child(this._levelFill);

        this._rightLabel = new St.Label({ style_class: 'ln-right', y_align: Clutter.ActorAlign.CENTER });

        for (const child of [this._leftArt, this._leftIcon, this._center, this._miniEq.actor, this._level, this._rightLabel])
            this._collapsed.add_child(child);
    }

    _buildExpanded() {
        this._expandedBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });

        this._calendarPage = new CalendarPage(this._calendar, this._interfaceSettings);
        this._nookPage = new NookPage({
            timer: this._timer,
            store: this._store,
            sysmon: this._sysmon,
            battery: this._battery,
            onPlayPause: () => this._player?.playPause(),
            onNext: () => this._player?.next(),
            onPrevious: () => this._player?.previous(),
        });
        this._pages = new Map();
        this._pages.set('nook', { actor: this._nookPage.actor });
        this._pages.set('music', { actor: this._buildMusicPage() });
        this._pages.set('calendar', { actor: this._calendarPage.actor });
        this._trayPage = new TrayPage(this._store);
        this._pages.set('tray', { actor: this._trayPage.actor });
        this._prompterPage = new PrompterPage(this._store);
        this._pages.set('prompter', { actor: this._prompterPage.actor });
        this._agentsPage = new AgentsPage(this._agents);
        this._pages.set('agents', { actor: this._agentsPage.actor });

        // Pages keep their final size and sit at the top center, so the notch
        // reveals them as it grows instead of squeezing them.
        for (const [name, page] of this._pages) {
            const [w, h] = PAGE_SIZE[name];
            page.actor.set_size(w, h + this._barHeight);
            page.actor.x_align = Clutter.ActorAlign.CENTER;
            page.actor.y_align = Clutter.ActorAlign.START;
            page.actor.x_expand = page.actor.y_expand = false;
            page.actor.style = `padding-top: ${this._barHeight + 6}px;`;
            page.actor.visible = false;
            this._expandedBox.add_child(page.actor);
        }
    }

    _buildTabBar() {
        this._tabBar = new St.BoxLayout({
            style_class: 'ln-tabbar',
            reactive: true,
            track_hover: true,
            opacity: 0,
            visible: false,
        });
        const tabs = [
            ['nook', 'view-app-grid-symbolic', 'Nook'],
            ['music', 'media-playback-start-symbolic', 'Music'],
            ['calendar', 'x-office-calendar-symbolic', 'Calendar'],
            ['tray', 'mail-inbox-symbolic', 'Tray'],
            ['prompter', 'format-justify-left-symbolic', 'Prompter'],
            ['agents', 'emoji-symbols-symbolic', 'Agents'],
        ];
        for (const [name, iconName, text] of tabs) {
            const content = new St.BoxLayout({ style_class: 'ln-tab-content' });
            content.add_child(new St.Icon({ icon_name: iconName, icon_size: 14, y_align: Clutter.ActorAlign.CENTER }));
            const label = new St.Label({ text, style_class: 'ln-tab-label', y_align: Clutter.ActorAlign.CENTER });
            content.add_child(label);
            const button = new St.Button({ style_class: 'ln-tab', can_focus: true, child: content });
            button.connect('clicked', () => this._selectPage(name));
            this._tabBar.add_child(button);
            Object.assign(this._pages.get(name), { button, label });
        }
    }

    _selectPage(name) {
        const changed = this._page !== name;
        this._page = name;
        for (const [key, page] of this._pages) {
            const active = key === name;
            page.actor.visible = active;
            page.button.checked = active;
            page.label.visible = active;
        }
        if (name === 'calendar')
            this._calendarPage.refresh();
        if (changed && this._expanded)
            this._relayout(true);
    }

    _buildMusicPage() {
        const page = new St.Widget({ layout_manager: new Clutter.BinLayout() });

        this._musicBox = new St.BoxLayout({ style_class: 'ln-music', vertical: true, x_expand: true, y_expand: true });

        // top row: art with app badge, title/artist, little visualizer
        const top = new St.BoxLayout({ style_class: 'ln-music-top' });
        const artHolder = new St.Widget({ width: 70, height: 70 });
        this._art = new St.Bin({ style_class: 'ln-art', x: 0, y: 0 });
        this._artIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 28 });
        this._badge = new St.Icon({ style_class: 'ln-badge', icon_size: 22, x: 44, y: 44 });
        artHolder.add_child(this._art);
        artHolder.add_child(this._badge);

        const info = new St.BoxLayout({ style_class: 'ln-info', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._title = ellipsize(new St.Label({ style_class: 'ln-title' }));
        this._artist = ellipsize(new St.Label({ style_class: 'ln-artist' }));
        info.add_child(this._title);
        info.add_child(this._artist);

        this._bigEq = new Equalizer(6, 10, 'ln-eq-small');
        this._bigEq.actor.y_align = Clutter.ActorAlign.START;

        top.add_child(artHolder);
        top.add_child(info);
        top.add_child(this._bigEq.actor);

        // slim seek bar
        this._track = new St.Widget({ style_class: 'ln-progress', reactive: true, x_expand: true });
        this._fill = new St.Widget({ style_class: 'ln-progress-fill', x: 0, y: 0, width: 0 });
        this._track.add_child(this._fill);
        this._track.connect('notify::width', () => this._renderProgress());
        this._track.connect('button-press-event', (actor, event) => this._startScrub(event));

        // controls, spread across the width
        const controls = new St.BoxLayout({ style_class: 'ln-controls', x_expand: true });
        this._shuffleButton = this._makeButton('media-playlist-shuffle-symbolic', 18, 'ln-btn', () => {
            if (this._player && this._player.shuffle !== null)
                this._player.setShuffle(!this._player.shuffle);
        });
        this._prevButton = this._makeButton('media-seek-backward-symbolic', 24, 'ln-btn', () => this._player?.previous());
        this._playButton = this._makeButton('media-playback-start-symbolic', 22, 'ln-btn-play', () => this._player?.playPause());
        this._nextButton = this._makeButton('media-seek-forward-symbolic', 24, 'ln-btn', () => this._player?.next());
        this._outputButton = this._makeButton('audio-speakers-symbolic', 18, 'ln-btn', () => {
            Main.overview.hide();
            Shell.AppSystem.get_default().lookup_app('gnome-sound-panel.desktop')?.activate();
        });
        const buttons = [this._shuffleButton, this._prevButton, this._playButton, this._nextButton, this._outputButton];
        buttons.forEach((b, i) => {
            controls.add_child(b);
            if (i < buttons.length - 1)
                controls.add_child(new St.Widget({ x_expand: true }));
        });

        this._musicBox.add_child(top);
        this._musicBox.add_child(this._track);
        this._musicBox.add_child(controls);

        this._empty = new St.Label({
            style_class: 'ln-empty',
            text: 'Nothing playing',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        page.add_child(this._musicBox);
        page.add_child(this._empty);
        return page;
    }

    _makeButton(iconName, size, styleClass, onClick) {
        const button = new St.Button({
            style_class: styleClass,
            can_focus: true,
            child: new St.Icon({ icon_name: iconName, icon_size: size }),
        });
        button.connect('clicked', onClick);
        return button;
    }

    // ---- geometry and expansion ---------------------------------------

    _bodySize() {
        if (this._expanded) {
            const [w, h] = PAGE_SIZE[this._page];
            return [w, h + this._barHeight];
        }
        return [this._collapsedWidth, this._barHeight];
    }

    _relayout(animate) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [w, h] = this._bodySize();
        const outerW = w + 2 * EAR;
        const x = monitor.x + Math.round((monitor.width - outerW) / 2);
        const y = monitor.y;

        const tabW = this._tabBar.get_preferred_width(-1)[1];
        const tabX = monitor.x + Math.round((monitor.width - tabW) / 2);
        const tabY = y + h + TAB_GAP;

        if (!animate) {
            // Cancel only geometry animations; the fades on these actors must keep running.
            for (const a of [this.actor, this._body, this._earRight, this._tabBar]) {
                for (const prop of ['x', 'y', 'width', 'height'])
                    a.remove_transition(prop);
            }
            this.actor.set_position(x, y);
            this.actor.set_size(outerW, h);
            this._body.set_size(w, h);
            this._earRight.x = EAR + w;
            this._tabBar.set_position(tabX, tabY);
            return;
        }
        const params = {
            duration: this._expanded ? 320 : 220,
            mode: this._expanded ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
        };
        this.actor.ease({ x, y, width: outerW, height: h, ...params });
        this._body.ease({ width: w, height: h, ...params });
        this._earRight.ease({ x: EAR + w, ...params });
        this._tabBar.ease({ x: tabX, y: tabY, ...params });
    }

    _fade(actor, show, delay = 0) {
        actor.remove_all_transitions();
        if (show)
            actor.visible = true;
        actor.ease({
            opacity: show ? 255 : 0,
            duration: show ? 200 : 110,
            delay: show ? delay : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!show && actor.opacity === 0)
                    actor.visible = false;
            },
        });
    }

    _setExpanded(expanded) {
        if (this._expanded === expanded)
            return;
        this._expanded = expanded;

        if (expanded) {
            if (this._agents.pendingPermission)
                this._selectPage('agents');
            this._body.add_style_class_name('expanded');
            this._fade(this._collapsed, false);
            this._fade(this._expandedBox, true, 80);
            this._fade(this._tabBar, true, 140);
            if (this._page === 'calendar')
                this._calendarPage.refresh();
            this._startPositionPoll();
            this._watchOutside();
        } else {
            this._unwatchOutside();
            this._body.remove_style_class_name('expanded');
            this._fade(this._expandedBox, false);
            this._fade(this._tabBar, false);
            this._fade(this._collapsed, true, 120);
            this._stopPositionPoll();
        }
        this._syncEqualizers();
        this._layoutBackdrop(); // corner radius follows the expanded state
        this._relayout(true);
    }

    // Hover opens the notch. It stays open until a click outside it (see _watchOutside).
    _onHover() {
        this._clearTimeout('hover');
        if (this._expanded)
            return;
        if (this.actor.hover || this._tabBar.hover)
            this._addTimeout('hover', HOVER_OPEN_MS, () => this._setExpanded(true));
    }

    _containsPoint(x, y) {
        return [this.actor, this._tabBar].some(a => {
            if (!a.visible)
                return false;
            const [ax, ay] = a.get_transformed_position();
            const [w, h] = a.get_transformed_size();
            return x >= ax && x < ax + w && y >= ay && y < ay + h;
        });
    }

    _onOutsideClick(x, y) {
        // typing, an open menu or a running prompter keep the notch open
        if (!this._expanded || this._busy.size > 0 || this._scrubbing || this._containsPoint(x, y))
            return;
        this._setExpanded(false);
    }

    // Clicks on shell actors arrive as stage events. Clicks on app windows go straight to the
    // window and never reach the stage, so the pointer buttons are also polled while open.
    _watchOutside() {
        if (this._outsideId)
            return;
        this._outsideId = global.stage.connect('captured-event', (stage, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS || event.type() === Clutter.EventType.TOUCH_BEGIN)
                this._onOutsideClick(...event.get_coords());
            return Clutter.EVENT_PROPAGATE;
        });
        const buttons = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;
        this._buttonsDown = (global.get_pointer()[2] & buttons) !== 0;
        this._outsidePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OUTSIDE_POLL_MS, () => {
            const [x, y, mods] = global.get_pointer();
            const down = (mods & buttons) !== 0;
            if (down && !this._buttonsDown)
                this._onOutsideClick(x, y);
            this._buttonsDown = down;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _unwatchOutside() {
        if (this._outsideId) {
            global.stage.disconnect(this._outsideId);
            this._outsideId = 0;
        }
        if (this._outsidePollId) {
            GLib.source_remove(this._outsidePollId);
            this._outsidePollId = 0;
        }
    }

    // Scroll down opens, scroll up closes, horizontal scroll skips tracks.
    // Scrolling inside the calendar list is consumed by its ScrollView first.
    _onScroll(event) {
        const now = Date.now();
        const s = this._scroll;
        if (now - s.last > 300)
            s.dx = s.dy = 0;
        s.last = now;

        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            s.dx += dx;
            s.dy += dy;
            if (Math.abs(s.dx) >= SCROLL_THRESHOLD && Math.abs(s.dx) > Math.abs(s.dy))
                direction = s.dx > 0 ? Clutter.ScrollDirection.RIGHT : Clutter.ScrollDirection.LEFT;
            else if (Math.abs(s.dy) >= SCROLL_THRESHOLD)
                direction = s.dy > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
            else
                return Clutter.EVENT_STOP;
        }
        if (now - s.fired < SCROLL_COOLDOWN_MS)
            return Clutter.EVENT_STOP;
        s.fired = now;
        s.dx = s.dy = 0;

        const musicGestures = !this._expanded || this._page === 'music';
        switch (direction) {
        case Clutter.ScrollDirection.DOWN:
            this._setExpanded(true);
            break;
        case Clutter.ScrollDirection.UP:
            this._setExpanded(false);
            break;
        case Clutter.ScrollDirection.RIGHT:
            if (musicGestures)
                this._player?.next();
            break;
        case Clutter.ScrollDirection.LEFT:
            if (musicGestures)
                this._player?.previous();
            break;
        }
        return Clutter.EVENT_STOP;
    }

    // ---- live activities ----------------------------------------------

    _showTransient(activity, ms) {
        this._transient = activity;
        this._addTimeout('transient', ms, () => {
            this._transient = null;
            this._renderCollapsed();
        });
        this._renderCollapsed();
    }

    _currentActivity() {
        if (this._transient)
            return this._transient;

        const waiting = this._agents.pendingPermission;
        if (waiting) {
            return {
                kind: 'agent-permission', width: COLLAPSED_WIDTH.activity, iconName: 'dialog-password-symbolic',
                text: waiting.permission.label, right: 'label', rightText: 'Approve?', accent: true,
            };
        }
        // the shown session if it is working, otherwise the most recently active working one
        const shown = this._agents.session;
        const agent = shown?.status === 'working' ? shown
            : this._agents.sessions.filter(x => x.status === 'working').sort((a, b) => b.updated - a.updated)[0];

        if (this._timer.state !== 'idle') {
            return {
                kind: 'timer', width: COLLAPSED_WIDTH.hud, iconName: 'alarm-symbolic',
                text: this._timer.mode === 'focus' ? 'Focus' : 'Break',
                right: 'label', rightText: this._timer.display, accent: true,
            };
        }

        const meeting = this._calendar.soon();
        if (meeting) {
            const mins = Math.ceil((meeting.start - Date.now()) / 60000);
            return {
                kind: 'meeting', width: COLLAPSED_WIDTH.activity, iconName: 'x-office-calendar-symbolic',
                text: meeting.summary, right: 'label', rightText: mins > 0 ? `in ${mins} min` : 'now',
            };
        }

        const download = this._downloads.current;
        if (download) {
            return {
                kind: 'download', width: COLLAPSED_WIDTH.activity, iconName: 'folder-download-symbolic',
                text: download.name, right: 'label', rightText: formatBytes(download.size),
            };
        }

        if (agent?.status === 'working') {
            return {
                kind: 'agent', width: COLLAPSED_WIDTH.activity, iconName: 'emoji-symbols-symbolic',
                text: agent.current?.label ?? agent.title ?? 'Claude', right: 'label', accent: true,
                rightText: this._agents.workingCount > 1 ? `${this._agents.workingCount} working` : 'Working',
            };
        }

        // Like NotchNook: art on the left, bars on the right, nothing in the middle.
        if (this._player?.isPlaying)
            return { kind: 'music', width: COLLAPSED_WIDTH.music, art: true, text: '', right: 'eq' };

        return { kind: 'idle', width: COLLAPSED_WIDTH.idle, text: null, right: null };
    }

    _renderCollapsed() {
        const a = this._currentActivity();
        this._activityKind = a.kind;

        this._leftArt.visible = Boolean(a.art);
        this._leftIcon.visible = !a.art && Boolean(a.gicon || a.iconName);
        if (a.gicon)
            this._leftIcon.gicon = a.gicon;
        else if (a.iconName)
            this._leftIcon.icon_name = a.iconName;

        this._showingClock = a.text === null || a.text === undefined;
        this._center.text = this._showingClock ? this._clockText : a.text;

        this._miniEq.actor.visible = a.right === 'eq';
        this._level.visible = a.right === 'level';
        this._rightLabel.visible = a.right === 'label';
        if (a.right === 'label')
            this._rightLabel.text = a.rightText ?? '';
        if (a.accent)
            this._rightLabel.add_style_class_name('accent');
        else
            this._rightLabel.remove_style_class_name('accent');
        if (a.right === 'level')
            this._levelFill.width = Math.round(LEVEL_WIDTH * (a.level ?? 0));

        this._syncEqualizers();
        if (this._collapsedWidth !== a.width) {
            this._collapsedWidth = a.width;
            if (!this._expanded)
                this._relayout(true);
        }
    }

    _syncEqualizers() {
        this._miniEq.running = !this._expanded && this._activityKind === 'music';
        this._bigEq.running = this._expanded && Boolean(this._player?.isPlaying);
    }

    _setBusy(source, on) {
        if (on)
            this._busy.add(source);
        else
            this._busy.delete(source);
        this._onHover();
    }

    _setStyle(style) {
        this._style = style;
        this._store.set('style', style);
        this._applyStyle();
        this._showTransient({
            kind: 'style', width: COLLAPSED_WIDTH.hud, iconName: 'weather-clear-night-symbolic',
            text: style === 'glass' ? 'Liquid Glass' : 'Classic', right: null,
        }, 1200);
    }

    // Glass: blur what is behind the body and tab bar, then tint it (see stylesheet).
    _applyStyle() {
        const glass = this._style === 'glass';
        // Only the body is blurred; the tab pill gets the tint alone.
        this._backdrop.visible = glass;
        this._layoutBackdrop();
        for (const actor of [this._body, this._tabBar]) {
            if (glass)
                actor.add_style_class_name('glass');
            else
                actor.remove_style_class_name('glass');
        }
        this._earLeft.queue_repaint();
        this._earRight.queue_repaint();
    }

    _layoutBackdrop() {
        if (!this._backdrop.visible)
            return;
        const r = this._expanded ? CORNER.expanded : CORNER.collapsed;
        this._backdrop.setShape(this._body.width, this._body.height, r);
    }

    // Volume and brightness popups go to the notch instead of the center of the screen.
    // When the notch cannot show them (fullscreen window, notch open) the stock OSD is used.
    _patchOsd() {
        const osd = Main.osdWindowManager;
        this._osdHadOwnShow = Object.prototype.hasOwnProperty.call(osd, 'show');
        this._origOsdShow = osd.show;
        const notch = this;
        osd.show = function (monitorIndex, icon, label, level, maxLevel) {
            if (!notch.actor.visible || notch._expanded)
                return notch._origOsdShow.call(this, monitorIndex, icon, label, level, maxLevel);
            const hasLevel = typeof level === 'number';
            notch._showTransient({
                kind: 'hud',
                width: hasLevel ? COLLAPSED_WIDTH.hud : COLLAPSED_WIDTH.activity,
                gicon: icon,
                text: label || '',
                right: hasLevel ? 'level' : null,
                level: hasLevel ? Math.max(0, Math.min(1, level / (maxLevel || 1))) : null,
            }, HUD_MS);
            return undefined;
        };
    }

    _unpatchOsd() {
        const osd = Main.osdWindowManager;
        if (this._osdHadOwnShow)
            osd.show = this._origOsdShow;
        else
            delete osd.show;
    }

    // ---- clock --------------------------------------------------------

    _updateClock() {
        const twelveHour = this._interfaceSettings.get_string('clock-format') === '12h';
        this._clockText = GLib.DateTime.new_now_local().format(twelveHour ? '%l:%M' : '%H:%M').trim();
        if (this._showingClock && this._center.text !== this._clockText)
            this._center.text = this._clockText;
    }

    // ---- music --------------------------------------------------------

    _appIcon(player) {
        const apps = Shell.AppSystem.get_default();
        const s = player.busSuffix;
        const candidates = [player.desktopEntry, s, `${s}_${s}`, `org.${s}.${s}`].filter(Boolean);
        for (const c of candidates) {
            const app = apps.lookup_app(`${c}.desktop`);
            if (app)
                return app.get_icon();
        }
        return apps.lookup_desktop_wmclass(s)?.get_icon() ?? null;
    }

    _syncPlayer() {
        const player = this._mpris.activePlayer;
        this._player = player;

        this._musicBox.visible = player !== null;
        this._empty.visible = player === null;

        if (player) {
            this._title.text = player.title;
            this._artist.text = player.artist || player.sourceName;
            this._lengthUs = player.length;
            this._playButton.child.icon_name = player.isPlaying
                ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            this._setEnabled(this._prevButton, player.canGoPrevious);
            this._setEnabled(this._nextButton, player.canGoNext);
            this._setEnabled(this._shuffleButton, player.shuffle !== null);
            if (player.shuffle)
                this._shuffleButton.add_style_pseudo_class('checked');
            else
                this._shuffleButton.remove_style_pseudo_class('checked');
            this._track.reactive = player.canSeek;
            const icon = this._appIcon(player);
            this._badge.gicon = icon;
            this._badge.visible = icon !== null;
            this._nookPage.setPlayer(player, icon);
            this._updateArt(player.artUrl);
            this._pollPosition();
        } else {
            this._lengthUs = this._positionUs = 0;
            this._nookPage.setPlayer(null, null);
            this._updateArt(null);
            this._renderProgress();
        }

        this._renderCollapsed();
    }

    _setEnabled(button, enabled) {
        button.reactive = enabled;
        button.opacity = enabled ? 255 : 80;
    }

    _updateArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        this._setArt(null);
        loadArt(url, uri => {
            if (this._destroyed || this._artUrl !== url)
                return;
            this._setArt(uri);
        });
    }

    _setArt(uri) {
        const style = uri ? `background-image: url("${uri}");` : null;
        this._art.style = style;
        this._leftArt.style = style;
        this._art.child = uri ? null : this._artIcon;
        this._leftArt.child = uri ? null : this._leftArtIcon;
        this._nookPage.setArt(uri);
    }

    _renderProgress(positionUs = this._positionUs) {
        const frac = this._lengthUs > 0 ? Math.min(1, positionUs / this._lengthUs) : 0;
        this._fill.width = Math.round(this._track.width * frac);
    }

    _pollPosition() {
        if (!this._expanded || !this._player || this._scrubbing)
            return;
        const player = this._player;
        player.getPosition(pos => {
            if (this._destroyed || pos === null || player !== this._player || this._scrubbing)
                return;
            this._positionUs = pos;
            this._renderProgress();
        });
    }

    _startPositionPoll() {
        this._stopPositionPoll();
        this._pollPosition();
        this._positionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_POLL_MS, () => {
            this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPositionPoll() {
        if (this._positionId) {
            GLib.source_remove(this._positionId);
            this._positionId = 0;
        }
    }

    // ---- scrubbing ----------------------------------------------------

    _startScrub(event) {
        if (!this._player?.canSeek || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._scrubbing = true;
        this._scrubTo(event);
        this._captureId = global.stage.connect('captured-event', (stage, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                this._scrubTo(ev);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                this._scrubTo(ev);
                this._endScrub(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    }

    _scrubTo(event) {
        const [stageX] = event.get_coords();
        const [trackX] = this._track.get_transformed_position();
        const width = this._track.width || 1;
        this._scrubFrac = Math.max(0, Math.min(1, (stageX - trackX) / width));
        this._renderProgress(this._scrubFrac * this._lengthUs);
    }

    _endScrub(commit) {
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        if (!this._scrubbing)
            return;
        this._scrubbing = false;
        if (commit && this._player) {
            this._positionUs = this._scrubFrac * this._lengthUs;
            this._player.setPosition(this._positionUs);
        }
        this._onHover();
    }

    // ---- helpers ------------------------------------------------------

    _addTimeout(name, ms, fn) {
        this._clearTimeout(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(name, id);
    }

    _clearTimeout(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    destroy() {
        this._destroyed = true;
        this._unpatchOsd();
        this._endScrub(false);
        this._unwatchOutside();
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        for (const key of ['_clockId', '_positionId']) {
            if (this[key])
                GLib.source_remove(this[key]);
            this[key] = 0;
        }
        this._miniEq.destroy();
        this._bigEq.destroy();
        Main.layoutManager.disconnect(this._monitorsId);
        this._mpris.disconnect(this._mprisId);
        this._calendar.disconnect(this._calendarId);
        this._downloads.disconnect(this._downloadsId);
        this._downloads.disconnect(this._downloadDoneId);
        this._battery.disconnect(this._batteryId);
        this._timer.disconnect(this._timerId);
        this._agents.disconnect(this._agentsId);
        this._busyIds.forEach(([obj, id]) => obj.disconnect(id));

        this._trayPage.destroy();
        this._prompterPage.destroy();
        this._agentsPage.destroy();
        this._nookPage.destroy();
        this._calendarPage.destroy();
        this._mpris.destroy();
        this._calendar.destroy();
        this._downloads.destroy();
        this._timer.destroy();
        this._agents.destroy();
        this._sysmon.destroy();
        this._battery.destroy();
        this._store.destroy();

        Main.layoutManager.removeChrome(this._tabBar);
        Main.layoutManager.removeChrome(this.actor);
        this._tabBar.destroy();
        this.actor.destroy();
    }
};
