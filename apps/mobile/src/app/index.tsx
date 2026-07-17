import { Redirect } from 'expo-router';
import React from 'react';

/**
 * Root route (`/`). There is no Home screen: `/` redirects to `/developer`,
 * which now carries the OTA delivery proof (BUNDLE_MARKER). Keeping `/` as a
 * valid route means a native host that mounts the `/` URL still resolves,
 * while the visible tabs are Developer, Sky, and Spinner only.
 */
export default function IndexRedirect() {
  return <Redirect href="/developer" />;
}
