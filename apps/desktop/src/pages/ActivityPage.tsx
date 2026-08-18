import { useState } from 'react';
import {
  Body1,
  Dropdown,
  Field,
  Input,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { AuditQuery, AuditResult, PermissionEffect, RiskLevel } from '@jarvis/types';
import { RiskBadge, StatusBadge, jarvisSpacing } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import { useAudit, useTools } from '../queries.js';

const useStyles = makeStyles({
  filters: { display: 'flex', gap: jarvisSpacing.s, flexWrap: 'wrap', marginBottom: jarvisSpacing.m },
  mono: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
});

const resultTone = {
  succeeded: 'ok',
  failed: 'error',
  denied: 'error',
  cancelled: 'neutral',
} as const;

export function ActivityPage() {
  const styles = useStyles();
  const tools = useTools();
  const [toolId, setToolId] = useState<string>('');
  const [result, setResult] = useState<string>('');
  const [permission, setPermission] = useState<string>('');
  const [minRiskLevel, setMinRiskLevel] = useState<string>('');
  const [search, setSearch] = useState('');

  const query: AuditQuery = {
    limit: 200,
    ...(toolId ? { toolId } : {}),
    ...(result ? { result: result as AuditResult } : {}),
    ...(permission ? { permission: permission as PermissionEffect } : {}),
    ...(minRiskLevel ? { minRiskLevel: Number(minRiskLevel) as RiskLevel } : {}),
    ...(search ? { search } : {}),
  };
  const { data = [] } = useAudit(query);

  return (
    <>
      <PageHeader title="Activity" description="Immutable audit trail of every tool action Jarvis attempted." />

      <div className={styles.filters}>
        <Field label="Tool">
          <Dropdown
            placeholder="All tools"
            value={toolId}
            selectedOptions={toolId ? [toolId] : []}
            onOptionSelect={(_, item) => setToolId(item.optionValue === '__all' ? '' : (item.optionValue ?? ''))}
          >
            <Option value="__all">All tools</Option>
            {(tools.data ?? []).map((tool) => (
              <Option key={tool.id} value={tool.id}>
                {tool.id}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Result">
          <Dropdown
            placeholder="Any result"
            value={result}
            selectedOptions={result ? [result] : []}
            onOptionSelect={(_, item) => setResult(item.optionValue === '__all' ? '' : (item.optionValue ?? ''))}
          >
            <Option value="__all">Any result</Option>
            <Option value="succeeded">succeeded</Option>
            <Option value="failed">failed</Option>
            <Option value="denied">denied</Option>
            <Option value="cancelled">cancelled</Option>
          </Dropdown>
        </Field>
        <Field label="Permission">
          <Dropdown
            placeholder="Any decision"
            value={permission}
            selectedOptions={permission ? [permission] : []}
            onOptionSelect={(_, item) => setPermission(item.optionValue === '__all' ? '' : (item.optionValue ?? ''))}
          >
            <Option value="__all">Any decision</Option>
            <Option value="allow">allow</Option>
            <Option value="ask">ask</Option>
            <Option value="deny">deny</Option>
          </Dropdown>
        </Field>
        <Field label="Minimum risk">
          <Dropdown
            placeholder="Any risk"
            value={minRiskLevel}
            selectedOptions={minRiskLevel ? [minRiskLevel] : []}
            onOptionSelect={(_, item) => setMinRiskLevel(item.optionValue === '__all' ? '' : (item.optionValue ?? ''))}
          >
            <Option value="__all">Any risk</Option>
            <Option value="1">L1 and above</Option>
            <Option value="2">L2 and above</Option>
            <Option value="3">L3 and above</Option>
            <Option value="4">L4 only</Option>
          </Dropdown>
        </Field>
        <Field label="Search target">
          <Input value={search} onChange={(_, item) => setSearch(item.value)} placeholder="path or command" />
        </Field>
      </div>

      {data.length === 0 ? (
        <Body1>No audit entries match these filters.</Body1>
      ) : (
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Time</TableHeaderCell>
              <TableHeaderCell>Tool</TableHeaderCell>
              <TableHeaderCell>Action</TableHeaderCell>
              <TableHeaderCell>Target</TableHeaderCell>
              <TableHeaderCell>Risk</TableHeaderCell>
              <TableHeaderCell>Permission</TableHeaderCell>
              <TableHeaderCell>Result</TableHeaderCell>
              <TableHeaderCell>Reversible</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((event) => (
              <TableRow key={event.id}>
                <TableCell>{new Date(event.time).toLocaleString()}</TableCell>
                <TableCell className={styles.mono}>{event.toolId}</TableCell>
                <TableCell>{event.action}</TableCell>
                <TableCell className={styles.mono}>{event.target ?? '—'}</TableCell>
                <TableCell>
                  <RiskBadge level={event.riskLevel} />
                </TableCell>
                <TableCell>
                  <StatusBadge
                    tone={event.permission === 'deny' ? 'error' : event.permission === 'ask' ? 'warning' : 'ok'}
                    label={event.permission}
                    title={event.permissionReason}
                  />
                </TableCell>
                <TableCell>
                  <StatusBadge tone={resultTone[event.result]} label={event.result} title={event.detail} />
                </TableCell>
                <TableCell>{event.reversible ? 'yes' : 'no'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
