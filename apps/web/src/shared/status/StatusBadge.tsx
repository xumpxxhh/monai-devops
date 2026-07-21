import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faCircle,
  faClock,
  faForward,
  faSpinner,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { StepUiStatus } from '../types/status';
import { STATUS_META } from '../types/status';

const ICONS = {
  circle: faCircle,
  clock: faClock,
  spinner: faSpinner,
  check: faCheck,
  xmark: faXmark,
  forward: faForward,
};

interface StatusBadgeProps {
  status: StepUiStatus | string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const meta = STATUS_META[status as StepUiStatus] ?? {
    label: status,
    color: 'text-muted',
    icon: 'circle',
  };
  const icon = ICONS[meta.icon as keyof typeof ICONS] ?? faCircle;
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill bg-raised border border-line ${textSize} font-medium ${meta.color}`}
    >
      <FontAwesomeIcon
        icon={icon}
        className={`text-[10px] ${status === 'running' ? 'animate-spin' : ''}`}
      />
      {meta.label}
    </span>
  );
}
