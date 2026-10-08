const { withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

/**
 * react-native-background-actions ships a bare <service> entry; Android 14+
 * requires an explicit foregroundServiceType plus the matching permission.
 * The library's manifest merges with ours, so we re-declare the service with
 * the connectedDevice type (BLE heart-rate sensor is the foreground device).
 */
function withBleForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    const application = manifest.application[0];
    application.service ??= [];

    const existing = application.service.find(
      (s) => s.$['android:name'] === SERVICE_NAME,
    );
    if (existing) {
      existing.$['android:foregroundServiceType'] = 'connectedDevice';
    } else {
      application.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:exported': 'false',
          'android:foregroundServiceType': 'connectedDevice',
          'tools:replace': 'android:foregroundServiceType',
        },
      });
    }
    return config;
  });
}

module.exports = withBleForegroundService;
