#!/usr/bin/env bash
# =============================================================================================
# Build do APK RemoteX SEM o Android SDK do Google (para CI/servidores Linux sem Android Studio).
#
# Ferramentas (Ubuntu/Debian): aapt, dalvik-exchange (dx), zipalign, apksigner,
# android-sdk-platform-23 (android.jar com recursos do framework) e JDK.
# Compilador Kotlin: baixado do GitHub oficial da JetBrains na primeira execução.
#
#   sudo apt-get install -y aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 openjdk-17-jdk
#   bash android-app/tools/build-apk.sh                      # APK de depuração
#   REMOTEX_SERVER=https://remotex.suaempresa.com.br \
#   RELEASE_KEYSTORE=/caminho/release.jks RELEASE_KEY_ALIAS=remotex \
#   RELEASE_KEYSTORE_PASS=... bash android-app/tools/build-apk.sh   # APK assinado para distribuição
#
# Com Android Studio, prefira o projeto Gradle em android-app/ (./gradlew assembleRelease).
# O código Kotlin é o mesmo; este script compila contra a API 23 (minSdk 26 — Android 8.0, targetSdk 34).
# =============================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
OUT="$APP/build/apk"
CACHE="$HERE/.cache"
KOTLIN_VERSION="${KOTLIN_VERSION:-2.1.21}"
ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
DX="$(command -v dalvik-exchange || command -v dx)"
VERSION_NAME="${VERSION_NAME:-1.0.0}"
VERSION_CODE="${VERSION_CODE:-1}"

for t in aapt zipalign apksigner javac keytool unzip; do
  command -v "$t" >/dev/null || { echo "Ferramenta ausente: $t (veja o cabeçalho deste script)"; exit 1; }
done
[ -f "$ANDROID_JAR" ] || { echo "android.jar não encontrado em $ANDROID_JAR (pacote android-sdk-platform-23)"; exit 1; }

mkdir -p "$CACHE"
KOTLINC="$CACHE/kotlinc/bin/kotlinc"
if [ ! -x "$KOTLINC" ]; then
  echo "→ baixando compilador Kotlin $KOTLIN_VERSION"
  curl -fsSL -o "$CACHE/kotlin-compiler.zip" "https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN_VERSION/kotlin-compiler-$KOTLIN_VERSION.zip"
  (cd "$CACHE" && unzip -q -o kotlin-compiler.zip)
fi
STDLIB="$CACHE/kotlinc/lib/kotlin-stdlib.jar"

rm -rf "$OUT"
mkdir -p "$OUT"/{gen,rclasses,kclasses,assets/web,stdlib,dex,res}

echo "→ 1/7 interface web (produção)"
(cd "$ROOT" && NODE_ENV=production node scripts/build.mjs client >/dev/null)
cp -r "$APP/web/dist/." "$OUT/assets/web/"
find "$OUT/assets/web" -name '*.map' -delete

# Servidor padrão embutido (opcional)
cp -r "$APP/app/src/main/res/." "$OUT/res/"
# No Gradle este valor vem de resValue (gradle.properties: remotexServer); aqui, de REMOTEX_SERVER.
cat > "$OUT/res/values/server.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources><string name="default_server">${REMOTEX_SERVER:-https://remotex.example.com}</string></resources>
XML

echo "→ 2/7 recursos (aapt)"
# O manifesto do projeto segue o padrão do AGP 8 (sem package/uses-sdk); o aapt precisa deles.
sed 's#<manifest xmlns:android="http://schemas.android.com/apk/res/android">#<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.remotex.app">#' \
  "$APP/app/src/main/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
aapt package -f -m \
  -M "$OUT/AndroidManifest.xml" \
  -S "$OUT/res" \
  -A "$OUT/assets" \
  -I "$ANDROID_JAR" \
  -J "$OUT/gen" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -F "$OUT/resources.apk"

echo "→ 3/7 classe R (javac)"
javac -nowarn -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -d "$OUT/rclasses" $(find "$OUT/gen" -name '*.java') 2>&1 | grep -v -E "^warning|^Picked up|bootstrap classpath" || true

echo "→ 4/7 Kotlin (kotlinc)"
env -u NODE_OPTIONS "$KOTLINC" $(find "$APP/app/src/main/java" -name '*.kt') \
  -classpath "$ANDROID_JAR:$OUT/rclasses" \
  -jvm-target 1.8 -no-reflect -no-jdk \
  -Xlambdas=class -Xsam-conversions=class -Xno-call-assertions -Xno-param-assertions -Xno-receiver-assertions \
  -d "$OUT/kclasses" 2>&1 | grep -v -E "^Picked up|warning:" || true
[ -f "$OUT/kclasses/com/remotex/app/MainActivity.class" ] || { echo "Falha ao compilar o Kotlin"; exit 1; }

echo "→ 5/7 DEX (dx)"
(cd "$OUT/stdlib" && unzip -q -o "$STDLIB" -x 'META-INF/*')
"$DX" --dex --min-sdk-version=26 --output="$OUT/dex/classes.dex" "$OUT/kclasses" "$OUT/rclasses" "$OUT/stdlib" 2>&1 | grep -v "^Picked up" || true
[ -f "$OUT/dex/classes.dex" ] || { echo "Falha ao gerar classes.dex"; exit 1; }

echo "→ 6/7 empacotamento e alinhamento"
cp "$OUT/resources.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && aapt add "$OUT/unsigned.apk" classes.dex >/dev/null)
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "→ 7/7 assinatura (apksigner, esquemas v1+v2+v3)"
if [ -n "${RELEASE_KEYSTORE:-}" ]; then
  KS="$RELEASE_KEYSTORE"; ALIAS="${RELEASE_KEY_ALIAS:-remotex}"; PASS="${RELEASE_KEYSTORE_PASS:?defina RELEASE_KEYSTORE_PASS}"; NAME="RemoteX-$VERSION_NAME.apk"
else
  KS="$CACHE/debug.keystore"; ALIAS="androiddebugkey"; PASS="android"; NAME="RemoteX-$VERSION_NAME-debug.apk"
  [ -f "$KS" ] || keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=RemoteX Debug,O=RemoteX,C=BR" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-key-alias "$ALIAS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --min-sdk-version 26 --out "$OUT/$NAME" "$OUT/aligned.apk"
apksigner verify --min-sdk-version 26 --verbose "$OUT/$NAME"

mkdir -p "$ROOT/dist/downloads"
cp "$OUT/$NAME" "$ROOT/dist/downloads/"
echo "✓ APK: dist/downloads/$NAME ($(du -h "$OUT/$NAME" | cut -f1))"
