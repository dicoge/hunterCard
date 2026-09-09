#!/usr/bin/env node
// DIC-1380 W7 CR — `nav_favorites` MUST route to FavoritesScreen.
//
// Mac-Codex reproduced that the drawer entry labelled "我的收藏" opened
// CollectionScreen — the unrelated ownership browser — because the
// Drawer.Screen name="Collection" was reusing the nav_favorites title.
// The bookmark listing FavoritesScreen was never wired into the router,
// so `navigation.navigate('Favorites')` failed and the drawer entry
// misled the user.
//
// This route-level regression pins the AppNavigator source:
//   * a Drawer.Screen named "Favorites" exists AND uses FavoritesScreen
//     as the component
//   * a Drawer.Screen named "Collection" that also opens FavoritesScreen
//     would be equally wrong; assert Collection stays on CollectionScreen
//   * the MainDrawerParamList carries `Favorites: undefined` so a typed
//     navigate() call compiles
//   * the `nav_favorites` title is attached to the Favorites screen, and
//     `nav_collection` is attached to Collection

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let passed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const navSrc = fs.readFileSync(path.join(repoRoot, 'src/navigation/AppNavigator.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(repoRoot, 'src/types/index.ts'), 'utf8');

// Import path must exist so the wiring can actually resolve.
ok(
  'AppNavigator imports FavoritesScreen',
  /import FavoritesScreen from ['"]\.\.\/screens\/FavoritesScreen['"]/.test(navSrc),
);

// A Drawer.Screen name="Favorites" that binds FavoritesScreen — the block
// must exist AS ONE unit, not split across two unrelated Drawer.Screen
// entries. Regex on multiline lets us prove the pairing.
const favoritesBlockRe = /<Drawer\.Screen[^>]*name=["']Favorites["'][\s\S]*?component=\{FavoritesScreen\}/;
ok(
  '`Favorites` drawer route binds the FavoritesScreen component (DIC-1380 W7 CR)',
  favoritesBlockRe.test(navSrc),
  'the Favorites drawer entry must open FavoritesScreen, not CollectionScreen',
);

// The `Favorites` block must attach the `nav_favorites` translation as
// its drawer title — otherwise the label is broken even if the route
// resolves. Look inside the same block.
const favoritesBlock = navSrc.match(/<Drawer\.Screen[^>]*name=["']Favorites["'][\s\S]*?\/>/);
ok(
  '`Favorites` drawer route uses `nav_favorites` as its title',
  favoritesBlock && /title:\s*t\(['"]nav_favorites['"]\)/.test(favoritesBlock[0]),
);

// Guard against regressions: Collection route MUST NOT open FavoritesScreen
// (the exact confusion the CR flagged), and Collection MUST carry
// nav_collection now, not nav_favorites.
const collectionBlock = navSrc.match(/<Drawer\.Screen[^>]*name=["']Collection["'][\s\S]*?\/>/);
ok(
  '`Collection` drawer route stays on CollectionScreen (does not open FavoritesScreen)',
  collectionBlock
    && /component=\{CollectionScreen\}/.test(collectionBlock[0])
    && !/component=\{FavoritesScreen\}/.test(collectionBlock[0]),
);
ok(
  '`Collection` drawer route uses `nav_collection` (not `nav_favorites`) as its title (DIC-1380 W7 CR)',
  collectionBlock
    && /title:\s*t\(['"]nav_collection['"]\)/.test(collectionBlock[0])
    && !/title:\s*t\(['"]nav_favorites['"]\)/.test(collectionBlock[0]),
);

// Types: MainDrawerParamList must include `Favorites: undefined` so
// `navigation.navigate('Favorites')` compiles.
ok(
  'MainDrawerParamList declares `Favorites: undefined`',
  /MainDrawerParamList\s*=\s*\{[\s\S]*Favorites:\s*undefined/.test(typesSrc),
);

// i18n keys the route depends on
const zh = fs.readFileSync(path.join(repoRoot, 'src/i18n/locales/zh.ts'), 'utf8');
const ja = fs.readFileSync(path.join(repoRoot, 'src/i18n/locales/ja.ts'), 'utf8');
ok('zh i18n declares nav_favorites', /nav_favorites:\s*['"][^'"]+['"]/.test(zh));
ok('zh i18n declares nav_collection', /nav_collection:\s*['"][^'"]+['"]/.test(zh));
ok('ja i18n declares nav_favorites', /nav_favorites:\s*['"][^'"]+['"]/.test(ja));
ok('ja i18n declares nav_collection', /nav_collection:\s*['"][^'"]+['"]/.test(ja));

// FavoritesScreen source must consume useFavoritesStore — the bookmark
// list must be the store, not a fresh copy or a dupe of collection.
const favSrc = fs.readFileSync(path.join(repoRoot, 'src/screens/FavoritesScreen.tsx'), 'utf8');
ok(
  'FavoritesScreen consumes useFavoritesStore (the store the account-sync round-trips)',
  favSrc.includes("import { useFavoritesStore") && favSrc.includes('useFavoritesStore('),
);

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W7 favorites nav route: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W7 favorites nav route failed`);
}
