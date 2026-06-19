plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.org.json)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // DSP tests consume the web app's audio fixtures directly from the repo root
    // so the Kotlin port and the JS analyzer are validated against the same data.
    systemProperty("prosodyball.fixtures", rootDir.resolve("../fixtures").absolutePath)
}
