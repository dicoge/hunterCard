#!/usr/bin/env node
// DIC-1427 QA P0 — Pen `App / 12 規則教學` (DAQIq) / `App / 13 教學詳情`
// (rV4Za) / `App / 14 教學模擬` (I6WwjY) IA + REAL progression on the shipped
// Tutorial routes.
//
// The prior Preview rendered an emoji hero + flat article cards with no
// progression at all. These tests pin the Pen hierarchy to the real
// tutorialStore / tutorialData / simulation dataset:
//   • DAQIq: gradient hero with a progress bar driven by useTutorialStore
//     («X / Y 章節完成»), numbered chapter rows with completed/active states,
//     simulation entry — no fake locks, no static «3 / 5».
//   • rV4Za: breadcrumb, CHAPTER hero card, phase step-navigator that really
//     switches the visible phase, 開始模擬 CTA to the real simulation route,
//     完整文字 toggle, and chapter completion writing back to the store.
//   • I6WwjY: turn bar with the real 階段 X/Y, accent hint banner from the
//     real step explanation, primary/secondary action row driving the real
//     step machine, and simulation completion writing back to the store.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { getTutorialData } = await import('../src/data/tutorialData.ts');
const { getSimulationPhases } = await import('../src/data/tutorialSimulationData.ts');
const { useTutorialStore } = await import('../src/store/tutorialStore.ts');
const { default: TutorialScreen } = await import('../src/screens/TutorialScreen.tsx');
const { default: TutorialDetailScreen } = await import('../src/screens/TutorialDetailScreen.tsx');
const { default: TutorialSimulationScreen } = await import('../src/screens/TutorialSimulationScreen.tsx');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const sections = getTutorialData('zh');
const SECTION_COUNT = sections.length;
assert.ok(SECTION_COUNT >= 5, 'real tutorial dataset present');
const resetStore = () => useTutorialStore.setState({ completedSections: {}, visitedSections: {}, simulationCompleted: false });

console.log('── DIC-1427 · App 12/13/14 tutorial Pen parity ──');

// ── App / 12 規則教學 (Pen DAQIq) ─────────────────────────────────────────

