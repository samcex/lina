#!/usr/bin/env bash
# Native Android SDK build: no Gradle, Maven downloads, or runtime dependencies.
set -euo pipefail
umask 077
LINA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINA_KEY="${LINA_ANDROID_KEYSTORE:-$LINA_ROOT/android/.local/lina.keystore}"
LINA_KEY_DIR="$(dirname "$LINA_KEY")"
lina_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
if [ -L "$LINA_KEY_DIR" ] || [ -L "$LINA_KEY" ]; then
  echo "Refusing a symlink signing key or key directory." >&2; exit 1
fi
if [ "$LINA_KEY_DIR" = "$LINA_ROOT/android/.local" ]; then
  mkdir -p "$LINA_KEY_DIR"
  [ -O "$LINA_KEY_DIR" ] || { echo "Signing key directory must be owned by the current user." >&2; exit 1; }
  chmod 700 "$LINA_KEY_DIR"
fi
if [ ! -d "$LINA_KEY_DIR" ] || [ ! -O "$LINA_KEY_DIR" ] || [ "$(lina_mode "$LINA_KEY_DIR")" != 700 ]; then
  echo "Signing key directory must be owned by the current user and have mode 0700: $LINA_KEY_DIR" >&2; exit 1
fi
if [ -e "$LINA_KEY" ]; then
  if [ ! -f "$LINA_KEY" ] || [ ! -O "$LINA_KEY" ]; then
    echo "Signing key must be an owned regular file: $LINA_KEY" >&2; exit 1
  fi
  chmod 600 "$LINA_KEY"
fi
LINA_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
LINA_TOOLS="$LINA_SDK/build-tools/${LINA_ANDROID_BUILD_TOOLS:-36.0.0}"
LINA_PLATFORM="$LINA_SDK/platforms/android-${LINA_ANDROID_API:-36}/android.jar"
for tool in aapt2 d8 zipalign apksigner; do
  [ -x "$LINA_TOOLS/$tool" ] || { echo "Missing Android SDK tool: $LINA_TOOLS/$tool" >&2; exit 1; }
done
[ -f "$LINA_PLATFORM" ] || { echo "Missing Android platform: $LINA_PLATFORM" >&2; exit 1; }
LINA_WORK="$(mktemp -d)"
trap 'rm -rf "$LINA_WORK"' EXIT
mkdir -p "$LINA_WORK/classes" "$LINA_WORK/dex" "$LINA_ROOT/dist/android"
"$LINA_TOOLS/aapt2" compile --dir "$LINA_ROOT/android/res" -o "$LINA_WORK/resources.zip"
"$LINA_TOOLS/aapt2" link -I "$LINA_PLATFORM" --manifest "$LINA_ROOT/android/AndroidManifest.xml" \
  -o "$LINA_WORK/unsigned.apk" "$LINA_WORK/resources.zip"
javac --release 8 -Xlint:-options -classpath "$LINA_PLATFORM" -d "$LINA_WORK/classes" "$LINA_ROOT"/android/src/app/lina/android/*.java
jar --create --file "$LINA_WORK/classes.jar" -C "$LINA_WORK/classes" .
"$LINA_TOOLS/d8" --lib "$LINA_PLATFORM" --min-api 26 --output "$LINA_WORK/dex" "$LINA_WORK/classes.jar"
jar --update --file "$LINA_WORK/unsigned.apk" -C "$LINA_WORK/dex" classes.dex
"$LINA_TOOLS/zipalign" -f -p 4 "$LINA_WORK/unsigned.apk" "$LINA_WORK/aligned.apk"
export LINA_ANDROID_STORE_PASSWORD="${LINA_ANDROID_STORE_PASSWORD:-android}"
if [ ! -f "$LINA_KEY" ]; then
  keytool -genkeypair -noprompt -keystore "$LINA_KEY" -storepass:env LINA_ANDROID_STORE_PASSWORD \
    -keypass:env LINA_ANDROID_STORE_PASSWORD -alias lina -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=LINA Local Build'
fi
chmod 600 "$LINA_KEY"
[ "$(lina_mode "$LINA_KEY")" = 600 ] || { echo "Signing key must have mode 0600." >&2; exit 1; }
"$LINA_TOOLS/apksigner" sign --ks "$LINA_KEY" --ks-key-alias lina --ks-pass env:LINA_ANDROID_STORE_PASSWORD \
  --key-pass env:LINA_ANDROID_STORE_PASSWORD --out "$LINA_ROOT/dist/android/lina.apk" "$LINA_WORK/aligned.apk"
"$LINA_TOOLS/apksigner" verify --verbose "$LINA_ROOT/dist/android/lina.apk"
"$LINA_TOOLS/zipalign" -c -p 4 "$LINA_ROOT/dist/android/lina.apk"
cp "$LINA_ROOT/dist/android/lina.apk" "$LINA_ROOT/web/public/lina.apk"
cp "$LINA_ROOT/dist/android/lina.apk" "$LINA_ROOT/lina.apk"
# A running installed daemon serves dist/web; update its APK immediately as well.
if [ -d "$LINA_ROOT/dist/web" ]; then
  cp "$LINA_ROOT/dist/android/lina.apk" "$LINA_ROOT/dist/web/lina.apk"
  chmod 644 "$LINA_ROOT/dist/web/lina.apk"
fi
chmod 644 "$LINA_ROOT/dist/android/lina.apk" "$LINA_ROOT/web/public/lina.apk" "$LINA_ROOT/lina.apk"
echo "Built signed APK: $LINA_ROOT/lina.apk"
