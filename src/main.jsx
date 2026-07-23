import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OrgCalendar from "./OrgCalendar.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <OrgCalendar />
  </StrictMode>
);
