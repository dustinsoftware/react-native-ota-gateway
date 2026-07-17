package expo.modules.hostenvironment

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * RN-facing surface for the host-selected backend environment. Storage lives
 * in [HostEnvironment]; this module only bridges the JS read. Returns null
 * when no host has published an environment (standalone builds, dev).
 */
class HostEnvironmentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostEnvironment")

    Function("getEnvironment") {
      HostEnvironment.current
    }
  }
}
