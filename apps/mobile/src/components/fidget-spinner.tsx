import React, { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
} from 'react-native-reanimated';

import { Colors } from '@/constants/theme';
import {
  accumulateAngle,
  angularVelocityFromLinear,
  pointerAngle,
} from '@/components/spinner-math';

/**
 * Interactive three-lobed fidget spinner. Dragging anywhere on the spinner
 * rotates it about its measured center: each move adds the normalized
 * shortest-path angular delta (so crossing the +/-180 seam is smooth), and
 * releasing lets it coast with decaying inertia. Starting a new drag cancels
 * any in-flight inertia so the spinner tracks the finger immediately.
 *
 * Rotation runs entirely on the UI thread via Reanimated + gesture-handler
 * worklets; the angle/velocity math lives in `spinner-math.ts`.
 */

const SPINNER_SIZE = 240;
const LOBE_COUNT = 3;
const LOBE_RADIUS = SPINNER_SIZE * 0.32;
const LOBE_DIAMETER = SPINNER_SIZE * 0.42;
const HUB_DIAMETER = SPINNER_SIZE * 0.34;
const CAP_DIAMETER = SPINNER_SIZE * 0.16;
const DECELERATION = 0.997;

export function FidgetSpinner() {
  const rotation = useSharedValue(0);
  const centerX = useSharedValue(SPINNER_SIZE / 2);
  const centerY = useSharedValue(SPINNER_SIZE / 2);
  const previousAngle = useSharedValue(0);
  const [size, setSize] = useState(SPINNER_SIZE);

  function onLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setSize(Math.min(width, height));
    centerX.value = width / 2;
    centerY.value = height / 2;
  }

  const pan = Gesture.Pan()
    .onBegin((event) => {
      // A fresh touch interrupts any coasting inertia so the spinner snaps to
      // tracking the finger rather than fighting the decay animation.
      cancelAnimation(rotation);
      previousAngle.value = pointerAngle(event.x, event.y, centerX.value, centerY.value);
    })
    .onUpdate((event) => {
      const current = pointerAngle(event.x, event.y, centerX.value, centerY.value);
      rotation.value = accumulateAngle(rotation.value, previousAngle.value, current);
      previousAngle.value = current;
    })
    .onEnd((event) => {
      const velocity = angularVelocityFromLinear(
        event.x,
        event.y,
        centerX.value,
        centerY.value,
        event.velocityX,
        event.velocityY,
      );
      rotation.value = withDecay({ velocity, deceleration: DECELERATION });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotateZ: `${rotation.value}rad` }],
  }));

  const scale = size / SPINNER_SIZE;
  const lobes = Array.from({ length: LOBE_COUNT }, (_, i) => {
    const angle = (i / LOBE_COUNT) * Math.PI * 2 - Math.PI / 2;
    return {
      key: i,
      left: (size / 2) + Math.cos(angle) * LOBE_RADIUS * scale - (LOBE_DIAMETER * scale) / 2,
      top: (size / 2) + Math.sin(angle) * LOBE_RADIUS * scale - (LOBE_DIAMETER * scale) / 2,
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        onLayout={onLayout}
        style={[styles.touchArea, { width: SPINNER_SIZE, height: SPINNER_SIZE }]}
        accessibilityRole="image"
        accessibilityLabel="Decorative fidget spinner">
        <Animated.View style={[styles.body, { width: size, height: size }, animatedStyle]}>
          {lobes.map((lobe) => (
            <View
              key={lobe.key}
              style={[
                styles.lobe,
                {
                  width: LOBE_DIAMETER * scale,
                  height: LOBE_DIAMETER * scale,
                  borderRadius: (LOBE_DIAMETER * scale) / 2,
                  left: lobe.left,
                  top: lobe.top,
                },
              ]}>
              <View
                style={[
                  styles.lobeCap,
                  {
                    width: CAP_DIAMETER * scale,
                    height: CAP_DIAMETER * scale,
                    borderRadius: (CAP_DIAMETER * scale) / 2,
                  },
                ]}
              />
            </View>
          ))}
          <View
            style={[
              styles.hub,
              {
                width: HUB_DIAMETER * scale,
                height: HUB_DIAMETER * scale,
                borderRadius: (HUB_DIAMETER * scale) / 2,
                left: (size - HUB_DIAMETER * scale) / 2,
                top: (size - HUB_DIAMETER * scale) / 2,
              },
            ]}>
            <View
              style={[
                styles.hubCap,
                {
                  width: CAP_DIAMETER * scale,
                  height: CAP_DIAMETER * scale,
                  borderRadius: (CAP_DIAMETER * scale) / 2,
                },
              ]}
            />
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  touchArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  lobe: {
    position: 'absolute',
    backgroundColor: Colors.dark.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lobeCap: {
    backgroundColor: Colors.dark.background,
  },
  hub: {
    position: 'absolute',
    backgroundColor: Colors.dark.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hubCap: {
    backgroundColor: Colors.dark.text,
  },
});
