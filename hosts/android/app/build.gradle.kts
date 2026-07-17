import com.android.build.api.attributes.BuildTypeAttr

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The brownfield AAR's native libraries (.so) -- the app's Fabric codegen
// (libappmodules.so, libreact_codegen_rnscreens.so, ...) -- are compiled against
// the RELEASE variant of react-android / hermes-android. react-android publishes
// separate debug/release variants of libreactnative.so whose C++ Props struct
// layouts differ (the debug variant carries extra members). A host DEBUG build
// otherwise resolves the DEBUG react-android variant, so at runtime the debug
// libreactnative's HostPlatformViewProps constructor writes debug-only fields past
// the end of the smaller release-layout object the AAR's codegen allocated -->
// native write SIGSEGV during Fabric ComponentDescriptorRegistry construction at
// launch (crash frame: HostPlatformViewProps::HostPlatformViewProps(...)+124, via
// RawPropsParser::prepare / installFabricUIManager). Force variant-aware
// substitution to the RELEASE variant so Gradle resolves the matching ABI in every
// build type. Versions MUST track the AAR's react-native version (react-android
// 0.83.6 <-> hermes-android 0.14.1).
configurations.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.facebook.react:react-android"))
            .using(
                variant(module("com.facebook.react:react-android:0.83.6")) {
                    attributes {
                        attribute(
                            BuildTypeAttr.ATTRIBUTE,
                            objects.named(BuildTypeAttr::class.java, "release"),
                        )
                    }
                },
            )
        substitute(module("com.facebook.hermes:hermes-android"))
            .using(
                variant(module("com.facebook.hermes:hermes-android:0.14.1")) {
                    attributes {
                        attribute(
                            BuildTypeAttr.ATTRIBUTE,
                            objects.named(BuildTypeAttr::class.java, "release"),
                        )
                    }
                },
            )
    }
}

android {
    // Deliberately still dev.otagateway.host while applicationId is
    // com.regalcinemas.reactnativetest. namespace only decides which package R
    // and BuildConfig are generated into, and the host's Kotlin sources are in
    // dev.otagateway.host -- keeping the two aligned is what lets the sources
    // use unqualified `R.` and the manifest use relative names (.RNHostActivity).
    // Renaming this without also moving every Kotlin file breaks both.
    namespace = "dev.otagateway.host"
    // Mirrors the generated apps/mobile/android project (compileSdk 36, minSdk 24).
    compileSdk = 36

    defaultConfig {
        // Device/store identity, and the id Maestro flows and adb target.
        applicationId = "com.regalcinemas.reactnativetest"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            // The otagatewaylib AAR publishes only a "release" variant
            // (singleVariant("release") in the config plugin), so the host's
            // debug build must fall back to the release variant of the AAR.
            matchingFallbacks += "release"
        }
        release {
            isMinifyEnabled = false
            matchingFallbacks += "release"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            // The AAR and react-android both ship these; take the first so the
            // build does not fail on duplicate native libraries.
            pickFirsts += "**/libc++_shared.so"
            pickFirsts += "**/libfbjni.so"
        }
    }
}

dependencies {
    // The brownfield artifact from mavenLocal(); brings React Native, Hermes,
    // expo-updates, and the OtaGatewayApp module transitively.
    // The version must track apps/mobile/app.json expo.version -- the publishing
    // plugin (withBrownfieldAndroidPublishing.js) stamps the AAR coordinate from
    // it (<version>-SNAPSHOT). plugins/__tests__/drift-guard.test.ts enforces this.
    implementation("dev.otagateway:otagatewaylib:0.1.0-SNAPSHOT")

    // Minimal androidx surface for a native host whose launcher shell hosts a
    // brownfield fragment plus a settings Activity. No Compose, no DI framework.
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.core:core-ktx:1.13.1")

    // Material Components for the standard native BottomNavigationView chrome in
    // the host shell (RNHostActivity). 1.12.0 is the current stable release and
    // is compatible with compileSdk 36 and androidx.appcompat 1.7.0.
    implementation("com.google.android.material:material:1.12.0")
}
