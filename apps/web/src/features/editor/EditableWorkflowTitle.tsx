import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPen } from '@fortawesome/free-solid-svg-icons';
import { Input } from '../../shared/ui/form';
import { validateWorkflowName } from './workflow-name';

export function EditableWorkflowTitle({
  value,
  onChange,
  error,
  onErrorChange,
}: {
  value: string;
  onChange: (name: string) => void;
  error?: string;
  onErrorChange: (error: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const startEditing = () => {
    setDraft(value);
    onErrorChange('');
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    const nameError = validateWorkflowName(trimmed);
    if (nameError) {
      onErrorChange(nameError);
      return;
    }
    onErrorChange('');
    onChange(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    onErrorChange('');
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex flex-col min-w-0">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) onErrorChange(validateWorkflowName(e.target.value) ?? '');
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className="h-9 text-base font-semibold max-w-md"
        />
        {error ? <span className="text-xs text-failed mt-0.5">{error}</span> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label="编辑工作流名称"
      title="点击编辑工作流名称"
      onClick={startEditing}
      className="group inline-flex items-center gap-2 min-w-0 max-w-[min(28rem,45vw)] rounded-ctrl border border-dashed border-line/60 px-2.5 py-1 -ml-2 text-base font-semibold text-ink hover:bg-raised hover:border-brand/40 transition-colors"
    >
      <span className="truncate">{value}</span>
      <span className="inline-flex items-center gap-1 shrink-0 text-xs font-normal text-muted group-hover:text-brand">
        <FontAwesomeIcon icon={faPen} />
        编辑
      </span>
    </button>
  );
}
