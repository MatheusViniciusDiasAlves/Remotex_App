# Mantém os métodos expostos ao JavaScript (window.RemoteXNative)
-keepclassmembers class com.remotex.app.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
