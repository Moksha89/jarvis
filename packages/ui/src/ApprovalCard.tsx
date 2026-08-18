import { useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Card,
  Divider,
  Field,
  Input,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ApprovalRequest } from '@jarvis/types';
import { RiskBadge } from './RiskBadge.js';
import { StatusBadge } from './StatusBadge.js';
import { jarvisSpacing } from './tokens.js';

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  confirmationPhrase: string;
  onApprove: (options: { confirmationPhrase?: string; remember: boolean }) => void;
  onDeny: () => void;
  busy?: boolean;
}

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.m, padding: jarvisSpacing.l },
  row: { display: 'flex', alignItems: 'center', gap: jarvisSpacing.s, flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: `${jarvisSpacing.xs} ${jarvisSpacing.m}` },
  label: { color: tokens.colorNeutralForeground3 },
  target: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
  actions: { display: 'flex', gap: jarvisSpacing.s, justifyContent: 'flex-end' },
});

/** Plain-language approval prompt: what, which tool, which target, risk, reversibility. */
export function ApprovalCard({ approval, confirmationPhrase, onApprove, onDeny, busy }: ApprovalCardProps) {
  const styles = useStyles();
  const [phrase, setPhrase] = useState('');
  const [remember, setRemember] = useState(false);
  const needsPhrase = approval.decision.requiresConfirmationPhrase;
  const canApprove = !busy && (!needsPhrase || phrase.trim() === confirmationPhrase);

  return (
    <Card className={styles.card}>
      <div className={styles.row}>
        <Subtitle2>Jarvis needs your approval</Subtitle2>
        <RiskBadge level={approval.riskLevel} />
        <StatusBadge
          tone={approval.reversible ? 'ok' : 'warning'}
          label={approval.reversible ? 'Reversible' : 'Not reversible'}
          title={
            approval.reversible
              ? 'This change can be undone or recovered.'
              : 'Once this runs, Jarvis cannot undo it for you.'
          }
        />
      </div>

      <Body1>{approval.summary}</Body1>
      <Divider />

      <div className={styles.grid}>
        <Caption1 className={styles.label}>Tool</Caption1>
        <Caption1 className={styles.target}>{approval.toolId}</Caption1>
        <Caption1 className={styles.label}>Action</Caption1>
        <Caption1>{approval.action}</Caption1>
        <Caption1 className={styles.label}>Target</Caption1>
        <Caption1 className={styles.target}>{approval.target ?? '—'}</Caption1>
        <Caption1 className={styles.label}>Why you are asked</Caption1>
        <Caption1>{approval.decision.explanation}</Caption1>
      </div>

      {needsPhrase ? (
        <Field
          label={`Type "${confirmationPhrase}" to confirm this high-risk action`}
          validationState={phrase && phrase.trim() !== confirmationPhrase ? 'warning' : 'none'}
        >
          <Input value={phrase} onChange={(_, data) => setPhrase(data.value)} placeholder={confirmationPhrase} />
        </Field>
      ) : null}

      <div className={styles.actions}>
        <Button appearance="subtle" onClick={() => setRemember(!remember)} disabled={busy}>
          {remember ? 'Will remember this choice' : 'Remember this choice'}
        </Button>
        <Button appearance="secondary" onClick={onDeny} disabled={busy}>
          Deny
        </Button>
        <Button
          appearance="primary"
          disabled={!canApprove}
          onClick={() => onApprove({ confirmationPhrase: needsPhrase ? phrase.trim() : undefined, remember })}
        >
          Approve
        </Button>
      </div>
    </Card>
  );
}
