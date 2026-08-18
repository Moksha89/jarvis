import { Badge, Tooltip } from '@fluentui/react-components';
import type { BadgeProps } from '@fluentui/react-components';

export type StatusTone = 'ok' | 'warning' | 'error' | 'neutral' | 'info';

const toneToColor: Record<StatusTone, BadgeProps['color']> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
  neutral: 'subtle',
  info: 'brand',
};

export interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
  /** Longer explanation shown on hover; keep it plain language. */
  title?: string;
  icon?: BadgeProps['icon'];
}

export function StatusBadge({ tone, label, title, icon }: StatusBadgeProps) {
  const badge = (
    <Badge appearance="filled" color={toneToColor[tone]} icon={icon} size="medium">
      {label}
    </Badge>
  );
  return title ? (
    <Tooltip content={title} relationship="description" withArrow>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}
