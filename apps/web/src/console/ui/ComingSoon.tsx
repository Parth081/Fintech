// Placeholder for a console module whose page is not available in this build.
import { EmptyState, Page, PageHeader } from './primitives';

export function ComingSoon({ title }: { title: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <div className="ct-card">
        <EmptyState title="Coming soon" icon="clock">
          This workspace is being rolled out and is not available in this environment yet.
        </EmptyState>
      </div>
    </Page>
  );
}
