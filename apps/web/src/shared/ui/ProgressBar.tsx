interface ProgressBarProps {
  completed: number;
  running: number;
  queued: number;
  failed: number;
  skipped: number;
  total: number;
}

export function ProgressBar({
  completed,
  running,
  queued,
  failed,
  skipped,
  total,
}: ProgressBarProps) {
  if (total === 0) {
    return <div className="h-1.5 rounded-pill bg-raised" />;
  }

  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <div className="h-1.5 rounded-pill bg-raised overflow-hidden flex">
      {completed > 0 && <div className="bg-completed h-full" style={{ width: pct(completed) }} />}
      {running > 0 && <div className="bg-running h-full" style={{ width: pct(running) }} />}
      {queued > 0 && <div className="bg-queued h-full" style={{ width: pct(queued) }} />}
      {failed > 0 && <div className="bg-failed h-full" style={{ width: pct(failed) }} />}
      {skipped > 0 && <div className="bg-skipped h-full" style={{ width: pct(skipped) }} />}
    </div>
  );
}
