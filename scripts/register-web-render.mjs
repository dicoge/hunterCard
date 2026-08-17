// Node --import hook for regressions that render a real `.tsx` screen through
// react-native-web. See web-render-hooks.mjs for what it aliases and why.
import { register } from 'node:module';

register('./web-render-hooks.mjs', import.meta.url);
