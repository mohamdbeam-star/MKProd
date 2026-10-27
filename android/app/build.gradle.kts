import java.io.File

plugins {
    id("com.android.application")
}

// Version name comes from the repository's VERSION file; the build number from CI (or 1 locally).
val versionFile = rootProject.file("../VERSION")
val appVersionName = (System.getenv("APP_VERSION") ?: (if (versionFile.exists()) versionFile.readText().trim() else "1.0.0"))
val appVersionCode = (System.getenv("APP_VERSION_CODE") ?: "1").toInt()

android {
    namespace = "com.mkoussa.mkprod"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mkoussa.mkprod"
        minSdk = 24          // Android 7.0 and newer: every phone, tablet and foldable in use today
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        resourceConfigurations += listOf("en")
    }

    // Release signing from environment variables (set by the GitHub workflow from repository
    // secrets, or by a developer locally). Without them the release build is unsigned.
    val ksPath = System.getenv("KEYSTORE_FILE")
    if (ksPath != null && File(ksPath).exists()) {
        signingConfigs {
            create("release") {
                storeFile = File(ksPath)
                storeType = "PKCS12"   // what keytool (JDK 9+) and `openssl pkcs12 -export` both produce
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (ksPath != null && File(ksPath).exists()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true   // BuildConfig.VERSION_NAME is used in the user agent
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    // Jetpack WindowManager: hinge position and posture on foldables (book, tabletop, flat).
    implementation("androidx.window:window:1.3.0")
    implementation("androidx.window:window-java:1.3.0")
}
