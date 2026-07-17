import ExpoModulesCore

/// RN-facing surface for the host-selected backend environment. Storage lives
/// in `HostEnvironmentRegistry`; this module only bridges the JS read. Returns
/// nil when no host has published an environment (standalone builds, dev).
public class HostEnvironmentModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HostEnvironment")

    Function("getEnvironment") { () -> String? in
      return HostEnvironmentRegistry.shared.current
    }
  }
}
