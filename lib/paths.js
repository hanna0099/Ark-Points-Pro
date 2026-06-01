const path = require('path');
const os = require('os');

function getUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ArkPointsPro');
  }
  return path.join(process.env.APPDATA || os.homedir(), 'ArkPointsPro');
}

module.exports = { getUserDataDir };
