import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';

import { useNativeMessages } from '@/brownfield/message-bridge';
import { applySelectTab } from '@/brownfield/nav-restore';

/**
 * Drives shell tab changes on the single persistent RN root. Under the
 * single-root design (docs/single-root-tabs-experiment.md) the host no longer
 * remounts a surface per tab tap; it posts a `selectTab` bridge message and
 * this listener swaps the tab in place via `router.replace`, re-pointing nav
 * restore at the new tab (see src/brownfield/nav-restore.ts). Renders nothing;
 * a no-op on web/standalone (useNativeMessages is a no-op off a brownfield
 * host), so it is safe to mount everywhere alongside NavStateGuard. Unknown
 * routes are ignored inside applySelectTab (the bridge is untrusted input).
 */
export function TabSelectGuard() {
  const router = useRouter();
  useNativeMessages((message) => {
    if (message.type !== 'selectTab') return;
    applySelectTab(message.route, (path) => router.replace(path as Href));
  });

  return null;
}
