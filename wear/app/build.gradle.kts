plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.voxarcade.wear"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.voxarcade.wear"
        minSdk = 30          // Wear OS 3+
        targetSdk = 34       // Wear OS 5 (Galaxy Watch 7)
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Pick up the web app copied in by copyWebApp (assets/web/...).
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
}

// ---------------------------------------------------------------------------
// Bundle the ProsodyBall web app into the APK's assets.
//
// The canonical web app lives at the repo root (two levels up from this module).
// We copy the files we actually need into src/main/assets/web/ before the
// assets are merged, so the existing engine is reused verbatim — the root
// files are never edited. The watch adaptation layer (watch.css / watch-boot.js)
// is copied from wear/assets-overlay/ into the same folder.
// ---------------------------------------------------------------------------
val repoRoot = rootProject.projectDir.parentFile
val generatedWebAssets = layout.buildDirectory.dir("generated/webAssets/web")

val copyWebApp by tasks.registering(Copy::class) {
    description = "Copy the ProsodyBall web app + watch overlay into the APK assets"

    // Core web app (reused unchanged).
    from(repoRoot) {
        include(
            "index.html",
            "app.js",
            "dsp-utils.js",
            "calibration-wizard.js",
            "bulb-controller.js",
            "necklace-controller.js",
            "performance-monitor.js"
        )
    }
    // Watch-specific overlay injected by MainActivity at runtime.
    from(rootProject.projectDir.resolve("assets-overlay")) {
        include("watch.css", "watch-boot.js", "watch-haptics.cjs")
    }

    into(generatedWebAssets)
}

tasks.named("preBuild") {
    dependsOn(copyWebApp)
}
