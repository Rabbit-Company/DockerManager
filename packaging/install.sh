#!/bin/sh
# Installs or updates the DockerManager controller from a GitHub release.
#
#   curl -fsSL https://github.com/Rabbit-Company/DockerManager/releases/latest/download/install.sh | sudo sh
#
# Settings, all optional:
#   DOMAIN=https://docker.example.com   address browsers and agents use, asked for when missing
#   VERSION=v0.1.0                      a release tag instead of the latest release
#   TZ=Europe/Ljubljana                 time zone, taken from the system when missing
#   sh -s -- --uninstall                removes the program and keeps the data in /var/lib/dockermanager
set -eu

REPO="${REPO:-Rabbit-Company/DockerManager}"
BASE_URL="${BASE_URL:-https://github.com/$REPO/releases}"
ROOT="${DM_ROOT:-}"
BIN="$ROOT/usr/local/bin/dockermanager-controller"
SHARE="$ROOT/opt/dockermanager"
CONF_DIR="$ROOT/etc/dockermanager"
CONF="$CONF_DIR/controller.env"
UNIT="$ROOT/etc/systemd/system/dockermanager-controller.service"

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "DockerManager runs on Linux."
[ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || fail "Run this as root, for example with sudo."
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
for tool in curl tar sha256sum; do
	command -v "$tool" >/dev/null 2>&1 || fail "$tool is required. Install it and run this again."
done

if [ "${1:-}" = "--uninstall" ]; then
	systemctl disable --now dockermanager-controller >/dev/null 2>&1 || true
	rm -f "$UNIT" "$BIN"
	rm -rf "$SHARE"
	systemctl daemon-reload
	say "DockerManager is removed. Settings in $CONF_DIR and data in /var/lib/dockermanager are kept. Delete them to start over."
	exit 0
fi

case "$(uname -m)" in
	x86_64 | amd64) ARCH=x64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) fail "There is no release for $(uname -m). Use x86_64 or aarch64, or build from source." ;;
esac

if [ -n "${VERSION:-}" ]; then
	TAG="$VERSION"
else
	TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$BASE_URL/latest" | sed -n 's#.*/tag/##p')
	[ -n "$TAG" ] || fail "Could not find the latest release at $BASE_URL."
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
ARCHIVE="dockermanager-linux-$ARCH.tar.gz"
say "Downloading DockerManager $TAG for $ARCH"
curl -fsSL "$BASE_URL/download/$TAG/$ARCHIVE" -o "$WORK/$ARCHIVE" || fail "Could not download $ARCHIVE from release $TAG."
curl -fsSL "$BASE_URL/download/$TAG/SHA256SUMS" -o "$WORK/SHA256SUMS" || fail "Could not download SHA256SUMS from release $TAG."
(cd "$WORK" && grep "  $ARCHIVE\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1) || fail "The download does not match its checksum. Nothing was changed."
mkdir "$WORK/files"
tar -xzf "$WORK/$ARCHIVE" -C "$WORK/files"

UPDATE=no
[ -f "$CONF" ] && UPDATE=yes

if [ "$UPDATE" = no ]; then
	ADDRESS="${DOMAIN:-}"
	GUESS="http://$(hostname -I 2>/dev/null | awk '{print $1}'):3000"
	[ "$GUESS" = "http://:3000" ] && GUESS="http://localhost:3000"
	if [ -z "$ADDRESS" ] && (: </dev/tty) 2>/dev/null; then
		printf '\nThe address browsers and agents will use to reach DockerManager.\n' >/dev/tty
		printf 'Use https://your.domain when a reverse proxy serves it, or keep the plain address.\n' >/dev/tty
		printf 'Address [%s]: ' "$GUESS" >/dev/tty
		read -r ADDRESS </dev/tty || ADDRESS=""
	fi
	ADDRESS=$(printf '%s' "${ADDRESS:-$GUESS}" | sed 's#/*$##')
	case "$ADDRESS" in
		https://*) BIND=127.0.0.1 ;;
		http://*) BIND=0.0.0.0 ;;
		*) fail "The address must start with http:// or https://, such as https://docker.example.com." ;;
	esac
	ZONE="${TZ:-}"
	[ -n "$ZONE" ] || ZONE=$(timedatectl show -p Timezone --value 2>/dev/null || true)
	[ -n "$ZONE" ] || ZONE=$(cat /etc/timezone 2>/dev/null || true)
	[ -n "$ZONE" ] || ZONE=UTC
	SETUP_TOKEN=$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n')
fi

mkdir -p "$(dirname "$BIN")" "$SHARE" "$CONF_DIR" "$(dirname "$UNIT")"
systemctl stop dockermanager-controller >/dev/null 2>&1 || true
install -m 755 "$WORK/files/dockermanager-controller" "$BIN.new" && mv "$BIN.new" "$BIN"
install -m 755 "$WORK/files/agent-linux-x64" "$WORK/files/agent-linux-arm64" "$SHARE/"
install -m 644 "$WORK/files/dockermanager-controller.service" "$UNIT"

if [ "$UPDATE" = no ]; then
	umask 077
	cat >"$CONF" <<EOF
# DockerManager controller settings. All options are listed in .env.example in the repository.
DOMAIN=$ADDRESS
BIND_ADDRESS=$BIND
TZ=$ZONE
# Needed once, on the first run page. Unused after the first account exists.
SETUP_TOKEN=$SETUP_TOKEN
EOF
	chmod 600 "$CONF"
fi

systemctl daemon-reload
systemctl enable dockermanager-controller >/dev/null 2>&1
systemctl restart dockermanager-controller

if [ "$UPDATE" = yes ]; then
	say "DockerManager is updated to $TAG and running. Your settings in $CONF were kept."
	exit 0
fi

say ""
say "DockerManager $TAG is running."
say ""
say "  Open      $ADDRESS/setup"
say "  Token     $SETUP_TOKEN"
say ""
if [ "$BIND" = 127.0.0.1 ]; then
	say "It listens on 127.0.0.1:3000. Point your reverse proxy for $ADDRESS there."
else
	say "It listens on port 3000 of every interface. Put it behind HTTPS before using it over the internet."
fi
say "Settings: $CONF. Logs: journalctl -u dockermanager-controller"
