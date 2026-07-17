import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { getHostEnvironment } from '../../modules/host-environment';

import { resolveGatewayUrl, type GatewayExtra } from './gateway-url';

/**
 * Gateway for BFF requests. In brownfield builds the native host publishes
 * its selected environment before RN boots and this resolves the matching
 * host from extra.gatewayUrls; otherwise the build-selected extra.gatewayUrl
 * applies, and the last resort is production, never dev (see
 * src/api/gateway-url.ts for the full precedence rationale).
 */
const GATEWAY_URL = resolveGatewayUrl(
  getHostEnvironment(),
  Constants.expoConfig?.extra as GatewayExtra | undefined,
);

/**
 * Base URL for BFF API requests.
 * - EXPO_PUBLIC_API_BASE_URL env var: override (e.g. a mock backend)
 * - Web: empty string (paths like /api/... resolve against current origin)
 * - Native debug: local Expo dev server
 * - Native release: the resolved gateway (host-selected environment in
 *   brownfield, else the build-selected bake, else production)
 */
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL
  || (Platform.OS === 'web'
    ? ''
    : __DEV__
      ? 'http://localhost:8081'
      : GATEWAY_URL);
