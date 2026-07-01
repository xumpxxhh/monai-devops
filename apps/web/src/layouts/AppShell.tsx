import { Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Sidebar } from '../shared/ui/Sidebar';
import { Topbar } from '../shared/ui/Topbar';
import { runsApi } from '../shared/api/runs';
import type { RunRecord } from '../shared/types';
import type { WsConnectionStatus } from '../shared/api/workflow-run-client';

export function AppShell() {
  const [recentRuns, setRecentRuns] = useState<RunRecord[]>([]);
  const [wsStatus] = useState<WsConnectionStatus>('disconnected');

  useEffect(() => {
    runsApi
      .list({ pageSize: 5 })
      .then((res) => setRecentRuns(res.items))
      .catch(() => {});
  }, []);

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
