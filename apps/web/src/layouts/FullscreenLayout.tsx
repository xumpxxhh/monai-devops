import { Link, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faDiagramProject } from '@fortawesome/free-solid-svg-icons';
import { ThemeSwitcher } from '../shared/theme/ThemeSwitcher';

interface FullscreenLayoutProps {
  backTo?: string;
  backLabel?: string;
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function FullscreenLayout({
  backTo = '/workflows',
  backLabel = '返回',
  title,
  actions,
  children,
}: FullscreenLayoutProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-canvas">
      <header className="h-14 shrink-0 bg-surface border-b border-line flex items-center justify-between px-4 gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <Link
            to={backTo}
            className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink px-2 py-1 rounded-ctrl hover:bg-raised shrink-0"
          >
            <FontAwesomeIcon icon={faArrowLeft} />
            {backLabel}
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <FontAwesomeIcon icon={faDiagramProject} className="text-brand text-base shrink-0" />
            {title}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <ThemeSwitcher />
          {actions}
        </div>
      </header>
      <div className="flex-1 overflow-hidden">{children ?? <Outlet />}</div>
    </div>
  );
}
