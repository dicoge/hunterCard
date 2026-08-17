// Stands in for expo native modules that cannot be imported outside a device
// runtime. Only reached from the push/price-alert transport, which renders
// nothing; any property read returns a no-op so an accidental call is loud in
// behaviour (undefined result) rather than a module-load crash.
const noop = () => undefined;

const stub = new Proxy(
  {},
  {
    get: (_target, prop) => (prop === 'default' ? stub : noop),
  },
);

export default stub;
export const getExpoPushTokenAsync = noop;
export const getPermissionsAsync = noop;
export const requestPermissionsAsync = noop;
export const setNotificationHandler = noop;
export const expoConfig = null;
