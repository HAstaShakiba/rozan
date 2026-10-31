/* exported init */
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { Notch } = Me.imports.notch;

class Extension {
    enable() {
        this._notch = new Notch();
    }

    disable() {
        this._notch?.destroy();
        this._notch = null;
    }
}

function init() {
    return new Extension();
}
