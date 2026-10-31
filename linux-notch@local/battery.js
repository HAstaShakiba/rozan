/* exported BatteryMonitor */
// Watches the UPower display device and reports plug/unplug and low-battery moments.
const { Gio } = imports.gi;
const Signals = imports.signals;
const { loadInterfaceXML } = imports.misc.fileUtils;

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));

// UPower.DeviceState
const STATE = { CHARGING: 1, DISCHARGING: 2, EMPTY: 3, FULLY_CHARGED: 4, PENDING_CHARGE: 5, PENDING_DISCHARGE: 6 };
const LOW_LEVELS = [20, 10, 5];

var BatteryMonitor = class BatteryMonitor {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._lastState = null;
        this._lastPercent = null;

        DeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (proxy, error) => {
                if (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`linux-notch: UPower unavailable: ${error.message}`);
                    return;
                }
                this._proxy = proxy;
                this._lastState = proxy.State;
                this._lastPercent = proxy.Percentage;
                this._propsId = proxy.connect('g-properties-changed', () => this._onChanged());
            }, this._cancellable);
    }

    get present() { return Boolean(this._proxy?.IsPresent); }
    get percent() { return Math.round(this._proxy?.Percentage ?? 0); }
    get iconName() { return this._proxy?.IconName || 'battery-symbolic'; }
    get charging() {
        const s = this._proxy?.State;
        return s === STATE.CHARGING || s === STATE.FULLY_CHARGED || s === STATE.PENDING_CHARGE;
    }

    _onChanged() {
        if (!this.present)
            return;
        const state = this._proxy.State;
        const percent = this._proxy.Percentage;

        const wasCharging = [STATE.CHARGING, STATE.FULLY_CHARGED, STATE.PENDING_CHARGE].includes(this._lastState);
        if (this._lastState !== null && state !== this._lastState && wasCharging !== this.charging)
            this.emit('event', this.charging ? 'Charging' : 'On battery');
        else if (state === STATE.DISCHARGING && this._lastPercent !== null &&
                 LOW_LEVELS.some(l => this._lastPercent > l && percent <= l))
            this.emit('event', 'Low battery');

        this._lastState = state;
        this._lastPercent = percent;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy)
            this._proxy.disconnect(this._propsId);
        this._proxy = null;
        this.disconnectAll();
    }
};
Signals.addSignalMethods(BatteryMonitor.prototype);
