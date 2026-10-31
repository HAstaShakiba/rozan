/* exported AgentsFeed, AgentsPage */
// AI agent progress, fed by hooks/notch-hook.py (registered as a Claude Code hook).
// The hook keeps one JSON file per session in ~/.cache/rozan/agents. This module
// lists every live session, lets the user pick which one the Agents page shows, and
// answers permission requests by writing <session>.decision.
const { St, Clutter, Gio, GLib, Pango } = imports.gi;
const Main = imports.ui.main;
const Signals = imports.signals;

const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'rozan', 'agents']);
const STALE_S = 2 * 3600;   // ignore sessions idle for longer than this
const ACTIVE_S = 120;       // "working" sessions older than this are treated as idle
const HEARTBEAT = GLib.build_filenamev([DIR, '.notch-alive']);
const HEARTBEAT_S = 10;      // the hook only waits for an answer while this file is fresh
const MAX_CHIPS = 6;

function ellipsize(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

function pidAlive(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.IS_DIR);
}

function parentPid(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        const stat = new TextDecoder().decode(bytes);
        return parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch (e) {
        return 0;
    }
}

var AgentsFeed = class AgentsFeed {
    constructor() {
        GLib.mkdir_with_parents(DIR, 0o700);
        this._dir = Gio.File.new_for_path(DIR);
        this.sessions = [];       // live sessions, oldest first (stable order for the chips)
        this._selectedId = null;  // null: follow the most recently active session
        this._seenPermissions = new Set();
        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', (m, file) => {
            if (file.get_basename().endsWith('.json'))
                this._queueReload();
        });
        this._reload();
        this._beat();
        // The heartbeat also rescans, so sessions whose terminal was closed disappear.
        this._beatId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HEARTBEAT_S, () => {
            this._beat();
            this._reload();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // The session the Agents page shows.
    get session() {
        return this.sessions.find(s => s.session_id === this._selectedId) ?? this._latest();
    }

    // A session waiting for a permission answer, preferring the one on screen.
    get pendingPermission() {
        const shown = this.session;
        return shown?.permission ? shown : this.sessions.find(s => s.permission) ?? null;
    }

    get workingCount() {
        return this.sessions.filter(s => s.status === 'working' || s.status === 'waiting').length;
    }

    _latest() {
        let best = null;
        for (const s of this.sessions) {
            if (!best || s.updated > best.updated)
                best = s;
        }
        return best;
    }

    select(sessionId) {
        if (this._selectedId === sessionId)
            return;
        this._selectedId = sessionId;
        this.emit('changed');
    }

    // Tells the hook script that the notch is running and can answer permission requests.
    _beat() {
        try {
            GLib.file_set_contents(HEARTBEAT, String(Date.now()));
        } catch (e) {
            // not fatal: the hook then falls back to the terminal prompt immediately
        }
    }

    _queueReload() {
        if (this._idleId)
            return;
        this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._idleId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        const now = Date.now() / 1000;
        const sessions = [];
        try {
            const children = this._dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info = children.next_file(null); info; info = children.next_file(null)) {
                const name = info.get_name();
                if (!name.endsWith('.json'))
                    continue;
                try {
                    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([DIR, name]));
                    const s = JSON.parse(new TextDecoder().decode(bytes));
                    if (s.status === 'ended' || now - (s.updated || 0) > STALE_S)
                        continue;
                    if (s.pid && !pidAlive(s.pid))
                        continue; // terminal closed without a SessionEnd event
                    if (s.status === 'working' && now - s.updated > ACTIVE_S && !s.permission)
                        s.status = 'idle';
                    sessions.push(s);
                } catch (e) {
                    // partially written or foreign file
                }
            }
            children.close(null);
        } catch (e) {
            logError(e, 'rozan: cannot read agent sessions');
        }
        sessions.sort((a, b) => (a.started ?? a.updated) - (b.started ?? b.updated));
        this.sessions = sessions;

        // A new permission request brings its session to the front.
        for (const s of sessions) {
            if (s.permission && !this._seenPermissions.has(s.permission.id)) {
                this._seenPermissions.add(s.permission.id);
                this._selectedId = s.session_id;
            }
        }
        if (this._selectedId && !sessions.some(s => s.session_id === this._selectedId))
            this._selectedId = null;
        // The periodic rescan usually finds nothing new; skip rebuilding the UI then.
        const key = JSON.stringify([this._selectedId, sessions]);
        if (key === this._lastKey)
            return;
        this._lastKey = key;
        this.emit('changed');
    }

    decide(decision) {
        const s = this.pendingPermission;
        const p = s?.permission;
        if (!p)
            return;
        const path = GLib.build_filenamev([DIR, `${s.session_id}.decision`]);
        GLib.file_set_contents(path, JSON.stringify({ id: p.id, decision }));
    }

    // Raise the terminal running the session: the window owned by one of the
    // Claude process's ancestors. ddterm hides its window, so it is asked to show itself.
    focusTerminal(session) {
        if (!session?.pid)
            return false;
        const ancestors = new Set();
        for (let pid = session.pid; pid > 1 && ancestors.size < 16; pid = parentPid(pid))
            ancestors.add(pid);
        const windows = global.display.list_all_windows().filter(w => ancestors.has(w.get_pid()));
        if (windows.length === 0)
            return false;
        const title = session.title ?? '';
        const win = windows.find(w => title && (w.get_title() ?? '').includes(title.slice(0, 20))) ?? windows[0];
        if ((win.get_wm_class() ?? '').includes('ddterm')) {
            Gio.DBus.session.call('org.gnome.Shell', '/org/gnome/Shell/Extensions/ddterm',
                'com.github.amezin.ddterm.Extension', 'Activate', null, null,
                Gio.DBusCallFlags.NONE, -1, null, null);
            return true;
        }
        Main.activateWindow(win);
        return true;
    }

    destroy() {
        GLib.source_remove(this._beatId);
        GLib.unlink(HEARTBEAT);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._monitor.disconnect(this._monitorId);
        this._monitor.cancel();
        this.disconnectAll();
    }
};
Signals.addSignalMethods(AgentsFeed.prototype);

