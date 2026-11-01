/* exported TABS, loadTabs, saveTabs, SETTINGS_PATH */
// User settings shared by the shell and the preferences window, kept in their own file
// (~/.local/share/rozan/settings.json) so the two processes never overwrite each other's
// state.json. Right now this is only which workspace tabs are shown and in what order.
const { Gio, GLib } = imports.gi;

const DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'rozan']);
var SETTINGS_PATH = GLib.build_filenamev([DIR, 'settings.json']);

// Every workspace, in its default order: [name, icon, label].
var TABS = [
    ['notifications', 'preferences-system-notifications-symbolic', 'Notifications'],
    ['nook', 'view-app-grid-symbolic', 'Nook'],
    ['music', 'media-playback-start-symbolic', 'Music'],
    ['calendar', 'x-office-calendar-symbolic', 'Calendar'],
    ['tray', 'mail-inbox-symbolic', 'Tray'],
    ['prompter', 'format-justify-left-symbolic', 'Prompter'],
    ['agents', 'emoji-symbols-symbolic', 'Agents'],
];

function readSettings() {
    try {
        const [ok, bytes] = GLib.file_get_contents(SETTINGS_PATH);
        if (ok)
            return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
            log(`rozan: cannot read ${SETTINGS_PATH}: ${e.message}`);
    }
    return {};
}

// Returns every tab as { name, enabled }, in the user's order. Unknown names are dropped,
// tabs missing from the file (added in a later version) are appended enabled, and at least
// one tab is always enabled.
function loadTabs() {
    const known = new Set(TABS.map(([name]) => name));
    const saved = readSettings().tabs;
    const tabs = [];
    for (const t of Array.isArray(saved) ? saved : []) {
        if (t && known.has(t.name) && !tabs.some(x => x.name === t.name))
            tabs.push({ name: t.name, enabled: t.enabled !== false });
    }
    for (const [name] of TABS) {
        if (!tabs.some(t => t.name === name))
            tabs.push({ name, enabled: true });
    }
    if (!tabs.some(t => t.enabled))
        tabs[0].enabled = true;
    return tabs;
}

function saveTabs(tabs) {
    const data = readSettings();
    data.tabs = tabs.map(({ name, enabled }) => ({ name, enabled }));
    GLib.mkdir_with_parents(DIR, 0o700);
    Gio.File.new_for_path(SETTINGS_PATH).replace_contents(
        new TextEncoder().encode(JSON.stringify(data, null, 1)),
        null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
