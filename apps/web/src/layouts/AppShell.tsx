import { Outlet } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { runsApi } from '../shared/api/runs';
import { subscribeRunsChanged } from '../shared/api/runs-events';
import type { RunRecord } from '../shared/types';
import type { WsConnectionStatus } from '../shared/api/workflow-run-client';

export function AppShell() {
  const [recentRuns, setRecentRuns] = useState<RunRecord[]>([]);
  const [wsStatus] = useState<WsConnectionStatus>('disconnected');

  const loadRecentRuns = useCallback(() => {
    runsApi
      .list({ pageSize: 5 })
      .then((res) => setRecentRuns(res.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadRecentRuns();
    return subscribeRunsChanged(loadRecentRuns);
  }, [loadRecentRuns]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar recentRuns={recentRuns} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar wsStatus={wsStatus} />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
