'use strict';

const fs = require('node:fs');

const UAP7_NAMESPACE = 'http://schemas.microsoft.com/appx/manifest/uap/windows10/7';

function patchManifestText(input) {
  let xml = String(input || '');
  if (!/<Package\b/.test(xml) || !/<Capabilities\b/.test(xml)) {
    throw new Error('Generated AppX manifest is missing Package or Capabilities.');
  }
  if (!/xmlns:uap7\s*=/.test(xml)) {
    xml = xml.replace(/<Package\b([^>]*)>/, (_match, attributes) => `<Package${attributes} xmlns:uap7="${UAP7_NAMESPACE}">`);
  }
  const ignored = xml.match(/IgnorableNamespaces=(["'])([^"']*)\1/);
  if (ignored && !ignored[2].split(/\s+/).includes('uap7')) {
    xml = xml.replace(ignored[0], `IgnorableNamespaces=${ignored[1]}${ignored[2]} uap7${ignored[1]}`);
  } else if (!ignored) {
    xml = xml.replace(/<Package\b([^>]*)>/, (_match, attributes) => `<Package${attributes} IgnorableNamespaces="uap7">`);
  }
  if (!/<uap7:Capability\s+Name=["']globalMediaControl["']\s*\/>/.test(xml)) {
    xml = xml.replace(/<\/Capabilities>/, '    <uap7:Capability Name="globalMediaControl" />\n  </Capabilities>');
  }
  return xml;
}

async function appxManifestCreated(manifestPath) {
  const original = fs.readFileSync(manifestPath, 'utf8');
  const patched = patchManifestText(original);
  fs.writeFileSync(manifestPath, patched, 'utf8');
}

exports.default = appxManifestCreated;
exports.patchManifestText = patchManifestText;
