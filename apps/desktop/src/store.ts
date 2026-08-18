import { create } from 'zustand';
import type { ChatMode } from '@jarvis/types';

export type PageId =
  | 'home'
  | 'chat'
  | 'tasks'
  | 'knowledge'
  | 'models'
  | 'permissions'
  | 'activity'
  | 'settings';

interface UiState {
  page: PageId;
  sidebarCollapsed: boolean;
  approvalsOpen: boolean;
  chatMode: ChatMode;
  activeConversationId: string | null;
  setPage: (page: PageId) => void;
  toggleSidebar: () => void;
  setApprovalsOpen: (open: boolean) => void;
  setChatMode: (mode: ChatMode) => void;
  setActiveConversation: (id: string | null) => void;
}

/** Zustand holds ephemeral UI state only; Core owns all durable state. */
export const useUiStore = create<UiState>((set) => ({
  page: 'home',
  sidebarCollapsed: false,
  approvalsOpen: false,
  chatMode: 'ask',
  activeConversationId: null,
  setPage: (page) => set({ page }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setApprovalsOpen: (approvalsOpen) => set({ approvalsOpen }),
  setChatMode: (chatMode) => set({ chatMode }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
}));
