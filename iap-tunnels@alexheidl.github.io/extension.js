import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Tunnels from './lib/tunnels.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const SD_BUS = 'org.freedesktop.systemd1';
const SD_PATH = '/org/freedesktop/systemd1';
const SD_MANAGER = 'org.freedesktop.systemd1.Manager';
const SD_UNIT = 'org.freedesktop.systemd1.Unit';
const SD_SERVICE = 'org.freedesktop.systemd1.Service';
const DBUS_PROPS = 'org.freedesktop.DBus.Properties';

/** Thin async wrapper around the systemd user manager on the session bus. */
class SystemdUser {
    constructor() {
        this._bus = Gio.DBus.session;
    }

    _call(path, iface, method, params = null, replyType = null) {
        return this._bus.call(SD_BUS, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null);
    }

    _manager(method, params, replyType) {
        return this._call(SD_PATH, SD_MANAGER, method, params, replyType);
    }

    async subscribe() {
        try {
            await this._manager('Subscribe');
        } catch (e) {
            // AlreadySubscribed is fine (e.g. after re-enabling the extension).
            if (!String(e.message).includes('AlreadySubscribed'))
                throw e;
        }
    }

    reload() {
        return this._manager('Reload');
    }

    async loadUnit(name) {
        const reply = await this._manager('LoadUnit', new GLib.Variant('(s)', [name]), '(o)');
        return reply.deepUnpack()[0];
    }

    async getState(path) {
        const reply = await this._call(path, DBUS_PROPS, 'GetAll',
            new GLib.Variant('(s)', [SD_UNIT]), '(a{sv})');
        const [props] = reply.deepUnpack();
        return {active: props.ActiveState.unpack(), sub: props.SubState.unpack()};
    }

    /** Exit status of the service's main process (last run). */
    async getExitStatus(path) {
        const reply = await this._call(path, DBUS_PROPS, 'Get',
            new GLib.Variant('(ss)', [SD_SERVICE, 'ExecMainStatus']), '(v)');
        return reply.deepUnpack()[0].unpack();
    }

    start(name) {
        return this._manager('StartUnit', new GLib.Variant('(ss)', [name, 'replace']), '(o)');
    }

    stop(name) {
        return this._manager('StopUnit', new GLib.Variant('(ss)', [name, 'replace']), '(o)');
    }

    async resetFailed(name) {
        try {
            await this._manager('ResetFailedUnit', new GLib.Variant('(s)', [name]));
        } catch {
            // Not failed / not loaded: nothing to reset.
        }
    }

    watch(path, callback) {
        return this._bus.signal_subscribe(SD_BUS, DBUS_PROPS, 'PropertiesChanged', path, null,
            Gio.DBusSignalFlags.NONE, (_conn, _sender, _path, _iface, _signal, params) => {
                const [iface, changed] = params.deepUnpack();
                if (iface === SD_UNIT)
                    callback(changed);
            });
    }

    unwatch(id) {
        this._bus.signal_unsubscribe(id);
    }
}

const isUp = state => ['active', 'activating', 'reloading'].includes(state.active);

function describe(tunnel, state) {
    const target = `localhost:${tunnel.LOCAL_PORT} → ${tunnel.INSTANCE}:${tunnel.REMOTE_PORT}`;
    switch (state.active) {
    case 'active':
    case 'reloading':
        return [_('Connected · %s').format(target), false];
    case 'activating':
        return [state.sub === 'auto-restart' ? _('Reconnecting…') : _('Connecting…'), false];
    case 'deactivating':
        return [_('Disconnecting…'), false];
    case 'failed':
        return state.authExpired
            ? [_('Sign-in expired · click to sign in'), true]
            : [_('Failed · click to retry'), true];
    default:
        return [target, false];
    }
}

const TunnelItem = GObject.registerClass({
    Signals: {'toggle': {}},
}, class TunnelItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({style_class: 'iap-tunnel-item'});

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'iap-tunnel-title'});
        this._detail = new St.Label({style_class: 'iap-tunnel-detail', opacity: 200});
        box.add_child(this._title);
        box.add_child(this._detail);
        this.add_child(box);

        this._switch = new PopupMenu.Switch(false);
        this.add_child(this._switch);
        this.label_actor = this._title;
    }

    update(tunnel, state) {
        this._title.text = tunnel.label;
        const [detail, failed] = describe(tunnel, state);
        this._detail.text = detail;
        if (failed)
            this._detail.add_style_class_name('iap-tunnel-failed');
        else
            this._detail.remove_style_class_name('iap-tunnel-failed');
        this._switch.state = isUp(state);
        this.accessible_name = `${tunnel.label}: ${detail}`;
    }

    activate(_event) {
        // Keep the menu open, like the VPN switches.
        this.emit('toggle');
    }
});

