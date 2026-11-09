// Shared tunnel config + systemd helpers. Used by both the shell extension and prefs,
// so it may only import GLib/Gio (no Shell or Gtk modules).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const UNIT_TEMPLATE_NAME = 'iap-tunnel@.service';
export const RUNNER_NAME = 'iap-tunnel-run';
/** Exit status of iap-tunnel-run when the Google sign-in expired. */
export const EXIT_AUTH = 75;
const MANAGED_MARKER = '# Managed by the IAP Tunnels GNOME extension';

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const KEYS = ['LABEL', 'PROJECT', 'ZONE', 'INSTANCE', 'REMOTE_PORT', 'LOCAL_PORT', 'ACCOUNT', 'EXTRA_ARGS'];
const REQUIRED = ['PROJECT', 'ZONE', 'INSTANCE', 'REMOTE_PORT', 'LOCAL_PORT'];

export const configDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'iap-tunnels']);
export const unitDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user']);
// Matches %D/iap-tunnels in the unit (XDG_DATA_HOME of the user manager).
export const runnerPath = () => GLib.build_filenamev([GLib.get_user_data_dir(), 'iap-tunnels', RUNNER_NAME]);
const stateFile = () => GLib.build_filenamev([GLib.get_user_state_dir(), 'iap-tunnels', 'last-used']);

export const unitName = id => `iap-tunnel@${id}.service`;

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function writeText(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
}

/** Parse a systemd EnvironmentFile (KEY=VALUE, optional quotes, # comments). */
export function parseEnv(text) {
    const out = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';'))
            continue;
        const eq = line.indexOf('=');
        if (eq < 1)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"')
            value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
        else if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'")
            value = value.slice(1, -1);
        out[key] = value;
    }
    return out;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Write known keys first, then any other environment variables the file already had
 * (e.g. CLOUDSDK_PYTHON added by hand), so saving from the UI never drops them.
 * Lower-case properties (id, label) are runtime fields and are not written.
 */
export function serializeEnv(data) {
    const lines = ['# IAP tunnel, edited by the IAP Tunnels GNOME extension'];
    const extra = Object.keys(data).filter(k => ENV_NAME.test(k) && !KEYS.includes(k)).sort();
    for (const key of [...KEYS, ...extra]) {
        const value = String(data[key] ?? '').trim();
        if (value !== '' && !/[\n\r]/.test(value))
            lines.push(`${key}="${value.replace(/(["\\])/g, '\\$1')}"`);
    }
    return `${lines.join('\n')}\n`;
}

/** Turn a display name into a valid tunnel id. */
export function slugify(text) {
    return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 63);
}

/** @returns {string|null} an error message, or null when valid */
export function validate(id, data, existing = []) {
    if (!ID_PATTERN.test(id ?? ''))
        return 'ID must be lowercase letters, digits and dashes, starting with a letter or digit.';
    for (const key of KEYS) {
        if (/[\n\r]/.test(String(data[key] ?? '')))
            return `${key} must not contain line breaks.`;
    }
    for (const key of REQUIRED) {
        if (String(data[key] ?? '').trim() === '')
            return `${key.replace('_', ' ').toLowerCase()} is required.`;
    }
    const account = String(data.ACCOUNT ?? '').trim();
    if (account && !/^[^\s@]+@[^\s@]+$/.test(account))
        return 'account must be an email address (or empty for the active gcloud account).';
    for (const key of ['PROJECT', 'ZONE', 'INSTANCE']) {
        if (!/^[a-z0-9][a-z0-9.:-]*$/.test(String(data[key]).trim()))
            return `${key.toLowerCase()} contains invalid characters.`;
    }
    for (const key of ['REMOTE_PORT', 'LOCAL_PORT']) {
        const port = Number(data[key]);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            return `${key.replace('_', ' ').toLowerCase()} must be a number between 1 and 65535.`;
    }
    const clash = existing.find(t => t.id !== id && Number(t.LOCAL_PORT) === Number(data.LOCAL_PORT));
    if (clash)
        return `Local port ${data.LOCAL_PORT} is already used by “${clash.label}”.`;
    return null;
}

/** @returns {Array<{id: string, label: string}>} tunnels sorted by label */
export function listTunnels() {
    const dir = Gio.File.new_for_path(configDir());
    const tunnels = [];
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return tunnels;
    }
    for (let info; (info = enumerator.next_file(null));) {
        const name = info.get_name();
        if (!name.endsWith('.env'))
            continue;
        const id = name.slice(0, -4);
        if (!ID_PATTERN.test(id))
            continue;
        const text = readText(GLib.build_filenamev([configDir(), name]));
        if (text === null)
            continue;
        const data = parseEnv(text);
        tunnels.push({...data, id, label: data.LABEL || id});
    }
    enumerator.close(null);
    return tunnels.sort((a, b) => a.label.localeCompare(b.label));
}

export function saveTunnel(id, data) {
    writeText(GLib.build_filenamev([configDir(), `${id}.env`]), serializeEnv(data));
}

export function deleteTunnel(id) {
    try {
        Gio.File.new_for_path(GLib.build_filenamev([configDir(), `${id}.env`])).delete(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }
}

/** Watch the config dir; returns the monitor (call .cancel() to stop). */
export function monitorConfig(callback) {
    GLib.mkdir_with_parents(configDir(), 0o755);
    const monitor = Gio.File.new_for_path(configDir())
        .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
    monitor.connect('changed', () => callback());
    return monitor;
}

const isManaged = text => text.split('\n', 3).some(line => line.startsWith(MANAGED_MARKER));

/**
 * Copy a bundled file to target unless the target was customised (no managed marker).
 * @returns {boolean} true when the target changed
 */
function installManaged(source, target, executable) {
    const wanted = readText(source);
    if (wanted === null)
        throw new Error(`Bundled file ${source} not found`);
    const current = readText(target);
    if (current === wanted || (current !== null && !isManaged(current)))
        return false;
    writeText(target, wanted);
    if (executable) {
        Gio.File.new_for_path(target).set_attribute_uint32('unix::mode', 0o755,
            Gio.FileQueryInfoFlags.NONE, null);
    }
    return true;
}

/**
 * Install or update the systemd template unit and the tunnel runner script from the
 * extension's bundled copies. Customised files (managed marker removed) are left alone.
 * @returns {boolean} true when the unit changed (a daemon-reload is needed)
 */
export function ensureBackend(extensionPath) {
    const bundled = name => GLib.build_filenamev([extensionPath, 'systemd', name]);
    installManaged(bundled(RUNNER_NAME), runnerPath(), true);
    return installManaged(bundled(UNIT_TEMPLATE_NAME),
        GLib.build_filenamev([unitDir(), UNIT_TEMPLATE_NAME]), false);
}

export function isAutostart(id) {
    return GLib.file_test(
        GLib.build_filenamev([unitDir(), 'default.target.wants', unitName(id)]),
        GLib.FileTest.EXISTS);
}

export function getLastUsed() {
    return readText(stateFile())?.trim() || null;
}

export function setLastUsed(id) {
    try {
        writeText(stateFile(), `${id}\n`);
    } catch (e) {
        console.warn(`iap-tunnels: cannot save last used tunnel: ${e.message}`);
    }
}

/** Run a command; resolves to {ok, stdout, stderr}. */
export async function run(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    return {ok: proc.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''};
}

export const systemctl = (...args) => run(['systemctl', '--user', ...args]);
