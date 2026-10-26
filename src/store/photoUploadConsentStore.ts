import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';

/**
 * Which photo-upload disclosure version this device accepted (see
 * src/services/photoUploadDisclosure). Device-local, like the scan quota; it is
 * a record of the in-app consent, not an account setting.
 */
interface PhotoUploadConsentState {
  acceptedVersion: string | null;
  accept: (version: string) => void;
  revoke: () => void;
}

export const usePhotoUploadConsentStore = create<PhotoUploadConsentState>()(
  persist(
    (set) => ({
      acceptedVersion: null,
      accept: (version) => set({ acceptedVersion: version }),
      revoke: () => set({ acceptedVersion: null }),
    }),
    {
      name: 'holohunter-photo-upload-consent',
      storage: createJSONStorage(() => platformStorage),
      partialize: (state) => ({ acceptedVersion: state.acceptedVersion }),
    },
  ),
);
