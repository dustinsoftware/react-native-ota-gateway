#!/bin/bash
# Android rotation scenario runner: Maestro cannot rotate the emulator, so
# this orchestrates part 1 (push RN Test 1, count to 2), a rotation to
# landscape via adb, part 2 (the RN surface survived in place: same count,
# still interactive), and restores portrait -- pass/fail is Maestro's.
set -euo pipefail
cd "$(dirname "$0")/.."

restore() {
  adb shell settings put system user_rotation 0
  adb shell settings put system accelerometer_rotation 1
}
trap restore EXIT

adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 0

maestro --device "${MAESTRO_DEVICE:-emulator-5554}" test .maestro/verify-rotation-android-part1.yaml

# Rotate to landscape and give the resize a moment to settle.
adb shell settings put system user_rotation 1
sleep 3

maestro --device "${MAESTRO_DEVICE:-emulator-5554}" test .maestro/verify-rotation-android-part2.yaml
echo "rotation scenario PASSED"
