const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

/**
 * Enables Android Auto Backup so the local SQLite data (events, sessions,
 * settings) is silently copied to the user's Google account and restored
 * on reinstall — uninstalling the app no longer wipes history.
 *
 * Requires two res/xml rule files (dataExtractionRules for API 31+,
 * fullBackupContent for older) plus manifest attributes, none of which
 * app.json can express — hence a config plugin.
 */

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <include domain="database" path="." />
        <include domain="sharedpref" path="." />
    </cloud-backup>
</data-extraction-rules>
`;

const FULL_BACKUP_CONTENT = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <include domain="database" path="." />
    <include domain="sharedpref" path="." />
</full-backup-content>
`;

function withAndroidAutoBackup(config) {
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'data_extraction_rules.xml'),
        DATA_EXTRACTION_RULES,
      );
      fs.writeFileSync(
        path.join(xmlDir, 'full_backup_content.xml'),
        FULL_BACKUP_CONTENT,
      );
      return cfg;
    },
  ]);

  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application[0];
    application.$['android:allowBackup'] = 'true';
    application.$['android:dataExtractionRules'] =
      '@xml/data_extraction_rules';
    application.$['android:fullBackupContent'] = '@xml/full_backup_content';
    return cfg;
  });
}

module.exports = withAndroidAutoBackup;
