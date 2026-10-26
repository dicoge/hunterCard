// Image asset module declarations. Metro / Expo / Webpack all resolve
// `import img from './foo.jpg'` at build time; without an ambient module
// declaration TypeScript rejects it as an unknown module. Values are
// platform-specific (Metro returns an ImageSourcePropType object, Webpack
// returns a string URL) — the loose `any` here keeps the compile passing
// on every target without a hand-rolled RN vs. Web split.
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.png';
declare module '*.gif';
declare module '*.webp';
declare module '*.svg';
