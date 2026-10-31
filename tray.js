/* exported TrayPage */
// "Files Tray" workspace: a shelf of file references kept in the notch.
//
// GNOME Shell 42 cannot receive drag-and-drop from Wayland apps, so files are
// added by copying them in Files (Ctrl+C) and pressing Paste here; to get a file
// back out, use Copy and paste it into the target app. Left click opens a file.
const { St, Clutter, Gio, GLib, Pango } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

const COPIED_FILES = 'x-special/gnome-copied-files';
const URI_LIST = 'text/uri-list';

// A rounded rectangle with a dashed outline, like NotchNook's empty tray.
function makeDashedBox() {
    const area = new St.DrawingArea({ x_expand: true, y_expand: true });
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const r = 18, inset = 1.5;
        cr.newSubPath();
        cr.arc(w - r - inset, r + inset, r, -Math.PI / 2, 0);
        cr.arc(w - r - inset, h - r - inset, r, 0, Math.PI / 2);
        cr.arc(r + inset, h - r - inset, r, Math.PI / 2, Math.PI);
        cr.arc(r + inset, r + inset, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.setSourceRGBA(1, 1, 1, 0.16);
        cr.setLineWidth(1.6);
        cr.setDash([6, 5], 0);
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

function decode(bytes) {
    const data = bytes?.get_data ? bytes.get_data() : bytes;
    return data ? new TextDecoder().decode(data) : '';
}

var TrayPage = class TrayPage {
    constructor(store) {
        this._store = store;
        this._uris = store.get('tray', []).filter(uri => Gio.File.new_for_uri(uri).query_exists(null));
        this._clipboard = St.Clipboard.get_default();

        this.actor = new St.BoxLayout({ style_class: 'ln-tray', x_expand: true, y_expand: true });
        this._frame = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });
        this._frame.add_child(makeDashedBox());

        // empty state
        this._emptyBox = new St.BoxLayout({ vertical: true, style_class: 'ln-tray-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._emptyBox.add_child(new St.Icon({ icon_name: 'mail-inbox-symbolic', icon_size: 20, x_align: Clutter.ActorAlign.CENTER }));
        this._emptyBox.add_child(new St.Label({ text: 'Files Tray', style_class: 'ln-tray-title', x_align: Clutter.ActorAlign.CENTER }));
        this._emptyBox.add_child(new St.Label({ text: 'Copy files in Files, then press Paste', style_class: 'ln-tray-hint', x_align: Clutter.ActorAlign.CENTER }));

        // file shelf
        this._shelf = new St.BoxLayout({ style_class: 'ln-tray-shelf' });
        this._scroll = new St.ScrollView({
            style_class: 'ln-tray-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_actor(this._shelf);

        // actions in a column to the right of the frame
        const actions = new St.BoxLayout({ style_class: 'ln-tray-actions', vertical: true, y_align: Clutter.ActorAlign.CENTER });
        this._pasteBtn = this._pill('edit-paste-symbolic', 'Paste', () => this._paste());
        this._clearBtn = this._pill('user-trash-symbolic', 'Clear', () => this._setUris([]));
        actions.add_child(this._pasteBtn);
        actions.add_child(this._clearBtn);

        this._frame.add_child(this._emptyBox);
        this._frame.add_child(this._scroll);
        this.actor.add_child(this._frame);
        this.actor.add_child(actions);

        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._render();
    }

    _pill(iconName, text, onClick) {
        const content = new St.BoxLayout({ style_class: 'ln-pill-content' });
        content.add_child(new St.Icon({ icon_name: iconName, icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        content.add_child(new St.Label({ text, y_align: Clutter.ActorAlign.CENTER }));
        const b = new St.Button({ style_class: 'ln-pill', child: content });
        b.connect('clicked', onClick);
        return b;
    }

    _setUris(uris) {
        this._uris = [...new Set(uris)];
        this._store.set('tray', this._uris);
        this._render();
    }

    addUris(uris) {
        this._setUris([...this._uris, ...uris]);
    }

    _paste() {
        const types = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        const type = types.includes(COPIED_FILES) ? COPIED_FILES : types.includes(URI_LIST) ? URI_LIST : null;
        if (!type) {
            Main.notify('Files Tray', 'The clipboard has no files. Copy files in Files first.');
            return;
        }
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, type, (clip, bytes) => {
            const lines = decode(bytes).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const uris = lines.filter(l => /^[a-z][a-z0-9+.-]*:\/\//i.test(l));
            if (uris.length)
                this.addUris(uris);
        });
    }

    _copy(uris) {
        const payload = `copy\n${uris.join('\n')}`;
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, COPIED_FILES, new GLib.Bytes(new TextEncoder().encode(payload)));
    }

    _open(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notify('Files Tray', e.message);
        }
    }

    _showInFolder(uri) {
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _render() {
        this._shelf.destroy_all_children();
        const empty = this._uris.length === 0;
        this._emptyBox.visible = empty;
        this._scroll.visible = !empty;
        this._clearBtn.visible = !empty;
        for (const uri of this._uris)
            this._shelf.add_child(this._makeTile(uri));
    }

    _makeTile(uri) {
        const file = Gio.File.new_for_uri(uri);
        let info = null;
        try {
            info = file.query_info('standard::display-name,standard::icon,standard::content-type,thumbnail::path',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            // shown with a generic icon
        }
        const name = info?.get_display_name() ?? file.get_basename();
        const type = info?.get_content_type() ?? '';
        const thumb = info?.get_attribute_byte_string('thumbnail::path');

        const box = new St.BoxLayout({ vertical: true, style_class: 'ln-tile-file' });
        const preview = new St.Bin({ style_class: 'ln-file-preview', x_align: Clutter.ActorAlign.CENTER });
        const imagePath = thumb || (type.startsWith('image/') ? file.get_path() : null);
        if (imagePath) {
            preview.add_style_class_name('image');
            preview.style = `background-image: url("${Gio.File.new_for_path(imagePath).get_uri()}");`;
        } else {
            preview.child = new St.Icon({ gicon: info?.get_icon() ?? new Gio.ThemedIcon({ name: 'text-x-generic' }), icon_size: 40 });
        }
        const label = new St.Label({ text: name, style_class: 'ln-file-name', x_align: Clutter.ActorAlign.CENTER });
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(preview);
        box.add_child(label);

        const button = new St.Button({ style_class: 'ln-file', child: box, button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE });
        button.connect('clicked', (b, mouse) => {
            if (mouse === 3)
                this._openMenu(button, uri);
            else
                this._open(uri);
        });
        return button;
    }

    _openMenu(source, uri) {
        this._menu?.destroy();
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        menu.addAction('Open', () => this._open(uri));
        menu.addAction('Copy', () => this._copy([uri]));
        menu.addAction('Show in Files', () => this._showInFolder(uri));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Remove from Tray', () => this._setUris(this._uris.filter(u => u !== uri)));
        Main.uiGroup.add_actor(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (m, open) => {
            this.emit('busy', open);
            if (!open) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._menu === menu) {
                        menu.destroy();
                        this._menu = null;
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        this._menu = menu;
        menu.open();
    }

    destroy() {
        this._menu?.destroy();
        this.actor.destroy();
    }
};
Signals.addSignalMethods(TrayPage.prototype);
