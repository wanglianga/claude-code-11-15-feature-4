import { create } from 'zustand';
import { api, getToken, setToken } from './api';
import type { User } from './types';

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 三级筛选：门店 / 品类 / 到货日 */
export interface Filters {
  storeId: number | null;
  categoryId: number | null;
  arrivalDate: string;
}

/** 建议表草稿：门店改量 + 原因码（按 SKU 暂存，确认前不落库） */
export interface DraftItem {
  qty: string;
  reasonCode: string;
}

interface AppState {
  token: string | null;
  user: User | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;

  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;

  draft: Record<number, DraftItem>;
  setDraft: (skuId: number, patch: Partial<DraftItem>) => void;
  clearDraft: () => void;

  toast: string | null;
  showToast: (msg: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  token: getToken(),
  user: JSON.parse(localStorage.getItem('fresh-order-user') ?? 'null'),
  async login(username, password) {
    const res = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    setToken(res.token);
    localStorage.setItem('fresh-order-user', JSON.stringify(res.user));
    set((s) => ({
      token: res.token,
      user: res.user,
      filters: { ...s.filters, storeId: res.user.storeId ?? s.filters.storeId ?? 1 },
    }));
  },
  logout() {
    setToken(null);
    localStorage.removeItem('fresh-order-user');
    set({ token: null, user: null, draft: {} });
  },

  filters: { storeId: null, categoryId: null, arrivalDate: tomorrowStr() },
  setFilters(patch) {
    set((s) => ({ filters: { ...s.filters, ...patch } }));
  },

  draft: {},
  setDraft(skuId, patch) {
    set((s) => {
      const cur = s.draft[skuId] ?? { qty: '', reasonCode: '' };
      return { draft: { ...s.draft, [skuId]: { ...cur, ...patch } } };
    });
  },
  clearDraft() {
    set({ draft: {} });
  },

  toast: null,
  showToast(msg) {
    set({ toast: msg });
    setTimeout(() => {
      if (get().toast === msg) set({ toast: null });
    }, 4000);
  },
}));
