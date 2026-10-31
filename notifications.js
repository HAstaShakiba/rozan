/* exported NotificationsFeed, NotificationsPage */
// Notifications come from GNOME Shell's own message tray, so everything that shows up
// in the date menu's list (apps, the notification daemon, system messages) is here too.
// Dismissing or clearing here removes it from GNOME as well.
const { St, Clutter, GLib, Pango } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const MAX_ITEMS = 30;

function plainText(text, markup) {
    if (!text)
        return '';
    const flat = text.replace(/\s*\n\s*/g, ' ').trim();
    if (!markup)
        return flat;
    return flat.replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function relativeTime(datetime, twelveHour) {
    if (!datetime)
        return '';
    const now = GLib.DateTime.new_now_local();
    const mins = Math.floor(now.difference(datetime) / GLib.TIME_SPAN_MINUTE);
    if (mins < 1)
        return 'now';
    if (mins < 60)
        return `${mins}m`;
    if (now.get_day_of_year() === datetime.get_day_of_year() && now.get_year() === datetime.get_year())
        return datetime.format(twelveHour ? '%l:%M %p' : '%H:%M').trim();
    return datetime.format('%b %-d');
}

// Tracks every message-tray source and its notifications.
// Signals: 'changed', 'shown' (notification) when one would pop a banner.
var NotificationsFeed = class NotificationsFeed {
    constructor() {
        this._sources = new Map();       // source -> [signal ids]
        this._notifications = new Map(); // notification -> [signal ids]
        const tray = Main.messageTray;
        this._trayIds = [
            tray.connect('source-added', (t, source) => this._addSource(source)),
            tray.connect('source-removed', (t, source) => this._removeSource(source)),
        ];
        for (const source of tray.getSources())
            this._addSource(source);
    }

    // Newest first.
    get items() {
        return [...this._notifications.keys()]
            .sort((a, b) => (b.datetime?.to_unix() ?? 0) - (a.datetime?.to_unix() ?? 0))
            .slice(0, MAX_ITEMS);
    }

    get count() {
        return this._notifications.size;
    }

    get unseenCount() {
        return [...this._notifications.keys()].filter(n => !n.acknowledged).length;
    }

    // GNOME's Do Not Disturb (the shell keeps it private, so read it defensively).
    get doNotDisturb() {
        return Boolean(Main.messageTray._busy);
    }

    markAllSeen() {
        for (const n of this._notifications.keys()) {
            if (!n.acknowledged)
                n.acknowledged = true;
        }
    }

    clear() {
        for (const n of [...this._notifications.keys()]) {
            if (!n.resident)
                n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        }
    }

    _addSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.set(source, [
            source.connect('notification-added', (s, n) => this._addNotification(n)),
            source.connect('notification-show', (s, n) => {
                if (!this.doNotDisturb)
                    this.emit('shown', n);
            }),
        ]);
        for (const n of source.notifications)
            this._addNotification(n);
    }

    _removeSource(source) {
        const ids = this._sources.get(source);
        if (!ids)
            return;
        ids.forEach(id => source.disconnect(id));
        this._sources.delete(source);
        for (const n of [...this._notifications.keys()]) {
            if (n.source === source)
                this._removeNotification(n);
        }
        this.emit('changed');
    }

    _addNotification(n) {
        if (this._notifications.has(n))
            return;
        this._notifications.set(n, [
            n.connect('destroy', () => this._removeNotification(n)),
            n.connect('updated', () => this.emit('changed')),
            n.connect('notify::acknowledged', () => this.emit('changed')),
        ]);
        this.emit('changed');
    }

    _removeNotification(n) {
        const ids = this._notifications.get(n);
        if (!ids)
            return;
        ids.forEach(id => n.disconnect(id));
        this._notifications.delete(n);
        this.emit('changed');
    }

    destroy() {
        for (const n of [...this._notifications.keys()])
            this._notifications.get(n).forEach(id => n.disconnect(id));
        this._notifications.clear();
        for (const [source, ids] of this._sources)
            ids.forEach(id => source.disconnect(id));
        this._sources.clear();
        this._trayIds.forEach(id => Main.messageTray.disconnect(id));
        this.disconnectAll();
    }
};
Signals.addSignalMethods(NotificationsFeed.prototype);

