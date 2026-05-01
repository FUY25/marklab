export function HomePage() {
  return (
    <main className="workspace-shell workspace-shell-simple" data-testid="home-page">
      <header className="workspace-header workspace-header-simple">
        <div>
          <p className="workspace-kicker">Local Markdown collaboration</p>
          <h1>MarkLab</h1>
        </div>
      </header>

      <section className="local-launch-panel" aria-label="Open a local Markdown file">
        <p>Open a Markdown file from your terminal.</p>
        <pre>
          <code>marklab open README.md</code>
        </pre>
      </section>
    </main>
  );
}
