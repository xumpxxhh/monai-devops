import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCube, faPlus } from '@fortawesome/free-solid-svg-icons';
import { WsPill } from './WsPill';
import type { WsConnectionStatus } from '../api/workflow-run-client';

interface TopbarProps {
  breadcrumb?: React.ReactNode;
  wsStatus?: WsConnectionStatus;
}

export function Topbar({ breadcrumb, wsStatus = 'disconnected' }: TopbarProps) {
  return (
    <header className="h-14 shrink-0 bg-surface/80 backdrop-blur border-b border-line flex items-center justify-between px-6">
      <div className="text-sm text-muted flex items-center gap-2">{breadcrumb}</div>
      <div className="flex items-center gap-4">
        <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted px-2.5 py-1 rounded-pill bg-raised border border-line">
          <FontAwesomeIcon icon={faCube} className="text-faint" />
          env: <span className="font-mono text-ink">local</span>
        </span>
        <WsPill status={wsStatus} />
        <Link
          to="/workflows/new"
          className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover transition-colors"
        >
          <FontAwesomeIcon icon={faPlus} />
          新建工作流
        </Link>
      </div>
    </header>
  );
}