var AgentsPage = class AgentsPage {
    constructor(feed) {
        this._feed = feed;
        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });

        // ---- session view
        this._view = new St.BoxLayout({ style_class: 'ln-agents', vertical: true, x_expand: true, y_expand: true });
        const header = new St.BoxLayout({ style_class: 'ln-agents-header' });
        // one chip per live session; clicking a chip shows that session
        this._chips = new St.BoxLayout({ style_class: 'ln-session-chips', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._chips);
        this._termBtn = new St.Button({
            style_class: 'ln-agent-chip ln-term-btn', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'utilities-terminal-symbolic', icon_size: 12 }),
        });
        this._termBtn.connect('clicked', () => this._feed.focusTerminal(this._feed.session));
        header.add_child(this._termBtn);
        this._statusDot = new St.Bin({ style_class: 'ln-agent-chip', child: new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 12 }) });
        header.add_child(this._statusDot);

        const body = new St.BoxLayout({ style_class: 'ln-agents-body', x_expand: true, y_expand: true });
        const left = new St.BoxLayout({ vertical: true, style_class: 'ln-agents-left', x_expand: true });
        const titleRow = new St.BoxLayout({ style_class: 'ln-agent-title-row' });
        titleRow.add_child(new St.Icon({ icon_name: 'emoji-symbols-symbolic', icon_size: 16, style_class: 'ln-agent-icon', y_align: Clutter.ActorAlign.CENTER }));
        this._agentName = new St.Label({ style_class: 'ln-agent-name', y_align: Clutter.ActorAlign.CENTER });
        this._task = ellipsize(new St.Label({ style_class: 'ln-agent-task', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        titleRow.add_child(this._agentName);
        titleRow.add_child(this._task);
        this._steps = new St.BoxLayout({ vertical: true, style_class: 'ln-agent-steps' });
        left.add_child(titleRow);
        left.add_child(this._steps);

        // right card: current tool, or a permission request
        this._card = new St.BoxLayout({ vertical: true, style_class: 'ln-agent-card', y_align: Clutter.ActorAlign.START });
        const cmdRow = new St.BoxLayout({ style_class: 'ln-card-row' });
        this._cardIcon = new St.Icon({ icon_name: 'utilities-terminal-symbolic', icon_size: 12, style_class: 'ln-card-icon', y_align: Clutter.ActorAlign.CENTER });
        this._cardCmd = ellipsize(new St.Label({ style_class: 'ln-card-cmd', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        cmdRow.add_child(this._cardIcon);
        cmdRow.add_child(this._cardCmd);
        this._cardSub = new St.Label({ style_class: 'ln-card-sub' });
        this._cardBar = new St.Widget({ style_class: 'ln-card-bar', x_expand: true, clip_to_allocation: true });
        this._cardBarFill = new St.Widget({ style_class: 'ln-card-bar-fill', x: 0, y: 0, width: 36 });
        this._cardBar.add_child(this._cardBarFill);
        this._permRow = new St.BoxLayout({ style_class: 'ln-perm-row' });
        const mk = (text, cls, decision) => {
            const b = new St.Button({ label: text, style_class: `ln-perm-btn ${cls}` });
            b.connect('clicked', () => this._feed.decide(decision));
            this._permRow.add_child(b);
        };
        mk('Allow', 'allow', 'allow');
        mk('Deny', 'deny', 'deny');
        mk('Terminal', 'ask', 'ask');
        for (const a of [cmdRow, this._cardSub, this._cardBar, this._permRow])
            this._card.add_child(a);

        body.add_child(left);
        body.add_child(this._card);
        this._view.add_child(header);
        this._view.add_child(body);

        // ---- empty state
        this._empty = new St.BoxLayout({ vertical: true, style_class: 'ln-agents-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._empty.add_child(new St.Icon({ icon_name: 'emoji-symbols-symbolic', icon_size: 20, x_align: Clutter.ActorAlign.CENTER }));
        this._empty.add_child(new St.Label({ text: 'No active agent sessions', style_class: 'ln-tray-title', x_align: Clutter.ActorAlign.CENTER }));
        this._empty.add_child(new St.Label({ text: 'Claude Code sessions appear here once the Rozan hook is installed.', style_class: 'ln-tray-hint', x_align: Clutter.ActorAlign.CENTER }));

        this.actor.add_child(this._view);
        this.actor.add_child(this._empty);

        this._feedId = feed.connect('changed', () => this.refresh());
        this.actor.connect('notify::mapped', () => this._syncTicker());
        this.refresh();
    }

    refresh() {
        const s = this._feed.session;
        this._view.visible = Boolean(s);
        this._empty.visible = !s;
        if (!s) {
            this._syncTicker();
            return;
        }
        const project = s.cwd ? GLib.path_get_basename(s.cwd) : '';
        this._agentName.text = s.agent || 'Claude';
        const tasks = s.tasks ?? [];
        const active = tasks.find(t => t.status === 'in_progress');
        this._task.text = `●  ${active?.active || s.title || s.prompt || project}`;
        this._statusDot.style_class = `ln-agent-chip ${s.status}`;
        this._termBtn.visible = Boolean(s.pid);
        this._buildChips(s);

        // checklist: tasks if the agent keeps a list, otherwise recent tool steps
        this._steps.destroy_all_children();
        const rows = tasks.length
            ? tasks.slice(0, 5).map(t => ({ label: t.text, state: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : 'pending' }))
            : [...(s.steps ?? []).slice(-3), ...(s.current ? [{ label: s.current.label, state: 'running' }] : [])];
        for (const r of rows) {
            const row = new St.BoxLayout({ style_class: 'ln-step' });
            const mark = { done: '✓', running: '▶', failed: '✕', pending: '○' }[r.state] ?? '•';
            row.add_child(new St.Label({ text: mark, style_class: `ln-step-mark ${r.state}`, y_align: Clutter.ActorAlign.CENTER }));
            row.add_child(ellipsize(new St.Label({ text: r.label, style_class: `ln-step-text ${r.state}`, x_expand: true, y_align: Clutter.ActorAlign.CENTER })));
            this._steps.add_child(row);
        }

        // right card
        const p = s.permission;
        this._permRow.visible = Boolean(p);
        this._cardBar.visible = !p && Boolean(s.current);
        this._card.visible = Boolean(p || s.current || s.status === 'idle');
        if (p) {
            this._card.add_style_class_name('perm');
            this._cardIcon.icon_name = 'dialog-password-symbolic';
            this._cardCmd.text = p.label;
            this._cardSub.text = `${p.tool} needs permission`;
        } else if (s.current) {
            this._card.remove_style_class_name('perm');
            this._cardIcon.icon_name = s.current.tool === 'Bash' ? 'utilities-terminal-symbolic' : 'system-run-symbolic';
            this._cardCmd.text = s.current.label;
        } else {
            this._card.remove_style_class_name('perm');
            this._cardIcon.icon_name = 'object-select-symbolic';
            this._cardCmd.text = project || 'Session';
            this._cardSub.text = s.status === 'idle' ? 'Waiting for your next prompt' : '';
        }
        this._syncTicker();
    }

    _buildChips(shown) {
        this._chips.destroy_all_children();
        let sessions = this._feed.sessions;
        if (sessions.length > MAX_CHIPS) {
            // keep the shown session and the most recently active others, in their usual order
            const keep = new Set([...sessions].sort((a, b) => b.updated - a.updated)
                .slice(0, MAX_CHIPS - 1).map(x => x.session_id));
            keep.add(shown.session_id);
            sessions = sessions.filter(x => keep.has(x.session_id));
        }
        // Sessions in the same folder get a number so they can be told apart.
        const seen = new Map();
        for (const x of sessions) {
            const project = x.cwd ? GLib.path_get_basename(x.cwd) : 'session';
            const n = (seen.get(project) ?? 0) + 1;
            seen.set(project, n);
            const shownHere = x.session_id === shown.session_id;
            const chip = new St.Button({
                style_class: `ln-session-chip ${x.status}${shownHere ? ' selected' : ''}`,
                can_focus: true,
            });
            const box = new St.BoxLayout({ style_class: 'ln-session-chip-box' });
            box.add_child(new St.Widget({ style_class: `ln-session-dot ${x.status}`, y_align: Clutter.ActorAlign.CENTER }));
            box.add_child(ellipsize(new St.Label({
                text: n > 1 ? `${project} ${n}` : project,
                style_class: 'ln-session-name',
                y_align: Clutter.ActorAlign.CENTER,
            })));
            chip.set_child(box);
            chip.connect('clicked', () => this._feed.select(x.session_id));
            this._chips.add_child(chip);
        }
    }

    // While a tool runs, update elapsed time and slide the indeterminate bar.
    _syncTicker() {
        const s = this._feed.session;
        const run = this.actor.mapped && Boolean(s?.current) && !s?.permission;
        if (run && !this._tickId) {
            let phase = 0;
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                const cur = this._feed.session?.current;
                if (!cur)
                    return GLib.SOURCE_CONTINUE;
                const secs = Math.max(0, Date.now() / 1000 - cur.started);
                this._cardSub.text = `${secs.toFixed(secs < 10 ? 2 : 1)} seconds`;
                phase = (phase + 0.02) % 1;
                const w = this._cardBar.width;
                this._cardBarFill.x = Math.round((w + 36) * phase - 36);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!run && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._feed.disconnect(this._feedId);
        this.actor.destroy();
    }
};
