// Projeto Android do RemoteX (Android Studio / Gradle).
// Alternativa sem SDK do Google: tools/build-apk.sh
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "RemoteX"
include(":app")
