import { Route, Routes } from 'react-router-dom';
import { AppShell } from './layouts/AppShell';
import DashboardPage from './features/dashboard/DashboardPage';
import WorkflowsListPage from './features/workflows/WorkflowsListPage';
import WorkflowEditorPage from './features/editor/WorkflowEditorPage';
import RunsListPage from './features/runs/RunsListPage';
import RunDetailPage from './features/run-detail/RunDetailPage';
import PluginsPage from './features/plugins/PluginsPage';
import ResourcesPage from './features/resources/ResourcesPage';
import Test from './pages/Test';

function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/workflows" element={<WorkflowsListPage />} />
        <Route path="/runs" element={<RunsListPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/resources" element={<ResourcesPage />} />
      </Route>
      <Route path="/workflows/new" element={<WorkflowEditorPage />} />
      <Route path="/workflows/:id/edit" element={<WorkflowEditorPage />} />
      <Route path="/runs/:runId" element={<RunDetailPage />} />
      <Route path="/test" element={<Test />} />
    </Routes>
  );
}

export default App;
