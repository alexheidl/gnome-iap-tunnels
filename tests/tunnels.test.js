// Run with: make test   (gjs -m, with XDG_CONFIG_HOME/XDG_STATE_HOME pointed at a temp dir)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import * as T from '../iap-tunnels@alexheidl.github.io/lib/tunnels.js';

let failures = 0;
function check(name, cond) {
    if (cond) {
        print(`ok   ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}`);
    }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!GLib.get_user_config_dir().includes('iap-test'))
    throw new Error('Refusing to run outside a temp XDG_CONFIG_HOME (use make test)');

// parse / serialize
const sample = {LABEL: 'Prod "DB"', PROJECT: 'p-1', ZONE: 'europe-west3-a', INSTANCE: 'db-1',
    REMOTE_PORT: '5432', LOCAL_PORT: '15432', EXTRA_ARGS: ''};
const text = T.serializeEnv(sample);
check('serialize skips empty keys', !text.includes('EXTRA_ARGS'));
check('serialize escapes quotes', text.includes('LABEL="Prod \\"DB\\""'));
check('roundtrip', eq(T.parseEnv(text), {...sample, EXTRA_ARGS: undefined}));
check('parse handles comments, single quotes, bare values',
    eq(T.parseEnv("# c\n\nA='x y'\nB=plain\n  C = \"q\"  \nbad line\n"), {A: 'x y', B: 'plain', C: 'q'}));

// unknown variables survive a save; runtime fields are not written
const withExtra = T.parseEnv(T.serializeEnv({...sample, id: 'x', label: 'X',
    CLOUDSDK_PYTHON: '/venv/bin/python', CLOUDSDK_PYTHON_SITEPACKAGES: '1'}));
check('extra env vars kept', withExtra.CLOUDSDK_PYTHON === '/venv/bin/python' &&
    withExtra.CLOUDSDK_PYTHON_SITEPACKAGES === '1');
check('runtime fields not written', !('id' in withExtra) && !('label' in withExtra));

// slugify
check('slugify', T.slugify('  My Server (prod)! ') === 'my-server-prod');

// validate
const ok = {PROJECT: 'p', ZONE: 'europe-west3-a', INSTANCE: 'vm', REMOTE_PORT: '22', LOCAL_PORT: '2222'};
check('valid config', T.validate('vm', ok) === null);
check('bad id', T.validate('Bad_ID', ok) !== null);
check('id may not start with dash', T.validate('-x', ok) !== null);
check('missing zone', T.validate('vm', {...ok, ZONE: ''}) !== null);
check('port range', T.validate('vm', {...ok, LOCAL_PORT: '70000'}) !== null);
check('non-numeric port', T.validate('vm', {...ok, REMOTE_PORT: 'ssh'}) !== null);
check('newline injection', T.validate('vm', {...ok, EXTRA_ARGS: 'a\nExecStart=evil'}) !== null);
check('local port clash', T.validate('vm', ok, [{id: 'other', label: 'Other', LOCAL_PORT: '2222'}]) !== null);
check('same tunnel keeps its port', T.validate('vm', ok, [{id: 'vm', label: 'VM', LOCAL_PORT: '2222'}]) === null);

// files
check('empty list without config dir', (await T.listTunnels()).length === 0);
T.saveTunnel('zeta', {...ok, LABEL: 'Zeta'});
T.saveTunnel('alpha', {...ok, LOCAL_PORT: '3333'});
GLib.file_set_contents(`${T.configDir()}/Not_Valid.env`, 'PROJECT=x\n');
const list = await T.listTunnels();
check('list sorted by label, invalid ids ignored', eq(list.map(t => t.id), ['alpha', 'zeta']));
check('label falls back to id', list[0].label === 'alpha');
T.deleteTunnel('zeta');
T.deleteTunnel('does-not-exist');
check('delete', eq((await T.listTunnels()).map(t => t.id), ['alpha']));

// backend install (unit + runner)
const extPath = GLib.build_filenamev([GLib.get_current_dir(), 'iap-tunnels@alexheidl.github.io']);
check('backend installs', await T.ensureBackend(extPath) === true);
check('backend idempotent', await T.ensureBackend(extPath) === false);
const runner = Gio.File.new_for_path(T.runnerPath());
check('runner installed', runner.query_exists(null));
check('runner executable', (runner.query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o111) !== 0);
const target = `${T.unitDir()}/${T.UNIT_TEMPLATE_NAME}`;
GLib.file_set_contents(target, '# my own unit\n');
check('customised template left alone', await T.ensureBackend(extPath) === false);
GLib.file_set_contents(T.runnerPath(), '#!/bin/sh\n# Managed by the IAP Tunnels GNOME extension (old)\n');
await T.ensureBackend(extPath);
check('managed runner gets updated', !String(new TextDecoder().decode(GLib.file_get_contents(T.runnerPath())[1])).includes('(old)'));

// account
check('account optional', T.validate('vm', {...ok, ACCOUNT: ''}) === null);
check('account must be an email', T.validate('vm', {...ok, ACCOUNT: 'not an email'}) !== null);
check('account accepted', T.validate('vm', {...ok, ACCOUNT: 'a@b.de'}) === null);
check('account serialized', T.parseEnv(T.serializeEnv({...ok, ACCOUNT: 'a@b.de'})).ACCOUNT === 'a@b.de');

// last used
check('no last used', await T.getLastUsed() === null);
T.setLastUsed('alpha');
check('last used', await T.getLastUsed() === 'alpha');

print(failures ? `\n${failures} failed` : '\nall passed');
System.exit(failures ? 1 : 0);
