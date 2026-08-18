import { FluentProvider, Text, makeStyles, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import {
  Bot24Regular,
  Chat24Regular,
  Cube24Regular,
  History24Regular,
  Home24Regular,
  Settings24Regular,
  ShieldTask24Regular,
  TaskListSquareLtr24Regular,
} from '@fluentui/react-icons';
import { AppShell, Sidebar, jarvisSpacing, type NavItem } from '@jarvis/ui';
import { useCoreEvents, useSettings } from './queries.js';
import { useUiStore, type PageId } from './store.js';
import { ApprovalShield } from './components/ApprovalShield.js';
import { SystemStrip } from './components/SystemStrip.js';
import { HomePage } from './pages/HomePage.js';
import { ChatPage } from './pages/ChatPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { PermissionsPage } from './pages/PermissionsPage.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

const navItems: readonly (NavItem & { id: PageId })[] = [
  { id: 'home', label: 'Home', icon: <Home24Regular /> },
  { id: 'chat', label: 'Chat', icon: <Chat24Regular /> },
  { id: 'tasks', label: 'Tasks', icon: <TaskListSquareLtr24Regular /> },
  { id: 'models', label: 'Models', icon: <Cube24Regular /> },
  { id: 'permissions', label: 'Permissions', icon: <ShieldTask24Regular /> },
  { id: 'activity', label: 'Activity', icon: <History24Regular /> },
  { id: 'settings', label: 'Settings', icon: <Settings24Regular /> },
];

const pages: Record<PageId, () => JSX.Element> = {
  home: HomePage,
  chat: ChatPage,
  tasks: TasksPage,
  models: ModelsPage,
  permissions: PermissionsPage,
  activity: ActivityPage,
  settings: SettingsPage,
};

const useStyles = makeStyles({
  brand: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.s },
  spacer: { flex: 1 },
});

export function App() {
  const styles = useStyles();
  const { page, sidebarCollapsed, setPage, toggleSidebar } = useUiStore();
  const settings = useSettings();
  useCoreEvents();

  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const themeSetting = settings.data?.theme ?? 'system';
  const dark = themeSetting === 'dark' || (themeSetting === 'system' && prefersDark);
  const Page = pages[page];

  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <AppShell
        sidebar={
          <Sidebar
            items={navItems}
            activeId={page}
            collapsed={sidebarCollapsed}
            onSelect={(id) => setPage(id as PageId)}
            onToggleCollapsed={toggleSidebar}
          />
        }
        header={
          <>
            <span className={styles.brand}>
              <Bot24Regular />
              <Text weight="semibold">Jarvis</Text>
            </span>
            <div className={styles.spacer} />
            <SystemStrip compact />
            <ApprovalShield />
          </>
        }
      >
        <Page />
      </AppShell>
    </FluentProvider>
  );
}
