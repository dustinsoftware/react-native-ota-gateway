import Foundation

/// Process-wide holder for the backend environment the native HOST app is
/// pointed at ("development" or "production"). The brownfield entry point
/// (`initializeUpdates(environment:)`, generated into OtaGatewayLib.swift
/// by plugins/withBrownfieldUpdates.js) publishes the host's selection here
/// BEFORE React Native starts, so the JS layer can resolve the matching
/// gateway URL instead of trusting a value baked into the bundle or cached in
/// an OTA manifest.
public final class HostEnvironmentRegistry {
  public static let shared = HostEnvironmentRegistry()

  private let lock = NSLock()
  private var environment: String?

  private init() {}

  /// Publishes the host-selected environment. Expected values are
  /// "development" or "production" (the JS wrapper treats anything else as
  /// unset and falls back toward production).
  public func configure(environment: String) {
    lock.lock()
    defer { lock.unlock() }
    self.environment = environment
  }

  var current: String? {
    lock.lock()
    defer { lock.unlock() }
    return environment
  }
}
