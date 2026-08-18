import { Badge, Tooltip } from '@fluentui/react-components';
import type { RiskLevel } from '@jarvis/types';
import { RISK_DESCRIPTIONS, RISK_LABELS } from '@jarvis/types';

const colors = ['success', 'informative', 'warning', 'danger', 'danger'] as const;

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <Tooltip content={RISK_DESCRIPTIONS[level]} relationship="description" withArrow>
      <Badge appearance="tint" color={colors[level]}>
        {`L${level} ${RISK_LABELS[level]}`}
      </Badge>
    </Tooltip>
  );
}
