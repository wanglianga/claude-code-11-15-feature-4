import { useApp } from '../store';
import type { Meta } from '../types';

/** 三级筛选条：门店 / 品类 / 到货日（Zustand 全局共享） */
export default function FilterBar({ meta }: { meta: Meta | null }) {
  const { filters, setFilters, user } = useApp();
  const isManager = user?.role === 'manager';

  return (
    <div className="filterbar">
      <label>
        门店
        <select
          value={filters.storeId ?? ''}
          disabled={isManager}
          onChange={(e) => setFilters({ storeId: Number(e.target.value) })}
        >
          {!filters.storeId && <option value="">请选择</option>}
          {meta?.stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <label>
        品类
        <select
          value={filters.categoryId ?? ''}
          onChange={(e) =>
            setFilters({ categoryId: e.target.value === '' ? null : Number(e.target.value) })
          }
        >
          <option value="">全部品类</option>
          {meta?.categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label>
        到货日
        <input
          type="date"
          value={filters.arrivalDate}
          onChange={(e) => setFilters({ arrivalDate: e.target.value })}
        />
      </label>
      <span className="muted small">
        口径：复盘以「观测需求」为基准 · 建议量 = 临界分位 × 特征因子，向上取整到最小订货单位
      </span>
    </div>
  );
}
