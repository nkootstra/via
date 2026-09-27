/// <reference types="vite/client" />
// An app in miniature: it imports @via/ui by its package name, as apps/web
// does, styles itself with one of the package's tokens, and has a stylesheet
// of its own for StyleX to append to.
import "./app.css";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@via/ui";
import { colors } from "@via/ui/tokens.stylex";
import { createRoot } from "react-dom/client";

const styles = stylex.create({
  note: { color: colors.foreground },
});

function App() {
  return (
    <main>
      <p {...stylex.props(styles.note)}>Tokens from another package</p>
      <Button>Sign in</Button>
    </main>
  );
}

const root = document.getElementById("root");

if (root !== null) createRoot(root).render(<App />);
