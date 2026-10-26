/**
 * Tutorial progression store (DIC-1427 — Pen DAQIq / rV4Za / I6WwjY).
 *
 * The Pen frames show REAL progression chrome — a hero progress bar
 * («X / Y 章節完成»), per-chapter completed/active states and an in-chapter
 * step navigator. This store is the truthful source for that chrome: a
 * chapter only becomes «completed» when the reader actually walks its last
 * phase (or finishes the whole simulation), never from static copy.
 *
 * Persisted like the other user-state stores (zustand + platformStorage) so
 * progression survives restarts on web and native alike.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';

interface TutorialProgressState {
  /** Chapters the reader finished (walked past the last phase / read view). */
  completedSections: Record<string, true>;
  /** Chapters the reader opened but has not finished — powers the «進行中»
   *  (active) row state on the Pen DAQIq chapter list. */
  visitedSections: Record<string, true>;
  /** True once the reader has stepped through the whole simulation. */
  simulationCompleted: boolean;
  markSectionVisited: (sectionId: string) => void;
  markSectionCompleted: (sectionId: string) => void;
  markSimulationCompleted: () => void;
  resetProgress: () => void;
}

export const useTutorialStore = create<TutorialProgressState>()(
  persist(
    (set) => ({
      completedSections: {},
      visitedSections: {},
      simulationCompleted: false,
      markSectionVisited: (sectionId) => set((s) => (
        s.visitedSections[sectionId] ? s : { visitedSections: { ...s.visitedSections, [sectionId]: true } }
      )),
      markSectionCompleted: (sectionId) => set((s) => (
        s.completedSections[sectionId] ? s : { completedSections: { ...s.completedSections, [sectionId]: true } }
      )),
      markSimulationCompleted: () => set({ simulationCompleted: true }),
      resetProgress: () => set({ completedSections: {}, visitedSections: {}, simulationCompleted: false }),
    }),
    {
      name: 'tutorial-progress',
      storage: createJSONStorage(() => platformStorage),
      version: 1,
    },
  ),
);

export default useTutorialStore;
