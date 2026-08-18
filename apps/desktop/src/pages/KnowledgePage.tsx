import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  Input,
  Label,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { KnowledgeHit, KnowledgeSource } from '@jarvis/types';
import { StatusBadge, jarvisSpacing } from '@jarvis/ui';
import type { StatusTone } from '@jarvis/ui';
import { PageHeader } from '../components/PageHeader.js';
import {
  useKnowledgeActions,
  useKnowledgeDocuments,
  useKnowledgeProgress,
  useKnowledgeSources,
  useKnowledgeStats,
} from '../queries.js';

const useStyles = makeStyles({
  card: { padding: jarvisSpacing.m, display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s },
  section: { display: 'flex', flexDirection: 'column', gap: jarvisSpacing.s, marginBottom: jarvisSpacing.l },
  row: { display: 'flex', gap: jarvisSpacing.s, alignItems: 'flex-end', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '260px' },
  meta: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: jarvisSpacing.xs, flexWrap: 'wrap' },
  hit: {
    padding: jarvisSpacing.s,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: jarvisSpacing.xs,
  },
  snippet: { whiteSpace: 'pre-wrap', fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  empty: { color: tokens.colorNeutralForeground3 },
});

const SOURCE_TONE: Record<KnowledgeSource['status'], StatusTone> = {
  idle: 'ok',
  indexing: 'info',
  error: 'error',
};

/**
 * Memory and knowledge: which folders Jarvis has read, and what it will retrieve.
 * Indexing obeys the same folder scopes as the filesystem tools, so a folder has to
 * be allowed in Permissions before it can be indexed.
 */
export function KnowledgePage() {
  const styles = useStyles();
  const sources = useKnowledgeSources();
  const stats = useKnowledgeStats();
  const actions = useKnowledgeActions();
  const progress = useKnowledgeProgress();
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const documents = useKnowledgeDocuments(expanded);

  const error =
    actions.addSource.error ?? actions.reindex.error ?? actions.removeSource.error ?? actions.search.error ?? null;
  const hits: KnowledgeHit[] = actions.search.data ?? [];

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="Index folders and files so Jarvis can answer from them, and see what it remembers from past chats."
      />

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{(error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : null}

      {stats.data && !stats.data.ready ? (
        <MessageBar intent="warning">
          <MessageBarBody>{stats.data.message}</MessageBarBody>
        </MessageBar>
      ) : null}

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Index a folder or file</Subtitle2>} />
          <div className={styles.row}>
            <div className={`${styles.grow}`}>
              <Label htmlFor="knowledge-path">Absolute path</Label>
              <Input
                id="knowledge-path"
                className={styles.grow}
                value={path}
                placeholder="C:\Users\me\Documents\notes"
                onChange={(_, data) => setPath(data.value)}
              />
            </div>
            <Button
              appearance="primary"
              disabled={!path.trim() || actions.addSource.isPending}
              onClick={() => actions.addSource.mutate(path.trim(), { onSuccess: () => setPath('') })}
            >
              Index
            </Button>
          </div>
          <Caption1 className={styles.meta}>
            {stats.data
              ? `${stats.data.documents} files · ${stats.data.fileChunks} passages · ${stats.data.conversationChunks} remembered turns · embedding model ${stats.data.embeddingModel}`
              : 'Loading index status…'}
          </Caption1>
          {stats.data && stats.data.staleChunks > 0 ? (
            <Caption1 className={styles.meta}>
              {`${stats.data.staleChunks} passages were embedded with another model and are ignored until you reindex.`}
            </Caption1>
          ) : null}
        </Card>
      </div>

      <div className={styles.section}>
        <Subtitle2>Sources</Subtitle2>
        {sources.isLoading ? <Spinner size="tiny" /> : null}
        {sources.data?.length === 0 ? (
          <Body1 className={styles.empty}>Nothing indexed yet. Add a folder above.</Body1>
        ) : null}
        {sources.data?.map((source) => (
          <Card key={source.id} className={styles.card}>
            <div className={styles.row}>
              <Text weight="semibold">{source.path}</Text>
              <StatusBadge tone={SOURCE_TONE[source.status]} label={source.status} />
            </div>
            <Caption1 className={styles.meta}>
              {`${source.documentCount} files · ${source.chunkCount} passages${
                source.lastIndexedAt ? ` · indexed ${new Date(source.lastIndexedAt).toLocaleString()}` : ''
              }`}
            </Caption1>
            {progress[source.id] ? (
              <Caption1 className={styles.meta}>
                {`Reading · ${progress[source.id]?.filesSeen ?? 0} files seen · ${
                  progress[source.id]?.chunksWritten ?? 0
                } passages written`}
              </Caption1>
            ) : null}
            {source.error ? <Caption1 className={styles.meta}>{source.error}</Caption1> : null}
            <div className={styles.actions}>
              <Button
                size="small"
                // Only a pass in this session blocks a reindex: a status left behind by a
                // closed app must not lock the user out of the one action that fixes it.
                disabled={progress[source.id] !== undefined || actions.reindex.isPending}
                onClick={() => actions.reindex.mutate(source.id)}
              >
                Reindex
              </Button>
              <Button size="small" onClick={() => setExpanded(expanded === source.id ? null : source.id)}>
                {expanded === source.id ? 'Hide files' : 'Show files'}
              </Button>
              <Button size="small" appearance="subtle" onClick={() => actions.removeSource.mutate(source.id)}>
                Remove
              </Button>
            </div>
            {expanded === source.id
              ? (documents.data ?? []).map((document) => (
                  <Caption1 key={document.id} className={styles.meta}>
                    {`${document.path} · ${document.chunkCount} passages`}
                  </Caption1>
                ))
              : null}
          </Card>
        ))}
      </div>

      <div className={styles.section}>
        <Card className={styles.card}>
          <CardHeader header={<Subtitle2>Search what Jarvis knows</Subtitle2>} />
          <div className={styles.row}>
            <Input
              className={styles.grow}
              value={query}
              placeholder="What did I write about the budget?"
              onChange={(_, data) => setQuery(data.value)}
            />
            <Button
              disabled={!query.trim() || actions.search.isPending}
              onClick={() => actions.search.mutate({ query: query.trim() })}
            >
              Search
            </Button>
          </div>
          {actions.search.isPending ? <Spinner size="tiny" /> : null}
          {actions.search.isSuccess && hits.length === 0 ? (
            <Body1 className={styles.empty}>No passage scored high enough to be worth showing.</Body1>
          ) : null}
          {hits.map((hit) => (
            <div key={hit.chunkId} className={styles.hit}>
              <Caption1 className={styles.meta}>
                {`${hit.corpus === 'files' ? 'File' : 'Past conversation'} · ${hit.source} · score ${hit.score.toFixed(2)}`}
              </Caption1>
              <span className={styles.snippet}>{hit.text.slice(0, 600)}</span>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
