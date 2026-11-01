/* exported init, fillPreferencesWindow */
// Preferences: turn workspace tabs on or off and change their order.
// Changes are saved immediately; the notch picks them up without a restart.
const { Adw, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { TABS, loadTabs, saveTabs } = Me.imports.settings;

function init() {
}

function fillPreferencesWindow(window) {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        title: 'Tabs',
        description: 'Choose which workspaces appear in the notch, and their order. At least one stays on.',
    });
    page.add(group);
    window.add(page);
    window.set_default_size(460, 560);

    const info = new Map(TABS.map(([name, icon, label]) => [name, { icon, label }]));
    let tabs = loadTabs();
    let rows = [];

    const render = () => {
        for (const row of rows)
            group.remove(row);
        rows = tabs.map((tab, i) => {
            const row = new Adw.ActionRow({ title: info.get(tab.name).label });
            row.add_prefix(new Gtk.Image({ icon_name: info.get(tab.name).icon }));

            const move = (delta, iconName, tooltip) => {
                const button = new Gtk.Button({
                    icon_name: iconName,
                    tooltip_text: tooltip,
                    valign: Gtk.Align.CENTER,
                    sensitive: i + delta >= 0 && i + delta < tabs.length,
                });
                button.add_css_class('flat');
                button.connect('clicked', () => {
                    [tabs[i], tabs[i + delta]] = [tabs[i + delta], tabs[i]];
                    saveTabs(tabs);
                    render();
                });
                return button;
            };
            row.add_suffix(move(-1, 'go-up-symbolic', 'Move up'));
            row.add_suffix(move(1, 'go-down-symbolic', 'Move down'));

            const toggle = new Gtk.Switch({
                active: tab.enabled,
                valign: Gtk.Align.CENTER,
                // the last enabled tab cannot be turned off
                sensitive: !tab.enabled || tabs.filter(t => t.enabled).length > 1,
            });
            toggle.connect('notify::active', () => {
                tab.enabled = toggle.active;
                saveTabs(tabs);
                render();
            });
            row.add_suffix(toggle);
            row.activatable_widget = toggle;

            group.add(row);
            return row;
        });
    };
    render();

    const reset = new Gtk.Button({ label: 'Reset to default', halign: Gtk.Align.END, margin_top: 12 });
    reset.connect('clicked', () => {
        tabs = TABS.map(([name]) => ({ name, enabled: true }));
        saveTabs(tabs);
        render();
    });
    const resetGroup = new Adw.PreferencesGroup();
    resetGroup.add(reset);
    page.add(resetGroup);
}
