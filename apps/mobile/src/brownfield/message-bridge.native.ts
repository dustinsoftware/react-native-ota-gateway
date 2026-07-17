import ReactNativeBrownfield from '@callstack/react-native-brownfield';
import type { MessageEvent } from '@callstack/react-native-brownfield';
import { useEffect, useRef } from 'react';

import { nativeToRNSchema } from './message-bridge.types';
import type { NativeToRNMessage, RNToNativeMessage } from './message-bridge.types';

export type { RNToNativeMessage, NativeToRNMessage };

export function sendToNative(message: RNToNativeMessage): void {
  ReactNativeBrownfield.postMessage(message);
}

export function popToNative(animated = true): void {
  ReactNativeBrownfield.popToNative(animated);
}

/**
 * Subscribe to typed messages from the native host app.
 * Uses a ref to avoid re-subscribing when the handler identity changes.
 * Invalid messages are silently dropped (logged in __DEV__).
 */
export function useNativeMessages(
  handler: (message: NativeToRNMessage) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const sub = ReactNativeBrownfield.onMessage((event: MessageEvent) => {
      const result = nativeToRNSchema.safeParse(event.data);
      if (result.success) {
        handlerRef.current(result.data);
      } else if (__DEV__) {
        console.warn(
          '[message-bridge] Invalid message from native:',
          event.data,
          result.error.issues,
        );
      }
    });
    return () => sub.remove();
  }, []);
}
