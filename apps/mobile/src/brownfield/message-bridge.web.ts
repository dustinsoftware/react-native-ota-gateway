import type { NativeToRNMessage, RNToNativeMessage } from './message-bridge.types';

export type { RNToNativeMessage, NativeToRNMessage };

// Web stubs -- brownfield messaging is native-only

export function sendToNative(_message: RNToNativeMessage): void {
  // no-op on web
}

export function popToNative(_animated?: boolean): void {
  // no-op on web
}

export function useNativeMessages(
  _handler: (message: NativeToRNMessage) => void,
): void {
  // no-op on web
}
