UUID := iap-tunnels@alexheidl.github.io
SRC := $(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall pack test check numpy

## Symlink the source into the user's extension folder (development install)
install:
	mkdir -p $(dir $(DEST))
	ln -sfn $(CURDIR)/$(SRC) $(DEST)
	gnome-extensions enable $(UUID) || echo "Log out and back in once, then run: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(DEST)

## Optional: NumPy for gcloud's bundled Python, used by all tunnels (less CPU per upload)
PYLIB := $(HOME)/.local/share/iap-tunnels/python
GCLOUD_PY = $$(gcloud info --format="value(basic.python_location)")
numpy:
	$(GCLOUD_PY) -m pip install --quiet --disable-pip-version-check --upgrade --target $(PYLIB) numpy
	PYTHONPATH=$(PYLIB) $(GCLOUD_PY) -c "import numpy; print('numpy', numpy.__version__, 'ready; restart running tunnels to use it')"

## Build a zip for `gnome-extensions install` / extensions.gnome.org
pack:
	mkdir -p dist
	gnome-extensions pack --force --extra-source=lib --extra-source=systemd --extra-source=icons -o dist $(SRC)

test:
	@tmp=$$(mktemp -d -t iap-test.XXXXXX); \
	XDG_CONFIG_HOME=$$tmp/config XDG_STATE_HOME=$$tmp/state XDG_DATA_HOME=$$tmp/data gjs -m tests/tunnels.test.js; rc=$$?; \
	rm -rf $$tmp; [ $$rc -eq 0 ] || exit $$rc; \
	echo; bash tests/wrapper.test.sh

check: test
	for f in $(SRC)/*.js $(SRC)/lib/*.js; do node --input-type=module --check < $$f || exit 1; done
	bash -n $(SRC)/systemd/iap-tunnel-run
	systemd-analyze --user verify $(SRC)/systemd/iap-tunnel@.service 2>&1 | grep -v 'not found\|EnvironmentFile' || true
