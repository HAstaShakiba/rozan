/* exported CalendarFeed, CalendarPage */
// Calendar data comes from GNOME Shell's own calendar server (Evolution Data Server),
// so any account added in GNOME Online Accounts or Evolution shows up here.
// Layout follows NotchNook's Calendar workspace: upcoming event cards on the left,
// a month grid on the right.
const { St, Clutter, GLib, Pango } = imports.gi;
const Signals = imports.signals;
const ShellCalendar = imports.ui.calendar;

const REFRESH_SECONDS = 300;
const UPCOMING_DAYS = 7;
const SOON_MS = 10 * 60 * 1000;        // show "in N min" this long before a meeting
const JUST_STARTED_MS = 5 * 60 * 1000; // and "now" for this long after it starts

// Calendar colors are not exposed by the shell's calendar server, so each source
// calendar gets a stable color from this palette.
const PALETTE = ['#0a84ff', '#ff9f0a', '#bf5af2', '#30d158', '#ff375f', '#64d2ff', '#ffd60a'];

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

function isAllDay(event) {
    const start = event.date, end = event.end;
    return start.getHours() === 0 && start.getMinutes() === 0 &&
        end.getHours() === 0 && end.getMinutes() === 0 && end - start >= 86400000 - 1000;
}

function colorFor(id) {
    // Event ids look like "<source uid>\n<component uid>..."; group by source.
    const source = String(id).split('\n')[0];
    let h = 0;
    for (const ch of source)
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
}

function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function toDateTime(date) {
    return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000));
}