const IapTunnelsIndicator = GObject.registerClass(
class IapTunnelsIndicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this._extension = extension;
        this._sd = new SystemdUser();
        this._tunnels = new Map(); // id -> {id, cfg, state, item, path, signalId, notified}
        this._destroyed = false;

        const icon = name => Gio.FileIcon.new(
            Gio.File.new_for_path(GLib.build_filenamev([extension.path, 'icons', `${name}-symbolic.svg`])));
        this._icons = {
            connected: icon('iap-tunnel'),
            connecting: icon('iap-tunnel-connecting'),
            error: icon('iap-tunnel-error'),
        };

        // Top bar: status icon + short label (tunnel name, or a count).
        this._indicator = this._addIndicator();
        this._indicator.gicon = this._icons.connected;
        this._indicator.visible = false;
        this._label = new St.Label({
            style_class: 'iap-tunnels-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._label);
        this._label.connect('notify::visible', () => this._syncIndicatorsVisible());

        this._toggle = new QuickMenuToggle({
            title: _('IAP Tunnels'),
            gicon: this._icons.connected,
            toggleMode: false,
        });
        this._toggle.menu.setHeader(this._icons.connected, _('IAP Tunnels'),
            _('Google Cloud Identity-Aware Proxy'));

        this._section = new PopupMenu.PopupMenuSection();
        this._toggle.menu.addMenuItem(this._section);
        this._emptyItem = new PopupMenu.PopupMenuItem(_('No tunnels configured'), {reactive: false});
        this._section.addMenuItem(this._emptyItem);

        this._toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._clearFailedItem = this._toggle.menu.addAction(_('Clear Failed Tunnels'),
            () => this._clearFailed().catch(logError));
        this._clearFailedItem.visible = false;
        this._toggle.menu.addAction(_('Sign in to Google Cloud…'), () => this._signIn().catch(logError));
        this._toggle.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._updateAccount().catch(logError);
        }, this);
        this._toggle.menu.addAction(_('Tunnel Settings'), () => {
            Main.panel.closeQuickSettings();
            this._extension.openPreferences();
        });

        this._toggle.connectObject('clicked', () => this._onToggleClicked().catch(logError), this);
        this.quickSettingsItems.push(this._toggle);

        this._setup().catch(e => logError(e, 'iap-tunnels: setup failed'));
    }

    async _setup() {
        try {
            if (await Tunnels.ensureBackend(this._extension.path))
                await this._sd.reload();
        } catch (e) {
            logError(e, 'iap-tunnels: could not install systemd template');
        }
        await this._sd.subscribe();
        if (this._destroyed)
            return;
        this._monitor = Tunnels.monitorConfig(() => this._scheduleReload());
        await this._reload();
    }

    _scheduleReload() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._reloadId = 0;
            this._reload().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        if (this._reloading) {
            this._reloadAgain = true;
            return;
        }
        this._reloading = true;
        try {
            const configs = await Tunnels.listTunnels();
            if (this._destroyed)
                return;
            const seen = new Set();
            for (const [index, cfg] of configs.entries()) {
                seen.add(cfg.id);
                let tunnel = this._tunnels.get(cfg.id);
                if (!tunnel) {
                    // eslint-disable-next-line no-await-in-loop
                    tunnel = await this._addTunnel(cfg);
                    if (this._destroyed)
                        return;
                }
                tunnel.cfg = cfg;
                tunnel.item.update(cfg, tunnel.state);
                this._section.moveMenuItem(tunnel.item, index);
            }
            for (const [id, tunnel] of this._tunnels) {
                if (!seen.has(id))
                    this._removeTunnel(tunnel);
            }
            this._emptyItem.visible = this._tunnels.size === 0;
            this._sync();
        } finally {
            this._reloading = false;
            if (this._reloadAgain && !this._destroyed) {
                this._reloadAgain = false;
                this._reload().catch(logError);
            }
        }
    }

    async _addTunnel(cfg) {
        const tunnel = {
            id: cfg.id,
            cfg,
            state: {active: 'inactive', sub: 'dead', authExpired: false},
            item: new TunnelItem(),
            notified: false,
        };
        tunnel.item.connectObject('toggle', () => this._toggleTunnel(tunnel).catch(logError), this);
        this._section.addMenuItem(tunnel.item);
        this._tunnels.set(cfg.id, tunnel);
        try {
            tunnel.path = await this._sd.loadUnit(Tunnels.unitName(cfg.id));
            if (this._destroyed)
                return tunnel;
            tunnel.signalId = this._sd.watch(tunnel.path, changed => this._onUnitChanged(tunnel, changed));
            tunnel.state = {...await this._sd.getState(tunnel.path), authExpired: false};
            if (tunnel.state.active === 'failed')
                await this._checkFailure(tunnel, false);
        } catch (e) {
            logError(e, `iap-tunnels: cannot track ${cfg.id}`);
        }
        return tunnel;
    }

    _removeTunnel(tunnel) {
        if (tunnel.signalId)
            this._sd.unwatch(tunnel.signalId);
        tunnel.item.destroy();
        this._tunnels.delete(tunnel.id);
    }

    _onUnitChanged(tunnel, changed) {
        if (!this._tunnels.has(tunnel.id))
            return;
        const previous = tunnel.state.active;
        if (changed.ActiveState)
            tunnel.state.active = changed.ActiveState.unpack();
        if (changed.SubState)
            tunnel.state.sub = changed.SubState.unpack();

        if (tunnel.state.active !== 'failed')
            tunnel.state.authExpired = false;
        else if (previous !== 'failed')
            this._checkFailure(tunnel, true).catch(logError);

        tunnel.item.update(tunnel.cfg, tunnel.state);
        this._sync();
    }

    /** Find out why a tunnel failed (exit 75 = sign-in expired) and tell the user once. */
    async _checkFailure(tunnel, notify) {
        let status = null;
        try {
            status = await this._sd.getExitStatus(tunnel.path);
        } catch (e) {
            logError(e, `iap-tunnels: cannot read exit status of ${tunnel.id}`);
        }
        if (this._destroyed || tunnel.state.active !== 'failed')
            return;
        tunnel.state.authExpired = status === Tunnels.EXIT_AUTH;
        tunnel.item.update(tunnel.cfg, tunnel.state);
        this._sync();

        if (!notify || tunnel.notified)
            return;
        tunnel.notified = true;
        if (tunnel.state.authExpired) {
            this._notifyAuthExpired();
        } else {
            Main.notifyError(
                _('IAP tunnel “%s” failed').format(tunnel.cfg.label),
                _('Logs: journalctl --user -u %s').format(Tunnels.unitName(tunnel.id)));
        }
    }

    /** One notification for all tunnels stopped by an expired sign-in, with a Sign In button. */
    _notifyAuthExpired() {
        const names = [...this._tunnels.values()]
            .filter(t => t.state.authExpired).map(t => t.cfg.label).join(', ');
        const body = _('Stopped: %s. Sign in again to reconnect.').format(names);
        if (this._authNotification) {
            this._authNotification.body = body;
            return;
        }
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title: _('Google Cloud sign-in expired'),
            body,
            iconName: 'dialog-password-symbolic',
            urgency: MessageTray.Urgency.HIGH,
        });
        notification.addAction(_('Sign In'), () => this._signIn().catch(logError));
        notification.connectObject(
            'activated', () => this._signIn().catch(logError),
            'destroy', () => {
                this._authNotification = null;
            }, this);
        this._authNotification = notification;
        source.addNotification(notification);
    }

    async _toggleTunnel(tunnel) {
        const unit = Tunnels.unitName(tunnel.id);
        if (tunnel.state.active === 'failed' && tunnel.state.authExpired) {
            await this._signIn(tunnel.cfg.ACCOUNT || null);
            return;
        }
        tunnel.notified = false;
        try {
            if (isUp(tunnel.state)) {
                await this._sd.stop(unit);
            } else {
                if (tunnel.state.active === 'failed')
                    await this._sd.resetFailed(unit);
                Tunnels.setLastUsed(tunnel.id);
                await this._sd.start(unit);
            }
        } catch (e) {
            Main.notifyError(_('IAP tunnel “%s”').format(tunnel.cfg.label), e.message);
        }
    }

    async _onToggleClicked() {
        const up = [...this._tunnels.values()].filter(t => isUp(t.state));
        if (up.length) {
            await Promise.all(up.map(t => this._toggleTunnel(t)));
            await this._clearFailed();
            return;
        }
        if (this._tunnels.size === 0) {
            this._extension.openPreferences();
            return;
        }
        const last = this._tunnels.get(await Tunnels.getLastUsed() ?? '');
        await this._toggleTunnel(last ?? this._tunnels.values().next().value);
    }

    async _clearFailed() {
        const failed = [...this._tunnels.values()].filter(t => t.state.active === 'failed');
        await Promise.all(failed.map(t => this._sd.resetFailed(Tunnels.unitName(t.id))));
    }

    _sync() {
        const all = [...this._tunnels.values()];
        const active = all.filter(t => t.state.active === 'active' || t.state.active === 'reloading');
        const connecting = all.filter(t => t.state.active === 'activating');
        const failed = all.filter(t => t.state.active === 'failed');
        const up = [...active, ...connecting];

        this._toggle.checked = up.length > 0;
        this._clearFailedItem.visible = failed.length > 0;

        // A failure wins over everything, then connecting, then connected.
        let status = null;
        let shown = [];
        if (failed.length) {
            status = 'error';
            shown = failed;
        } else if (connecting.length) {
            status = 'connecting';
            shown = up;
        } else if (active.length) {
            status = 'connected';
            shown = active;
        }

        this._indicator.visible = status !== null;
        this._label.visible = status !== null;
        if (status) {
            this._indicator.gicon = this._icons[status];
            this._label.text = shown.length === 1 ? shown[0].cfg.label : String(shown.length);
            const names = shown.map(t => t.cfg.label).join(', ');
            this.accessible_name = {
                error: _('IAP tunnel failed: %s'),
                connecting: _('IAP tunnel connecting: %s'),
                connected: _('IAP tunnel connected: %s'),
            }[status].format(names);
        }

        let subtitle = null;
        if (all.length === 0)
            subtitle = _('Not configured');
        else if (connecting.length)
            subtitle = _('Connecting…');
        else if (active.length === 1)
            subtitle = active[0].cfg.label;
        else if (active.length > 1)
            subtitle = _('%d connected').format(active.length);
        else if (failed.length === 1)
            subtitle = _('%s failed').format(failed[0].cfg.label);
        else if (failed.length > 1)
            subtitle = _('%d failed').format(failed.length);
        this._toggle.subtitle = subtitle;
    }

    /**
     * Run `gcloud auth login` (opens the browser), then reconnect every tunnel that
     * stopped because of the expired sign-in and uses that account.
     */
    async _signIn(account = null) {
        Main.panel.closeQuickSettings();
        if (this._signingIn)
            return;
        this._signingIn = true;
        this._authNotification?.destroy();
        try {
            const expired = [...this._tunnels.values()].filter(t => t.state.authExpired);
            account ??= expired.find(t => t.cfg.ACCOUNT)?.cfg.ACCOUNT ?? null;

            const {ok, stderr} = await Tunnels.run(
                ['gcloud', 'auth', 'login', '--brief', ...account ? [account] : []]);
            if (this._destroyed)
                return;
            if (!ok) {
                Main.notifyError(_('Google Cloud sign-in failed'),
                    stderr.trim().split('\n').at(-1) ?? '');
                return;
            }

            // Restart tunnels whose account we just refreshed: the named account, or
            // the active gcloud account for tunnels without one.
            const active = await this._activeAccount();
            const refreshed = expired.filter(t => (t.cfg.ACCOUNT || active) === (account ?? active));
            await Promise.all(refreshed.map(async t => {
                t.notified = false;
                const unit = Tunnels.unitName(t.id);
                await this._sd.resetFailed(unit);
                await this._sd.start(unit);
            }));
            Main.notify(_('Signed in to Google Cloud'),
                refreshed.length
                    ? _('Reconnecting: %s').format(refreshed.map(t => t.cfg.label).join(', '))
                    : _('Signed in as %s').format(account ?? active ?? '?'));
            this._updateAccount().catch(logError);
        } catch (e) {
            Main.notifyError(_('Google Cloud sign-in failed'), e.message);
        } finally {
            this._signingIn = false;
        }
    }

    async _activeAccount() {
        const {ok, stdout} = await Tunnels.run(['gcloud', 'config', 'get-value', 'account']);
        return ok && stdout.trim() ? stdout.trim() : null;
    }

    /** Show the signed-in gcloud account in the menu header. */
    async _updateAccount() {
        const account = await this._activeAccount();
        if (this._destroyed)
            return;
        this._toggle.menu.setHeader(this._icons.connected, _('IAP Tunnels'),
            account ? _('Signed in as %s').format(account) : _('Not signed in to Google Cloud'));
    }

    destroy() {
        this._destroyed = true;
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._monitor?.cancel();
        this._authNotification?.destroy();
        for (const tunnel of [...this._tunnels.values()])
            this._removeTunnel(tunnel);
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class IapTunnelsExtension extends Extension {
    enable() {
        this._indicator = new IapTunnelsIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        // Tunnels are systemd services, so they keep running (e.g. on the lock screen).
        this._indicator?.destroy();
        this._indicator = null;
    }
}
