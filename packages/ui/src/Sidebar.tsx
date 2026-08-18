import type { ReactElement, ReactNode } from 'react';
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { PanelLeftContract24Regular, PanelLeftExpand24Regular } from '@fluentui/react-icons';
import { jarvisLayout, jarvisMotion, jarvisRadius, jarvisSpacing } from './tokens.js';

export interface NavItem {
  id: string;
  label: string;
  icon: ReactElement;
  /** Rendered as a small trailing count, e.g. pending approvals. */
  badge?: number;
}

export interface SidebarProps {
  items: readonly NavItem[];
  activeId: string;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggleCollapsed: () => void;
  footer?: ReactNode;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: jarvisSpacing.xs,
    padding: jarvisSpacing.s,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    transitionProperty: 'width',
    transitionDuration: jarvisMotion.normal,
    transitionTimingFunction: jarvisMotion.easing,
    overflowX: 'hidden',
  },
  expanded: { width: jarvisLayout.sidebarExpandedWidth },
  collapsed: { width: jarvisLayout.sidebarCollapsedWidth },
  item: { justifyContent: 'flex-start', borderRadius: jarvisRadius.medium },
  itemCollapsed: { justifyContent: 'center', minWidth: 'auto' },
  spacer: { flex: 1 },
  badge: {
    marginLeft: 'auto',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
});

export function Sidebar({ items, activeId, collapsed, onSelect, onToggleCollapsed, footer }: SidebarProps) {
  const styles = useStyles();
  return (
    <nav
      aria-label="Jarvis sections"
      className={mergeClasses(styles.root, collapsed ? styles.collapsed : styles.expanded)}
    >
      <Tooltip content={collapsed ? 'Expand navigation' : 'Collapse navigation'} relationship="label" withArrow>
        <Button
          appearance="subtle"
          icon={collapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />}
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className={mergeClasses(styles.item, collapsed ? styles.itemCollapsed : undefined)}
        />
      </Tooltip>

      {items.map((item) => {
        const button = (
          <Button
            key={item.id}
            appearance={item.id === activeId ? 'primary' : 'subtle'}
            icon={item.icon}
            onClick={() => onSelect(item.id)}
            aria-current={item.id === activeId ? 'page' : undefined}
            className={mergeClasses(styles.item, collapsed ? styles.itemCollapsed : undefined)}
          >
            {collapsed ? undefined : (
              <>
                {item.label}
                {item.badge ? <span className={styles.badge}>{item.badge}</span> : null}
              </>
            )}
          </Button>
        );
        return collapsed ? (
          <Tooltip key={item.id} content={item.label} relationship="label" withArrow positioning="after">
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}

      <div className={styles.spacer} />
      {footer}
    </nav>
  );
}
