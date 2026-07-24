import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

import { sendToNative } from '@/brownfield/message-bridge';
import { isBrownfieldHost } from '@/brownfield/runtime';
import { deferReloadUntilIdle, isJourneyActive } from '@/utils/journey-lock';

/**
 * Reloads the JS app so a freshly-downloaded OTA update takes effect.
 *
 * In a brownfield app the native host owns the React Native view lifecycle, so
 * expo-updates' `reloadAsync()` crashes (its RelaunchProcedure can't restart a
 * native-hosted RN root). Instead we post a `reload` message to the host, which
 * tears down and re-creates the RN root -- restarting the runtime so it picks
 * up the newly-downloaded update.
 *
 * Standalone native and web fall back to the normal `Updates.reloadAsync()`.
 *
 * While a JOURNEY is active (src/utils/journey-lock.ts) the restart is
 * deferred, not dropped: it fires as soon as the last journey ends. Restarting
 * the runtime mid-funnel would destroy in-flight work; the downloaded update
 * loses nothing by waiting.
 */
export async function reloadApp(): Promise<void> {
  if (isJourneyActive()) {
    deferReloadUntilIdle(reloadApp);
    return;
  }
  if (Platform.OS !== 'web' && isBrownfieldHost()) {
    sendToNative({ type: 'reload' });
    return;
  }
  await Updates.reloadAsync();
}
