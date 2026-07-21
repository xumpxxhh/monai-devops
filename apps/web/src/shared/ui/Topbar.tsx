import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCube, faPlus } from '@fortawesome/free-solid-svg-icons';
import { systemApi } from '../api/misc';
import { WsPill } from './WsPill';
import type { WsConnectionStatus } from '../api/workflow-run-client';

interface TopbarProps {
  breadcrumb?: React.ReactNode;
  wsStatus?: WsConnectionStatus;
}

export function Topbar({ breadcrumb, wsStatus = 'disconnected' }: TopbarProps) {
  const [envLabel, setEnvLabel] = useState<string | null>(null);
  const [appEnv, setAppEnv] = useState<string | null>(null);

  useEffect(() => {
    systemApi
      .info()
      .then((info) => {
        setAppEnv(info.appEnv);
        setEnvLabel(info.appEnvLabel);
      })
      .catch(() => {});
  }, []);

  return (
    <header className="h-14 shrink-0 bg-surface/80 backdrop-blur border-b border-line flex items-center justify-between px-6">
      <div className="text-sm text-muted flex items-center gap-2">{breadcrumb}</div>
      <div className="flex items-center gap-4">
        {envLabel && (
          <span
            className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted px-2.5 py-1 rounded-pill bg-raised border border-line"
            title={appEnv ?? undefined}
          >
            <FontAwesomeIcon icon={faCube} className="text-faint" />
            env: <span className="font-mono text-ink">{envLabel}</span>
          </span>
        )}
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
