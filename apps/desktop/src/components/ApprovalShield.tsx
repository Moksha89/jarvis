import {
  Badge,
  Body1,
  Button,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  makeStyles,
} from '@fluentui/react-components';
import { Dismiss24Regular, ShieldTask24Regular } from '@fluentui/react-icons';
import { ApprovalCard, jarvisSpacing } from '@jarvis/ui';
import { useApprovalActions } from '../hooks/useApprovalActions.js';
import { usePendingApprovals } from '../queries.js';
import { useUiStore } from '../store.js';

const useStyles = makeStyles({
  trigger: { position: 'relative' },
  badge: { position: 'absolute', top: '-2px', right: '-2px' },
  list: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.m },
});

/** Top-right shield badge plus the approval queue drawer. */
export function ApprovalShield() {
  const styles = useStyles();
  const { approvalsOpen, setApprovalsOpen } = useUiStore();
  const { data: approvals = [] } = usePendingApprovals();
  const { approve, deny, busy, confirmationPhrase } = useApprovalActions();

  return (
    <>
      <span className={styles.trigger}>
        <Button
          appearance={approvals.length > 0 ? 'primary' : 'subtle'}
          icon={<ShieldTask24Regular />}
          onClick={() => setApprovalsOpen(true)}
          aria-label={`Approval queue (${approvals.length} pending)`}
        />
        {approvals.length > 0 ? (
          <Badge className={styles.badge} appearance="filled" color="danger" size="small">
            {approvals.length}
          </Badge>
        ) : null}
      </span>

      <Drawer type="overlay" position="end" size="medium" open={approvalsOpen} onOpenChange={(_, data) => setApprovalsOpen(data.open)}>
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={() => setApprovalsOpen(false)}
                aria-label="Close approval queue"
              />
            }
          >
            Approval queue
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.list}>
            {approvals.length === 0 ? (
              <Body1>Nothing is waiting for you. Jarvis will ask here before any risky action.</Body1>
            ) : (
              approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  confirmationPhrase={confirmationPhrase}
                  busy={busy}
                  onApprove={(options) => approve(approval.id, options)}
                  onDeny={() => deny(approval.id)}
                />
              ))
            )}
          </div>
        </DrawerBody>
      </Drawer>
    </>
  );
}
