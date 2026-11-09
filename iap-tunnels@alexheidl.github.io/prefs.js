import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Tunnels from './lib/tunnels.js';

const describe = t =>
    `${t.INSTANCE}:${t.REMOTE_PORT} → localhost:${t.LOCAL_PORT} · ${t.PROJECT} · ${t.ZONE}`;

export default class IapTunnelsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(680, 640);
        window.search_enabled = false;

        const page = new Adw.PreferencesPage({title: _('Tunnels'), icon_name: 'network-vpn-symbolic'});
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Tunnels'),
            description: _('Each tunnel forwards a port of a Compute Engine VM to localhost through Identity-Aware Proxy. Switch them on and off from Quick Settings.'),
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add Tunnel'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        addButton.connect('clicked', () => this._openEditor(window, null));
        group.set_header_suffix(addButton);
        page.add(group);

        const help = new Adw.PreferencesGroup({title: _('Troubleshooting')});
        help.add(new Adw.ActionRow({
            title: _('Credentials'),
            subtitle: _('Tunnels use your gcloud login. When Google asks you to sign in again, the tunnels stop and a notification offers “Sign In”; they reconnect by themselves afterwards.'),
        }));
        help.add(new Adw.ActionRow({
            title: _('Logs'),
            subtitle: 'journalctl --user -u "iap-tunnel@*"',
            subtitle_selectable: true,
        }));
        page.add(help);

        const rows = [];
        const refresh = () => {
            rows.splice(0).forEach(row => group.remove(row));
            const tunnels = Tunnels.listTunnels();
            if (tunnels.length === 0) {
                rows.push(new Adw.ActionRow({
                    title: _('No tunnels yet'),
                    subtitle: _('Click + to add one.'),
                }));
            }
            for (const tunnel of tunnels)
                rows.push(this._createRow(window, tunnel));
            rows.forEach(row => group.add(row));
        };
        this._refresh = refresh;

        // Refresh when files change (also picks up edits made by hand).
        window._iapMonitor = Tunnels.monitorConfig(() => {
            if (window._iapRefreshId)
                GLib.source_remove(window._iapRefreshId);
            window._iapRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                window._iapRefreshId = 0;
                refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
        window.connect('close-request', () => {
            window._iapMonitor.cancel();
            if (window._iapRefreshId)
                GLib.source_remove(window._iapRefreshId);
            return false;
        });
        refresh();
    }

    _createRow(window, tunnel) {
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(tunnel.label, -1),
            subtitle: GLib.markup_escape_text(describe(tunnel), -1),
            activatable: true,
        });
        if (Tunnels.isAutostart(tunnel.id)) {
            row.add_suffix(new Gtk.Label({
                label: _('At login'),
                css_classes: ['dim-label', 'caption'],
                valign: Gtk.Align.CENTER,
            }));
        }
        const deleteButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Delete'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        deleteButton.connect('clicked', () => this._confirmDelete(window, tunnel));
        row.add_suffix(deleteButton);
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', () => this._openEditor(window, tunnel));
        return row;
    }

    _confirmDelete(window, tunnel) {
        const dialog = new Adw.AlertDialog({
            heading: _('Delete “%s”?').replace('%s', tunnel.label),
            body: _('The tunnel is stopped and its configuration removed.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', async (_d, response) => {
            if (response !== 'delete')
                return;
            const unit = Tunnels.unitName(tunnel.id);
            await Tunnels.systemctl('disable', '--now', unit);
            await Tunnels.systemctl('reset-failed', unit);
            Tunnels.deleteTunnel(tunnel.id);
            this._refresh?.();
            window.add_toast(new Adw.Toast({title: _('Deleted “%s”').replace('%s', tunnel.label)}));
        });
        dialog.present(window);
    }

    _openEditor(window, tunnel) {
        const isNew = tunnel === null;
        const dialog = new Adw.Dialog({
            title: isNew ? _('Add Tunnel') : _('Edit Tunnel'),
            content_width: 520,
        });

        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        const cancelButton = new Gtk.Button({label: _('Cancel')});
        const saveButton = new Gtk.Button({
            label: isNew ? _('Add') : _('Save'),
            css_classes: ['suggested-action'],
        });
        header.pack_start(cancelButton);
        header.pack_end(saveButton);

        const banner = new Adw.Banner();
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.add_top_bar(banner);

        const page = new Adw.PreferencesPage();
        toolbar.set_content(page);
        dialog.set_child(toolbar);

        const entry = (title, text = '') => new Adw.EntryRow({title, text: text ?? ''});
        const port = (title, value) => {
            const row = Adw.SpinRow.new_with_range(1, 65535, 1);
            row.title = title;
            row.value = Number(value) || 1;
            return row;
        };

        const general = new Adw.PreferencesGroup();
        const nameRow = entry(_('Name'), tunnel?.LABEL ?? '');
        const idRow = entry(_('ID (systemd unit iap-tunnel@ID)'), tunnel?.id ?? '');
        idRow.sensitive = isNew;
        general.add(nameRow);
        general.add(idRow);
        page.add(general);

        const cloud = new Adw.PreferencesGroup({title: _('Google Cloud')});
        const projectRow = entry(_('Project ID'), tunnel?.PROJECT);
        const zoneRow = entry(_('Zone (e.g. europe-west3-a)'), tunnel?.ZONE);
        const instanceRow = entry(_('VM instance name'), tunnel?.INSTANCE);
        [projectRow, zoneRow, instanceRow].forEach(row => cloud.add(row));
        page.add(cloud);

        const ports = new Adw.PreferencesGroup({
            title: _('Ports'),
            description: _('The tunnel listens on localhost only.'),
        });
        const remoteRow = port(_('Port on the VM'), tunnel?.REMOTE_PORT ?? 22);
        const localRow = port(_('Local port'), tunnel?.LOCAL_PORT ?? 2222);
        ports.add(remoteRow);
        ports.add(localRow);
        page.add(ports);

        const advanced = new Adw.PreferencesGroup({title: _('Options')});
        const autostartRow = new Adw.SwitchRow({
            title: _('Connect at login'),
            active: !isNew && Tunnels.isAutostart(tunnel.id),
        });
        const accountRow = entry(_('Google account (empty = active gcloud account)'), tunnel?.ACCOUNT);
        const extraRow = entry(_('Extra gcloud arguments'), tunnel?.EXTRA_ARGS);
        advanced.add(autostartRow);
        advanced.add(accountRow);
        advanced.add(extraRow);
        page.add(advanced);

        if (isNew) {
            // Suggest an ID from the name until the user edits the ID themselves.
            let idTouched = false;
            idRow.connect('changed', () => {
                if (idRow.text !== Tunnels.slugify(nameRow.text))
                    idTouched = true;
            });
            nameRow.connect('changed', () => {
                if (!idTouched)
                    idRow.text = Tunnels.slugify(nameRow.text);
            });
            // Prefill the active gcloud project.
            Tunnels.run(['gcloud', 'config', 'get-value', 'project']).then(({ok, stdout}) => {
                const project = stdout.trim();
                if (ok && project && !projectRow.text)
                    projectRow.text = project;
            }).catch(() => {});
        }

        cancelButton.connect('clicked', () => dialog.close());
        saveButton.connect('clicked', async () => {
            const id = idRow.text.trim();
            const data = {
                ...tunnel, // keep settings the dialog doesn't show (e.g. CLOUDSDK_PYTHON)
                LABEL: nameRow.text.trim(),
                PROJECT: projectRow.text.trim(),
                ZONE: zoneRow.text.trim(),
                INSTANCE: instanceRow.text.trim(),
                REMOTE_PORT: String(remoteRow.value),
                LOCAL_PORT: String(localRow.value),
                ACCOUNT: accountRow.text.trim(),
                EXTRA_ARGS: extraRow.text.trim(),
            };
            let error = Tunnels.validate(id, data, Tunnels.listTunnels());
            if (!error && isNew && Tunnels.listTunnels().some(t => t.id === id))
                error = _('A tunnel with ID “%s” already exists.').replace('%s', id);
            if (error) {
                banner.title = error;
                banner.revealed = true;
                return;
            }

            saveButton.sensitive = false;
            try {
                Tunnels.saveTunnel(id, data);
                const unit = Tunnels.unitName(id);
                if (Tunnels.ensureBackend(this.path))
                    await Tunnels.systemctl('daemon-reload');
                if (autostartRow.active !== Tunnels.isAutostart(id))
                    await Tunnels.systemctl(autostartRow.active ? 'enable' : 'disable', unit);
                // Apply changed settings to a running tunnel.
                if (!isNew)
                    await Tunnels.systemctl('try-restart', unit);
                dialog.close();
                this._refresh?.();
                window.add_toast(new Adw.Toast({title: isNew ? _('Tunnel added') : _('Tunnel saved')}));
            } catch (e) {
                banner.title = e.message;
                banner.revealed = true;
                saveButton.sensitive = true;
            }
        });

        dialog.present(window);
    }
}
