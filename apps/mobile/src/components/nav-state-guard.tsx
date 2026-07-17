import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { checkpointNavPath } from '@/brownfield/nav-restore';

/**
 * Checkpoints the current pathname into the host-state store whenever it
 * changes, so a host-remounted surface that opted into `restoreNavState` can
 * resume where the user was (see src/brownfield/nav-restore.ts). Renders
 * nothing; a no-op on web/standalone and on surfaces that did not opt in.
 */
export function NavStateGuard() {
  const pathname = usePathname();

  useEffect(() => {
    checkpointNavPath(pathname);
  }, [pathname]);

  return null;
}
