// zustand StateStorage persisted to one JSON file per simulated device
// (process.env.DEVICE_STORE), so killing and re-spawning a device process is a real
// app restart for the account-sync two-device regression. Test-only.
import fs from 'node:fs';

const file = process.env.DEVICE_STORE;
const read = () => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};
const write = (data) => fs.writeFileSync(file, JSON.stringify(data));

const storage = {
  getItem: (name) => { const d = read(); return Object.prototype.hasOwnProperty.call(d, name) ? d[name] : null; },
  setItem: (name, value) => { const d = read(); d[name] = value; write(d); },
  removeItem: (name) => { const d = read(); delete d[name]; write(d); },
};
export default storage;
