import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { cloudLayers, cloudPositions, type CloudLayerConfig } from './sky-layout';

/**
 * Decorative responsive "blue sky" with several parallax cloud layers drifting
 * at varied speeds. Purely cosmetic and non-interactive (`pointerEvents="none"`)
 * so a native brownfield host can replace the RN surface at any time; every
 * layer's loop is stopped on unmount, leaving no orphaned animations.
 */

const SKY_COLOR = '#5AA9E6';
const SKY_HIGHLIGHT = '#BFE3FF';
const CLOUD_COLOR = '#FFFFFF';
const BASE_CLOUD_WIDTH = 120;
const BASE_CLOUD_HEIGHT = 44;

function Cloud({ width, height }: { width: number; height: number }) {
  return (
    <View style={{ width, height }}>
      <View
        style={[
          styles.cloudBody,
          { width, height: height * 0.6, top: height * 0.4, borderRadius: height },
        ]}
      />
      <View
        style={[
          styles.cloudPuff,
          { width: width * 0.5, height: width * 0.5, left: width * 0.12, borderRadius: width },
        ]}
      />
      <View
        style={[
          styles.cloudPuff,
          { width: width * 0.6, height: width * 0.6, left: width * 0.38, borderRadius: width },
        ]}
      />
    </View>
  );
}

/** One screen-wide strip of clouds; two of these tile to loop seamlessly. */
function CloudStrip({ layer, screenWidth }: { layer: CloudLayerConfig; screenWidth: number }) {
  const cloudWidth = BASE_CLOUD_WIDTH * layer.scale;
  const cloudHeight = BASE_CLOUD_HEIGHT * layer.scale;
  const positions = cloudPositions(screenWidth, layer.cloudCount);
  return (
    <View style={[styles.strip, { width: screenWidth }]}>
      {positions.map((x, i) => (
        <View key={i} style={{ position: 'absolute', left: x }}>
          <Cloud width={cloudWidth} height={cloudHeight} />
        </View>
      ))}
    </View>
  );
}

function Layer({ layer, screenWidth }: { layer: CloudLayerConfig; screenWidth: number }) {
  const translateX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Scroll one screen width, then snap back to 0. Because two identical
    // strips sit side by side, the second occupies the first's old position at
    // the moment of the snap, so the wrap is seamless. translateX is
    // layout-independent (native driver safe); web has no native driver.
    const loop = Animated.loop(
      Animated.timing(translateX, {
        toValue: -screenWidth,
        duration: layer.durationMs,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [translateX, screenWidth, layer.durationMs]);

  return (
    <Animated.View
      style={[
        styles.layer,
        { top: layer.top, opacity: layer.opacity, transform: [{ translateX }] },
      ]}>
      <CloudStrip layer={layer} screenWidth={screenWidth} />
      <View style={{ position: 'absolute', left: screenWidth }}>
        <CloudStrip layer={layer} screenWidth={screenWidth} />
      </View>
    </Animated.View>
  );
}

export function Sky() {
  const { width, height } = useWindowDimensions();
  const layers = cloudLayers(width, height);

  return (
    <View pointerEvents="none" style={styles.container}>
      <View style={styles.highlight} />
      {layers.map((layer) => (
        <Layer key={layer.index} layer={layer} screenWidth={width} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: SKY_COLOR,
    overflow: 'hidden',
  },
  highlight: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: SKY_HIGHLIGHT,
    opacity: 0.35,
    height: '45%',
  },
  layer: {
    position: 'absolute',
    left: 0,
    flexDirection: 'row',
  },
  strip: {
    height: BASE_CLOUD_HEIGHT * 2,
  },
  cloudBody: {
    position: 'absolute',
    backgroundColor: CLOUD_COLOR,
  },
  cloudPuff: {
    position: 'absolute',
    top: 0,
    backgroundColor: CLOUD_COLOR,
  },
});
