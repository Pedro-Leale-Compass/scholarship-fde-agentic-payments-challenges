import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./config.js";
import App from "./App.js";
import "@aws-amplify/ui-react/styles.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
