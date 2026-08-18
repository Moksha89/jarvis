import type { ReactNode } from 'react';
import { Body1, Subtitle1, makeStyles, tokens } from '@fluentui/react-components';
import { jarvisSpacing } from '@jarvis/ui';

const useStyles = makeStyles({
  root: { display: 'flex', alignItems: 'flex-start', gap: jarvisSpacing.m, marginBottom: jarvisSpacing.l },
  text: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.xxs },
  description: { color: tokens.colorNeutralForeground3 },
  spacer: { flex: 1 },
});

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.text}>
        <Subtitle1>{title}</Subtitle1>
        <Body1 className={styles.description}>{description}</Body1>
      </div>
      <div className={styles.spacer} />
      {action}
    </div>
  );
}
