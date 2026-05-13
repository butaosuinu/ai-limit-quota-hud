type SampleRow = {
  id: string;
  label: string;
  detail: string;
  reset: string;
};

const SAMPLE_ROWS: SampleRow[] = [
  { id: "claude-code", label: "Claude Code", detail: "74%", reset: "2:14" },
  { id: "anthropic-api", label: "Anthropic API", detail: "812k tok", reset: "0:37" },
  { id: "openai-api", label: "OpenAI API", detail: "59 req", reset: "0:01" },
];

export function App() {
  return (
    <main className="overlay" data-testid="overlay-root">
      <header className="overlay__title">QuotaHUD</header>
      <ul className="overlay__rows">
        {SAMPLE_ROWS.map((row) => (
          <li key={row.id} className="overlay__row">
            <span className="overlay__row-label">{row.label}</span>
            <span className="overlay__row-detail">{row.detail}</span>
            <span className="overlay__row-reset">reset {row.reset}</span>
          </li>
        ))}
      </ul>
      <footer className="overlay__footer">phase 0 scaffold · sample data</footer>
    </main>
  );
}
