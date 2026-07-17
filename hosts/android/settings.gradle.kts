pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        // The brownfield AAR (dev.otagateway:otagatewaylib) is published to the
        // local Maven repository by `brownfield publish:android`. It must come
        // first so the host resolves the locally-built artifact.
        mavenLocal()
        google()
        mavenCentral()
    }
}

rootProject.name = "ota-gateway-host"

include(":app")
