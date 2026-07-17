// Type surface for the platform-split message bridge. At runtime Metro resolves
// `./message-bridge` to message-bridge.native.ts (native) or message-bridge.web.ts
// (web); this declaration lets TypeScript resolve the bare `./message-bridge`
// import. Keep it in sync with the .native/.web exports.
import type { NativeToRNMessage, RNToNativeMessage } from './message-bridge.types';

export type { RNToNativeMessage, NativeToRNMessage };

export function sendToNative(message: RNToNativeMessage): void;
export function popToNative(animated?: boolean): void;
export function useNativeMessages(
  handler: (message: NativeToRNMessage) => void,
): void;
