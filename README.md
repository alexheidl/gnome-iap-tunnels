# IAP Tunnels for GNOME

Switch [Google Cloud Identity-Aware Proxy (IAP) TCP tunnels](https://cloud.google.com/iap/docs/using-tcp-forwarding) on and off from GNOME's Quick Settings, the same way you switch a VPN.

IAP TCP forwarding lets you reach a port on a Compute Engine VM, for example SSH, a database or an internal web app, without giving the VM a public IP. Normally you keep a terminal open running `gcloud compute start-iap-tunnel`. This extension runs those tunnels in the background, shows their status in the top bar and tells you when they need attention.

## Features

- **Quick Settings toggle.** Click it to connect the tunnel you used last, or to disconnect everything that's running. Its menu has a switch per tunnel showing *Connecting…*, *Connected · localhost:PORT → vm:PORT*, or *Failed*.
- **Top-bar status.** Its own tunnel icon (so it isn't mistaken for a VPN) and the tunnel's name next to it, or a count when several are up:
  - arrow: connected
  - dots: connecting or reconnecting
  - "!": a tunnel failed and stays down, until you retry it or choose *Clear Failed Tunnels*
- **Settings window.** Add, edit and delete tunnels, and choose which ones connect at login.
- **Expired sign-in detection.** When Google asks you to sign in again, gcloud keeps the local port open but every connection fails. The extension spots this, stops the tunnel and shows *Sign-in expired* instead of a misleading *Connected*. One notification with a **Sign In** button covers all affected tunnels. Signing in runs `gcloud auth login` (it opens your browser), and those tunnels then reconnect automatically.
- **Account display.** The menu header shows which Google account gcloud is using. Each tunnel can optionally use a different account.
- **Plain systemd underneath.** Each tunnel is a systemd user service, so tunnels keep running on the lock screen and you can also manage them from a terminal.

Supported: GNOME Shell 48–51 (tested on 51).

This is an independent project, not affiliated with or endorsed by Google.

## Requirements

- GNOME Shell 48 or newer
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`), signed in with `gcloud auth login`
- IAP TCP forwarding set up for the VM you want to reach:
  - your account needs the **IAP-secured Tunnel User** role (`roles/iap.tunnelResourceAccessor`) on the project or the VM
  - a firewall rule must allow ingress from IAP's range `35.235.240.0/20` to the port, for example:

    ```bash
    gcloud compute firewall-rules create allow-iap-ingress \
      --network=default --direction=INGRESS --action=allow \
      --rules=tcp:22 --source-ranges=35.235.240.0/20
    ```

  See [Using IAP for TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding) for details.

If `gcloud compute start-iap-tunnel INSTANCE PORT --zone=ZONE` works in a terminal, the extension will work too.

## Install

```bash
git clone https://github.com/alexheidl/gnome-iap-tunnels.git
cd gnome-iap-tunnels
make install      # links the extension into ~/.local/share/gnome-shell/extensions
```

On Wayland, GNOME Shell only discovers new extensions at login. **Log out and back in once**, then run:

```bash
gnome-extensions enable iap-tunnels@alexheidl.github.io
```

To install from a zip instead: `make pack`, then `gnome-extensions install --force dist/*.zip`.

## Usage

1. Open the settings window: run `gnome-extensions prefs iap-tunnels@alexheidl.github.io`, or choose *Tunnel Settings* in the IAP Tunnels menu.
2. Click **+** and fill in the project, zone, VM name, the port on the VM and a free local port. The project is prefilled from your active gcloud configuration.
3. Switch the tunnel on in Quick Settings. It's ready when its row says *Connected*, and then you connect to `localhost:<local port>`.

For SSH, for example, forward VM port `22` to local port `2222`, then run `ssh -p 2222 user@localhost`.

### Configuration files

The settings window writes one file per tunnel. You can also edit these by hand; the menu picks up changes automatically.

```ini
# ~/.config/iap-tunnels/db.env  →  unit iap-tunnel@db.service
LABEL="Database"
PROJECT="my-project"
ZONE="europe-west3-a"
INSTANCE="db-1"
REMOTE_PORT="5432"
LOCAL_PORT="15432"
ACCOUNT=""        # optional: a gcloud account other than the active one
EXTRA_ARGS=""     # optional: extra arguments for gcloud compute start-iap-tunnel
```

| Key | Required | Meaning |
|---|---|---|
| `LABEL` | no | Name shown in the menu (defaults to the file name) |
| `PROJECT` | yes | Google Cloud project ID |
| `ZONE` | yes | Zone of the VM |
| `INSTANCE` | yes | VM instance name |
| `REMOTE_PORT` | yes | Port on the VM |
| `LOCAL_PORT` | yes | Port on `localhost`; must be unique across tunnels |
| `ACCOUNT` | no | Passed to gcloud as `--account` |
| `EXTRA_ARGS` | no | Appended to the gcloud command, split on spaces |

Any other variables in the file, such as `CLOUDSDK_PYTHON`, are passed to gcloud unchanged and kept when you save from the settings window.

### From a terminal

```bash
systemctl --user start iap-tunnel@db      # connect
systemctl --user stop iap-tunnel@db       # disconnect
systemctl --user enable iap-tunnel@db     # connect at login
journalctl --user -u iap-tunnel@db        # logs
```

## How it works

```
~/.config/systemd/user/iap-tunnel@.service      template unit (installed and updated by the extension)
~/.local/share/iap-tunnels/iap-tunnel-run       runner script (installed and updated by the extension)
~/.config/iap-tunnels/<id>.env                  one file per tunnel
```

The unit runs the runner script, which runs `gcloud compute start-iap-tunnel` and also watches the Google sign-in:

- It checks `gcloud auth print-access-token` when it starts and then every 60 s. The check is non-interactive, so it fails once a reauthentication is needed.
- It watches gcloud's output for `Reauthentication failed`, `ReauthRequiredError` and `invalid_grant`, which gcloud logs when it keeps listening but drops every connection.
- When either happens, it stops the tunnel and exits with code **75**. The unit doesn't restart on that code, so it lands in *failed*. The extension reads the exit code over D-Bus and shows *Sign-in expired*.
- Network errors don't count as an expired sign-in: a failed check while you're offline leaves the tunnel running.

Other failures restart the tunnel every 5 s. After 5 failures in 2 minutes the unit gives up and the tunnel shows as *Failed*.

| Exit code | Meaning |
|---|---|
| `75` | Google sign-in expired or needs reauthentication |
| `64` | Incomplete tunnel configuration |
| other | gcloud's own exit code |

The extension talks to systemd over D-Bus and listens for unit state changes, so it never polls. How often Google asks you to sign in again is set by your organisation's session-length policy; the extension can't change that, only make it quicker to handle. Tunnels use gcloud's user credentials, not Application Default Credentials.

If you customise the unit or the runner, delete the `# Managed by …` line at the top and the extension will stop overwriting the file.

## Optional: faster uploads with NumPy

gcloud warns that installing NumPy improves tunnel performance. NumPy does the WebSocket masking of *uploaded* data in C instead of Python. `make numpy` installs it for gcloud's bundled Python, into `~/.local/share/iap-tunnels/python`, so your system Python isn't touched. The runner uses it automatically; restart running tunnels to pick it up.

An example measurement, a 64 MB upload over SSH through IAP on a connection with roughly 45 Mbit/s upload:

| | Upload | Tunnel CPU per 64 MB |
|---|---|---|
| without NumPy | 35–45 Mbit/s | 4.2–5.3 s (about 35% of one core) |
| with NumPy | 41–44 Mbit/s | 0.85 s (about 6% of one core) |

NumPy cut the tunnel's CPU use about 5-fold, but throughput only improves when gcloud is CPU-bound, roughly above 100 Mbit/s of upload. On a slower connection the network is the limit. If gcloud updates its bundled Python, run `make numpy` again; until then gcloud simply runs without NumPy.

## Troubleshooting

- **The toggle doesn't appear after `make install`.** Log out and back in (Wayland), then run `gnome-extensions enable iap-tunnels@alexheidl.github.io`. Errors show up in `journalctl --user -b | grep -i iap-tunnels`.
- **A tunnel shows *Failed*.** Check `journalctl --user -u iap-tunnel@<id>`. Common causes are a missing firewall rule for `35.235.240.0/20`, a missing IAM role, a wrong zone or instance name, or a local port that's already in use.
- **A tunnel shows *Sign-in expired*.** Click it, or use the notification's **Sign In** button, and finish the sign-in in your browser.
- ***Connected* means the gcloud process is running and signed in.** It doesn't prove the service on the VM is reachable: if the VM is stopped, individual connections fail while the tunnel stays up.

## Uninstall

```bash
make uninstall
```

This removes the extension but leaves your tunnels and their services in place, so they can still run from a terminal. To remove those too, stop and disable each tunnel (`systemctl --user disable --now iap-tunnel@<id>`), then delete `~/.config/iap-tunnels`, `~/.local/share/iap-tunnels` and `~/.config/systemd/user/iap-tunnel@.service`.

## Development

```bash
make test     # gjs unit tests for lib/tunnels.js + runner tests with a fake gcloud
make check    # tests + JS syntax check + systemd-analyze verify
```

| Path | Purpose |
|---|---|
| `iap-tunnels@alexheidl.github.io/extension.js` | Quick Settings toggle, menu, top-bar indicator, systemd D-Bus client |
| `iap-tunnels@alexheidl.github.io/prefs.js` | Adwaita settings window |
| `iap-tunnels@alexheidl.github.io/lib/tunnels.js` | Shared config parsing and validation, backend install |
| `iap-tunnels@alexheidl.github.io/systemd/iap-tunnel@.service` | systemd user template unit |
| `iap-tunnels@alexheidl.github.io/systemd/iap-tunnel-run` | Runner script: tunnel plus sign-in watchdog |
| `iap-tunnels@alexheidl.github.io/icons/` | Symbolic status icons |
| `tests/` | Tests |

Issues and pull requests are welcome.

## License

[GPL-2.0-or-later](LICENSE), the license GNOME Shell and most of its extensions use.
