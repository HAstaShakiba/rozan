/* exported MprisManager */
// Tracks MPRIS media players on the session bus and picks the one the notch follows.
const { Gio, GLib } = imports.gi;
const Signals = imports.signals;

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE_NAME = 'org.mpris.MediaPlayer2.Player';
// playerctld re-exports other players; following it would duplicate them.
const IGNORED = new Set(['org.mpris.MediaPlayer2.playerctld']);

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg type="o" direction="in"/>
      <arg type="x" direction="in"/>
    </method>
    <signal name="Seeked"><arg type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="Shuffle" type="b" access="readwrite"/>
  </interface>
</node>`;
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_IFACE);

const ignoreResult = () => {};

class Player {
    constructor(busName, onChange) {
        this.busName = busName;
        this.lastActive = 0;
        this._onChange = onChange;
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();

        const suffix = busName.slice(MPRIS_PREFIX.length).split('.')[0];
        this.busSuffix = suffix;
        this.sourceName = suffix.charAt(0).toUpperCase() + suffix.slice(1);
        this.desktopEntry = null;
        this._getRootProperty('DesktopEntry', v => {
            this.desktopEntry = v;
            this._onChange(this);
        });
        this._getRootProperty('Identity', v => {
            this.sourceName = v;
            this._onChange(this);
        });

        PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    log(`linux-notch: cannot connect to ${busName}: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            this._propsId = proxy.connect('g-properties-changed', () => this._changed());
            this._seekedId = proxy.connectSignal('Seeked', () => this._onChange(this));
            this._changed();
        }, this._cancellable, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES);
    }

    _getRootProperty(name, callback) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', name]),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, this._cancellable,
            (conn, res) => {
                try {
                    const [value] = conn.call_finish(res).recursiveUnpack();
                    if (value)
                        callback(value);
                } catch (e) {
                    // Optional property; many players omit it.
                }
            });
    }

    _changed() {
        if (this.isPlaying)
            this.lastActive = Date.now();
        this._onChange(this);
    }

    _prop(name) {
        const v = this._proxy?.get_cached_property(name);
        return v ? v.recursiveUnpack() : null;
    }

    get ready() { return this._proxy !== null; }
    get status() { return this._prop('PlaybackStatus') ?? 'Stopped'; }
    get isPlaying() { return this.status === 'Playing'; }
    get metadata() { return this._prop('Metadata') ?? {}; }
    get title() { return this.metadata['xesam:title'] ?? ''; }
    get artUrl() { return this.metadata['mpris:artUrl'] || null; }
    get length() { return Number(this.metadata['mpris:length'] ?? 0); }
    get trackId() { return this.metadata['mpris:trackid'] ?? null; }
    get canGoNext() { return Boolean(this._prop('CanGoNext')); }
    get canGoPrevious() { return Boolean(this._prop('CanGoPrevious')); }
    // null when the player does not support shuffle
    get shuffle() { return this._prop('Shuffle'); }
    get canSeek() { return Boolean(this._prop('CanSeek')) && this.length > 0; }

    get artist() {
        const a = this.metadata['xesam:artist'];
        return Array.isArray(a) ? a.join(', ') : (a ?? '');
    }

    playPause() { this._proxy?.PlayPauseRemote(ignoreResult); }
    next() { this._proxy?.NextRemote(ignoreResult); }
    previous() { this._proxy?.PreviousRemote(ignoreResult); }

    setShuffle(value) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE_NAME, 'Shuffle', new GLib.Variant('b', value)]),
            null, Gio.DBusCallFlags.NONE, 1000, this._cancellable, ignoreResult);
    }

    setPosition(us) {
        if (this._proxy && this.trackId)
            this._proxy.SetPositionRemote(this.trackId, Math.max(0, Math.round(us)), ignoreResult);
    }

    // Position is not announced through PropertiesChanged, so it is read on demand.
    getPosition(callback) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE_NAME, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1000, this._cancellable,
            (conn, res) => {
                try {
                    const [pos] = conn.call_finish(res).recursiveUnpack();
                    callback(Number(pos));
                } catch (e) {
                    callback(null);
                }
            });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            this._proxy.disconnect(this._propsId);
            this._proxy.disconnectSignal(this._seekedId);
            this._proxy = null;
        }
    }
}

var MprisManager = class MprisManager {
    constructor() {
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();
        this._idleId = 0;

        this._ownerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'linux-notch: ListNames failed');
                }
            });
    }

    _add(name) {
        if (IGNORED.has(name) || this._players.has(name))
            return;
        this._players.set(name, new Player(name, () => this._queueChanged()));
    }

    _remove(name) {
        const p = this._players.get(name);
        if (!p)
            return;
        p.destroy();
        this._players.delete(name);
        this._queueChanged();
    }

    // Players often send several property changes in a row; emit once per main-loop pass.
    _queueChanged() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    // Prefer a playing player (most recently started first), then the most recently active one.
    get activePlayer() {
        const ready = [...this._players.values()].filter(p => p.ready && p.title);
        if (ready.length === 0)
            return null;
        const playing = ready.filter(p => p.isPlaying);
        const pool = playing.length > 0 ? playing : ready;
        return pool.reduce((a, b) => (b.lastActive > a.lastActive ? b : a));
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._players.forEach(p => p.destroy());
        this._players.clear();
        this.disconnectAll();
    }
};
Signals.addSignalMethods(MprisManager.prototype);
