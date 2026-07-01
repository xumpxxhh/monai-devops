import { Link, Outlet } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faDiagramProject } from '@fortawesome/free-solid-svg-icons';

interface FullscreenLayoutProps {
  backTo?: string;
  backLabel?: string;
  title?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
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
      <header className="h-14 shrink-0 bg-surface border-b border-line flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <Link
            to={backTo}
            className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink px-2 py-1 rounded-ctrl hover:bg-raised"
          >
            <FontAwesomeIcon icon={faArrowLeft} />
            {backLabel}
          </Link>
          <div className="flex items-center gap-2 text-sm font-medium">
            <FontAwesomeIcon icon={faDiagramProject} className="text-brand" />
            {title}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="flex-1 overflow-hidden">{children ?? <Outlet />}</div>
    </div>
  );
}
