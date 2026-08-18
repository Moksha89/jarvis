import { Caption1, ProgressBar, makeStyles, tokens } from '@fluentui/react-components';
import { jarvisSpacing } from './tokens.js';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xxs, minWidth: '120px' },
  row: { display: 'flex', justifyContent: 'space-between', gap: jarvisSpacing.s },
  value: { color: tokens.colorNeutralForeground3 },
});

export interface ResourceMeterProps {
  label: string;
  /** 0-100. */
  percent: number;
  detail?: string;
}

export function ResourceMeter({ label, percent, detail }: ResourceMeterProps) {
  const styles = useStyles();
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <Caption1>{label}</Caption1>
        <Caption1 className={styles.value}>{detail ?? `${clamped}%`}</Caption1>
      </div>
      <ProgressBar
        value={clamped / 100}
        thickness="medium"
        color={clamped > 90 ? 'error' : clamped > 75 ? 'warning' : 'brand'}
      />
    </div>
  );
}
