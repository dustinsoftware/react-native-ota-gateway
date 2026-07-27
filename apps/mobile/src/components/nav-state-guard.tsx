import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { checkpointActiveTab, checkpointNavPath } from '@/brownfield/nav-restore';

/**
 * Checkpoints the current pathname into the host-state store whenever it
 * changes, so a host-remounted surface (or an in-place OTA reload) that opted
 * into `restoreNavState` can resume where the user was (see
 * src/brownfield/nav-restore.ts).
 *
 * Both writes are DERIVED from the OBSERVED pathname:
 *  - `checkpointNavPath` files the path under its owning tab's `nav:<tab>`
 *    slice, and
 *  - `checkpointActiveTab` records that owning tab as `nav:activeTab`.
 * Attribution follows where the user actually IS, so an in-place `selectTab`
 * swap can never mis-file a lagging emission under the wrong tab. Renders
 * nothing; a no-op on web/standalone and on surfaces that did not opt in (both
 * checkpoint functions gate on the restore flag and on the path naming a known
 * tab).
 */
export function NavStateGuard() {
  const pathname = usePathname();

  useEffect(() => {
    checkpointNavPath(pathname);
    checkpointActiveTab(pathname);
  }, [pathname]);

  return null;
}
