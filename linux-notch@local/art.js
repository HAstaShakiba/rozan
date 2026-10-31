/* exported loadArt */
// Resolves an MPRIS art URL to a local file URI. Remote art (for example Spotify's
// https URLs) is downloaded once with curl into the user cache directory.
// curl runs as a subprocess so the extension does not load libsoup, whose two
// major versions cannot coexist inside gnome-shell.
const { Gio, GLib } = imports.gi;

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'linux-notch', 'art']);

var loadArt = function (url, callback) {
    if (!url)
        return callback(null);
    if (url.startsWith('file://'))
        return callback(url);
    if (!/^https?:\/\//.test(url))
        return callback(null);

    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
    const file = Gio.File.new_for_path(GLib.build_filenamev([CACHE_DIR, name]));
    if (file.query_exists(null))
        return callback(file.get_uri());

    const part = Gio.File.new_for_path(`${file.get_path()}.part`);
    try {
        const proc = Gio.Subprocess.new(
            ['curl', '-sfL', '--max-time', '10', '--max-filesize', '10000000',
                '-o', part.get_path(), '--', url],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (p, res) => {
            try {
                p.wait_check_finish(res);
                part.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
                callback(file.get_uri());
            } catch (e) {
                callback(null);
            }
        });
    } catch (e) {
        logError(e, 'linux-notch: cannot start curl');
        callback(null);
    }
    return undefined;
};
