import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { makeStyles, tokens } from '@fluentui/react-components';
import { jarvisRadius, jarvisSpacing } from '@jarvis/ui';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: jarvisSpacing.s,
    lineHeight: tokens.lineHeightBase300,
    '& pre': {
      margin: 0,
      padding: jarvisSpacing.m,
      borderRadius: jarvisRadius.medium,
      overflowX: 'auto',
      backgroundColor: tokens.colorNeutralBackground3,
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase200,
    },
    '& code': { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
    '& p': { margin: 0 },
    '& ul, & ol': { margin: 0, paddingLeft: jarvisSpacing.xl },
    '& table': { borderCollapse: 'collapse' },
    '& th, & td': { border: `1px solid ${tokens.colorNeutralStroke2}`, padding: jarvisSpacing.xs },
    '& a': { color: tokens.colorBrandForegroundLink },
  },
});

/** Markdown + syntax-highlighted code for chat messages. */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