var CalendarFeed = class CalendarFeed {
    constructor() {
        try {
            this._source = new ShellCalendar.DBusEventSource();
            this._changedId = this._source.connect('changed', () => this.emit('changed'));
        } catch (e) {
            logError(e, 'linux-notch: calendar unavailable');
            this._source = null;
        }
        this._request();
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._request();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // The whole current month (for the grid dots) plus the next week (for the list).
    _request() {
        if (!this._source)
            return;
        const today = startOfDay(new Date());
        this._day = today.getTime();
        this._begin = new Date(today.getFullYear(), today.getMonth(), 1);
        const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        const weekEnd = addDays(today, UPCOMING_DAYS + 1);
        this._end = monthEnd > weekEnd ? monthEnd : weekEnd;
        this._source.requestRange(this._begin, this._end);
        this.emit('changed');
    }

    _ensureToday() {
        if (this._source && startOfDay(new Date()).getTime() !== this._day)
            this._request();
    }

    _map(e) {
        return {
            id: e.id,
            summary: e.summary || 'Untitled',
            start: e.date,
            end: e.end,
            allDay: isAllDay(e),
            color: colorFor(e.id),
        };
    }

    // Events that have not ended yet, from now through the next week.
    upcoming() {
        if (!this._source)
            return [];
        this._ensureToday();
        const now = new Date();
        const until = addDays(startOfDay(now), UPCOMING_DAYS + 1);
        return this._source.getEvents(now, until).filter(e => e.end > now).map(e => this._map(e));
    }

    hasEvents(day) {
        if (!this._source)
            return false;
        return this._source.getEvents(startOfDay(day), addDays(startOfDay(day), 1)).length > 0;
    }

    // The timed event that is about to start or has just started, for the live activity.
    soon() {
        const now = Date.now();
        return this.upcoming().find(e => !e.allDay &&
            e.start - now <= SOON_MS && now - e.start <= JUST_STARTED_MS) ?? null;
    }

    destroy() {
        GLib.source_remove(this._refreshId);
        if (this._source) {
            this._source.disconnect(this._changedId);
            this._source.destroy();
        }
        this.disconnectAll();
    }
};
Signals.addSignalMethods(CalendarFeed.prototype);

var CalendarPage = class CalendarPage {
    constructor(feed, interfaceSettings) {
        this._feed = feed;
        this._settings = interfaceSettings;

        this.actor = new St.BoxLayout({ style_class: 'ln-calendar', x_expand: true, y_expand: true });

        // left: today header + upcoming events
        const left = new St.BoxLayout({ style_class: 'ln-cal-left', vertical: true, x_expand: true });
        const header = new St.BoxLayout({ style_class: 'ln-cal-header' });
        this._weekday = new St.Label({ style_class: 'ln-cal-weekday' });
        this._day = new St.Label({ style_class: 'ln-cal-day' });
        this._week = new St.Label({ style_class: 'ln-cal-week' });
        header.add_child(this._weekday);
        header.add_child(this._day);
        header.add_child(this._week);

        this._list = new St.BoxLayout({ style_class: 'ln-cal-list', vertical: true, x_expand: true });
        const scroll = new St.ScrollView({
            style_class: 'ln-cal-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scroll.add_actor(this._list);
        left.add_child(header);
        left.add_child(scroll);

        // right: month grid
        const right = new St.BoxLayout({ style_class: 'ln-cal-right', vertical: true });
        this._month = new St.Label({ style_class: 'ln-cal-month', x_align: Clutter.ActorAlign.END });
        this._grid = new St.Widget({ style_class: 'ln-cal-grid', layout_manager: new Clutter.GridLayout({ row_spacing: 2, column_spacing: 4 }) });
        right.add_child(this._month);
        right.add_child(this._grid);

        this.actor.add_child(left);
        this.actor.add_child(right);

        this._feedId = feed.connect('changed', () => this.refresh());
        this.refresh();
    }

    refresh() {
        const now = GLib.DateTime.new_now_local();
        this._weekday.text = now.format('%a').toUpperCase();
        this._day.text = String(now.get_day_of_month());
        this._week.text = `W${now.get_week_of_year()}`;
        this._month.text = now.format('%b').toUpperCase();
        this._renderList();
        this._renderGrid(new Date());
    }

    _renderList() {
        this._list.destroy_all_children();
        const events = this._feed.upcoming();
        if (events.length === 0) {
            this._list.add_child(new St.Label({ style_class: 'ln-cal-empty', text: 'No upcoming events' }));
            return;
        }

        const twelveHour = this._settings.get_string('clock-format') === '12h';
        const timeFormat = twelveHour ? '%l:%M %p' : '%H:%M';
        const today = startOfDay(new Date()).getTime();
        let lastDay = today;

        for (const e of events) {
            const day = Math.max(startOfDay(e.start).getTime(), today);
            if (day !== lastDay) {
                this._list.add_child(new St.Label({
                    style_class: 'ln-cal-dayhead',
                    text: toDateTime(new Date(day)).format('%a, %b %-d').toUpperCase(),
                }));
                lastDay = day;
            }

            const card = new St.BoxLayout({ style_class: 'ln-cal-card', style: `background-color: ${rgba(e.color, 0.18)};` });
            card.add_child(new St.Widget({ style_class: 'ln-cal-bar', style: `background-color: ${e.color};` }));
            const text = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            const title = new St.Label({ style_class: 'ln-cal-title', text: e.summary, style: `color: ${e.color};` });
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const when = e.allDay ? 'All day'
                : `${toDateTime(e.start).format(timeFormat).trim()} – ${toDateTime(e.end).format(timeFormat).trim()}`;
            text.add_child(title);
            text.add_child(new St.Label({ style_class: 'ln-cal-time', text: when }));
            card.add_child(text);

            const nowMs = Date.now();
            if (!e.allDay && e.start <= nowMs && e.end > nowMs)
                card.add_child(new St.Label({ style_class: 'ln-cal-now', text: 'Now', y_align: Clutter.ActorAlign.CENTER }));
            this._list.add_child(card);
        }
    }

    // Monday-first month grid; today in a red circle, a dot under days with events.
    _renderGrid(today) {
        this._grid.destroy_all_children();
        const layout = this._grid.layout_manager;
        ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d, col) => {
            const label = new St.Label({ style_class: 'ln-cal-dow', text: d, x_align: Clutter.ActorAlign.CENTER });
            if (col >= 5)
                label.add_style_class_name('weekend');
            layout.attach(label, col, 0, 1, 1);
        });

        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const offset = (first.getDay() + 6) % 7;
        for (let d = 1; d <= days; d++) {
            const date = new Date(today.getFullYear(), today.getMonth(), d);
            const index = offset + d - 1;
            const col = index % 7;
            const cell = new St.BoxLayout({ style_class: 'ln-cal-cell', vertical: true });
            const label = new St.Label({ style_class: 'ln-cal-num', text: String(d), x_align: Clutter.ActorAlign.CENTER });
            if (col >= 5)
                label.add_style_class_name('weekend');
            if (d === today.getDate())
                label.add_style_class_name('today');
            const dot = new St.Widget({ style_class: 'ln-cal-dot', x_align: Clutter.ActorAlign.CENTER });
            dot.opacity = d !== today.getDate() && this._feed.hasEvents(date) ? 255 : 0;
            cell.add_child(label);
            cell.add_child(dot);
            layout.attach(cell, col, 1 + Math.floor(index / 7), 1, 1);
        }
    }

    destroy() {
        this._feed.disconnect(this._feedId);
        this.actor.destroy();
    }
};
