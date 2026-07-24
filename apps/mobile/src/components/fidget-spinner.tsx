import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';

import { checkpointHostState, readHostSavedState } from '@/brownfield/host-state';
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
 *
 * Under a brownfield host the spinner PERSISTS its motion in the host's
 * native store (src/brownfield/host-state.ts): a frame callback measures the
 * live angular velocity, a throttled interval checkpoints {angle, velocity},
 * and a fresh mount resumes the decay from the saved values -- so switching
 * native tabs (or even killing the process) and coming back finds the spinner
 * coasting exactly where it was dismissed. Time does not advance while the
 * surface is unmounted: the state is frozen at the last checkpoint.
 */

const SPINNER_SIZE = 240;
const LOBE_COUNT = 3;
const LOBE_RADIUS = SPINNER_SIZE * 0.32;
const LOBE_DIAMETER = SPINNER_SIZE * 0.42;
const HUB_DIAMETER = SPINNER_SIZE * 0.34;
const CAP_DIAMETER = SPINNER_SIZE * 0.16;
// Per-millisecond friction factor for the coast, applied by the frame
// callback (not withDecay, whose internal stop-epsilon would halt a slow spin
// abruptly). 0.99999 halves the velocity roughly every 70 seconds: a hand-spun
// spinner keeps going more or less indefinitely, which is both the toy's charm
// and what makes the persistence demo unmistakable after any roundtrip.
const FRICTION = 0.99999;
// A center-adjacent release can divide by a tiny radius and produce an absurd
// angular velocity; cap the coast at a fast-but-plausible spin.
const MAX_VELOCITY = 60;
/** Below this (rad/s) the spinner counts as idle: not worth resuming. */
const IDLE_VELOCITY = 0.2;
/** How often live motion is checkpointed into the host store. */
const CHECKPOINT_MS = 400;
/** Key of this component's slice in the host's saved-state store. */
const STATE_KEY = 'spinner';

interface SpinnerState extends Record<string, unknown> {
  angle: number;
  velocity: number;
}

/** A sample of the spinner's live motion, for read-outs beside it. */
export interface SpinnerSample {
  spinning: boolean;
  velocity: number;
}

export function FidgetSpinner({ onSample }: { onSample?: (sample: SpinnerSample) => void }) {
  const saved = useRef(readHostSavedState<SpinnerState>(STATE_KEY)).current;
  const rotation = useSharedValue(saved?.angle ?? 0);
  // Inertial velocity while coasting (finger up). The frame callback owns the
  // integration; a drag sets it on release and zeroes it on touch-down.
  const coastVelocity = useSharedValue(saved?.velocity ?? 0);
  const liveVelocity = useSharedValue(0);
  const frameRotation = useSharedValue(saved?.angle ?? 0);
  const centerX = useSharedValue(SPINNER_SIZE / 2);
  const centerY = useSharedValue(SPINNER_SIZE / 2);
  const previousAngle = useSharedValue(0);
  const [size, setSize] = useState(SPINNER_SIZE);

  // The UI-thread physics loop. While coasting it integrates
  // rotation += v*dt and applies per-ms friction; during a drag (coast
  // velocity zeroed) the gesture owns rotation. Either way the live velocity
  // is measured from the per-frame rotation delta -- that measurement is what
  // checkpoints (and the read-out) report. A persisted coast resumes here
  // automatically: coastVelocity initializes from the saved slice.
  useFrameCallback((frame) => {
    const dt = frame.timeSincePreviousFrame;
    if (dt !== null && dt > 0) {
      if (Math.abs(coastVelocity.value) > IDLE_VELOCITY) {
        rotation.value += (coastVelocity.value * dt) / 1000;
        coastVelocity.value *= Math.pow(FRICTION, dt);
      } else if (coastVelocity.value !== 0) {
        coastVelocity.value = 0;
      }
      liveVelocity.value = ((rotation.value - frameRotation.value) * 1000) / dt;
    }
    frameRotation.value = rotation.value;
  });

  // Throttled checkpoint into the host's native store. Continuous (not an
  // unmount hook): a surface teardown or force-stop can outrun a final post,
  // and a <=CHECKPOINT_MS-stale snapshot is indistinguishable to the eye. The
  // trailing idle write records that a spinner watched to a stop STAYS
  // stopped on the next mount. Reading .value from the JS thread is a
  // supported synchronous SharedValue access.
  const wasSpinning = useRef(false);
  useEffect(() => {
    const id = setInterval(() => {
      const velocity = liveVelocity.value;
      const spinning = Math.abs(velocity) > IDLE_VELOCITY;
      onSample?.({ spinning, velocity });
      if (spinning || wasSpinning.current) {
        checkpointHostState(STATE_KEY, {
          angle: rotation.value,
          velocity: spinning ? velocity : 0,
        } satisfies SpinnerState);
      }
      wasSpinning.current = spinning;
    }, CHECKPOINT_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setSize(Math.min(width, height));
    centerX.value = width / 2;
    centerY.value = height / 2;
  }

  const pan = Gesture.Pan()
    .onBegin((event) => {
      // A fresh touch interrupts any coasting inertia so the spinner snaps to
      // tracking the finger rather than fighting the physics loop.
      coastVelocity.value = 0;
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
      coastVelocity.value = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity));
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