var NotificationsPage = class NotificationsPage {
    constructor(feed, interfaceSettings, { onActivate }) {
        this._feed = feed;
        this._settings = interfaceSettings;
        this._onActivate = onActivate;
        this._visible = false;

        this.actor = new St.BoxLayout({ style_class: 'ln-notifs', vertical: true, x_expand: true, y_expand: true });

        const header = new St.BoxLayout({ style_class: 'ln-notifs-header' });
        header.add_child(new St.Label({ style_class: 'ln-notifs-heading', text: 'NOTIFICATIONS', y_align: Clutter.ActorAlign.CENTER }));
        this._countLabel = new St.Label({ style_class: 'ln-notifs-count', y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._countLabel);
        header.add_child(new St.Widget({ x_expand: true }));
        this._dnd = new St.Label({ style_class: 'ln-notifs-dnd', text: 'Do Not Disturb', y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._dnd);
        const clearContent = new St.BoxLayout({ style_class: 'ln-pill-content' });
        clearContent.add_child(new St.Icon({ icon_name: 'edit-clear-all-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        clearContent.add_child(new St.Label({ text: 'Clear all', y_align: Clutter.ActorAlign.CENTER }));
        this._clearBtn = new St.Button({ style_class: 'ln-pill', child: clearContent });
        this._clearBtn.connect('clicked', () => this._feed.clear());
        header.add_child(this._clearBtn);

        this._list = new St.BoxLayout({ style_class: 'ln-notifs-list', vertical: true, x_expand: true });
        const scroll = new St.ScrollView({
            style_class: 'ln-notifs-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scroll.add_actor(this._list);

        this.actor.add_child(header);
        this.actor.add_child(scroll);

        this._feedId = this._feed.connect('changed', () => this._queueRender());
        this._render();
    }

    // Called by the notch when this page becomes visible or hidden.
    setVisible(visible) {
        this._visible = visible;
        if (visible) {
            this._render();
            this._feed.markAllSeen();
        }
    }

    _queueRender() {
        if (this._renderId)
            return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._renderId = 0;
            this._render();
            if (this._visible)
                this._feed.markAllSeen();
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        const items = this._feed.items;
        this._countLabel.text = items.length ? String(this._feed.count) : '';
        this._clearBtn.visible = items.length > 0;
        this._dnd.visible = this._feed.doNotDisturb;

        this._list.destroy_all_children();
        if (items.length === 0) {
            const empty = new St.BoxLayout({ style_class: 'ln-notifs-empty', vertical: true, x_expand: true });
            empty.add_child(new St.Icon({ icon_name: 'notifications-disabled-symbolic', icon_size: 26, x_align: Clutter.ActorAlign.CENTER }));
            empty.add_child(new St.Label({ text: 'No notifications', x_align: Clutter.ActorAlign.CENTER }));
            this._list.add_child(empty);
            return;
        }

        const twelveHour = this._settings.get_string('clock-format') === '12h';
        for (const n of items)
            this._list.add_child(this._card(n, twelveHour));
    }

    _card(n, twelveHour) {
        const card = new St.BoxLayout({ style_class: 'ln-notif-card', x_expand: true });

        let gicon = n.gicon;
        try {
            gicon ??= n.source?.getIcon();
        } catch (e) {
            gicon = null;
        }
        const icon = new St.Icon({ style_class: 'ln-notif-icon', icon_size: 28, y_align: Clutter.ActorAlign.CENTER });
        if (gicon)
            icon.gicon = gicon;
        else
            icon.icon_name = 'preferences-system-notifications-symbolic';

        const text = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const top = new St.BoxLayout({ style_class: 'ln-notif-top' });
        const app = new St.Label({ style_class: 'ln-notif-app', text: (n.source?.title ?? '').toUpperCase() });
        app.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        top.add_child(app);
        top.add_child(new St.Label({ style_class: 'ln-notif-time', text: relativeTime(n.datetime, twelveHour) }));
        const title = new St.Label({ style_class: 'ln-notif-title', text: plainText(n.title, false) });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(top);
        text.add_child(title);
        const bodyText = plainText(n.bannerBodyText, n.bannerBodyMarkup);
        if (bodyText) {
            const body = new St.Label({ style_class: 'ln-notif-body', text: bodyText });
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(body);
        }

        const open = new St.Button({ style_class: 'ln-notif-open', x_expand: true, child: new St.BoxLayout({ style_class: 'ln-notif-row' }) });
        open.child.add_child(icon);
        open.child.add_child(text);
        open.connect('clicked', () => {
            n.activate();
            this._onActivate?.();
        });
        card.add_child(open);

        const close = new St.Button({
            style_class: 'ln-notif-close',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 12 }),
        });
        close.connect('clicked', () => n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED));
        card.add_child(close);
        return card;
    }

    destroy() {
        if (this._renderId)
            GLib.source_remove(this._renderId);
        this._feed.disconnect(this._feedId);
        this.actor.destroy();
    }
};
