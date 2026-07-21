import { NavLink } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faDiagramProject,
  faGaugeHigh,
  faPlay,
  faPuzzlePiece,
  faServer,
} from '@fortawesome/free-solid-svg-icons';
import type { RunRecord } from '../shared/types';
import { RUN_STATUS_META } from '../shared/types/status';

const NAV = [
  { to: '/', label: '概览', icon: faGaugeHigh, end: true },
  { to: '/workflows', label: '工作流', icon: faDiagramProject },
  { to: '/runs', label: '运行', icon: faPlay },
  { to: '/plugins', label: '插件', icon: faPuzzlePiece },
  { to: '/resources', label: '资源与调度', icon: faServer },
];

interface SidebarProps {
  recentRuns?: RunRecord[];
}

export function Sidebar({ recentRuns = [] }: SidebarProps) {
  return (
    <aside className="w-60 shrink-0 bg-surface border-r border-line flex flex-col h-full">
      <NavLink to="/" className="h-14 flex items-center gap-2.5 px-5 border-b border-line">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-brand/20 text-brand">
          <FontAwesomeIcon icon={faDiagramProject} />
        </span>
        <span className="font-semibold tracking-tight">
          MONAI <span className="text-brand">DevOps</span>
        </span>
      </NavLink>

      <nav className="p-3 space-y-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-ctrl text-sm transition-colors ${
                isActive
                  ? 'bg-brand-soft text-brand font-medium'
                  : 'text-muted hover:bg-raised hover:text-ink'
              }`
            }
          >
            <FontAwesomeIcon icon={item.icon} className="w-4 text-center" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {recentRuns.length > 0 && (
        <>
          <div className="mx-3 my-1 border-t border-line-soft" />
          <div className="px-3 pt-1 pb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint">
            最近运行
          </div>
          <div className="px-2 space-y-0.5 overflow-auto flex-1">
            {recentRuns.slice(0, 5).map((run) => {
              const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.queued;
              return (
                <NavLink
                  key={run.runId}
                  to={`/runs/${run.runId}`}
                  className="group flex items-center gap-2 px-3 py-1.5 rounded-ctrl text-xs text-muted hover:bg-raised hover:text-ink transition-colors"
                >
                  <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                  <span className="truncate flex-1">
                    {run.workflowSnapshot?.name ?? run.workflowId}
                  </span>
                  <span className="font-mono text-faint group-hover:text-muted">
                    #{run.runId.slice(0, 6)}
                  </span>
                </NavLink>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-auto p-3 text-[11px] text-faint border-t border-line-soft">
        v0.1 · 控制台
      </div>
    </aside>
  );
}
