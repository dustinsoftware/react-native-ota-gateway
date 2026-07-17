Pod::Spec.new do |s|
  s.name           = 'ExpoHostEnvironment'
  s.version        = '1.0.0'
  s.summary        = 'Expo module exposing the host-selected backend environment to JS'
  s.description    = 'Custom Expo Module that publishes the native host app\'s selected backend environment (development or production) to the JS layer, so gateway URLs can be resolved at runtime instead of baked into the bundle.'
  s.author         = 'OtaGateway'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
