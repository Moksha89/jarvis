import type { ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { jarvisLayout, jarvisSpacing } from './tokens.js';

export interface AppShellProps {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}

const useStyles = makeStyles({
  root: { display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground2 },
  main: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: jarvisSpacing.s,
    height: jarvisLayout.headerHeight,
    padding: `0 ${jarvisSpacing.l}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  content: { flex: 1, overflowY: 'auto', padding: jarvisSpacing.xl },
  inner: { maxWidth: jarvisLayout.contentMaxWidth, margin: '0 auto', width: '100%' },
});

export function AppShell({ sidebar, header, children }: AppShellProps) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      {sidebar}
      <div className={styles.main}>
        <header className={styles.header}>{header}</header>
        <main className={styles.content}>
          <div className={styles.inner}>{children}</div>
        </main>
      </div>
    </div>
  );
}
