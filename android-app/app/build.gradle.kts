import org.gradle.api.tasks.Exec

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val webDist = rootProject.file("web/dist")
val webAssets = layout.buildDirectory.dir("generated/webAssets")

android {
    namespace = "com.remotex.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.remotex.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        resValue("string", "default_server", (project.findProperty("remotexServer") as String?) ?: "https://remotex.example.com")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(webAssets)
}

kotlin {
    jvmToolchain(17)
}

// Compila a interface web (TypeScript) e copia para os assets do APK: assets/web/*
val buildWeb by tasks.registering(Exec::class) {
    workingDir = rootProject.file("..")
    commandLine("node", "scripts/build.mjs", "client")
    environment("NODE_ENV", "production")
}

val copyWeb by tasks.registering(Copy::class) {
    dependsOn(buildWeb)
    from(webDist) { exclude("**/*.map") }
    into(webAssets.map { it.dir("web") })
}

tasks.named("preBuild") { dependsOn(copyWeb) }
