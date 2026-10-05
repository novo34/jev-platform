import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section>
        <p className="eyebrow">JEV Platform</p>
        <h1>Platform skeleton is running.</h1>
        <p>
          Web, API, worker and shared packages are separated and ready for the
          next controlled backlog task.
        </p>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