await test('DAQIq hero: gradient progress hero driven by the real tutorial store, not static copy', async () => {
  resetStore();
  const { container, cleanup } = await render(React.createElement(TutorialScreen, {
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    assert.ok(container.querySelector('[data-testid="tutorial-hero"]'), 'gradient hero (Pen DJCul)');
    const progressLabel = container.querySelector('[data-testid="tutorial-hero-progress-label"]');
    assert.ok(progressLabel, 'progress label (Pen mYVCg)');
    assert.ok(
      progressLabel.textContent.includes(`0 / ${SECTION_COUNT}`),
      `fresh store shows 0 / ${SECTION_COUNT}, got «${progressLabel.textContent}»`,
    );
    assert.ok(container.querySelector('[data-testid="tutorial-hero-progress-bar"]'), 'progress track (Pen lYAvu)');
  } finally { await cleanup(); }
});

await test('DAQIq chapters: numbered rows with real completed/active states from the store', async () => {
  resetStore();
  useTutorialStore.setState({
    completedSections: { [sections[0].id]: true },
    visitedSections: { [sections[0].id]: true, [sections[1].id]: true },
    simulationCompleted: false,
  });
  const pressed = [];
  const { container, cleanup } = await render(React.createElement(TutorialScreen, {
    navigation: { navigate: (r, p) => pressed.push([r, p]), goBack() {} },
  }));
  try {
    for (const [i, section] of sections.entries()) {
      const row = container.querySelector(`[data-testid="tutorial-section-${section.id}"]`);
      assert.ok(row, `chapter row ${section.id}`);
      assert.ok(
        row.textContent.includes(String(i + 1).padStart(2, '0')),
        `row ${section.id} carries the Pen numbered chip ${String(i + 1).padStart(2, '0')}`,
      );
    }
    assert.ok(
      container.querySelector(`[data-testid="tutorial-chapter-state-${sections[0].id}-completed"]`),
      'finished chapter shows the completed state (Pen circle-check)',
    );
    assert.ok(
      container.querySelector(`[data-testid="tutorial-chapter-state-${sections[1].id}-active"]`),
      'visited-but-unfinished chapter shows the active state (Pen circle-play)',
    );
    const progressLabel = container.querySelector('[data-testid="tutorial-hero-progress-label"]');
    assert.ok(progressLabel.textContent.includes(`1 / ${SECTION_COUNT}`), 'hero reflects one real completion');

    await act(async () => container.querySelector(`[data-testid="tutorial-section-${sections[2].id}"]`).click());
    assert.deepEqual(pressed[0], ['TutorialDetail', { sectionId: sections[2].id }], 'row navigates to the real detail route');
  } finally { await cleanup(); }
});

await test('DAQIq simulation entry survives and routes to the real simulation', async () => {
  resetStore();
  const pressed = [];
  const { container, cleanup } = await render(React.createElement(TutorialScreen, {
    navigation: { navigate: (r) => pressed.push(r), goBack() {} },
  }));
  try {
    const entry = container.querySelector('[data-testid="tutorial-simulation-entry"]');
    assert.ok(entry, 'simulation entry tile');
    await act(async () => entry.click());
    assert.deepEqual(pressed, ['TutorialSimulation']);
  } finally { await cleanup(); }
});

// ── App / 13 教學詳情 (Pen rV4Za) ─────────────────────────────────────────

const phasedSection = sections.find((s) => Array.isArray(s.phases) && s.phases.length >= 3);
assert.ok(phasedSection, 'dataset has a phased chapter for the step navigator');

await test('rV4Za: breadcrumb + CHAPTER hero card carry the real chapter identity', async () => {
  resetStore();
  const { container, cleanup } = await render(React.createElement(TutorialDetailScreen, {
    route: { params: { sectionId: phasedSection.id } },
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const crumb = container.querySelector('[data-testid="tutorial-detail-crumb"]');
    assert.ok(crumb, 'breadcrumb (Pen qOcyP)');
    assert.ok(crumb.textContent.includes('規則教學'), 'crumb roots at 規則教學');
    const hero = container.querySelector('[data-testid="tutorial-detail-hero"]');
    assert.ok(hero, 'hero card (Pen Lpj3B)');
    const chapterIndex = sections.indexOf(phasedSection) + 1;
    assert.ok(
      hero.textContent.includes(`CHAPTER ${String(chapterIndex).padStart(2, '0')}`),
      'CHAPTER label reflects the real chapter index',
    );
    assert.ok(hero.textContent.includes(phasedSection.title), 'hero carries the real title');
    assert.ok(
      useTutorialStore.getState().visitedSections[phasedSection.id],
      'opening the chapter records the real visited state',
    );
  } finally { await cleanup(); }
});

await test('rV4Za: 章節導覽 step pills really switch the visible phase; 完整文字 restores the full view', async () => {
  resetStore();
  const { container, cleanup } = await render(React.createElement(TutorialDetailScreen, {
    route: { params: { sectionId: phasedSection.id } },
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const pills = container.querySelectorAll('[data-testid^="tutorial-detail-step-"]');
    assert.equal(pills.length, phasedSection.phases.length, 'one pill per real phase (Pen P3N2f)');

    const pill1 = container.querySelector('[data-testid="tutorial-detail-step-1"]');
    await act(async () => pill1.click());
    const visiblePhases = container.querySelectorAll('[data-testid^="tutorial-detail-phase-"]');
    assert.equal(visiblePhases.length, 1, 'stepped mode shows exactly the chosen phase');
    assert.ok(
      container.querySelector('[data-testid="tutorial-detail-phase-1"]'),
      'chosen phase is the visible one',
    );

    const fullText = container.querySelector('[data-testid="tutorial-detail-full-text"]');
    assert.ok(fullText, '完整文字 CTA (Pen ThoBL)');
    await act(async () => fullText.click());
    assert.equal(
      container.querySelectorAll('[data-testid^="tutorial-detail-phase-"]').length,
      phasedSection.phases.length,
      '完整文字 shows every phase again',
    );
  } finally { await cleanup(); }
});

await test('rV4Za: 開始模擬 routes to the real simulation; walking past the last phase completes the chapter in the store', async () => {
  resetStore();
  const pressed = [];
  const { container, cleanup } = await render(React.createElement(TutorialDetailScreen, {
    route: { params: { sectionId: phasedSection.id } },
    navigation: { navigate: (r) => pressed.push(r), goBack() {} },
  }));
  try {
    const startSim = container.querySelector('[data-testid="tutorial-detail-start-sim"]');
    assert.ok(startSim, '開始模擬 CTA (Pen tz0Aa)');
    await act(async () => startSim.click());
    assert.deepEqual(pressed, ['TutorialSimulation']);

    const lastIdx = phasedSection.phases.length - 1;
    await act(async () => container.querySelector(`[data-testid="tutorial-detail-step-${lastIdx}"]`).click());
    const completeBtn = container.querySelector('[data-testid="tutorial-detail-complete"]');
    assert.ok(completeBtn, 'completion CTA appears on the last phase');
    assert.equal(useTutorialStore.getState().completedSections[phasedSection.id], undefined, 'not completed before the press');
    await act(async () => completeBtn.click());
    assert.equal(
      useTutorialStore.getState().completedSections[phasedSection.id],
      true,
      'completion is REAL store state, not static copy',
    );
  } finally { await cleanup(); }
});

// ── App / 14 教學模擬 (Pen I6WwjY) ────────────────────────────────────────

const phases = getSimulationPhases('zh');

await test('I6WwjY: turn bar carries the real 階段 X/Y and the action row drives the real step machine', async () => {
  resetStore();
  const { container, cleanup } = await render(React.createElement(TutorialSimulationScreen, {
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const turnBar = container.querySelector('[data-testid="tutorial-simulation-turnbar"]');
    assert.ok(turnBar, 'turn bar (Pen hVdrQ)');
    assert.ok(turnBar.textContent.includes(`1`), 'turn bar starts at the real phase 1');
    assert.ok(turnBar.textContent.includes(`${phases.length}`), `turn bar shows the real total ${phases.length}`);

    const firstStep = container.querySelector('[data-testid^="tutorial-simulation-step-"]');
    assert.ok(firstStep, 'real first step renders');
    const firstStepId = firstStep.getAttribute('data-testid');

    const next = container.querySelector('[data-testid="tutorial-simulation-next"]');
    assert.ok(next, 'primary next action (Pen x431v7)');
    await act(async () => next.click());
    const afterStep = container.querySelector('[data-testid^="tutorial-simulation-step-"]');
    assert.notEqual(afterStep.getAttribute('data-testid'), firstStepId, 'next advances the REAL step machine');
  } finally { await cleanup(); }
});

await test('I6WwjY: hint banner renders the real step explanation when present', async () => {
  resetStore();
  const stepWithHint = phases.flatMap((p) => p.steps).find((s) => s.explanation);
  assert.ok(stepWithHint, 'dataset has a step with an explanation');
  const { container, cleanup } = await render(React.createElement(TutorialSimulationScreen, {
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const next = () => container.querySelector('[data-testid="tutorial-simulation-next"]');
    let hint = container.querySelector('[data-testid="tutorial-simulation-hint"]');
    let guard = 0;
    while (!hint && guard < 60) {
      await act(async () => next().click());
      hint = container.querySelector('[data-testid="tutorial-simulation-hint"]');
      guard += 1;
    }
    assert.ok(hint, 'accent hint banner (Pen Cpwfh) appears on a real step with explanation');
  } finally { await cleanup(); }
});

await test('I6WwjY: finishing the walkthrough records simulationCompleted and leaves via goBack', async () => {
  resetStore();
  const events = [];
  const { container, cleanup } = await render(React.createElement(TutorialSimulationScreen, {
    navigation: { navigate() {}, goBack: () => events.push('goBack') },
  }));
  try {
    const totalSteps = phases.reduce((sum, p) => sum + p.steps.length, 0);
    for (let i = 0; i < totalSteps; i += 1) {
      const next = container.querySelector('[data-testid="tutorial-simulation-next"]');
      await act(async () => next.click());
    }
    assert.deepEqual(events, ['goBack'], 'completion leaves the route');
    assert.equal(useTutorialStore.getState().simulationCompleted, true, 'simulation completion is REAL store state');
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
